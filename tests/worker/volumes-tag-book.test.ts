/**
 * 卷看板的标签书分支：`tcm_kind` 为空的那类书，卷是章节携带的 `_microfeed.volume` 标签。
 *
 * 本机库 9,506 条条目全部带 `tcm_kind`，这条分支在真实数据上走不到，所以它的口径只能
 * 由端点层夹具锁住（票据 04）。这里锁四件：
 * - 点书只见卷：卷名同时是 `key` 与 `name`，条数来自整本窄读取的内存分组，载荷里
 *   一个条目 id 都不出现；显式卷序排在使用它的卷之前，未归类桶恒在最后；
 * - 点卷只见该卷：按卷名等值条件只回这一卷的条目，被软删的条目与别的书的同名卷
 *   都不出现；
 * - 过期或手填的卷名当作「这本书没有这一卷」：空列表 + `unknown`，不读任何额外行；
 * - 两个入口都只认 `content:volume:read`，缺码 403。
 *
 * 不给 `_microfeed.volume` 加派生真实列与索引（票据 04 的决定），所以卷名条件在
 * `items_book_id` 上步进这本书的全部条目行——这条分支的读取代价按整本算，
 * 但它只在真的存在标签书时才付。
 *
 * 测试只写不跑：门禁由用户手动触发。
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as volumeEntries} from "@/pages/[adminPath]/ajax/volumes/entries";
import {GET as volumesIndex} from "@/pages/[adminPath]/ajax/volumes/index";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";
import {UNFILED_VOLUME_KEY, type VolumeEntryList, type VolumeList} from "@/shared/ExtVolume";

const INDEX_URL = "https://feed.example.com/admin/ajax/volumes/";
const ENTRIES_URL = "https://feed.example.com/admin/ajax/volumes/entries";
const BOOK = "TagBook1";
const OTHER_BOOK = "TagBook2";
const CHAPTER_A1 = "TagItmA00001";
const CHAPTER_A2 = "TagItmA00002";
const CHAPTER_B1 = "TagItmB00001";
const CHAPTER_UNFILED = "TagItmU00001";
const CHAPTER_DELETED = "TagItmD00001";
const CHAPTER_OTHER = "TagItmO00001";

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-tag"},
    rbacPermissions: new Set<string>(codes),
  };
}

function readLocals() {
  return locals(PERMISSION_CODES.CONTENT_VOLUME_READ);
}

async function callIndex(bookId: string, who = readLocals()) {
  return volumesIndex({
    locals: who,
    request: new Request(`${INDEX_URL}?bookId=${bookId}`),
  } as never);
}

async function callEntries(bookId: string, volume: string, who = readLocals()) {
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

interface Seed {
  chapterNo: number;
  bookId: string;
  id: string;
  pubDate?: string;
  status?: number;
  title: string;
  volume?: string;
  volumeOrder?: number;
}

/** 章节行：`tcm_kind` 留空，卷只存在于 `_microfeed.volume` 标签里。 */
async function insertChapter(seed: Seed): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    seed.id,
    seed.status ?? STATUSES.PUBLISHED,
    JSON.stringify({
      title: seed.title,
      _microfeed: {
        bookId: seed.bookId,
        chapterNo: seed.chapterNo,
        volume: seed.volume ?? "",
        ...(seed.volumeOrder == null ? {} : {volumeOrder: seed.volumeOrder}),
      },
    }),
    seed.pubDate ?? "2026-01-01T00:00:00.000Z",
    seed.bookId,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ).run();
}

async function seedTagBooks(): Promise<void> {
  const ids = [
    CHAPTER_A1,
    CHAPTER_A2,
    CHAPTER_B1,
    CHAPTER_UNFILED,
    CHAPTER_DELETED,
    CHAPTER_OTHER,
  ];
  await env.FEED_DB.batch(ids.map((id) => env.FEED_DB.prepare(
    "DELETE FROM items WHERE id = ?",
  ).bind(id)));
  await env.FEED_DB.batch([BOOK, OTHER_BOOK].map((id) => env.FEED_DB.prepare(
    "DELETE FROM channels WHERE id = ?",
  ).bind(id)));

  await insertChannel(BOOK, "星河剑歌");
  await insertChannel(OTHER_BOOK, "别家书");

  await insertChapter({
    bookId: BOOK,
    chapterNo: 1,
    id: CHAPTER_A1,
    pubDate: "2026-01-01T00:00:00.000Z",
    title: "第1章",
    volume: "第一卷",
  });
  await insertChapter({
    bookId: BOOK,
    chapterNo: 2,
    id: CHAPTER_A2,
    pubDate: "2026-01-02T00:00:00.000Z",
    title: "第2章",
    volume: "第一卷",
  });
  // 显式卷序 0：这本书里排在「第一卷」之前。
  await insertChapter({
    bookId: BOOK,
    chapterNo: 1,
    id: CHAPTER_B1,
    pubDate: "2026-02-01T00:00:00.000Z",
    title: "第1章",
    volume: "第二卷",
    volumeOrder: 0,
  });
  await insertChapter({
    bookId: BOOK,
    chapterNo: 3,
    id: CHAPTER_UNFILED,
    pubDate: "2026-01-03T00:00:00.000Z",
    title: "未归档章",
  });
  await insertChapter({
    bookId: BOOK,
    chapterNo: 4,
    id: CHAPTER_DELETED,
    status: STATUSES.DELETED,
    title: "已删章",
    volume: "第一卷",
  });
  // 别的书也有一卷叫「第一卷」：按书名等值取条目时必须被 `book_id` 挡住。
  await insertChapter({
    bookId: OTHER_BOOK,
    chapterNo: 1,
    id: CHAPTER_OTHER,
    title: "别家第1章",
    volume: "第一卷",
  });
}

async function readVolumes(response: Response): Promise<VolumeList | null> {
  const body = await response.json() as {volumes: VolumeList | null};
  return body.volumes;
}

async function readEntries(response: Response): Promise<VolumeEntryList> {
  return response.json() as Promise<VolumeEntryList>;
}

describe("admin volume board: tag-based books (volume is a tag, not a chapter)", () => {
  beforeEach(seedTagBooks);

  it("lists the book's volumes with counts and no entry rows", async () => {
    const response = await callIndex(BOOK);
    expect(response.status).toBe(200);
    const volumes = await readVolumes(response);
    expect(volumes?.book).toEqual({id: BOOK, title: "星河剑歌"});
    // 书形由 `tcm_kind` 探测决定：这本书的条目都没有它，所以是标签书。
    expect(volumes?.tcm).toBe(false);
    expect(volumes?.volumes).toEqual([
      {chapterCount: 1, key: "第二卷", name: "第二卷", order: 0},
      {chapterCount: 2, key: "第一卷", name: "第一卷", order: null},
      {chapterCount: 1, key: UNFILED_VOLUME_KEY, name: "", order: null},
    ]);
    // 卷名就是键：前端把 `key` 原样发回来即可，不需要分辨书的种类。
    expect(volumes?.volumes[1]?.key).toBe(volumes?.volumes[1]?.name);

    const text = JSON.stringify(await callIndex(BOOK).then((r) => r.json()));
    for (const id of [CHAPTER_A1, CHAPTER_A2, CHAPTER_B1, CHAPTER_UNFILED]) {
      expect(text).not.toContain(id);
    }
  });

  it("returns only that volume's chapters when one volume is opened", async () => {
    const result = await readEntries(await callEntries(BOOK, "第一卷"));

    expect(result.tcm).toBe(false);
    expect(result.unknown).toBe(false);
    expect(result.name).toBe("第一卷");
    expect(result.entries.map((entry) => [entry.index, entry.id, entry.title])).toEqual([
      [1, CHAPTER_A1, "第1章"],
      [2, CHAPTER_A2, "第2章"],
    ]);
    // 被软删的那条与别家书的同名卷都不在载荷里。
    expect(JSON.stringify(result)).not.toContain(CHAPTER_DELETED);
    expect(JSON.stringify(result)).not.toContain(CHAPTER_OTHER);
  });

  it("serves the unfiled bucket by its key and reports a stale label as unknown", async () => {
    const unfiled = await readEntries(await callEntries(BOOK, UNFILED_VOLUME_KEY));
    expect(unfiled.name).toBe("");
    expect(unfiled.unknown).toBe(false);
    expect(unfiled.entries.map((entry) => entry.id)).toEqual([CHAPTER_UNFILED]);

    const stale = await readEntries(await callEntries(BOOK, "第三卷"));
    expect(stale.entries).toEqual([]);
    expect(stale.unknown).toBe(true);
  });

  it("requires the volume read code on both endpoints", async () => {
    const noCode = locals();
    expect((await callIndex(BOOK, noCode)).status).toBe(403);
    expect((await callEntries(BOOK, "第一卷", noCode)).status).toBe(403);
  });

  it("returns no volumes for a book that does not exist", async () => {
    const volumes = await readVolumes(await callIndex("TagNoBook1"));
    expect(volumes?.book).toBeNull();
    expect(volumes?.volumes).toEqual([]);
  });
});
