import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import ThemeStore from "@/server/themes/ThemeStore";
import {POST as themesPost} from "@/pages/[adminPath]/ajax/themes";
import {POST as purgeTheme} from "@/pages/[adminPath]/ajax/themes/[themeId]/purge";
import {PERMISSION_CODES} from "@/shared/Constants";
import type {
  ThemeBundleV1,
  ThemeManifestV1,
} from "@/shared/themes/ThemeContract";

/**
 * 主题物理删除（purge）的端点层。
 *
 * 锁三件事：
 * - 权限门：`CONTENT_SETTINGS_MANAGE` 之外的调用必须 403（purge 不可恢复，
 *   UI 藏起按钮不能是唯一防线）。
 * -  purge 真的物理删除（行没了），且不碰软删除的 DELETE 动词。
 * - 未知 id 与激活行拒绝时，行必须还在（purge 失败不留半成品）。
 */

function packageData(packageId: string, version = "1.0.0"):
  {bundle: ThemeBundleV1; manifest: ThemeManifestV1} {
  return {
    bundle: {
      assets: [],
      rssStylesheet: "<xsl:stylesheet xmlns:xsl=\"http://www.w3.org/1999/XSL/Transform\" version=\"1.0\"></xsl:stylesheet>",
      webBodyEnd: "",
      webBodyStart: "",
      webFeed: "<main>{{title}}</main>",
      webHeader: "",
      webItem: "<main>{{items.0.title}}</main>",
    },
    manifest: {
      assets: [],
      author: "Tests",
      files: {
        rssStylesheet: "rss.xsl",
        webBodyEnd: "body-end.mustache",
        webBodyStart: "body-start.mustache",
        webFeed: "feed.mustache",
        webHeader: "header.mustache",
        webItem: "item.mustache",
      },
      formatVersion: 1,
      license: "MIT",
      microfeed: "*",
      name: packageId,
      packageId,
      version,
    },
  };
}

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-theme"},
    rbacPermissions: new Set<string>(codes),
  };
}

function callCleanup(
  body: Record<string, unknown>,
  who = locals(PERMISSION_CODES.CONTENT_SETTINGS_MANAGE),
) {
  return themesPost({
    locals: who,
    request: new Request("https://feed.example.com/admin/ajax/themes/", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({action: "purgeOldVersions", ...body}),
    }),
  } as never);
}

function callPurge(themeId: string, who = locals(PERMISSION_CODES.CONTENT_SETTINGS_MANAGE)) {
  return purgeTheme({
    locals: who,
    params: {themeId},
    request: new Request(`https://feed.example.com/admin/ajax/themes/${themeId}/purge/`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: "{}",
    }),
  } as never);
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM themes"),
    env.FEED_DB.prepare(
      `UPDATE theme_state SET active_theme_id = NULL,
       previous_theme_id = NULL WHERE id = 'current'`,
    ),
  ]);
});

describe("admin theme purge endpoint", () => {
  it("requires the manage permission code", async () => {
    const denied = await callPurge("anything", locals());
    expect(denied.status).toBe(403);
  });

  it("purges a custom version physically", async () => {
    const store = new ThemeStore(env.FEED_DB);
    const version = await store.installVersion({
      ...packageData(`local.purge-ep.${crypto.randomUUID()}`),
      source: {kind: "local-directory"},
    });

    const response = await callPurge(version.id);

    expect(response.status).toBe(200);
    expect(await store.getVersion(version.id, true)).toBeNull();
  });

  it("cleans up old versions in dry-run mode without deleting", async () => {
    const store = new ThemeStore(env.FEED_DB);
    const packageId = `local.cleanup-ep.${crypto.randomUUID()}`;
    const active = await store.installVersion({
      ...packageData(packageId, "1.0.0"),
      source: {kind: "local-directory"},
    });
    const stale = await store.installVersion({
      ...packageData(packageId, "2.0.0"),
      source: {kind: "local-directory"},
    });
    await store.activate(active.id);

    const denied = await callCleanup({dryRun: true}, locals());
    expect(denied.status).toBe(403);

    const preview = await callCleanup({dryRun: true});
    expect(preview.status).toBe(200);
    const body = await preview.json() as {
      purged: {id: string; packageId: string; tombstone: boolean; version: string}[];
    };
    expect(body.purged.map((row) => row.id)).toEqual([stale.id]);
    expect(body.purged[0]).toEqual({
      id: stale.id,
      packageId,
      tombstone: false,
      version: "2.0.0",
    });
    expect(await store.getVersion(stale.id, true)).not.toBeNull();
  });

  it("purges old versions and keeps the active and previous rows", async () => {
    const store = new ThemeStore(env.FEED_DB);
    const packageId = `local.cleanup-ep-run.${crypto.randomUUID()}`;
    const previous = await store.installVersion({
      ...packageData(packageId, "1.0.0"),
      source: {kind: "local-directory"},
    });
    const active = await store.installVersion({
      ...packageData(packageId, "2.0.0"),
      source: {kind: "local-directory"},
    });
    await store.activate(previous.id);
    await store.activate(active.id);

    const response = await callCleanup({});

    expect(response.status).toBe(200);
    expect(await store.getVersion(previous.id, true)).not.toBeNull();
    expect(await store.getVersion(active.id, true)).not.toBeNull();
  });

  it("keeps the row when the id is unknown or the version is active", async () => {
    const store = new ThemeStore(env.FEED_DB);
    const unknown = await callPurge("no-such-theme");
    expect(unknown.status).toBe(400);

    const active = await store.installVersion({
      ...packageData(`local.purge-ep-active.${crypto.randomUUID()}`),
      source: {kind: "local-directory"},
    });
    await store.activate(active.id);

    const denied = await callPurge(active.id);

    expect(denied.status).toBe(400);
    expect(await store.getVersion(active.id, true)).not.toBeNull();
  });
});
