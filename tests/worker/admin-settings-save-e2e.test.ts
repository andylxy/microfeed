import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {POST as feedPost} from "@/pages/[adminPath]/ajax/feed";
import FeedPublicJsonBuilder from "@/server/feed/FeedPublicJsonBuilder";
import {themeContext} from "@/shared/themes/ThemeRenderer";
import {SETTINGS_CATEGORIES} from "@/shared/Constants";

/**
 * Logged-in admin E2E for the settings save path.
 *
 * The site-title (and every settings category) is written through
 * `/admin/ajax/feed`, which is guarded by RBAC and persisted per-category into
 * the `settings` table. These tests drive the *real* endpoint with an
 * authenticated (or deliberately unauthenticated) `locals` object — the same
 * shape the middleware resolves a session cookie into — so the guard, the
 * persist, and the public render are all exercised together. This closes the
 * "no local logged-in verification" gap for the settings pages.
 */

const ORIGIN = "https://feed.example.com";
const CATEGORY = SETTINGS_CATEGORIES.WEB_GLOBAL_SETTINGS; // "webGlobalSettings"
const NEW_TITLE = "测试站点标题";
const THEME_META = {assetBaseUrl: "/a", packageId: "p", version: "1"};

/** An authenticated admin `locals`; defaults to a super admin (`*`). */
function adminLocals(permissions: string[] = ["*"]) {
  return {
    authUser: {id: "u_admin"},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

function feedRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/admin/ajax/feed/`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
}

/** Read the live `settings` row the endpoint is supposed to have written. */
async function savedSettingsData(): Promise<Record<string, unknown> | null> {
  const row = await env.FEED_DB.prepare(
    "SELECT data FROM settings WHERE category = ? LIMIT 1",
  ).bind(CATEGORY).first<{data: string}>();
  return row ? JSON.parse(row.data) as Record<string, unknown> : null;
}

beforeEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM settings WHERE category = ?").bind(CATEGORY),
  ]);
});

describe("admin settings save (logged-in E2E)", () => {
  it("persists a site title written by a super admin through the real endpoint", async () => {
    const response = await feedPost({
      locals: adminLocals(),
      request: feedRequest({settings: {[CATEGORY]: {siteTitle: NEW_TITLE}}}),
    } as never);

    expect(response.status).toBe(200);
    const saved = await savedSettingsData();
    expect(saved?.siteTitle).toBe(NEW_TITLE);
  });

  it("reflects the saved title in the public feed context built from D1", async () => {
    await feedPost({
      locals: adminLocals(),
      request: feedRequest({settings: {[CATEGORY]: {siteTitle: NEW_TITLE}}}),
    } as never);

    // The public site builds its context from the same FeedPublicJsonBuilder
    // the live worker uses, reading the just-persisted settings from D1.
    const saved = await savedSettingsData();
    expect(saved?.siteTitle).toBe(NEW_TITLE);

    const extra = new FeedPublicJsonBuilder(
      {
        channel: {categories: [], title: "频道名"},
        settings: {[CATEGORY]: saved ?? {}},
      },
      ORIGIN,
      {url: `${ORIGIN}/`, cf: null},
      false,
    )._buildPublicContentMicrofeedExtra({});
    expect((extra as Record<string, unknown>).siteTitle).toBe(NEW_TITLE);

    // And the public context exposes it as the header logo variable, which the
    // theme template renders as `fq-logo-text` (covered in theme-site-title).
    const context = themeContext(
      {title: "频道名", _microfeed: {siteTitle: NEW_TITLE}},
      THEME_META,
    );
    expect(context.site_title).toBe(NEW_TITLE);
  });

  it("refuses the save for an anonymous request with 401", async () => {
    const response = await feedPost({
      locals: {authUser: null, rbacPermissions: new Set<string>()},
      request: feedRequest({settings: {[CATEGORY]: {siteTitle: NEW_TITLE}}}),
    } as never);

    expect(response.status).toBe(401);
    expect(await savedSettingsData()).toBeNull();
  });

  it("refuses the save for a signed-in account missing the chapter-create grant with 403", async () => {
    // A settings-only save carries no item id, so the feed endpoint guards it
    // with CONTENT_CHAPTER_CREATE; an account without that grant is 403'd.
    const response = await feedPost({
      locals: adminLocals(["content:book:read"]),
      request: feedRequest({settings: {[CATEGORY]: {siteTitle: NEW_TITLE}}}),
    } as never);

    expect(response.status).toBe(403);
    expect(await savedSettingsData()).toBeNull();
  });
});
