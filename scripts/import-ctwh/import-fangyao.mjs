// 方剂（fang_yao + fang_yao_body）导入工具 —— 把 ctwh/FangYao.sql（804 方）+
// ctwh/FangYaoBody.sql（2025 组成行）导入本地 D1。
//
// 设计要点（照 import-chapter-body.mjs 模式，ADR-0062 D7 / ADR-0065 决策 2）：
//   - 复用 parse.ts 的 iterInsertRows/mysqlUnescape：dump 里的 `\r` `\n` `\t` `\'`
//     全部还原成真实控制字符。**全格式保真**（ADR-0062 决策 6）——不 trim、不 strip、
//     不归一换行、不折叠空白。方文的前导缩进、句号后空格、真实换行都是内容。
//   - 写入走**参数化语句**（db.prepare(...).run(...)），不拼 SQL 字符串：文本原样进库、
//     不生成 SQL 文件、不触发 `git diff --check` 的尾随空白红线。
//   - **全量导入 804 + 2025 行**（P2）。严禁按 IsEnable 过滤——373 无组成方照导。
//   - 9 类 `$单字母{}` 标记（$u/$w/$f/$s/$m/$a/$q/$n/$g）原样存不解析。
//   - 关联：源 FangYaoBody.FangId 是源 FangYao.Id，经本地 `fang_yao.source_fang_legacy_id`
//     映射到新 id（0184 迁移带该列）。
//   - **P1 甲**：`fang_no` 组内连续（按 source_book_legacy_id 分桶、桶内按源 Id 升序赋
//     1..N），绝不复用源 FangNo（源组内重复 + 跨书重叠）。**不复用源 Id 作 body.position**
//     ——源 body Id 含 2 行 snowflake int64（>2^53，JS Number 会丢精度），改用「方内按
//     源文件出现顺序（= Id 升序）赋 rank 1..N」，顺序保真且满足 UNIQUE(fang_yao_id, position)。
//   - **P3 唯一例外（花括号配平）**：见 balanceFangText()。其余一律不改。
//
// 自检（任一不符 fail-fast，`--apply` 时中止）：
//   行数 804/2025 / 5 书源组计数 / signature 唯一 797 / 9 类标记计数 / FangText LF 790·
//   TAB 401·CR 0 / 悬空 fang_yao_id=0 / body 方内 position 重复=0 / amount 含 `$x{`=22 /
//   YaoID=-1=2 / 15 方配平修正后 0 不配平。
//
// 用法：
//   node --import tsx scripts/import-ctwh/import-fangyao.mjs [--apply] [--src ctwh]
//   --apply  实际写入本地 D1（默认只构建 + 自检，不写库）

import {readFileSync, readdirSync, writeFileSync, mkdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {iterInsertRows, rowValue} from "./parse.ts";

const INSTANCE = "ctwh-881019-xyz";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const EMIT_MIGRATION = args.includes("--emit-migration")
  ? args[args.indexOf("--emit-migration") + 1]
  : null;
const SRC = resolve(args.includes("--src") ? args[args.indexOf("--src") + 1] : "ctwh");
const OUT = resolve(
  args.includes("--out") ? args[args.indexOf("--out") + 1] : "ctwh-books/fang-yao/out",
);

/** 源数据基线（2026-11-05 审计实测，ADR-0065 数据审计节）。 */
const EXPECTED = {
  fangRows: 804,
  bodyRows: 2025,
  // 5 书源组（按源 BookId，显示名以 ctwh-books/books.json 为准）
  sourceGroups: {10001: 113, 10002: 202, 9040000: 111, 1001000: 329, 9050000: 49},
  signatureUnique: 797,
  // FangText 标记（9 类，原样存不解析）
  markers: {"$u{": 4053, "$w{": 3634, "$f{": 332, "$s{": 227, "$m{": 217, "$a{": 68, "$q{": 41, "$n{": 16, "$g{": 3},
  // FangText 格式保真（SQL 转义解码后核）
  lfFangText: 790,
  tabFangText: 401,
  crFangText: 0,
  // P3：15 方不配平（7 方 `{` 富余补 `}`；8 方 `}` 富余按根源修复）；导入后须 0
  unbalancedBefore: 15,
  unbalancedAfter: 0,
  // body
  amountWithMarker: 22,
  yaoIdNegativeOne: 2,
  // body IsEnable 与所属方 IsEnable 不一致（源数据本身如此，全量保真不修正）
  bodyEnableMismatch: 226,
  // FangdrinkNum 保真（VARCHAR）：1 行非整数小数（源 261 大半夏汤 "1.5"）、1 行 NULL（源 627）
  fangDrinkNumNonInt: 1,
  fangDrinkNumNull: 1,
  // 无组成方（P2 全量导入：源未结构化组成，导入后仅空态不解析）
  noComposition: 373,
};

/**
 * 花括号配平（P3 唯一例外，其余一律不改）。
 *
 * 15 方不配平，两类（2026-11-05 实测，用户裁定「按根源修复」）：
 *   - `{` 富余（7 方：355/537/655/661/669/776/782）：**逐标记在内容终点补 `}`**——
 *     这些方的富余 `{` 是真缺闭合（如 `$u{知母$w{六两}` 缺 `$u{知母}` 的 `}`），
 *     未闭合标记都位于药味/剂量列表中部而非文末，故在**紧邻下一个 `$<letter>{`
 *     之前**（该标记内容合理终点）补 `}`，绝不在文末补（会吞入整篇后续内容）。
 *   - `}` 富余（8 方）：分两小类，**按根源修复**：
 *       · 缺开型（591/634）：`$u半夏}`、`$u黄连}` 等——`$` 标记漏写 `{`，**补 `{`**
 *         （`$u半夏}` → `$u{半夏}`），恢复标记结构。
 *       · 多写型（481/517/615/675/704/797）：`$u{茵陈蒿}}$w{十分}`、行首孤 `}`、
 *         `$w{一升}}` 等——**删一个多余 `}`**，恢复闭合配对。
 *
 * 规则：`{` 与 `}` 计数不等且该方不在对应修复表内 → fail-fast（不静默改）。
 * 修复后必须配平（`{` 数 == `}` 数），否则 fail-fast。
 *
 * @param {string} text  已解码的源 FangText
 * @param {string} legacyId  源 FangYao.Id（用于精确匹配修复表 + 错误定位）
 * @returns {string} 配平后的文本（仅在上述 15 方有改动，其余逐字符不变）
 */
function balanceFangText(text, legacyId) {
  const open = (text.match(/\{/g) || []).length;
  const close = (text.match(/\}/g) || []).length;
  if (open === close) return text; // 已配平，原样
  // `{` 富余或 `}` 富余都只对已核实的 15 方做根源修复，其余 fail-fast
  const fixes = open > close ? FIX_OPEN_ROWS[legacyId] : FIX_ROWS[legacyId];
  if (!fixes) {
    throw new Error(
      `花括号不配平且无修复表：源 FangYao.Id=${legacyId} ` +
      `({=${open}, }=${close})。已核实的 7 方 \`{\` 富余为 ` +
      `[355,537,655,661,669,776,782]、8 方 \`}\` 富余为 ` +
      `[481,517,591,615,634,675,704,797]，其余出现即异常。`,
    );
  }
  let out = text;
  for (const [from, to] of fixes) {
    if (!out.includes(from)) {
      throw new Error(
        `修复表条目未命中源文本：Id=${legacyId} from=${JSON.stringify(from)}`,
      );
    }
    out = out.split(from).join(to);
  }
  const afterOpen = (out.match(/\{/g) || []).length;
  const afterClose = (out.match(/\}/g) || []).length;
  if (afterOpen !== afterClose) {
    throw new Error(`修复后仍不配平：Id=${legacyId} ({=${afterOpen}, }=${afterClose})`);
  }
  return out;
}

/**
 * 8 方 `}` 富余的精确子串修复表（按根源修复，用户裁定）。
 * 每项 [from, to]：把 from 替换为 to。缺开型补 `{`，多写型删 `}`。
 */
const FIX_ROWS = {
  481: [["$u{茵陈蒿}}$w{十分}", "$u{茵陈蒿}$w{十分}"]],
  517: [["}、$u{竹叶}", "、$u{竹叶}"]],
  591: [
    ["$u半夏}", "$u{半夏}"],
    ["$u甘草}", "$u{甘草}"],
    ["$u大枣}", "$u{大枣}"],
    ["$u粳米}", "$u{粳米}"],
  ],
  615: [
    ["$u{半夏} }$w{(洗)}", "$u{半夏} $w{(洗)}"],
    ["$u{甘草} }$w{(炙)}", "$u{甘草} $w{(炙)}"],
  ],
  634: [
    ["$u黄连}", "$u{黄连}"],
    ["$u厚朴}", "$u{厚朴}"],
    ["$u甘草}", "$u{甘草}"],
    ["$u半夏}", "$u{半夏}"],
    ["$u括蒌根}", "$u{括蒌根}"],
  ],
  675: [["$w{一升}}、", "$w{一升}、"]],
  704: [["}、$u{乌头}", "、$u{乌头}"]],
  797: [["$w{一升}}、", "$w{一升}、"]],
};

/**
 * 7 方 `{` 富余的精确子串修复表（按根源修复，用户裁定 + ADR「合理终点」口径）。
 * 每项 [from, to]：把 from 替换为 to（to = from 仅在未闭合 `$<字母>{` 的内容终点
 * ——紧邻下一个 `$<字母>{` 标记前——插入一个 `}`）。未闭合标记都在药味/剂量列表
 * 中部，**绝不在文末补**（会吞入整篇后续内容）。to 与 from 逐字节只差一个 `}`。
 */
const FIX_OPEN_ROWS = {
  355: [["$w{四两|  $u{人参}", "$w{四两|}  $u{人参}"]],
  537: [["$u{细辛$u{干姜}", "$u{细辛}$u{干姜}"]],
  655: [
    ["$u{百合$w{七枚}", "$u{百合}$w{七枚}"],
    ["$u{知母$w{三两}", "$u{知母}$w{三两}"],
  ],
  661: [
    ["$u{百合$w{一两 (炙)}", "$u{百合}$w{一两 (炙)}"],
    ["$u{滑石$w{二两}", "$u{滑石}$w{二两}"],
  ],
  669: [
    ["$u{知母$w{六两}", "$u{知母}$w{六两}"],
    ["$u{石膏$w{一斤}", "$u{石膏}$w{一斤}"],
    ["$u{甘草$w{二两(炙)}", "$u{甘草}$w{二两(炙)}"],
    ["$u{粳米$w{二合}", "$u{粳米}$w{二合}"],
    ["$u{桂枝$w{三两}", "$u{桂枝}$w{三两}"],
  ],
  776: [
    ["$u{百合$w{一两 (炙)}", "$u{百合}$w{一两 (炙)}"],
    ["$u{滑石$w{二两}", "$u{滑石}$w{二两}"],
  ],
  782: [
    ["$u{知母$w{六两}", "$u{知母}$w{六两}"],
    ["$u{石膏$w{一斤}", "$u{石膏}$w{一斤}"],
    ["$u{甘草$w{二两(炙)}", "$u{甘草}$w{二两(炙)}"],
    ["$u{粳米$w{二合}", "$u{粳米}$w{二合}"],
    ["$u{桂枝$w{三两}", "$u{桂枝}$w{三两}"],
  ],
};

/** 打开活跃的本地 D1（照 import-chapter-body.mjs 按 d1_migrations 记录数取活跃库）。 */
function localDbHandle() {
  const d1Dir = join(
    ".microfeed/instances",
    INSTANCE,
    "local-state",
    "v3/d1/miniflare-D1DatabaseObject",
  );
  const candidates = readdirSync(d1Dir).filter(
    (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
  );
  if (candidates.length === 0) throw new Error(`未找到本地 D1 sqlite：${d1Dir}`);

  let best = null;
  for (const file of candidates) {
    const handle = new DatabaseSync(join(d1Dir, file));
    let applied = -1;
    try {
      applied = handle.prepare("SELECT COUNT(*) AS c FROM d1_migrations").get().c;
    } catch {
      applied = -1;
    }
    if (!best || applied > best.applied) best = {applied, handle};
    else handle.close();
  }
  if (!best || best.applied < 0) throw new Error(`本地 D1 无迁移账本：${d1Dir}`);
  console.log("本地 D1：", best.applied, "条已应用迁移");
  return best.handle;
}

const asText = (v) => (v == null ? "" : String(v));

/** 文本字段原样返回；空串保持空串（不 trim）。 */
const rawText = (v) => (v == null ? null : String(v));

/** 可空文本：NULL 与空串 → NULL（仅用于 yao_list 的空串归一，不改非空值）。 */
const nullIfEmpty = (v) => {
  if (v == null) return null;
  const s = String(v);
  return s === "" ? null : s;
};

// ---- 1) 读源 ----
const fangRows = [...iterInsertRows(readFileSync(join(SRC, "FangYao.sql"), "utf8"))];
const bodyRows = [...iterInsertRows(readFileSync(join(SRC, "FangYaoBody.sql"), "utf8"))];

if (fangRows.length !== EXPECTED.fangRows) {
  throw new Error(`方剂行数应为 ${EXPECTED.fangRows}，实得 ${fangRows.length}`);
}
if (bodyRows.length !== EXPECTED.bodyRows) {
  throw new Error(`组成行数应为 ${EXPECTED.bodyRows}，实得 ${bodyRows.length}`);
}

// ---- 2) 本地 D1（--apply 用；build-only 也打开以做表存在校验） ----
let db = null;
try {
  db = localDbHandle();
} catch (error) {
  console.warn("无法打开本地 D1（build-only 仍可验源侧统计，--apply 会被拦下）：", error.message);
}

// ---- 3) 书源组显示名：唯一真源 ctwh-books/books.json（ADR-0065：10001/1001000/
// 9040000/9050000 仅 books.json 有；BookChapter.sql 对 3 组为空）----
// 缺失即 fail-fast——组显示名不能回退到 BookId 字符串（那会丢失书语义）。
const bookJson = JSON.parse(
  readFileSync(resolve(SRC, "..", "ctwh-books", "books.json"), "utf8"),
);
const bookNameById = new Map();
const books = bookJson.books ?? bookJson.list ?? [];
for (const item of books) {
  const id = String(item.bookNo ?? item.book_no ?? "");
  const name = asText(item.name).trim();
  if (id && name) bookNameById.set(id, name);
}
if (bookNameById.size === 0) {
  throw new Error(`ctwh-books/books.json 无任何书名（缺 bookNo/name 字段或文件结构不符）`);
}
console.log("书源组显示名（books.json）：", bookNameById.size, "条");

function sourceBookName(bookLegacyId) {
  const fromJson = bookNameById.get(bookLegacyId);
  if (!fromJson) {
    throw new Error(`书源组 ${bookLegacyId} 在 ctwh-books/books.json 无显示名（唯一书名真源，禁回退）`);
  }
  return fromJson;
}

// ---- 3) 逐行映射（fang_yao） ----
const records = [];
const stats = {
  markers: {"$u{": 0, "$w{": 0, "$f{": 0, "$s{": 0, "$m{": 0, "$a{": 0, "$q{": 0, "$n{": 0, "$g{": 0},
  lfFangText: 0,
  tabFangText: 0,
  crFangText: 0,
  unbalancedBefore: 0,
  unbalancedAfter: 0,
  groupCounts: {},
  signatures: new Set(),
  fangDrinkNumNonInt: 0,
  fangDrinkNumNull: 0,
  braceReport: [], // 逐方配平报告（ADR P3 规则4）
};
const usedIds = new Set();
const fangIdByLegacy = new Map(); // 源 FangYao.Id → 新 id（body 映射用）

// P1 甲：fang_no 组内连续——按 source_book_legacy_id 分桶，桶内按源 Id 升序赋 1..N。
// 源 FangYao.Id 已核实严格升序（1..809，desc=0），故遍历顺序即桶内 Id 升序。
const fangNoByBook = new Map(); // source_book_legacy_id → 当前组内最大 fang_no

for (const row of fangRows) {
  const legacyId = asText(rowValue(row, "Id"));
  const bookLegacyId = asText(rowValue(row, "FangSourceBookId"));
  const rawFangText = asText(rowValue(row, "FangText"));

  // 标记计数（配平前统计，配平只改 `{}` 不改 `$`标记 → 前后一致）
  for (const [marker, count] of Object.entries(stats.markers)) {
    const hits = rawFangText.split(marker).length - 1;
    if (hits > 0) stats.markers[marker] = count + hits;
  }

  // 格式保真统计（配平前，配平只加 `}`/补 `{`/删 `}`，不改 LF/CR/缩进 → 与源一致）
  if (rawFangText.includes("\n")) stats.lfFangText += 1;
  if (rawFangText.includes("\t")) stats.tabFangText += 1;
  if (rawFangText.includes("\r")) stats.crFangText += 1;

  const beforeOpen = (rawFangText.match(/\{/g) || []).length;
  const beforeClose = (rawFangText.match(/\}/g) || []).length;
  if (beforeOpen !== beforeClose) stats.unbalancedBefore += 1;

  const fangText = balanceFangText(rawFangText, legacyId);
  const afterOpen = (fangText.match(/\{/g) || []).length;
  const afterClose = (fangText.match(/\}/g) || []).length;
  if (afterOpen !== afterClose) stats.unbalancedAfter += 1;

  // 逐方配平报告（ADR P3 规则4：15 方逐行列出 源 {} 数 → 修正动作 → 结果 {} 数）
  if (beforeOpen !== beforeClose) {
    const fangName = asText(rowValue(row, "FangName"));
    stats.braceReport.push({
      id: legacyId,
      name: fangName,
      before: `${beforeOpen}/${beforeClose}`,
      action: beforeOpen > beforeClose ? `补 ${beforeOpen - beforeClose} 个 \`}\`` : `修 ${beforeClose - beforeOpen} 处`,
      after: `${afterOpen}/${afterClose}`,
    });
  }

  const sig = asText(rowValue(row, "Signature"));
  if (sig) stats.signatures.add(sig);

  if (!stats.groupCounts[bookLegacyId]) stats.groupCounts[bookLegacyId] = 0;
  stats.groupCounts[bookLegacyId] += 1;

  // fang_no 组内 rank（P1 甲）：桶内递增。源 Id 升序 → 组内顺序确定。
  const no = (fangNoByBook.get(bookLegacyId) ?? 0) + 1;
  fangNoByBook.set(bookLegacyId, no);

  // 确定性子 id（部署种子幂等关键）：`fy` + 源 Id 9 位补零 = 11 字符，VARCHAR(11)。
  // 源 FangYao.Id（1..809）唯一 → fang id 唯一；且与 `--emit-migration` 写死进
  // 0185 的 id 逐字节一致，故对已用 `--apply` 种过的库重放 0185 是纯幂等跳过。
  const id = "fy" + String(Number(legacyId)).padStart(9, "0");
  usedIds.add(id);
  fangIdByLegacy.set(legacyId, id);

  const createdAt = asText(rowValue(row, "CreateDate")).replace("T", " ").slice(0, 19);
  const fangDrinkNum = rawText(rowValue(row, "FangdrinkNum"));
  if (fangDrinkNum === null) stats.fangDrinkNumNull += 1;
  else if (fangDrinkNum !== "" && !/^\d+$/.test(fangDrinkNum)) stats.fangDrinkNumNonInt += 1;
  records.push({
    id,
    fangNo: no,
    fangName: asText(rowValue(row, "FangName")),
    sourceBookLegacyId: bookLegacyId,
    sourceBookName: sourceBookName(bookLegacyId),
    sourceFangLegacyId: legacyId,
    yaoList: nullIfEmpty(rowValue(row, "YaoList")),
    fangText,
    fangDrinkNum,
    isEnable: Number(rowValue(row, "IsEnable") ?? 1),
    signatureId: rawText(rowValue(row, "SignatureId")),
    signature: rawText(rowValue(row, "Signature")),
    createdAt: createdAt || new Date().toISOString().slice(0, 19).replace("T", " "),
  });
}

// ---- 4) body 逐行映射 ----
const bodyRecords = [];
const bodyStats = {
  amountWithMarker: 0,
  yaoIdNegativeOne: 0,
  orphanFang: 0,
  bodyEnableMismatch: 0,
  isEnableByFang: new Map(records.map((r) => [r.sourceFangLegacyId, r.isEnable])),
};
const usedBodyIds = new Set();
// body position：方内按源文件出现顺序（= Id 升序，已核实）赋 rank 1..N。
// 不复用源 body Id（含 2 行 snowflake int64 >2^53，JS Number 丢精度）。
const bodyPosByFang = new Map();
// 有组成行的方（无组成方 = P2 全量导入下的空态，源未结构化）
const fangWithBody = new Set();

for (const row of bodyRows) {
  const fangLegacyId = asText(rowValue(row, "FangId"));
  const newFangId = fangIdByLegacy.get(fangLegacyId);
  if (!newFangId) {
    bodyStats.orphanFang += 1;
    continue;
  }
  fangWithBody.add(fangLegacyId);

  const amount = asText(rowValue(row, "Amount"));
  if (amount.includes("$x{")) bodyStats.amountWithMarker += 1;

  const yaoLegacy = asText(rowValue(row, "YaoID"));
  if (yaoLegacy === "-1") bodyStats.yaoIdNegativeOne += 1;

  const bodyIsEnable = Number(rowValue(row, "IsEnable") ?? 1);
  const fangIsEnable = bodyStats.isEnableByFang.get(fangLegacyId);
  if (fangIsEnable !== undefined && fangIsEnable !== bodyIsEnable) {
    bodyStats.bodyEnableMismatch += 1;
  }

  const pos = (bodyPosByFang.get(fangLegacyId) ?? 0) + 1;
  bodyPosByFang.set(fangLegacyId, pos);

  // 确定性子 id：`fb` + 全局序号（非孤儿组成 1..2025）9 位补零 = 11 字符。
  // 与 `--emit-migration` 写死进 0185 的 id 一致 → 重放 0185 对已种库幂等跳过。
  const id = "fb" + String(bodyRecords.length + 1).padStart(9, "0");
  usedBodyIds.add(id);

  const createdAt = asText(rowValue(row, "CreateDate")).replace("T", " ").slice(0, 19);
  bodyRecords.push({
    id,
    fangYaoId: newFangId,
    position: pos,
    showName: rawText(rowValue(row, "ShowName")),
    amount: rawText(rowValue(row, "Amount")),
    extraProcess: rawText(rowValue(row, "ExtraProcess")),
    weight: rawText(rowValue(row, "Weight")),
    yaoLegacyId: rawText(rowValue(row, "YaoID")),
    isEnable: bodyIsEnable,
    signatureId: rawText(rowValue(row, "SignatureId")),
    signature: rawText(rowValue(row, "Signature")),
    createdAt: createdAt || new Date().toISOString().slice(0, 19).replace("T", " "),
  });
}

// ---- 5) 自检 ----
const failures = [];
const check = (label, actual, expected) => {
  if (expected === null) return;
  if (actual !== expected) failures.push(`${label}: 期望 ${expected}，实得 ${actual}`);
};

check("方剂行数", records.length, EXPECTED.fangRows);
check("组成行数", bodyRecords.length, EXPECTED.bodyRows);
check("组内无重复 fang_no", new Set(records.map((r) => `${r.sourceBookLegacyId}#${r.fangNo}`)).size, EXPECTED.fangRows);
for (const [group, expected] of Object.entries(EXPECTED.sourceGroups)) {
  check(`书源组 ${group}`, stats.groupCounts[group] ?? 0, expected);
}
check("书源组总数", Object.keys(stats.groupCounts).length, Object.keys(EXPECTED.sourceGroups).length);
check("signature 唯一", stats.signatures.size, EXPECTED.signatureUnique);
for (const [marker, expected] of Object.entries(EXPECTED.markers)) {
  check(`标记 ${marker}`, stats.markers[marker], expected);
}
check("LF fang_text 行数", stats.lfFangText, EXPECTED.lfFangText);
check("TAB fang_text 行数", stats.tabFangText, EXPECTED.tabFangText);
check("CR fang_text 行数", stats.crFangText, EXPECTED.crFangText);
check("配平前不配平方数", stats.unbalancedBefore, EXPECTED.unbalancedBefore);
check("配平后不配平方数", stats.unbalancedAfter, EXPECTED.unbalancedAfter);
check("amount 含 $x{", bodyStats.amountWithMarker, EXPECTED.amountWithMarker);
check("YaoID=-1 行数", bodyStats.yaoIdNegativeOne, EXPECTED.yaoIdNegativeOne);
check("悬空 fang_yao_id", bodyStats.orphanFang, 0);
check("body IsEnable 与所属方不一致", bodyStats.bodyEnableMismatch, EXPECTED.bodyEnableMismatch);
check("fang_drink_num 非整数", stats.fangDrinkNumNonInt, EXPECTED.fangDrinkNumNonInt);
check("fang_drink_num NULL", stats.fangDrinkNumNull, EXPECTED.fangDrinkNumNull);
check("无组成方", records.filter((r) => !fangWithBody.has(r.sourceFangLegacyId)).length, EXPECTED.noComposition);
check(
  "body 方内 position 重复",
  new Set(bodyRecords.map((r) => `${r.fangYaoId}#${r.position}`)).size,
  EXPECTED.bodyRows,
);

// 解析残留：mysqlUnescape 漏还原时剩这些字面量
check(
  "FangText 残留字面 \\'",
  records.filter((r) => r.fangText.includes("\\'")).length,
  0,
);
check(
  "FangText 残留字面 \\n / \\r / \\t",
  records.filter((r) => /\\[nrt]/.test(r.fangText)).length,
  0,
);

// 5 书源组显示名必须全部命中 books.json（唯一真源；sourceBookName() 缺失即抛，
// 此断言兜底「books.json 少一册但映射恰没抛」的边缘）。
check(
  "书源组名未命中 books.json",
  Object.keys(stats.groupCounts).filter((g) => !bookNameById.has(g)).length,
  0,
);

// ---- 6) 报告 ----
mkdirSync(OUT, {recursive: true});
const report = {
  mode: APPLY ? "build+apply" : "build-only",
  fangRows: records.length,
  bodyRows: bodyRecords.length,
  sourceGroups: stats.groupCounts,
  sourceGroupNames: Object.fromEntries(
    Object.keys(stats.groupCounts).map((g) => [g, sourceBookName(g)]),
  ),
  markers: stats.markers,
  signatureUnique: stats.signatures.size,
  braceFix: {
    before: stats.unbalancedBefore,
    after: stats.unbalancedAfter,
    fixedRows: stats.unbalancedBefore - stats.unbalancedAfter,
  },
  braceReport: stats.braceReport,
  body: {
    amountWithMarker: bodyStats.amountWithMarker,
    yaoIdNegativeOne: bodyStats.yaoIdNegativeOne,
    orphanFang: bodyStats.orphanFang,
    enableMismatch: bodyStats.bodyEnableMismatch,
  },
  failures,
};
writeFileSync(join(OUT, "summary.json"), JSON.stringify(report, null, 2) + "\n");

console.log("=== 方剂导入自检 ===");
console.log("方剂行数：", records.length, " 组成行数：", bodyRecords.length);
console.log("书源组：", JSON.stringify(stats.groupCounts));
console.log("标记：", JSON.stringify(stats.markers));
console.log("signature 唯一：", stats.signatures.size);
console.log("花括号配平：前", stats.unbalancedBefore, " 后", stats.unbalancedAfter,
  " 修正", stats.unbalancedBefore - stats.unbalancedAfter, "方");
for (const row of stats.braceReport) {
  console.log("  方", row.id, row.name || "(未命名)", ":", row.before, "→", row.action, "→", row.after);
}
console.log("组成：amount 含 $x{", bodyStats.amountWithMarker, " YaoID=-1", bodyStats.yaoIdNegativeOne,
  " 悬空", bodyStats.orphanFang, " IsEnable 不一致", bodyStats.bodyEnableMismatch);
console.log("格式：LF", stats.lfFangText, " TAB", stats.tabFangText, " CR", stats.crFangText);

if (failures.length) {
  console.error("自检 FAIL：");
  for (const failure of failures) console.error("  - " + failure);
  console.error("已中止（不写入）。报告：", join(OUT, "summary.json"));
  process.exit(1);
}
console.log("自检全部通过。报告：", join(OUT, "summary.json"));

// ---- 6.5) --emit-migration：生成部署种子迁移（deploy-anywhere 默认数据）----
// 用户裁定「当前模块数据设为默认数据，部署到其他位置也自带」（2026-11-05）。
// 约束两条（缺一不可）：
//   1. D1 单语句 100KB 上限 → 按累计字节 <80KB 分块（多行 VALUES，留 20KB 余量）。
//   2. `git diff --check` 红线只查物理行尾空白 → 文本里的 LF/TAB/CR 编码为
//      `@@NL@@`/`@@TB@@`/`@@CR@@` 哨兵，迁移文件保持单物理行，运行时用
//      `replace(..., '@@NL@@', char(10))` 还原——字节级保真且不触发行尾红线。
// 与 `--apply`（参数化逐行）同源：用同一份已解码、已配平的 records/bodyRecords，
// 所以库内内容与迁移文本必然一致。id 用本脚本生成的确定性 `fy`/`fb`+9 位补零写死进文件
// （取代早期随机 11 位，保证 0185 重放幂等），此后稳定；`INSERT OR IGNORE` 幂等
// （UNIQUE(source_fang_legacy_id) / 主键冲突跳过）。
const SENTINELS = ["@@NL@@", "@@TB@@", "@@CR@@"];

/** 单引号转义 + 控制字符编码为哨兵。返回 SQL 字面量（无引号，`'` 已 `''`）。
 *  前提：任何文本列都不得含哨兵原文（下方 verifyNoSentinel 先 fail-fast）。 */
function encodeLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value)
    .replace(/'/g, "''")
    .replace(/\n/g, "@@NL@@")
    .replace(/\t/g, "@@TB@@")
    .replace(/\r/g, "@@CR@@")}'`;
}

/** 文本列表达式：无控制字符 → 纯字面量；有 → 字面量外包三层 replace 运行时还原。 */
function textExpr(value) {
  if (value === null || value === undefined) return "NULL";
  const s = String(value);
  if (!/[\n\t\r]/.test(s)) return encodeLiteral(s);
  return `replace(replace(replace(${encodeLiteral(s)}, ` +
    `'@@NL@@', char(10)), '@@TB@@', char(9)), '@@CR@@', char(13))`;
}

function verifyNoSentinel(rows, pick) {
  for (const row of rows) {
    const value = pick(row);
    if (value != null && SENTINELS.some((sentinel) => String(value).includes(sentinel))) {
      throw new Error(
        `文本含哨兵 ${SENTINELS.find((s) => String(value).includes(s))}，请换哨兵：${String(value).slice(0, 40)}`,
      );
    }
  }
}

/** 按累计字节分块（单条 INSERT 语句 <80KB）。 */
function chunkByBytes(rows, toRowSql) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const sql = toRowSql(row);
    const rowBytes = Buffer.byteLength(sql, "utf8") + 8; // ", " 与 ")" 余量
    if (current.length > 0 && bytes + rowBytes > 80 * 1024) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(sql);
    bytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function fangRowSql(row) {
  return `(${[
    encodeLiteral(row.id),
    row.fangNo,
    textExpr(row.fangName),
    textExpr(row.sourceBookLegacyId),
    textExpr(row.sourceBookName),
    textExpr(row.sourceFangLegacyId),
    textExpr(row.yaoList),
    textExpr(row.fangText),
    textExpr(row.fangDrinkNum),
    row.isEnable ? 1 : 0,
    textExpr(row.signatureId),
    textExpr(row.signature),
    textExpr(row.createdAt),
    textExpr(row.createdAt),
  ].join(", ")})`;
}

function bodyRowSql(row) {
  return `(${[
    encodeLiteral(row.id),
    encodeLiteral(row.fangYaoId),
    row.position,
    textExpr(row.showName),
    textExpr(row.amount),
    textExpr(row.extraProcess),
    textExpr(row.weight),
    textExpr(row.yaoLegacyId),
    row.isEnable ? 1 : 0,
    textExpr(row.signatureId),
    textExpr(row.signature),
    textExpr(row.createdAt),
    textExpr(row.createdAt),
  ].join(", ")})`;
}

function emitMigrationSql() {
  verifyNoSentinel(records, (r) => [
    r.fangName, r.sourceBookLegacyId, r.sourceBookName, r.sourceFangLegacyId,
    r.yaoList, r.fangText, r.fangDrinkNum, r.signatureId, r.signature,
  ]);
  verifyNoSentinel(bodyRecords, (r) => [
    r.showName, r.amount, r.extraProcess, r.weight, r.yaoLegacyId,
    r.signatureId, r.signature,
  ]);

  const header = [
    "-- 方剂默认数据（deploy-anywhere 种子，ADR-0065）——由 import-fangyao.mjs 生成，",
    "-- 勿手改。部署到任何位置，fang_yao 与 fang_yao_body 都自带同一份数据",
    "-- （804 方 + 2025 组成，与源库逐字节一致）。",
    "--",
    "-- 生成约束：① D1 单语句 100KB 上限，按 <80KB 分块；② 文本 LF/TAB/CR 编码为",
    "-- @@NL@@/@@TB@@/@@CR@@ 哨兵，运行时 replace(..., char(10)) 还原，文件保持单物理行，",
    "-- 不触发 git diff --check 行尾红线；③ id 写死、INSERT OR IGNORE 幂等。",
    "--",
  ].join("\n");

  const lines = [header];
  const fangChunks = chunkByBytes(records, fangRowSql);
  for (const chunk of fangChunks) {
    lines.push(
      "INSERT OR IGNORE INTO fang_yao " +
      "(id, fang_no, fang_name, source_book_legacy_id, source_book_name, " +
      " source_fang_legacy_id, yao_list, fang_text, fang_drink_num, is_enable, " +
      " signature_id, signature, created_at, updated_at) VALUES\n" +
      chunk.join(",\n") + ";",
    );
  }
  const bodyChunks = chunkByBytes(bodyRecords, bodyRowSql);
  for (const chunk of bodyChunks) {
    lines.push(
      "INSERT OR IGNORE INTO fang_yao_body " +
      "(id, fang_yao_id, position, show_name, amount, extra_process, weight, " +
      " yao_legacy_id, is_enable, signature_id, signature, created_at, updated_at) VALUES\n" +
      chunk.join(",\n") + ";",
    );
  }
  return lines.join("\n") + "\n";
}

if (EMIT_MIGRATION) {
  const sql = emitMigrationSql();
  writeFileSync(EMIT_MIGRATION, sql);
  const statementCount = (sql.match(/INSERT OR IGNORE/g) || []).length;
  console.log(
    "部署种子迁移已生成：", EMIT_MIGRATION,
    "（", Buffer.byteLength(sql, "utf8"), "字节，", statementCount, " 条语句）",
  );
}

// ---- 7) 应用 ----
if (!APPLY) {
  console.log("build-only 完成（未写库）。加 --apply 写入本地 D1。");
  process.exit(0);
}
if (!db) {
  console.error("无法打开本地 D1，--apply 中止。");
  process.exit(2);
}

// --apply 前置闸：迁移 0184 未应用则中止（否则 fang_yao_id 写 NULL / 建表失败）
try {
  const tableCheck = db.prepare("SELECT COUNT(*) AS c FROM fang_yao").get();
  console.log("本地 fang_yao 现：", tableCheck.c, "行");
} catch (error) {
  console.error("本地无 fang_yao 表（请先应用迁移 0184），--apply 中止。", error.message);
  process.exit(2);
}

const insertFangSql =
  "INSERT OR REPLACE INTO fang_yao " +
  "(id, fang_no, fang_name, source_book_legacy_id, source_book_name, source_fang_legacy_id, " +
  " yao_list, fang_text, fang_drink_num, is_enable, signature_id, signature, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const insertBodySql =
  "INSERT OR REPLACE INTO fang_yao_body " +
  "(id, fang_yao_id, position, show_name, amount, extra_process, weight, yao_legacy_id, " +
  " is_enable, signature_id, signature, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

db.exec("BEGIN;");
try {
  // 全量重建语义：id 确定性（'fy'/'fb'+9 位补零），复跑先清空再 `INSERT OR REPLACE` 重建。
  // （0185 部署种子用 `INSERT OR IGNORE` 幂等，二者 id 同构、互不冲突。）
  for (const table of ["fang_yao_body", "fang_yao"]) {
    const existing = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    if (existing > 0) {
      db.exec(`DELETE FROM ${table}`);
      console.log(`清空既有 ${table}：`, existing);
    }
  }
  const fangStatement = db.prepare(insertFangSql);
  for (const record of records) {
    fangStatement.run(
      record.id,
      record.fangNo,
      record.fangName,
      record.sourceBookLegacyId,
      record.sourceBookName,
      record.sourceFangLegacyId,
      record.yaoList,
      record.fangText,
      record.fangDrinkNum,
      record.isEnable,
      record.signatureId,
      record.signature,
      record.createdAt,
      record.createdAt,
    );
  }
  const bodyStatement = db.prepare(insertBodySql);
  for (const record of bodyRecords) {
    bodyStatement.run(
      record.id,
      record.fangYaoId,
      record.position,
      record.showName,
      record.amount,
      record.extraProcess,
      record.weight,
      record.yaoLegacyId,
      record.isEnable,
      record.signatureId,
      record.signature,
      record.createdAt,
      record.createdAt,
    );
  }
  db.exec("COMMIT;");
} catch (error) {
  db.exec("ROLLBACK;");
  console.error("APPLY FAILED:", error.message);
  process.exit(2);
}

// ---- 8) 写入后逐行对账（唯一能证明没丢换行/空格/CR 的环节） ----
const fangCount = db.prepare("SELECT COUNT(*) AS c FROM fang_yao").get().c;
const bodyCount = db.prepare("SELECT COUNT(*) AS c FROM fang_yao_body").get().c;

const rereadFang = new Map();
for (const row of db
  .prepare("SELECT source_fang_legacy_id, fang_text, fang_no FROM fang_yao")
  .all()) {
  rereadFang.set(String(row.source_fang_legacy_id), row);
}
const rereadBody = new Map();
for (const row of db
  .prepare("SELECT fang_yao_id, position, amount FROM fang_yao_body")
  .all()) {
  rereadBody.set(`${row.fang_yao_id}#${row.position}`, row);
}

let missingFang = 0;
let fangTextDiff = 0;
let fangNoDiff = 0;
for (const record of records) {
  const got = rereadFang.get(record.sourceFangLegacyId);
  if (!got) {
    missingFang += 1;
    continue;
  }
  if (got.fang_text !== record.fangText) fangTextDiff += 1;
  if (Number(got.fang_no) !== record.fangNo) fangNoDiff += 1;
}

let missingBody = 0;
let bodyAmountDiff = 0;
for (const record of bodyRecords) {
  const got = rereadBody.get(`${record.fangYaoId}#${record.position}`);
  if (!got) {
    missingBody += 1;
    continue;
  }
  const gotAmount = got.amount ?? null;
  const wantAmount = record.amount ?? null;
  if (gotAmount !== wantAmount) bodyAmountDiff += 1;
}

console.log(
  "应用完成：fang_yao 现 =", fangCount,
  " fang_yao_body 现 =", bodyCount,
  " 方对账缺失", missingFang, " Text 不一致", fangTextDiff, " fang_no 不一致", fangNoDiff,
  " 组成对账缺失", missingBody, " Amount 不一致", bodyAmountDiff,
);

if (fangCount !== EXPECTED.fangRows) {
  console.error(`fang_yao 行数 ${fangCount} 不等于期望 ${EXPECTED.fangRows}，导入失败。`);
  process.exit(3);
}
if (bodyCount !== EXPECTED.bodyRows) {
  console.error(`fang_yao_body 行数 ${bodyCount} 不等于期望 ${EXPECTED.bodyRows}，导入失败。`);
  process.exit(3);
}
if (missingFang > 0 || fangTextDiff > 0 || fangNoDiff > 0) {
  console.error("fang_yao 库内内容与源不一致，导入失败。");
  process.exit(3);
}
if (missingBody > 0 || bodyAmountDiff > 0) {
  console.error("fang_yao_body 库内内容与源不一致，导入失败。");
  process.exit(3);
}
