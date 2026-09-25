import React from "react";

import i18n from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {MAX_ITEMS_PER_PAGE, STATUSES} from "@/shared/Constants";
import {
  buildChapterImportItem,
  splitChapters,
  type ChapterDraft,
} from "@/shared/novelChapterImport";

/**
 * Admin tool behind the "txt 分章导入" page.
 *
 * Both sources (a pasted textarea and an uploaded `.txt` file) end up as the
 * same plain string, are split by the dependency-free `splitChapters` parser,
 * and are then created one at a time through the dashboard's own
 * `ajax/feed` endpoint - the same contract `EditItemApp` uses. Going through
 * the dashboard endpoint rather than the public API keeps the admin session as
 * the only credential: no API token is ever placed in the browser.
 *
 * Reading the uploaded file in the browser (instead of staging it in R2 first)
 * means the tool has no R2 prerequisite and no upload round-trip; a novel `.txt`
 * is text, so nothing is gained by a detour through object storage.
 */
interface Props {
  mediaStorageReady?: boolean;
}

interface State {
  drafts: ChapterDraft[];
  importing: boolean;
  progress: number;
  source: "file" | "paste";
  text: string;
}

const MAX_PREVIEW = 8;

// C12: a rerun after a partial failure used to create every chapter again —
// the import had no dedup at all. Imported chapters carry no server-side
// identity beyond their title, so the dedup key is the normalized title:
// existing non-deleted items are paged through the admin list once before the
// run, and every created chapter joins the set, which also makes duplicates
// within a single run impossible.
const chapterKey = (title: string) => title.trim().toLowerCase();

async function fetchExistingChapterKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | number | undefined;
  // Hard page cap: 20 × 300 items covers any single novel; beyond that the
  // loop stops deduplicating rather than spinning forever. Any fetch failure
  // degrades to an empty set — dedup is best-effort and must never block the
  // import itself.
  for (let page = 0; page < 20; page += 1) {
    try {
      const url = new URL(ADMIN_URLS.ajaxItems(), window.location.origin);
      url.searchParams.set("status", "all");
      url.searchParams.set("limit", String(MAX_ITEMS_PER_PAGE));
      if (cursor !== undefined) url.searchParams.set("next_cursor", String(cursor));
      const response = await fetch(url.toString(), {headers: {accept: "application/json"}});
      if (!response.ok) break;
      const data = await response.json() as {
        items?: Array<{title?: unknown}>;
        nextCursor?: string | number;
      };
      for (const item of data.items ?? []) {
        if (typeof item.title === "string") keys.add(chapterKey(item.title));
      }
      cursor = data.nextCursor;
      if (cursor === undefined) break;
    } catch {
      break;
    }
  }
  return keys;
}

export default class ImportChaptersApp extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      drafts: [],
      importing: false,
      progress: 0,
      source: "paste",
      text: "",
    };
    this.onTextChange = this.onTextChange.bind(this);
    this.onFileChange = this.onFileChange.bind(this);
    this.onParse = this.onParse.bind(this);
    this.onImport = this.onImport.bind(this);
  }

  onTextChange(text: string) {
    // Any edit invalidates a previous preview: the drafts must always describe
    // the text currently on screen.
    this.setState({drafts: [], progress: 0, source: "paste", text});
  }

  async onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      this.setState({drafts: [], progress: 0, source: "file", text});
    } catch {
      showToast(i18n.t("importChapters.fileReadFailed"), "error");
    }
  }

  onParse() {
    const drafts = splitChapters(this.state.text);
    this.setState({drafts, progress: 0});
    if (drafts.length === 0) {
      showToast(i18n.t("importChapters.noChapters"), "error");
    }
  }

  async onImport() {
    const {drafts} = this.state;
    if (drafts.length === 0 || this.state.importing) return;
    this.setState({importing: true, progress: 0});

    // One base timestamp for the whole import; chapters get strictly increasing
    // offsets so they sort in serial order (the book chapter list orders by
    // `pub_date` ascending — chapter 1 must be the earliest). Spacing by index
    // instead of `Date.now()` per chapter avoids same-millisecond ties that
    // would otherwise make the order non-deterministic (A3).
    const publishBase = Date.now();
    const existingKeys = await fetchExistingChapterKeys();
    let created = 0;
    let failed = 0;
    let skipped = 0;
    for (let index = 0; index < drafts.length; index++) {
      const draft = drafts[index]!;
      const key = chapterKey(draft.title);
      if (existingKeys.has(key)) {
        skipped += 1;
        this.setState({progress: created + failed + skipped});
        continue;
      }
      try {
        const response = await fetch(ADMIN_URLS.ajaxFeed(), {
          body: JSON.stringify({
            item: buildChapterImportItem(
              draft,
              publishBase + index * 1000,
              STATUSES.PUBLISHED,
            ),
          }),
          headers: {"Content-Type": "application/json"},
          method: "POST",
        });
        if (!response.ok) throw new Error(String(response.status));
        existingKeys.add(key);
        created += 1;
      } catch {
        // Keep going: a single bad chapter should not abandon the rest of a
        // several-hundred-chapter import. The counters report what happened.
        failed += 1;
      }
      this.setState({progress: created + failed + skipped});
    }

    this.setState({importing: false});
    const allClean = failed === 0 && skipped === 0;
    showToast(
      allClean
        ? i18n.t("importChapters.importDone", {count: created})
        : i18n.t("importChapters.importMixed", {created, failed, skipped}),
      allClean ? "success" : "error",
    );
  }

  render() {
    const t = i18n.t.bind(i18n);
    const {drafts, importing, progress, text} = this.state;
    const preview = drafts.slice(0, MAX_PREVIEW);

    return (<div className="flex flex-col gap-6">
      <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
        <h2 className="text-lg font-semibold">{t("importChapters.sourceTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("importChapters.sourceIntro")}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            accept=".txt,text/plain"
            className="text-sm"
            onChange={this.onFileChange}
            type="file"
          />
        </div>
        <textarea
          className="mt-4 min-h-64 w-full rounded-md border bg-background p-3 font-mono text-xs"
          onChange={(e) => this.onTextChange(e.target.value)}
          placeholder={t("importChapters.pastePlaceholder")}
          value={text}
        />
        <div className="mt-4 flex items-center gap-3">
          <Button
            disabled={text.trim().length === 0 || importing}
            onClick={this.onParse}
            type="button"
          >
            {t("importChapters.parse")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("importChapters.charCount", {count: text.length})}
          </span>
        </div>
      </div>

      {drafts.length > 0 && <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
        <h2 className="text-lg font-semibold">
          {t("importChapters.previewTitle", {count: drafts.length})}
        </h2>
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {preview.map((draft, index) => (<li className="flex gap-2" key={index}>
            <span className="text-muted-foreground">{index + 1}.</span>
            <span className="font-medium">{draft.title}</span>
            {draft.volume && <span className="text-muted-foreground">
              ({draft.volume})
            </span>}
          </li>))}
        </ul>
        {drafts.length > preview.length && <p className="mt-2 text-sm text-muted-foreground">
          {t("importChapters.previewMore", {count: drafts.length - preview.length})}
        </p>}
        <div className="mt-4 flex items-center gap-3">
          <Button
            disabled={importing}
            onClick={this.onImport}
            type="button"
          >
            {importing
              ? t("importChapters.importing", {done: progress, total: drafts.length})
              : t("importChapters.import", {count: drafts.length})}
          </Button>
        </div>
      </div>}
    </div>);
  }
}
