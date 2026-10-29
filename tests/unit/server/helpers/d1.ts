import {DatabaseSync} from "node:sqlite";

/**
 * 真实 SQLite 上的 D1 适配层（测试专用）。
 *
 * 生产代码读写的 SQL 原样跑在 `node:sqlite` 上：json_extract、`ON CONFLICT`、
 * `meta.changes` 这些语义都由真实引擎给出，测试验证的是查询口径本身，不用假数据
 * 伪造结论（AGENTS.md 禁止 mock）。
 */
export function makeD1(database: DatabaseSync): D1Database {
  function statement(sql: string, values: unknown[]) {
    return {
      bind(...next: unknown[]) {
        return statement(sql, next);
      },
      async all() {
        return {
          results: database.prepare(sql).all(...(values as never[])) as Record<string, unknown>[],
        };
      },
      async first() {
        const rows = database
          .prepare(sql)
          .all(...(values as never[])) as Record<string, unknown>[];
        return rows[0] ?? null;
      },
      async run() {
        const result = database.prepare(sql).run(...(values as never[]));
        return {success: true, meta: {changes: result.changes}} as never;
      },
    };
  }

  return {
    prepare(sql: string) {
      return statement(sql, []);
    },
    // D1 的 batch 是单事务全成或全回滚。这里用显式事务复刻，好让断言能看到
    // 「中途失败 ⇒ 前序写入也回滚」这类依赖。
    async batch(list: {run: () => Promise<unknown>}[]) {
      database.exec("BEGIN");
      try {
        const out = list.map((item) => item.run());
        database.exec("COMMIT");
        return out;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

/** 建一个内存库并执行建表语句。 */
export function makeSqlite(schema: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(schema);
  return database;
}
