import i18n from "@/client/i18n";

// Key suffixes, not labels: the toolbar is labelled once per editor, and
// switching languages reloads the page, so resolving through i18n here keeps the
// tooltips in step with the rest of the UI.
const RICH_EDITOR_TOOLBAR_LABEL_KEYS = [
  [".ql-header", "richEditor.textStyle"],
  ["button.ql-bold", "richEditor.bold"],
  ["button.ql-italic", "richEditor.italic"],
  ["button.ql-underline", "richEditor.underline"],
  ["button.ql-blockquote", "richEditor.blockQuote"],
  ["button.ql-code", "richEditor.inlineCode"],
  ["button.ql-code-block", "richEditor.codeBlock"],
  ['button.ql-list[value="ordered"]', "richEditor.numberedList"],
  ['button.ql-list[value="bullet"]', "richEditor.bulletedList"],
  ['button.ql-indent[value="-1"]', "richEditor.decreaseIndent"],
  ['button.ql-indent[value="+1"]', "richEditor.increaseIndent"],
  ["button.ql-link", "richEditor.insertLink"],
  ["button.ql-image", "richEditor.insertImage"],
  ["button.ql-video", "richEditor.insertVideo"],
  ["button.ql-strike", "richEditor.strikeThrough"],
  ["select.ql-align", "richEditor.textAlign"],
  ["select.ql-color", "richEditor.textColor"],
  ["select.ql-background", "richEditor.backgroundColor"],
  ["button.ql-clean", "richEditor.clearFormatting"],
] as const;

export function labelRichEditorToolbar(container: HTMLElement): void {
  RICH_EDITOR_TOOLBAR_LABEL_KEYS.forEach(([selector, key]) => {
    const label = i18n.t(key);
    container.querySelectorAll<HTMLElement>(selector).forEach((control) => {
      control.setAttribute("aria-label", label);
      control.setAttribute("title", label);
    });
  });
}

export {RICH_EDITOR_TOOLBAR_LABEL_KEYS};
