/**
 * 「版本管理 → 历史包」端点：`GET` 列出上传过的 APK，`DELETE` 删掉一个。
 *
 * - `GET` 守 `system:app-version:read`（与配置读同码）；
 * - `DELETE` 守 `system:app-version:manage`，并且**拒绝删除当前下载地址指向的包** ——
 *   旧客户端可能缓存过那个 URL，删了它等于让那批用户升级时下不到包。
 *
 * 删除的作用域由 `apk-store.deleteUploadedApk` 限制在 `<环境>/app/` 前缀内，
 * 不会波及同 bucket 里的图片与主题资源。
 */
import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {readAppVersionConfig} from "@/server/app-version/config";
import {
  deleteUploadedApk,
  listUploadedApks,
} from "@/server/app-version/apk-store";
import {mediaBucket, mediaStorageUnavailableResponse} from "@/server/media/storage";
import {jsonResponse} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {isCurrentDownloadTarget} from "@/shared/AppDeviceVersion";
import {PERMISSION_CODES} from "@/shared/Constants";

const NO_STORE = {"cache-control": "private, no-store"} as const;

export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_VERSION_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  if (!mediaBucket(env)) {
    return mediaStorageUnavailableResponse();
  }
  return jsonResponse(
    {apks: await listUploadedApks(env, request.url)},
    {headers: NO_STORE},
  );
};

export const DELETE: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.SYSTEM_APP_VERSION_MANAGE,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;
  if (!mediaBucket(env)) {
    return mediaStorageUnavailableResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({error: "Invalid deletion request."}, {status: 400});
  }
  const key = typeof (raw as {key?: unknown} | null)?.key === "string"
    ? ((raw as {key: string}).key).trim()
    : "";
  if (!key) {
    return jsonResponse({error: "A key is required."}, {status: 400});
  }

  // 当前在用 → 拒绝。放在删除之前问，而不是「删了再报错」。
  const config = await readAppVersionConfig(env.FEED_DB);
  if (isCurrentDownloadTarget(config.downloadUrl, key)) {
    return jsonResponse(
      {
        error:
          "This package is the one the download URL points at. Point the URL elsewhere first.",
        reason: "currentDownloadTarget",
      },
      {status: 409},
    );
  }

  const deleted = await deleteUploadedApk(env, request.url, key);
  if (!deleted) {
    // 键不在 `<环境>/app/` 前缀内：不做删除（防止变成删任意对象的后门）。
    return jsonResponse({error: "Key is not an uploaded app package."}, {status: 400});
  }
  return jsonResponse({deleted: true}, {headers: NO_STORE});
};
