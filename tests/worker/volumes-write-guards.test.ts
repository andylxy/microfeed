/**
 * 卷看板的四个写入口：归属判定逐条做，不再读整本书。
 *
 * 改动前每次写入先把这本书的全部条目读回来构造「可改 id 集合」（《素问》整本看板
 * 2,964 行；归卷 3 条的守卫读取按两遍口径是 5,928 行），所以改 1 条也要为其余几千条
 * 付行读。改动后每个提交进来的 id 各读两下——一次只读结构列的主键点查（守卫），一次
 * 整行（重建条目与审计快照）——归卷 3 条是 6 行，改名/卷序则按卷条件只选那一卷的 id。
 *
 * 这里锁的就是「不读整本」之后仍然成立的那几条边界：
 * - 缺 `content:volume:update` 时四个入口一律 403（读权限码不放行写入）；
 * - 属于别的书的 id 一行都不改，本书的 id 照常写入；
 * - 篇章自身与独立目录（`fang`）不在写入口径里，被软删的条目同样跳过；
 * - 中药/名词书挂在根篇章下的 `yao` 行属于该卷，改名与归卷要能改到它；
 * - 改名冲突仍是 409，理由码不变；
 * - 改名与卷序只落在那一卷的条目上，别的卷一行不动；
 * - 书不存在时 404。
 *
 * 测试只写不跑：门禁由用户手动触发（见 AGENTS.md「门禁仅在手动触发时运行」）。
 */

import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {POST as assignVolume} from "@/pages/[adminPath]/ajax/volumes/assign";
import {POST as setVolumeOrder} from "@/pages/[adminPath]/ajax/volumes/order";
import {POST as renameVolume} from "@/pages/[adminPath]/ajax/volumes/rename";
import {POST as reorderChapters} from "@/pages/[adminPath]/ajax/volumes/reorder";
import {VOLUME_ERRORS} from "@/server/admin/volume-handlers";
import FeedDb from "@/server/feed/FeedDb";
import {PERMISSION_CODES, STATUSES} from "@/shared/Constants";
import {translate} from "@/shared/i18n";

const ORIGIN = "https://feed.example.com";
const BOOK = "WgBook1";
const OTHER_BOOK = "WgBook2";
const CHAPTER_A = "WgChapA001";
const CHAPTER_B = "WgChapB001";
const CHAPTER_OTHER = "WgChapO001";
const SECTION_A1 = "WgSecA00001";
const SECTION_A2 = "WgSecA00002";
const SECTION_B1 = "WgSecB00001";
const SECTION_DELETED = "WgSecD00001";
const SECTION_OTHER = "WgSecO00001";
const YAO_A = "WgYaoA00001";
const FANG_A = "WgFang00001";

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-volwrite"},
    rbacPermissions: new Set<string>(codes),
  };
}

function writeLocals() {
  return locals(PERMISSION_CODES.CONTENT_VOLUME_UPDATE);
}

async function post(handler: typeof assignVolume, payload: unknown, who = writeLocals()) {
  return handler({
    locals: who,
    request: new Request(`${ORIGIN}/admin/ajax/volumes/`, {
      body: JSON.stringify(payload),
      headers: {"content-type": "application/json"},
      method: "POST",
    }),
  } as never);
}

async function updatedCount(response: Response): Promise<number> {
  const body = await response.json() as {updated?: number};
  return body.updated ?? -1;
}

/** 一行条目的写入口径：卷标签、父项、章序、卷序、状态。 */
interface RowSnapshot {
  book_id: string | null;
  chapter_no: number | null;
  id: string;
  status: number;
  tcm_kind: string | null;
  tcm_parent_id: string | null;
  title: string | null;
  volume: string | null;
  volume_order: number | null;
}

async function readRow(id: string): Promise<RowSnapshot> {
  const row = await env.FEED_DB.prepare(
    "SELECT id, status, book_id, tcm_kind, tcm_parent_id, " +
      "json_extract(data, '$.title') AS title, " +
      "json_extract(data, '$._microfeed.volume') AS volume, " +
      "json_extract(data, '$._microfeed.chapterNo') AS chapter_no, " +
      "json_extract(data, '$._microfeed.volumeOrder') AS volume_order " +
      "FROM items WHERE id = ?",
  ).bind(id).first<RowSnapshot>();
  if (row == null) throw new Error(`Missing row: ${id}`);
  return row;
}

async function insertChannel(id: string, title: string): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO channels (id, data, created_at, status, genre) VALUES (?, ?, ?, ?, ?)",
  ).bind(id, JSON.stringify({_microfeed: {}, title}), Date.now(), STATUSES.PUBLISHED, "").run();
}

interface Seed {
  bookId: string;
  chapterNo?: number;
  id: string;
  parentId?: string;
  status?: number;
  tcmKind?: string;
  title: string;
  volume?: string;
}

async function insertItem(seed: Seed): Promise<void> {
  await env.FEED_DB.prepare(
    "INSERT INTO items (id, status, data, pub_date, book_id, tcm_kind, tcm_parent_id, " +
      "created_at, updated_at, content_text, review_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    seed.id,
    seed.status ?? STATUSES.PUBLISHED,
    JSON.stringify({
      title: seed.title,
      _microfeed: {
        bookId: seed.bookId,
        chapterNo: seed.chapterNo ?? 1,
        volume: seed.volume ?? "",
      },
    }),
    "2026-01-01T00:00:00.000Z",
    seed.bookId,
    seed.tcmKind ?? null,
    seed.parentId ?? "",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    seed.title,
    "approved",
  ).run();
}

/** 两本中医典籍：本书有两卷（含一条被软删的条文、一行中药、一行方剂），别家一卷一条。 */
async function seedBooks(): Promise<void> {
  // 先让出厂内容就位（`getContent` 在 settings 为空时会补齐），写入路径要用它。
  await new FeedDb(env, new Request(`${ORIGIN}/admin/`)).getContent(null);
  await env.FEED_DB.batch([
    env.FEED_DB.prepare("DELETE FROM items WHERE book_id = ?").bind(BOOK),
    env.FEED_DB.prepare("DELETE FROM items WHERE book_id = ?").bind(OTHER_BOOK),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id = ?").bind(BOOK),
    env.FEED_DB.prepare("DELETE FROM channels WHERE id = ?").bind(OTHER_BOOK),
  ]);

  await insertChannel(BOOK, "测试典籍");
  await insertChannel(OTHER_BOOK, "别家典籍");

  await insertItem({bookId: BOOK, id: CHAPTER_A, tcmKind: "chapter", title: "卷甲"});
  await insertItem({bookId: BOOK, id: CHAPTER_B, tcmKind: "chapter", title: "卷乙"});
  await insertItem({
    bookId: BOOK,
    id: SECTION_A1,
    parentId: CHAPTER_A,
    title: "甲一",
    tcmKind: "section",
    volume: "卷甲",
  });
  await insertItem({
    bookId: BOOK,
    id: SECTION_A2,
    parentId: CHAPTER_A,
    title: "甲二",
    tcmKind: "section",
    volume: "卷甲",
  });
  await insertItem({
    bookId: BOOK,
    id: SECTION_B1,
    parentId: CHAPTER_B,
    title: "乙一",
    tcmKind: "section",
    volume: "卷乙",
  });
  await insertItem({
    bookId: BOOK,
    id: SECTION_DELETED,
    parentId: CHAPTER_A,
    status: STATUSES.DELETED,
    title: "甲三（已删）",
    tcmKind: "section",
    volume: "卷甲",
  });
  // 中药书形状：`yao` 行挂在篇章下，它也是这一卷的条目。
  await insertItem({
    bookId: BOOK,
    id: YAO_A,
    parentId: CHAPTER_A,
    title: "1、甘草",
    tcmKind: "yao",
    volume: "卷甲",
  });
  // 方剂是独立目录：带着本书的 book_id，但不归卷/章树管。
  await insertItem({bookId: BOOK, id: FANG_A, title: "测试方剂", tcmKind: "fang"});
  await insertItem({
    bookId: OTHER_BOOK,
    id: CHAPTER_OTHER,
    tcmKind: "chapter",
    title: "别卷",
  });
  await insertItem({
    bookId: OTHER_BOOK,
    id: SECTION_OTHER,
    parentId: CHAPTER_OTHER,
    title: "别家条文",
    tcmKind: "section",
    volume: "别卷",
  });
}

describe("admin volume writes: guard is a per-id point read", () => {
  beforeEach(seedBooks);

  it("refuses all four write endpoints without the manage code", async () => {
    const noCode = locals(PERMISSION_CODES.CONTENT_VOLUME_READ);

    expect((await post(assignVolume, {bookId: BOOK, itemIds: [SECTION_A1], volume: "卷乙"}, noCode)).status)
      .toBe(403);
    expect((await post(renameVolume, {bookId: BOOK, from: "卷甲", to: "卷甲新"}, noCode)).status)
      .toBe(403);
    expect((await post(reorderChapters, {bookId: BOOK, updates: [{chapterNo: 2, id: SECTION_A1}]}, noCode)).status)
      .toBe(403);
    expect((await post(setVolumeOrder, {bookId: BOOK, orders: [{order: 0, volume: "卷甲"}]}, noCode)).status)
      .toBe(403);

    // 拒绝得彻底：一行都没被改。
    expect(await readRow(SECTION_A1)).toMatchObject({volume: "卷甲"});
  });

  it("writes this book's id and ignores another book's id in one batch", async () => {
    const response = await post(assignVolume, {
      bookId: BOOK,
      itemIds: [SECTION_A1, SECTION_OTHER],
      volume: "卷乙",
    });

    expect(response.status).toBe(200);
    expect(await updatedCount(response)).toBe(1);
    expect(await readRow(SECTION_A1)).toMatchObject({
      tcm_parent_id: CHAPTER_B,
      volume: "卷乙",
    });
    // 别家典籍的那一行连读都没读：守卫点查带着 `book_id`，主键对不上就跳过。
    expect(await readRow(SECTION_OTHER)).toMatchObject({
      tcm_parent_id: CHAPTER_OTHER,
      volume: "别卷",
    });
  });

  it("skips a chapter row, a fang row, and a soft-deleted entry", async () => {
    const response = await post(assignVolume, {
      bookId: BOOK,
      itemIds: [CHAPTER_A, FANG_A, SECTION_DELETED],
      volume: "卷乙",
    });

    expect(response.status).toBe(200);
    expect(await updatedCount(response)).toBe(0);
    // 篇章自身就是卷名那一行，不通过归卷改写；方剂属于独立目录；已删条目不参与。
    expect(await readRow(CHAPTER_A)).toMatchObject({tcm_parent_id: "", title: "卷甲"});
    expect(await readRow(FANG_A)).toMatchObject({tcm_parent_id: "", volume: ""});
    expect(await readRow(SECTION_DELETED)).toMatchObject({
      tcm_parent_id: CHAPTER_A,
      volume: "卷甲",
    });
  });

  it("files an herb row under another volume and unfiles it again", async () => {
    // `yao` 行挂在根篇章下，与条文同属那一卷；守卫放开到 `NOT IN ('chapter','fang')`
    // 才有这条写入——只认 `section` 的口径会把中药书的整批条目漏在写入口之外。
    const moved = await post(assignVolume, {
      bookId: BOOK,
      itemIds: [YAO_A],
      volume: "卷乙",
    });
    expect(await updatedCount(moved)).toBe(1);
    expect(await readRow(YAO_A)).toMatchObject({tcm_parent_id: CHAPTER_B, volume: "卷乙"});

    const unfiled = await post(assignVolume, {bookId: BOOK, itemIds: [YAO_A], volume: ""});
    expect(await updatedCount(unfiled)).toBe(1);
    // 退回未归类桶写的是 NULL 父项（卷列表把父项为空的行算进未归类）。
    expect(await readRow(YAO_A)).toMatchObject({tcm_parent_id: null, volume: ""});
  });

  it("rejects a rename onto an existing volume name with the same reason code", async () => {
    const response = await post(renameVolume, {bookId: BOOK, from: "卷甲", to: "卷乙"});

    expect(response.status).toBe(409);
    const body = await response.json() as {error?: string};
    expect(body.error).toBe(translate(VOLUME_ERRORS.volumeExists));
    expect(await readRow(CHAPTER_A)).toMatchObject({title: "卷甲"});
    expect(await readRow(SECTION_A1)).toMatchObject({volume: "卷甲"});
  });

  it("renames one volume's rows and leaves the other volume untouched", async () => {
    const response = await post(renameVolume, {bookId: BOOK, from: "卷甲", to: "卷甲新"});

    expect(response.status).toBe(200);
    // 卷甲的两条条文加一行中药：被软删的那条不在守卫口径里。
    expect(await updatedCount(response)).toBe(3);
    expect(await readRow(CHAPTER_A)).toMatchObject({title: "卷甲新"});
    expect(await readRow(SECTION_A1)).toMatchObject({volume: "卷甲新"});
    expect(await readRow(SECTION_A2)).toMatchObject({volume: "卷甲新"});
    expect(await readRow(YAO_A)).toMatchObject({volume: "卷甲新"});
    // 别的卷一行都不读、也不改。
    expect(await readRow(SECTION_B1)).toMatchObject({volume: "卷乙"});
    expect(await readRow(CHAPTER_B)).toMatchObject({title: "卷乙"});
  });

  it("writes an explicit volume order on that volume's entries only", async () => {
    const response = await post(setVolumeOrder, {
      bookId: BOOK,
      orders: [{order: 3, volume: "卷甲"}],
    });

    expect(response.status).toBe(200);
    expect(await updatedCount(response)).toBe(3);
    expect(await readRow(SECTION_A1)).toMatchObject({volume_order: 3});
    expect(await readRow(SECTION_A2)).toMatchObject({volume_order: 3});
    expect(await readRow(YAO_A)).toMatchObject({volume_order: 3});
    expect(await readRow(SECTION_B1)).toMatchObject({volume_order: null});
  });

  it("rewrites chapterNo for this book's id and ignores a foreign id", async () => {
    const response = await post(reorderChapters, {
      bookId: BOOK,
      updates: [{chapterNo: 5, id: SECTION_A1}, {chapterNo: 7, id: SECTION_OTHER}],
    });

    expect(response.status).toBe(200);
    expect(await updatedCount(response)).toBe(1);
    expect(await readRow(SECTION_A1)).toMatchObject({chapter_no: 5});
    expect(await readRow(SECTION_OTHER)).toMatchObject({chapter_no: 1});
  });

  it("answers a missing book with 404 before reading any item row", async () => {
    const response = await post(assignVolume, {
      bookId: "WgNoBook1",
      itemIds: [SECTION_A1],
      volume: "卷乙",
    });

    expect(response.status).toBe(404);
    const body = await response.json() as {error?: string};
    expect(body.error).toBe(translate(VOLUME_ERRORS.bookMissing));
    expect(await readRow(SECTION_A1)).toMatchObject({volume: "卷甲"});
  });
});
