import {ADMIN_URLS} from "@/shared/StringUtils";

export interface MarkerConfig {
  code: string;
  title: string;
}

/**
 * 0068 播种的标记的兜底按钮，即便列表拉取失败（如权限或网络抖动）编辑器也
 * 始终有按钮可用。实时库列表才是权威 —— 新增标记后在后台维护，下次页面加载
 * 即出现，无需重新部署。
 */
export const DEFAULT_MARKER_CONFIGS: MarkerConfig[] = [
  {code: "f", title: "方剂"},
  {code: "a", title: "按语"},
  {code: "u", title: "中药"},
  {code: "x", title: "橙字"},
];

/**
 * 从后台拉取标注标记列表，失败则回退到种子配置。原 wangEditor 在挂载时拉取并
 * 注册工具栏按钮；现由 Markdown 编辑器复用同一逻辑。
 */
export async function fetchAnnotationMarkers(): Promise<MarkerConfig[]> {
  try {
    const response = await fetch(ADMIN_URLS.ajaxAnnotationMarkersList(), {
      headers: {"content-type": "application/json"},
    });
    if (!response.ok) {
      console.warn(
        `[annotationMarkers] marker list fetch failed: HTTP ${response.status}`,
      );
      return DEFAULT_MARKER_CONFIGS;
    }
    const data = (await response.json()) as {markers?: MarkerConfig[]};
    if (Array.isArray(data.markers) && data.markers.length > 0) {
      return data.markers;
    }
    return DEFAULT_MARKER_CONFIGS;
  } catch (error) {
    console.warn("[annotationMarkers] marker list fetch threw", error);
    return DEFAULT_MARKER_CONFIGS;
  }
}

/**
 * 在 `value` 的 `[start, end)` 选区处插入标注包裹 `$<code>{...}`。
 *
 * 有选区时把选区包进花括号；无选区时插入 `$<code>{}` 并把光标置于花括号内，
 * 方便作者接着键入。返回新值与新光标位置（与 AdminMarkdownEditor 的
 * `pendingSelection` 机制配套）。纯函数，便于单元测试。
 */
export function wrapWithMarker(
  value: string,
  start: number,
  end: number,
  code: string,
): {value: string; selectionStart: number; selectionEnd: number} {
  const selectedText = value.substring(start, end);
  const open = `$${code}{`;
  const close = "}";
  const newValue = value.slice(0, start) + open + selectedText + close + value.slice(end);
  let selectionStart: number;
  let selectionEnd: number;
  if (selectedText.length > 0) {
    // 选中整段包裹，光标覆盖 `$f{...}` 全部。
    selectionStart = start;
    selectionEnd = start + open.length + selectedText.length + close.length;
  } else {
    // 无选区：光标置于 `${code}{` 之后、花括号之内。
    selectionStart = start + open.length;
    selectionEnd = start + open.length;
  }
  return {value: newValue, selectionStart, selectionEnd};
}
