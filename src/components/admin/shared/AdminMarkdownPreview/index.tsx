import {useColorMode} from "@/client/useColorMode";
import MarkdownPreview from "@uiw/react-markdown-preview";
import remarkBreaks from "remark-breaks";
import remarkNoIndentedCode from "@/components/admin/shared/AdminMarkdownEditor/remarkNoIndentedCode";

/**
 * 后台只读 Markdown 预览的统一容器。
 *
 * 包装 @uiw/react-markdown-preview，集中解决它两个默认行为导致的横向撑破，
 * 供各模块详情页只读态复用（fang-yao / ming-ci / zhong-yao / book-chapter）：
 *
 * 1. 正文里 4 空格 / tab 缩进的行会被 Markdown 解析成缩进代码块 <pre><code>，
 *    预览库 markdown.css 给 pre > code 设了 white-space:pre（不换行），长段落
 *    会横向撑破容器。remarkNoIndentedCode 把非围栏缩进代码块还原成普通段落，
 *    随正文按容器宽换行（这类缩进属排版，作用等同代码的情况请用围栏 ```）。
 * 2. markdown.css 未分层，Tailwind utilities 在 @layer utilities。CSS 规范里
 *    未分层普通规则优先级高于 @layer 内规则，且压倒 specificity。因此残留的
 *    pre > code 需用 whitespace-pre-wrap!（!important 跨层）才盖得过
 *    white-space:pre。逐层 min-w-0 / max-w-full / overflow-x-auto 再兜底真围栏
 *    代码块与超宽表格：压回容器宽，超长内容在容器内滚动，不撑破页面。
 */

// 逐层约束：根容器与内部 pre/table/img 全部 min-w-0 + max-w-full，超长内容由
// overflow-x-auto 在容器内消化。这套 class 与 AdminMarkdownEditor 编辑态预览同源。
const CONTAINER_CLASS =
  "w-full min-w-0 max-w-full overflow-x-auto break-words rounded-md border bg-muted/30 p-4 text-sm [&_.wmde-markdown]:min-w-0 [&_.wmde-markdown]:max-w-full [&_.wmde-markdown]:overflow-x-auto [&_.wmde-markdown]:break-words [&_img]:max-w-full [&_pre]:min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_.wmde-markdown_pre_code]:whitespace-pre-wrap! [&_table]:min-w-0 [&_table]:max-w-full [&_table]:overflow-x-auto";

export interface AdminMarkdownPreviewProps {
  /** Markdown 源码，原样渲染不改写（$ 标记等原样呈现） */
  source: string;
  /** 附加到外层容器的 class（例如外间距）；逐层约束 class 始终保留 */
  className?: string;
}

export default function AdminMarkdownPreview({
  source,
  className,
}: AdminMarkdownPreviewProps) {
  const colorMode = useColorMode();
  return (
    <div
      className={
        className ? `${CONTAINER_CLASS} ${className}` : CONTAINER_CLASS
      }
    >
      <MarkdownPreview
        remarkPlugins={[remarkBreaks, remarkNoIndentedCode]}
        source={source}
        wrapperElement={
          colorMode ? {"data-color-mode": colorMode} : undefined
        }
      />
    </div>
  );
}