import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {ADMIN_TYPEAHEAD_TABLE} from "@/shared/ItemSearchSql";
import {listWebhookExplorerSubjects} from "@/server/webhooks/explorer";

/**
 * 后台事件源 typeahead（`sourceKind === "item"`）的两条取数路径。
 *
 * 索引 `ext_admin_typeahead` 是派生数据、不进迁移，测试环境里没有它。
 * 这里用单语句建表 + 显式写索引行：D1 的 `exec` 无法可靠执行含
 * `BEGIN … END` 触发器体的多语句，而本用例只需验证查询侧的两条分支，
 * 触发器的维护由 `CREATE_ADMIN_TYPEAHEAD_INDEX_SQL` 负责（已在本地库实测）。
 */
const db = env.FEED_DB;
const EVENT_TYPE = "item.published";
const INSERTED: Array<{id: string; title: string}> = [];

/** 与建索引 SQL 同形的 haystack：标题 + 空格 + lower(id)，逐字用空格分隔。 */
function haystack(id: string, title: string): string {
  return [...`${title} ${id}`.toLowerCase()].join(" ");
}

function explorerEnv(): Env {
  // 只有 FEED_DB 要换成测试库，其余绑定直接取运行环境里的真实值
  // （`FeedDb` 要的是完整的 Env，逐个桩一遍既啰嗦又会与真实绑定漂移）。
  return {...env, FEED_DB: db};
}

function explorerRequest(): Request {
  return new Request(
    "https://feed.example.com/admin/ajax/webhook-explorer/subjects",
  );
}

async function insertItem(
  id: string,
  title: string,
  updatedAt: string,
): Promise<void> {
  INSERTED.push({id, title});
  await db
    .prepare(
      "INSERT OR REPLACE INTO items (id, status, data, pub_date, created_at, updated_at, " +
        "content_text, content_text_updated_at, content_text_revision, review_status, " +
        "book_id, tcm_kind, tcm_parent_id) " +
        "VALUES (?, 1, ?, ?, ?, ?, '', ?, 1, NULL, NULL, NULL, NULL)",
    )
    .bind(
      id,
      JSON.stringify({title}),
      updatedAt,
      updatedAt,
      updatedAt,
      updatedAt,
    )
    .run();
}

async function buildIndex(): Promise<void> {
  await db
    .prepare(
      "CREATE VIRTUAL TABLE IF NOT EXISTS ext_admin_typeahead USING fts5(" +
        "haystack, content_id UNINDEXED, tokenize = 'unicode61')",
    )
    .run();
  await db.batch([
    db.prepare(`DELETE FROM ${ADMIN_TYPEAHEAD_TABLE}`),
    ...INSERTED.map((row, index) =>
      db
        .prepare(
          "INSERT INTO ext_admin_typeahead(rowid, haystack, content_id) " +
            "VALUES (?, ?, ?)",
        )
        .bind(index + 1, haystack(row.id, row.title), row.id)
    ),
  ]);
}

async function dropIndex(): Promise<void> {
  await db.prepare(`DROP TABLE IF EXISTS ${ADMIN_TYPEAHEAD_TABLE}`).run();
}

async function subjects(query: string): Promise<string[]> {
  const result = await listWebhookExplorerSubjects(
    explorerEnv(),
    explorerRequest(),
    EVENT_TYPE,
    query,
  );
  return result.map((entry) => entry.id);
}

afterEach(async () => {
  await dropIndex();
  if (INSERTED.length > 0) {
    const ids = INSERTED.map((row) => `'${row.id}'`).join(",");
    await db.exec(`DELETE FROM items WHERE id IN (${ids});`);
    INSERTED.length = 0;
  }
});

describe("listWebhookExplorerSubjects item typeahead", () => {
  it("空搜索词走 items 直查并返回上限内的条目", async () => {
    await insertItem("typeahead-empty-1", "黄芪建中汤", "2026-01-03T00:00:00.000Z");
    await insertItem("typeahead-empty-2", "桂枝汤", "2026-01-02T00:00:00.000Z");
    const ids = await subjects("");
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(50);
  });

  it("索引可用时结果与 items 直查完全一致（顺序与集合）", async () => {
    await insertItem("typeahead-hit-1", "黄芪建中汤", "2026-01-03T00:00:00.000Z");
    await insertItem("typeahead-hit-2", "黄芪桂枝五物汤", "2026-01-02T00:00:00.000Z");
    await insertItem("typeahead-miss-1", "桂枝汤", "2026-01-01T00:00:00.000Z");

    await buildIndex();
    const viaIndex = await subjects("黄芪");

    await dropIndex();
    const viaScan = await subjects("黄芪");

    expect(viaIndex).toEqual(["typeahead-hit-1", "typeahead-hit-2"]);
    expect(viaScan).toEqual(viaIndex);
  });

  it("索引缺失或为空时走 items 直查，不抛错", async () => {
    await insertItem("typeahead-fallback-1", "黄芪建中汤", "2026-01-03T00:00:00.000Z");
    await dropIndex();
    await expect(subjects("黄芪")).resolves.toEqual(["typeahead-fallback-1"]);

    // 建表但不回填：索引存在却为空，同样应走直查
    await db
      .prepare(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ext_admin_typeahead USING fts5(" +
          "haystack, content_id UNINDEXED, tokenize = 'unicode61')",
      )
      .run();
    await expect(subjects("黄芪")).resolves.toEqual(["typeahead-fallback-1"]);
  });

  it("搜索词含双引号时不抛错", async () => {
    await insertItem("typeahead-quote-1", "黄芪建中汤", "2026-01-03T00:00:00.000Z");
    await buildIndex();
    await expect(subjects('黄芪"')).resolves.toBeInstanceOf(Array);
  });
});
