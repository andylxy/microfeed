import {env} from "cloudflare:workers";
import type {APIContext} from "astro";
import {afterEach, describe, expect, it} from "vitest";

import {GET} from "@/pages/[adminPath]/ajax/tcm/fang-references";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";

const ORIGIN = "https://feed.example.com";

/**
 * The endpoint is permission-guarded (`content:chapter:read`); a wildcard grant
 * keeps the focus on the citation paths. The guard itself is covered by
 * rbac.test.ts / page-guards.
 */
const ADMIN_LOCALS = {
  authUser: {id: "u_admin_fang_refs", role: null},
  rbacBanned: false,
  rbacDeviceRevoked: false,
  rbacMustChangePassword: false,
  rbacPermissions: new Set(["*"]),
};

// Fixed ids; the worker D1 starts from migrations only, so nothing real can
// collide. afterEach removes everything this file created.
const BOOK = "frbook";
const OTHER_BOOK = "frbook2";
const CHAPTER = "frC1";
const BODY_SECTION = "frS1";
const FANGLIST_SECTION = "frS2";
const DRAFT_SECTION = "frS3";
const CROSS_BOOK_SECTION = "frS4";
const CREATED_ITEM_IDS = [CHAPTER, BODY_SECTION, FANGLIST_SECTION, DRAFT_SECTION, CROSS_BOOK_SECTION];

async function get(pathname: string): Promise<Response> {
  const request = new Request(`${ORIGIN}${pathname}`);
  const response = await GET({
    locals: ADMIN_LOCALS,
    params: {adminPath: "admin"},
    request,
    url: new URL(request.url),
  } as unknown as APIContext);
  if (!(response instanceof Response)) throw new Error("Expected a response.");
  return response;
}

interface ReferenceRow {
  id: string;
  status: number;
  title: string;
  chapterId: string;
  chapterTitle: string;
  bookId: string;
  bookTitle: string;
}

async function references(query: string): Promise<{items: ReferenceRow[]; total: number}> {
  const response = await get(`/admin/ajax/tcm/fang-references${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as {items: ReferenceRow[]; total: number};
}

function item(
  id: string,
  bookId: string | null,
  kind: string,
  status: number,
  data: Record<string, unknown>,
  parentId: string | null = null,
) {
  return env.FEED_DB.prepare(
    "INSERT INTO items (id, status, data, book_id, tcm_kind, tcm_parent_id) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, status, JSON.stringify(data), bookId, kind, parentId);
}

afterEach(async () => {
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM ext_marker_citations"),
    env.FEED_DB.prepare("DELETE FROM ext_marker_citation_state"),
    ...CREATED_ITEM_IDS.map((id) =>
      env.FEED_DB.prepare("DELETE FROM items WHERE id = ?").bind(id),
    ),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id IN (?, ?)").bind(BOOK, OTHER_BOOK),
  ]);
});

describe("fang references endpoint", () => {
  it("indexes both citation sources and merges drafts, ordered by receiptNo", async () => {
    await env.FEED_DB.batch([
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, status, data) VALUES (?, ?, ?)",
      ).bind(BOOK, STATUSES.PUBLISHED, JSON.stringify({title: "伤寒论"})),
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, status, data) VALUES (?, ?, ?)",
      ).bind(OTHER_BOOK, STATUSES.PUBLISHED, JSON.stringify({title: "金匮要略"})),
      item(CHAPTER, BOOK, "chapter", STATUSES.PUBLISHED, {
        title: "辨太阳病脉证并治（上）第五",
        description: "篇首无标记。",
      }),
      // 正文来源：$f{} 标记
      item(BODY_SECTION, BOOK, "section", STATUSES.PUBLISHED, {
        title: "第一条",
        description: "太阳病，$f{桂枝汤}主之。",
        _microfeed: {receiptNo: 1000000},
      }, CHAPTER),
      // 结构化来源：fangList（带空格，trim 后应命中）
      item(FANGLIST_SECTION, BOOK, "section", STATUSES.PUBLISHED, {
        title: "第二条",
        description: "无正文标记。",
        _microfeed: {receiptNo: 1001000, fangList: [" 桂枝汤 "]},
      }, CHAPTER),
      // 草稿：不在物化索引里（读者口径 status IN (1,4)），须由草稿分支补齐，
      // 且按 receiptNo 插回正确位置（1000500 位于两条已发布条文之间）
      item(DRAFT_SECTION, BOOK, "section", STATUSES.UNPUBLISHED, {
        title: "草稿条",
        description: "写了一半，$f{桂枝汤}主之。",
        _microfeed: {receiptNo: 1000500},
      }, CHAPTER),
      // 别书同名方：单书查询不应出现
      item(CROSS_BOOK_SECTION, OTHER_BOOK, "section", STATUSES.PUBLISHED, {
        title: "别书条",
        description: "$f{桂枝汤}。",
        _microfeed: {receiptNo: 9},
      }),
    ]);

    const {items, total} = await references("?name=" + encodeURIComponent("桂枝汤") + "&bookId=" + BOOK);
    expect(items.map((r) => r.id)).toEqual([BODY_SECTION, DRAFT_SECTION, FANGLIST_SECTION]);
    expect(total).toBe(3);
    expect(items.map((r) => r.status)).toEqual([
      STATUSES.PUBLISHED,
      STATUSES.UNPUBLISHED,
      STATUSES.PUBLISHED,
    ]);
    // 篇章/书标题回查照旧
    expect(items[0]!.chapterTitle).toBe("辨太阳病脉证并治（上）第五");
    expect(items[0]!.bookTitle).toBe("伤寒论");
    expect(items[0]!.title).toBe("第一条");
    // fangList 源的标题来自物化表的 section_title
    expect(items[2]!.title).toBe("第二条");
  });

  it("falls back to the cross-book scan when bookId is absent", async () => {
    await env.FEED_DB.batch([
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, status, data) VALUES (?, ?, ?)",
      ).bind(BOOK, STATUSES.PUBLISHED, JSON.stringify({title: "伤寒论"})),
      env.FEED_DB.prepare(
        "INSERT INTO channels (id, status, data) VALUES (?, ?, ?)",
      ).bind(OTHER_BOOK, STATUSES.PUBLISHED, JSON.stringify({title: "金匮要略"})),
      item(BODY_SECTION, BOOK, "section", STATUSES.PUBLISHED, {
        title: "第一条",
        description: "$f{桂枝汤}主之。",
        _microfeed: {receiptNo: 1000000},
      }),
      item(CROSS_BOOK_SECTION, OTHER_BOOK, "section", STATUSES.PUBLISHED, {
        title: "别书条",
        description: "$f{桂枝汤}。",
        _microfeed: {receiptNo: 9},
      }),
    ]);

    const {items, total} = await references("?name=" + encodeURIComponent("桂枝汤"));
    expect(items.map((r) => r.id)).toEqual([BODY_SECTION, CROSS_BOOK_SECTION]);
    expect(total).toBe(2);
    expect(items[1]!.bookTitle).toBe("金匮要略");
  });

  it("rejects a missing name and an unreadable caller", async () => {
    const missingName = await get("/admin/ajax/tcm/fang-references");
    expect(missingName.status).toBe(400);

    const forbidden = await GET({
      locals: {
        authUser: {id: "u_admin_fang_refs", role: null},
        rbacBanned: false,
        rbacDeviceRevoked: false,
        rbacMustChangePassword: false,
        rbacPermissions: new Set<string>(),
      },
      params: {adminPath: "admin"},
      request: new Request(`${ORIGIN}/admin/ajax/tcm/fang-references?name=x&bookId=${BOOK}`),
      url: new URL(`${ORIGIN}/admin/ajax/tcm/fang-references`),
    } as unknown as APIContext);
    expect(forbidden.status).toBeGreaterThanOrEqual(400);
    // 权限码登记在 rbac.test.ts；这里只断言「无权限拿不到数据」
    expect(PERMISSION_CODES.CONTENT_CHAPTER_READ).toBe("content:chapter:read");
  });
});
