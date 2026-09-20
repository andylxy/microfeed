import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  listAuditChaptersHandler,
  listAuditTrailHandler,
} from "@/server/admin/audit-handlers";
import type {
  AuditDb,
  AuditDbPreparedStatement,
} from "@/server/feed/extContentAudit";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements AuditDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): AuditDbPreparedStatement {
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
      created_at TIMESTAMP
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

  it("returns an empty trail for a chapter with no records", async () => {
    const {db} = emptyDatabase();
    await expect(listAuditTrailHandler(db, "missing")).resolves
      .toMatchObject({item: null, rows: []});
  });
});
