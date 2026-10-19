import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import ApiAuthenticationApp, {
  shouldShowApiAccessControls,
} from "@/components/admin/api/ApiAuthenticationApp";
import ApiOverviewApp from "@/components/admin/api/ApiOverviewApp";
import ApiSettingsApp from "@/components/admin/api/ApiSettingsApp";
import {
  buildApiExampleCode,
  highlightApiExampleCode,
} from "@/components/admin/api/ApiTryIt";
import {type ApiKeyRecord, updateApiAccessEnabled} from "@/shared/Api";
import {ADMIN_API_PAGES, adminApiPageUrl} from "@/shared/AdminApiNavigation";
import {isMenuIconName} from "@/shared/MenuIconNames";

const apiKey: ApiKeyRecord = {
  apiKey: "mf_abcdefghijklmnopqrstuvwxyz",
  createdAtMs: 1_725_000_000_000,
  id: "api-key-1",
  name: "Publishing",
  scopes: ["content:read", "content:write"],
  updatedAtMs: 1_725_000_000_000,
};

describe("API admin pages", () => {
  it("shows API availability controls only when API access is disabled", () => {
    expect(shouldShowApiAccessControls({
      enabled: false,
      publicDocsEnabled: false,
    })).toBe(true);
    expect(shouldShowApiAccessControls({
      enabled: true,
      publicDocsEnabled: false,
    })).toBe(false);
    expect(updateApiAccessEnabled({
      enabled: true,
      publicDocsEnabled: true,
    }, false)).toEqual({
      enabled: false,
      publicDocsEnabled: false,
    });
    expect(updateApiAccessEnabled({
      enabled: false,
      publicDocsEnabled: false,
    }, true)).toEqual({
      enabled: true,
      publicDocsEnabled: false,
    });
  });

  it("keeps the four-page API navigation as the single source for the menu", () => {
    expect(ADMIN_API_PAGES.map(({id}) => id)).toEqual([
      "overview",
      "authentication",
      "explorer",
      "settings",
    ]);
    expect(ADMIN_API_PAGES.map(({path}) => path)).toEqual([
      "api",
      "api/auth",
      "api/explorer",
      "api/settings",
    ]);
    // 主菜单把这几页注入为「集成 → API」的第三级：文案走 i18n 键，图标名
    // 必须在共享清单里登记，否则渲染会静默回退 ListIcon。
    for (const page of ADMIN_API_PAGES) {
      expect(page.nameKey.startsWith("api.")).toBe(true);
      expect(isMenuIconName(page.icon)).toBe(true);
    }
    // 三级子项的 URL 必须带上实际 admin 路径：漏传会静默回退默认 "admin"，
    // 自定义 MICROFEED_ADMIN_PATH 的部署里点子项即 404。
    expect(adminApiPageUrl(ADMIN_API_PAGES[1], "console")).toBe(
      "/console/api/auth/",
    );
  });

  it("renders overview status and gates the AI-agent prompt", () => {
    const output = renderToStaticMarkup(React.createElement(ApiOverviewApp, {
      apiKeys: [],
      authenticationUrl: "/admin/api/auth/",
      explorerUrl: "/admin/api/explorer/",
      llmsFullUrl: "https://feed.example.com/api/v1/llms-full.txt",
      settings: {enabled: false, publicDocsEnabled: false},
      settingsUrl: "/admin/api/settings/",
    }));
    expect(output).toContain("Active API keys");
    expect(output).toContain("!text-primary-foreground");
    expect(output).toContain(
      "Read https://feed.example.com/api/v1/llms-full.txt",
    );
    expect(output).toContain("Enable API access and publish API docs");
    expect(output).toContain("OpenAPI JSON");
    expect(output).toContain("llms-full.txt");
    expect(output.toLowerCase()).not.toContain("reference");
    expect(output).toContain("lg:grid-cols-2");
    expect(output).toContain('aria-label="Copy this prompt"');
    expect(output).toContain("absolute right-3 bottom-3");
    expect(output).not.toContain(">Copy prompt<");
  });

  it("prefills Bearer examples from a selected API key", () => {
    const code = buildApiExampleCode(
      "https://feed.example.com/api/v1/feed/?limit=3",
      apiKey.apiKey,
    );
    expect(code.javascript).toContain(`Bearer ${apiKey.apiKey}`);
    expect(code.javascript).toContain("await fetch");
    expect(code.curl).toContain(`Bearer ${apiKey.apiKey}`);
    expect(highlightApiExampleCode(code.javascript, "javascript"))
      .toContainEqual({kind: "keyword", value: "await"});
    expect(highlightApiExampleCode(code.curl, "curl"))
      .toContainEqual({kind: "command", value: "curl"});

    const output = renderToStaticMarkup(React.createElement(ApiOverviewApp, {
      apiKeys: [apiKey],
      authenticationUrl: "/admin/api/auth/",
      explorerUrl: "/admin/api/explorer/",
      llmsFullUrl: "https://feed.example.com/api/v1/llms-full.txt",
      settings: {enabled: true, publicDocsEnabled: true},
      settingsUrl: "/admin/api/settings/",
    }));
    expect(output).toContain("API key for this example");
    expect(output).toContain(`Bearer ${apiKey.apiKey}`);
    expect(output).toContain("JavaScript");
    expect(output).toContain("cURL");
    expect(output).toContain("Try it now");
    expect(output).toContain("pb-[50vh]");
    expect(output.match(/gap-3 border-b p-5/g)).toHaveLength(3);
    expect(output).toContain('data-syntax="keyword"');
    expect(output).toContain(">Run<");
  });

  it("renders multiple named API keys and immediate availability switches", () => {
    const authentication = renderToStaticMarkup(React.createElement(
      ApiAuthenticationApp,
      {
        initialApiKeys: [apiKey],
        initialSettings: {enabled: true, publicDocsEnabled: false},
      },
    ));
    expect(authentication).toContain("Publishing");
    expect(authentication).toContain("Create API key");
    expect(authentication).toContain("Rotate");
    expect(authentication).toContain("Revoke");
    expect(authentication).not.toContain(apiKey.apiKey);

    const settings = renderToStaticMarkup(React.createElement(ApiSettingsApp, {
      initialSettings: {enabled: true, publicDocsEnabled: false},
    }));
    expect(settings).toContain("Enable API access");
    expect(settings).toContain("Publish API docs");
    expect(settings).toContain("Control integration access and public API docs.");
    expect(settings.indexOf('data-slot="card-description"'))
      .toBeLessThan(settings.indexOf('data-slot="card-content"'));
    expect(settings).toContain("ml-4 divide-y border-l-2");
    expect(settings.toLowerCase()).not.toContain("reference");
    expect(settings).toContain("OpenAPI YAML");
    expect(settings).toContain("llms.txt");
    expect(settings).toContain("/api/v1/*");
    expect(settings).toContain("gap-3 border-b p-5");
    expect(settings).toContain("gap-0 py-0");
    expect(settings).not.toContain(">Update<");
  });
});
