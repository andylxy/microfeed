import {DatabaseSync} from "node:sqlite";
import {describe, expect, it} from "vitest";

import {STATUSES} from "@/shared/Constants";
import {
  recordAudit,
  recordItemEdit,
  type AuditDb,
  type AuditDbPreparedStatement,
} from "@/server/feed/extContentAudit";
import {
  applyReviewTransition,
  isAllowedReviewTransition,
  listItemAuditRows,
  listPendingReviewItems,
  mergeRestoredVersion,
  readItemReviewStatus,
  rebuildItemVersion,
  reviewTransition,
} from "@/server/feed/extReview";

/**
 * In-memory SQLite doubles for the two D1-shaped ports, matching the schema the
 * real migrations create so the production SQL is exercised for real.
 */
function makeStatement(
  database: DatabaseSync,
  sql: string,
  boundValues: unknown[] = [],
): AuditDbPreparedStatement {
  return {
    bind(...values: unknown[]) {
      return makeStatement(database, sql, values);
    },
    async run() {
      database.prepare(sql).run(...(boundValues as any[]));
      return {results: [] as Record<string, unknown>[], success: true};
    },
    async all() {
      return {
        results: database
          .prepare(sql)
          .all(...(boundValues as any[])) as Record<string, unknown>[],
        success: true,
      };
    },
    async first() {
      const rows = database
        .prepare(sql)
        .all(...(boundValues as any[])) as Record<string, unknown>[];
      return rows[0] ?? null;
    },
  };
}

function newDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE items (
    id TEXT PRIMARY KEY,
    status INTEGER,
    data TEXT,
    review_status TEXT,
    updated_at TEXT
  )`);
  database.exec(`CREATE TABLE ext_content_audit (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    channel_id TEXT,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    diff_data TEXT,
    checkpoint_data TEXT,
    is_checkpoint BOOLEAN DEFAULT 0,
    review_status TEXT,
    reason TEXT,
    created_at TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  )`);
  database.exec(`CREATE TABLE ext_content_report (
    id TEXT PRIMARY KEY,
    item_id TEXT,
    channel_id TEXT,
    reporter_type TEXT,
    category TEXT,
    detail TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT
  )`);
  return database;
}

const dbOf = (database: DatabaseSync): AuditDb => ({
  prepare: (sql: string) => makeStatement(database, sql),
});

function seedItem(
  database: DatabaseSync,
  id: string,
  data: Record<string, unknown>,
  reviewStatus: string,
  updatedAt = "2026-08-01T00:00:00.000Z",
): void {
  database
    .prepare("INSERT INTO items (id, status, data, review_status, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, STATUSES.UNPUBLISHED, JSON.stringify(data), reviewStatus, updatedAt);
}

describe("review state machine", () => {
  it("submits unpublished, approves published, and rejects with a reason", () => {
    expect(reviewTransition("submit")).toMatchObject({
      reviewStatus: "submitted",
      status: STATUSES.UNPUBLISHED,
      takedown: false,
    });
    expect(reviewTransition("approve")).toMatchObject({
      reviewStatus: "approved",
      status: STATUSES.PUBLISHED,
    });
    expect(reviewTransition("reject", "  内容不合规  ")).toMatchObject({
      reason: "内容不合规",
      reviewStatus: "rejected",
      status: STATUSES.UNPUBLISHED,
    });
  });

  it("refuses to reject without a reason", () => {
    expect(() => reviewTransition("reject")).toThrow(/reason/);
    expect(() => reviewTransition("reject", "   ")).toThrow(/reason/);
  });

  it("marks a takedown and clears it again when the chapter is restored", () => {
    const takenDown = applyReviewTransition(
      {_microfeed: {reviewStatus: "approved"}, title: "第一章"},
      reviewTransition("takedown", "侵权"),
    );
    expect((takenDown._microfeed as any).takedown).toBe(true);
    expect((takenDown._microfeed as any).takedownReason).toBe("侵权");

    const restored = applyReviewTransition(
      takenDown,
      reviewTransition("approve"),
    );
    expect((restored._microfeed as any).takedown).toBeUndefined();
    expect((restored._microfeed as any).reviewStatus).toBe("approved");
  });

  it("defaults an unknown or missing review status to draft", () => {
    expect(readItemReviewStatus({_microfeed: {reviewStatus: "approved"}})).toBe("approved");
    expect(readItemReviewStatus({_microfeed: {reviewStatus: "nonsense"}})).toBe("draft");
    expect(readItemReviewStatus({})).toBe("draft");
  });
});

describe("review queue and version rebuild", () => {
  it("lists only submitted chapters, oldest first, with their titles", async () => {
    const database = newDatabase();
    const db = dbOf(database);
    seedItem(database, "it-new", {title: "新提交"}, "submitted", "2026-08-02T00:00:00.000Z");
    seedItem(database, "it-old", {title: "早提交"}, "submitted", "2026-08-01T00:00:00.000Z");
    seedItem(database, "it-draft", {title: "草稿"}, "draft");

    const queue = await listPendingReviewItems(db);
    expect(queue.map((row) => row.id)).toEqual(["it-old", "it-new"]);
    expect(queue[0]!.title).toBe("早提交");
  });

  it("survives a malformed data column instead of failing the queue", async () => {
    const database = newDatabase();
    const db = dbOf(database);
    database
      .prepare("INSERT INTO items (id, status, data, review_status, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("it-bad", STATUSES.UNPUBLISHED, "{not json", "submitted", "2026-08-01T00:00:00.000Z");

    const queue = await listPendingReviewItems(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.title).toBe("");
  });

  it("rebuilds a past version from the nearest checkpoint plus later diffs", async () => {
    const database = newDatabase();
    const db = dbOf(database);

    // Edit 1 is the checkpoint (full snapshot); edits 2 and 3 are diffs only.
    await recordAudit(db, {
      action: "edit",
      actorType: "author",
      checkpointData: {title: "v1", _microfeed: {volume: "第一卷"}},
      diffData: [{op: "update", path: "title", before: "v0", after: "v1"}],
      isCheckpoint: true,
      itemId: "it1",
    });
    await recordAudit(db, {
      action: "edit",
      actorType: "author",
      diffData: [{op: "update", path: "title", before: "v1", after: "v2"}],
      isCheckpoint: false,
      itemId: "it1",
    });
    await recordAudit(db, {
      action: "edit",
      actorType: "author",
      diffData: [
        {op: "update", path: "_microfeed.volume", before: "第一卷", after: "第二卷"},
        {op: "add", path: "tags", after: ["热血"]},
      ],
      isCheckpoint: false,
      itemId: "it1",
    });

    const rows = await listItemAuditRows(db, "it1");
    expect(rows).toHaveLength(3);

    const restored = await rebuildItemVersion(db, "it1", rows[2]!.id);
    expect(restored).toEqual({
      _microfeed: {volume: "第二卷"},
      tags: ["热血"],
      title: "v2",
    });

    // The checkpoint row itself rebuilds to exactly its snapshot.
    expect(await rebuildItemVersion(db, "it1", rows[0]!.id)).toEqual({
      _microfeed: {volume: "第一卷"},
      title: "v1",
    });
  });

  it("returns null when the audit row belongs to another item", async () => {
    const database = newDatabase();
    const db = dbOf(database);
    await recordAudit(db, {
      action: "edit",
      actorType: "author",
      checkpointData: {title: "v1"},
      diffData: [],
      isCheckpoint: true,
      itemId: "it1",
    });

    expect(await rebuildItemVersion(db, "it2", "missing")).toBeNull();
  });
});

describe("review transition guards", () => {
  it("allows every transition the queue needs", () => {
    expect(isAllowedReviewTransition("draft", "submit")).toBe(true);
    expect(isAllowedReviewTransition("submitted", "approve")).toBe(true);
    expect(isAllowedReviewTransition("submitted", "reject")).toBe(true);
    expect(isAllowedReviewTransition("submitted", "takedown")).toBe(true);
    expect(isAllowedReviewTransition("approved", "takedown")).toBe(true);
    expect(isAllowedReviewTransition("rejected", "submit")).toBe(true);
    expect(isAllowedReviewTransition("rejected", "takedown")).toBe(true);
  });

  it("rejects illegal moves that would corrupt the workflow", () => {
    // A raw draft must not be approved (only submitted chapters are reviewable).
    expect(isAllowedReviewTransition("draft", "approve")).toBe(false);
    expect(isAllowedReviewTransition("draft", "reject")).toBe(false);
    expect(isAllowedReviewTransition("draft", "takedown")).toBe(false);
    // Re-submitting an already-approved chapter would silently unpublish it.
    expect(isAllowedReviewTransition("approved", "submit")).toBe(false);
    expect(isAllowedReviewTransition("approved", "reject")).toBe(false);
    // A submitted chapter cannot be re-submitted.
    expect(isAllowedReviewTransition("submitted", "submit")).toBe(false);
  });
});

describe("mergeRestoredVersion", () => {
  it("keeps the live review lifecycle, restoring only the historical body", () => {
    const existing = {
      title: "当前正文",
      _microfeed: {reviewStatus: "rejected", takedown: false},
    };
    const restored = {
      title: "旧正文",
      _microfeed: {reviewStatus: "submitted", takedown: false},
    };
    const merged = mergeRestoredVersion(existing, restored);
    // The body comes from the restored historical version...
    expect((merged as {title: string}).title).toBe("旧正文");
    // ...but the review lifecycle stays where the live chapter currently sits,
    // so a restore can never move a chapter back into the queue or clear a takedown.
    expect((merged._microfeed as Record<string, unknown>).reviewStatus).toBe("rejected");
    expect((merged._microfeed as Record<string, unknown>).takedown).toBe(false);
  });

  it("falls back to the restored review status only when the live one is absent", () => {
    const existing = {title: "x", _microfeed: {}};
    const restored = {title: "y", _microfeed: {reviewStatus: "submitted"}};
    const merged = mergeRestoredVersion(existing, restored);
    expect((merged._microfeed as Record<string, unknown>).reviewStatus).toBe("submitted");
  });
});

describe("creation checkpoint recoverability", () => {
  it("a forced creation checkpoint makes the first version restorable", async () => {
    const database = newDatabase();
    const db = dbOf(database);
    // The write seam records a creation with forceCheckpoint so version 1 is never
    // orphaned: without it, rebuildItemVersion returned null for the oldest row.
    const created = {title: "初版", _microfeed: {volume: "第一卷"}, id: "it1"};
    await recordItemEdit(db, {}, created, {forceCheckpoint: true});

    const rows = await listItemAuditRows(db, "it1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCheckpoint).toBe(true);

    const rebuilt = await rebuildItemVersion(db, "it1", rows[0]!.id);
    expect(rebuilt).toEqual(created);
  });
});
