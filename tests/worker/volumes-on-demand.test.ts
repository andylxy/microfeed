/**
 * 卷看板端点层：`GET ajax/volumes/?bookId=` 只返回这本书的**卷**与每卷条数。
 *
 * 这条端点是「点书只见卷」的落点，也是最容易静默回退成「点书读整本」的地方——
 * 整本书的条目行一旦回到这份载荷里，一次页面打开就要步进几千行（《素问》实测
 * 8,812），远程 D1 的 5M 日额度当天就会被审目录的动作吃光。所以这里锁四件：
 * - 缺 `content:volume:read` 必须 403（读路径与写路径同码分权）；
 * - 载荷里有卷行与条数，**没有任何条目行**（条文的 id 一个都不出现）；
 * - 卷键由后端给出：TCM 典籍是那行篇章的 id，未归类桶是 `UNFILED_VOLUME_KEY`；
 * - 逐卷条数来自那条覆盖索引分组扫描，口径与展开该卷时读到的条目数一致。
 *
 * 迁移在这里被真的应用到 Miniflare D1，所以 0116 重建后的 `items_book_kind`
 * 就是这条查询实际走的索引。
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as volumesIndex} from "@/pages/[adminPath]/ajax/volumes/index";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";
import {UNFILED_VOLUME_KEY, type VolumeList} from "@/shared/ExtVolume";

const BOARD_URL = "https://feed.example.com/admin/ajax/volumes/";
const BOOK = "VolBook1";
const OTHER_BOOK = "VolBook2";
const CHAPTER_A = "VolChapA001";
const CHAPTER_B = "VolChapB001";
const CHAPTER_EMPTY = "VolChapC001";
const CHAPTER_DELETED = "VolChapD001";
const SECTION_A1 = "VolSecA00001";
const SECTION_A2 = "VolSecA00002";
const SECTION_B1 = "VolSecB00001";
const SECTION_ORPHAN = "VolSecX00001";
const SECTION_NO_PARENT = "VolSecY00001";
const SECTION_UNDER_DELETED = "VolSecZ00001";
const FANG_ROW = "VolFang00001";

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-vol"},
    rbacPermissions: new Set<string>(codes),
  };
}

function readLocals() {
  return locals(PERMISSION_CODES.CONTENT_VOLUME_READ);
}

async function callBook(bookId: string, who = readLocals()) {
  return volumesIndex({
    locals: who,
    request: new Request(`${BOARD_URL}?bookId=${bookId}`),
  } as never);
}

async function insertChannel(id: string, title: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, JSON.stringify({_microfeed: {}, title}), Date.now(), STATUSES.PUBLISHED, "").run();
}

interface ItemSeed {
  bookId: string;
  data: Record<string, unknown>;
  id: string;
  parentId?: string;
  pubDate?: string;
  status?: number;
  tcmKind?: string;
  title: string;
}

async function insertItem(seed: ItemSeed): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    seed.id,
    seed.status ?? STATUSES.PUBLISHED,
    JSON.stringify({_microfeed: {bookId: seed.bookId, ...seed.data}, title: seed.title}),
    seed.pubDate ?? "2026-01-01T00:00:00.000Z",
    seed.bookId,
    seed.tcmKind ?? null,
    seed.parentId ?? "",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ).run();
}

async function seedTcmBook(): Promise<void> {
  const ids = [
    BOOK,
    OTHER_BOOK,
    CHAPTER_A,
    CHAPTER_B,
    CHAPTER_EMPTY,
    CHAPTER_DELETED,
    SECTION_A1,
    SECTION_A2,
    SECTION_B1,
    SECTION_ORPHAN,
    SECTION_NO_PARENT,
    SECTION_UNDER_DELETED,
    FANG_ROW,
  ];
  await env.FEED_DB.batch(ids.map((id) => env.FEED_DB.prepare(
    "DELETE FROM items WHERE id = ?",
  ).bind(id)));
  await env.FEED_DB.batch([BOOK, OTHER_BOOK].map((id) => env.FEED_DB.prepare(
    "DELETE FROM channels WHERE id = ?",
  ).bind(id)));

  await insertChannel(BOOK, "测试典籍");
  await insertChannel(OTHER_BOOK, "别家典籍");

  // 篇章 = 卷；条文的 `_microfeed.section` 决定卷序（此处 A=2、B=1，所以 B 在前）。
  await insertItem({
    bookId: BOOK,
    data: {section: 2},
    id: CHAPTER_A,
    title: "卷甲",
    tcmKind: "chapter",
  });
  await insertItem({
    bookId: BOOK,
    data: {section: 1},
    id: CHAPTER_B,
    title: "卷乙",
    tcmKind: "chapter",
  });
  await insertItem({
    bookId: BOOK,
    data: {section: 3},
    id: CHAPTER_EMPTY,
    title: "卷丙（空）",
    tcmKind: "chapter",
  });
  await insertItem({
    bookId: BOOK,
    data: {section: 4},
    id: CHAPTER_DELETED,
    status: STATUSES.DELETED,
    title: "已删篇章",
    tcmKind: "chapter",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 201},
    id: SECTION_A1,
    parentId: CHAPTER_A,
    title: "甲一",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 202},
    id: SECTION_A2,
    parentId: CHAPTER_A,
    title: "甲二",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 101},
    id: SECTION_B1,
    parentId: CHAPTER_B,
    title: "乙一",
    tcmKind: "section",
  });
  // 分组键指向别的书的一行篇章：属于「本书之内、树之外」，落进未归类桶。
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 901},
    id: SECTION_ORPHAN,
    parentId: OTHER_BOOK,
    title: "孤条文",
    tcmKind: "section",
  });
  // `tcm_parent_id` 为空：同样算未归类。
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 902},
    id: SECTION_NO_PARENT,
    title: "无父条文",
    tcmKind: "section",
  });
  // 挂在被软删篇章下的条文不算未归类（既有看板口径）。
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 401},
    id: SECTION_UNDER_DELETED,
    parentId: CHAPTER_DELETED,
    title: "删章下的条文",
    tcmKind: "section",
  });
  // 方剂带着本书的 book_id、没有父项，它不属于卷/章树，不得凭空造出未归类条数。
  await insertItem({
    bookId: BOOK,
    data: {no: 1, sourceBookId: BOOK},
    id: FANG_ROW,
    title: "测试方剂",
    tcmKind: "fang",
  });
}

async function readVolumes(response: Response): Promise<VolumeList | null> {
  const body = await response.json() as {volumes: VolumeList | null};
  return body.volumes;
}

describe("admin volume board: book click returns volumes only", () => {
  beforeEach(seedTcmBook);

  it("requires the volume read code", async () => {
    const denied = await callBook(BOOK, locals());
    expect(denied.status).toBe(403);
  });

  it("lists the book's volumes with entry counts, in chapter order", async () => {
    const response = await callBook(BOOK);
    expect(response.status).toBe(200);
    const volumes = await readVolumes(response);
    expect(volumes?.book).toEqual({id: BOOK, title: "测试典籍"});
    expect(volumes?.tcm).toBe(true);
    expect(volumes?.volumes.map((volume) => [volume.key, volume.name, volume.chapterCount])).toEqual([
      [CHAPTER_B, "卷乙", 1],
      [CHAPTER_A, "卷甲", 2],
      [CHAPTER_EMPTY, "卷丙（空）", 0],
      [UNFILED_VOLUME_KEY, "", 2],
    ]);
  });

  it("never carries an entry row in the book-click payload", async () => {
    const response = await callBook(BOOK);
    const text = JSON.stringify(await response.json());
    for (const sectionId of [
      SECTION_A1,
      SECTION_A2,
      SECTION_B1,
      SECTION_ORPHAN,
      SECTION_NO_PARENT,
      SECTION_UNDER_DELETED,
    ]) {
      expect(text).not.toContain(sectionId);
    }
  });

  it("keeps the deleted chapter out of the volume list and its section out of the unfiled bucket", async () => {
    const volumes = await readVolumes(await callBook(BOOK));
    expect(volumes?.volumes.map((volume) => volume.key)).not.toContain(CHAPTER_DELETED);
    // 未归类只数孤条文与无父条文两条；删章下的那条与方剂都不计入。
    expect(volumes?.volumes.at(-1)?.chapterCount).toBe(2);
  });

  it("reads a private, non-stable payload", async () => {
    const response = await callBook(BOOK);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns no volumes for a book that does not exist", async () => {
    const volumes = await readVolumes(await callBook("VolNoSuchBook"));
    expect(volumes?.book).toBeNull();
    expect(volumes?.volumes).toEqual([]);
  });
});
