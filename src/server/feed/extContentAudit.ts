import {randomShortUUID} from "@/shared/StringUtils";

/**
 * Content-audit engine for the novel-cms extension.
 *
 * Records every edit to an item as a field-level diff (per ADR-0003:
 * "audit trail = field-level diff + periodic checkpoints"). The diff model
 * keeps storage small while still reconstructing any historical version by
 * replaying diffs forward from the nearest full checkpoint snapshot.
 *
 * All database access goes through the minimal `AuditDb` port so the engine
 * can be unit-tested against an in-memory SQLite and run unchanged against a
 * real Cloudflare D1 binding in production (a `D1Database` is structurally
 * assignable to `AuditDb`).
 */

export type AuditAction =
  | "edit"
  | "submit"
  | "approve"
  | "reject"
  | "takedown"
  | "restore"
  | "auto_flag";

export type ActorType = "admin" | "author" | "reviewer" | "system";

export type FieldOp = "add" | "update" | "remove";

/** A single field-level change between two versions of an item's `data`. */
export interface FieldChange {
  /** Dot-path to the changed field, e.g. "title" or "_microfeed.volume". */
  path: string;
  op: FieldOp;
  before?: unknown;
  after?: unknown;
}

export type ItemData = Record<string, any>;

/** Subset of `D1Result` the engine relies on. */
export interface D1ResultLike {
  results: Record<string, unknown>[];
  success: boolean;
}

export interface AuditDbPreparedStatement {
  bind(...values: unknown[]): AuditDbPreparedStatement;
  run(): Promise<D1ResultLike>;
  all(): Promise<D1ResultLike>;
  first(): Promise<unknown>;
}

/** Minimal D1-shaped database port used by this engine. */
export interface AuditDb {
  prepare(query: string): AuditDbPreparedStatement;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

/**
 * Compute the field-level difference between two item `data` objects.
 * Nested plain objects (e.g. `_microfeed`) are diffed recursively so that
 * `volume` / `chapterNo` / `tags` are reported as independent fields.
 */
export function computeDiff(existing: ItemData, next: ItemData): FieldChange[] {
  const changes: FieldChange[] = [];
  const keys = new Set([...Object.keys(existing), ...Object.keys(next)]);
  for (const key of keys) {
    const inExisting = Object.prototype.hasOwnProperty.call(existing, key);
    const inNext = Object.prototype.hasOwnProperty.call(next, key);
    const existingVal = existing[key];
    const nextVal = next[key];
    if (inExisting && inNext) {
      if (isPlainObject(existingVal) && isPlainObject(nextVal)) {
        const nested = computeDiff(existingVal, nextVal);
        for (const c of nested) {
          changes.push({
            path: `${key}.${c.path}`,
            op: c.op,
            before: c.before,
            after: c.after,
          });
        }
      } else if (!deepEqual(existingVal, nextVal)) {
        changes.push({path: key, op: "update", before: existingVal, after: nextVal});
      }
    } else if (inNext && !inExisting) {
      changes.push({path: key, op: "add", after: nextVal});
    } else if (inExisting && !inNext) {
      changes.push({path: key, op: "remove", before: existingVal});
    }
  }
  return changes;
}

/**
 * Decide whether the current edit should produce a full checkpoint snapshot.
 * `existingCount` is the number of audit rows already recorded for this item
 * BEFORE this edit; the current edit is #(existingCount + 1). A checkpoint is
 * emitted on every `checkpointInterval`-th edit (K, 2K, 3K, ...).
 */
export function shouldCheckpoint(existingCount: number, checkpointInterval: number): boolean {
  if (checkpointInterval <= 0) return false;
  return (existingCount + 1) % checkpointInterval === 0;
}

function clone(data: ItemData): ItemData {
  return JSON.parse(JSON.stringify(data)) as ItemData;
}

/**
 * Walk to (and return) the parent container of the leaf at `path`, creating
 * intermediate plain objects as needed. Shared by `setByPath` / `deleteByPath`.
 */
function walkToParent(obj: any, path: string): any {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1]!;
  walkToParent(obj, path)[leaf] = value;
}

function deleteByPath(obj: any, path: string): void {
  const parts = path.split(".");
  const leaf = parts[parts.length - 1]!;
  delete walkToParent(obj, path)[leaf];
}

/** Apply an ordered list of field changes to a copy of `data`. */
export function applyDiff(data: ItemData, changes: FieldChange[]): ItemData {
  const result = clone(data);
  for (const c of changes) {
    if (c.op === "remove") {
      deleteByPath(result, c.path);
    } else {
      setByPath(result, c.path, c.after);
    }
  }
  return result;
}

/**
 * Reconstruct a target version from a full checkpoint snapshot plus the
 * ordered field-level diffs between the checkpoint and that version.
 */
export function rebuildFromCheckpoint(
  checkpointData: ItemData,
  diffs: FieldChange[],
): ItemData {
  return applyDiff(checkpointData, diffs);
}

export interface RecordAuditParams {
  itemId: string;
  channelId?: string | null;
  action: AuditAction;
  actorType: ActorType;
  actorId?: string | null;
  diffData: FieldChange[];
  isCheckpoint: boolean;
  checkpointData?: ItemData | null;
  reviewStatus?: string | null;
  reason?: string | null;
}

const INSERT_AUDIT = `INSERT INTO ext_content_audit (
  id, item_id, channel_id, action, actor_type, actor_id,
  diff_data, checkpoint_data, is_checkpoint, review_status, reason
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Persist one audit row. The caller is responsible for computing `diffData`
 * (via `computeDiff`) and deciding `isCheckpoint` (via `shouldCheckpoint`),
 * then passing the current full `data` as `checkpointData` on checkpoint rows.
 *
 * A checkpoint row MUST carry `checkpointData` (ADR-0003: a checkpoint is a
 * full snapshot); recording a checkpoint without one would make
 * `rebuildFromCheckpoint` unable to restore the version, so we refuse it.
 */
export async function recordAudit(
  db: AuditDb,
  params: RecordAuditParams,
): Promise<void> {
  if (params.isCheckpoint && params.checkpointData == null) {
    throw new Error("extContentAudit: a checkpoint row must include checkpointData");
  }
  await db
    .prepare(INSERT_AUDIT)
    .bind(
      randomShortUUID(),
      params.itemId,
      params.channelId ?? null,
      params.action,
      params.actorType,
      params.actorId ?? null,
      JSON.stringify(params.diffData ?? []),
      params.isCheckpoint ? JSON.stringify(params.checkpointData) : null,
      params.isCheckpoint ? 1 : 0,
      params.reviewStatus ?? null,
      params.reason ?? null,
    )
    .run();
}

const COUNT_AUDIT = `SELECT COUNT(*) AS c FROM ext_content_audit WHERE item_id = ?`;

/** Number of audit rows already recorded for an item (used by checkpointing). */
export async function countAuditRecords(
  db: AuditDb,
  itemId: string,
): Promise<number> {
  const row = await db.prepare(COUNT_AUDIT).bind(itemId).first();
  if (row == null) return 0;
  const c = (row as Record<string, unknown>).c;
  return typeof c === "number" ? c : Number(c);
}
