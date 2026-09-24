import React from "react";
import {describe, expect, it, vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";

// The real `@wangeditor/editor` package touches `navigator` at import time and
// its `<Editor>` is a DOM component; in a node unit test we only care that the
// wrapper hands the body to `<Editor>` the right way and forwards its HTML. Both
// packages are mocked.
vi.mock("@wangeditor/editor", () => ({
  i18nChangeLanguage: () => {},
}));

// Capture the props the wrapper passes to the (mocked) wangEditor `<Editor>` so
// the test can prove the body is seeded *uncontrolled* (defaultHtml), not as a
// controlled `value` that wangEditor-for-react would reset on every parent
// re-render and clobber the author's last keystroke.
vi.mock("@wangeditor/editor-for-react", () => ({
  Editor: (props: any) => {
    (globalThis as any).__wangEditorProps = props;
    return null;
  },
  Toolbar: () => null,
}));

import RichEditorWangEditor from "@/components/admin/shared/AdminRichEditor/component/RichEditorWangEditor";

describe("RichEditorWangEditor content ownership", () => {
  it("loads the body as uncontrolled defaultHtml, never a controlled value", () => {
    // Regression for the "edited Quill/Markdown body lost on save" bug. A
    // controlled `value` makes wangEditor-for-react call `setHtml(value)` on
    // every parent re-render; when the parent's `description` lags the author's
    // keystroke by a tick, that reset overwrites the edit and the original
    // content is what gets saved. `defaultHtml` seeds the editor once and lets
    // it own its content, so only `onChange` ever writes `description`.
    renderToStaticMarkup(
      React.createElement(RichEditorWangEditor, {
        value: "<p>handover body</p>",
        onChange: () => {},
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
});
