import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {STATUSES} from "@/shared/Constants";
import FeedDb from "@/server/feed/FeedDb";
import {
  latestAdminItems,
  searchAdminItems,
} from "@/server/admin/item-search";
import {getAdminItemSearch} from "@/pages/[adminPath]/ajax/search/index";

const ORIGIN = "https://feed.example.com";
const ALL_STATUSES = ["published", "unlisted", "unpublished"] as const;
const PUBLISHED_AT = "2026-08-01T10:00:00.000Z";

async function database(): Promise<FeedDb> {
  const request = new Request(`${ORIGIN}/admin/ajax/search/`);
  const result = new FeedDb(env, request);
  await result.getContent();
  return result;
}

async function save(
  db: FeedDb,
  id: string,
  title: string,
  status = STATUSES.PUBLISHED,
  publishedAt = PUBLISHED_AT,
): Promise<void> {
  await db.putContent({
    item: {
      description: "Body text",
      id,
      pubDateMs: Date.parse(publishedAt),
      status,
      title,
    },
  });
}

beforeEach(async () => {
  await env.FEED_DB.prepare("DELETE FROM items WHERE id LIKE 'search-%'").run();
});

describe("admin item search (direct items query)", () => {
  it("matches a title substring case-insensitively", async () => {
    await save(await database(), "search-alpha", "Alpha season finale");
    await save(await database(), "search-beta", "Beta season preview");

    const lower = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "alpha",
      statuses: [...ALL_STATUSES],
    });
    expect(lower.map(({id}) => id)).toEqual(["search-alpha"]);

    const upper = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "ALPHA",
      statuses: [...ALL_STATUSES],
    });
    expect(upper.map(({id}) => id)).toEqual(["search-alpha"]);
  });

  it("requires every query term to be present", async () => {
    await save(await database(), "search-alpha", "Alpha season finale");
    await save(await database(), "search-beta", "Beta season preview");

    const both = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "season finale",
      statuses: [...ALL_STATUSES],
    });
    expect(both.map(({id}) => id)).toEqual(["search-alpha"]);

    const quoted = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: '"season finale"',
      statuses: [...ALL_STATUSES],
    });
    expect(quoted.map(({id}) => id)).toEqual(["search-alpha"]);

    const absent = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "season gamma",
      statuses: [...ALL_STATUSES],
    });
    expect(absent).toEqual([]);
  });

  it("honours the limit and returns an empty list when nothing matches", async () => {
    const db = await database();
    for (let index = 0; index < 8; index += 1) {
      await save(db, `search-set-${index}`, `Shared title ${index}`);
    }
    const limited = await searchAdminItems(env.FEED_DB, {
      limit: 3,
      query: "Shared title",
      statuses: [...ALL_STATUSES],
    });
    expect(limited.length).toBe(3);

    const none = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "nothing-matches-this",
      statuses: [...ALL_STATUSES],
    });
    expect(none).toEqual([]);
  });

  it("leaves deleted items out and keeps the other statuses", async () => {
    const db = await database();
    await save(db, "search-pub", "Status target item");
    await save(db, "search-hidden", "Status target item", STATUSES.UNLISTED);
    await save(db, "search-gone", "Status target item", STATUSES.DELETED);

    const found = await searchAdminItems(env.FEED_DB, {
      limit: 10,
      query: "Status target",
      statuses: [...ALL_STATUSES],
    });
    expect(found.map(({id}) => id).sort()).toEqual([
      "search-hidden",
      "search-pub",
    ]);
    expect(found.map(({status}) => status).sort()).toEqual([
      "published",
      "unlisted",
    ]);
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    await save(await database(), "search-percent", "Discount 100% off");
    await save(await database(), "search-plain", "Discount 100 off");
    await save(await database(), "search-underscore", "Code a_b here");
    await save(await database(), "search-other", "Code axb here");

    const percent = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "100%",
      statuses: [...ALL_STATUSES],
    });
    expect(percent.map(({id}) => id)).toEqual(["search-percent"]);

    const underscore = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "a_b",
      statuses: [...ALL_STATUSES],
    });
    expect(underscore.map(({id}) => id)).toEqual(["search-underscore"]);
  });

  it("marks the matched span for highlighting", async () => {
    await save(await database(), "search-mark", "Highlight 黄芪 target");
    const [found] = await searchAdminItems(env.FEED_DB, {
      limit: 5,
      query: "黄芪",
      statuses: [...ALL_STATUSES],
    });
    expect(found?.highlights.title).toEqual([
      {matched: false, text: "Highlight "},
      {matched: true, text: "黄芪"},
      {matched: false, text: " target"},
    ]);
  });

  it("reports dates and recently updated rows without a query", async () => {
    await save(await database(), "search-recent", "Recent dashboard item");
    const [latest] = await latestAdminItems(
      env.FEED_DB,
      [...ALL_STATUSES],
      5,
    );
    expect(latest?.id).toBe("search-recent");
    expect(latest?.date_published).toBe(PUBLISHED_AT);
    expect(latest?.date_modified).toEqual(expect.any(String));
    expect(latest?.highlights.title).toEqual([
      {matched: false, text: "Recent dashboard item"},
    ]);
  });
});

describe("admin item search transport", () => {
  it("serves recent rows for an empty query and typed rows for a keyword", async () => {
    await save(await database(), "search-admin", "Dashboard searchable");

    const recent = await getAdminItemSearch(
      new Request(`${ORIGIN}/admin/ajax/search/`),
      env,
      "admin",
    );
    expect(recent.status).toBe(200);
    const recentData = await recent.json() as {items: unknown[]};
    expect(recentData.items.length).toBeGreaterThan(0);
    expect(recentData.items.length).toBeLessThanOrEqual(5);
    expect(recentData.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date_published: PUBLISHED_AT,
        id: "search-admin",
      }),
    ]));

    const typed = await getAdminItemSearch(
      new Request(`${ORIGIN}/admin/ajax/search/?q=searchable`),
      env,
      "admin",
    );
    expect(await typed.json()).toMatchObject({
      items: [expect.objectContaining({
        edit_url: "/admin/items/search-admin/",
        id: "search-admin",
        match_type: "exact",
      })],
    });
  });

  it("returns an empty list for a one-character query", async () => {
    await save(await database(), "search-short", "Short query guard");
    const oneCharacter = await getAdminItemSearch(
      new Request(`${ORIGIN}/admin/ajax/search/?q=s`),
      env,
      "admin",
    );
    expect(await oneCharacter.json()).toEqual({items: []});
  });
});
