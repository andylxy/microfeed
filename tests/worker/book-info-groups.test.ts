import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {
  listBookGroupsHandler,
  reassignBookGroupHandler,
  saveBookGroupsHandler,
} from "@/server/book-info/handlers";
import {
  createBookInfo,
  deleteBookInfo,
  getBookInfo,
  purgeBookInfo,
} from "@/server/book-info/store";
import type {BookInfoDb} from "@/server/book-info/types";
import type {BookInfoGroup} from "@/shared/BookInfo";

const db = env.FEED_DB as unknown as BookInfoDb;
// 分组走 settings 通道，吃 `D1Database`（`groups.ts` 不经 `BookInfoDb` 端口）。
const groupsDb = env.FEED_DB;

/**
 * 「书本信息」分组（ADR-0059）的真实 D1 往返。
 *
 * 迁移 0172 已由测试环境应用：`settings.book_groups` 有一行三组快照
 * （shanghan/neijing/bencao），`book_info.case_division` 有索引。分组走 settings
 * 通道（`D1Database`）、书走 `book_info` 端口（`BookInfoDb`），两侧是同一个
 * `env.FEED_DB`（ADR-0059 决策 5）。用例自清理：改派后把书物删、把 settings
 * 写回快照，不留脏行。
 */

/** 迁移 0172 的种子快照，测试结束写回，避免污染其他用例。 */
const SEED_GROUPS: BookInfoGroup[] = [
  {key: "shanghan", label: "伤寒金匮", sort: 0},
  {key: "neijing", label: "内经", sort: 1},
  {key: "bencao", label: "本草", sort: 2},
];

/** 建一本 11 位固定 id 的测试书（自管 id 便于收尾物删）。 */
async function seedBook(caseDivision: string, suffix: string): Promise<string> {
  const id = `grptest${suffix}`.slice(0, 11);
  await createBookInfo(db, id, {
    bookName: "分组测试书",
    bookNo: String(9000 + Number(suffix)),
    caseDivision,
    hotBook: 0,
  });
  return id;
}

/** 先软删再物删，彻底清掉一本测试书。 */
async function purgeBook(id: string): Promise<void> {
  await deleteBookInfo(db, id);
  await purgeBookInfo(db, id);
}

describe("book groups over the real D1", () => {
  it("reads the 0172 seed snapshot of three groups", async () => {
    const groups = await listBookGroupsHandler(groupsDb);
    expect(groups.map((group) => group.key)).toEqual(["shanghan", "neijing", "bencao"]);
  });

  it("round-trips a save then list (whole-list overwrite)", async () => {
    const next: BookInfoGroup[] = [
      {key: "shanghan", label: "伤寒金匮", sort: 0},
      {key: "wuxing", label: "五行", sort: 1},
    ];
    const saved = await saveBookGroupsHandler(groupsDb, {groups: next});
    expect(saved.groups.map((group) => group.key)).toEqual(["shanghan", "wuxing"]);

    const listed = await listBookGroupsHandler(groupsDb);
    expect(listed.map((group) => group.key)).toEqual(["shanghan", "wuxing"]);

    // 还原种子，避免污染其他用例。
    await saveBookGroupsHandler(groupsDb, {groups: SEED_GROUPS});
  });

  it("refuses an empty group list with the lastGroup 400", async () => {
    await expect(
      saveBookGroupsHandler(groupsDb, {groups: []}),
    ).rejects.toMatchObject({status: 400, i18nKey: "errors.bookInfo.lastGroup"});
  });

  it("reassigns every book of a group to the target group", async () => {
    const id = await seedBook("shanghan", "001");
    try {
      await reassignBookGroupHandler(db, {from: "shanghan", to: "bencao"});
      const moved = await getBookInfo(db, id);
      expect(moved?.caseDivision).toBe("bencao");
    } finally {
      await purgeBook(id);
    }
  });

  it("reassign handler rejects from === to", async () => {
    await expect(
      reassignBookGroupHandler(db, {from: "shanghan", to: "shanghan"}),
    ).rejects.toMatchObject({status: 400});
  });
});
