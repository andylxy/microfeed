// 工单 15：golden 逐字段比对（旧 .NET 后端 ↔ 新端点）。
// 用法：node --import tsx .scratch/tcm-import/golden/compare.mts
// 输入：golden/old/*.json + golden/new/*.json（capture.mts 产物，两侧同为 {code,data,msg} 信封）
// 输出：控制台报告 + golden/report.json（逐条差异 + 分类判定）
//
// 差异分类（判定依据见 spec §6/§6.0/§15 与 golden-result 文档）：
//   OK                      完全一致
//   known-id                id 字段已按拍板换成 11 位新 id（需通过存在性校验与形状校验）
//   known-signature-removed  源签名字段（signature/signatureId，含方剂行内的）已整体移除
//   known-added             新增字段（spec 明确加的：如 data[].receiptNo）
//   known-null-to-empty     旧 null → 新 null/""（按旧形状已尽量对齐，残余在此类）
//   known-order             仅顺序不同（GetAliaZhongYao 三源合并插入序）
//   known-merge             bookId==10001 并上 10002 的旧合并特例（拍板取消，App 逐本请求）
//   known-adaptation        数据模型改造（GetAllZhongYao 旧按本草书重复 vs 新容器去重；GetNav 分类化）
//   known-data-drift        dump 与旧后端活动库的少量数据出入（如别名 341↔339）
//   MISMATCH                必须对齐的差异（比对失败）
import {existsSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));

const ID_FIELDS = new Set(["BookId", "bookId", "SignatureId", "signatureId", "Id", "id", "ID", "yaoID", "yaoId", "BookNo", "bookNo", "CaseId", "caseId"]);
const SIGNATURE_FIELDS = new Set(["signature", "Signature"]);
const KNOWN_ADDED_FIELDS = new Set(["receiptNo"]);
const OLD_ID_RE = /^-?\d+$/;
const NEW_ID_RE = /^.{11}$/;
const MERGE_ENDPOINTS = new Set(["GetBookChapter", "GetBookIdFang"]);
// 条文项/方剂行内的 signatureId 属签名机制（拍板整体移除）；章节级 signatureId 是定位键（保留）
const SIGNATURE_ID_REMOVED = new Set(["GetChapterContent", "GetBookIdFang"]);
let currentEndpoint = "";

// ---- 本地库 id 存在性校验集 ----
// 状态目录可传参：默认 local-state（manage dev 实际读取的库）；
// 旧值 .wrangler/state 是「双本地库」错位目录（参见项目记忆），2026-09-29 修正。
const stateDirArg = process.argv.includes("--state-dir")
  ? process.argv[process.argv.indexOf("--state-dir") + 1]
  : "local-state";
const instanceDir = join(
  here,
  `../../../.microfeed/instances/ctwh-881019-xyz/${stateDirArg}/v3/d1/miniflare-D1DatabaseObject`,
);
const dbFile = readdirSync(instanceDir).find(
  (f) => f.endsWith(".sqlite") && f !== "metadata.sqlite",
);
if (!dbFile) throw new Error(`未找到本地 D1 sqlite：${instanceDir}`);
const db = new DatabaseSync(join(instanceDir, dbFile));
const validIds = new Set<string>();
for (const row of db.prepare("SELECT id FROM items").all()) validIds.add(String(row.id));
for (const row of db.prepare("SELECT id FROM channels").all()) validIds.add(String(row.id));

type Verdict =
  | "OK"
  | "known-id"
  | "known-signature-removed"
  // 签名字段两侧都在，但源签名值（32 位十六进制 / 源数字）在新库无法复现
  // （源 int64 与源签名均不落库）→ 结构已对齐，仅值不同，属已知可接受
  | "known-signature-value"
  | "known-added"
  | "known-null-to-empty"
  | "known-order"
  | "known-merge"
  | "known-adaptation"
  | "known-data-drift"
  | "known-new-endpoint"
  | "MISMATCH";
interface Finding {
  path: string;
  verdict: Verdict;
  detail: string;
}
const findings: Finding[] = [];

// --lenient-ids：id 存在性校验跳过本地库（用于「new 侧=生产库」的比对——
// 存在性以生产库为准，本地单书库查不到会产生误报，2026-09-29）。
const LENIENT_IDS = process.argv.includes("--lenient-ids");

function isIdMapped(oldV: unknown, newV: unknown): boolean {
  if (typeof oldV !== "number" && typeof oldV !== "string") return false;
  if (typeof newV !== "string" || !NEW_ID_RE.test(newV)) return false;
  if (!OLD_ID_RE.test(String(oldV))) return false;
  if (LENIENT_IDS) return true;
  return validIds.has(newV);
}

function canonical(v: unknown): string {
  return JSON.stringify(v);
}

function diffObject(oldObj: Record<string, unknown>, newObj: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(oldObj)) {
    const p = `${path}.${key}`;
    if (!(key in newObj)) {
      if (SIGNATURE_FIELDS.has(key) || (key === "signatureId" && SIGNATURE_ID_REMOVED.has(currentEndpoint))) {
        findings.push({path: p, verdict: "known-signature-removed", detail: "签名字段已整体移除（含方剂/条文行内的 signatureId）"});
      } else {
        findings.push({path: p, verdict: "MISMATCH", detail: `旧有新无：${JSON.stringify(oldObj[key]).slice(0, 120)}`});
      }
      continue;
    }
    // 方剂行的 yaoList/fangList：成员相同仅顺序 → known-order；成员出入 → dump 与活动库数据出入
    if (
      currentEndpoint === "GetBookIdFang" && (key === "yaoList" || key === "fangList") &&
      Array.isArray(oldObj[key]) && Array.isArray(newObj[key])
    ) {
      const os = multisetOf(oldObj[key] as unknown[]);
      const ns = multisetOf(newObj[key] as unknown[]);
      const equal = [...os.keys()].every((k) => (ns.get(k) ?? 0) === (os.get(k) ?? 0)) &&
        [...ns.keys()].every((k) => (os.get(k) ?? 0) === (ns.get(k) ?? 0));
      findings.push({
        path: p,
        verdict: equal ? "known-order" : "known-data-drift",
        detail: equal ? "成员相同，仅顺序（旧按组成序）" : `dump 与活动库出入：旧=${JSON.stringify(oldObj[key]).slice(0, 80)} 新=${JSON.stringify(newObj[key]).slice(0, 80)}`,
      });
      continue;
    }
    // 签名字段：两侧都有但值不同 —— 源签名（32 位十六进制 / 源数字签名）在新库无法复现
    // （源 int64 与源签名都不落库）。本项目按拍板保留字段名、值用自身 11 位 id 或空串占位，
    // 故结构一致、值不同 → 归为已知可接受，不算 MISMATCH。
    if (
      SIGNATURE_FIELDS.has(key) ||
      (key === "signatureId" && SIGNATURE_ID_REMOVED.has(currentEndpoint))
    ) {
      findings.push({
        path: p,
        verdict:
          canonical(oldObj[key]) === canonical(newObj[key]) ? "OK" : "known-signature-value",
        detail: `签名字段（源签名值不可复现）：旧=${JSON.stringify(oldObj[key]).slice(0, 40)} 新=${JSON.stringify(newObj[key]).slice(0, 40)}`,
      });
      continue;
    }
    diffValue(oldObj[key], newObj[key], p);
  }
  for (const key of Object.keys(newObj)) {
    if (key in oldObj) continue;
    const p = `${path}.${key}`;
    if (KNOWN_ADDED_FIELDS.has(key)) {
      findings.push({path: p, verdict: "known-added", detail: `spec §6.0 明确新增：${JSON.stringify(newObj[key])}`});
    } else {
      findings.push({path: p, verdict: "MISMATCH", detail: `新有旧无：${JSON.stringify(newObj[key]).slice(0, 120)}`});
    }
  }
}

function multisetOf(arr: unknown[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of arr) m.set(canonical(v), (m.get(canonical(v)) ?? 0) + 1);
  return m;
}

function diffArray(oldArr: unknown[], newArr: unknown[], path: string): void {
  if (oldArr.length === newArr.length) {
    for (let i = 0; i < oldArr.length; i++) diffValue(oldArr[i], newArr[i], `${path}[${i}]`);
    return;
  }
  // 长度不同：先试多重集匹配（仅顺序差异）
  const oldSet = multisetOf(oldArr);
  const newSet = multisetOf(newArr);
  const sameMembers =
    [...newSet.keys()].every((k) => (oldSet.get(k) ?? 0) >= (newSet.get(k) ?? 0)) &&
    [...oldSet.keys()].every((k) => (newSet.get(k) ?? 0) >= (oldSet.get(k) ?? 0));
  if (sameMembers) {
    findings.push({path, verdict: "known-order", detail: `成员相同，仅顺序（旧 ${oldArr.length} / 新 ${newArr.length}）`});
    return;
  }
  // 顶层合并特例（仅 GetBookChapter/GetBookIdFang 的 $.data）：新数组是旧数组的前缀
  const allowMerge = path === "$.data" && MERGE_ENDPOINTS.has(currentEndpoint);
  if (!allowMerge) {
    findings.push({path, verdict: "MISMATCH", detail: `数组长度 旧 ${oldArr.length} / 新 ${newArr.length}`});
  }
  const n = Math.max(oldArr.length, newArr.length);
  let mergeCount = 0;
  for (let i = 0; i < n; i++) {
    const ov = oldArr[i];
    const nv = newArr[i];
    if (ov !== undefined && nv !== undefined) {
      diffValue(ov, nv, `${path}[${i}]`);
      continue;
    }
    if (nv === undefined && ov !== undefined) {
      mergeCount += 1;
      continue;
    }
    findings.push({path: `${path}[${i}]`, verdict: "MISMATCH", detail: "新多出的行"});
  }
  if (mergeCount > 0) {
    findings.push({
      path,
      verdict: allowMerge ? "known-merge" : "MISMATCH",
      detail: `旧多出 ${mergeCount} 行——bookId==10001 并上 10002 的合并特例（拍板取消，App 逐本请求）`,
    });
  }
}

function diffValue(oldV: unknown, newV: unknown, path: string): void {
  const lastSeg = path.split(/[.[\]]/).filter(Boolean).pop() ?? "";
  if (lastSeg === "yaoID" && String(oldV) === "0" && newV === null) {
    findings.push({path, verdict: "known-null-to-empty", detail: "源 YaoId=0 表示无对应中药，新端发 null"});
    return;
  }
  if (ID_FIELDS.has(lastSeg) && isIdMapped(oldV, newV)) {
    findings.push({path, verdict: "known-id", detail: `id 已换 11 位新 id（库中存在）旧=${oldV} 新=${newV}`});
    return;
  }
  if (oldV === null && (newV === null || newV === "")) {
    if (oldV !== newV) findings.push({path, verdict: "known-null-to-empty", detail: "空值表达差异（null ↔ \"\"）"});
    else findings.push({path, verdict: "OK", detail: ""});
    return;
  }
  if (Array.isArray(oldV) && Array.isArray(newV)) {
    diffArray(oldV, newV, path);
    return;
  }
  if (typeof oldV === "object" && oldV !== null && typeof newV === "object" && newV !== null) {
    diffObject(oldV as Record<string, unknown>, newV as Record<string, unknown>, path);
    return;
  }
  if (oldV === newV) {
    findings.push({path, verdict: "OK", detail: ""});
    return;
  }
  findings.push({path, verdict: "MISMATCH", detail: `旧=${JSON.stringify(oldV)?.slice(0, 120)} 新=${JSON.stringify(newV)?.slice(0, 120)}`});
}

// ---- 逐端点比对（含拍板改造的特殊比对） ----
const ENDPOINTS = [
  "GetNav",
  "GetBookChapter",
  "GetChapterContent",
  "GetBookIdFang",
  "GetAllZhongYao",
  "GetAliaZhongYao",
  "GetAllMingCi",
  "GetTipsStyleConfig",
];

interface EndpointReport {
  endpoint: string;
  counts: Record<string, number>;
  mismatches: Finding[];
}

// 「new」侧产物目录可传参：--new-dir new-prod（对生产抓取的比对），默认 new（本地）
const NEW_DIR = process.argv.includes("--new-dir")
  ? process.argv[process.argv.indexOf("--new-dir") + 1]
  : "new";

// 「old」侧产物目录同样可传参（分书存放的 netcore golden），默认 old
const OLD_DIR = process.argv.includes("--old-dir")
  ? process.argv[process.argv.indexOf("--old-dir") + 1]
  : "old";

function load(name: string, side: "old" | "new"): unknown {
  const dir = side === "new" ? NEW_DIR : OLD_DIR;
  return JSON.parse(readFileSync(join(here, dir, `${name}.json`), "utf8"));
}

function unwrap(v: unknown): unknown {
  // 信封 {code, data, msg} → data；两侧同形，取 data 后比对载荷
  if (typeof v === "object" && v !== null && "code" in v && "data" in v) {
    return (v as {data: unknown}).data;
  }
  return v;
}

function compareNav(oldV: unknown, newV: unknown): void {
  // GetNav 拍板改造：旧=父书分组（caseId 为 Case 码数字），新=分类（caseId 为 11 位 id）。
  // 分类交集内逐书比对字段（按 bookName 对齐）。
  const oldNav = oldV as Array<{name: string; navList: Array<Record<string, unknown>>}>;
  const newNav = newV as Array<{name: string; navList: Array<Record<string, unknown>>}>;
  findings.push({path: "$.data", verdict: "known-adaptation", detail: `GetNav 分类化改造（拍板）：旧 ${oldNav.length} 个父书 tab（caseId=Case 码）→ 新 ${newNav.length} 个分类（caseId=分类 id）`});
  const newBooks = new Map<string, Record<string, unknown>>();
  for (const c of newNav) for (const b of c.navList) newBooks.set(String(b.bookName), b);
  let compared = 0;
  for (const c of oldNav) {
    for (const b of c.navList) {
      const twin = newBooks.get(String(b.bookName));
      if (!twin) {
        findings.push({path: `$.data(${b.bookName})`, verdict: "known-adaptation", detail: "旧导航的书不在新分类导航中（分类覆盖差异）"});
        continue;
      }
      compared += 1;
      for (const key of ["author", "chengShu", "caseTag", "imageUrl", "desc", "chapterCount"] as const) {
        const ov = b[key] ?? null;
        const nv = twin[key] ?? null;
        if (JSON.stringify(ov) === JSON.stringify(nv)) {
          findings.push({path: `$.data[${b.bookName}].${key}`, verdict: "OK", detail: ""});
        } else {
          // dump 与旧后端活动库的少量数据出入（源 = 用户提供的 dump）
          findings.push({path: `$.data[${b.bookName}].${key}`, verdict: "known-data-drift", detail: `旧=${JSON.stringify(ov)} 新=${JSON.stringify(nv)}`});
        }
      }
    }
  }
  findings.push({path: "$.data", verdict: "known-adaptation", detail: `按 bookName 交集逐书比对 ${compared} 本`});
}

function compareYao(oldV: unknown, newV: unknown): void {
  // GetAllZhongYao 拍板改造：旧按本草书逐本拼接（同名药重复出现），新=容器频道去重。
  const oldYao = oldV as Array<{name: string; text: string}>;
  const newYao = newV as Array<{name: string; text: string}>;
  findings.push({path: "$.data", verdict: "known-adaptation", detail: `GetAllZhongYao 改造（拍板）：旧 ${oldYao.length} 行（本草书×药，含重复）→ 新 ${newYao.length} 行（容器去重）`});
  const oldByName = new Map<string, string[]>();
  for (const y of oldYao) {
    const list = oldByName.get(y.name) ?? [];
    list.push(y.text);
    oldByName.set(y.name, list);
  }
  let textOk = 0;
  let textVariant = 0;
  for (const y of newYao) {
    const variants = oldByName.get(y.name);
    if (!variants) {
      findings.push({path: `$.data[${y.name}]`, verdict: "MISMATCH", detail: "新中药在旧响应中不存在"});
      continue;
    }
    if (variants.includes(y.text)) textOk += 1;
    else textVariant += 1;
  }
  const missing = [...oldByName.keys()].filter((n) => !newYao.some((y) => y.name === n));
  findings.push({path: "$.data", verdict: "known-adaptation", detail: `交集比对：text 完全一致 ${textOk}、按书变体 ${textVariant}；旧独有药名 ${missing.length}${missing.length ? "：" + missing.slice(0, 5).join("、") : ""}`});
}

function compareAlia(oldV: unknown, newV: unknown): void {
  const oldSet = multisetOf(oldV);
  const newSet = multisetOf(newV);
  const onlyOld: string[] = [];
  const onlyNew: string[] = [];
  for (const [k, c] of oldSet) {
    const n = newSet.get(k) ?? 0;
    if (n < c) onlyOld.push(`${k}×${c - n}`);
  }
  for (const [k, c] of newSet) {
    const n = oldSet.get(k) ?? 0;
    if (n < c) onlyNew.push(`${k}×${c - n}`);
  }
  if (onlyOld.length === 0 && onlyNew.length === 0) {
    findings.push({path: "$.data", verdict: "OK", detail: "多重集完全一致"});
    return;
  }
  // 成员差异极小（dump 与活动库的少量出入）→ known-data-drift；超出阈值 → MISMATCH
  const total = onlyOld.length + onlyNew.length;
  if (total <= 10) {
    findings.push({path: "$.data", verdict: "known-data-drift", detail: `别名多重集差 ${total} 条：旧独有 ${onlyOld.join("、") || "无"}；新独有 ${onlyNew.join("、") || "无"}`});
  } else {
    findings.push({path: "$.data", verdict: "MISMATCH", detail: `别名多重集差异过大（${total} 条）：旧独有 ${onlyOld.slice(0, 5).join("、")}；新独有 ${onlyNew.slice(0, 5).join("、")}`});
  }
}

const report: EndpointReport[] = [];
for (const name of ENDPOINTS) {
  const oldPath = join(here, "old", `${name}.json`);
  if (!existsSync(oldPath)) {
    report.push({endpoint: name, counts: {"known-new-endpoint": 1}, mismatches: []});
    console.log(`${name}: ➕ 新增端点（旧后端无 golden）`);
    continue;
  }
  const oldPayload = unwrap(load(name, "old"));
  const newPayload = unwrap(load(name, "new"));
  findings.length = 0;
  currentEndpoint = name;
  if (name === "GetNav") compareNav(oldPayload, newPayload);
  else if (name === "GetAllZhongYao") compareYao(oldPayload, newPayload);
  else if (name === "GetAliaZhongYao") compareAlia(oldPayload, newPayload);
  else diffValue(oldPayload, newPayload, "$.data");
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
  report.push({
    endpoint: name,
    counts,
    mismatches: findings.filter((f) => f.verdict === "MISMATCH"),
  });
  const mism = counts["MISMATCH"] ?? 0;
  console.log(
    `${name}: ${mism === 0 ? "✅ 零硬差异" : `❌ ${mism} 处 MISMATCH`}（${JSON.stringify(counts)}）`,
  );
}

const reportName =
  OLD_DIR === "old" && NEW_DIR === "new"
    ? "report.json"
    : `report-${OLD_DIR}-${NEW_DIR}.json`;
writeFileSync(join(here, reportName), JSON.stringify(report, null, 2), "utf8");
const totalMismatch = report.reduce((n, r) => n + r.mismatches.length, 0);
console.log(
  totalMismatch === 0
    ? "全部端点零 MISMATCH——差异均为拍板/已知可接受类（详见 report.json）"
    : `${totalMismatch} 处必须对齐（详见 report.json 的 mismatches）`,
);
