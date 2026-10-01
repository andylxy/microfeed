import {env} from "cloudflare:workers";

import type {APIRoute} from "astro";
import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {getDerivedYaoAliases} from "@/server/tcm/reads";
import {PERMISSION_CODES} from "@/shared/Constants";

export interface AdminAliasRow {
  /** `ext_tcm_aliases.id` for a manual/hidden row; `null` for a derived one. */
  id: string | null;
  bieming: string;
  name: string;
  /** `manual` = 手工覆盖别名（可编辑）；`derived` = 导入别名（只读，可覆盖/隐藏）；`hidden` = 被隐藏的导入别名（可恢复）。 */
  source: "manual" | "derived" | "hidden";
}

/** Manual overrides + hide directives from `ext_tcm_aliases` — the CRUD target. */
async function listExtAliasRows(
  db: D1Database,
): Promise<Array<{id: string; bieming: string; name: string; deleted: number}>> {
  const result = await db
    .prepare(
      "SELECT id, bieming, name, deleted FROM ext_tcm_aliases ORDER BY bieming ASC",
    )
    .all<{id: string; bieming: string; name: string; deleted: number}>();
  return result.results ?? [];
}

/**
 * The alias board's rows: every effective alias, each tagged with its source so
 * the UI knows which actions apply:
 *   - `manual`  — a row in `ext_tcm_aliases` (deleted=0): a manual override that
 *                 wins over a same-named derived alias. Editable/deletable here.
 *   - `derived` — an imported alias (yaoAlias / YaoList / BieMing), read-only.
 *                 Can be overridden (adds a manual row) or hidden (adds a
 *                 deleted=1 row) from this board.
 *   - `hidden`  — a derived alias that has a `deleted=1` directive; shown so it
 *                 can be restored (the directive is removed).
 *
 * A manual override whose `bieming` matches a derived one replaces it in the
 * list (and in the app endpoint too — `getDerivedYaoAliases`/`getAppYaoAliases`
 * merge `ext_tcm_aliases` last). Hidden `bieming`s drop out of the derived set.
 */
export async function listAliases(db: D1Database): Promise<AdminAliasRow[]> {
  const derived = await getDerivedYaoAliases(db);
  const extRows = await listExtAliasRows(db);

  const overrideBieming = new Set<string>();
  const hiddenById = new Map<string, string>();
  const rows: AdminAliasRow[] = [];

  for (const row of extRows) {
    if (row.deleted === 1) {
      // Hide directive for a derived alias — surface it as a `hidden` row.
      hiddenById.set(row.bieming, row.id);
    } else {
      overrideBieming.add(row.bieming);
      rows.push({
        id: row.id,
        bieming: row.bieming,
        name: row.name,
        source: "manual",
      });
    }
  }

  for (const [bieming, name] of derived) {
    if (overrideBieming.has(bieming)) continue; // manual override wins
    const hiddenId = hiddenById.get(bieming);
    if (hiddenId) {
      rows.push({id: hiddenId, bieming, name, source: "hidden"});
    } else {
      rows.push({id: null, bieming, name, source: "derived"});
    }
  }

  return rows.sort((a, b) => a.bieming.localeCompare(b.bieming, "zh"));
}

/** `GET` — the alias board rows, guarded by `content:alias:read`. */
export const listAliasesEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ALIAS_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  return jsonResponse(
    {aliases: await listAliases(env.FEED_DB)},
    {headers: {"cache-control": "private, no-store"}},
  );
};

function parseAliasBody(body: unknown): {bieming: string; name: string} {
  const parsed = body as {bieming?: unknown; name?: unknown} | null;
  return {
    bieming: typeof parsed?.bieming === "string" ? parsed.bieming.trim() : "",
    name: typeof parsed?.name === "string" ? parsed.name.trim() : "",
  };
}

/** `POST {bieming, name}` — add or override a manual alias (`content:alias:manage`). */
export const createAliasEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ALIAS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const {bieming, name} = parseAliasBody(await request.json().catch(() => null));
  if (!bieming || !name) {
    return localizedError(request, "errors.aliases.invalidInput", 400);
  }
  const now = Date.now();
  const existing = await env.FEED_DB
    .prepare("SELECT id FROM ext_tcm_aliases WHERE bieming = ?")
    .bind(bieming)
    .first<{id: string}>();
  if (existing) {
    // Upsert: editing an existing override, or overriding a hidden directive.
    await env.FEED_DB
      .prepare(
        "UPDATE ext_tcm_aliases SET name = ?, deleted = 0, updated_at_ms = ? WHERE id = ?",
      )
      .bind(name, now, existing.id)
      .run();
  } else {
    await env.FEED_DB
      .prepare(
        "INSERT INTO ext_tcm_aliases " +
          "(id, bieming, name, created_at_ms, updated_at_ms, deleted) VALUES (?, ?, ?, ?, ?, 0)",
      )
      .bind(crypto.randomUUID(), bieming, name, now, now)
      .run();
  }
  return jsonResponse({aliases: await listAliases(env.FEED_DB)});
};

/** `PUT {id, bieming, name}` — edit a manual alias (`content:alias:manage`). */
export const updateAliasEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ALIAS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const raw = (await request.json().catch(() => null)) as {id?: unknown} | null;
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  const {bieming, name} = parseAliasBody(raw);
  if (!id || !bieming || !name) {
    return localizedError(request, "errors.aliases.invalidInput", 400);
  }
  const existing = await env.FEED_DB
    .prepare("SELECT id FROM ext_tcm_aliases WHERE id = ?")
    .bind(id)
    .first<{id: string}>();
  if (!existing) {
    return localizedError(request, "errors.aliases.notFound", 404);
  }
  const clash = await env.FEED_DB
    .prepare("SELECT id FROM ext_tcm_aliases WHERE bieming = ? AND id != ?")
    .bind(bieming, id)
    .first<{id: string}>();
  if (clash) {
    return localizedError(request, "errors.aliases.duplicate", 409);
  }
  await env.FEED_DB
    .prepare(
      "UPDATE ext_tcm_aliases SET bieming = ?, name = ?, updated_at_ms = ? WHERE id = ?",
    )
    .bind(bieming, name, Date.now(), id)
    .run();
  return jsonResponse({aliases: await listAliases(env.FEED_DB)});
};

/**
 * `DELETE` — two shapes, both `content:alias:manage`:
 *   - `{id}`            → hard-delete that `ext_tcm_aliases` row. Used for a
 *                         manual override (derived reappears) or a hidden
 *                         directive (derived is restored).
 *   - `{bieming, hide}` → upsert a `deleted=1` directive that hides the
 *                         same-named derived alias from the board and the app
 *                         endpoint.
 */
export const deleteAliasEndpoint: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_ALIAS_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  const raw = (await request.json().catch(() => null)) as {
    id?: unknown;
    bieming?: unknown;
    hide?: unknown;
  } | null;

  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (id) {
    const existing = await env.FEED_DB
      .prepare("SELECT id FROM ext_tcm_aliases WHERE id = ?")
      .bind(id)
      .first<{id: string}>();
    if (!existing) {
      return localizedError(request, "errors.aliases.notFound", 404);
    }
    await env.FEED_DB
      .prepare("DELETE FROM ext_tcm_aliases WHERE id = ?")
      .bind(id)
      .run();
    return jsonResponse({aliases: await listAliases(env.FEED_DB)});
  }

  const bieming =
    typeof raw?.bieming === "string" ? raw.bieming.trim() : "";
  const hide = raw?.hide === true;
  if (bieming && hide) {
    const now = Date.now();
    const existing = await env.FEED_DB
      .prepare("SELECT id FROM ext_tcm_aliases WHERE bieming = ?")
      .bind(bieming)
      .first<{id: string}>();
    if (existing) {
      await env.FEED_DB
        .prepare(
          "UPDATE ext_tcm_aliases SET deleted = 1, updated_at_ms = ? WHERE id = ?",
        )
        .bind(now, existing.id)
        .run();
    } else {
      await env.FEED_DB
        .prepare(
          "INSERT INTO ext_tcm_aliases " +
            "(id, bieming, name, created_at_ms, updated_at_ms, deleted) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(crypto.randomUUID(), bieming, bieming, now, now)
        .run();
    }
    return jsonResponse({aliases: await listAliases(env.FEED_DB)});
  }

  return localizedError(request, "errors.aliases.invalidInput", 400);
};
