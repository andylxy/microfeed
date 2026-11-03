import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {
  createBookInfoHandler,
  deleteBookInfoHandler,
  updateBookInfoHandler,
  purgeBookInfoHandler,
  listBookStatusesHandler,
  saveBookStatusesHandler,
} from "@/server/book-info/handlers";
import type {BookInfoDb} from "@/server/book-info/types";
import {ADMIN_PAGE_GUARDS} from "@/shared/AdminPageGuards";
import {PERMISSION_CODES} from "@/shared/Constants";

const db = env.FEED_DB as unknown as BookInfoDb;
const groupsDb = env.FEED_DB;

/**
 * 独立书本信息模块（ADR-0058）的真实 D1 往返。
 *
 * 迁移 0171/0173/0174 已由测试环境应用，因此 `book_info` 表（文本 book_no/case_tag、
 * NOT NULL hot_book）、权限树页面节点与 `settings.book_info_statuses` 默认三项都存在。
 * 不建账号：handler 直接收 `BookInfoDb` 端口，不走 `requireRbac`（守卫在
 * `tests/unit/admin-endpoint-guards.test.ts` 静态校验）。用例自清理（软删+物删），
 * 不留行。
 */
describe("book_info over the real D1", () => {
  it("creates, updates, soft-deletes and purges one row", async () => {
    const created = await createBookInfoHandler(db, groupsDb, {
      bookName: "D1 往返书名",
      author: "测试",
      bookNo: "4242",
      caseDivision: "测试划分",
      hotBook: 0,
      isEnable: true,
    });
    expect(created.id).toHaveLength(11);
    expect(created.bookName).toBe("D1 往返书名");
    expect(created.bookNo).toBe("4242");
    expect(created.isDeleted).toBe(false);

    const updated = await updateBookInfoHandler(db, groupsDb, created.id, {
      bookName: "D1 改名",
      isEnable: false,
    });
    expect(updated.bookName).toBe("D1 改名");
    expect(updated.isEnable).toBe(false);

    await deleteBookInfoHandler(db, created.id);
    await expect(purgeBookInfoHandler(db, created.id)).resolves.toEqual({
      purged: true,
    });
  });

  it("update handler refuses a parent pointing at itself", async () => {
    const created = await createBookInfoHandler(db, groupsDb, {
      bookName: "自引用书名",
      bookNo: "4243",
      caseDivision: "划分",
      hotBook: 0,
    });
    await expect(
      updateBookInfoHandler(db, groupsDb, created.id, {parentId: created.id}),
    ).rejects.toMatchObject({status: 400});
    await deleteBookInfoHandler(db, created.id);
    await purgeBookInfoHandler(db, created.id);
  });

  it("rejects a hot_book value outside the seeded status list", async () => {
    await expect(
      createBookInfoHandler(db, groupsDb, {
        bookName: "越界状态书名",
        bookNo: "4244",
        caseDivision: "划分",
        hotBook: 99999,
      }),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.invalidStatus"});
  });
});

describe("book_info statuses over the real D1 (migration 0174 seed)", () => {
  it("lists the three seeded statuses 公开/隐藏/会员", async () => {
    const statuses = await listBookStatusesHandler(groupsDb);
    expect(statuses.map((status) => status.value)).toEqual([0, 1, 2]);
    expect(statuses.map((status) => status.label)).toEqual(["公开", "隐藏", "会员"]);
  });

  it("refuses an empty status list with the lastStatus 400", async () => {
    await expect(
      saveBookStatusesHandler(groupsDb, {statuses: []}),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.lastStatus"});
  });

  it("refuses a duplicate status value with a 400", async () => {
    await expect(
      saveBookStatusesHandler(groupsDb, {
        statuses: [
          {value: 0, label: "公开", sort: 0},
          {value: 0, label: "重复值", sort: 1},
        ],
      }),
    ).rejects.toMatchObject({status: 400});
  });

  it("round-trips a saved status list through the write handler", async () => {
    const result = await saveBookStatusesHandler(groupsDb, {
      statuses: [
        {value: 0, label: "公开", sort: 0},
        {value: 1, label: "隐藏", sort: 1},
        {value: 2, label: "会员", sort: 2},
      ],
    });
    expect(result.statuses).toHaveLength(3);
    expect((await listBookStatusesHandler(groupsDb)).map((status) => status.value))
      .toEqual([0, 1, 2]);
  });
});

describe("book-info page guard catalog", () => {
  it("registers the page with the reused content:book:read code", () => {
    expect(ADMIN_PAGE_GUARDS["book-info"]).toBe(
      PERMISSION_CODES.CONTENT_BOOK_READ,
    );
  });
});
