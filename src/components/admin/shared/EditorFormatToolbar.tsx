import {EDITOR_TOOLBAR_ACTIONS, type EditorToolbarAction} from "@/client/markdownActions";
import {useTranslation} from "@/client/i18n";

interface Props {
  onAction: (action: EditorToolbarAction) => void;
}

/**
 * 一个工具栏，由共享动作列表拼成。
 *
 * 可视化编辑器保留 Quill 自己的工具栏，因为图片与视频插入归它所有；本组件
 * 给 Markdown 编辑器同一套词汇（粗体、斜体、引用、列表、代码、链接、标题）。
 * 同样的动作、同样的标签，无重复标记，Markdown 也不绕道 HTML。
 */
export default function EditorFormatToolbar({onAction}: Props) {
  const {t} = useTranslation();
  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-1 rounded-[10px] border bg-muted/40 p-1.5"
      role="toolbar"
    >
      {EDITOR_TOOLBAR_ACTIONS.map((item, index) => {
        if ('heading' in item) {
          return (
            <select
              aria-label={t(item.labelKey)}
              className="rounded border bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              key={`heading-${index}`}
              onChange={(event) => {
                if (!event.target.value) return;
                onAction(`header-${event.target.value}` as EditorToolbarAction);
              }}
              title={t(item.labelKey)}
              value=""
            >
              <option value="" disabled>{t(item.labelKey)}</option>
              {item.options.map((opt) => (
                <option key={opt.level} value={opt.level}>{t(opt.labelKey)}</option>
              ))}
            </select>
          );
        }
        const {action, labelKey} = item;
        return (
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
        );
      })}
    </div>
  );
}
