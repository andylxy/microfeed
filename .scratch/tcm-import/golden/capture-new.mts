// 重新抓取 microfeed 侧（本地服务器）响应到 golden/new/*.json —— 全量导入后复跑对比用。
//
// 用法：MICROFEED_APP_TOKEN=<mflc_…> node --import tsx .scratch/tcm-import/golden/capture-new.mts
// 目标与产物目录可传参：--base <url>（默认本地 4321，可指向生产做线上比对）；
// --out-dir <name>（默认 new；对生产抓取用 new-prod 以免覆盖本地产物）。
//
// ⚠️ 8 个内容端点需登录凭证 `mflc_…`（移动端鉴权已落地，匿名不再放行）。
// 未设 MICROFEED_APP_TOKEN 时会在首个端点抛 401 并给出带凭证的复现命令。
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";

import {tcmId} from "../../../scripts/import-ctwh/build";
import {iterInsertRows, type DumpRow} from "../../../scripts/import-ctwh/parse";

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, "../../../ctwh");
const argOf = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const outSide = join(here, argOf("--out-dir") ?? "new");
const newBase = argOf("--base") ?? "http://localhost:4321";
const BOOK_NO = argOf("--book-no") ?? "10001";

function rowsOf(file: string): DumpRow[] {
  return [...iterInsertRows(readFileSync(join(sourceDir, file), "utf8"))];
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
const chapterId = tcmId("chapter", String(rowValue(bookRow, "BookInfoId") ?? ""));

console.log(`映射：channelId=${channelId} chapterId=${chapterId}`);

const targets: Array<{name: string; path: string}> = [
  {name: "GetNav", path: "GetNav"},
  {name: "GetBookChapter", path: `GetBookChapter?bookId=${channelId}`},
  {name: "GetChapterContent", path: `GetChapterContent?chapterId=${chapterId}`},
  {name: "GetBookIdFang", path: `GetBookIdFang?bookId=${channelId}`},
  {name: "GetAllZhongYao", path: "GetAllZhongYao"},
  {name: "GetAliaZhongYao", path: "GetAliaZhongYao"},
  {name: "GetAllMingCi", path: "GetAllMingCi"},
  {name: "GetTipsStyleConfig", path: "GetTipsStyleConfig?version=0"},
];

mkdirSync(outSide, {recursive: true});

// App 内容端点需登录凭证：Bearer `mflc_…` → 用户 → 角色 → 权限
// `app:mobile:access`，外加 `X-Timestamp` / `X-Nonce` 防重放头。
// 从环境变量 `MICROFEED_APP_TOKEN` 读取（不回显、不落日志）；未提供则匿名请求，
// 8 个内容端点会全部返回 401「Unauthorized」并在首个端点处抛错。
const appToken = process.env.MICROFEED_APP_TOKEN?.trim();

function newHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    app: "2",
    SessionId: randomUUID().replace(/-/g, ""),
  };
  if (appToken) {
    headers.Authorization = `Bearer ${appToken}`;
    headers["X-Timestamp"] = String(Date.now());
    headers["X-Nonce"] = randomUUID().replace(/-/g, "").toLowerCase();
  }
  return headers;
}

if (!appToken) {
  console.warn(
    "[new] 未提供 MICROFEED_APP_TOKEN —— 内容端点将返回 401。这是预期行为：" +
      "移动端鉴权已落地，匿名不再放行。",
  );
}

for (const t of targets) {
  const p = `/api/AppBookRequest/${t.path}`;
  const res = await fetch(`${newBase}${p}`, {
    headers: newHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  writeFileSync(join(outSide, `${t.name}.json`), text, "utf8");
  console.log(`[new] ${p} → ${res.status}（${text.length} 字节）`);
  if (res.status === 401 && !appToken) {
    throw new Error(
      `[new] ${p} 状态码 401：缺少 MICROFEED_APP_TOKEN。` +
        "带 mflc_ 凭证重试：MICROFEED_APP_TOKEN=<mflc_…> node --import tsx " +
        ".scratch/tcm-import/golden/capture-new.mts",
    );
  }
  if (res.status !== 200) throw new Error(`[new] ${p} 状态码 ${res.status}：${text.slice(0, 200)}`);
}
console.log("capture-new 完成，已覆盖 golden/new/*.json");
