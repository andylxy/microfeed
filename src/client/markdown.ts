import {marked} from "marked";

/**
 * Markdown → HTML for the admin editors.
 *
 * The item body is stored as HTML (`data.description`) because that is what the
 * public feed, the reader themes, the search index and the RSS/JSON feeds all
 * consume. A Markdown editor therefore renders to HTML on save, exactly like the
 * visual and HTML-source editors do — the stored shape never changes.
 *
 * The Markdown source itself is kept alongside it (`data.content_markdown`) so
 * the body can be re-opened and edited as Markdown instead of being round-tripped
 * through HTML and slowly degraded.
 */
marked.setOptions({
  // Single newlines become <br>: that is how people expect a novel chapter to
  // read, and how every Markdown editor behaves.
  breaks: true,
  gfm: true,
});

/** Render Markdown to HTML. Never throws: an empty or broken input yields "". */
export function renderMarkdown(source: string): string {
  const markdown = String(source ?? "").trim();
  if (!markdown) return "";
  try {
    return marked.parse(markdown, {async: false}) as string;
  } catch {
    return "";
  }
}
