import {useEffect, useRef, useState, type ChangeEvent} from "react";

import AdminCodeEditor from "@/components/admin/shared/AdminCodeEditor";
import AdminSwitch from "@/components/admin/shared/AdminSwitch";
import EditorFormatToolbar from "@/components/admin/shared/EditorFormatToolbar";
import {applyMarkdownAction, type EditorToolbarAction} from "@/client/markdownActions";
import MarkdownPreview from "@uiw/react-markdown-preview";
import remarkBreaks from "remark-breaks";
import remarkNoIndentedCode from "./remarkNoIndentedCode";
import {useColorMode} from "@/client/useColorMode";
import {useTranslation} from "@/client/i18n";
import {
  decideSelectionRestore,
  type SelectionRestoreDecision,
} from "./selectionRestore";
import {
  fetchAnnotationMarkers,
  type MarkerConfig,
  wrapWithMarker,
} from "@/client/annotationMarkers";

/** 连续等待的最大帧数，超出便放弃，避免 DOM 一直不同步时空转。 */
const MAX_RESTORE_FRAMES = 10;

/** 文本动作产出的新值与目标选区（两个纯函数共用这一形状）。 */
interface TextEditResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

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
   * 预览开关的初始状态。默认 `false`——打开编辑器先看到源码，需要再切换
   * 到「预览」；调用方想一开始展开预览时传 `true`。
   */
  defaultPreview?: boolean;
  /**
   * 把「空行 + 4 空格缩进」的缩进代码块当作排版、渲染成普通段落（而非等宽
   * 代码框）。默认 `false`——通用 Markdown 场景（feed 条目等）里缩进就是
   * 代码，保持原样；只有正文缩进代表版式的中医类内容才开启。
   */
  indentAsText?: boolean;
  /**
   * 源码框的无障碍名称。默认为通用文案；字段另有所属的调用方传字段名
   * （如「正文」「注释」），让屏幕阅读器读到的是字段语义而非泛称。
   */
  ariaLabel?: string;
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
  indentAsText = false,
  ariaLabel,
}: Props) {
  const {t} = useTranslation();
  const [preview, setPreview] = useState(defaultPreview);
  const [markers, setMarkers] = useState<MarkerConfig[]>([]);
  // 预览暗色与后台主题同源：观察 <html data-color-mode>（共享 hook）。
  const colorMode = useColorMode();
  const containerRef = useRef<HTMLDivElement>(null);
  // 动作生效后光标应处的位置。连同本次产出的新值一起保存：第三方编辑器
  // 内部还有一层 useState，DOM 的 value 会晚几帧才跟上 props.value。只有
  // 等 DOM 值与期望值一致后才恢复选区，否则刚设好的选区会被随后的赋值抹掉。
  const pendingSelection = useRef<{
    start: number;
    end: number;
    expectedValue: string;
  } | null>(null);

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

  /** 记下动作产出的新值与目标选区，再交给调用方更新受控值。
   *  值没变时不动 pending，避免下一次无关的 value 变化误恢复旧选区。 */
  const applyEdit = (result: TextEditResult) => {
    if (result.value === value) return;
    pendingSelection.current = {
      start: result.selectionStart,
      end: result.selectionEnd,
      expectedValue: result.value,
    };
    onChange(result.value);
  };

  const onToolbarAction = (action: EditorToolbarAction) => {
    const textarea = findTextarea();
    if (!textarea) return;
    applyEdit(applyMarkdownAction(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      action,
    ));
  };

  const onMarkerClick = (code: string) => {
    const textarea = findTextarea();
    if (!textarea) return;
    applyEdit(wrapWithMarker(
      value,
      textarea.selectionStart,
      textarea.selectionEnd,
      code,
    ));
  };

  useEffect(() => {
    const target = pendingSelection.current;
    if (!target) return;
    let frame = 0;
    let attempts = 0;
    // 第三方编辑器把 props.value 同步进 DOM 需要额外一轮渲染。逐帧等到
    // textarea.value 与本次动作产出的值一致，再恢复选区；成功后才清 pending，
    // 这样即使 effect 被 cleanup 打断，下一次 value 变化仍能接着恢复。
    const restore = () => {
      const textarea = findTextarea();
      if (!textarea) {
        // 编辑器尚未挂上 DOM：继续等下一帧，别静默放弃；超过上限才收尾。
        attempts += 1;
        if (attempts <= MAX_RESTORE_FRAMES) {
          frame = window.requestAnimationFrame(restore);
        } else if (pendingSelection.current === target) {
          pendingSelection.current = null;
        }
        return;
      }
      const decision: SelectionRestoreDecision = decideSelectionRestore(
        textarea.value,
        target.expectedValue,
        attempts,
        MAX_RESTORE_FRAMES,
      );
      if (decision === "wait") {
        attempts += 1;
        frame = window.requestAnimationFrame(restore);
        return;
      }
      if (decision === "give-up") {
        // 只清本次目标；期间若有新动作写入新 pending，别一起抹掉。
        if (pendingSelection.current === target) pendingSelection.current = null;
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(target.start, target.end);
      if (pendingSelection.current === target) pendingSelection.current = null;
    };
    frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return (
    // min-w-0 / max-w-full 阻断预览里的长行把弹层的 grid 隐式列撑宽。
    // 不设时 CSS Grid 会按 min-content 计算列宽，勾选预览后整块编辑器
    // 连同源码框一起向右拉长（markdown.css 的 pre/table 是 max-content）。
    // overflow-hidden 是最后一道保险：即便上游某层漏了约束，本控件也绝不
    // 把父容器撑宽——宽内容由预览框自身的 overflow-x-auto 横向滚动消化。
    <div
      className="admin-markdown-editor w-full min-w-0 max-w-full overflow-hidden"
      ref={containerRef}
    >
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
              onMouseDown={(event) => event.preventDefault()}
              title={marker.title}
              type="button"
            >
              {marker.title}
            </button>
          ))}
        </div>
      )}
      <AdminCodeEditor
        ariaLabel={ariaLabel ?? t("shared.markdownSourceAria")}
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
        <AdminSwitch
          checked={preview}
          label={t("shared.markdownPreview")}
          onCheckedChange={setPreview}
        />
      </div>
      {preview && (
        value.trim() ? (
          // 预览走成熟 Markdown 预览组件（ADR-0035）：作者键入的语法在此渲染
          // 成最终形态。配 remark-breaks 让换行与阅读页 marked 的 breaks:true
          // 行为一致，按行写作的观感两边相同。
          // 预览自带 CSS 把 pre/table 设成 width:max-content，这里逐层压回
          // 容器宽度并让超长内容在预览框内横向滚动，避免把父级撑宽：根节点
          // 与 pre/table/img 全部 min-w-0 + max-w-full，根节点自带 overflow-x
          // 兜底，容器再 break-words 拦住无空格超长串。
          // indentAsText 开启时：正文里「空行 + 4 空格缩进」的行会被 markdown
          // 解析成 <pre><code> 缩进代码块（white-space:pre、不换行，长行撑出血
          // 滚动条）。此类内容的缩进属版式，故用 remarkNoIndentedCode 把它还原
          // 成普通段落随容器换行；通用场景不开该开关，缩进代码块保持原样。
          <div
            className="mt-2 w-full min-w-0 max-w-full overflow-x-auto break-words rounded-md border bg-muted/30 p-4 text-sm [&_.wmde-markdown]:min-w-0 [&_.wmde-markdown]:max-w-full [&_.wmde-markdown]:overflow-x-auto [&_img]:max-w-full [&_pre]:min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:min-w-0 [&_table]:max-w-full [&_table]:overflow-x-auto"
          >
            <MarkdownPreview
              remarkPlugins={
                indentAsText
                  ? [remarkBreaks, remarkNoIndentedCode]
                  : [remarkBreaks]
              }
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
