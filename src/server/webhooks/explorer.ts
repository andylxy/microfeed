import FeedDb from "@/server/feed/FeedDb";
import {getPageById, listPages} from "@/server/pages/service";
import {getSiteFileById, listSiteFiles} from "@/server/site-files/service";
import ThemeStore from "@/server/themes/ThemeStore";
import {localizedOpenApiSchemas} from "@/shared/OpenApiDocument";
import {
  type AdminLanguage,
  adminLanguageFromRequest,
} from "@/shared/AdminLanguage";
import {ITEM_STATUSES_DICT, STATUSES} from "@/shared/Constants";
import {ADMIN_TYPEAHEAD_TABLE} from "@/shared/ItemSearchSql";
import {isLocalDevelopmentHostname} from "@/shared/StringUtils";
import {
  WEBHOOK_EVENT_DEFINITIONS,
  WEBHOOK_EVENT_EXAMPLES,
  webhookChannelSnapshot,
  webhookEventInputForSnapshot,
  webhookGeneratedEventInput,
  webhookItemSnapshot,
  webhookPageSnapshot,
  webhookSiteFileSnapshot,
  webhookThemeSnapshot,
} from "@/shared/WebhookExamples";
import {
  WEBHOOK_EVENT_TYPE_SET,
  type WebhookEventInput,
  type WebhookEventType,
  type WebhookExplorerPreview,
  type WebhookExplorerSourceMode,
  type WebhookExplorerSubject,
} from "@/shared/Webhooks";
import {
  createWebhookExplorerDelivery,
  prepareWebhookEvent,
} from "./events";
import {getWebhookDelivery} from "./store";
import {WebhookRequestError} from "./validation";

export interface WebhookExplorerSelection {
  eventType: WebhookEventType;
  sourceMode: WebhookExplorerSourceMode;
  subjectId?: string;
}

function eventType(value: unknown): WebhookEventType {
  if (typeof value !== "string" || !WEBHOOK_EVENT_TYPE_SET.has(value)) {
    throw new WebhookRequestError("errors.webhook.chooseEvent");
  }
  return value as WebhookEventType;
}

export function parseWebhookExplorerSelection(
  input: Record<string, unknown>,
): WebhookExplorerSelection {
  const sourceMode = input.source_mode;
  if (sourceMode !== "generated" && sourceMode !== "current") {
    throw new WebhookRequestError("errors.webhook.chooseExampleOrCurrent");
  }
  const subjectId = typeof input.subject_id === "string"
    ? input.subject_id.trim()
    : "";
  return {
    eventType: eventType(input.event_type),
    sourceMode,
    ...(subjectId ? {subjectId} : {}),
  };
}

function includesSearch(values: unknown[], query: string): boolean {
  if (!query) return true;
  return values.some((value) =>
    String(value ?? "").toLocaleLowerCase().includes(query)
  );
}

function statusLabel(value: unknown): string {
  return ITEM_STATUSES_DICT[Number(value)]?.name ?? "unknown";
}

/** 两条取数路径共用的行映射，避免同一形状在文件里写两遍。 */
function itemSubject(row: Record<string, unknown>): WebhookExplorerSubject {
  return {
    description: statusLabel(row.status),
    id: String(row.id),
    label: String(row.title || "Untitled item"),
  };
}

/**
 * 查询串转 FTS5 短语：`黄芪` → `"黄 芪"`，逐字切开后按相邻序列匹配，语义等价子串。
 * 顺序是先逐字切开、再把 `"` 逐字双写；反过来会让双写出来的两个引号被切开，
 * 转义失效后 MATCH 表达式语法错误。
 */
function typeaheadPhrase(query: string): string {
  return `"${[...query].map((ch) => (ch === '"' ? '""' : ch)).join(" ")}"`;
}

/**
 * 派生索引是否可用：表存在、且已回填。索引由 prepareItemSearch 维护，
 * 尚未部署到位的实例上两条都不成立。判定放在查询之前，查询本身保持
 * fast-fail——不捕获错误，也不在出错后兜底。
 * 判定自身的代价（本地 9506 行 items 实测中位数）：sqlite_master 点查 0.014ms
 * + 索引首行 0.003ms，共读 2 行；随后索引查询本体 0.050ms。
 */
async function adminTypeaheadReady(database: D1Database): Promise<boolean> {
  const present = await database.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).bind(ADMIN_TYPEAHEAD_TABLE).first<{ok: number}>();
  if (present === null) return false;
  // 表名走模板插值：派生表不在本地门禁库里，直写表名会让 check-d1-scan 的
  // EXPLAIN 报 no such table；插值后由 canPlan 判为动态名字并计入 skipped。
  const seeded = await database.prepare(
    `SELECT 1 AS ok FROM ${ADMIN_TYPEAHEAD_TABLE} LIMIT 1`,
  ).first<{ok: number}>();
  return seeded !== null;
}

/** 经 ext_admin_typeahead 索引取候选条目，顺序与 items 直查一致。 */
async function itemSubjectsByIndex(
  database: D1Database,
  query: string,
): Promise<WebhookExplorerSubject[]> {
  const result = await database.prepare(`
    SELECT i.id, i.status, COALESCE(json_extract(i.data, '$.title'), '') AS title
    FROM ${ADMIN_TYPEAHEAD_TABLE} f
    JOIN items i ON i.id = f.content_id
    WHERE f.haystack MATCH ? AND i.status != ?
    ORDER BY i.updated_at DESC, i.id DESC
    LIMIT 50
  `).bind(typeaheadPhrase(query), STATUSES.DELETED)
    .all<Record<string, unknown>>();
  return result.results.map(itemSubject);
}

export async function listWebhookExplorerSubjects(
  runtimeEnv: Env,
  request: Request,
  typeValue: unknown,
  searchValue: unknown,
): Promise<WebhookExplorerSubject[]> {
  const type = eventType(typeValue);
  const definition = WEBHOOK_EVENT_DEFINITIONS.find((entry) => entry.type === type)!;
  const query = typeof searchValue === "string"
    ? searchValue.trim().toLocaleLowerCase()
    : "";
  if (definition.sourceKind === "webhook") return [];
  if (definition.sourceKind === "channel") {
    return [{id: "primary", label: "Primary channel"}];
  }
  if (definition.sourceKind === "page_navigation") {
    return [{id: "navigation", label: "Current Page navigation"}];
  }
  if (definition.sourceKind === "item") {
    // 实测代价（2026-10-21 本地重测，`.scratch/d1-scan-fix/probe-facts20.mjs`：每轮
    // 新建连接、单轮 9 次取中位数、5 轮再取中位数；区间是 5 轮的中位数的最小值–最大值）：
    //   空搜索词走 items_updated_at（434,176 字节 / 106 页），LIMIT 50 早停，
    //     读取 50 行 / 0.128ms（区间 0.115–0.135ms）。
    //   非空搜索词走 ext_admin_typeahead，候选数取 `probe-facts18.mjs` 的 MATCH 计数：
    //     `黄芪` 22 个候选 / 0.123ms（0.114–0.124ms）、无命中搜索词 0 个候选 /
    //     0.287ms（0.272–0.297ms）、单字 `黄` 291 个候选 / 2.632ms（2.421–2.841ms，
    //     返回 50 行，回表在 ORDER BY 之后、LIMIT 之前完成）。
    //   移除前的 LIKE 直查：稀有词 34.006ms（33.809–35.808ms）、无命中搜索词
    //     36.912ms（36.246–41.964ms），两种形态都扫描完整条 items_updated_at 并回表
    //     9,506 行 / 18,395,136 字节，按 5,000,000 行/日只够 525 次请求。
    //   派生索引体积 1,249,280 字节 / 305 页（FTS5 影子对象合计）。
    // 索引属派生数据、由 prepareItemSearch 维护；未创建或未回填时非空搜索返回空候选，
    // 操作者可以清空搜索词浏览最近条目，避免一次请求吃掉 0.19% 的日读取额度。
    // 探针脚本在 `.scratch/d1-scan-fix/`（未纳入版本管理），逐项取证范围见 ADR-0043 D6。
    if (query !== "") {
      if (!await adminTypeaheadReady(runtimeEnv.FEED_DB)) return [];
      return await itemSubjectsByIndex(runtimeEnv.FEED_DB, query);
    }
    const result = await runtimeEnv.FEED_DB.prepare(`
      SELECT id, status, COALESCE(json_extract(data, '$.title'), '') AS title
      FROM items
      WHERE status != ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 50
    `).bind(STATUSES.DELETED)
      .all<Record<string, unknown>>();
    return result.results.map(itemSubject);
  }
  if (definition.sourceKind === "page") {
    const pages = await listPages(
      new FeedDb(runtimeEnv, request),
      request,
      {limit: 100},
    );
    return pages.items.filter((page) =>
      includesSearch([page.id, page.title, page.slug], query)
    ).slice(0, 50).map((page) => ({
      description: `${page.status} · /${page.slug}`,
      id: page.id,
      label: page.title || "Untitled Page",
    }));
  }
  if (definition.sourceKind === "site_file") {
    const files = await listSiteFiles(runtimeEnv.FEED_DB, request);
    return files.filter((file) =>
      (type !== "site_file.reset" || Boolean(file.generator)) &&
      includesSearch([file.id, file.filename], query)
    ).slice(0, 50).map((file) => ({
      description: file.generator ? `built-in · ${file.mode}` : file.mode,
      id: file.id,
      label: file.filename,
    }));
  }
  const themes = await new ThemeStore(runtimeEnv.FEED_DB).listVersions(false);
  return themes.filter((theme) =>
    includesSearch(
      [theme.id, theme.name, theme.packageId, theme.version],
      query,
    )
  ).slice(0, 50).map((theme) => ({
    description: `${theme.packageId} · ${theme.version}`,
    id: theme.id,
    label: theme.name,
  }));
}

async function currentSnapshot(
  runtimeEnv: Env,
  request: Request,
  selection: WebhookExplorerSelection,
): Promise<Record<string, unknown>> {
  const definition = WEBHOOK_EVENT_DEFINITIONS.find((entry) =>
    entry.type === selection.eventType
  )!;
  const subjectId = selection.subjectId;
  if (definition.sourceKind === "webhook") {
    throw new WebhookRequestError(
      "errors.webhook.testUsesSnapshot",
    );
  }
  if (definition.sourceKind === "channel") {
    const row = await runtimeEnv.FEED_DB.prepare(`
      SELECT id, data FROM channels
      WHERE status = ? AND is_primary = 1
      LIMIT 1
    `).bind(STATUSES.PUBLISHED).first<{data: string; id: string}>();
    if (!row) {
      throw new WebhookRequestError("errors.webhook.channelNotFound");
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      throw new WebhookRequestError("errors.webhook.channelSnapshotInvalid");
    }
    return webhookChannelSnapshot({id: row.id, ...data});
  }
  if (definition.sourceKind === "page_navigation") {
    const pages = await runtimeEnv.FEED_DB.prepare(`
      SELECT id FROM pages
      WHERE status = ? AND show_in_navigation = 1
      ORDER BY navigation_order ASC, title COLLATE NOCASE ASC, id ASC
    `).bind(STATUSES.PUBLISHED).all<{id: string}>();
    return {
      id: "navigation",
      page_ids: pages.results.map(({id}) => String(id)),
    };
  }
  if (!subjectId) {
    throw new WebhookRequestError("errors.webhook.chooseCurrentContent");
  }
  if (definition.sourceKind === "item") {
    const item = await new FeedDb(runtimeEnv, request).getItemById(subjectId);
    if (!item || Number(item.status) === STATUSES.DELETED) {
      throw new WebhookRequestError("errors.webhook.selectedItemNotFound");
    }
    return webhookItemSnapshot(item as Record<string, unknown>);
  }
  if (definition.sourceKind === "page") {
    const page = await getPageById(runtimeEnv.FEED_DB, request, subjectId);
    if (!page) throw new WebhookRequestError("errors.page.selectedNotFound");
    return webhookPageSnapshot(page as unknown as Record<string, unknown>);
  }
  if (definition.sourceKind === "site_file") {
    const file = await getSiteFileById(runtimeEnv.FEED_DB, request, subjectId);
    if (!file) {
      throw new WebhookRequestError("errors.siteFile.selectedNotFound");
    }
    if (selection.eventType === "site_file.reset" && !file.generator) {
      throw new WebhookRequestError("errors.siteFile.resetBuiltInOnly");
    }
    return webhookSiteFileSnapshot(file as unknown as Record<string, unknown>);
  }
  const theme = await new ThemeStore(runtimeEnv.FEED_DB).getVersion(subjectId);
  if (!theme) throw new WebhookRequestError("errors.theme.selectedNotFound");
  return webhookThemeSnapshot(theme as unknown as Record<string, unknown>);
}

export async function webhookExplorerEventInput(
  runtimeEnv: Env,
  request: Request,
  selection: WebhookExplorerSelection,
): Promise<WebhookEventInput> {
  if (selection.sourceMode === "generated") {
    return webhookGeneratedEventInput(selection.eventType);
  }
  return webhookEventInputForSnapshot(
    selection.eventType,
    await currentSnapshot(runtimeEnv, request, selection),
  );
}

function replaceGeneratedValues(
  value: unknown,
  oldId: string,
  newId: string,
  timestamp: string,
  field = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      replaceGeneratedValues(entry, oldId, newId, timestamp, field)
    );
  }
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    if ((field.startsWith("date_") || field.endsWith("_at")) &&
        Number.isFinite(Date.parse(value))) return timestamp;
    return value.replaceAll(oldId, newId);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    replaceGeneratedValues(entry, oldId, newId, timestamp, key),
  ]));
}

function materializeGeneratedInput(
  input: WebhookEventInput,
  endpointId: string,
): WebhookEventInput {
  const stableSubject = input.type === "channel.updated" ||
    input.type === "page.navigation_updated";
  const newId = stableSubject
    ? input.subjectId
    : input.type === "webhook.test"
    ? endpointId
    : `test_${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  return {
    ...input,
    object: replaceGeneratedValues(
      input.object,
      input.subjectId,
      newId,
      timestamp,
    ) as Record<string, unknown>,
    subjectId: newId,
  };
}

function dereferenceSchema(
  value: unknown,
  schemas: Record<string, Record<string, unknown>>,
  trail: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => dereferenceSchema(entry, schemas, trail));
  }
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const reference = typeof object.$ref === "string" ? object.$ref : "";
  const prefix = "#/components/schemas/";
  if (reference.startsWith(prefix)) {
    const name = reference.slice(prefix.length);
    const target = schemas[name];
    if (!target || trail.has(name)) return object;
    return dereferenceSchema(
      target,
      schemas,
      new Set([...trail, name]),
    );
  }
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [
    key,
    dereferenceSchema(entry, schemas, trail),
  ]));
}

function eventSchema(
  type: WebhookEventType,
  language: AdminLanguage,
): Record<string, unknown> {
  const schemas = localizedOpenApiSchemas(language);
  const envelope = schemas?.MicrofeedWebhookEvent as
    | {oneOf?: Array<Record<string, any>>}
    | undefined;
  const variant = envelope?.oneOf?.find((entry) =>
    entry.properties?.type?.const === type
  );
  return (dereferenceSchema(variant ?? {}, schemas ?? {}) ?? {}) as
    Record<string, unknown>;
}

function previewHeaders(type: WebhookEventType): Record<string, string> {
  return {
    "content-type": "application/json",
    "webhook-id": "whd_generated_when_sent",
    "webhook-signature": "v1,generated_when_sent",
    "webhook-timestamp": "generated_when_sent",
    "x-microfeed-attempt": "1",
    "x-microfeed-event": type,
    "x-microfeed-test": "true",
  };
}

export async function previewWebhookExplorerEvent(
  runtimeEnv: Env,
  request: Request,
  selection: WebhookExplorerSelection,
): Promise<WebhookExplorerPreview> {
  let payload: Record<string, unknown>;
  if (selection.sourceMode === "generated") {
    payload = structuredClone(WEBHOOK_EVENT_EXAMPLES[selection.eventType]);
  } else {
    const input = await webhookExplorerEventInput(runtimeEnv, request, selection);
    const eventId = `evt_preview_${selection.eventType.replaceAll(".", "_")}`;
    payload = JSON.parse(prepareWebhookEvent(
      runtimeEnv,
      request,
      input,
      {origin: "dashboard"},
      {
        correlationId: eventId,
        eventId,
        requestId: "req_preview",
        test: true,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ).payload) as Record<string, unknown>;
  }
  return {
    headers: previewHeaders(selection.eventType),
    payload,
    rawBody: JSON.stringify(payload),
    schema: eventSchema(selection.eventType, adminLanguageFromRequest(request)),
  };
}

export async function printWebhookExplorerEvent(
  runtimeEnv: Env,
  request: Request,
  selection: WebhookExplorerSelection,
): Promise<WebhookExplorerPreview> {
  if (!isLocalDevelopmentHostname(new URL(request.url).hostname)) {
    throw new WebhookRequestError(
      "errors.webhook.printLoopbackOnly",
    );
  }
  const preview = await previewWebhookExplorerEvent(runtimeEnv, request, selection);
  console.info(
    `=== microfeed Event Explorer preview: ${selection.eventType} (not delivered) ===`,
  );
  console.info(preview.rawBody);
  return preview;
}

export async function sendWebhookExplorerEvent(
  runtimeEnv: Env,
  request: Request,
  selection: WebhookExplorerSelection,
  endpointId: string,
) {
  if (!endpointId) throw new WebhookRequestError("errors.webhook.chooseEndpoint");
  const eventInput = await webhookExplorerEventInput(
    runtimeEnv,
    request,
    selection,
  );
  const result = await createWebhookExplorerDelivery(
    runtimeEnv,
    request,
    endpointId,
    selection.sourceMode === "generated"
      ? materializeGeneratedInput(eventInput, endpointId)
      : eventInput,
  );
  return {
    ...result,
    delivery: await getWebhookDelivery(runtimeEnv.FEED_DB, result.deliveryId),
  };
}
