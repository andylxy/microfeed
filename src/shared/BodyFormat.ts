import {marked} from "marked";
// Relative, not "@/shared/...": theme-kit runs through plain tsx, which cannot
// resolve the alias.
import {htmlToPlainText} from "./StringUtils";

/**
 * A chapter body is stored in whichever form it was written.
 *
 * It used to be that everything was stored as HTML and Markdown was rendered at
 * save time. That loses the source: HTML → Markdown (to reopen the editor) is
 * lossy, and a couple of round trips visibly degrades the text. So now the body
 * keeps its original form and rendering happens on the way out:
 *
 *   markdown  → `description` holds Markdown, rendered to HTML for display
 *   html      → `description` holds HTML, used as-is
 *
 * `data.content_format` records which. Anything without it is HTML, which is
 * what every chapter written before this existed already is.
 *
 * NOTE: this module must not import through the `@/` alias — `theme-kit` is run
 * with plain `tsx` and cannot resolve it.
 */
export const BODY_FORMAT_HTML = "html";
export const BODY_FORMAT_MARKDOWN = "markdown";

export type BodyFormat = typeof BODY_FORMAT_HTML | typeof BODY_FORMAT_MARKDOWN;

marked.setOptions({
  // Single newlines become <br>: prose is written line by line.
  breaks: true,
  gfm: true,
});

/** The stored format of a body. Unknown or missing means HTML. */
export function bodyFormat(value: unknown): BodyFormat {
  return String(value ?? "").trim().toLowerCase() === BODY_FORMAT_MARKDOWN
    ? BODY_FORMAT_MARKDOWN
    : BODY_FORMAT_HTML;
}

/** Render Markdown to HTML. Never throws; empty input yields "". */
export function renderMarkdown(source: string): string {
  const markdown = String(source ?? "").trim();
  if (!markdown) return "";
  try {
    return marked.parse(markdown, {async: false}) as string;
  } catch {
    return "";
  }
}

/** The body as HTML, ready to display. Markdown is rendered; HTML passes through. */
export function bodyToHtml(body: unknown, format: unknown): string {
  const source = String(body ?? "");
  if (!source.trim()) return "";
  return bodyFormat(format) === BODY_FORMAT_MARKDOWN
    ? renderMarkdown(source)
    : source;
}

/**
 * The body as plain text, for the search index and word counts.
 *
 * Markdown is rendered first, otherwise the index would be full of `#` and `**`
 * and searching for a word would miss it.
 */
export function bodyToPlainText(body: unknown, format: unknown): string {
  // Render first (Markdown), then reuse the existing conversion so entities,
  // block spacing and the rest behave exactly like they always have. Hand-rolling
  // this here is how `&amp;` ends up in the search index.
  return htmlToPlainText(bodyToHtml(body, format));
}
