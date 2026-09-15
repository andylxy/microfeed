import {describe, expect, it} from "vitest";

import i18n from "@/client/i18n";
import {
  labelRichEditorToolbar,
  RICH_EDITOR_TOOLBAR_LABEL_KEYS,
} from "@/client/RichEditorToolbar";

describe("labelRichEditorToolbar", () => {
  it("adds accessible hover labels to every configured toolbar control", () => {
    const controls = new Map<string, {
      attributes: Map<string, string>;
      setAttribute(name: string, value: string): void;
    }>(
      RICH_EDITOR_TOOLBAR_LABEL_KEYS.map(([selector]) => [
        selector,
        {
          attributes: new Map<string, string>(),
          setAttribute(name: string, value: string) {
            this.attributes.set(name, value);
          },
        },
      ]),
    );
    const container = {
      querySelectorAll(selector: string) {
        const control = controls.get(selector);
        return control ? [control] : [];
      },
    } as unknown as HTMLElement;

    labelRichEditorToolbar(container);

    RICH_EDITOR_TOOLBAR_LABEL_KEYS.forEach(([selector, key]) => {
      const label = i18n.t(key);
      expect(label).not.toBe(key);
      expect(controls.get(selector)?.attributes.get("aria-label")).toBe(label);
      expect(controls.get(selector)?.attributes.get("title")).toBe(label);
    });
  });

  it("keeps the clear-formatting control explicitly labeled", () => {
    expect(RICH_EDITOR_TOOLBAR_LABEL_KEYS).toContainEqual([
      "button.ql-clean",
      "richEditor.clearFormatting",
    ]);
    expect(i18n.t("richEditor.clearFormatting")).toBe("Clear formatting");
  });
});
