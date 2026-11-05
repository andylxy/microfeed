// tests/unit/support/sqlite-statement.ts
//
// D1 预编译语句的 `node:sqlite` 替身，20 个单测共用（原每文件各持一份约 572 行副本）。
// 抽成单份的依据（2026-11-05 实测）：12 个生产侧 `*DbPreparedStatement` 端口只在四轴上不同
// （bind 返回类型名 / run() 返回形状 / all() 返回形状 / first() 有无），一个结构类型超集类即可
// 覆盖全部端口。各模块的 `emptyDatabase()` DDL 与 7 行 `implements XxxDb` 包装类留在原文件，
// 因为 DDL 是各模块 schema 真源、包装类是端口漂移的编译期哨兵。
//
// 不得在此文件改动以影响单测行为；运行时回归由用户手动触发（AGENTS.md「测试只写不跑」）。

import type {DatabaseSync} from "node:sqlite";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/** D1 预编译语句的 `node:sqlite` 替身，20 个单测共用。 */
export class SqliteStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): this {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<{results: Record<string, unknown>[]; success: boolean}> {
    return {
      results: this.statement.all(...this.values) as Record<string, unknown>[],
      success: true,
    };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined)
      ?? null;
  }

  async run(): Promise<{results: Record<string, unknown>[]; success: boolean}> {
    this.statement.run(...this.values);
    return {results: [], success: true};
  }
}
