/**
 * 共享的格式化动作，以及每个动作在 Markdown 里的含义。
 *
 * 这是「共享」部分：一份动作列表，每项一个标签，用于拼出工具栏。动作如何
 * 施加取决于编辑器：
 *
 *   visual (Quill)  -> Quill 自己的工具栏（保留：图片/视频插入归它所有）
 *   markdown        -> 这些动作把 Markdown 语法插到选区周围
 *
 * Markdown 一律作为文本插入，绝不经过 HTML，所以不发生任何转换、也不会
 * 退化——作者键入的原文就是存储的原文。
 */
export type EditorToolbarAction =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'blockquote'
  | 'code'
  | 'code-block'
  | 'list-bullet'
  | 'list-ordered'
  | 'task-list'
  | 'table'
  | 'horizontal-rule'
  | 'link'
  | 'image'
  | 'autolink'
  | 'header-1'
  | 'header-2'
  | 'header-3'
  | 'header-4'
  | 'header-5'
  | 'header-6';

/** 绑定单个动作的普通工具栏按钮。 */
export interface EditorToolbarButton {
  action: EditorToolbarAction;
  labelKey: string;
}

/**
 * 标题选择器，渲染成一个下拉框（H1–H6）。共享列表里的一项，但派发的是
 * `header-<level>` 动作——作者选级别即可，不必罗列六个独立按钮。
 */
export interface EditorToolbarHeading {
  heading: true;
  /** 下拉框自身的标签（aria-label 与占位选项）。 */
  labelKey: string;
  options: ReadonlyArray<{level: number; labelKey: string}>;
}

export type EditorToolbarItem = EditorToolbarButton | EditorToolbarHeading;

export const EDITOR_TOOLBAR_ACTIONS: ReadonlyArray<EditorToolbarItem> = [
  {
    heading: true,
    labelKey: 'richEditor.heading',
    options: [
      {level: 1, labelKey: 'richEditor.heading1'},
      {level: 2, labelKey: 'richEditor.heading2'},
      {level: 3, labelKey: 'richEditor.heading3'},
      {level: 4, labelKey: 'richEditor.heading4'},
      {level: 5, labelKey: 'richEditor.heading5'},
      {level: 6, labelKey: 'richEditor.heading6'},
    ],
  },
  {action: 'bold', labelKey: 'richEditor.bold'},
  {action: 'italic', labelKey: 'richEditor.italic'},
  {action: 'strikethrough', labelKey: 'richEditor.strikethrough'},
  {action: 'blockquote', labelKey: 'richEditor.blockQuote'},
  {action: 'code', labelKey: 'richEditor.inlineCode'},
  {action: 'code-block', labelKey: 'richEditor.codeBlock'},
  {action: 'list-bullet', labelKey: 'richEditor.bulletedList'},
  {action: 'list-ordered', labelKey: 'richEditor.numberedList'},
  {action: 'task-list', labelKey: 'richEditor.taskList'},
  {action: 'table', labelKey: 'richEditor.table'},
  {action: 'horizontal-rule', labelKey: 'richEditor.horizontalRule'},
  {action: 'link', labelKey: 'richEditor.insertLink'},
  {action: 'image', labelKey: 'richEditor.image'},
  {action: 'autolink', labelKey: 'richEditor.autoLink'},
];

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * 把动作施加到纯文本。保持纯函数（无 DOM）以便单测——编辑器只需交出
 * 值与选区。
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
    case 'strikethrough':
      return wrap(source, start, end, '~~', '~~', '删除线');
    case 'code':
      return wrap(source, start, end, '`', '`', '代码');
    case 'link':
      return wrap(source, start, end, '[', '](https://)', '链接文字');
    case 'code-block':
      return wrapBlock(source, start, end, '```', '```', '代码');
    case 'header-1':
      return applyHeading(source, start, end, 1);
    case 'header-2':
      return applyHeading(source, start, end, 2);
    case 'header-3':
      return applyHeading(source, start, end, 3);
    case 'header-4':
      return applyHeading(source, start, end, 4);
    case 'header-5':
      return applyHeading(source, start, end, 5);
    case 'header-6':
      return applyHeading(source, start, end, 6);
    case 'image':
      return wrap(source, start, end, '![', '](https://)', '图片描述');
    case 'autolink':
      return applyAutoLink(source, start, end);
    case 'blockquote':
      return prefixLines(source, start, end, '> ');
    case 'list-bullet':
      return prefixLines(source, start, end, '- ');
    case 'list-ordered':
      return prefixLines(source, start, end, '1. ');
    case 'task-list':
      return prefixLines(source, start, end, '- [ ] ');
    case 'horizontal-rule':
      return insertBlock(source, start, end, '---');
    case 'table':
      return insertTable(source, start, end);
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

/** 块级动作（``` 围栏）需要文本独占行。 */
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

/**
 * 把一段文本插入到独占行（分割线、表格）。与 `wrapBlock` 不同，选区不被
 * 包裹——块占据其位置。
 *
 * 块前后必须是空行：`---` 紧贴文本行会被 marked 解析成 setext 二级标题，
 * GFM 表格无法打断正文。单个 `\n` 不够——阅读页会把源码原样渲染出来。
 */
function insertBlock(
  source: string,
  start: number,
  end: number,
  block: string,
): TextEdit {
  const head = leadingBlankLines(source, start);
  const tail = trailingBlankLines(source, end);
  const insertion = `${head}${block}${tail}`;
  const insertPos = start + head.length;
  return {
    value: source.slice(0, start) + insertion + source.slice(end),
    selectionStart: insertPos,
    selectionEnd: insertPos + block.length,
  };
}

/**
 * 插入点 `pos` 前要补的空行：前行有内容补 "\n\n"，已有空行分隔则补 ""。
 */
function leadingBlankLines(source: string, pos: number): string {
  if (pos === 0) return '';
  if (source[pos - 1] !== '\n') return '\n\n';
  return pos === 1 || source[pos - 2] === '\n' ? '' : '\n';
}

/**
 * 插入点 `pos` 后要补的空行：后行有内容补 "\n\n"，已有空行分隔则补 ""。
 */
function trailingBlankLines(source: string, pos: number): string {
  if (pos >= source.length) return '';
  if (source[pos] !== '\n') return '\n\n';
  return pos + 1 >= source.length || source[pos + 1] === '\n' ? '' : '\n';
}

/** 插入 GFM 表格模板；光标停在首个数据单元格。 */
function insertTable(
  source: string,
  start: number,
  end: number,
): TextEdit {
  const template = [
    '| 列1 | 列2 | 列3 |',
    '| --- | --- | --- |',
    '| 内容 |  |  |',
  ].join('\n');
  const result = insertBlock(source, start, end, template);
  // 模板是本地常量，必然包含「内容」。
  const placeholderIndex = template.indexOf('内容');
  result.selectionStart += placeholderIndex;
  result.selectionEnd = result.selectionStart + 2;
  return result;
}

/**
 * 选区覆盖的行区间 [lineStart, lineEnd)：空选区时取光标所在行的剩余部分。
 */
function lineRange(
  source: string,
  start: number,
  end: number,
): {lineStart: number; lineEnd: number} {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  // 空选区依然格式化光标所在的那一行。
  const lineEnd = end === start ? endOfLine(source, start) : end;
  return {lineStart, lineEnd};
}

function prefixLines(
  source: string,
  start: number,
  end: number,
  prefix: string,
): TextEdit {
  const {lineStart, lineEnd} = lineRange(source, start, end);
  const lines = source.slice(lineStart, lineEnd).split('\n');
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

/**
 * 对受影响的行设置标题级别：行首已有的 `#{1,6} ` 前缀先被剥掉，再按所选
 * 级别重新加——`## 小节` 选 H1 得 `# 小节`（下拉是设置级别，不切换、
 * 不叠加前缀）。
 */
function applyHeading(
  source: string,
  start: number,
  end: number,
  level: number,
): TextEdit {
  const prefix = '#'.repeat(level) + ' ';
  const {lineStart, lineEnd} = lineRange(source, start, end);
  const lines = source.slice(lineStart, lineEnd).split('\n');
  let oldPrefixLength = 0;
  const next = lines
    .map((line) => {
      const existing = line.match(/^#{1,6}\s+/u);
      if (existing) oldPrefixLength += existing[0].length;
      return prefix + line.replace(/^#{1,6}\s+/u, '');
    })
    .join('\n');
  const delta = prefix.length * lines.length - oldPrefixLength;
  return {
    value: source.slice(0, lineStart) + next + source.slice(lineEnd),
    selectionStart: Math.max(lineStart, start + delta),
    selectionEnd: Math.max(lineStart, end + delta),
  };
}

/**
 * 把 URL 包进尖括号以便 marked 链接它。选中内容不符合 URL 特征时包尖括号
 * 会渲染成字面文本，故回退为普通链接形式——按钮永不产出裸 `<文字>`。
 *
 * `www.` 开头先补 scheme 再包：尖括号 autolink 不认无 scheme 的 `www.`，
 * 直接包会渲染出畸形 HTML（尖括号残留、`>` 被吞进 href）。
 */
function applyAutoLink(
  source: string,
  start: number,
  end: number,
): TextEdit {
  const selected = source.slice(start, end);
  if (selected && !looksLikeUrl(selected)) {
    return wrap(source, start, end, '[', '](https://)', '链接文字');
  }
  const inner = selected
    ? (/^www\./iu.test(selected.trim()) ? `http://${selected.trim()}` : selected)
    : 'https://';
  return {
    value: source.slice(0, start) + '<' + inner + '>' + source.slice(end),
    selectionStart: start + 1,
    selectionEnd: start + 1 + inner.length,
  };
}

function looksLikeUrl(text: string): boolean {
  return /^(?:https?:\/\/|www\.|mailto:)/iu.test(text.trim());
}
