/**
 * 中药 board actions. This project routes admin verbs through one file per
 * action (`ajax/volumes/assign.ts` → POST), keeping `index.ts` for the GET
 * board — an `export const PUT` on `index.ts` is not routed (404). So the board's
 * verbs share this file, all POST, distinguished by an `action` field:
 *   {action:"add",    bookId, name, text?}      → create
 *   {action:"update", id, name?, text?, status?} → rename / re-text / (un)publish
 *   {action:"delete", id}                        → soft delete (status = 3)
 * Restoring a soft-deleted row is the inverse verb and lives in `restore.ts`.
 *
 * The body is parsed **once** here and handed to the verb: a `Request` body is a
 * one-shot stream, and re-wrapping the request to re-read it is unreliable.
 */
import type {APIRoute} from "astro";

import {jsonResponse} from "@/server/http";
import {
  TCM_ENTRY_KINDS,
  tcmEntryEndpoints,
} from "@/server/admin/tcm-entry-handlers";

const endpoints = tcmEntryEndpoints(TCM_ENTRY_KINDS.yao);

/** `POST {action: "add" | "update" | "delete", ...}` */
export const POST: APIRoute = async (context) => {
  const raw = (await context.request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  const action = typeof raw?.action === "string" ? raw.action : "";
  if (action === "add") return endpoints.createWith(context as never, raw);
  if (action === "update") return endpoints.updateWith(context as never, raw);
  if (action === "delete") return endpoints.removeWith(context as never, raw);
  return jsonResponse({error: "errors.tcmEntries.invalidInput"}, {status: 400});
};
