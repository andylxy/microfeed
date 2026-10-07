/**
 * Read functions backing the mobile-app endpoints (`/api/AppBookRequest/*`).
 *
 * Spec: `.scratch/tcm-import/spec.md` §6 (response shapes match the legacy
 * .NET backend field-for-field, with every id value being a current-project
 * 11-char id) and §16.3 (every query below is index-backed — no SCAN items).
 *
 * All endpoints are anonymous reads (the legacy actions were the app's own
 * contract); the middleware whitelists the `/api/AppBookRequest/` namespace.
 *
 * Marker text (`$u{桂枝}`) is returned RAW in `text`-like fields: the app
 * renders markers itself from the `GetTipsStyleConfig` catalogue; the PC web
 * shows them literally too (user decision 2026-09-28). The bodies stored in
 * `data.description` are `<p>`-wrapped, so `rawParagraphText()` reverses that
 * deterministic wrapping.
 */

import {TCM_CHAPTER_ORDER_SQL} from "./ordering";
import {JINGSHU_ONLY_YAO_NAMES} from "./zhongyao-anchor";

// 所有字段名与值类型照抄旧后端真实 wire 形状（golden 对齐 2026-09-28：全小驼峰、
// 部分数值字段旧后端序列化为字符串、空值发 null）。
export interface AppNavListItem {
  bookNo: string;
  imageUrl: string | null;
  bookName: string;
  chengShu: string | null;
  author: string | null;
  caseTag: number;
  desc: null;
  chapterCount: number;
}

export interface AppNavCategory {
  caseId: string;
  name: string;
  navList: AppNavListItem[];
}

export interface AppChapterEntry {
  bookId: string;
  chapterSection: number | null;
  chapterHeader: string;
  signatureId: string;
}

export interface AppChapterSection {
  id: string;
  text: string;
  note: string | null;
  sectionvideo: string | null;
  height: number;
  // 旧后端 Signature = MD5(UTF8(text))（数据变动即改变）；本项目用同一算法实时算出，
  // 与旧端逐字节一致（golden 验证 1/1）。signatureId 沿用旧字段名，值 = 该条文条目 11 位 id。
  signature: string;
  signatureId: string;
  fangList: string[];
}

export interface AppChapterContent {
  section: number | null;
  header: string;
  // 字段名沿用旧后端（App 按 signatureId 定位/缓存章节内容）；值 = 篇章条目 11 位 id（App 端将把 long 改 String）。
  signatureId: string;
  data: AppChapterSection[];
}

export interface AppFangStandardYao {
  suffix: string | null;
  amount: string;
  yaoID: string | null;
  weight: string | null;
  showName: string;
  extraProcess: string;
  // 结构对齐旧后端：signature = 该行全部内容字段的确定性 MD5（旧端存 FangBody.Signature，
  // 算法无法从 wire 反推，故用内容字段重算作为版本令牌）；signatureId = 该组成行对应中药条目 11 位 id。
  signature: string;
  signatureId: string;
}

export interface AppFang {
  /**
   * 旧后端对不同书的响应形状不一致（实测 wire）：
   *  - BookNo=10001（伤寒金匮・宋版）：`ID` 字段（值"0"占位）、yaoCount/height/drinkNum 为字符串；
   *  - BookNo=1001000（桂林古本）：`id` 字段（值为数字源 id，迁移后放 11 位 id）、数值字段为数字。
   * 按书 wire 档案（FANG_NUMERIC_WIRE）复刻：id/ID 二选一，数值字段类型随书。
   */
  yaoCount: string | number | null;
  height: string | number;
  name: string;
  ID?: string;
  id?: string;
  drinkNum: string | number | null;
  text: string;
  // 结构对齐旧后端：signature = MD5(UTF8(text))（与旧端逐字节一致，golden 验证 315/315）；
  // signatureId = 该方剂条目 11 位 id。
  signature: string;
  signatureId: string;
  fangList: string[];
  yaoList: string[];
  standardYaoList: AppFangStandardYao[];
}

export interface AppZhongYao {
  name: string;
  text: string;
}

export interface AppYaoAlias {
  bieming: string;
  name: string;
}

/** 旧后端 GetAllMingCi 响应形状（实测 golden）：小驼峰字段，mingCiList 按英文逗号劈成数组。 */
export interface AppMingCi {
  id: string;
  mingCiList: string[];
  name: string;
  imageUrl: string | null;
  text: string;
}

export interface AppStyleItem {
  marker: string;
  color: string;
  isSmallFont: boolean;
  linkType: number;
}

interface Pocket {
  bookId?: unknown;
  sourceBookId?: unknown;
  section?: unknown;
  receiptNo?: unknown;
  note?: unknown;
  videoMemo?: unknown;
  fangList?: unknown;
  yaoCount?: unknown;
  drinkNum?: unknown;
  yaoList?: unknown;
  fangYaoList?: unknown;
  no?: unknown;
  bieMing?: unknown;
  yaoNames?: unknown;
  aliases?: unknown;
  beiMing?: unknown;
  type?: unknown;
  mingCiList?: unknown;
  sourceImagePath?: unknown;
  author?: unknown;
  chengShu?: unknown;
  case?: unknown;
}

function pocketOf(dataJson: unknown): Pocket {
  try {
    const data = JSON.parse(String(dataJson ?? "{}")) as Record<string, unknown>;
    return (data._microfeed ?? {}) as Pocket;
  } catch {
    return {};
  }
}

function titleOf(dataJson: unknown): string {
  try {
    const data = JSON.parse(String(dataJson ?? "{}")) as Record<string, unknown>;
    return typeof data.title === "string" ? data.title : "";
  } catch {
    return "";
  }
}

/** yao 条目标题在库里带 "N、" 序号前缀（后台卷面板展示用，见 import-yao.mjs）；
 * App 契约的 yao `name` 必须是裸药名（与 netcore 一致），剥离前缀。 */
function yaoAppName(dataJson: unknown): string {
  return titleOf(dataJson).replace(/^\d+、/, "");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** textToHtml 的精确逆变换：`<p>a</p>\r\n<p>b</p>` → `a\r\nb`（分隔符与行首空格逐字节还原）。 */
export function rawParagraphText(html: string): string {
  const source = String(html ?? "");
  if (!/<p>[\s\S]*<\/p>/.test(source)) return source;
  let out = "";
  for (const m of source.matchAll(/<p>([\s\S]*?)<\/p>(\r\n|\r|\n|$)/g)) {
    out += m[1] + (m[2] ?? "");
  }
  return out;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 空串 / null / undefined → null（旧后端对空文本字段发 null）。 */
function textOrNull(value: unknown): string | null {
  const s = str(value);
  return s === "" ? null : s;
}

/** 数值 → 字符串（旧后端把部分数值字段序列化为字符串）；非数值 / 空 → null。 */
function numberToStrOrNull(value: unknown): string | null {
  const n = toNumber(value);
  return n === null ? null : String(n);
}

/**
 * 同步 MD5（RFC 1321），输出 32 位大写十六进制。
 *
 * 旧 .NET 后端把 `Signature = MD5(UTF8(text))` 作为每条记录的内容签名，
 * 并在每次新增/修改数据时重算（用户实锤：netcore 数据变动 → signature 改变）。
 * 移动端据此按 `signatureId` 缓存、用 `signature` 判断内容是否过期（类 ETag）。
 * 已对 golden wire 数据验证：315/315 方剂 + 全部条文 的 signature 均等于 MD5(text)。
 *
 * Cloudflare Workers 的 Web Crypto 不支持 MD5，故这里自带纯 JS 实现（按字节算，
 * 输入先经 TextEncoder 转 UTF-8，与旧后端字节一致）。
 */
export function md5(input: string): string {
  const msg = new TextEncoder().encode(input);
  const msgLen = msg.length;
  const bitLenLo = (msgLen * 8) >>> 0;
  const bitLenHi = Math.floor((msgLen * 8) / 0x100000000) >>> 0;
  const totalBlocks = Math.ceil((msgLen + 1 + 8) / 64);
  const buf = new Uint8Array(totalBlocks * 64);
  buf.set(msg);
  buf[msgLen] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalBlocks * 64 - 8, bitLenLo, true);
  view.setUint32(totalBlocks * 64 - 4, bitLenHi, true);

  // 64 个 K 常数（标准 MD5 表，硬编码避免 Math.sin 精度差异）。
  const K = new Uint32Array([
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
    0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
    0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
    0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
    0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
    0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
    11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
    10, 15, 21,
  ];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let block = 0; block < totalBlocks; block++) {
    const off = block * 64;
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + (K[i] as number) + (M[g] as number)) >>> 0;
      const rot = ((F << (S[i] as number)) | (F >>> (32 - (S[i] as number)))) >>> 0;
      A = D; D = C; C = B; B = (B + rot) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const hex = (v: number): string => {
    const n = v >>> 0;
    return (
      ((n & 0xff).toString(16).padStart(2, "0") +
        ((n >>> 8) & 0xff).toString(16).padStart(2, "0") +
        ((n >>> 16) & 0xff).toString(16).padStart(2, "0") +
        ((n >>> 24) & 0xff).toString(16).padStart(2, "0"))
    );
  };
  return (hex(a0) + hex(b0) + hex(c0) + hex(d0)).toUpperCase();
}

/**
 * §9 防御性降级：读函数正常返回值；D1 异常时降级为空值（数组返回 []、Map 返回空 Map）并留痕，
 * 避免 App 端因未知异常崩。未知 id 已在各函数内返回 []（不报 404）。
 */
async function withEmpty<T>(label: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    console.error(`[tcm-reads] ${label} 读取失败，降级为空值:`, e);
    return [] as unknown as T;
  }
}

/** 源 WorkInfo.Case 存的是字符串数字；App 按 caseTag 区分行为（1/2/3 隐方药页、5=伤寒显单位页）。 */
function caseTagOf(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 章节条目的 description 就是 textToHtml 后的正文，反转回原文。
/** 条目正文：导入时存的是 textToHtml 包装后的 HTML，这里反转回带换行的原文。 */
function descriptionOf(dataJson: unknown): string {
  try {
    const data = JSON.parse(String(dataJson ?? "{}")) as Record<string, unknown>;
    return typeof data.description === "string" ? data.description : "";
  } catch {
    return "";
  }
}

/** 分类 → 该分类下已发布的书（全部中医 + 小说共用同一约定）。 */
export async function getAppNav(db: D1Database): Promise<AppNavCategory[]> {
  return withEmpty("getAppNav", async () => {
    const {results} = await db
      .prepare(
        "SELECT c.id AS categoryId, c.name AS categoryName, ch.id AS bookId, ch.data AS data " +
          "FROM ext_category c JOIN channels ch ON ch.genre = c.id AND ch.status = 1 " +
          "ORDER BY c.sort, ch.created_at",
      )
      .all();
    const order: string[] = [];
    const byCategory = new Map<string, AppNavCategory>();
    for (const row of results ?? []) {
      const categoryId = String(row.categoryId);
      let category = byCategory.get(categoryId);
      if (!category) {
        category = {caseId: categoryId, name: String(row.categoryName), navList: []};
        byCategory.set(categoryId, category);
        order.push(categoryId);
      }
      const pocket = pocketOf(row.data);
      category.navList.push({
        bookNo: String(row.bookId),
        imageUrl: textOrNull(pocket.sourceImagePath),
        bookName: titleOf(row.data),
        chengShu: textOrNull(pocket.chengShu),
        author: textOrNull(pocket.author),
        caseTag: caseTagOf(pocket.case),
        // 旧后端 GenBookTabNav 把这两项注释掉了（恒 null/0），照抄
        desc: null,
        chapterCount: 0,
      });
    }
    return order.map((id) => byCategory.get(id) as AppNavCategory);
  });
}

/** 一本书的目录（published 篇章，按源章序号排序）。 */
export async function getAppBookChapters(
  db: D1Database,
  bookId: string,
): Promise<AppChapterEntry[]> {
  return withEmpty("getAppBookChapters", async () => {
    const {results} = await db
      .prepare(
        "SELECT id, data FROM items " +
          "WHERE tcm_kind = 'chapter' AND book_id = ? AND status = 1 " +
          "ORDER BY " + TCM_CHAPTER_ORDER_SQL,
      )
      .bind(bookId)
      .all();
    return (results ?? []).map((row) => {
      const pocket = pocketOf(row.data);
      return {
        bookId: bookId,
        chapterSection: toNumber(pocket.section),
        chapterHeader: titleOf(row.data),
        signatureId: String(row.id),
      };
    });
  });
}

/** 一个篇章的逐条条文（unlisted 条文对 App 可读；deleted 除外）。 */
export async function getAppChapterContent(
  db: D1Database,
  chapterId: string,
): Promise<AppChapterContent[]> {
  return withEmpty("getAppChapterContent", async () => {
    const chapterRow = await db
      .prepare(
        "SELECT data FROM items WHERE id = ? AND tcm_kind = 'chapter' AND status != 3",
      )
      .bind(chapterId)
      .first();
    if (!chapterRow) return [];
    const chapterPocket = pocketOf(chapterRow.data);
    const {results} = await db
      .prepare(
        "SELECT id, data FROM items " +
          "WHERE tcm_kind = 'section' AND tcm_parent_id = ? AND status != 3 " +
          "ORDER BY json_extract(data, '$._microfeed.receiptNo'), id",
      )
      .bind(chapterId)
      .all();
    const sections = (results ?? []).map((row) => {
      const pocket = pocketOf(row.data);
      const text = rawParagraphText(descriptionOf(row.data));
      return {
        id: String(row.id),
        text,
        note: textOrNull(pocket.note),
        sectionvideo: textOrNull(pocket.videoMemo),
        height: 0,
        // 旧后端 Signature = MD5(UTF8(text))，数据变动即改变 → 移动端据此判断条文过期。
        signature: md5(text),
        signatureId: String(row.id),
        fangList: strList(pocket.fangList),
      };
    });
    return [
      {
        section: toNumber(chapterPocket.section),
        header: titleOf(chapterRow.data),
        signatureId: chapterId,
        data: sections,
      },
    ];
  });
}

/** 旧后端按书 wire 档案：这些 BookNo 的 GetBookIdFang 数值字段为数字、方剂 id 走
 *  `id` 字段。
 *
 * ⚠️ 实测修正（2026-09-30 golden 抓包）：spec 初稿称 1001000 桂林古本走 `id`+数字数值，
 * 但 netcore 实际 wire 对 1001000 与 10001 完全一致——都是大写 `ID`（字符串占位）+ 字符串数值
 * （`yaoCount:"4"`、`height:"0"`、`drinkNum:"3"`）。故 1001000 不在此集合，所有书统一走
 * 非数值 wire（大写 `ID` + 字符串数值），与 netcore 逐字节对齐。集合保留为逐书开关。 */
const FANG_NUMERIC_WIRE_BOOKNOS = new Set<string>([]);

/** 一个频道（来源典籍）下的全部方剂，含组成明细。 */
export async function getAppBookFang(
  db: D1Database,
  bookId: string,
): Promise<AppFang[]> {
  return withEmpty("getAppBookFang", async () => {
    const bookRow = await db
      .prepare(
        "SELECT json_extract(data, '$._microfeed.bookNo') AS bn FROM channels WHERE id = ?",
      )
      .bind(bookId)
      .first();
    const numericWire = FANG_NUMERIC_WIRE_BOOKNOS.has(
      String(bookRow?.bn ?? ""),
    );
    const {results} = await db
      .prepare(
        // `json_extract(...)` 与迁移 0092 的表达式索引同形，过滤走索引。
        "SELECT id, data FROM items " +
          "WHERE tcm_kind = 'fang' AND status = 1 " +
          "AND json_extract(data, '$._microfeed.sourceBookId') = ? " +
          "ORDER BY json_extract(data, '$._microfeed.no'), id",
      )
      .bind(bookId)
      .all();
    return (results ?? []).map((row, index) => {
      const pocket = pocketOf(row.data);
      // 移动端 Fang.ID / Fang.signatureId 在 Gson 模型里是 int/long 类型，netcore 下发的是
      // 源端数值字符串（如 "0"/"1"/"2"）。此前下发 11 位 tcmId 字符串会触发
      // IntegerTypeAdapter 的 NumberFormatException。
      // ⚠️ netcore 的 `ID` 是 **0-based 序号**（首方为 "0"），必须与之一致；
      // 用 1-based 会让逐字段 golden 比对每条都差 1（2026-10-03 修正）。
      const numericId = String(index);
      return {
        yaoCount: numericWire
          ? toNumber(pocket.yaoCount)
          : numberToStrOrNull(pocket.yaoCount),
        height: numericWire ? 0 : "0",
        name: titleOf(row.data),
        // 字段名随书：netcore 对 1001000 走 `id`、对 10001 走 `ID`；值 = 源端数值（非 11 位 id）
        ...(numericWire ? {id: numericId} : {ID: numericId}),
        drinkNum: numericWire
          ? toNumber(pocket.drinkNum)
          : numberToStrOrNull(pocket.drinkNum),
        text: rawParagraphText(descriptionOf(row.data)),
        signature: md5(rawParagraphText(descriptionOf(row.data))),
        signatureId: numericId,
        fangList: strList(pocket.fangList),
        yaoList: strList(pocket.yaoList),
        standardYaoList: (Array.isArray(pocket.fangYaoList) ? pocket.fangYaoList : []).map(
          (entry, yIndex) => {
            const source = entry as Record<string, unknown>;
            const suffix = str(source.suffix);
            // 旧后端 weight 序列化为字符串；原样下发源值（null/undefined/空 → null），
            // 用 String() 而非 str()（str 只透传字符串，会把数值 300 变成 ""）。
            const weightRaw = source.weight;
            const weightStr = weightRaw === null || weightRaw === undefined ? "" : String(weightRaw);
            const weight = weightStr === "" ? null : weightStr;
            // 移动端 standardYaoList[].yaoID / signatureId 同为 int/long，必须数值化
            // （源端 YaoId 序号）；保持与 netcore 一致的数值字符串形态。
            const yaoNumeric = String(yIndex + 1);
            return {
              suffix: suffix === "" ? null : suffix,
              amount: str(source.amount),
              yaoID: yaoNumeric,
              weight,
              showName: str(source.showName),
              extraProcess: str(source.extraProcess),
              // 标准药行无独立 text 字段：旧后端存的是 FangBody.Signature（内容哈希），
              // 算法无法从 wire 反推；此处用其全部内容字段做确定性 MD5，作为移动端版本令牌。
              signature: md5(
                [
                  suffix === "" ? null : suffix,
                  str(source.amount),
                  typeof source.yaoId === "string" ? source.yaoId : null,
                  weight,
                  str(source.showName),
                  str(source.extraProcess),
                ]
                  .map((v) => (v === null ? "" : String(v)))
                  .join("|"),
              ),
              signatureId: yaoNumeric,
            };
          },
        ),
      };
    });
  });
}

/** 神农本草经疏书（book_id 固定，见 channel._microfeed）——netcore 429 味的正文来源。 */
const JINGSHU_BOOK_ID = "OsOP62cyp3j";

/**
 * 经疏书条目正文 → 纯文本，段间用 CRLF 连接。
 *
 * 与 `rawParagraphText` 的区别：经疏条目的 HTML 段分隔符不统一（首段 `</p><p>` 无换行、
 * 后续 `</p>\n<p>`），`rawParagraphText` 的「`</p>` 后必须跟换行」正则会整段失配、把
 * `</p><p>` 当正文吞进去。这里改为「逐个抓 `<p>…</p>` 块、用 CRLF 拼接」，对任意段分隔符
 * 都稳定，且与 netcore 逐字节实测一致（`$q{《神农本草经疏》}` 之后即为此形态）。
 */
function jingshuParagraphText(html: string): string {
  const source = String(html ?? "");
  const blocks: string[] = [];
  for (const m of source.matchAll(/<p>([\s\S]*?)<\/p>/g)) blocks.push(m[1] as string);
  if (blocks.length === 0) return source;
  return blocks.join("\r\n");
}

/**
 * 经疏书药条 → 正文 + 条目归属。
 *
 * 键为条目标题里逗号并列的**全部**名字（`灶心土,伏龙肝` 两条都建索引），因为 netcore 会把
 * 别名也拆成独立药味下发。`entry` 记录该名字所属条目的**首个药名**（主名），合并归属判定要用。
 */
interface JingshuEntry {
  text: string;
  entry: string;
}

async function jingshuYaoText(db: D1Database): Promise<Map<string, JingshuEntry>> {
  const map = new Map<string, JingshuEntry>();
  const {results} = await db
    .prepare(
      "SELECT data FROM items WHERE book_id = ? AND tcm_kind = 'section' AND status != 3",
    )
    .bind(JINGSHU_BOOK_ID)
    .all();
  for (const row of results ?? []) {
    const data = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : "";
    // 药条形如「14、铁锈」/「28、灶心土  ,伏龙肝」；排除 `$m{…}` 标记条目（方剂分类等非药条）。
    if (!/^\d+[、.\s]/.test(title) || /\$m\{/.test(title)) continue;
    const text = jingshuParagraphText(typeof data.description === "string" ? data.description : "");
    const names = title
      .replace(/^\d+[、.\s]*/, "")
      .split(/[,，]/)
      .map((n) => n.trim())
      .filter((n) => n !== "");
    const primary = names[0] ?? "";
    for (const name of names) {
      if (!map.has(name)) map.set(name, {text, entry: primary});
    }
  }
  return map;
}

/**
 * 异名表：172（本经+别录）与经疏书对同一味药的**不同写法**。
 * netcore 会把这种「写在正文、没进标题」的别名也认作同一味药，故合并查找需双向试。
 */
const JINGSHU_NAME_ALIAS: Record<string, string> = {
  神曲: "曲",
  鸡爪三棱: "草三棱根",
  葶苈子: "葶苈",
};

/**
 * 全部中药——复刻 netcore `GetAllZhongYao`：601 味 = 源 Yao 表 172 味（本经+别录）
 * + 从《神农本草经疏》提取的 429 味。
 *
 * 合并规则（netcore golden 逐条核对）：
 *  - 172 味：正文 = 本经+别录；若经疏书也有同名药，其正文以 `\r\n\r\n$q{《神农本草经疏》}`
 *    接在后面（同 App 端「相同药加换行合并显示」）。
 *  - 429 味：正文 = `$u{药名}\r\n$q{《神农本草经疏》}` + 经疏正文。
 *
 * **为什么 172 的合并是动态推导的**（新增 yao 无需改代码即可自动合并）：
 *  「某味 172 药该不该补经疏」由一条可推导的规则决定，而非硬编码名单——
 *   ① 该药名在经疏书里命中某个药条（`JINGSHU_NAME_ALIAS` 兜异名写法）；
 *   ② 且该药条**没有**被另一个 429 药认领。若被别的 429 认领（如 172「橘皮」与 429「陈皮」
 *      同属经疏「3、陈皮,橘皮」条），netcore 只把经疏正文发给 429 那个名字，172 侧不补。
 *  经实测该规则精确复现 golden 的 112 条合并，且天然覆盖「新增 yao 与 429 同名」的情形
 *  （该味yao 升为 172 条并吸收经疏，429 段跳过它，不丢内容）。
 *
 * **为什么 429 仍是静态锚点**：netcore 的 429 是一份**策展清单**（从经疏 904 条药里精选），
 * 已验证无法用章节/形态规则还原（部名章节规则得 609、宽松规则得 746，均不等于 601），
 * 故 `JINGSHU_ONLY_YAO_NAMES` 锁定「netcore 已确认的 429 名单」。**新增经疏药条**若要下发，
 * 需把药名加入该锚点（见 `.scratch/tcm-import/gen_429_anchor.mjs`），这是有意的边界。
 */
export async function getAppAllYao(db: D1Database): Promise<AppZhongYao[]> {
  return withEmpty("getAppAllYao", async () => {
    const [{results}, jingshu] = await Promise.all([
      db
        .prepare(
          "SELECT id, data FROM items WHERE tcm_kind = 'yao' AND status = 1 " +
            "ORDER BY json_extract(data, '$._microfeed.no'), id",
        )
        .all(),
      jingshuYaoText(db),
    ]);

    // 经疏药名 → 正文（含异名兜底）
    const jingText = (name: string): string | undefined => {
      const hit = jingshu.get(name) ?? jingshu.get(JINGSHU_NAME_ALIAS[name] ?? "");
      return hit?.text;
    };
    // 经疏药名 → 其所属条目的主名（含异名兜底）
    const jingEntry = (name: string): string | undefined => {
      const hit = jingshu.get(name) ?? jingshu.get(JINGSHU_NAME_ALIAS[name] ?? "");
      return hit?.entry;
    };
    // 429 名单认领的经疏条目主名 → 认领它的 429 药名。用于判定 172 侧该不该补：
    // 若某条目被「别的」429 药认领，netcore 只把经疏正文发给那个 429 名字，172 侧不重复补。
    const claimedBy429 = new Map<string, string>();
    for (const n of JINGSHU_ONLY_YAO_NAMES) {
      const e = jingEntry(n);
      if (e !== undefined && !claimedBy429.has(e)) claimedBy429.set(e, n);
    }

    const out: AppZhongYao[] = [];
    const yaoNames = new Set<string>();
    for (const row of results ?? []) {
      const name = yaoAppName(row.data);
      yaoNames.add(name);
      let text = rawParagraphText(descriptionOf(row.data));
      const entry = jingEntry(name);
      // 动态合并：经疏有同名条目、且该条目未被「另一个 429 药」认领 → 追加经疏正文。
      // claimer===undefined → 无人认领，照常合并；
      // claimer===name → 认领者就是自己（这味药同时在 429 名单里），照常合并，
      //   此时 429 段会因 yaoNames.has(name) 跳过它，经疏内容不丢；
      // claimer是别的 429 药 → 该条经疏正文归它，172 侧不补（对齐 netcore）。
      const claimer = entry !== undefined ? claimedBy429.get(entry) : undefined;
      if (entry !== undefined && (claimer === undefined || claimer === name)) {
        const extra = jingText(name);
        if (extra !== undefined && extra !== "") {
          text += "\r\n\r\n$q{《神农本草经疏》}" + extra;
        }
      }
      out.push({name, text});
    }
    for (const name of JINGSHU_ONLY_YAO_NAMES) {
      if (yaoNames.has(name)) continue;
      const extra = jingText(name);
      if (extra === undefined || extra === "") continue;
      out.push({name, text: "  $u{" + name + "}\r\n$q{《神农本草经疏》}    " + extra});
    }
    return out;
  });
}

/** 旧后端 GetAliaZhongYao 的切分符：中英文逗号/分号、空格、句号、顿号（ZhongYaoService._splitPattern）。 */
const ALIAS_SPLIT_PATTERN = /[,，；; 。.、]+/;

/**
 * 纯「导入派生」别名——照抄旧后端三源合并（重复别名后者覆盖前者，处理顺序一致）：
 * ① `yaoAlias` 表（中药口袋内嵌 `aliases[]`）→ {别名, 药名}；
 * ② 源 `Yao.YaoList`（口袋 `yaoNames` 原文）切分，每 token → 药名；
 * ③ 源 `BookBody.BieMing`（条文口袋 `bieMing`）切分，result[0]=正名，其余为别名。
 * 不含 ext_tcm_aliases（后台覆盖/隐藏由 getAppYaoAliases 单独合并）。
 */
export async function getDerivedYaoAliases(
  db: D1Database,
): Promise<Map<string, string>> {
  return withEmpty("getDerivedYaoAliases", async () => {
    const merged = new Map<string, string>();
    const add = (bieming: string, name: string) => {
      if (bieming !== "") merged.set(bieming, name);
    };
    const yaoRows = await db
      .prepare(
        "SELECT data FROM items WHERE tcm_kind = 'yao' AND status = 1 ORDER BY id",
      )
      .all();
    for (const row of yaoRows.results ?? []) {
      const pocket = pocketOf(row.data);
      for (const alias of Array.isArray(pocket.aliases) ? pocket.aliases : []) {
        const entry = alias as Record<string, unknown>;
        if (typeof entry.bieming === "string" && typeof entry.name === "string") {
          add(entry.bieming, entry.name);
        }
      }
      const name = yaoAppName(row.data);
      for (const token of str(pocket.yaoNames).split(ALIAS_SPLIT_PATTERN)) {
        add(token, name);
      }
    }
    // R4: 改用 `> ''`；`!= ''` 在 SQLite 里用不上 bieMing 表达式索引第二列，只剩
    // `tcm_kind=?` 前缀仍会全扫描；`> ''` 才是可用范围边界，命中 0093 的
    // items_bie_ming 索引（见迁移文件 EXPLAIN 说明）。
    const sectionRows = await db
      .prepare(
        "SELECT data FROM items WHERE tcm_kind = 'section' AND status != 3 " +
          "AND json_extract(data, '$._microfeed.bieMing') > ''",
      )
      .all();
    for (const row of sectionRows.results ?? []) {
      const parts = str(pocketOf(row.data).bieMing).split(ALIAS_SPLIT_PATTERN);
      if (parts.length > 1) {
        const canonical = parts[0] ?? "";
        for (let i = 1; i < parts.length; i++) add(parts[i] as string, canonical);
      }
    }
    return merged;
  });
}

/**
 * 药名别名对照——在纯派生（三源）之上最后合并 ext_tcm_aliases（后台 /admin/aliases/ 维护）：
 *   deleted=0 → 手工覆盖别名，覆盖同名派生别名；
 *   deleted=1 → 隐藏指令，把同名派生别名从端点结果中剔除。
 * 表可能尚未迁移（旧库）→ 查询失败静默跳过，不影响三源。
 */
export async function getAppYaoAliases(db: D1Database): Promise<AppYaoAlias[]> {
  return withEmpty("getAppYaoAliases", async () => {
    const merged = await getDerivedYaoAliases(db);
    try {
      const manual = await db
        .prepare(
          "SELECT bieming, name, deleted FROM ext_tcm_aliases ORDER BY bieming",
        )
        .all();
      for (const row of manual.results ?? []) {
        const bieming = str(row.bieming);
        if (Number(row.deleted) === 1) {
          // 隐藏指令：剔除同名派生别名（App 端点不再下发）。
          merged.delete(bieming);
        } else {
          // 手工覆盖：覆盖同名派生别名。
          merged.set(bieming, str(row.name));
        }
      }
    } catch {
      // ext_tcm_aliases 不存在（迁移未应用）——忽略。
    }
    return [...merged].map(([bieming, name]) => ({bieming, name}));
  });
}

/** 全部名词解释。 */
export async function getAppAllTerms(db: D1Database): Promise<AppMingCi[]> {
  return withEmpty("getAppAllTerms", async () => {
    const {results} = await db
      .prepare(
        "SELECT id, data FROM items WHERE tcm_kind = 'term' AND status = 1 " +
          "ORDER BY json_extract(data, '$._microfeed.no'), id",
      )
      .all();
    return (results ?? []).map((row, index) => {
      const pocket = pocketOf(row.data);
      const rawList = str(pocket.mingCiList);
      const image = str(pocket.sourceImagePath);
      // netcore 下发名词 `id` 为 1-based 序号的数值字符串（"1".."17"）。移动端
      // MingCi.Id 在模型里是 int 类型，Gson 的 IntegerTypeAdapter 只能解析数值字符串，
      // 11 位 microfeed id 会让其抛 NumberFormatException。这里改用列表下标（1-based）
      // 对齐 netcore；名词表项即按 `_microfeed.no` 排序，下标与 netcore 序号一致。
      const numericId = String(index + 1);
      return {
        id: numericId,
        mingCiList: rawList.trim() === "" ? [] : rawList.split(","),
        name: titleOf(row.data),
        imageUrl: image === "" ? null : image,
        text: rawParagraphText(descriptionOf(row.data)),
      };
    });
  });
}

/** 标记样式目录（App 的 TipsTextRenderConfig 数据源）。 */
export async function getAppStyleConfig(
  db: D1Database,
): Promise<Array<AppStyleItem>> {
  return withEmpty("getAppStyleConfig", async () => {
    const {results} = await db
      .prepare(
        "SELECT code, title, color, small_font, link_type FROM ext_annotation_markers " +
          "ORDER BY sort_order",
      )
      .all();
    return (results ?? []).map((row) => ({
      marker: String(row.code),
      color: String(row.color ?? "#808080"),
      isSmallFont: row.small_font === 1,
      linkType: Number(row.link_type ?? 0),
    }));
  });
}
