import {env} from "cloudflare:workers";

import type {APIRoute} from "astro";

import {jsonResponse, localizedError, serviceError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {listTcmEntryBoard} from "@/server/feed/extTcmEntries";
import {writeItemContent} from "@/server/feed/extContentReview";
import type {AuditDb} from "@/server/feed/extContentAudit";
import type {VolumeDb} from "@/server/feed/extVolume";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";
import type {PermissionCode} from "@/shared/Constants";

/**
 * CRUD for the 中药 / 名词 boards (`/admin/yao/`, `/admin/term/`).
 *
 * Unlike the alias board — which keeps hand-written rows in an `ext_*` side table
 * and only merges them over the read-only import — a 中药/名词 entry **is** an
 * `items` row, so every operation here writes `items` directly. The import
 * pipeline stays the source of truth for ids: an entry's id must keep the
 * `tcmId(kind, sourceKey)` shape so 方剂 `fangYaoList[].yaoId` keeps resolving, and
 * a re-run of the importer must not orphan rows this board created (see
 * `novel-book-ops` §4.10 错误区 5).
 *
 * Deletion is soft (`status = 3`): the row disappears from the board and from
 * the App endpoints but stays restorable, because a 方剂 may still reference it.
 */
export interface TcmEntryCrudErrors {
  invalidInput: string;
  notFound: string;
  duplicate: string;
  bookMissing: string;
}

const ERRORS: TcmEntryCrudErrors = {
  invalidInput: "errors.tcmEntries.invalidInput",
  notFound: "errors.tcmEntries.notFound",
  duplicate: "errors.tcmEntries.duplicate",
  bookMissing: "errors.tcmEntries.bookMissing",
};

/** The two kinds this board serves, and the permission each one guards. */
export const TCM_ENTRY_KINDS = {
  yao: {
    kind: "yao",
    read: PERMISSION_CODES.CONTENT_YAO_READ,
    manage: PERMISSION_CODES.CONTENT_YAO_MANAGE,
  },
  term: {
    kind: "term",
    read: PERMISSION_CODES.CONTENT_TERM_READ,
    manage: PERMISSION_CODES.CONTENT_TERM_MANAGE,
  },
} as const;

export type TcmEntryKind = keyof typeof TCM_ENTRY_KINDS;

type EntrySpec = (typeof TCM_ENTRY_KINDS)[TcmEntryKind];

/**
 * 11-char base62 id, same shape as `tcmId` and the volume board's `newItemId`
 * (`volume-handlers.ts`). Random rather than derived, so a hand-added entry never
 * claims a future importer's deterministic id; retried against the unique index
 * because 11 base62 chars of `crypto.getRandomValues` can in principle repeat.
 */
function newEntryId(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(11);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

async function idExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM items WHERE id = ?")
    .bind(id)
    .first<{x: number}>();
  return row != null;
}

async function allocateId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newEntryId();
    if (!(await idExists(db, id))) return id;
  }
  throw new Error("无法分配唯一条目 id");
}

interface EntryRow {
  id: string;
  tcm_kind: string;
  status: number;
  data: string;
  book_id: string;
}

async function loadEntry(db: D1Database, id: string): Promise<EntryRow | null> {
  const row = await db
    .prepare("SELECT id, tcm_kind, status, data, book_id FROM items WHERE id = ?")
    .bind(id)
    .first<EntryRow>();
  return row ?? null;
}

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

interface ParsedBody {
  bookId: string;
  id: string;
  name: string;
  text: string;
  status: number | null;
}

const NAME_MAX = 200;
const TEXT_MAX = 20_000;

function parseBody(raw: unknown): ParsedBody {
  const body = (raw ?? {}) as Record<string, unknown>;
  const num = Number(body.status);
  return {
    bookId: typeof body.bookId === "string" ? body.bookId.trim() : "",
    id: typeof body.id === "string" ? body.id.trim() : "",
    name: typeof body.name === "string" ? body.name.trim().slice(0, NAME_MAX) : "",
    text: typeof body.text === "string" ? body.text.slice(0, TEXT_MAX) : "",
    status: Number.isInteger(num) ? num : null,
  };
}

/** Deterministic inverse of the importer's `textToHtml` (one `<p>` per line). */
function textToHtml(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks = lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => `<p>${line}</p>`);
  return blocks.join("\r\n");
}

/** Next display ordinal for an added entry: one past the book's current max `no`. */
async function nextNo(db: D1Database, bookId: string, kind: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT MAX(json_extract(data, '$._microfeed.no')) AS m FROM items " +
        "WHERE book_id = ? AND tcm_kind = ?",
    )
    .bind(bookId, kind)
    .first<{m: number | null}>();
  return Number(row?.m ?? -1) + 1;
}

/** True when another live entry of this kind in the same book carries that name. */
async function nameTaken(
  db: D1Database,
  bookId: string,
  kind: string,
  name: string,
  exceptId: string,
): Promise<boolean> {
  const rows = await db
    .prepare(
      "SELECT id, data FROM items WHERE book_id = ? AND tcm_kind = ? AND status != ?",
    )
    .bind(bookId, kind, STATUSES.DELETED)
    .all<{id: string; data: string}>();
  for (const row of rows.results ?? []) {
    if (row.id === exceptId) continue;
    const title = parseData(row.data).title;
    if (typeof title === "string" && title.trim() === name) return true;
  }
  return false;
}

async function respond(
  db: D1Database,
  bookId: string,
  kind: string,
  includeDeleted: boolean,
): Promise<Response> {
  return jsonResponse(
    {board: await listTcmEntryBoard(db as unknown as VolumeDb, bookId, kind, includeDeleted)},
    {headers: {"cache-control": "private, no-store"}},
  );
}

/** The parsed JSON payload a verb should act on, when the route already read it. */
type EntryBody = Record<string, unknown> | null;

/**
 * Build the five endpoints for one kind, so a route file just picks its spec:
 * `const h = tcmEntryEndpoints(TCM_ENTRY_KINDS.yao)`.
 *
 * Every verb takes an optional pre-parsed `body`. The `action.ts` route reads the
 * request body **once** to pick the verb, then hands the same object down —
 * a `Request` body is a one-shot stream, and re-wrapping the Astro request to
 * re-read it is unreliable (it silently yielded `null`, so writes landed on
 * `status` but never on `data`). Routes that mount a single verb per file (no
 * dispatch) can omit it and let the handler read the body itself.
 */
export function tcmEntryEndpoints(spec: EntrySpec) {
  /**
   * `POST {bookId, name, text?, status?}` — add a 中药/名词 entry.
   *
   * The new row gets a fresh 11-char id and `_microfeed.no` = max + 1 so it lands
   * at the end of the board. The body is stored through the same `<p>` wrapping
   * the importer uses, so the item editor and the App endpoints read it
   * unchanged.
   */
  const create = async (
    {locals, request}: {locals: never; request: Request},
    preParsed?: EntryBody,
  ): Promise<Response> => {
    const guard = await requireRbac(
      locals,
      spec.manage as PermissionCode,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;

    const {bookId, name, text, status} = parseBody(
      preParsed !== undefined
        ? preParsed
        : await request.json().catch(() => null),
    );
    if (!bookId || name === "") {
      return localizedError(request, ERRORS.invalidInput, 400);
    }
    const db = env.FEED_DB;
    const book = await db.prepare("SELECT 1 AS x FROM channels WHERE id = ?")
      .bind(bookId)
      .first<{x: number}>();
    if (book == null) return localizedError(request, ERRORS.bookMissing, 404);
    if (await nameTaken(db, bookId, spec.kind, name, "")) {
      return localizedError(request, ERRORS.duplicate, 409, {name});
    }

    const id = await allocateId(db);
    const no = await nextNo(db, bookId, spec.kind);
    const now = new Date().toISOString();
    const data = {
      title: name,
      description: textToHtml(text),
      _microfeed: {bookId, no},
    };
    await db
      .prepare(
        "INSERT INTO items " +
          "(id, status, data, created_at, updated_at, book_id, tcm_kind, tcm_parent_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .bind(
        id,
        status ?? STATUSES.PUBLISHED,
        JSON.stringify(data),
        now,
        now,
        bookId,
        spec.kind,
      )
      .run();
    return respond(db, bookId, spec.kind, false);
  };

  /**
   * `PUT {id, name?, text?, status?}` — rename / re-text / (un)publish an entry.
   * `bookId` comes from the stored row so the response re-renders the board the
   * entry belongs to.
   */
  const update = async (
    {locals, request}: {locals: never; request: Request},
    preParsed?: EntryBody,
  ): Promise<Response> => {
    const guard = await requireRbac(
      locals,
      spec.manage as PermissionCode,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;

    // `text` is checked on the raw payload because an empty string is a
    // legitimate edit (clear the body) that `parseBody` can't tell from
    // "field absent".
    const raw = (preParsed !== undefined
      ? preParsed
      : await request.json().catch(() => null)) as Record<string, unknown> | null;
    const body = parseBody(raw);
    const id = body.id;
    if (!id) return localizedError(request, ERRORS.invalidInput, 400);

    const db = env.FEED_DB;
    const existing = await loadEntry(db, id);
    if (existing == null || existing.tcm_kind !== spec.kind) {
      return localizedError(request, ERRORS.notFound, 404);
    }
    const before = parseData(existing.data);
    if (body.name !== "" && body.name !== before.title) {
      if (await nameTaken(db, existing.book_id, spec.kind, body.name, id)) {
        return localizedError(request, ERRORS.duplicate, 409, {name: body.name});
      }
    }

    const after: Record<string, unknown> = {...before};
    if (body.name !== "") after.title = body.name;
    if (typeof raw?.text === "string") after.description = textToHtml(body.text);
    const nextStatus = body.status ?? Number(existing.status);
    // `writeItemContent` keeps `content_text` / `review_status` in step with
    // `data`; the `status` column is a separate concern, so it is set here.
    await writeItemContent(
      db as unknown as AuditDb,
      id,
      JSON.stringify(after),
    );
    if (nextStatus !== Number(existing.status)) {
      await db
        .prepare("UPDATE items SET status = ? WHERE id = ?")
        .bind(nextStatus, id)
        .run();
    }
    return respond(db, existing.book_id, spec.kind, false);
  };

  /**
   * `DELETE {id}` — soft-delete (status = 3). The row leaves the board and the
   * App endpoints but stays in the table, so a 方剂 that still points at it
   * keeps a resolvable target and the entry can be restored.
   */
  const remove = async (
    {locals, request}: {locals: never; request: Request},
    preParsed?: EntryBody,
  ): Promise<Response> => {
    const guard = await requireRbac(
      locals,
      spec.manage as PermissionCode,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;

    const {id} = parseBody(
      preParsed !== undefined
        ? preParsed
        : await request.json().catch(() => null),
    );
    if (!id) return localizedError(request, ERRORS.invalidInput, 400);
    const db = env.FEED_DB;
    const existing = await loadEntry(db, id);
    if (existing == null || existing.tcm_kind !== spec.kind) {
      return localizedError(request, ERRORS.notFound, 404);
    }
        // Only the `status` column changes here, so the canonical `writeItemContent`
    // path isn't needed (it exists to keep `data`'s derived columns in step).
    await db
      .prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?")
      .bind(STATUSES.DELETED, new Date().toISOString(), id)
      .run();
    return respond(db, existing.book_id, spec.kind, false);
  };

  /** `POST {id, status?}` — restore a soft-deleted entry (default: published). */
  const restore = async (
    {locals, request}: {locals: never; request: Request},
    preParsed?: EntryBody,
  ): Promise<Response> => {
    const guard = await requireRbac(
      locals,
      spec.manage as PermissionCode,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;

    const {id, status} = parseBody(
      preParsed !== undefined
        ? preParsed
        : await request.json().catch(() => null),
    );
    if (!id) return localizedError(request, ERRORS.invalidInput, 400);
    const db = env.FEED_DB;
    const existing = await loadEntry(db, id);
    if (existing == null || existing.tcm_kind !== spec.kind) {
      return localizedError(request, ERRORS.notFound, 404);
    }
        const restored = status ?? STATUSES.PUBLISHED;
    await db
      .prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?")
      .bind(restored, new Date().toISOString(), id)
      .run();
    return respond(db, existing.book_id, spec.kind, true);
  };

  /** `GET ?bookId=[&deleted=1]` — the board, or the recycle view when asked. */
  const list: APIRoute = async ({locals, request}) => {
    const guard = await requireRbac(
      locals,
      spec.read as PermissionCode,
      request,
      env.FEED_DB,
    );
    if (guard) return guard;
    const url = new URL(request.url);
    const bookId = url.searchParams.get("bookId") ?? "";
    try {
      return await respond(
        env.FEED_DB,
        bookId,
        spec.kind,
        url.searchParams.get("deleted") === "1",
      );
    } catch (error) {
      const response = serviceError(error);
      if (response) return response;
      throw error;
    }
  };

  // `create`/`update`/`remove`/`restore` take an optional pre-parsed body; the
  // `APIRoute`-shaped wrappers below drop it, so a route that mounts a single
  // verb per file (no dispatch) can export them directly.
  const asRoute = (
    fn: (
      context: {locals: never; request: Request},
      preParsed?: EntryBody,
    ) => Promise<Response>,
  ): APIRoute => (context) => fn(context as never);

  return {
    create: asRoute(create),
    update: asRoute(update),
    remove: asRoute(remove),
    restore: asRoute(restore),
    list,
    // Pre-parsed-body variants, for a dispatching route that already read the
    // request body to pick a verb.
    createWith: create,
    updateWith: update,
    removeWith: remove,
  };
}
