/**
 * 前台站点外壳配置的唯一出口（ADR-0066 决策 14，规范 §3.4「P1 裁决：③」）。
 *
 * 只点查 `settings` 的两行与 `pages` 表；站名/图标/描述/语言/版权/出版方
 * 全部来自 0189 迁移写进 `webGlobalSettings` 的键，不读主频道、不经 loadFeed。
 */
import {
  htmlToPlainText,
  resolvePublicBucketUrl,
  urlJoinWithRelative,
} from "@/shared/StringUtils";
import {resolveBuiltInTemplateVariables} from "@/shared/TemplateVariables";
import {navigationPages} from "@/server/pages/service";

export type FrontAccessPolicy = "public" | "headless" | "offline";

export interface FrontSite {
  title: string;
  /** 已按 publicBucketUrl 拼好的完整图标 URL；空串表示不输出 link */
  faviconUrl: string;
  language: string;
  description: string;
  copyright: string;
  publisher: string;
  navPages: Array<{url: string; label: string}>;
  accessPolicy: FrontAccessPolicy;
}

/** 与 fast-fail 一致：坏 JSON 就地抛出，不静默当成空配置。 */
function parseRow(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  const parsed = JSON.parse(String(value)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("settings 行的 data 不是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

export async function loadFrontSite(
  db: D1Database,
  request: Request,
): Promise<FrontSite> {
  const url = new URL(request.url);
  const {results} = await db
    .prepare(
      "SELECT category, data FROM settings " +
        "WHERE category IN ('webGlobalSettings', 'access')",
    )
    .all<{category: string; data: string | null}>();
  let web: Record<string, unknown> = {};
  let access: Record<string, unknown> = {};
  for (const row of results ?? []) {
    if (row.category === "webGlobalSettings") web = parseRow(row.data);
    else if (row.category === "access") access = parseRow(row.data);
  }

  const favicon = parseRow(web.favicon);
  const faviconPath = text(favicon.url);
  const faviconUrl = faviconPath
    ? String(
        urlJoinWithRelative(
          resolvePublicBucketUrl(web.publicBucketUrl, url.hostname),
          faviconPath,
          url.origin,
        ) ?? "",
      )
    : "";

  const pages = await navigationPages(db, request);
  const navPages = pages.map((page) => ({
    url: String(page.url ?? ""),
    label: String(page.navigation_label ?? page.title ?? ""),
  }));

  const policy = text(access.currentPolicy);
  // 站名与 lang 是展示缺省值；缺行时 settings 不返回记录，这里只补空字段。
  return {
    title: text(web.siteTitle) || "microfeed",
    faviconUrl,
    language: text(web.language) || "zh-CN",
    description: htmlToPlainText(text(web.description)),
    copyright: resolveBuiltInTemplateVariables(text(web.copyright)),
    publisher: text(web.publisher),
    navPages,
    accessPolicy:
      policy === "headless" || policy === "offline" ? policy : "public",
  };
}

/** 与旧 hidePublicWeb 同义：headless / offline 的站点前台一律 404。 */
export function shouldHideFrontSite(site: FrontSite): boolean {
  return site.accessPolicy !== "public";
}
