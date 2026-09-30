import {env} from "cloudflare:workers";
import {afterEach, describe, expect, it} from "vitest";

import {listAdminItems} from "@/server/items/admin-list";
import {STATUSES} from "@/shared/Constants";

const CHAPTER_ID = "kindchapter1";
const SECTION_ID = "kindsection1";
const FANG_ID = "kindfang001";
const NOVEL_ID = "kindnovel01";

const ITEM_IDS = [CHAPTER_ID, SECTION_ID, FANG_ID, NOVEL_ID];

async function seed() {
  await env.FEED_DB.prepare(
    "DELETE FROM items WHERE id IN ('kindchapter1', 'kindsection1', 'kindfang001', 'kindnovel01')",
  ).run();
  await env.FEED_DB.batch([
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at, book_id, tcm_kind, tcm_parent_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).bind(
      CHAPTER_ID,
      STATUSES.PUBLISHED,
      JSON.stringify({_microfeed: {section: 1}, title: "辨太阳病脉证并治"}),
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:00:00.000Z",
      "2026-08-04T10:00:00.000Z",
      "apptcmtbook",
      "chapter",
    ),
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at, tcm_kind, tcm_parent_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      SECTION_ID,
      // 条文按拍板导入为 unlisted：不进公开 feed，但后台列表可见可管。
      STATUSES.UNLISTED,
      JSON.stringify({
        _microfeed: {receiptNo: 1, chapterId: CHAPTER_ID},
        title: "太阳之为病，脉浮。",
      }),
      "2026-08-04T10:01:00.000Z",
      "2026-08-04T10:01:00.000Z",
      "2026-08-04T10:01:00.000Z",
      "section",
      CHAPTER_ID,
    ),
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at, tcm_kind, tcm_parent_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    ).bind(
      FANG_ID,
      STATUSES.PUBLISHED,
      JSON.stringify({
        _microfeed: {fangYaoList: [{yaoId: "yao1", amount: "三两"}]},
        title: "桂枝汤",
      }),
      "2026-08-04T10:02:00.000Z",
      "2026-08-04T10:02:00.000Z",
      "2026-08-04T10:02:00.000Z",
      "fang",
    ),
    // 普通小说条目：tcm_kind 为 NULL，只出现在「全部」视图。
    env.FEED_DB.prepare(
      "INSERT INTO items (id, status, data, pub_date, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      NOVEL_ID,
      STATUSES.PUBLISHED,
      JSON.stringify({title: "Novel chapter"}),
      "2026-08-04T10:03:00.000Z",
      "2026-08-04T10:03:00.000Z",
      "2026-08-04T10:03:00.000Z",
    ),
  ]);
}

afterEach(async () => {
  await env.FEED_DB.prepare(
    "DELETE FROM items WHERE id IN ('kindchapter1', 'kindsection1', 'kindfang001', 'kindnovel01')",
  ).run();
});

function adminList(searchParams: Record<string, string> = {}) {
  const request = new Request(
    `https://feed.example.com/admin/ajax/items/?${new URLSearchParams(searchParams)}`,
  );
  return listAdminItems(env.FEED_DB, request, {limit: 20});
}

describe("admin item list TCM kind filtering", () => {
  it("shows every kind under the default view and reports tcm presence", async () => {
    await seed();
    const all = await adminList();
    expect(all.items.map((item) => item.id).sort()).toEqual([...ITEM_IDS].sort());
    expect(all.hasTcmItems).toBe(true);
  });

  it("narrows to one kind and echoes the applied filter", async () => {
    await seed();
    const sections = await adminList({tcmKind: "section"});
    expect(sections.items.map((item) => item.id)).toEqual([SECTION_ID]);
    expect(sections.tcmKindFilter).toBe("section");

    const fangs = await adminList({tcmKind: "fang"});
    expect(fangs.items.map((item) => item.id)).toEqual([FANG_ID]);

    const chapters = await adminList({tcmKind: "chapter"});
    expect(chapters.items.map((item) => item.id)).toEqual([CHAPTER_ID]);
  });

  it("combines the kind filter with the status filter", async () => {
    await seed();
    // 条文是 unlisted；默认视图（status != deleted）能看到它，
    // 但 status=published + kind=section 就一条也不剩。
    const publishedSections = await adminList({
      status: "published",
      tcmKind: "section",
    });
    expect(publishedSections.items).toEqual([]);

    const unlistedSections = await adminList({
      status: "unlisted",
      tcmKind: "section",
    });
    expect(unlistedSections.items.map((item) => item.id)).toEqual([SECTION_ID]);
  });

  it("keeps novel rows (NULL kind) out of kind views but in the default one", async () => {
    await seed();
    const kinds = await adminList({tcmKind: "yao"});
    expect(kinds.items).toEqual([]);

    const all = await adminList();
    expect(all.items.some((item) => item.id === NOVEL_ID)).toBe(true);
    expect(all.tcmKindFilter).toBeUndefined();
  });

  it("falls back to the default view for an unknown kind value", async () => {
    await seed();
    const listing = await adminList({tcmKind: "not-a-kind"});
    expect(listing.items.length).toBe(ITEM_IDS.length);
    expect(listing.tcmKindFilter).toBeUndefined();
  });
});
