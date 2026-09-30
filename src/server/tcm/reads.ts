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
 * §9 防御性降级：读函数正常返回数组；D1 异常时降级为 [] 并留痕，
 * 避免 App 端因未知异常崩。未知 id 已在各函数内返回 []（不报 404）。
 */
async function withEmpty<T>(label: string, op: () => Promise<T[]>): Promise<T[]> {
  try {
    return await op();
  } catch (e) {
    console.error(`[tcm-reads] ${label} 读取失败，降级为 []:`, e);
    return [];
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
          "ORDER BY json_extract(data, '$._microfeed.section'), id",
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
        "SELECT id, data FROM items " +
          "WHERE tcm_kind = 'fang' AND status = 1 " +
          "AND json_extract(data, '$._microfeed.sourceBookId') = ? " +
          "ORDER BY json_extract(data, '$._microfeed.no'), id",
      )
      .bind(bookId)
      .all();
    return (results ?? []).map((row) => {
      const pocket = pocketOf(row.data);
      const fangItemId = String(row.id);
      return {
        yaoCount: numericWire
          ? toNumber(pocket.yaoCount)
          : numberToStrOrNull(pocket.yaoCount),
        height: numericWire ? 0 : "0",
        name: titleOf(row.data),
        // 字段名随书：netcore 对 1001000 走 `id`、对 10001 走 `ID`；值 = 11 位 id
        ...(numericWire ? {id: fangItemId} : {ID: fangItemId}),
        drinkNum: numericWire
          ? toNumber(pocket.drinkNum)
          : numberToStrOrNull(pocket.drinkNum),
        text: rawParagraphText(descriptionOf(row.data)),
        signature: md5(rawParagraphText(descriptionOf(row.data))),
        signatureId: String(row.id),
        fangList: strList(pocket.fangList),
        yaoList: strList(pocket.yaoList),
        standardYaoList: (Array.isArray(pocket.fangYaoList) ? pocket.fangYaoList : []).map(
          (entry) => {
            const source = entry as Record<string, unknown>;
            const suffix = str(source.suffix);
            // 旧后端 weight 序列化为字符串；原样下发源值（null/undefined/空 → null），
            // 用 String() 而非 str()（str 只透传字符串，会把数值 300 变成 ""）。
            const weightRaw = source.weight;
            const weightStr = weightRaw === null || weightRaw === undefined ? "" : String(weightRaw);
            const weight = weightStr === "" ? null : weightStr;
            return {
              suffix: suffix === "" ? null : suffix,
              amount: str(source.amount),
              yaoID: typeof source.yaoId === "string" ? source.yaoId : null,
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
              signatureId: typeof source.yaoId === "string" ? source.yaoId : "",
            };
          },
        ),
      };
    });
  });
}

/** 全部中药。 */
export async function getAppAllYao(db: D1Database): Promise<AppZhongYao[]> {
  return withEmpty("getAppAllYao", async () => {
    const {results} = await db
      .prepare(
        "SELECT id, data FROM items WHERE tcm_kind = 'yao' AND status = 1 " +
          "ORDER BY json_extract(data, '$._microfeed.no'), id",
      )
      .all();
    return (results ?? []).map((row) => {
      const text = rawParagraphText(descriptionOf(row.data));
      return {
        name: yaoAppName(row.data),
        text,
      };
    });
  });
}

/** 旧后端 GetAliaZhongYao 的切分符：中英文逗号/分号、空格、句号、顿号（ZhongYaoService._splitPattern）。 */
const ALIAS_SPLIT_PATTERN = /[,，；; 。.、]+/;

/**
 * 药名别名对照——照抄旧后端三源合并（重复别名后者覆盖前者，处理顺序一致）：
 * ① `yaoAlias` 表（中药口袋内嵌 `aliases[]`）→ {别名, 药名}；
 * ② 源 `Yao.YaoList`（口袋 `yaoNames` 原文）切分，每 token → 药名；
 * ③ 源 `BookBody.BieMing`（条文口袋 `bieMing`）切分，result[0]=正名，其余为别名。
 */
export async function getAppYaoAliases(db: D1Database): Promise<AppYaoAlias[]> {
  return withEmpty("getAppYaoAliases", async () => {
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
    const sectionRows = await db
      .prepare(
        "SELECT data FROM items WHERE tcm_kind = 'section' AND status != 3 " +
          "AND json_extract(data, '$._microfeed.bieMing') != ''",
      )
      .all();
    for (const row of sectionRows.results ?? []) {
      const parts = str(pocketOf(row.data).bieMing).split(ALIAS_SPLIT_PATTERN);
      if (parts.length > 1) {
        const canonical = parts[0] ?? "";
        for (let i = 1; i < parts.length; i++) add(parts[i] as string, canonical);
      }
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
    return (results ?? []).map((row) => {
      const pocket = pocketOf(row.data);
      const rawList = str(pocket.mingCiList);
      const image = str(pocket.sourceImagePath);
      return {
        id: String(row.id),
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
