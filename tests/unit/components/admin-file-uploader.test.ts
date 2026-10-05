import React from "react";
import {describe, expect, it, vi} from "vitest";

/**
 * `AdminFileUploader` 是「条目 → 媒体文件」「版本管理 → 上传 APK」共用的上传件。
 * 它有三条触发路径（拖拽投放 / 点选文件 / 键盘回车）与一条**扩展名过滤**，
 * 全是 handler 逻辑，静态渲染断言不到。
 *
 * 本仓组件测试没有 DOM 环境（没装 jsdom），而这是带 `useId`/`useRef` 的**函数**组件，
 * 不能像 class 组件那样 `new` 出来调方法。把这两个 hook 换成桩，就能直接调用组件函数
 * 拿到它返回的 `<label>` 元素，再调它 props 上的 handler —— 走的是**同一份** handler 代码，
 * 等价于浏览器里触发同名事件（差别只在于事件对象是构造的）。
 */
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useId: () => "test-id",
    useRef: (initial: unknown) => ({current: initial ?? null}),
  };
});

import AdminFileUploader from "@/components/admin/shared/AdminFileUploader";

type UploaderProps = Parameters<typeof AdminFileUploader>[0];
type Element = React.ReactElement<Record<string, any>>;

function apk(name = "app.apk"): File {
  return new File(["x"], name, {type: "application/vnd.android.package-archive"});
}

function renderUploader(overrides: Partial<UploaderProps> = {}) {
  const handleChange = vi.fn();
  const onDisabledClick = vi.fn();
  const onRejected = vi.fn();
  const element = AdminFileUploader({
    children: React.createElement("div", null, "选择 APK 文件"),
    handleChange,
    name: "apkUploader",
    onDisabledClick,
    onRejected,
    types: ["apk"],
    ...overrides,
  }) as Element;
  return {element, handleChange, onDisabledClick, onRejected};
}

/** 组件返回的根就是 `<label>`；它的 `children` 里那个 `<input>` 是点选入口。 */
function inputOf(element: Element) {
  return React.Children.toArray(element.props.children).find(
    (child) => React.isValidElement(child) && child.type === "input",
  ) as React.ReactElement<{onChange: (event: unknown) => void}>;
}

function drop(element: Element, files: File[]) {
  const preventDefault = vi.fn();
  element.props.onDrop({dataTransfer: {files}, preventDefault});
  return preventDefault;
}

describe("AdminFileUploader 的触发与过滤", () => {
  it("uploads a dropped .apk and prevents the browser default", () => {
    const {element, handleChange, onRejected} = renderUploader();
    const preventDefault = drop(element, [apk()]);
    // 不 preventDefault 浏览器就不会触发 drop —— 这是拖拽能用的前提。
    expect(preventDefault).toHaveBeenCalled();
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect((handleChange.mock.calls[0]?.[0] as File).name).toBe("app.apk");
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("uploads a file chosen through the picker", () => {
    const {element, handleChange} = renderUploader();
    inputOf(element).props.onChange({currentTarget: {files: [apk("picked.apk")]}});
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect((handleChange.mock.calls[0]?.[0] as File).name).toBe("picked.apk");
  });

  it("reports a dropped file whose extension is not allowed", () => {
    const {element, handleChange, onRejected} = renderUploader();
    const notes = new File(["x"], "notes.txt", {type: "text/plain"});
    drop(element, [notes]);
    expect(handleChange).not.toHaveBeenCalled();
    // 关键：不再静默忽略 —— 调用方要能给出提示，否则用户以为控件坏了。
    expect(onRejected).toHaveBeenCalledWith(notes);
  });

  it("reports a wrongly-typed file chosen through the picker too", () => {
    const {element, handleChange, onRejected} = renderUploader();
    inputOf(element).props.onChange({
      currentTarget: {files: [new File(["x"], "notes.txt", {type: "text/plain"})]},
    });
    expect(handleChange).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a drop carries no file", () => {
    const {element, handleChange, onRejected} = renderUploader();
    drop(element, []);
    expect(handleChange).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("accepts any file when no types are configured", () => {
    const {element, handleChange, onRejected} = renderUploader({types: []});
    drop(element, [new File(["x"], "anything.bin")]);
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("treats a leading dot in the configured types as optional", () => {
    const {element, handleChange} = renderUploader({types: [".apk"]});
    drop(element, [apk()]);
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it("is case-insensitive about the extension", () => {
    const {element, handleChange} = renderUploader();
    drop(element, [apk("APP.APK")]);
    expect(handleChange).toHaveBeenCalledTimes(1);
  });

  it("while disabled reports the click instead of uploading", () => {
    const {element, handleChange, onDisabledClick, onRejected} = renderUploader({disabled: true});
    drop(element, [apk()]);
    expect(handleChange).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    expect(onDisabledClick).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the caller passes no onRejected", () => {
    const {element, handleChange} = renderUploader({onRejected: undefined});
    expect(() => drop(element, [new File(["x"], "notes.txt")])).not.toThrow();
    expect(handleChange).not.toHaveBeenCalled();
  });
});
