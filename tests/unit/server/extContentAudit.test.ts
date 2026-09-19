import {describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";

import {
  AUDIT_CHECKPOINT_INTERVAL,
  applyDiff,
  computeDiff,
  countAuditRecords,
  readReviewStatus,
  recordAudit,
  recordItemEdit,
  rebuildFromCheckpoint,
  shouldCheckpoint,
  type AuditDb,
  type AuditDbPreparedStatement,
  type FieldChange,
  type ItemData,
} from "@/server/feed/extContentAudit";

/**
 * Test double for the D1-compatible `AuditDb` port. Backed by an in-memory
 * `node:sqlite` database so we exercise the real SQL the production code
 * issues against Cloudflare D1, without needing a live Worker binding.
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

function fakeAuditDb(database: DatabaseSync): AuditDb {
  return {
    prepare(sql: string) {
      return makeStatement(database, sql);
    },
  };
}

function newAuditTable(database: DatabaseSync): void {
  database.exec(
    `CREATE TABLE ext_content_audit (
      id TEXT PRIMARY KEY,
      item_id TEXT,
      channel_id TEXT,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      diff_data TEXT,
      checkpoint_data TEXT,
      is_checkpoint INTEGER,
      review_status TEXT,
      reason TEXT
    )`,
  );
}

function clone(data: ItemData): ItemData {
  return JSON.parse(JSON.stringify(data)) as ItemData;
}

describe("computeDiff", () => {
  it("reports add / update / remove at the top level", () => {
    const existing: ItemData = {title: "A", keep: "x"};
    const next: ItemData = {title: "B", extra: "y"};

    const diff = computeDiff(existing, next);

    expect(diff.find((d) => d.path === "title")).toEqual({
      path: "title",
      op: "update",
      before: "A",
      after: "B",
    });
    expect(diff.find((d) => d.path === "extra")?.op).toBe("add");
    expect(diff.find((d) => d.path === "keep")?.op).toBe("remove");
  });

  it("recurses into _microfeed so volume / chapterNo diff independently", () => {
    const existing: ItemData = {_microfeed: {volume: "v1", chapterNo: 1}};
    const next: ItemData = {_microfeed: {volume: "v2", chapterNo: 1}};

    const diff = computeDiff(existing, next);

    expect(diff.find((d) => d.path === "_microfeed.volume")).toEqual({
      path: "_microfeed.volume",
      op: "update",
      before: "v1",
      after: "v2",
    });
    // chapterNo unchanged -> no change recorded
    expect(diff.find((d) => d.path === "_microfeed.chapterNo")).toBeUndefined();
  });

  it("treats an array field as a single value (no per-element diff)", () => {
    const existing: ItemData = {tags: ["a", "b"]};
    const next: ItemData = {tags: ["a", "c"]};

    const diff = computeDiff(existing, next);

    expect(diff).toEqual([
      {path: "tags", op: "update", before: ["a", "b"], after: ["a", "c"]},
    ]);
  });
});

describe("shouldCheckpoint", () => {
  it("returns true on every Kth edit and false otherwise", () => {
    const K = 3;
    for (let count = 0; count < 12; count++) {
      expect(shouldCheckpoint(count, K)).toBe((count + 1) % K === 0);
    }
  });

  it("marks the Kth edit (not the 1st) as the first checkpoint", () => {
    expect(shouldCheckpoint(0, 3)).toBe(false); // 1st edit
    expect(shouldCheckpoint(2, 3)).toBe(true); // 3rd edit
  });

  it("never checkpoints for a non-positive K", () => {
    expect(shouldCheckpoint(5, 0)).toBe(false);
  });
});

describe("rebuildFromCheckpoint", () => {
  it("replays flattened diffs to reconstruct the latest version from v0", () => {
    const v0: ItemData = {
      title: "T0",
      description: "<p>0</p>",
      _microfeed: {volume: "v1", chapterNo: 1},
    };
    const v1 = applyDiff(clone(v0), computeDiff(v0, {...v0, title: "T1"}));
    const v2 = applyDiff(clone(v1), computeDiff(v1, {...v1, description: "<p>1</p>"}));
    const v3: ItemData = {
      ...v2,
      _microfeed: {...v2._microfeed, volume: "v2", chapterNo: 2},
      tags: ["xianxia"],
    };

    const diffs: FieldChange[] = [
      ...computeDiff(v0, v1),
      ...computeDiff(v1, v2),
      ...computeDiff(v2, v3),
    ];

    expect(rebuildFromCheckpoint(v0, diffs)).toEqual(v3);
  });

  it("reconstructs correctly from a later checkpoint (checkpoint + tail diffs)", () => {
    const v0: ItemData = {title: "T0", _microfeed: {volume: "v1", chapterNo: 1}};
    const v1 = applyDiff(clone(v0), computeDiff(v0, {...v0, title: "T1"}));
    const v2 = applyDiff(clone(v1), computeDiff(v1, {...v1, description: "<p>1</p>"}));
    const v3: ItemData = {
      ...v2,
      _microfeed: {...v2._microfeed, volume: "v2"},
      tags: ["a"],
    };

    const tail: FieldChange[] = [...computeDiff(v1, v2), ...computeDiff(v2, v3)];

    expect(rebuildFromCheckpoint(v1, tail)).toEqual(v3);
  });

  it("restores a removed field when a remove diff is replayed", () => {
    const base: ItemData = {title: "X", summary: "old"};
    const edited: ItemData = {title: "X"};
    const diffs = computeDiff(base, edited);

    expect(rebuildFromCheckpoint(base, diffs)).toEqual(edited);
  });

  it("reconstructs a version after a nested _microfeed field is removed", () => {
    const base: ItemData = {
      title: "X",
      _microfeed: {volume: "v1", chapterNo: 1, note: "draft"},
    };
    const edited: ItemData = {
      title: "X",
      _microfeed: {volume: "v2", chapterNo: 1},
    };
    const diffs = computeDiff(base, edited);

    // the nested `note` is a remove; `volume` is an update
    expect(diffs.find((d) => d.path === "_microfeed.note")?.op).toBe("remove");
    expect(diffs.find((d) => d.path === "_microfeed.volume")?.op).toBe("update");

    expect(rebuildFromCheckpoint(base, diffs)).toEqual(edited);
  });
});

describe("recordAudit + countAuditRecords", () => {
  it("persists an edit row with field-level diff and no checkpoint", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const diff = computeDiff({title: "A"}, {title: "B"});
    await recordAudit(db, {
      itemId: "it1",
      channelId: "ch1",
      action: "edit",
      actorType: "author",
      actorId: "u1",
      diffData: diff,
      isCheckpoint: false,
    });

    expect(await countAuditRecords(db, "it1")).toBe(1);
    const row = database
      .prepare(
        "SELECT action, actor_type, actor_id, diff_data, is_checkpoint, checkpoint_data " +
          "FROM ext_content_audit WHERE item_id = 'it1'",
      )
      .get() as Record<string, unknown>;
    expect(row.action).toBe("edit");
    expect(row.actor_type).toBe("author");
    expect(row.actor_id).toBe("u1");
    expect(row.is_checkpoint).toBe(0);
    expect(row.checkpoint_data).toBeNull();
    expect(JSON.parse(row.diff_data as string)).toEqual(diff);
  });

  it("stores the full checkpoint snapshot and review_status on a checkpoint", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const checkpoint: ItemData = {title: "T", _microfeed: {volume: "v1", chapterNo: 3}};
    await recordAudit(db, {
      itemId: "it2",
      action: "edit",
      actorType: "admin",
      diffData: [],
      isCheckpoint: true,
      checkpointData: checkpoint,
      reviewStatus: "submitted",
      reason: "needs review",
    });

    const row = database
      .prepare(
        "SELECT is_checkpoint, checkpoint_data, review_status, reason " +
          "FROM ext_content_audit WHERE item_id = 'it2'",
      )
      .get() as Record<string, unknown>;
    expect(row.is_checkpoint).toBe(1);
    expect(JSON.parse(row.checkpoint_data as string)).toEqual(checkpoint);
    expect(row.review_status).toBe("submitted");
    expect(row.reason).toBe("needs review");
  });

  it("counts per item and tolerates missing rows", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    expect(await countAuditRecords(db, "missing")).toBe(0);
    await recordAudit(db, {
      itemId: "itA",
      action: "edit",
      actorType: "admin",
      diffData: [],
      isCheckpoint: false,
    });
    await recordAudit(db, {
      itemId: "itA",
      action: "edit",
      actorType: "admin",
      diffData: [],
      isCheckpoint: false,
    });
    expect(await countAuditRecords(db, "itA")).toBe(2);
  });
});

describe("audit checkpoint cadence (end-to-end)", () => {
  const checkpointInterval = 3;

  /**
   * Drive a sequence of edits through the real `recordAudit` + `shouldCheckpoint`
   * + `countAuditRecords` trio exactly as production would: for each edit, count
   * the existing rows, decide whether it is a checkpoint, compute the diff, and
   * persist. `versions[0]` is the seed; each subsequent entry is one edit.
   */
  async function simulateEdits(
    db: AuditDb,
    itemId: string,
    versions: ItemData[],
  ): Promise<void> {
    let prev = versions[0]!;
    for (let i = 1; i < versions.length; i++) {
      const next = versions[i]!;
      const existingCount = await countAuditRecords(db, itemId);
      const isCheckpoint = shouldCheckpoint(existingCount, checkpointInterval);
      await recordAudit(db, {
        itemId,
        action: "edit",
        actorType: "author",
        diffData: computeDiff(prev, next),
        isCheckpoint,
        checkpointData: isCheckpoint ? next : null,
      });
      prev = next;
    }
  }

  it("emits exactly one checkpoint row on the Kth edit, carrying the full snapshot", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const v0: ItemData = {title: "T0", _microfeed: {volume: "v1"}};
    const v1: ItemData = {...v0, title: "T1"};
    const v2: ItemData = {...v1, title: "T2"};
    const v3: ItemData = {...v2, _microfeed: {volume: "v2"}, tags: ["a"]};

    await simulateEdits(db, "it1", [v0, v1, v2, v3]);

    const rows = database
      .prepare(
        "SELECT is_checkpoint, checkpoint_data, diff_data " +
          "FROM ext_content_audit WHERE item_id = 'it1'",
      )
      .all() as Array<{is_checkpoint: number; checkpoint_data: unknown; diff_data: string}>;

    // versions[0] is the seed, so the 4 versions above are 3 edits -> 3 rows.
    expect(rows.length).toBe(3);
    // only the 3rd edit (the Kth) is a checkpoint
    const checkpoints = rows.filter((r) => r.is_checkpoint === 1);
    expect(checkpoints.length).toBe(1);
    // the checkpoint snapshot is exactly v3 (edit #3's resulting data)
    expect(JSON.parse(checkpoints[0]!.checkpoint_data as string)).toEqual(v3);
    // and its diff matches the v2 -> v3 transition
    expect(JSON.parse(checkpoints[0]!.diff_data as string)).toEqual(computeDiff(v2, v3));
    // non-checkpoint rows carry no snapshot
    for (const r of rows) {
      if (r.is_checkpoint === 0) expect(r.checkpoint_data).toBeNull();
    }
  });

  it("refuses to record a checkpoint row without a snapshot (ADR-0003)", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    await expect(
      recordAudit(db, {
        itemId: "itX",
        action: "edit",
        actorType: "admin",
        diffData: [],
        isCheckpoint: true,
        // checkpointData intentionally omitted
      }),
    ).rejects.toThrow(/checkpointData/);
  });
});

describe("recordItemEdit", () => {
  function readRows(database: DatabaseSync) {
    return database
      .prepare(
        "SELECT action, actor_type, diff_data, is_checkpoint, checkpoint_data, review_status " +
          "FROM ext_content_audit WHERE item_id = 'it1' ORDER BY rowid ASC",
      )
      .all() as Array<{
        action: string;
        actor_type: string;
        diff_data: string;
        is_checkpoint: number;
        checkpoint_data: string | null;
        review_status: string | null;
      }>;
  }

  it("records one row carrying the field-level diff of the edit", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const before: ItemData = {title: "旧标题", _microfeed: {volume: "第一卷"}};
    const after: ItemData = {title: "新标题", _microfeed: {volume: "第一卷"}};
    await recordItemEdit(db, {...before, id: "it1"}, {...after, id: "it1"});

    const rows = readRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("edit");
    expect(rows[0]!.actor_type).toBe("author");
    expect(JSON.parse(rows[0]!.diff_data)).toEqual([
      {op: "update", path: "title", after: "新标题", before: "旧标题"},
    ]);
  });

  it("records nothing when the edit changes no field", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const same: ItemData = {title: "不变", _microfeed: {volume: "第一卷"}};
    await recordItemEdit(db, {...same, id: "it1"}, {...same, id: "it1"});

    expect(readRows(database)).toHaveLength(0);
  });

  it("snapshots the first row and then every Nth edit", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    for (let index = 1; index <= AUDIT_CHECKPOINT_INTERVAL; index += 1) {
      const next: ItemData = {title: `第${index}版`, id: "it1"};
      await recordItemEdit(db, {title: `第${index - 1}版`, id: "it1"}, next);
    }

    const rows = readRows(database);
    expect(rows).toHaveLength(AUDIT_CHECKPOINT_INTERVAL);
    // The first recorded row is always a snapshot — restore needs an anchor even for
    // items that never went through the write seam's create row — and every Nth edit
    // after it is one too.
    expect(rows[0]!.is_checkpoint).toBe(1);
    expect(JSON.parse(rows[0]!.checkpoint_data!)).toEqual({title: "第1版", id: "it1"});
    expect(rows[AUDIT_CHECKPOINT_INTERVAL - 1]!.is_checkpoint).toBe(1);
    expect(JSON.parse(rows[AUDIT_CHECKPOINT_INTERVAL - 1]!.checkpoint_data!))
      .toEqual({title: `第${AUDIT_CHECKPOINT_INTERVAL}版`, id: "it1"});
    expect(rows.filter((row) => row.is_checkpoint === 1)).toHaveLength(2);
    // Only the first and the Nth carry a snapshot.
    for (const row of rows.slice(1, -1)) expect(row.checkpoint_data).toBeNull();
  });

  it("mirrors the novel-cms review state onto the audit row", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    await recordItemEdit(
      db,
      {title: "草稿", id: "it1"},
      {_microfeed: {reviewStatus: "submitted"}, title: "提交版", id: "it1"},
    );

    expect(readRows(database)[0]!.review_status).toBe("submitted");
  });

  it("reads the review state only from a non-empty _microfeed string", () => {
    expect(readReviewStatus({_microfeed: {reviewStatus: "approved"}})).toBe("approved");
    expect(readReviewStatus({_microfeed: {reviewStatus: ""}})).toBeNull();
    expect(readReviewStatus({_microfeed: {reviewStatus: 7}})).toBeNull();
    expect(readReviewStatus({})).toBeNull();
  });

  it("forceCheckpoint emits a checkpoint on the very first edit so version 1 stays restorable", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    // The first write of an item has existingCount === 0, so the normal cadence
    // would not checkpoint it - but forceCheckpoint must, or version 1 would be
    // unrecoverable (the write seam passes forceCheckpoint on create).
    const created: ItemData = {title: "初版", _microfeed: {volume: "第一卷"}, id: "it1"};
    await recordItemEdit(db, {}, created, {forceCheckpoint: true});

    const rows = readRows(database);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_checkpoint).toBe(1);
    expect(JSON.parse(rows[0]!.checkpoint_data!)).toEqual(created);
  });

  it("checkpoints an item's first recorded row even without forceCheckpoint", async () => {
    // Items seeded straight into `items` (imports, fixtures, direct SQL) never
    // go through the write seam's create row, so their earliest audit row is an
    // *edit*. With no snapshot at or before it, rebuildItemVersion can never
    // replay and every "restore this version" fails. The first row must always
    // be a snapshot, with or without the caller's forceCheckpoint.
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    const first: ItemData = {id: "it1", title: "初版"};
    const second: ItemData = {id: "it1", title: "第二版"};
    // No forceCheckpoint anywhere: the first row is still a snapshot, and the
    // second one (edit #2 of 3) is not.
    await recordItemEdit(db, {}, first);
    await recordItemEdit(db, first, second);

    const rows = readRows(database);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.is_checkpoint).toBe(1);
    expect(JSON.parse(rows[0]!.checkpoint_data!)).toEqual(first);
    expect(rows[1]!.is_checkpoint).toBe(0);

    // And the periodic cadence still applies afterwards: edit #3 is a checkpoint.
    await recordItemEdit(db, second, {id: "it1", title: "第三版"});
    expect(readRows(database)[2]!.is_checkpoint).toBe(1);
  });

  it("snapshots the next edit when a legacy chain has no checkpoint", async () => {
    const database = new DatabaseSync(":memory:");
    newAuditTable(database);
    const db = fakeAuditDb(database);

    // A row recorded before the guarantee existed: no snapshot anywhere, so
    // restore had nothing to replay from.
    database
      .prepare(
        "INSERT INTO ext_content_audit " +
          "(id, item_id, action, actor_type, diff_data, is_checkpoint) " +
          "VALUES ('legacy1','it1','edit','author','[]',0)",
      )
      .run();

    const next: ItemData = {id: "it1", title: "接管后的第一版"};
    await recordItemEdit(db, {id: "it1", title: "旧版"}, next);

    const rows = readRows(database);
    expect(rows).toHaveLength(2);
    // The legacy row is left exactly as it was — history is never rewritten.
    expect(rows[0]!.is_checkpoint).toBe(0);
    // The new row gives the chain an anchor, so it (and everything after it)
    // becomes restorable without waiting for the periodic cadence.
    expect(rows[1]!.is_checkpoint).toBe(1);
    expect(JSON.parse(rows[1]!.checkpoint_data!)).toEqual(next);
  });
});
