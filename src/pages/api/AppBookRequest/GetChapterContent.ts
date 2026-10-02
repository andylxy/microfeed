import type {APIRoute} from "astro";
import {env} from "cloudflare:workers";

import {jsonResponse} from "@/server/http";
import {appEnvelope} from "@/server/tcm/envelope";
import {getAppChapterContent} from "@/server/tcm/reads";

export const GET: APIRoute = async ({url}) => {
  // The legacy app calls this endpoint with the old .NET backend's parameter
  // names — `bookId` (channel) + `contentId` (chapter section) + `signatureId`
  // (the chapter id it received from GetBookChapter) — whereas the golden
  // capture tool uses the microfeed-native `chapterId`. Both carry the chapter's
  // 11-char id, so accept either; the app's `signatureId` is the one that must
  // keep working (it was rejected with 400 before, breaking the reader).
  const chapterId = url.searchParams.get("chapterId") ??
    url.searchParams.get("signatureId") ?? "";
  if (!chapterId) return jsonResponse({error: "missing chapterId"}, {status: 400});
  return jsonResponse(appEnvelope(await getAppChapterContent(env.FEED_DB, chapterId)), {
    headers: {"cache-control": "public, max-age=300"},
  });
};
