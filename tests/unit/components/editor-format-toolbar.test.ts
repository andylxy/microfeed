import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import EditorFormatToolbar from "@/components/admin/shared/EditorFormatToolbar";
import {EDITOR_TOOLBAR_ACTIONS} from "@/client/markdownActions";

/**
 * The Markdown editor has no built-in toolbar, so this component is the only way
 * to format text there. Locks the buttons actually rendered — a missing or
 * mislabelled action is invisible until someone tries to use it and finds no
 * button.
 */
function renderToolbar(): string {
  return renderToStaticMarkup(
    React.createElement(EditorFormatToolbar, {onAction: () => {}}),
  ).replaceAll("<!-- -->", "");
}

describe("EditorFormatToolbar", () => {
  it("renders one control per shared action", () => {
    // The action ids are internal; what must hold is that every shared action
    // produces exactly one control. Labels are asserted separately below.
    const html = renderToolbar();
    expect(
      html.match(/<button\b/gu)?.length ?? 0,
    ).toBe(EDITOR_TOOLBAR_ACTIONS.length);
  });

  it("labels each control so the toolbar is not a row of blank boxes", () => {
    const html = renderToolbar();
    // The labels come from the shared richEditor.* strings, so a typo in a key
    // would leave a blank button. Assert on visible text and on aria-label too.
    expect(html).toContain("Bold");
    expect(html).toContain("Italic");
    expect(html).toContain("Heading 2");
    const ariaLabels = html.match(/aria-label="[^"]+"/gu) ?? [];
    expect(ariaLabels.length).toBe(EDITOR_TOOLBAR_ACTIONS.length);
    for (const label of ariaLabels) {
      expect(label).not.toContain("richEditor.");
    }
  });

  it("is a toolbar for assistive technology", () => {
    expect(renderToolbar()).toContain('role="toolbar"');
  });
});
