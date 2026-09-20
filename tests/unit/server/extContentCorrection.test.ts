import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {
  approveCorrection,
  getCorrection,
  listCorrections,
  rejectCorrection,
  submitCorrection,
  type CorrectionDb,
  type CorrectionDbPreparedStatement,
} from "@/server/feed/extContentCorrection";
import {listItemAuditRows} from "@/server/feed/extReview";

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement implements CorrectionDbPreparedStatement {
  private readonly statement: ReturnType<DatabaseSync["prepare"]>;
  private values: SqlInputValue[] = [];

  constructor(database: DatabaseSync, query: string) {
    this.statement = database.prepare(query);
  }

  bind(...values: unknown[]): CorrectionDbPreparedStatement {
    this.values = values as SqlInputValue[];
    return this;
  }

  async all(): Promise<{results: Record<string, unknown>[]}> {
    return {
      results: this.statement.all(...this.values) as Record<string, unknown>[],
    };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return (this.statement.get(...this.values) as Record<string, unknown> | undefined)
      ?? null;
  }

  async run(): Promise<{success: boolean}> {
    this.statement.run(...this.values);
    return {success: true};
  }
}

class SqliteCorrectionDb implements CorrectionDb {
  constructor(private readonly database: DatabaseSync) {}

  prepare(query: string): CorrectionDbPreparedStatement {
    return new SqliteStatement(this.database, query);
  }
}

function emptyDatabase(): SqliteCorrectionDb {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE items (
      id VARCHAR(11) PRIMARY KEY,
      status TINYINT,
      data TEXT,
      content_text TEXT NOT NULL DEFAULT '',
      content_text_updated_at TIMESTAMP,
      review_status TEXT,
      pub_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      approved_by TEXT,
      approved_at INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ext_content_correction (
      id VARCHAR(11) PRIMARY KEY,
      item_id VARCHAR(11) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      diff_data TEXT,
      proposed_data TEXT NOT NULL,
      submitted_by TEXT,
      submitted_at INTEGER,
      reviewed_by TEXT,
      reviewed_at INTEGER,
      reason TEXT
    );
  `);
  return new SqliteCorrectionDb(database);
}

function seed(database: SqliteCorrectionDb, data: Record<string, unknown>) {
  const db = (database as unknown as {database: DatabaseSync}).database;
  db.prepare("INSERT INTO items (id, status, data) VALUES (?,?,?)").run(
    "chap1",
    1,
    JSON.stringify(data),
  );
}

const ORIGINAL = {
  id: "chap1",
  title: "第一章 起锚",
  _microfeed: {bookId: "book2", chapterNo: 1, volume: "第一卷 远帆"},
};

describe("content correction", () => {
  it("records a proposal without touching the item", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);

    const correction = await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "第一章 起航"},
      reason: "错别字",
      submittedBy: "reviewer-a",
    });

    expect(correction.status).toBe("pending");
    expect(correction.submittedBy).toBe("reviewer-a");
    expect(correction.changes).toEqual([
      {
        after: "第一章 起航",
        before: "第一章 起锚",
        op: "update",
        path: "title",
      },
    ]);

    // The item is untouched until approval.
    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT data FROM items WHERE id = ?",
    ).get("chap1") as Record<string, unknown>;
    expect(JSON.parse(String(row.data)).title).toBe("第一章 起锚");
  });

  it("refreshes the searchable text when a correction is confirmed", async () => {
    const db = emptyDatabase();
    const before = {
      id: "chap1",
      title: "第一章 起锚",
      description: "<p>旧正文</p>",
      _microfeed: {bookId: "book2", chapterNo: 1},
    };
    seed(db, before);
    const submitted = await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...before, description: "<p>新正文</p>"},
      submittedBy: "reviewer-a",
    });
    await approveCorrection(db, submitted.id, "reviewer-b");

    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT data, content_text FROM items WHERE id = ?",
    ).get("chap1") as Record<string, unknown>;
    expect(JSON.parse(String(row.data)).description).toBe("<p>新正文</p>");
    // Approving used to write `data` only, so the FTS index kept answering
    // searches with the body the correction had just replaced.
    expect(row.content_text).toBe("新正文");
  });

  it("refuses a proposal that changes nothing", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);
    await expect(submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL},
    })).rejects.toThrow();
  });

  it("writes back to the original storage on approval and trails the approver", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);

    const submitted = await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "第一章 起航"},
      submittedBy: "reviewer-a",
    });
    const approved = await approveCorrection(db, submitted.id, "reviewer-b");

    expect(approved.status).toBe("approved");
    expect(approved.reviewedBy).toBe("reviewer-b");
    expect(approved.submittedBy).toBe("reviewer-a");

    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT data FROM items WHERE id = ?",
    ).get("chap1") as Record<string, unknown>;
    expect(JSON.parse(String(row.data)).title).toBe("第一章 起航");

    const audit = await listItemAuditRows(
      db as unknown as Parameters<typeof listItemAuditRows>[0],
      "chap1",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "correction_apply",
      actorId: "reviewer-b",
    });
  });

  it("refuses to approve twice", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);
    const submitted = await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "改过"},
    });
    await approveCorrection(db, submitted.id, "reviewer-b");
    await expect(approveCorrection(db, submitted.id, "reviewer-b")).rejects.toThrow();
  });

  it("leaves the item alone on rejection", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);
    const submitted = await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "不该改"},
      submittedBy: "reviewer-a",
    });
    const rejected = await rejectCorrection(db, submitted.id, "reviewer-b");

    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedBy).toBe("reviewer-b");
    const row = (db as unknown as {database: DatabaseSync}).database.prepare(
      "SELECT data FROM items WHERE id = ?",
    ).get("chap1") as Record<string, unknown>;
    expect(JSON.parse(String(row.data)).title).toBe("第一章 起锚");
  });

  it("lists a chapter's proposals in submission order", async () => {
    const db = emptyDatabase();
    seed(db, ORIGINAL);
    await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "A"},
    });
    await submitCorrection(db, {
      itemId: "chap1",
      proposedData: {...ORIGINAL, title: "B"},
    });
    const all = await listCorrections(db, "chap1");
    expect(all.map((c) => c.changes[0]?.after)).toEqual(["A", "B"]);
    expect(await getCorrection(db, all[0]!.id)).toMatchObject({id: all[0]!.id});
  });
});
