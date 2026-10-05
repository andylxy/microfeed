import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  DELETE as apksDelete,
  GET as apksGet,
} from "@/pages/[adminPath]/ajax/app-versions/apks";
import {saveAppVersionConfig} from "@/server/app-version/config";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 「历史包」端点（`/admin/ajax/app-versions/apks`）：列出/删除 R2 里上传过的 APK。
 *
 * 三条不变量值得钉死，它们都是**安全相关**的，读代码看不出对错：
 *   1. 只列 `<环境>/app/` 前缀 —— 否则本地后台会列到生产的对象；
 *   2. 删除只作用于该前缀内 —— 否则这个端点变成「删任意 R2 对象」的后门
 *      （同一个 bucket 里躺着条目图片与主题资源）；
 *   3. 拒绝删除**当前下载地址指向的包** —— 旧客户端缓存过那个 URL，
 *      删了它等于让那批用户升级时下不到包。
 *
 * worker 测试环境里 `DEPLOYMENT_ENVIRONMENT=production`，且请求 host 不是本地开发域名，
 * 所以环境前缀是 `production`。
 */
const READ = PERMISSION_CODES.SYSTEM_APP_VERSION_READ;
const MANAGE = PERMISSION_CODES.SYSTEM_APP_VERSION_MANAGE;
const PREFIX = "production/app/";
const URL = "https://feed.example.com/admin/ajax/app-versions/apks/";

function locals(permissions: string[]) {
  return {
    authUser: {id: "u_apk_admin"},
    rbacPermissions: new Set<string>(permissions),
  };
}

function request(method = "GET", body?: unknown): Request {
  return new Request(URL, {
    ...(body === undefined
      ? {}
      : {
        body: JSON.stringify(body),
        headers: {"content-type": "application/json"},
      }),
    method,
  });
}

/** 放一个对象，返回它的 ETag（= 内容 MD5）。 */
async function put(key: string, content: string): Promise<string> {
  const object = await env.MEDIA_BUCKET.put(key, content);
  return object?.etag ?? "";
}

/** 桶在同一测试文件内共享，逐例清空，避免互相看见。 */
async function clearBucket(): Promise<void> {
  const listed = await env.MEDIA_BUCKET.list();
  for (const object of listed.objects) {
    await env.MEDIA_BUCKET.delete(object.key);
  }
}

async function listNames(): Promise<string[]> {
  const response = await apksGet({
    locals: locals([READ]),
    request: request(),
  } as never);
  const body = await response.json() as {apks: Array<{name: string}>};
  return body.apks.map((apk) => apk.name);
}

beforeEach(async () => {
  await clearBucket();
  await saveAppVersionConfig(env.FEED_DB, {
    downloadUrl: "",
    latestVersionName: "1.5",
    minVersionCode: 0,
  });
});

describe("GET 历史包", () => {
  it("lists the uploaded packages newest first, with the R2 ETag as md5", async () => {
    const olderEtag = await put(`${PREFIX}older.apk`, "older-content");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newerEtag = await put(`${PREFIX}newer.apk`, "newer-content");
    // 同 bucket 里的其它对象必须**不**出现。
    await put("production/media/photo.png", "png");

    const response = await apksGet({
      locals: locals([READ]),
      request: request(),
    } as never);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      apks: Array<{key: string; md5: string; name: string; size: number; uploadedAt: string}>;
    };
    expect(body.apks.map((apk) => apk.name)).toEqual(["newer.apk", "older.apk"]);
    // 单段 PUT 的 ETag 就是内容 MD5 —— 列表不必把对象读回来重算。
    expect(body.apks[0]?.md5).toBe(newerEtag);
    expect(body.apks[1]?.md5).toBe(olderEtag);
    expect(body.apks[0]?.size).toBe("newer-content".length);
    expect(body.apks[0]?.key).toBe(`${PREFIX}newer.apk`);
  });

  it("returns an empty list when nothing was uploaded", async () => {
    expect(await listNames()).toEqual([]);
  });

  it("refuses a caller without system:app-version:read", async () => {
    const response = await apksGet({
      locals: locals([]),
      request: request(),
    } as never);
    expect(response.status).toBe(403);
  });
});

describe("DELETE 历史包", () => {
  it("deletes an uploaded package", async () => {
    await put(`${PREFIX}doomed.apk`, "x");
    const response = await apksDelete({
      locals: locals([MANAGE]),
      request: request("DELETE", {key: `${PREFIX}doomed.apk`}),
    } as never);
    expect(response.status).toBe(200);
    expect(await env.MEDIA_BUCKET.head(`${PREFIX}doomed.apk`)).toBeNull();
    expect(await listNames()).toEqual([]);
  });

  it("refuses a key outside the app prefix (not a general R2 delete)", async () => {
    await put("production/media/photo.png", "png");
    const response = await apksDelete({
      locals: locals([MANAGE]),
      request: request("DELETE", {key: "production/media/photo.png"}),
    } as never);
    expect(response.status).toBe(400);
    // 关键：对象还在。这个端点的权限码不该能删整站的图。
    expect(await env.MEDIA_BUCKET.head("production/media/photo.png")).not.toBeNull();
  });

  it("refuses a traversal key that merely starts with the prefix", async () => {
    await put("production/media/photo.png", "png");
    const response = await apksDelete({
      locals: locals([MANAGE]),
      // 以 `production/app/` 开头，但 `..` 会把目标指到前缀之外。
      request: request("DELETE", {key: `${PREFIX}../media/photo.png`}),
    } as never);
    expect(response.status).toBe(400);
    expect(await env.MEDIA_BUCKET.head("production/media/photo.png")).not.toBeNull();
  });

  it("refuses the package the download URL points at", async () => {
    await put(`${PREFIX}live.apk`, "live");
    await saveAppVersionConfig(env.FEED_DB, {
      downloadUrl: `https://feed.example.com/media/${PREFIX}live.apk`,
      latestVersionName: "1.5",
      minVersionCode: 0,
    });
    const response = await apksDelete({
      locals: locals([MANAGE]),
      request: request("DELETE", {key: `${PREFIX}live.apk`}),
    } as never);
    expect(response.status).toBe(409);
    expect(await env.MEDIA_BUCKET.head(`${PREFIX}live.apk`)).not.toBeNull();
  });

  it("still allows deleting once the URL points elsewhere", async () => {
    await put(`${PREFIX}live.apk`, "live");
    await saveAppVersionConfig(env.FEED_DB, {
      downloadUrl: `https://feed.example.com/media/${PREFIX}other.apk`,
      latestVersionName: "1.5",
      minVersionCode: 0,
    });
    const response = await apksDelete({
      locals: locals([MANAGE]),
      request: request("DELETE", {key: `${PREFIX}live.apk`}),
    } as never);
    expect(response.status).toBe(200);
  });

  it("requires system:app-version:manage", async () => {
    await put(`${PREFIX}kept.apk`, "x");
    const response = await apksDelete({
      locals: locals([READ]),
      request: request("DELETE", {key: `${PREFIX}kept.apk`}),
    } as never);
    expect(response.status).toBe(403);
    expect(await env.MEDIA_BUCKET.head(`${PREFIX}kept.apk`)).not.toBeNull();
  });

  it("rejects a body without a key", async () => {
    const response = await apksDelete({
      locals: locals([MANAGE]),
      request: request("DELETE", {}),
    } as never);
    expect(response.status).toBe(400);
  });
});
