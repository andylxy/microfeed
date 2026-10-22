import {env} from "cloudflare:workers";
import type {APIRoute} from "astro";

import {jsonResponse, localizedError} from "@/server/http";
import {requireRbac} from "@/server/rbac/guard";
import {ensureMarkerCitations} from "@/server/tcm/markerPopover";
import {STATUSES, PERMISSION_CODES} from "@/shared/Constants";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

/** 编辑器按篇章分组显示的一条引用条文。 */
interface CitingSection {
  id: string;
  status: number;
  title: string;
  chapterId: string;
  bookId: string;
  /** Sort key only, never serialised: the receiptNo rank of the old ORDER BY. */
  receiptRank: number;
}

/**
 * `GET ?name=<方剂名>&bookId=<书频道id>` — 返回引用了该方剂的条文。
 *
 * 条文通过两种来源引用方剂：`_microfeed.fangList`（方剂名 JSON 数组）或正文
 * 里的 `$f{方剂名}` 标记。每行另带所属篇章（`tcm_parent_id`），编辑器据此
 * 把反向链接按篇章分组，不再平铺一串条文号。
 *
 * `bookId` 把检索限定在一本书（方剂自身的 `_microfeed.sourceBookId`）：
 * 多本书存在同名方剂（桂枝汤在 4 本书共 110 条引用：70 / 32 / 6 / 2，
 * `probe-facts22.mjs`），每本书的编辑页面只列自己书的条文。
 *
 * 单书路径（编辑器默认场景）走 0111 的引用物化表 `ext_marker_citations` 点查，
 * 不再按 `tcm_kind` 索引读取整本 `items`：跨书旧查询每次请求要按
 * `items_bie_ming (tcm_kind=?)` 读取本地 8,066 个 section 行
 * （`.scratch/d1-scan-fix/probe-facts17.mjs` 计数），正文上的 LIKE 没有索引可用，
 * 按 `items` 平均 1,935 字节/行推得 ≈15.6 MB。修复后的读取字节数按本地 `dbstat`
 * （`.scratch/d1-scan-fix/probe-facts18.mjs`）
 * 的表行数与表字节数取数推得：
 * 物化表 1,818 行 / 147,456 字节（平均 81 字节/行），lookup 索引 90,112 字节；
 * 单个方剂最大命中 70 行（桂枝汤，书 `q6u5siNb2hT`，`probe-facts21.mjs` 的计划
 * `SEARCH ext_marker_citations USING INDEX ext_marker_citations_lookup
 * (book_id=? AND marker_code=? AND marker_name=?)`）→ 索引步进约 3.5 KB 加回表
 * 约 5.7 KB；合并回表 `items` 最多 70 行、篇章标题最多 50 行，按 items 平均
 * 1,935 字节/行约 135 KB 与 97 KB，整请求约 240 KB（KB 级数字均为按平均行字节取数推得）。
 * 物化表是读者口径（`status IN (1,4)`，与 popover 同一份），
 * 草稿（status 2）不在其中，所以另有一条本书范围的草稿扫描补齐——旧查询的
 * `status != 3` 是含草稿的，编辑器视图不能因此漏看自己正在写的条文。
 * `bookId` 必填：本地 804 个方剂行（`tcm_kind = 'fang'`）全部带
 * `_microfeed.sourceBookId`（`probe-facts7.mjs`），调用方缺少参数时直接返回 400；
 * 跨书 LIKE 的代价就是上面那条旧查询，每一本有方剂的书都要各发送一次。
 * 探针脚本在 `.scratch/d1-scan-fix/`（未纳入版本管理），逐项取证范围见
 * ADR-0043 的「验证」一节。
 *
 * 排序沿用旧的 `book_id, receiptNo, id`：物化行按 `section_seq` **全量**取出
 * （不设 LIMIT——要复刻旧语义的「前 50 条」必须知道全部候选的 receiptNo，只保留
 * rowid 序的前 50 条会漏掉后期改过编号的条文；物化行平均 81 字节/行，多取的
 * 代价可忽略），与草稿行合并后回表读取 receiptNo（整数，与 SQL 数值序同口径），
 * 重排并截取前 50 条。
 */
export const GET: APIRoute = async ({locals, request}) => {
  const guard = await requireRbac(
    locals,
    PERMISSION_CODES.CONTENT_CHAPTER_READ,
    request,
    env.FEED_DB,
  );
  if (guard) return guard;

  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  if (!name) {
    return localizedError(request, "errors.fang.referencesNameMissing", 400);
  }
  const bookId = (url.searchParams.get("bookId") ?? "").trim();
  if (!bookId) {
    return localizedError(request, "errors.fang.referencesBookMissing", 400);
  }

  const escaped = escapeLike(name);
  const likePattern = `%$f{${escaped}}%`;

  // 懒自举：脏了才重算，与 popover 共用同一机制，每个变更周期至多一次。
  // 编辑器是这张表的新读者——不 ensure 就直接查，刚写完的条文会漏。
  await ensureMarkerCitations(env.FEED_DB, bookId);

  // 物化点查：全量读取本书该方剂的引用（排序键 section_seq 只是输入顺序，
  // 最终顺序由合并函数按 receiptNo 定）。不设 LIMIT 的原因见文件头注释——
  // 旧查询的「前 50 条」是 receiptNo 序的全局前 50；按 rowid 序先截取 50 条会
  // 漏掉后期改过编号的条文。行数即 `total` 的物化一侧，不再另跑一条同谓词的
  // `SELECT count(*)`（那会在同一段索引范围上多步进一次）。
  const {results} = await env.FEED_DB
    .prepare(
      "SELECT section_id, section_title FROM ext_marker_citations " +
        "WHERE book_id = ? AND marker_code = 'f' AND marker_name = ? " +
        "ORDER BY section_seq",
    )
    .bind(bookId, name)
    .all<{section_id: string; section_title: string}>();
  const indexed = (results ?? []).map((row) => ({
    id: String(row.section_id),
    title: String(row.section_title),
  }));

  // 草稿补齐：本书范围内按 status=2 过滤。计划是
  // `SEARCH items USING INDEX items_book_kind (book_id=? AND tcm_kind=? AND status=?)`，
  // 只步进本书草稿行，命中的行再读取表数据来拼装标题；本地 status=2 的 section 为
  // 0 行。不带 ORDER BY / LIMIT——合并函数统一按 (book_id, receiptNo, id) 重排并截
  // 50 条，SQL 侧再排一次只是多余的 TEMP B-TREE（D1SCAN-002）。行数即 `total`
  // 的草稿一侧；旧查询的 total 是全量计数，编辑器底部「仅显示前 50 条」的提示
  // 靠它保持一致，所以计数不能带 LIMIT。
  const draftCondition =
    "book_id = ? AND tcm_kind = 'section' AND status = ? AND (" +
    "EXISTS (SELECT 1 FROM json_each(" +
    "json_extract(data, '$._microfeed.fangList')) WHERE json_each.value = ?) " +
    "OR data LIKE ? ESCAPE '\\')";
  const draftResult = await env.FEED_DB
    .prepare(
      "SELECT id, data FROM items " + `WHERE ${draftCondition}`,
    )
    .bind(bookId, STATUSES.UNPUBLISHED, name, likePattern)
    .all<{id: string; data: string}>();
  // book_id / tcm_parent_id 不在这里读取：合并函数回表时统一取得，避免两处口径。
  const drafts = (draftResult.results ?? []).map((row) => ({
    id: String(row.id),
    title: titleOf(row.data),
  }));

  const total = indexed.length + drafts.length;
  const citing = await mergeByReceiptNo(env.FEED_DB, indexed, drafts);

  // 篇章标题存在 data JSON 里（items 没有 title 列），对去重后的 id 集合做一次
  // IN 批量查询（≤50 个 parent）。
  const parentIds = [
    ...new Set(citing.map((row) => row.chapterId).filter(Boolean)),
  ].map(String);
  const chapterTitles = await lookupItemTitles(env.FEED_DB, parentIds);

  const items = citing.map((row) => ({
    id: row.id,
    status: row.status,
    title: row.title,
    chapterId: row.chapterId,
    chapterTitle: chapterTitles.get(row.chapterId) ?? "",
    bookId: row.bookId,
  }));
  return jsonResponse(
    {items, total},
    {headers: {"cache-control": "private, no-store"}},
  );
};

/** 条目 `data` 里的 `title`；JSON 解析不出来时返回空字符串。 */
function titleOf(data: string): string {
  try {
    const parsed = JSON.parse(data) as {title?: unknown};
    return typeof parsed.title === "string" ? parsed.title : "";
  } catch {
    // data is always valid JSON here; fall through to the id-only row.
    return "";
  }
}

/**
 * 把物化行（已发布 / 未列出）与草稿行合并成一张表，按旧扫描的排序键
 * `book_id, receiptNo, id` 排序并截取前 50 条。
 *
 * 引用物化表不存 receiptNo，候选 id 按主键回表读取一次 `items`，带上响应需要
 * 的列；排序在 JS 里对这组行执行，再截取前 50 条，等于旧查询的全局前 50。
 * 按 rowid 先截取 50 条会漏掉后期改过编号的条文。
 *
 * receiptNo 在每条 section 行里都是整数，按数值比较以复刻 SQLite 的 ORDER BY；
 * 缺失该值时位于最前，与 SQL NULL 在 ASC 中的位置一致。回表分片按 90 个 id：D1 单条
 * 语句的绑定参数上限是 100，预留余量，本地单个方剂最多 70 条（桂枝汤），更大的
 * 语料会超过 90 条。
 */
const ID_CHUNK = 90;

async function mergeByReceiptNo(
  db: typeof env.FEED_DB,
  indexed: Array<{id: string; title: string}>,
  drafts: Array<{id: string; title: string}>,
): Promise<CitingSection[]> {
  const ids = [...new Set([...indexed.map((r) => r.id), ...drafts.map((r) => r.id)])];
  if (ids.length === 0) return [];
  const byId = new Map<
    string,
    {
      status: number;
      book_id: string | null;
      tcm_parent_id: string | null;
      receipt_no: number | null;
    }
  >();
  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const {results} = await db
      .prepare(
        "SELECT id, status, book_id, tcm_parent_id, " +
          "json_extract(data, '$._microfeed.receiptNo') AS receipt_no " +
          `FROM items WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{
        id: string;
        status: number;
        book_id: string | null;
        tcm_parent_id: string | null;
        receipt_no: number | null;
      }>();
    for (const row of results ?? []) byId.set(String(row.id), row);
  }
  const titleOfId = new Map([
    ...indexed.map((r) => [r.id, r.title] as const),
    ...drafts.map((r) => [r.id, r.title] as const),
  ]);

  const receiptRank = (value: number | null): number =>
    typeof value === "number" && Number.isFinite(value) ? value : -1;

  const merged: CitingSection[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    merged.push({
      id,
      status: Number(row.status),
      title: titleOfId.get(id) ?? "",
      chapterId: row.tcm_parent_id ? String(row.tcm_parent_id) : "",
      bookId: row.book_id ? String(row.book_id) : "",
      receiptRank: receiptRank(row.receipt_no),
    });
  }
  merged.sort((a, b) => {
    if (a.bookId !== b.bookId) return a.bookId < b.bookId ? -1 : 1;
    if (a.receiptRank !== b.receiptRank) return a.receiptRank - b.receiptRank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged.slice(0, 50);
}

/** 批量读取 items 的 `data.title`（表没有 title 列，标题在 JSON 里）。 */
async function lookupItemTitles(
  db: typeof env.FEED_DB,
  ids: string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const placeholders = ids.map(() => "?").join(", ");
  const {results} = await db
    .prepare(
      "SELECT id, json_extract(data, '$.title') AS title FROM items " +
        `WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{id: string; title: string | null}>();
  for (const row of results ?? []) {
    if (row.title) titles.set(String(row.id), row.title);
  }
  return titles;
}
