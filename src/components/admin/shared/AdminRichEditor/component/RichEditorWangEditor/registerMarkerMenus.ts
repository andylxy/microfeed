/**
 * wangEditor v5 plugin: one toolbar button per "annotation marker".
 *
 * Clicking a button wraps the current selection in `$<code>{...}` (e.g. select
 * "大承气汤" and click `$f` → `$f{大承气汤}`). The markers are no longer
 * hard-coded here — the editor fetches the live list from
 * `ajax/annotation-markers/list` on mount and calls {@link registerMarkerMenus}
 * with whatever rows exist, so adding a marker in the admin UI shows up on the
 * next page load with no redeploy.
 *
 * Plugin spec (https://www.wangeditor.com/v5/plugins.html):
 *   - toolbar buttons use `IButtonMenu` and are registered via `Boot.registerMenu`;
 *   - `Boot.registerMenu` is global but **throws on a duplicate key**, so
 *     {@link registerMarkerMenus} tracks registered keys and skips them;
 *   - a menu registered before `<Editor>` is created is what makes the button
 *     appear in the toolbar.
 */

import {Boot, SlateEditor} from "@wangeditor/editor";
import type {IButtonMenu, IDomEditor} from "@wangeditor/editor";

export interface MarkerConfig {
  code: string;
  title: string;
  multi?: boolean;
}

/** Toolbar menu key for a marker code, e.g. `marker-f`. */
export function markerMenuKey(code: string): string {
  return `marker-${code}`;
}

/**
 * The four TCM markers seeded into `ext_annotation_markers` by migration 0068.
 * Used as a fallback so the editor always has buttons even if the list fetch
 * fails (e.g. a permission or network hiccup); the live DB list overrides these
 * on a successful fetch.
 */
export const DEFAULT_MARKER_CONFIGS: MarkerConfig[] = [
  {code: "f", title: "$f 方剂"},
  {code: "a", title: "$a 中药"},
  {code: "u", title: "$u 穴位"},
  {code: "x", title: "$x 西医/检验", multi: true},
];

class MarkerButtonMenu implements IButtonMenu {
  readonly title: string;
  readonly iconSvg = ""; // 故意留空：让 wangEditor 直接渲染 title 文字（中文标签）
  readonly tag = "button";
  private readonly code: string;

  constructor(code: string, title: string) {
    this.code = code;
    this.title = title;
  }

  getValue(_editor: IDomEditor): string {
    return "";
  }

  isActive(_editor: IDomEditor): boolean {
    return false;
  }

  isDisabled(editor: IDomEditor): boolean {
    return editor.selection == null;
  }

  exec(editor: IDomEditor, _value: string | boolean): void {
    const selection = editor.selection;
    if (selection == null) return;
    const selectedText = editor.getSelectionText();
    editor.focus();
    if (selectedText.length > 0) {
      SlateEditor.deleteFragment(editor);
    }
    const open = `$${this.code}{`;
    const close = "}";
    editor.insertText(open);
    if (selectedText.length > 0) {
      editor.insertText(selectedText);
    }
    editor.insertText(close);
    if (selectedText.length === 0) {
      // No selection: leave the cursor inside the braces so the author can type.
      editor.move(-1);
    }
  }
}

/**
 * Register toolbar buttons for the given markers. Safe to call repeatedly
 * (on every editor mount) — keys already registered are skipped, because
 * wangEditor's `Boot.registerMenu` **throws** on a duplicate key
 * ("Duplicated key '...' in menu items") rather than replacing the
 * constructor, and a throw here would abort the live-list refresh.
 *
 * Registration must happen before `<Editor>` is created for the buttons to
 * show. Note wangEditor has no unregister API, so a *renamed* title for an
 * already-registered key keeps the old label until the next full page load
 * (which re-imports this module fresh).
 */
const registeredMenuKeys = new Set<string>();

export function registerMarkerMenus(configs: MarkerConfig[]): void {
  for (const cfg of configs) {
    const key = markerMenuKey(cfg.code);
    if (registeredMenuKeys.has(key)) continue;
    Boot.registerMenu({
      key,
      factory: () => new MarkerButtonMenu(cfg.code, cfg.title),
    });
    registeredMenuKeys.add(key);
  }
}

// Side-effect: guarantee the four seed markers are registered as early as this
// module loads, so the very first editor render (before the list fetch resolves)
// already shows buttons.
registerMarkerMenus(DEFAULT_MARKER_CONFIGS);
