import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {listPcInterfaces} from "@/server/admin/pc-interfaces";
import {DEFAULT_ADMIN_PATH} from "@/shared/AdminPath";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * PC 接口清单的防漂移红线（migration 0131）。
 *
 * 清单是展示用的静态目录，权威在路由文件里。这里逐行核对：
 *   - 路径能解析到一个真实存在的路由文件；
 *   - 路由文件（或它两跳内的本地导入模块）确实引用该行的每个门码；
 *   - 路由文件（或被再导出的模块）确实导出该行的 HTTP 方法。
 * 路由改门码、改方法或删文件而忘记同步目录时，这里先红。
 *
 * 「两跳」覆盖三种真实形态：薄壳再导出（rbac 域）、经工厂函数委托
 * （devices / webhooks 的 route builder）、守卫常量在被导入模块里。
 * 第二跳是给 `requireAudienceGuard` 这类按端分派守卫留的——常量在
 * `guard.ts`，离路由文件隔一层。
 */

const ROOT = join("src");
const AJAX = join(ROOT, "pages", "[adminPath]", "ajax");
/** 导入扫描上限：防一条 import 链把半个 src 拖进来。 */
const MAX_SOURCES = 60;

/** code → Constants.ts 里的常量名（如 `content:book:read` → `CONTENT_BOOK_READ`）。 */
const CONSTANT_BY_CODE = new Map(
  Object.entries(PERMISSION_CODES).map(([name, code]) => [code as string, name]),
);

/** `/admin/ajax/books/[bookId]` → 路由文件路径（Astro 文件路由命名）。 */
function routeFileFor(path: string): string {
  const rest = path.replace(new RegExp(`^/${DEFAULT_ADMIN_PATH}/ajax/`, "u"), "");
  const segments = rest.split("/");
  const base = join(AJAX, ...segments);
  // `[param]` 段与普通段一样：可能是文件（`feed.ts`）也可能是目录（
  // `site-files/[siteFileId]/index.ts`）。文件优先，目录兜底。
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  return join(base, "index.ts");
}

/** `@/x/y` → `src/x/y`；非本地模块（cloudflare:workers 等）返回 null。 */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  return join(ROOT, specifier.slice(2));
}

/** 一个文件里的本地导入与再导出目标（已解析为路径，存在的才收）。 */
function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const targets: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
    const resolved = resolveAlias(match[1] ?? "");
    if (!resolved) continue;
    for (const candidate of [`${resolved}.ts`, join(resolved, "index.ts")]) {
      if (existsSync(candidate)) {
        targets.push(candidate);
        break;
      }
    }
  }
  return targets;
}

/**
 * 从路由文件出发、最多两跳的本地模块集合（含路由文件自身，去重封顶）。
 * 守卫常量、方法导出都在这个集合里找。
 */
function sourceBundle(routePath: string): string[] {
  const seen = new Set<string>([routePath]);
  let frontier = [routePath];
  for (let hop = 0; hop < 2 && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const target of localImports(file)) {
        if (seen.size >= MAX_SOURCES) break;
        if (!seen.has(target)) {
          seen.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** 集合里是否出现该门码（常量名或字面量）。 */
function referencesCode(bundle: string[], code: string): boolean {
  const constant = CONSTANT_BY_CODE.get(code);
  const needles = constant
    ? [`PERMISSION_CODES.${constant}`, `"${code}"`, `'${code}'`]
    : [`"${code}"`, `'${code}'`];
  return bundle.some((file) => {
    const text = readFileSync(file, "utf8");
    return needles.some((needle) => text.includes(needle));
  });
}

/** 集合里是否导出该 HTTP 方法（`export const GET` / `… as GET,`）。 */
function exportsMethod(bundle: string[], method: string): boolean {
  const inline = new RegExp(`export\\s+(?:const|async function)\\s+${method}\\b`, "u");
  const reexport = new RegExp(`as\\s+${method}\\s*[},]`, "u");
  return bundle.some((file) => {
    const text = readFileSync(file, "utf8");
    return inline.test(text) || reexport.test(text);
  });
}

describe("listPcInterfaces matches the real admin ajax routes", () => {
  const rows = listPcInterfaces();

  it("carries exactly the catalogued endpoints", () => {
    // 规模钉成具体数字：增删任何一行都要在这里改数字，顺手逼一次「这是有意的」。
    // 自建账号端点（account/*、auth/credential-login 等）只要求活跃账号、不绑
    // 权限码，不在授权树里出现，因此不进这份清单。
    expect(rows).toHaveLength(133);
  });

  it("keeps every path unique per method", () => {
    const keys = rows.map((row) => `${row.method} ${row.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("maps every auth to the session class (dashboard endpoints)", () => {
    expect(rows.every((row) => row.auth === "session")).toBe(true);
  });

  it("rewrites the admin base to the configured one", () => {
    // 站点把后台配到 /cms/ 时，叶子上显示的就是 /cms/ajax/…（目录里存的是默认基址）。
    const custom = listPcInterfaces("cms");
    expect(custom).toHaveLength(rows.length);
    expect(custom[0]?.path).toBe("/cms/ajax/books");
    expect(custom.some((row) => row.path.startsWith(`/${DEFAULT_ADMIN_PATH}/`))).toBe(false);
  });

  for (const row of listPcInterfaces()) {
    it(`${row.method} ${row.path} -> ${row.permissionCodes.join("|")}`, () => {
      const routePath = routeFileFor(row.path);
      expect(existsSync(routePath), `route file missing: ${routePath}`).toBe(true);
      const bundle = sourceBundle(routePath);

      for (const code of row.permissionCodes) {
        expect(
          referencesCode(bundle, code),
          `${routePath} does not reference the gate code ${code}`,
        ).toBe(true);
      }

      expect(
        exportsMethod(bundle, row.method),
        `${routePath} does not export ${row.method}`,
      ).toBe(true);
    });
  }
});
