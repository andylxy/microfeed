// 工单 15：从旧 .NET 后端与本地 dev 抓取 golden 响应（固定参数，两侧同源同章）。
// 用法：
//   node --import tsx .scratch/tcm-import/golden/capture.mts --old http://192.168.2.158:9991 --new http://localhost:4321
// 凭据：旧后端需要移动端登录（AccessKey HMAC 签名）。请手工创建
//   .scratch/tcm-import/golden/.credentials.json  内容：{"userName":"…","passWord":"…"}
// （凭据只从该文件读，不进命令行、不回显、不落日志。）
// 产物：golden/old/<name>.json 与 golden/new/<name>.json（原始响应文本原样保存）。
import {createHmac, randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

import {tcmId} from "../../../scripts/import-ctwh/build";
import {iterInsertRows, type DumpRow} from "../../../scripts/import-ctwh/parse";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const sourceDir = join(repoRoot, "ctwh");
const outDir = here;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const oldBase = argValue("--old") ?? "http://localhost:9991";
const newBase = argValue("--new") ?? "http://localhost:4321";
// 焦点书可传参：--book-no <WorkInfo.BookNo>（默认 10001 伤寒金匮・宋版）。
// 产物目录 --old-dir/--new-dir 可分书存放，避免覆盖既有 golden。
const BOOK_NO = argValue("--book-no") ?? "10001";
const oldOutDir = join(here, argValue("--old-dir") ?? "old");
const newOutDir = join(here, argValue("--new-dir") ?? "new");

// ---- 源 dump → 旧→新 id 映射（与 build.ts 同一套确定性推导 tcmId） ----
function rowsOf(file: string): DumpRow[] {
  const text = readFileSync(join(sourceDir, file), "utf8");
  return [...iterInsertRows(text)];
}
function rowValue(row: DumpRow, column: string): string | number | null {
  const i = row.columns.indexOf(column);
  return i === -1 ? null : (row.values[i] ?? null);
}

const workRow = rowsOf("WorkInfo.sql").find(
  (r) => r.table === "WorkInfo" && String(rowValue(r, "BookNo") ?? "") === BOOK_NO,
);
if (!workRow) throw new Error(`WorkInfo 中找不到 BookNo=${BOOK_NO}`);
const channelId = tcmId("work", String(rowValue(workRow, "ChapterId") ?? ""));

const bookRow = rowsOf("Book.sql").find(
  (r) => r.table === "Book" && String(rowValue(r, "BookId") ?? "") === BOOK_NO,
);
if (!bookRow) throw new Error(`Book 中找不到 BookId=${BOOK_NO}`);
const chapterSourceId = String(rowValue(bookRow, "BookInfoId") ?? "");
const chapterId = tcmId("chapter", chapterSourceId);
const chapterSection = String(rowValue(bookRow, "ChapterSection") ?? "");

console.log(`映射：channelId=${channelId} chapterId=${chapterId}（源章序号 ${chapterSection}）`);

// ---- 旧后端鉴权：App 内置默认设备密钥（SecurityConfig 硬编码，登录前即用）→ 每请求 HMAC-SHA256 五段签名 ----
// 签名原文 = {METHOD}\n{host:port}\n{path}\n{timestampMs}\n{nonce}，Base64(HMAC-SHA256(str, secret))。
// 若默认密钥被服务端禁用，可改走 login：手工创建 .credentials.json {"userName":"…","passWord":"…"}。
let accessKeyId = "3xl81vfcZMFoFWks14d1iMXzCNmOxyyX";
let accessKeySecret = "KZbbYBtUeMXbIimx";

function headersForOld(): Record<string, string> {
  return {
    app: "2",
    SessionId: randomUUID().replace(/-/g, ""),
    "Content-Type": "application/json;charset=UTF-8",
    Accept: "application/json, text/plain, */*",
  };
}

function signedHeaders(method: string, url: URL): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomUUID().replace(/-/g, "").toLowerCase();
  const path = url.pathname;
  const stringToSign = [method.toUpperCase(), url.host, path, timestamp, nonce].join("\n");
  const signature = createHmac("sha256", accessKeySecret).update(stringToSign, "utf8").digest("base64");
  return {
    ...headersForOld(),
    Signature: `Signature ${signature}`,
    "X-AccessKeyId": accessKeyId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
  };
}

async function oldLogin(): Promise<void> {
  // 默认设备密钥已内置（见上方常量）；仅当存在凭据文件时改走 login 换取用户级 AccessKey。
  const credPath = join(outDir, ".credentials.json");
  if (!existsSync(credPath)) {
    console.log("[old] 使用 App 内置默认设备密钥签名（未提供 .credentials.json，跳过 login）");
    return;
  }
  const cred = JSON.parse(readFileSync(credPath, "utf8")) as {userName: string; passWord: string};
  const res = await fetch(`${oldBase}/api/AppBookRequest/login`, {
    method: "POST",
    headers: headersForOld(),
    body: JSON.stringify({userName: cred.userName, passWord: cred.passWord}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`login 响应非 JSON（${res.status}）：${text.slice(0, 200)}`);
  }
  const login = parsed as {AccessKeyId?: string; AccessKeySecret?: string; Account?: string};
  if (!login.AccessKeyId || !login.AccessKeySecret) {
    throw new Error(`login 未返回 AccessKey（${res.status}）：${text.slice(0, 200)}`);
  }
  accessKeyId = login.AccessKeyId;
  accessKeySecret = login.AccessKeySecret;
  console.log(`[old] login 成功（Account=${login.Account ?? "?"}，AccessKey 已获取，不回显）`);
}

// ---- 抓取 ----
async function oldGet(pathAndQuery: string): Promise<{status: number; text: string}> {
  const url = new URL(`${oldBase}${pathAndQuery}`);
  const res = await fetch(url, {headers: signedHeaders("GET", url), signal: AbortSignal.timeout(30_000)});
  return {status: res.status, text: await res.text()};
}

async function newGet(pathAndQuery: string): Promise<{status: number; text: string}> {
  const res = await fetch(`${newBase}${pathAndQuery}`, {signal: AbortSignal.timeout(30_000)});
  return {status: res.status, text: await res.text()};
}

async function capture(
  side: "old" | "new",
  oldChapter: {section: string; signatureId: string} | undefined,
): Promise<void> {
  const targets: Array<{name: string; path: string}> = [
    {name: "GetNav", path: "GetNav"},
    {name: "GetBookChapter", path: `GetBookChapter?bookId=${side === "old" ? BOOK_NO : channelId}`},
  ];
  if (side === "old" && oldChapter) {
    targets.push({
      name: "GetChapterContent",
      path: `GetChapterContent?bookId=${BOOK_NO}&contentId=${oldChapter.section}&signatureId=${oldChapter.signatureId}`,
    });
  } else if (side === "new") {
    targets.push({name: "GetChapterContent", path: `GetChapterContent?chapterId=${chapterId}`});
  }
  targets.push(
    {name: "GetBookIdFang", path: `GetBookIdFang?bookId=${side === "old" ? BOOK_NO : channelId}`},
    {name: "GetAllZhongYao", path: "GetAllZhongYao"},
    {name: "GetAliaZhongYao", path: "GetAliaZhongYao"},
    {name: "GetAllMingCi", path: "GetAllMingCi"},
    {name: "GetTipsStyleConfig", path: "GetTipsStyleConfig?version=0"},
  );

  const outSide = side === "old" ? oldOutDir : newOutDir;
  mkdirSync(outSide, {recursive: true});
  for (const t of targets) {
    // 旧后端从未实现 GetTipsStyleConfig（App 端本地兜底），属新增端点——旧侧跳过
    if (side === "old" && t.name === "GetTipsStyleConfig") {
      console.log(`[old] ${t.path} —— 旧后端无此端点，跳过（新增端点，无 golden）`);
      continue;
    }
    const p = `/api/AppBookRequest/${t.path}`;
    let {status, text} = side === "old" ? await oldGet(p) : await newGet(p);
    // 旧后端 GetAliaZhongYao 有已知的竞态 bug（Parallel.ForEach + 字典重复键 → 500），重试 2 次
    let attempt = 0;
    while (status >= 500 && attempt < 2) {
      attempt += 1;
      await new Promise((r) => setTimeout(r, 1500));
      ({status, text} = side === "old" ? await oldGet(p) : await newGet(p));
    }
    writeFileSync(join(outSide, `${t.name}.json`), text, "utf8");
    console.log(`[${side}] ${t.path} → ${status}（${text.length} 字节）${attempt > 0 ? `（重试 ${attempt} 次后）` : ""}`);
    if (status !== 200) throw new Error(`[${side}] ${t.path} 状态码 ${status}：${text.slice(0, 200)}`);
  }
}

// ---- 主流程 ----
await oldLogin();

// 旧侧先抓 GetBookChapter，取目标章的 ChapterSection + SignatureId 供 GetChapterContent 链式定位
const oldChapterResp = await oldGet(`/api/AppBookRequest/GetBookChapter?bookId=${BOOK_NO}`);
if (oldChapterResp.status !== 200) {
  throw new Error(`旧后端不可达（${oldBase}）：状态码 ${oldChapterResp.status}：${oldChapterResp.text.slice(0, 200)}`);
}
const oldParsed = JSON.parse(oldChapterResp.text) as unknown;
// 旧后端响应带 HttpData 包装层 {code, data, ...}；内容在 data 里
const oldChapters = (
  typeof oldParsed === "object" && oldParsed !== null && Array.isArray((oldParsed as {data?: unknown}).data)
    ? (oldParsed as {data: unknown[]}).data
    : oldParsed
) as Array<{ChapterSection: number; chapterSection?: number; SignatureId?: number | string; signatureId?: number | string}>;
if (!Array.isArray(oldChapters) || oldChapters.length === 0) {
  throw new Error(`旧后端 GetBookChapter 无数据，原始响应：${oldChapterResp.text.slice(0, 300)}`);
}
const firstRow = oldChapters.find(
  (c) => String(c.ChapterSection ?? c.chapterSection) === chapterSection,
) ?? oldChapters[0]!;
const first = {
  section: String(firstRow.ChapterSection ?? firstRow.chapterSection),
  signatureId: String(firstRow.SignatureId ?? firstRow.signatureId),
};

await capture("old", first);
await capture("new", undefined);
console.log("golden 抓取完成：golden/old/*.json + golden/new/*.json");
