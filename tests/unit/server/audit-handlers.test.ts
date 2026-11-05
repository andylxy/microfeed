import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {SqliteStatement} from "../support/sqlite-statement";
import {
  listAuditChaptersHandler,
  listAuditTrailHandler,
  listReviewRecordsHandler,
  setAuditRowArchivedHandler,
} from "@/server/admin/audit-handlers";
import type {
  AuditDb,
  AuditDbPreparedStatement,
} from "@/server/feed/extContentAudit";



class SqliteAuditDb implements AuditDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): AuditDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function emptyDatabase(): {database: DatabaseSync; db: SqliteAuditDb} {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id VARCHAR(11) PRIMARY KEY,
      status TINYINT,
      data TEXT
    );
    CREATE TABLE ext_content_audit (
      id VARCHAR(11) PRIMARY KEY,
      item_id VARCHAR(11),
      channel_id VARCHAR(11),
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      diff_data TEXT,
      checkpoint_data TEXT,
      is_checkpoint BOOLEAN DEFAULT 0,
      review_status TEXT,
      reason TEXT,
      created_at TIMESTAMP,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ext_content_review (
      id VARCHAR(11) PRIMARY KEY,
      item_id VARCHAR(11),
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_at INTEGER,
      reviewed_at INTEGER,
      proposed_data TEXT,
      snapshot_data TEXT
    );
  `);
  return {database, db: new SqliteAuditDb(database)};
}

function addAuditRow(
  database: DatabaseSync,
  id: string,
  itemId: string,
  createdAt: string,
  isCheckpoint = false,
) {
  database.prepare(
    "INSERT INTO ext_content_audit (id, item_id, action, actor_type, " +
      "diff_data, is_checkpoint, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, itemId, "edit", "author", "[]", isCheckpoint ? 1 : 0, createdAt);
}

function addReviewRow(
  database: DatabaseSync,
  id: string,
  itemId: string,
  description: string,
) {
  database.prepare(
    "INSERT INTO ext_content_review (id, item_id, action, status, " +
      "submitted_at, proposed_data) VALUES (?,?,?,?,?,?)",
  ).run(id, itemId, "edit", "pending", 1700000000000, JSON.stringify({
    title: "第一章",
    description,
  }));
}

describe("audit browsing", () => {
  it("lists chapters by most recent change, newest first", async () => {
    const {database, db} = emptyDatabase();
    database.prepare("INSERT INTO items (id, status, data) VALUES (?,?,?)")
      .run("chap1", 1, JSON.stringify({title: "第一章"}));
    database.prepare("INSERT INTO items (id, status, data) VALUES (?,?,?)")
      .run("chap2", 1, JSON.stringify({title: "第二章"}));
    addAuditRow(database, "a1", "chap1", "1700000000000");
    addAuditRow(database, "a2", "chap1", "1700000100000");
    addAuditRow(database, "a3", "chap2", "1700000200000");

    const {chapters} = await listAuditChaptersHandler(db);
    expect(chapters.map((chapter) => chapter.id)).toEqual(["chap2", "chap1"]);
    expect(chapters[1]).toMatchObject({changeCount: 2, title: "第一章"});
  });

  it("reads both created_at shapes and returns the trail newest first", async () => {
    const {database, db} = emptyDatabase();
    database.prepare("INSERT INTO items (id, status, data) VALUES (?,?,?)")
      .run("chap1", 1, JSON.stringify({title: "第一章"}));
    // The audit module writes epoch milliseconds; the correction module writes
    // `YYYY-MM-DD HH:MM:SS`. Both have to survive the round trip.
    addAuditRow(database, "a1", "chap1", "1700000000000", true);
    addAuditRow(database, "a2", "chap1", "2026-09-19 10:30:00");

    const {item, rows} = await listAuditTrailHandler(db, "chap1");
    expect(item).toMatchObject({title: "第一章"});
    expect(rows.map((row) => row.id)).toEqual(["a2", "a1"]);
    expect(rows[1]?.createdAt).toBe(new Date(1700000000000).toISOString());
    // Only a2 has a checkpoint behind it at that point in the chain.
    expect(rows[0]?.restorable).toBe(true);
  });

  it("rejects a FeedDb wrapper passed where a D1 handle is required", async () => {
    // `FeedDb` declares `[member: string]: any`, so it satisfies the `AuditDb`
    // port at compile time but has no `prepare()` at runtime. That combination
    // 500s the audit page with a bare "prepare is not a function".
    const wrapper = {} as Parameters<typeof listAuditChaptersHandler>[0];
    await expect(listAuditChaptersHandler(wrapper))
      .rejects.toThrow(/env\.FEED_DB/u);
    await expect(listAuditTrailHandler(wrapper, "chap1"))
      .rejects.toThrow(/env\.FEED_DB/u);
  });

  it("archives a row without deleting it, and can bring it back", async () => {
    const {database, db} = emptyDatabase();
    addAuditRow(database, "a1", "chap1", "1700000000000", true);
    addAuditRow(database, "a2", "chap1", "1700000100000");

    // Scoped to the item: a row from another chapter must not be reachable.
    expect(await setAuditRowArchivedHandler(db, "chap2", "a2", true))
      .toEqual({archived: true, found: false});

    expect(await setAuditRowArchivedHandler(db, "chap1", "a2", true))
      .toEqual({archived: true, found: true});

    const {rows} = await listAuditTrailHandler(db, "chap1");
    expect(rows.find((row) => row.id === "a2")?.archived).toBe(true);
    expect(rows.find((row) => row.id === "a1")?.archived).toBe(false);
    // The row is still there — archiving is a flag, never a delete.
    expect(rows).toHaveLength(2);

    await setAuditRowArchivedHandler(db, "chap1", "a2", false);
    const again = await listAuditTrailHandler(db, "chap1");
    expect(again.rows.find((row) => row.id === "a2")?.archived).toBe(false);
  });

  it("returns an empty trail for a chapter with no records", async () => {
    const {db} = emptyDatabase();
    await expect(listAuditTrailHandler(db, "missing")).resolves
      .toMatchObject({item: null, rows: []});
  });

  it("strips script, event attributes and javascript: links from review HTML", async () => {
    // ADR-0047 F1：编辑提交的富文本在审核页以 HTML 渲染，读取时按白名单消毒。
    const {database, db} = emptyDatabase();
    addReviewRow(
      database,
      "r1",
      "chap1",
      "<p onclick=\"steal()\">正文</p><script>alert(1)</script>" +
        "<img src=\"x\" onerror=\"alert(2)\">" +
        "<a href=\"javascript:alert(3)\">链接</a>",
    );

    const {records} = await listReviewRecordsHandler(db, "chap1");
    const html = records[0]?.contentHtml ?? "";
    expect(html).toContain("<p>正文</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    // 链接标签保留，但危险协议被剥离。
    expect(html).toContain("<a rel=\"noopener noreferrer\">链接</a>");
  });

  it("keeps whitelisted tags intact when sanitizing review HTML", async () => {
    const {database, db} = emptyDatabase();
    addReviewRow(
      database,
      "r1",
      "chap1",
      "<h2>小节</h2><table><tbody><tr><td>格</td></tr></tbody></table>" +
        "<em>重</em><pre><code>文</code></pre>" +
        "<a href=\"https://example.com/a\" title=\"注\">外链</a>",
    );

    const {records} = await listReviewRecordsHandler(db, "chap1");
    const html = records[0]?.contentHtml ?? "";
    expect(html).toContain("<h2>小节</h2>");
    expect(html).toContain("<table><tbody><tr><td>格</td></tr></tbody></table>");
    expect(html).toContain("<em>重</em>");
    expect(html).toContain("<pre><code>文</code></pre>");
    expect(html).toContain(
      "<a href=\"https://example.com/a\" title=\"注\" rel=\"noopener noreferrer\">外链</a>",
    );
  });
});
