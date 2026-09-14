import {describe, expect, it} from "vitest";

import {
  flatten,
  translationResources,
  translate,
} from "@/shared/i18n";

type NestedRecord = Record<string, unknown>;

function collectKeys(
  value: NestedRecord,
  prefix = "",
  keys: string[] = [],
): string[] {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") {
      keys.push(path);
    } else {
      collectKeys(entry as NestedRecord, path, keys);
    }
  }
  return keys;
}

describe("admin i18n resources", () => {
  it("keeps zh-CN keys identical to en", () => {
    const enKeys = collectKeys(
      translationResources.en.translation as NestedRecord,
    ).sort();
    const zhKeys = collectKeys(
      translationResources["zh-CN"].translation as NestedRecord,
    ).sort();

    expect(zhKeys).toEqual(enKeys);
  });

  it("returns English text for en", () => {
    expect(translate("login.signInTitle", "en")).toBe(
      "Sign in to the admin dashboard",
    );
  });

  it("returns Chinese text for zh-CN", () => {
    expect(translate("login.signInTitle", "zh-CN")).toBe("登录管理后台");
  });

  it("falls back to the key when missing", () => {
    expect(translate("missing.key", "en")).toBe("missing.key");
    expect(translate("missing.key", "zh-CN")).toBe("missing.key");
  });

  it("interpolates placeholders", () => {
    expect(translate("nav.openPublicAccess", "zh-CN", {title: "测试"})).toBe(
      "打开「测试」的公开访问链接",
    );
  });

  it("flattens nested resources into dotted keys", () => {
    const flat = flatten(translationResources.en.translation);
    expect(flat["login.signInTitle"]).toBe("Sign in to the admin dashboard");
  });
});
