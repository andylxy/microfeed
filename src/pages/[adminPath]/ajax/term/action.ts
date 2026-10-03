/**
 * 名词 board actions — counterpart of `ajax/yao/action.ts`. One file per action
 * because this project routes admin verbs that way; all POST, dispatched by an
 * `action` field. The body is parsed once and passed down (a `Request` body is a
 * one-shot stream).
 */
import type {APIRoute} from "astro";

import {jsonResponse} from "@/server/http";
import {
  TCM_ENTRY_KINDS,
  tcmEntryEndpoints,
} from "@/server/admin/tcm-entry-handlers";

const endpoints = tcmEntryEndpoints(TCM_ENTRY_KINDS.term);

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
