/**
 * 后台标注标记目录（`ext_annotation_markers`）里的一行。
 *
 * 标记码是稳定身份，被写进正文（`$<code>{…}`），所以码本身创建后不可改；
 * 颜色、字号比例与链接类型是渲染器套用到 `$<code>{…}` 上的呈现。渲染侧的
 * 输入形状是 `TcmMarkers.ts` 的 `TcmMarkerStyle`，两者刻意分开：这里是
 * 后台目录行（多了 id / 标题 / 排序），那边是渲染入参。
 *
 * 放在 `src/shared` 是因为后台列表组件与服务端处理器说的是同一个形状，
 * 组件不能从 `src/server` 取类型（AGENTS.md「源码架构」）。
 */
export interface AnnotationMarker {
  id: string;
  /** 标记字母，例如 `f`；正文里写成 `$f{…}`。 */
  code: string;
  /** 显示名，例如 `$f 方剂`。 */
  title: string;
  sortOrder: number;
  /** CSS 可用的颜色：`#RRGGBB` 或 `rgba(...)`。 */
  color: string;
  /** 为真时按 `smallFontScale` 缩小渲染。 */
  smallFont: boolean;
  /** `smallFont` 生效时的比例，例如 `0.7` 表示 70%。 */
  smallFontScale: number;
  /** 0 = 纯文本，1 = 中药，2 = 方剂，3 = 名词。 */
  linkType: number;
}
