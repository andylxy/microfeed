/**
 * 反向守卫：better-auth 的 admin 插件已从实例上摘除（运行期那一半）。
 *
 * 单元环境没有 D1 绑定，构造实例会抛 `Failed to initialize database adapter`，
 * 只能在 miniflare 里验。静态那一半（没有调用点、装配清单源码）在
 * `tests/unit/drop-admin-plugin-routes.test.ts`。
 *
 * 15 个方法名取自插件产物 `better-auth/dist/plugins/admin/routes.mjs` 末尾的导出
 * 清单，与 `/api/auth/admin/*` 的 15 条路由一一对应。ADR-0054。
 */
import {env} from "cloudflare:workers";
import {describe, expect, it} from "vitest";

import {createMicrofeedAuth} from "@/server/auth/better-auth";

const ADMIN_PLUGIN_METHODS = [
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

function makeAuth(): ReturnType<typeof createMicrofeedAuth> {
  return createMicrofeedAuth(env, new Request("http://localhost/api/auth/ok"));
}

describe("admin 插件方法不在 api 上", () => {
  it("15 个方法一个都不剩", () => {
    const api = makeAuth().api as unknown as Record<string, unknown>;
    const survived = ADMIN_PLUGIN_METHODS.filter(
      (method) => typeof api[method] === "function",
    );
    // 报出具体名字，比一句 boolean 断言好定位：谁把插件加回来会立刻看到是哪个。
    expect(survived).toEqual([]);
  });

  it("其余原语仍在，说明实例本身是完整的", () => {
    const api = makeAuth().api as unknown as Record<string, unknown>;
    for (const method of ["signInEmail", "signUpEmail", "getSession"]) {
      expect(typeof api[method]).toBe("function");
    }
  });
});

describe("装配清单里没有 admin 插件", () => {
  it("插件 id 集合是 passkey / username / oauth-provider", () => {
    const options = (makeAuth() as unknown as {
      options?: {plugins?: {id?: string}[]};
    }).options;
    expect(Array.isArray(options?.plugins)).toBe(true);
    const ids = (options?.plugins ?? []).map((plugin) => plugin.id ?? "");
    expect(ids).not.toContain("admin");
    expect(new Set(ids)).toEqual(
      new Set(["passkey", "username", "oauth-provider"]),
    );
  });
});
