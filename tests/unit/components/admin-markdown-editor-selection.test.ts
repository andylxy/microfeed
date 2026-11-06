import {describe, expect, it} from "vitest";

import {decideSelectionRestore} from "@/components/admin/shared/AdminMarkdownEditor/selectionRestore";

/**
 * 工具栏动作后的光标恢复判定（ADR-0035 编辑器共用逻辑）。
 *
 * 第三方代码编辑器把 props.value 存进内部 useState，DOM 的 textarea.value
 * 会晚一帧才跟上。只有等两者一致才允许恢复选区，否则随后那次赋值会把
 * 光标推到文本末尾——即用户所报「插入 $a{}/$m{} 后光标漂到结尾」。
 */
describe("decideSelectionRestore", () => {
  it("restores only once the DOM value matches the edit result", () => {
    expect(decideSelectionRestore("$a{}正文", "$a{}正文", 0, 10)).toBe("restore");
  });

  it("keeps waiting while the third-party editor still holds the old value", () => {
    expect(decideSelectionRestore("正文", "$a{}正文", 0, 10)).toBe("wait");
    expect(decideSelectionRestore("正文", "$a{}正文", 9, 10)).toBe("wait");
  });

  it("gives up after the frame budget so a stale value cannot spin forever", () => {
    expect(decideSelectionRestore("正文", "$a{}正文", 10, 10)).toBe("give-up");
  });

  it("treats an out-of-sync empty DOM value as waiting, not restoring", () => {
    expect(decideSelectionRestore("", "$a{}", 0, 10)).toBe("wait");
  });
});
