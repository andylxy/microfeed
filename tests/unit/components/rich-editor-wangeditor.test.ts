import React from "react";
import {describe, expect, it, vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";

// The real `@wangeditor/editor` package touches `navigator` at import time and
// its `<Editor>` is a DOM component; in a node unit test we only care that the
// wrapper hands the body to `<Editor>` the right way and forwards its HTML. Both
// packages are mocked.
const {registerMenu} = vi.hoisted(() => ({registerMenu: vi.fn()}));
vi.mock("@wangeditor/editor", () => ({
  i18nChangeLanguage: () => {},
  // The `registerMarkerMenus` side-effect import registers `$X{...}` button
  // menus through `Boot.registerMenu`; the real package also exposes
  // `SlateEditor` used inside `exec`. Both are no-ops here — the wrapper's
  // content-ownership wiring is what this test checks, not the plugin.
  Boot: {registerMenu},
  SlateEditor: {deleteFragment: () => {}},
}));

// Capture the props the wrapper passes to the (mocked) wangEditor `<Editor>` /
// `<Toolbar>` so the test can prove the body is seeded *uncontrolled*
// (defaultHtml), not as a controlled `value` that wangEditor-for-react would
// reset on every parent re-render and clobber the author's last keystroke.
vi.mock("@wangeditor/editor-for-react", () => ({
  Editor: (props: any) => {
    (globalThis as any).__wangEditorProps = props;
    return null;
  },
  Toolbar: (props: any) => {
    (globalThis as any).__wangToolbarProps = props;
    return null;
  },
}));

import RichEditorWangEditor from "@/components/admin/shared/AdminRichEditor/component/RichEditorWangEditor";

describe("RichEditorWangEditor content ownership", () => {
  it("registers the $X{...} annotation menus (f/a/u/x) on load", () => {
    // The plugin registers four toolbar buttons through `Boot.registerMenu`
    // as a side effect of importing `RichEditorWangEditor`. Prove they are
    // wired with the expected menu keys so the toolbar actually shows them.
    const registeredKeys = registerMenu.mock.calls.map((call) => (call[0] as {key: string}).key);
    expect(registeredKeys).toEqual(
      expect.arrayContaining(["marker-f", "marker-a", "marker-u", "marker-x"]),
    );
  });

  it("loads the body as uncontrolled defaultHtml, never a controlled value", () => {
    // Regression for the "edited Quill/Markdown body lost on save" bug. A
    // controlled `value` makes wangEditor-for-react call `setHtml(value)` on
    // every parent re-render; when the parent's `description` lags the author's
    // keystroke by a tick, that reset overwrites the edit and the original
    // content is what gets saved. `defaultHtml` seeds the editor once and lets
    // it own its content, so only `onChange` ever writes `description`.
    // `initialMarkers` seeds the marker list so the (single) editor mount
    // happens during this SSR render instead of after the live fetch.
    renderToStaticMarkup(
      React.createElement(RichEditorWangEditor, {
        value: "<p>handover body</p>",
        onChange: () => {},
        initialMarkers: [{code: "f", title: "$f 方剂"}],
      }),
    );

    const props = (globalThis as any).__wangEditorProps;
    expect(props.defaultHtml).toBe("<p>handover body</p>");
    expect(props.value).toBeUndefined();
  });

  it("reports the editor's own HTML through onChange, unmodified", () => {
    // Whatever wangEditor produces is the body that is saved — no Quill
    // cleanup, no reformat. The handover must not round-trip the content.
    const onChange = vi.fn();
    renderToStaticMarkup(
      React.createElement(RichEditorWangEditor, {
        value: "<p>seed</p>",
        onChange,
        initialMarkers: [{code: "f", title: "$f 方剂"}],
      }),
    );

    // The mocked `<Editor>` wires its `onChange` to feed `getHtml()` upward;
    // invoke it the way wangEditor would and confirm the raw HTML is passed on.
    const props = (globalThis as any).__wangEditorProps;
    const wiredOnChange = props.onChange;
    expect(typeof wiredOnChange).toBe("function");
    wiredOnChange({getHtml: () => "<p>edited by wangEditor</p>"});
    expect(onChange).toHaveBeenCalledWith("<p>edited by wangEditor</p>");
  });

  it("mounts exactly once with the seeded marker list as toolbar keys", () => {
    // Regression for the white-screen: remounting Toolbar/Editor on a key
    // change makes wangEditor-for-react build a second toolbar (its effect has
    // no cleanup) bound partly to an orphaned editor, which crashed on click.
    // The wrapper must instead mount once with the final list.
    renderToStaticMarkup(
      React.createElement(RichEditorWangEditor, {
        value: "<p>seed</p>",
        onChange: () => {},
        initialMarkers: [
          {code: "f", title: "$f 方剂"},
          {code: "y", title: "$y 测试"},
        ],
      }),
    );

    const toolbarProps = (globalThis as any).__wangToolbarProps;
    expect(toolbarProps.defaultConfig.insertKeys.index).toBe(0);
    expect(toolbarProps.defaultConfig.insertKeys.keys).toEqual([
      "marker-f",
      "marker-y",
    ]);
  });
});
