// Relative, not "@/shared/...": theme-kit runs through plain tsx, which cannot
// resolve the alias.
import {unescapeHtml} from "./StringUtils";

/**
 * HTML → Markdown, for the one moment a chapter changes hands.
 *
 * A body is stored in the form it was authored (`BodyFormat.ts`), so converting
 * is never part of saving — it runs once, when an author explicitly switches an
 * HTML chapter to Markdown. That single conversion is lossy in the ways Markdown
 * itself is lossy, and the author is warned before it runs (the confirm step in
 * `AdminRichEditor`).
 *
 * Kept: paragraphs, headings, bold/italic, inline code, fenced code blocks,
 * quotes, ordered/unordered lists, links, images, strikethrough.
 * Kept as raw HTML because Markdown has no syntax for it: underline,
 * subscript/superscript, video.
 * Lost: text colour, background, alignment, indent — the text survives, the
 * styling does not.
 *
 * Pure string in, string out: no DOM, so it runs and is tested in plain node.
 */

/** Tags that end the line they sit in. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "td", "th", "tr", "ul",
]);

const VOID_TAGS = new Set(["br", "hr", "img", "input", "source", "track"]);

/** Inline tags with a Markdown spelling. */
const INLINE_MARKERS: Record<string, string | undefined> = {
  b: "**",
  del: "~~",
  em: "*",
  i: "*",
  s: "~~",
  strike: "~~",
  strong: "**",
};

/** Tags Markdown cannot express, passed through verbatim. */
const PASSTHROUGH_TAGS = new Set(["sub", "sup", "u"]);

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:"[^"]*"|'[^']*'|[^>"'])*\/?>/gu;

const MARKDOWN_SPECIALS = /([\\`*_[\]])/gu;

interface Frame {
  href?: string;
  kind: "heading" | "inline" | "link" | "list" | "pre" | "quote";
  level?: number;
  marker?: string;
  ordered?: boolean;
  start?: number;
}

interface Tag {
  attrs: Record<string, string>;
  closing: boolean;
  name: string;
  selfClosing: boolean;
}

function parseTag(raw: string): Tag {
  const closing = raw.startsWith("</");
  const body = raw.replace(/^<\/?/u, "").replace(/\/?>$/u, "");
  const name = (/^([a-zA-Z][a-zA-Z0-9-]*)/u.exec(body)?.[1] ?? "").toLowerCase();
  const attrs: Record<string, string> = {};
  const attrPattern =
    /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(body)) !== null) {
    attrs[match[1]!.toLowerCase()] = unescapeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return {
    attrs,
    closing,
    name,
    selfClosing: /\/>$/u.test(raw) || VOID_TAGS.has(name),
  };
}

/** Escape the characters that would otherwise turn into Markdown syntax. */
function escapeText(text: string): string {
  return text.replace(MARKDOWN_SPECIALS, "\\$1");
}

/** Only a *leading* marker is ambiguous, so only a leading one is escaped. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)([#>])/u, "$1\\$2")
    .replace(/^(\s*)([-+])(?= )/u, "$1\\$2")
    .replace(/^(\s*)(\d+)\.(?= )/u, "$1$2\\.");
}

function tidy(value: string): string {
  return value.replace(/[^\S\n]+$/gmu, "").replace(/\n{3,}/gu, "\n\n").trim();
}

function htmlToMarkdown(html: unknown): string {
  const source = String(html ?? "");
  if (!source.trim()) return "";

  // The two elements whose content is never prose.
  const cleaned = source
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<!--[\s\S]*?-->/gu, "");

  const blocks: string[] = [];
  const listItems: string[] = [];
  const stack: Frame[] = [];
  let line = "";
  let listDepth = 0;
  let inListItem = false;

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(listItems.join("\n"));
    listItems.length = 0;
  };

  const pushBlock = (value: string) => {
    flushList();
    blocks.push(value);
  };

  /**
   * End the current line. A list item joins the pending list block so that items
   * stay consecutive lines — a blank line between them would end the list.
   */
  const flushLine = () => {
    const value = escapeLineStart(tidy(line));
    line = "";
    if (!value) return;
    if (inListItem) {
      const indent = "  ".repeat(Math.max(0, listDepth - 1));
      const ordered = nearestList()?.ordered ?? false;
      const prefix = `${indent}${ordered ? "1. " : "- "}`;
      listItems.push(
        `${prefix}${value.replace(/\n/gu, `\n${" ".repeat(prefix.length)}`)}`,
      );
      return;
    }
    pushBlock(value);
  };

  const nearestList = () => (
    [...stack].reverse().find((frame) => frame.kind === "list")
  );

  /** Close the nearest matching frame, dropping anything malformed above it. */
  const closeFrame = (
    predicate: (frame: Frame) => boolean,
  ): Frame | undefined => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (predicate(stack[index]!)) {
        const [frame] = stack.splice(index, 1);
        return frame;
      }
    }
    return undefined;
  };

  const tokens = cleaned.match(TAG_PATTERN) ?? [];
  let cursor = 0;
  for (const token of tokens) {
    const index = cleaned.indexOf(token, cursor);
    const inPre = stack.some((frame) => frame.kind === "pre");
    const inCode = inPre || stack.some(
      (frame) => frame.kind === "inline" && frame.marker === "`",
    );
    if (index > cursor) {
      const text = unescapeHtml(cleaned.slice(cursor, index));
      // Inside code the markup is literal: escaping it would change the code.
      line += inCode ? text : escapeText(text);
    }
    cursor = index + token.length;

    if (!token.startsWith("<")) continue;
    const tag = parseTag(token);
    if (!tag.name) continue;

    if (inPre && tag.name !== "pre") {
      if (tag.name === "br") line += "\n";
      continue;
    }

    if (tag.name === "br") {
      line += "\n";
      continue;
    }

    if (tag.name === "hr") {
      flushLine();
      pushBlock("---");
      continue;
    }

    if (tag.name === "img") {
      const src = tag.attrs.src ?? "";
      if (src) line += `![${tag.attrs.alt ?? ""}](${src})`;
      continue;
    }

    if (tag.name === "video") {
      const src = tag.attrs.src ?? "";
      const poster = tag.attrs.poster ? ` poster="${tag.attrs.poster}"` : "";
      line += `<video src="${src}"${poster} controls></video>`;
      continue;
    }

    if (tag.name === "a") {
      if (tag.closing) {
        const frame = closeFrame((item) => item.kind === "link");
        if (frame) {
          const at = frame.start ?? 0;
          line = `${line.slice(0, at)}[${line.slice(at)}](${frame.href ?? ""})`;
        }
      } else {
        stack.push({href: tag.attrs.href ?? "", kind: "link", start: line.length});
      }
      continue;
    }

    if (tag.name === "pre") {
      if (tag.closing) {
        const frame = closeFrame((item) => item.kind === "pre");
        if (frame) {
          const body = line.replace(/^\n+|\n+$/gu, "");
          line = "";
          pushBlock(`\`\`\`\n${body}\n\`\`\``);
        }
      } else {
        flushLine();
        stack.push({kind: "pre"});
        line = "";
      }
      continue;
    }

    if (tag.name === "blockquote") {
      if (tag.closing) {
        const frame = closeFrame((item) => item.kind === "quote");
        if (frame) {
          flushLine();
          // The inner paragraphs were pushed as blocks; quote them as one unit.
          const inner = blocks.splice(frame.start ?? 0);
          if (inner.length) {
            pushBlock(
              inner.join("\n\n")
                .split("\n")
                .map((row) => (row ? `> ${row}` : ">"))
                .join("\n"),
            );
          }
        }
      } else {
        flushLine();
        stack.push({kind: "quote", start: blocks.length});
      }
      continue;
    }

    if (tag.name === "ol" || tag.name === "ul") {
      if (tag.closing) {
        flushLine();
        closeFrame((item) => item.kind === "list");
        listDepth = Math.max(0, listDepth - 1);
      } else {
        flushLine();
        listDepth += 1;
        stack.push({kind: "list", ordered: tag.name === "ol"});
      }
      continue;
    }

    if (tag.name === "li") {
      if (tag.closing) {
        flushLine();
        inListItem = false;
      } else {
        flushLine();
        inListItem = true;
      }
      continue;
    }

    const headingLevel = /^h([1-6])$/u.exec(tag.name)?.[1];
    if (headingLevel) {
      if (tag.closing) {
        const frame = closeFrame((item) => item.kind === "heading");
        if (frame) {
          const value = tidy(line);
          line = "";
          if (value) pushBlock(`${"#".repeat(frame.level ?? 1)} ${value}`);
        }
      } else {
        flushLine();
        stack.push({kind: "heading", level: Number(headingLevel)});
      }
      continue;
    }

    if (tag.name === "code" && !inPre) {
      if (tag.closing) {
        const frame = closeFrame((item) => item.kind === "inline");
        if (frame?.marker === "`") {
          const at = frame.start ?? 0;
          const body = line.slice(at).replace(/`/gu, "\\`");
          line = `${line.slice(0, at)}\`${body}\``;
        }
      } else {
        stack.push({kind: "inline", marker: "`", start: line.length});
      }
      continue;
    }

    const marker = INLINE_MARKERS[tag.name];
    if (marker !== undefined) {
      if (tag.closing) {
        const frame = closeFrame(
          (item) => item.kind === "inline" && item.marker === marker,
        );
        if (frame) {
          const at = frame.start ?? 0;
          const body = line.slice(at);
          // Emphasis markers need the content to be non-empty to be recognised.
          line = body
            ? `${line.slice(0, at)}${marker}${body}${marker}`
            : line;
        }
      } else {
        stack.push({kind: "inline", marker, start: line.length});
      }
      continue;
    }

    if (PASSTHROUGH_TAGS.has(tag.name)) {
      line += tag.closing ? `</${tag.name}>` : `<${tag.name}>`;
      continue;
    }

    if (BLOCK_TAGS.has(tag.name) && (tag.closing || tag.selfClosing)) {
      flushLine();
      continue;
    }
  }

  if (cursor < cleaned.length) {
    const rest = unescapeHtml(cleaned.slice(cursor));
    const inCode = stack.some(
      (frame) => frame.kind === "pre"
        || (frame.kind === "inline" && frame.marker === "`"),
    );
    line += inCode ? rest : escapeText(rest);
  }
  flushLine();
  flushList();

  return tidy(blocks.join("\n\n"));
}

export {htmlToMarkdown};
