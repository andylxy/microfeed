/**
 * 卷看板端点层：`GET ajax/volumes/entries?bookId=&volume=` 只返回**这一卷**的条目。
 *
 * 这条端点是「点卷只见该卷」的落点。它容易被写坏的方向有两个方向都锁：
 * - 读多了：为了列出某卷而把整本书读回来（《素问》8,812 行），或者把别的卷、
 *   别的书的条目混进载荷；
 * - 读错了：客户端手填或过期的卷键指向别的书的那一行篇章时，服务端仍然照着它读，
 *   等于用一个只读端点跨书取内容。
 * 所以这里锁：卷键必须先以主键点查确认是本书的篇章，否则空列表、零条目读；
 * 卷内序来自 `items_section_order`（receiptNo → no → id），与书页目录同源；
 * 方剂不属于卷/章树，出现在任何卷的载荷里都算回归；缺读权限 403。
 *
 * 迁移在这里被真的应用到 Miniflare D1，种子与 `volumes-on-demand.test.ts` 同一套形状。
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as volumeEntries} from "@/pages/[adminPath]/ajax/volumes/entries";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";
import {UNFILED_VOLUME_KEY, type VolumeEntryList} from "@/shared/ExtVolume";

const ENTRIES_URL = "https://feed.example.com/admin/ajax/volumes/entries";
const BOOK = "ExpBook1";
const OTHER_BOOK = "ExpBook2";
const CHAPTER_A = "ExpChapA0001";
const CHAPTER_B = "ExpChapB0001";
const CHAPTER_OTHER = "ExpChapO0001";
const CHAPTER_DELETED = "ExpChapD0001";
const SECTION_B2 = "ExpSecB00002";
const SECTION_B1 = "ExpSecB00001";
const SECTION_A2 = "ExpSecA00002";
const SECTION_A1 = "ExpSecA00001";
const SECTION_ORPHAN = "ExpSecX00001";
const SECTION_NO_PARENT = "ExpSecY00001";
const FANG_ROW = "ExpFang00001";

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-exp"},
    rbacPermissions: new Set<string>(codes),
  };
}

async function call(
  bookId: string,
  volume: string,
  who = locals(PERMISSION_CODES.CONTENT_VOLUME_READ),
) {
  const params = new URLSearchParams({bookId, volume});
  return volumeEntries({
    locals: who,
    request: new Request(`${ENTRIES_URL}?${params.toString()}`),
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
    "2026-01-01T00:00:00.000Z",
    seed.bookId,
    seed.tcmKind ?? null,
    seed.parentId ?? "",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ).run();
}

/** 乱序插入：种子顺序与 receiptNo 顺序相反，排序回归不会被写入顺序掩盖。 */
async function seedTcmBook(): Promise<void> {
  const ids = [
    BOOK,
    OTHER_BOOK,
    CHAPTER_A,
    CHAPTER_B,
    CHAPTER_OTHER,
    CHAPTER_DELETED,
    SECTION_A1,
    SECTION_A2,
    SECTION_B1,
    SECTION_B2,
    SECTION_ORPHAN,
    SECTION_NO_PARENT,
    FANG_ROW,
  ];
  await env.FEED_DB.batch(ids.map((id) => env.FEED_DB.prepare(
    "DELETE FROM items WHERE id = ?",
  ).bind(id)));
  await env.FEED_DB.batch([BOOK, OTHER_BOOK].map((id) => env.FEED_DB.prepare(
    "DELETE FROM channels WHERE id = ?",
  ).bind(id)));

  await insertChannel(BOOK, "展开测试典籍");
  await insertChannel(OTHER_BOOK, "别家典籍");

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
    bookId: OTHER_BOOK,
    data: {section: 1},
    id: CHAPTER_OTHER,
    title: "别家卷",
    tcmKind: "chapter",
  });
  await insertItem({
    bookId: BOOK,
    data: {section: 3},
    id: CHAPTER_DELETED,
    status: STATUSES.DELETED,
    title: "已删篇章",
    tcmKind: "chapter",
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
    data: {receiptNo: 201},
    id: SECTION_A1,
    parentId: CHAPTER_A,
    title: "甲一",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 102},
    id: SECTION_B2,
    parentId: CHAPTER_B,
    title: "乙二",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {no: 11, receiptNo: 101},
    id: SECTION_B1,
    parentId: CHAPTER_B,
    title: "乙一",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 901},
    id: SECTION_ORPHAN,
    parentId: CHAPTER_OTHER,
    title: "孤条文",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {receiptNo: 902},
    id: SECTION_NO_PARENT,
    title: "无父条文",
    tcmKind: "section",
  });
  await insertItem({
    bookId: BOOK,
    data: {no: 1, sourceBookId: BOOK},
    id: FANG_ROW,
    title: "测试方剂",
    tcmKind: "fang",
  });
}

async function readBody(response: Response): Promise<VolumeEntryList> {
  return await response.json() as VolumeEntryList;
}

describe("admin volume board: volume click reads that volume only", () => {
  beforeEach(seedTcmBook);

  it("requires the volume read code", async () => {
    const denied = await call(BOOK, CHAPTER_A, locals());
    expect(denied.status).toBe(403);
  });

  it("returns the volume's entries in section order with a 1-based index", async () => {
    const response = await call(BOOK, CHAPTER_A);
    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body.name).toBe("卷甲");
    expect(body.tcm).toBe(true);
    expect(body.unknown).toBe(false);
    expect(body.entries.map((entry) => [entry.index, entry.id, entry.title])).toEqual([
      [1, SECTION_A1, "甲一"],
      [2, SECTION_A2, "甲二"],
    ]);
  });

  it("never carries another volume's entry", async () => {
    const text = JSON.stringify(await readBody(await call(BOOK, CHAPTER_B)));
    for (const otherId of [SECTION_A1, SECTION_A2, SECTION_ORPHAN, SECTION_NO_PARENT]) {
      expect(text).not.toContain(otherId);
    }
    const body = await readBody(await call(BOOK, CHAPTER_B));
    expect(body.entries.map((entry) => entry.id)).toEqual([SECTION_B1, SECTION_B2]);
  });

  it("keeps 方剂 out of every volume's entries", async () => {
    for (const key of [CHAPTER_A, CHAPTER_B, UNFILED_VOLUME_KEY]) {
      const text = JSON.stringify(await readBody(await call(BOOK, key)));
      expect(text).not.toContain(FANG_ROW);
    }
  });

  it("lists the unfiled bucket's sections, orphan and parentless alike", async () => {
    const body = await readBody(await call(BOOK, UNFILED_VOLUME_KEY));
    expect(body.name).toBe("");
    expect(body.entries.map((entry) => entry.id)).toEqual([
      SECTION_ORPHAN,
      SECTION_NO_PARENT,
    ]);
  });

  it("answers a foreign chapter key with an empty list", async () => {
    const body = await readBody(await call(BOOK, CHAPTER_OTHER));
    expect(body.unknown).toBe(true);
    expect(body.entries).toEqual([]);
    // 别家卷下的条文一行都不该出现在载荷里。
    expect(JSON.stringify(body)).not.toContain(SECTION_B1);
  });

  it("answers a soft-deleted chapter key with an empty list", async () => {
    const body = await readBody(await call(BOOK, CHAPTER_DELETED));
    expect(body.unknown).toBe(true);
    expect(body.entries).toEqual([]);
  });

  it("rejects a request without a book id or a volume key", async () => {
    const missingBook = await volumeEntries({
      locals: locals(PERMISSION_CODES.CONTENT_VOLUME_READ),
      request: new Request(`${ENTRIES_URL}?volume=${CHAPTER_A}`),
    } as never);
    expect(missingBook.status).toBe(400);
    const missingVolume = await volumeEntries({
      locals: locals(PERMISSION_CODES.CONTENT_VOLUME_READ),
      request: new Request(`${ENTRIES_URL}?bookId=${BOOK}`),
    } as never);
    expect(missingVolume.status).toBe(400);
  });

  it("reads a private, non-stable payload", async () => {
    const response = await call(BOOK, CHAPTER_A);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
