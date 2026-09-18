import {useState} from "react";
import {useTranslation} from "@/client/i18n";
import i18n from "@/client/i18n";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import {Button} from "@/components/ui/button";
import {
  type ThemeBundleV1,
  type ThemeFileKey,
} from "@/shared/themes/ThemeContract";

const FILE_LABELS: Record<ThemeFileKey, string> = {
  rssStylesheet: i18n.t("codeEditor.files.rssStylesheet"),
  webBodyEnd: i18n.t("codeEditor.files.webBodyEnd"),
  webBodyStart: i18n.t("codeEditor.files.webBodyStart"),
  webCategory: i18n.t("codeEditor.files.webCategory"),
  webFeed: i18n.t("codeEditor.files.webFeed"),
  webHeader: i18n.t("codeEditor.files.webHeader"),
  webItem: i18n.t("codeEditor.files.webItem"),
  webPage: i18n.t("codeEditor.files.webPage"),
  webSearch: i18n.t("codeEditor.files.webSearch"),
  webHome: i18n.t("codeEditor.files.webHome"),
};

export const THEME_EDITOR_FILE_KEYS: readonly ThemeFileKey[] = [
  "webFeed",
  "webItem",
  "webPage",
  "webSearch",
  "webHome",
  "webHeader",
  "webBodyStart",
  "webBodyEnd",
  "rssStylesheet",
];

export interface ThemeEditorLinks {
  jsonFeedUrl: string;
  rssFeedUrl: string;
  webFeedUrl: string;
  webItemUrl?: string;
  webPageUrl?: string;
  webSearchUrl?: string;
}

interface ThemeFileHelp {
  description: string;
  exampleLabel: string;
  exampleUrlKey: Exclude<keyof ThemeEditorLinks, "jsonFeedUrl">;
}

export const THEME_FILE_HELP: Record<ThemeFileKey, ThemeFileHelp> = {
  rssStylesheet: {
    description: i18n.t("codeEditor.help.rssStylesheetDesc"),
    exampleLabel: i18n.t("codeEditor.help.rssStylesheetLabel"),
    exampleUrlKey: "rssFeedUrl",
  },
  webBodyEnd: {
    description: i18n.t("codeEditor.help.webBodyEndDesc"),
    exampleLabel: i18n.t("codeEditor.help.webBodyEndLabel"),
    exampleUrlKey: "webFeedUrl",
  },
  webBodyStart: {
    description: i18n.t("codeEditor.help.webBodyStartDesc"),
    exampleLabel: i18n.t("codeEditor.help.webBodyStartLabel"),
    exampleUrlKey: "webFeedUrl",
  },
  webCategory: {
    description: i18n.t("codeEditor.help.webCategoryDesc"),
    exampleLabel: i18n.t("codeEditor.help.webCategoryLabel"),
    exampleUrlKey: "webFeedUrl",
  },
  webFeed: {
    description: i18n.t("codeEditor.help.webFeedDesc"),
    exampleLabel: i18n.t("codeEditor.help.webFeedLabel"),
    exampleUrlKey: "webFeedUrl",
  },
  webHeader: {
    description: i18n.t("codeEditor.help.webHeaderDesc"),
    exampleLabel: i18n.t("codeEditor.help.webHeaderLabel"),
    exampleUrlKey: "webFeedUrl",
  },
  webItem: {
    description: i18n.t("codeEditor.help.webItemDesc"),
    exampleLabel: i18n.t("codeEditor.help.webItemLabel"),
    exampleUrlKey: "webItemUrl",
  },
  webPage: {
    description: i18n.t("codeEditor.help.webPageDesc"),
    exampleLabel: i18n.t("codeEditor.help.webPageLabel"),
    exampleUrlKey: "webPageUrl",
  },
  webSearch: {
    description: i18n.t("codeEditor.help.webSearchDesc"),
    exampleLabel: i18n.t("codeEditor.help.webSearchLabel"),
    exampleUrlKey: "webSearchUrl",
  },
  webHome: {
    description: i18n.t("codeEditor.help.webHomeDesc"),
    exampleLabel: i18n.t("codeEditor.help.webHomeLabel"),
    exampleUrlKey: "webFeedUrl",
  },
};

interface Props {
  bundle: ThemeBundleV1;
  links: ThemeEditorLinks;
  onChange: (bundle: ThemeBundleV1) => void;
}

export default function ThemeBundleEditor({bundle, links, onChange}: Props) {
  const {t} = useTranslation();
  const fileKeys = THEME_EDITOR_FILE_KEYS.filter((key) =>
    typeof bundle[key] === "string"
  );
  const hash = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  const initial = fileKeys.includes(hash as ThemeFileKey)
    ? hash as ThemeFileKey
    : fileKeys[0] ?? "webFeed";
  const [file, setFile] = useState<ThemeFileKey>(initial);
  const help = THEME_FILE_HELP[file];
  const exampleUrl = links[help.exampleUrlKey];
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[12rem_minmax(0,1fr)] md:items-start">
      <nav
        aria-label={t("codeEditor.themeFiles")}
        className="flex max-w-full flex-nowrap gap-1 overflow-x-auto rounded-[14px] border bg-card p-2 shadow-xs md:flex-col md:overflow-visible"
      >
        {fileKeys.map((key) => (
          <Button
            aria-pressed={file === key}
            className="shrink-0 md:w-full md:justify-start"
            key={key}
            size="sm"
            type="button"
            variant={file === key ? "default" : "ghost"}
            onClick={() => {
              setFile(key);
              window.history.replaceState(null, "", `#${key}`);
            }}
          >
            {FILE_LABELS[key]}
          </Button>
        ))}
      </nav>
      <div className="min-w-0">
        <div className="mb-3 grid gap-1 text-xs leading-relaxed text-muted-foreground">
          <p>{help.description}</p>
          <p className="flex flex-wrap gap-x-2">
            <span>
              {t("codeEditor.mustacheNoteStart")}
              <a
                className="font-medium text-primary underline-offset-4 hover:underline"
                href="https://mustache.github.io/"
                rel="noopener noreferrer"
                target="_blank"
              >
                Mustache
              </a>
              {t("codeEditor.mustacheNoteMid")}
              <a
                className="font-medium text-primary underline-offset-4 hover:underline"
                href={links.jsonFeedUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("codeEditor.mustacheJsonFeed")}
              </a>
              {t("codeEditor.mustacheNoteEnd")}
            </span>
            {exampleUrl && (
              <a
                className="font-medium text-primary underline-offset-4 hover:underline"
                href={exampleUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {help.exampleLabel}
              </a>
            )}
          </p>
        </div>
        {file === "webHeader" && bundle.webHeader.includes("microfeed-design-tokens") && (
          <p className="mb-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
            {t("codeEditor.designTokensNote")}
          </p>
        )}
        <AdminCodeEditor
          ariaLabel={`${FILE_LABELS[file]} ${t("codeEditor.editorSuffix")}`}
          code={bundle[file] ?? ""}
          language={file === "rssStylesheet" ? "xml" : "html"}
          minHeight="54vh"
          onChange={(event) => onChange({...bundle, [file]: event.target.value})}
          placeholder={file === "rssStylesheet"
            ? t("codeEditor.placeholderXml")
            : t("codeEditor.placeholderHtml")}
        />
      </div>
    </div>
  );
}
