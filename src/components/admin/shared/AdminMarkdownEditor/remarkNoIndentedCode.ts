import type {Code, Parent, Paragraph} from "mdast";
import {visit} from "unist-util-visit";
import type {VFile} from "vfile";

/**
 * 把「缩进代码块」还原成普通段落。
 *
 * 中医正文里「空行 + 4 空格缩进」的行会被 Markdown 解析成缩进代码块，渲染成
 * 等宽的代码框；但这些缩进是排版，不表示代码。这里把非围栏（源码行不以 ```
 * 或 ~~~ 开头）的 code 节点改成段落，行与行之间补 break 保留换行，让它们按
 * 普通正文换行显示。围栏代码块（真正的代码）原样保留。
 */
export default function remarkNoIndentedCode() {
  return (tree: Parent, file: VFile) => {
    const sourceLines = file.toString().split(/\r\n|\r|\n/);
    visit(tree, "code", (node: Code, index, parent) => {
      if (!parent || index === undefined || index === null) return;
      const startLine = node.position?.start.line;
      const srcLine = startLine ? sourceLines[startLine - 1] ?? "" : "";
      // 真围栏代码块的起始行最多缩进 3 空格（4+ 空格的 ``` 本身属于缩进代码块
      // 的内容）。据此区分：≤3 空格 + 围栏 → 保留；否则当缩进代码块转段落。
      if (/^ {0,3}(```|~~~)/.test(srcLine)) return;

      const value = node.value.replace(/\n+$/, "");
      const children: Paragraph["children"] = [];
      value.split("\n").forEach((line, i) => {
        if (i > 0) children.push({type: "break"});
        children.push({type: "text", value: line});
      });
      parent.children[index] = {type: "paragraph", children};
    });
  };
}
