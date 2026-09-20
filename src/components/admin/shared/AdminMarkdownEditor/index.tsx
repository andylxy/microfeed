import {useState, type ChangeEvent} from "react";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import {useTranslation} from "@/client/i18n";
import {renderMarkdown} from "@/client/markdown";

interface Props {
  onChange: (value: string) => void;
  value?: string;
}

/**
 * Markdown source editor with a live preview.
 *
 * `onChange` receives the Markdown source, not HTML — the caller decides what to
 * store. (The item editor renders it to HTML for the body and keeps the source
 * for the next edit.)
 */
export default function AdminMarkdownEditor({onChange, value = ""}: Props) {
  const {t} = useTranslation();
  const [preview, setPreview] = useState(true);
  const onCodeChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
  };
  const html = renderMarkdown(value);

  return (
    <div className="admin-markdown-editor">
      <AdminCodeEditor
        ariaLabel={t("shared.markdownSourceAria")}
        code={value}
        fontSize={14.4}
        language="markdown"
        maxHeight="32rem"
        minHeight="16rem"
        onChange={onCodeChange}
        placeholder={t("shared.markdownSourcePlaceholder")}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {t("shared.markdownHint")}
        </span>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            checked={preview}
            onChange={(event) => setPreview(event.target.checked)}
            type="checkbox"
          />
          {t("shared.markdownPreview")}
        </label>
      </div>
      {preview && (
        <div
          className="mt-2 rounded-md border bg-muted/30 px-4 py-3 text-sm"
          // Rendered from the editor's own Markdown: the author is the only one
          // who can put anything here, and the HTML editor accepts raw HTML too,
          // so this is the same trust level as the rest of the admin form.
          dangerouslySetInnerHTML={{
            __html: html || `<p class="text-muted-foreground">${t("shared.markdownEmptyPreview")}</p>`,
          }}
        />
      )}
    </div>
  );
}
