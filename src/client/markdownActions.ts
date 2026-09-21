/**
 * The shared formatting actions, and what each one means in Markdown.
 *
 * This is the "shared" part: one list of actions with one label each, used to
 * build a toolbar. How an action is applied depends on the editor:
 *
 *   visual (Quill)  -> Quill's own toolbar (kept: it owns image/video insertion)
 *   markdown        -> these actions insert Markdown syntax around the selection
 *
 * Markdown is inserted as text, never through HTML, so nothing is converted and
 * nothing can degrade — the source the author typed is the source that is stored.
 */
export type EditorToolbarAction =
  | 'bold'
  | 'italic'
  | 'blockquote'
  | 'code'
  | 'code-block'
  | 'list-bullet'
  | 'list-ordered'
  | 'link'
  | 'header-2'
  | 'header-3';

export const EDITOR_TOOLBAR_ACTIONS: ReadonlyArray<{
  action: EditorToolbarAction;
  labelKey: string;
}> = [
  {action: 'header-2', labelKey: 'richEditor.heading2'},
  {action: 'header-3', labelKey: 'richEditor.heading3'},
  {action: 'bold', labelKey: 'richEditor.bold'},
  {action: 'italic', labelKey: 'richEditor.italic'},
  {action: 'blockquote', labelKey: 'richEditor.blockQuote'},
  {action: 'code', labelKey: 'richEditor.inlineCode'},
  {action: 'code-block', labelKey: 'richEditor.codeBlock'},
  {action: 'list-bullet', labelKey: 'richEditor.bulletedList'},
  {action: 'list-ordered', labelKey: 'richEditor.numberedList'},
  {action: 'link', labelKey: 'richEditor.insertLink'},
];

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Apply an action to plain text. Kept pure (no DOM) so it can be unit tested —
 * the editor only has to hand over the value and the selection.
 */
export function applyMarkdownAction(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  action: EditorToolbarAction,
): TextEdit {
  const source = String(value ?? '');
  const start = clamp(selectionStart, 0, source.length);
  const end = clamp(selectionEnd, start, source.length);

  switch (action) {
    case 'bold':
      return wrap(source, start, end, '**', '**', '粗体');
    case 'italic':
      return wrap(source, start, end, '*', '*', '斜体');
    case 'code':
      return wrap(source, start, end, '`', '`', '代码');
    case 'link':
      return wrap(source, start, end, '[', '](https://)', '链接文字');
    case 'code-block':
      return wrapBlock(source, start, end, '```', '```', '代码');
    case 'header-2':
      return prefixLines(source, start, end, '## ');
    case 'header-3':
      return prefixLines(source, start, end, '### ');
    case 'blockquote':
      return prefixLines(source, start, end, '> ');
    case 'list-bullet':
      return prefixLines(source, start, end, '- ');
    case 'list-ordered':
      return prefixLines(source, start, end, '1. ');
    default:
      return {value: source, selectionStart: start, selectionEnd: end};
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function wrap(
  source: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): TextEdit {
  const selected = source.slice(start, end) || placeholder;
  return {
    value: source.slice(0, start) + before + selected + after + source.slice(end),
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length,
  };
}

/** Block actions (``` fences) need the text on its own lines. */
function wrapBlock(
  source: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): TextEdit {
  const selected = source.slice(start, end) || placeholder;
  const needsLeadingBreak = start > 0 && source[start - 1] !== '\n';
  const needsTrailingBreak = end < source.length && source[end] !== '\n';
  const head = `${needsLeadingBreak ? '\n' : ''}${before}\n`;
  const tail = `\n${after}${needsTrailingBreak ? '\n' : ''}`;
  return {
    value: source.slice(0, start) + head + selected + tail + source.slice(end),
    selectionStart: start + head.length,
    selectionEnd: start + head.length + selected.length,
  };
}

function prefixLines(
  source: string,
  start: number,
  end: number,
  prefix: string,
): TextEdit {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  // An empty selection still formats the line the caret sits on.
  const lineEnd = end === start
    ? endOfLine(source, start)
    : end;
  const block = source.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const alreadyPrefixed = lines.every((line) => line.startsWith(prefix));
  const next = lines
    .map((line) => (
      alreadyPrefixed
        ? line.slice(prefix.length)
        : prefix + line
    ))
    .join('\n');
  const prefixDelta = alreadyPrefixed ? -prefix.length : prefix.length;
  return {
    value: source.slice(0, lineStart) + next + source.slice(lineEnd),
    selectionStart: Math.max(lineStart, start + prefixDelta),
    selectionEnd: Math.max(lineStart, end + prefixDelta * lines.length),
  };
}

function endOfLine(source: string, index: number): number {
  const newline = source.indexOf('\n', index);
  return newline === -1 ? source.length : newline;
}
