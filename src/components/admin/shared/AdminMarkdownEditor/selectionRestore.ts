/**
 * 工具栏动作后光标恢复的判定。只描述「DOM 值是否已追上动作产出的值」，
 * 不碰 DOM，便于在 node 环境下单测（组件本身在这里只能静态渲染）。
 *
 * 第三方 `@uiw/react-textarea-code-editor` 把 props.value 存进自己的
 * useState，靠 effect 再同步到 textarea，DOM 会晚一帧才有新值。若在这之前
 * 设置选区，随后那次赋值会把光标推到文本末尾——这是「插入标注后光标漂到
 * 结尾」的根因。
 */
export type SelectionRestoreDecision = "wait" | "restore" | "give-up";

export function decideSelectionRestore(
  domValue: string,
  expectedValue: string,
  attempts: number,
  maxFrames: number,
): SelectionRestoreDecision {
  if (domValue === expectedValue) return "restore";
  if (attempts < maxFrames) return "wait";
  return "give-up";
}
