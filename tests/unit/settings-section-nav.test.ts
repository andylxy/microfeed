import {beforeEach, describe, expect, it} from "vitest";

import {activeAnchorSectionId, observeScrollAndResize} from "@/client/AdminSettingsScroll";
import {
  getSettingsSection,
  setSettingsSection,
  subscribeSettingsSection,
} from "@/client/settings-section-state";
import {
  installSettingsSectionNav,
  jumpToSettingsSection,
  settingsSectionIdFromHref,
} from "@/client/settings-section-nav";

// 环境说明：与 admin-menu-tree.test.ts 一致，跑在 node（无 jsdom）里，window /
// document / rAF 都是手搓桩。settings-section-nav 在调用时才读全局，所以每个
// 用例临时装配、用完卸载。

interface Rect {
  height: number;
  top: number;
}

const rect = (height: number, top: number): Rect => ({height, top});

/** replaceState 的调用记录：模块级，harness 的桩往里写，断言直接读。 */
const replaceStateCalls: {data: unknown; unused: string; url: string}[] = [];

/** 迷你事件目标：收 handlers、可手动 dispatch、可数个数（卸载断言用）。 */
function fakeTarget() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, handler: (event: unknown) => void): void {
      const set = handlers.get(type) ?? new Set<(event: unknown) => void>();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type: string, handler: (event: unknown) => void): void {
      handlers.get(type)?.delete(handler);
    },
    dispatch(type: string, event: unknown = {}): void {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
    count(type: string): number {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

interface FakeClick {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  preventDefault: () => void;
  shiftKey: boolean;
  target: {closest: (selector: string) => {href: string} | null};
}

/** 造一次点击：closest 只认一个锚点（侧栏/抽屉里的分区链接都长这样）。 */
function clickOn(href: string | null, overrides: Partial<FakeClick> = {}): FakeClick {
  let prevented = false;
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    preventDefault: (): void => {
      prevented = true;
    },
    shiftKey: false,
    target: {closest: (): {href: string} | null => (href ? {href} : null)},
    ...overrides,
    get defaultPrevented(): boolean {
      return prevented;
    },
  };
}

interface Harness {
  assigned: string[];
  document: ReturnType<typeof fakeTarget> & {
    getElementById: (id: string) => unknown;
  };
  root: ReturnType<typeof fakeTarget> & {
    clientHeight: number;
    getBoundingClientRect: () => Rect;
    scrollHeight: number;
    scrollTo: (options: {behavior?: string; top: number}) => void;
    scrollTop: number;
  };
  scrollTos: {behavior?: string; top: number}[];
  window: ReturnType<typeof fakeTarget>;
}

/**
 * 装一套环境：`#admin-page-content` 滚动容器 + 若干分区元素 + window。
 * `elements` 缺省的分区视为不在文档里（getElementById 返回 null）。
 */
function harness(options: {
  elements?: Record<string, Rect>;
  hash?: string;
  pathname?: string;
  scroll?: {clientHeight?: number; scrollHeight?: number; scrollTop?: number};
  withRoot?: boolean;
} = {}): Harness {
  const {
    elements = {},
    hash = "",
    pathname = "/admin/settings",
    scroll = {},
    withRoot = true,
  } = options;
  const scrollTos: {behavior?: string; top: number}[] = [];
  const assigned: string[] = [];
  const state = {scrollTop: scroll.scrollTop ?? 0};

  const root = {
    ...fakeTarget(),
    clientHeight: scroll.clientHeight ?? 500,
    getBoundingClientRect: (): Rect => rect(500, 0),
    scrollHeight: scroll.scrollHeight ?? 2000,
    scrollTo: (options: {behavior?: string; top: number}): void => {
      scrollTos.push(options);
      state.scrollTop = options.top;
    },
    get scrollTop(): number {
      return state.scrollTop;
    },
  };

  const byId: Record<string, unknown> = {};
  for (const [id, box] of Object.entries(elements)) {
    byId[id] = {getBoundingClientRect: (): Rect => box};
  }
  if (withRoot) byId["admin-page-content"] = root;

  const documentStub = Object.assign(fakeTarget(), {
    getElementById: (id: string): unknown => byId[id] ?? null,
  });
  const windowStub = {
    ...fakeTarget(),
    history: {
      replaceState: (data: unknown, unused: string, url: string): void => {
        replaceStateCalls.push({data, unused, url});
      },
    },
    location: {
      assign: (url: string): void => {
        assigned.push(url);
      },
      hash,
      href: `http://d.test${pathname}`,
      pathname,
    },
  };

  (globalThis as Record<string, unknown>).window = windowStub;
  (globalThis as Record<string, unknown>).document = documentStub;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = (): void => {};

  return {assigned, document: documentStub, root, scrollTos, window: windowStub};
}

beforeEach(() => {
  replaceStateCalls.length = 0;
  setSettingsSection("");
});

describe("settings section state", () => {
  it("notifies subscribers on change, once per change, until unsubscribed", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettingsSection(() =>
      seen.push(getSettingsSection()),
    );

    setSettingsSection("site");
    setSettingsSection("site");
    setSettingsSection("favicon");
    expect(seen).toEqual(["site", "favicon"]);

    unsubscribe();
    setSettingsSection("items-settings");
    expect(seen).toEqual(["site", "favicon"]);
    expect(getSettingsSection()).toBe("items-settings");
  });
});

describe("activeAnchorSectionId", () => {
  const sections = [{id: "a"}, {id: "b"}, {id: "c"}];
  const rootWith = (scrollTop: number, rects: Record<string, Rect>): HTMLElement => {
    const byId: Record<string, unknown> = {};
    for (const [id, box] of Object.entries(rects)) {
      byId[id] = {getBoundingClientRect: (): Rect => box};
    }
    (globalThis as Record<string, unknown>).document = {
      getElementById: (id: string): unknown => byId[id] ?? null,
    };
    return {
      clientHeight: 500,
      getBoundingClientRect: (): Rect => rect(500, 0),
      scrollHeight: 2000,
      scrollTop,
    } as HTMLElement;
  };

  it("keeps the last section whose top crossed the threshold", () => {
    // 阈值 = 容器顶边(0) + 56：a 已越过，b、c 还在下面。
    const root = rootWith(0, {
      a: rect(100, 0),
      b: rect(100, 200),
      c: rect(100, 400),
    });
    expect(activeAnchorSectionId(sections, root)).toBe("a");
  });

  it("treats the bottom of the scroll as the last section", () => {
    const root = rootWith(1500, {
      a: rect(100, 0),
      b: rect(100, 500),
      c: rect(100, 900),
    });
    expect(activeAnchorSectionId(sections, root)).toBe("c");
  });

  it("treats the bottom of the scroll as the last visible section", () => {
    // 末块被搜索过滤藏起来（矩形四边皆为 0）时，高亮停在可见的末块，被藏
    // 起来的那块不高亮。
    const root = rootWith(1500, {
      a: rect(100, 0),
      b: rect(100, 500),
      c: rect(0, 900),
    });
    expect(activeAnchorSectionId(sections, root)).toBe("b");
  });

  it("skips sections hidden with display:none (all-zero rects)", () => {
    // 设置页搜索过滤会把不命中的分区藏起来，其矩形四边皆为 0；混进来会让
    // 高亮跳到第一个被藏起的分区。
    const root = rootWith(0, {
      a: rect(0, 0),
      b: rect(100, 0),
      c: rect(100, 900),
    });
    expect(activeAnchorSectionId(sections, root)).toBe("b");
  });
});

describe("observeScrollAndResize", () => {
  // 桩里的 requestAnimationFrame 同步回调，没有真实的帧合并；这里验证的是
  // 接线（装载一次、scroll/resize 各触发、卸载后全静音）。
  it("runs once on install, again on scroll and resize, and goes quiet after uninstall", () => {
    const env = harness({elements: {site: rect(100, 0)}});
    let ticks = 0;
    const uninstall = observeScrollAndResize(
      env.root as unknown as HTMLElement,
      () => {
        ticks += 1;
      },
    );
    expect(ticks).toBe(1);
    expect(env.root.count("scroll")).toBe(1);
    expect(env.window.count("resize")).toBe(1);

    env.root.dispatch("scroll");
    env.window.dispatch("resize");
    expect(ticks).toBe(3);

    uninstall();
    env.root.dispatch("scroll");
    env.window.dispatch("resize");
    expect(ticks).toBe(3);
    expect(env.root.count("scroll")).toBe(0);
    expect(env.window.count("resize")).toBe(0);
  });
});

describe("settingsSectionIdFromHref", () => {
  beforeEach(() => {
    // 函数以 window.location.href 为 URL 基址（相对 href 的兜底），先装环境。
    harness();
  });

  it("resolves a same-page link to its section id", () => {
    expect(
      settingsSectionIdFromHref(
        "http://d.test/admin/settings#content-review",
        "/admin/settings",
      ),
    ).toBe("content-review");
  });

  it("tolerates a trailing-slash mismatch between menu data and the address bar", () => {
    expect(
      settingsSectionIdFromHref(
        "http://d.test/admin/settings/#site",
        "/admin/settings",
      ),
    ).toBe("site");
  });

  it("ignores links to other pages and unknown hashes", () => {
    expect(
      settingsSectionIdFromHref(
        "http://d.test/admin/books#site",
        "/admin/settings",
      ),
    ).toBeNull();
    expect(
      settingsSectionIdFromHref(
        "http://d.test/admin/settings#nope",
        "/admin/settings",
      ),
    ).toBeNull();
    expect(
      settingsSectionIdFromHref(
        "http://d.test/admin/settings",
        "/admin/settings",
      ),
    ).toBeNull();
  });
});

describe("jumpToSettingsSection", () => {
  it("scrolls smoothly, records the URL with replaceState and updates the store", () => {
    const env = harness({elements: {site: rect(100, 2000)}});

    expect(jumpToSettingsSection("site")).toBe(true);
    expect(env.scrollTos).toEqual([{behavior: "smooth", top: 1976}]);
    expect(replaceStateCalls).toEqual([{data: null, unused: "", url: "#site"}]);
    expect(getSettingsSection()).toBe("site");
  });

  it("reports failure without touching history when the section is not in the document", () => {
    harness({elements: {}});

    expect(jumpToSettingsSection("site")).toBe(false);
    expect(replaceStateCalls).toEqual([]);
    expect(getSettingsSection()).toBe("");
  });
});

describe("installSettingsSectionNav", () => {
  it("takes the initial section from the URL hash", () => {
    // 浏览器里 SettingsApp 的 rAF 先把正文滚到 hash 对应的分区，观察器随后
    // 读到的就是同一块；桩里让滚动位置与 hash 一致，模拟那一步已发生。
    harness({elements: {site: rect(100, 0)}, hash: "#site"});

    const uninstall = installSettingsSectionNav();
    expect(getSettingsSection()).toBe("site");
    uninstall();
  });

  it("intercepts a sidebar section link: smooth scroll, replaceState, no history push", () => {
    const env = harness({
      elements: {"content-review": rect(100, 0), site: rect(100, 2000)},
    });
    const uninstall = installSettingsSectionNav();

    env.document.dispatch("click", clickOn("http://d.test/admin/settings#site"));

    expect(env.scrollTos).toEqual([{behavior: "smooth", top: 1976}]);
    expect(replaceStateCalls.map(({url}) => url)).toEqual(["#site"]);
    expect(getSettingsSection()).toBe("site");
    uninstall();
  });

  it("follows the scroll position once mounted", () => {
    const env = harness({
      elements: {
        "content-review": rect(100, 0),
        "custom-code": rect(100, 900),
        site: rect(100, 2000),
      },
      scroll: {scrollTop: 300},
    });
    const uninstall = installSettingsSectionNav();
    // 初始（无 hash）：custom-code 还在阈值下方、content-review 已越过 → 后者。
    expect(getSettingsSection()).toBe("content-review");

    env.root.scrollTo({top: 1500});
    env.root.dispatch("scroll");
    expect(getSettingsSection()).toBe("site");
    uninstall();
  });

  it("leaves other pages' links and modified clicks to the browser", () => {
    const env = harness({elements: {site: rect(100, 2000)}});
    const uninstall = installSettingsSectionNav();

    const otherPage = clickOn("http://d.test/admin/books#site");
    const modified = clickOn("http://d.test/admin/settings#site", {ctrlKey: true});
    for (const click of [otherPage, modified]) {
      env.document.dispatch("click", click);
    }

    expect(env.scrollTos).toEqual([]);
    expect(otherPage.defaultPrevented).toBe(false);
    expect(modified.defaultPrevented).toBe(false);
    uninstall();
  });

  it("falls back to a full navigation when the scroll root is missing", () => {
    const env = harness({elements: {site: rect(100, 2000)}, withRoot: false});
    const uninstall = installSettingsSectionNav();

    const click = clickOn("http://d.test/admin/settings#site");
    env.document.dispatch("click", click);

    expect(env.assigned).toEqual(["http://d.test/admin/settings#site"]);
    expect(click.defaultPrevented).toBe(true);
    expect(replaceStateCalls).toEqual([]);
    uninstall();
  });

  it("removes every listener and clears the shared state on uninstall", () => {
    const env = harness({elements: {site: rect(100, 2000)}, hash: "#site"});
    const uninstall = installSettingsSectionNav();
    expect(env.document.count("click")).toBe(1);
    expect(env.root.count("scroll")).toBe(1);

    uninstall();

    expect(env.document.count("click")).toBe(0);
    expect(env.root.count("scroll")).toBe(0);
    expect(getSettingsSection()).toBe("");
    const click = clickOn("http://d.test/admin/settings#site");
    env.document.dispatch("click", click);
    expect(click.defaultPrevented).toBe(false);
  });
});
