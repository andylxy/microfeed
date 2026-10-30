import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

import {LOGIN_METHOD_TOGGLE_KEYS} from "@/shared/AppLoginMethods";

/**
 * 「登录管理」板的行清单必须覆盖 `LOGIN_METHOD_TOGGLE_KEYS` 里的每个开关。
 *
 * 这条不变量值一条测试：开关的**保存**路径由 `LOGIN_METHOD_TOGGLE_KEYS` 驱动
 * （`ajax/login-methods/save.ts` 按这份清单校验），但**渲染**是一张手写行表。
 * 两边一旦漂移，就会出现「后端能存、后台没入口」的开关——`emailRegisterEnabled`
 * 当初就是这样漏掉的：端点全通、App 能读，后台却只能靠直接改库才能打开。
 *
 * 板子是 `client:only` 的 React 岛，首帧只有 loading 态（数据在 effect 里取），
 * 所以这里读源码而不是渲染。
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const BOARD = path.join(
  repositoryRoot,
  "src",
  "components",
  "admin",
  "login-methods",
  "LoginMethodsApp.tsx",
);

describe("login methods board rows", () => {
  const source = readFileSync(BOARD, "utf8");

  it("renders a row for every toggle key the save path accepts", () => {
    const missing = LOGIN_METHOD_TOGGLE_KEYS.filter(
      (key) => !new RegExp(`key:\\s*"${key}"`, "u").test(source),
    );
    expect(missing).toEqual([]);
  });

  it("labels every row through i18n instead of literal copy", () => {
    const labels = [...source.matchAll(/labelKey:\s*"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    // 所有行都必须走 i18n，禁止写死文案。
    expect(labels.every((key) => key?.startsWith("appLoginMethods."))).toBe(true);
    // 绑了真实配置键的行数必须等于保存路径接受的键数：每条行都绑定一个可保存键，
    // 不再有「预留·未接通」的不可拨动行。
    const keyedRows = [...source.matchAll(/key:\s*"([^"]+)"/gu)];
    expect(keyedRows.length).toBe(LOGIN_METHOD_TOGGLE_KEYS.length);
  });
});
