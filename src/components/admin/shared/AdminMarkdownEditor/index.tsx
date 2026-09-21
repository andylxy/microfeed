import {useEffect, useRef, useState, type ChangeEvent} from "react";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import EditorFormatToolbar from "@/components/admin/shared/EditorFormatToolbar";
import {applyMarkdownAction, type EditorToolbarAction} from "@/client/markdownActions";
import {useTranslation} from "@/client/i18n";
import {renderMarkdown} from "@/shared/BodyFormat";

interface Props {
  onChange: (value: string) => void;
  value?: string;
}

/**
 * Markdown source editor with a live preview.
 *
 * `onChange` receives the Markdown source, not HTML — the caller decides what to
 * store. The body keeps its source, so reopening this box shows what was typed
 * rather than a rendering of it.
 */
export default function AdminMarkdownEditor({
  onChange,
  value = "",
}: Props) {
  const {t} = useTranslation();
  const [preview, setPreview] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  // Where the caret should land after an action. The textarea is owned by
  // AdminCodeEditor, so the selection is restored once the new value has been
  // rendered.
  const pendingSelection = useRef<{start: number; end: number} | null>(null);

  const findTextarea = (): HTMLTextAreaElement | null => (
    containerRef.current?.querySelector("textarea") ?? null
  );

  const onCodeChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
  };

  const onToolbarAction = (action: EditorToolbarAction) => {
    const textarea = findTextarea();
    if (!textarea) return;
    const result = applyMarkdownAction(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      action,
    );
    pendingSelection.current = {
      start: result.selectionStart,
      end: result.selectionEnd,
    };
    onChange(result.value);
  };

  useEffect(() => {
    const target = pendingSelection.current;
    if (!target) return;
    pendingSelection.current = null;
    // The code editor writes the new value into the textarea a tick after the
    // render, and assigning `value` moves the caret to the very end. Restore on
    // the next tick, or the selection the action just made is clobbered and the
    // caret jumps to the end of the chapter.
    const timer = window.setTimeout(() => {
      const textarea = findTextarea();
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(target.start, target.end);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [value]);

  const html = renderMarkdown(value);

  return (
    <div className="admin-markdown-editor" ref={containerRef}>
      <EditorFormatToolbar onAction={onToolbarAction} />
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
