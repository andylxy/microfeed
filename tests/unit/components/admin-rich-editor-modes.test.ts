import React from "react";
import {describe, expect, it, vi} from "vitest";

// Quill touches `document` the moment it is imported, and these tests run in
// node. The editor's DOM behaviour is not what is under test here — the mode
// list and the body it hands over are.
vi.mock("quill", () => {
  class FakeBlot {}
  const Quill: any = class {};
  Quill.import = () => FakeBlot;
  Quill.register = () => {};
  return {default: Quill, Delta: class {}};
});

import AdminRichEditor from "@/components/admin/shared/AdminRichEditor";
import RichEditorQuill from "@/components/admin/shared/AdminRichEditor/component/RichEditorQuill";
import AdminRadioGroup from "@/components/admin/shared/AdminRadioGroup";

/**
 * The mode list an author actually sees.
 *
 * Every chapter written before Markdown support is HTML, and for those the block
 * must be the two modes it has always had: visual editor and HTML source. A
 * third, empty Markdown box next to them is what made the editor look broken, so
 * the list is asserted here rather than left to a ternary.
 */
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

function mountEditor(props: Record<string, unknown>) {
  const editor = new AdminRichEditor(props);
  // No DOM here, so state is applied straight onto the instance: the switch flow
  // has to be observable through `render()`.
  editor.setState = ((update: unknown, callback?: () => void) => {
    const next = (typeof update === "function"
      ? (update as (state: any, props: any) => object)(editor.state, editor.props)
      : update) as Record<string, unknown>;
    editor.state = {...editor.state, ...next};
    callback?.();
  }) as typeof editor.setState;
  return editor;
}

function modeOptions(editor: AdminRichEditor) {
  const group = findElement(
    editor.render(),
    (element) => element.type === AdminRadioGroup &&
      element.props.name === "richOrHtml",
  );
  return (group?.props.options as {value: string}[]).map((option) => option.value);
}

/**
 * Whether the Markdown editor is on screen. Matched by display name rather than
 * by importing it: importing would pull the code editor into a node test, and
 * its internals are not reachable from this tree anyway (it is a function
 * component, so `findElement` only ever sees the element itself).
 */
function hasMarkdownEditor(editor: AdminRichEditor) {
  return Boolean(
    findElement(
      editor.render(),
      (element) => typeof element.type === "function"
        && element.type.name === "AdminMarkdownEditor",
    ),
  );
}

const baseProps = {
  onChange: () => {},
  onFormatChange: () => {},
};

describe("AdminRichEditor modes", () => {
  it("offers Markdown as a third mode beside the original two", () => {
    // Picked the same way as the others: a radio, not a separate control.
    const editor = mountEditor({...baseProps, value: "<p>body</p>"});
    expect(modeOptions(editor)).toEqual(["rich", "html", "markdown"]);
  });

  it("offers no Markdown mode when the caller cannot record the format", () => {
    // Channel and page descriptions have no `content_format`.
    const editor = mountEditor({onChange: () => {}, value: "<p>body</p>"});
    expect(modeOptions(editor)).toEqual(["rich", "html"]);
  });

  it("hands the visual editor the body unchanged", () => {
    const editor = mountEditor({...baseProps, value: "<p>a</p><p>b</p>"});
    const quill = findElement(
      editor.render(),
      (element) => element.type === RichEditorQuill,
    );
    expect(quill?.props.value).toBe("<p>a</p><p>b</p>");
  });

  it("leaves content_format alone when an HTML chapter is edited", () => {
    // HTML is the default: a chapter saved from the visual editor has to keep
    // looking exactly like one written before Markdown existed.
    const onFormatChange = vi.fn();
    const editor = mountEditor({
      ...baseProps,
      onChange: vi.fn(),
      onFormatChange,
      value: "<p>a</p>",
    });

    editor.onRichChange("<p>a b</p>");

    expect(onFormatChange).not.toHaveBeenCalled();
  });

  it("records the conversion when a Markdown chapter is edited as HTML", () => {
    const onFormatChange = vi.fn();
    const editor = mountEditor({
      ...baseProps,
      bodyFormat: "markdown",
      onChange: vi.fn(),
      onFormatChange,
      value: "# Title",
    });

    editor.onRichChange("<h1>Title</h1>");

    expect(onFormatChange).toHaveBeenCalledWith("html");
  });

  it("keeps Markdown verbatim and marks the body as Markdown", () => {
    const onChange = vi.fn();
    const onFormatChange = vi.fn();
    const editor = mountEditor({
      ...baseProps,
      bodyFormat: "markdown",
      onChange,
      onFormatChange,
      value: "# Title",
    });

    editor.onMarkdownChange("## Chapter\n\nProse.");

    expect(onChange).toHaveBeenCalledWith("## Chapter\n\nProse.");
    expect(onFormatChange).toHaveBeenCalledWith("markdown");
  });

  describe("switching a chapter to Markdown", () => {
    it("rewrites the body and opens the editor when Markdown is picked", () => {
      // Picking the mode is all it takes — no confirmation. The regression this
      // locks is the other way round: the Markdown box must show the chapter's
      // own text, never an empty one that reads as "my chapter is gone".
      const onChange = vi.fn();
      const onFormatChange = vi.fn();
      const editor = mountEditor({
        ...baseProps,
        onChange,
        onFormatChange,
        value: "<h2>第一章</h2><p>正文 <strong>加粗</strong></p>",
      });

      editor.onModeChange("markdown");

      expect(onChange).toHaveBeenCalledWith("## 第一章\n\n正文 **加粗**");
      expect(onFormatChange).toHaveBeenCalledWith("markdown");
      expect(editor.state.mode).toBe("markdown");
    });

    it("re-reads the body when the HTML source mode is opened", () => {
      // `htmlSource` is captured once at mount. Converting to Markdown changes
      // the body without touching it, so opening the HTML source box must
      // re-read — otherwise it shows (and, on the first keystroke, saves back)
      // the pre-conversion HTML and every Markdown edit is lost.
      const editor = mountEditor({...baseProps, value: "<p>一 旧正文</p>"});
      editor.onModeChange("markdown");
      (editor as any).props = {
        ...editor.props,
        bodyFormat: "markdown",
        value: "## 新标题\n\n二 新正文",
      };

      editor.onModeChange("html");

      expect(editor.state.htmlSource).toContain("新标题");
      expect(editor.state.htmlSource).toContain("二 新正文");
      expect(editor.state.htmlSource).not.toContain("一 旧正文");
    });

    it("refuses to convert when the caller cannot record the format", () => {
      const onChange = vi.fn();
      const editor = mountEditor({onChange, value: "<p>body</p>"});

      editor.onModeChange("markdown");

      // Still switches the view, but must not rewrite the body: with nowhere to
      // record the format, the reader would render `##` as literal text.
      expect(onChange).not.toHaveBeenCalled();
    });

    it("opens the Markdown editor straight away on a Markdown body", () => {
      // Nothing to convert: the source is already there to edit.
      const onChange = vi.fn();
      const editor = mountEditor({
        ...baseProps,
        bodyFormat: "markdown",
        onChange,
        value: "# Title",
      });

      editor.onModeChange("markdown");

      expect(onChange).not.toHaveBeenCalled();
      expect(hasMarkdownEditor(editor)).toBe(true);
    });

    it("opens the Markdown mode once the new format is recorded", () => {
      const editor = mountEditor({...baseProps, value: "<p>body</p>"});
      editor.onModeChange("markdown");
      expect(editor.state.mode).toBe("markdown");

      // `bodyFormat` is owned by the caller; the Markdown mode appears as soon as
      // it writes the new one, which is what makes the switch stick.
      (editor as any).props = {
        ...editor.props,
        bodyFormat: "markdown",
        value: "body",
      };
      expect(modeOptions(editor)).toEqual(["rich", "html", "markdown"]);
    });
  });
});
