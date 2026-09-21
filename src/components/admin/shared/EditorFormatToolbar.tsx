import {EDITOR_TOOLBAR_ACTIONS, type EditorToolbarAction} from "@/client/markdownActions";
import {useTranslation} from "@/client/i18n";

interface Props {
  onAction: (action: EditorToolbarAction) => void;
}

/**
 * One toolbar, built from the shared action list.
 *
 * The visual editor keeps Quill's own toolbar, because that is what owns image
 * and video insertion; this component gives the Markdown editor the same
 * vocabulary (bold, italic, quote, lists, code, link, headings). Same actions,
 * same labels, no duplicated markup and no HTML round trip for Markdown.
 */
export default function EditorFormatToolbar({onAction}: Props) {
  const {t} = useTranslation();
  return (
    <div
      className="mb-3 flex flex-wrap gap-1 rounded-[10px] border bg-muted/40 p-1.5"
      role="toolbar"
    >
      {EDITOR_TOOLBAR_ACTIONS.map(({action, labelKey}) => (
        <button
          aria-label={t(labelKey)}
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
          key={action}
          onClick={() => onAction(action)}
          title={t(labelKey)}
          type="button"
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
