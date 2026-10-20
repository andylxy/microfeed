import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach, describe, expect, it, vi} from "vitest";

import AdminHomeApp from "@/components/admin/home/AdminHomeApp";
import WhatsNewApp from "@/components/admin/home/AdminHomeApp/component/WhatsNewApp";
import {ONBOARDING_TYPES} from "@/shared/Constants";
import type {OnboardingCheck, OnboardingResult} from "@/types";

function onboardingResult(complete: boolean): OnboardingResult {
  const check = (ready: boolean): OnboardingCheck => ({
    ready,
    required: false,
  });

  return {
    allOk: complete,
    requiredOk: true,
    result: {
      [ONBOARDING_TYPES.CUSTOM_DOMAIN]: check(complete),
      [ONBOARDING_TYPES.MEDIA_STORAGE]: {
        ...check(true),
        mediaStorageState: "ready",
      },
      [ONBOARDING_TYPES.PROTECTED_ADMIN_DASHBOARD]: {
        ...check(complete),
        adminProtection: {
          builtInLogin: complete,
          cloudflareAccess: false,
        },
      },
      [ONBOARDING_TYPES.VALID_PUBLIC_BUCKET_URL]: check(complete),
    },
  };
}

// 摘要块（loading 态）在输出里的标记：AdminCollectionLoading 的只读文案与
// 其无障碍属性。全仓首页 harness 仅此一处，两个态都复用同一组标记。
const USAGE_STRIP_LOADING = "Loading usage…";
const USAGE_STRIP_BUSY = 'aria-busy="true"';
// UsageTrendChart 的趋势图 SVG 标记：首页链路不得引入任何图表容器。
const TREND_CHART_MARKER = 'preserveAspectRatio="none"';
const SETUP_CHECKLIST_TITLE = ">Setup checklist</div>";

function renderHome(complete: boolean, canReadCloudUsage: boolean): string {
  vi.stubGlobal("window", {
    location: {
      hostname: "feed.example.com",
      port: "",
      protocol: "https:",
    },
  });

  return renderToStaticMarkup(
    React.createElement(AdminHomeApp, {
      canReadCloudUsage,
      feedContent: {},
      onboardingResult: onboardingResult(complete),
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("admin home section order", () => {
  it("shows the setup checklist first while tasks remain", () => {
    const output = renderHome(false, false);

    expect(output.indexOf(SETUP_CHECKLIST_TITLE)).toBeLessThan(
      output.indexOf(">Public access</h2>"),
    );
  });

  it("moves the completed setup checklist below Public access", () => {
    const output = renderHome(true, false);

    expect(output.indexOf(">Public access</h2>")).toBeLessThan(
      output.indexOf(SETUP_CHECKLIST_TITLE),
    );
  });

  it("renders no usage strip block without the cloud-usage read permission", () => {
    const output = renderHome(false, false);

    expect(output).not.toContain(USAGE_STRIP_LOADING);
    expect(output).not.toContain(USAGE_STRIP_BUSY);
    expect(output).not.toContain(TREND_CHART_MARKER);
  });

  it("renders the usage strip loading block above the setup checklist", () => {
    const output = renderHome(false, true);

    expect(output).toContain(USAGE_STRIP_LOADING);
    expect(output).toContain(USAGE_STRIP_BUSY);
    // 本票只做 loading + ready：island 层不出图表容器。
    expect(output).not.toContain(TREND_CHART_MARKER);
    expect(output.indexOf(USAGE_STRIP_LOADING)).toBeLessThan(
      output.indexOf(SETUP_CHECKLIST_TITLE),
    );
  });

  it("keeps the usage strip above the setup checklist once it is complete", () => {
    const output = renderHome(true, true);

    expect(output).toContain(USAGE_STRIP_LOADING);
    expect(output).not.toContain(TREND_CHART_MARKER);
    expect(output.indexOf(USAGE_STRIP_LOADING)).toBeLessThan(
      output.indexOf(SETUP_CHECKLIST_TITLE),
    );
  });

  it("links the updates card directly to the What's new section", () => {
    const app = new WhatsNewApp({});
    app.state = {
      fetchStatus: null,
      items: [{
        _microfeed: {
          date_published_short: "Aug 14, 2026",
          web_url: "https://www.microfeed.org/example/",
        },
        id: "example",
        title: "Example update",
      }],
    };

    const output = renderToStaticMarkup(app.render());

    expect(output).toContain(
      'href="https://www.microfeed.org/#whats-new"',
    );
  });
});
