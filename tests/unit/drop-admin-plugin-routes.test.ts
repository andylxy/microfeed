/**
 * 反向守卫：better-auth 的 admin 插件已从实例上摘除。
 *
 * 该插件挂出 15 条 `/api/auth/admin/*` 端点，每条都在 RBAC 之外自带一套鉴权判据
 * （它只看 `auth_user.role`）。插件在册时，任何拿到管理员会话的调用方都能绕过
 * `ext_user_roles` 改角色、封号、改密——这是第二个授权面。移除后这些方法既不能
 * 被调用，也不能被重新装回来。
 *
 * 本文件只做静态检查：better-auth 构造实例时会初始化 Kysely 适配器，单元环境没有
 * D1 绑定，初始化会抛 `Failed to initialize database adapter`（未处理拒绝），测
 * 不出结论。「`api` 上确实没有这 15 个方法」由
 * `tests/worker/drop-admin-plugin-routes.test.ts` 在 miniflare 的真 D1 上验。
 *
 * 方法名取自插件产物 `better-auth/dist/plugins/admin/routes.mjs` 末尾的导出清单，
 * 与 15 条路由一一对应。ADR-0054。
 */
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");
const cliRoot = path.join(repositoryRoot, "manage-cli");

/** admin 插件在 `api` 上提供的全部方法。 */
export const ADMIN_PLUGIN_METHODS = [
  "adminUpdateUser",
  "banUser",
  "createUser",
  "getUser",
  "impersonateUser",
  "listUserSessions",
  "listUsers",
  "removeUser",
  "revokeUserSession",
  "revokeUserSessions",
  "setRole",
  "setUserPassword",
  "stopImpersonating",
  "unbanUser",
  "userHasPermission",
] as const;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(filename);
      }
      return /\.tsx?$/u.test(entry.name) ? [filename] : [];
    }),
  );
  return files.flat();
}

/** 两棵树下的全部源文件，读一次给后面的 15 条正则复用。 */
async function allSources(): Promise<{file: string; source: string}[]> {
  const out: {file: string; source: string}[] = [];
  for (const root of [sourceRoot, cliRoot]) {
    for (const file of await sourceFiles(root)) {
      out.push({
        file: path.relative(repositoryRoot, file),
        source: await readFile(file, "utf8"),
      });
    }
  }
  return out;
}

describe("admin 插件的方法没有任何调用点", () => {
  it("15 个方法名在 src/ 与 manage-cli/ 里一次都没被调", async () => {
    expect(ADMIN_PLUGIN_METHODS).toHaveLength(15);
    const sources = await allSources();
    expect(sources.length).toBeGreaterThan(100);

    const callers: string[] = [];
    for (const {file, source} of sources) {
      for (const method of ADMIN_PLUGIN_METHODS) {
        // 只认 `xxx.api.<method>(` 这种取用方式：`getUser` 这类通用词在别处当普通
        // 函数名出现是正常的，插件调用一定过 `.api`。
        if (new RegExp(`\\.api\\.${method}\\s*\\(`, "u").test(source)) {
          callers.push(`${file} -> ${method}`);
        }
      }
    }
    expect(callers).toEqual([]);
  });
});

/**
 * `api` 上查不到方法只能证明结果，证明不了装配：插件若被加回来却因配置错误没挂出
 * 端点，运行期照样查不到。这一组直接读装配清单的源码。
 */
describe("装配清单里没有 admin 插件", () => {
  it("plugins 数组只剩 passkey / username / oauthProvider", async () => {
    const source = await readFile(
      path.join(sourceRoot, "server", "auth", "better-auth.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/better-auth\/plugins\/admin/u);

    const pluginsAt = source.indexOf("plugins: [");
    expect(pluginsAt).toBeGreaterThan(-1);
    const pluginsEnd = source.indexOf("\n    ],", pluginsAt);
    expect(pluginsEnd).toBeGreaterThan(pluginsAt);
    const plugins = source.slice(pluginsAt, pluginsEnd);

    // 切片里出现 `adminUrl(...)` 与 `adminPath` 是正常的，这里只认插件调用形态。
    expect(plugins).not.toMatch(/(?:^|[\s,])admin\s*\(/mu);
    for (const kept of ["passkey", "username", "oauthProvider"]) {
      expect(plugins).toContain(`${kept}(`);
    }
  });
});
