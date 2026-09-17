import {describe, expect, it} from "vitest";
import {DatabaseSync} from "node:sqlite";

import {
  applyDiff,
  computeDiff,
  countAuditRecords,
  recordAudit,
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
