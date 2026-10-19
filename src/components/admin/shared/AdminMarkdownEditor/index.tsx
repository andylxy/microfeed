import {useEffect, useRef, useState, type ChangeEvent} from "react";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import EditorFormatToolbar from "@/components/admin/shared/EditorFormatToolbar";
import {applyMarkdownAction, type EditorToolbarAction} from "@/client/markdownActions";
import MarkdownPreview from "@uiw/react-markdown-preview";
import remarkBreaks from "remark-breaks";
import {useTranslation} from "@/client/i18n";
import {
  fetchAnnotationMarkers,
  type MarkerConfig,
  wrapWithMarker,
} from "@/client/annotationMarkers";

interface Props {
  onChange: (value: string) => void;
  value?: string;
  /**
   * 源码框的占位符。默认为章节正文语法的文案；字段另有所属的调用方
   * 传自己的，源码框便不会自称是章节正文。
   */
  placeholder?: string;
  /**
   * 编辑器下方的提示。默认为章节正文语法的文案（阅读页渲染正文）；字段
   * 的去向另有所属的调用方传自己的，提示于是与字段真实的数据去向一致。
   */
  hint?: string;
  /**
   * 预览复选框的初始状态。默认 `false`——打开编辑器先看到源码，需要再勾
   * 选「预览」；调用方想一开始展开预览时传 `true`。
   */
  defaultPreview?: boolean;
}

/**
 * Markdown 源码编辑器，附只读原文回显。
 *
 * `onChange` 收到的是 Markdown 源码，存什么由调用方决定。正文保留源码，
 * 重新打开此框看到的是键入的原文。
 */
export default function AdminMarkdownEditor({
  onChange,
  placeholder,
  hint,
  value = "",
  defaultPreview = false,
}: Props) {
  const {t} = useTranslation();
  const [preview, setPreview] = useState(defaultPreview);
  const [markers, setMarkers] = useState<MarkerConfig[]>([]);
  const [colorMode, setColorMode] = useState<"dark" | "light" | undefined>(
    undefined,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  // 动作生效后光标应处的位置。textarea 归 AdminCodeEditor 所有，故选区
  // 在新值渲染完成后再恢复。
  const pendingSelection = useRef<{start: number; end: number} | null>(null);

  // 预览组件的暗色开关是 data-color-mode 属性，与 admin 的 .dark 类不同源。
  // applyAdminTheme 会把解析后的明暗写进 <html data-color-mode>，此处观察
  // 该属性：用户切换、系统偏好变化都会跟上，无需知道主题从何而来。
  useEffect(() => {
    const read = () => setColorMode(
      document.documentElement.dataset.colorMode === "dark" ? "dark" : "light",
    );
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-mode"],
    });
    return () => observer.disconnect();
  }, []);

  // 标注标记工具栏：拉取后台标记列表（回退种子），提供一键插入 `$<code>{}`。
  // 原由 wangEditor 提供，现迁移到 Markdown 编辑器，所有 Markdown 编辑场景通用。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await fetchAnnotationMarkers();
      if (!cancelled) setMarkers(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const onMarkerClick = (code: string) => {
    const textarea = findTextarea();
    if (!textarea) return;
    const result = wrapWithMarker(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      code,
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
    // 代码编辑器在渲染后的下一个 tick 才把新值写进 textarea，而赋值
    // `value` 会把光标推到末尾。在下一个 tick 恢复选区，否则动作刚设好的
    // 选区被抹掉，光标跳到章节末尾。
    const timer = window.setTimeout(() => {
      const textarea = findTextarea();
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(target.start, target.end);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <div className="admin-markdown-editor" ref={containerRef}>
      <EditorFormatToolbar onAction={onToolbarAction} />
      {markers.length > 0 && (
        <div
          className="mb-2 flex flex-wrap gap-1 rounded-[10px] border bg-muted/40 p-1.5"
          role="toolbar"
          aria-label={t("shared.annotationMarkerToolbar")}
        >
          {markers.map((marker) => (
            <button
              aria-label={marker.title}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
              key={marker.code}
              onClick={() => onMarkerClick(marker.code)}
              title={marker.title}
              type="button"
            >
              {marker.title}
            </button>
          ))}
        </div>
      )}
      <AdminCodeEditor
        ariaLabel={t("shared.markdownSourceAria")}
        code={value}
        fontSize={14.4}
        language="markdown"
        maxHeight="32rem"
        minHeight="16rem"
        onChange={onCodeChange}
        placeholder={placeholder ?? t("shared.markdownSourcePlaceholder")}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {hint ?? t("shared.markdownHint")}
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
        value.trim() ? (
          // 预览走成熟 Markdown 预览组件（ADR-0035）：作者键入的语法在此渲染
          // 成最终形态。配 remark-breaks 让换行与阅读页 marked 的 breaks:true
          // 行为一致，按行写作的观感两边相同。
          <div className="mt-2 overflow-auto rounded-md border bg-muted/30 p-4 text-sm">
            <MarkdownPreview
              remarkPlugins={[remarkBreaks]}
              source={value}
              wrapperElement={
                colorMode ? {"data-color-mode": colorMode} : undefined
              }
            />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("shared.markdownEmptyPreview")}
          </p>
        )
      )}
    </div>
  );
}
