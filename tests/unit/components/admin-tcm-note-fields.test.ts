import React from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import Requests from "@/client/requests";
import EditItemApp from "@/components/admin/items/EditItemApp";
import AdminTextarea from "@/components/admin/shared/AdminTextarea";
import {STATUSES} from "@/shared/Constants";

vi.mock("@/client/ToastUtils", () => ({showToast: vi.fn()}));
vi.mock("astro:transitions/client", () => ({navigate: vi.fn()}));
vi.mock("@/components/admin/shared/AdminImageUploaderApp", () => ({
  default: () => null,
}));
vi.mock("@/components/admin/shared/AdminRichEditor", () => ({
  default: () => null,
}));
vi.mock("@/components/admin/items/EditItemApp/components/MediaManager", () => ({
  default: () => null,
}));

const mountedComponents: React.Component[] = [];

function useSynchronousState(component: React.Component<any, any>) {
  component.setState = ((update: unknown, callback?: () => void) => {
    const nextState = typeof update === "function"
      ? update(component.state, component.props)
      : update;
    component.state = {...component.state, ...nextState};
    callback?.();
  }) as typeof component.setState;
}

function findElement(
  value: React.ReactNode,
  predicate: (element: React.ReactElement<any>) => boolean,
): React.ReactElement<any> | undefined {
  for (const child of React.Children.toArray(value)) {
    if (!React.isValidElement<any>(child)) continue;
    if (predicate(child)) return child;
    const nested = findElement(child.props.children, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function feed(item?: Record<string, unknown>) {
  return {
    channel: {
      id: "channel0001",
      is_primary: true,
      language: "en-us",
      status: STATUSES.PUBLISHED,
      title: "Example channel",
    },
    ...(item ? {item} : {}),
    items: [],
    settings: {
      webGlobalSettings: {publicBucketUrl: "/media/"},
    },
  };
}

function props(item?: Record<string, unknown>) {
  return {
    feedContent: feed(item),
    onboardingResult: {allOk: true, requiredOk: true, result: {}},
  } as any;
}

function mount<T extends React.Component<any, any>>(component: T): T {
  useSynchronousState(component);
  component.componentDidMount?.();
  mountedComponents.push(component);
  return component;
}

function noteTextarea(app: EditItemApp) {
  return findElement(
    app.render(),
    (element) => element.type === AdminTextarea && element.props.minRows === 8,
  );
}

function videoMemoTextarea(app: EditItemApp) {
  return findElement(
    app.render(),
    (element) => element.type === AdminTextarea && element.props.minRows === 4,
  );
}

beforeEach(() => {
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    history: {replaceState: vi.fn(), state: null},
    location: {
      assign: vi.fn(),
      hostname: "feed.example.com",
      origin: "https://feed.example.com",
      search: "",
    },
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => ({content: "admin"})),
    removeEventListener: vi.fn(),
  });
  vi.spyOn(Requests, "axiosGet").mockResolvedValue({data: {books: []}} as any);
  vi.spyOn(Requests, "axiosPost").mockResolvedValue({} as any);
});

afterEach(() => {
  for (const component of mountedComponents.splice(0)) {
    component.componentWillUnmount?.();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TCM section annotation fields (note / videoMemo)", () => {
  it("shows both annotation textareas on the new-item form", () => {
    // The new-item page runs the same component in create mode, where the
    // _microfeed pocket does not exist yet. The fields must still render —
    // a pocket-key condition would hide them on the one page that was asked
    // for them by name.
    const app = mount(new EditItemApp(props()));

    expect(noteTextarea(app)).toBeDefined();
    expect(noteTextarea(app)?.props.value).toBe("");
    expect(videoMemoTextarea(app)).toBeDefined();
    expect(videoMemoTextarea(app)?.props.value).toBe("");
  });

  it("prefills the stored note and videoMemo when editing a section", () => {
    const app = mount(new EditItemApp({
      ...props({
        _microfeed: {note: "旧注文", videoMemo: "旧备注"},
        id: "tcmsec0001",
        status: STATUSES.PUBLISHED,
        title: "辨太阳病脉证并治",
      }),
      itemId: "tcmsec0001",
    }));

    expect(noteTextarea(app)?.props.value).toBe("旧注文");
    expect(videoMemoTextarea(app)?.props.value).toBe("旧备注");
  });

  it("saves an edited note into the _microfeed pocket verbatim", async () => {
    const app = mount(new EditItemApp(props()));

    noteTextarea(app)?.props.onChange({target: {value: "新注文"}});
    await app.onSubmit({preventDefault: vi.fn()});

    expect(Requests.axiosPost).toHaveBeenCalledOnce();
    expect(vi.mocked(Requests.axiosPost).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        item: expect.objectContaining({
          _microfeed: expect.objectContaining({note: "新注文"}),
        }),
      }),
    );
  });

  it("keeps the pocket clean when the annotation fields are untouched", async () => {
    const app = mount(new EditItemApp({
      ...props({
        _microfeed: {bookId: "book0001"},
        id: "novelchap1",
        status: STATUSES.PUBLISHED,
        title: "第一章",
      }),
      itemId: "novelchap1",
    }));

    app.onUpdateItemMeta({title: "第一章（改）"});
    await app.onSubmit({preventDefault: vi.fn()});

    expect(Requests.axiosPost).toHaveBeenCalledOnce();
    const body = vi.mocked(Requests.axiosPost).mock.calls[0]?.[1] as {
      item: {_microfeed?: Record<string, unknown>};
    };
    expect(body.item._microfeed).toEqual({bookId: "book0001"});
  });
});
