import {describe, expect, it} from "vitest";

import {
  adminLanguageFromRequest,
  languageFromCookieHeader,
} from "@/shared/AdminLanguage";
import {
  localizedError,
  localizedTextError,
  notFoundResponse,
} from "@/server/http";
import {translate} from "@/shared/i18n";

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/admin", {headers});
}

const chinese = () => request({cookie: "microfeed-admin-language=zh-CN"});
const english = () => request({"accept-language": "en-US,en;q=0.9"});

describe("adminLanguageFromRequest", () => {
  it("prefers the explicit cookie over accept-language", () => {
    expect(adminLanguageFromRequest(request({
      cookie: "microfeed-admin-language=zh-CN",
      "accept-language": "en-US,en;q=0.9",
    }))).toBe("zh-CN");
  });

  it("honours an explicit choice of English", () => {
    expect(adminLanguageFromRequest(request({
      cookie: "microfeed-admin-language=en",
      "accept-language": "zh-CN,zh;q=0.9",
    }))).toBe("en");
  });

  it("finds the cookie among others", () => {
    expect(adminLanguageFromRequest(request({
      cookie: "a=1; microfeed-admin-language=zh-CN; b=2",
      "accept-language": "en",
    }))).toBe("zh-CN");
  });

  it("falls back to accept-language without a cookie", () => {
    expect(adminLanguageFromRequest(request({
      "accept-language": "zh-CN,zh;q=0.9",
    }))).toBe("zh-CN");
    expect(adminLanguageFromRequest(english())).toBe("en");
  });

  it("falls back to English with no hints at all", () => {
    expect(adminLanguageFromRequest(request())).toBe("en");
    expect(adminLanguageFromRequest(undefined)).toBe("en");
  });

  it("ignores an unknown cookie value", () => {
    expect(adminLanguageFromRequest(request({
      cookie: "microfeed-admin-language=fr-FR",
      "accept-language": "zh-CN",
    }))).toBe("zh-CN");
  });
});

describe("languageFromCookieHeader", () => {
  it("returns null when the preference is absent", () => {
    expect(languageFromCookieHeader(null)).toBeNull();
    expect(languageFromCookieHeader("")).toBeNull();
    expect(languageFromCookieHeader("other=1")).toBeNull();
  });
});

describe("localizedError", () => {
  it("returns a JSON body in the request language", async () => {
    const response = localizedError(english(), "errors.general.notFound");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({error: "Not found"});
  });

  it("follows the preference cookie", async () => {
    const response = localizedError(chinese(), "errors.general.notFound");
    const body = await response.json() as {error: string};
    expect(body.error).toBe(translate("errors.general.notFound", "zh-CN"));
    expect(body.error).not.toBe("Not found");
  });

  it("keeps the status and passes headers through", () => {
    const response = localizedError(
      english(),
      "errors.general.notFound",
      409,
      undefined,
      {headers: {"cache-control": "private, no-store"}},
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("localizedTextError", () => {
  it("returns plain text, not JSON", async () => {
    const response = localizedTextError(english(), "errors.general.notFound", 500);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type") ?? "").not.toContain("json");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("preserves a caller-supplied content type", () => {
    const response = localizedTextError(english(), "errors.general.notFound", 404, undefined, {
      headers: {"content-type": "text/plain; charset=utf-8"},
    });
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("notFoundResponse", () => {
  it("returns a localized 404 and does not invent a statusText", async () => {
    const response = notFoundResponse(english());
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("works without a request", async () => {
    const response = notFoundResponse();
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });
});
