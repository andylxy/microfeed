/**
 * 四个架构门禁脚本（check-adr、check-migrations、check-server-layout、
 * check-endpoint-registration）共用的辅助函数。
 *
 * 每个门禁自行声明规则与成功提示。四者共用的是：问题记录、递归目录遍历、
 * 以及违规输出——全部按 AGENTS.md「架构治理」规定的
 * `文件:行 <规则编号> <描述>` 格式输出（行号为 0 表示规则判定于整个文件层级）。
 *
 * 用 `yarn <name>:check` 运行某个门禁；一旦记录到任何问题，门禁即以非零状态退出。
 */
import {readdirSync, existsSync, statSync} from "node:fs";
import path from "node:path";

/**
 * 一条规则违规记录。`line` 默认 0，因为多数规则针对整个文件或整个名称；
 * 能定位到具体行（如 check-adr）的门禁会显式传入行号。
 */
type Finding = {file: string; line: number; rule: string; message: string};

const findings: Finding[] = [];

/** 记录一条违规，由 {@link printViolations} 统一输出。 */
export function report(
  file: string,
  rule: string,
  message: string,
  line = 0,
): void {
  findings.push({file, line, rule, message});
}

/** 该门禁目前已记录的违规条数。 */
export function violationCount(): number {
  return findings.length;
}

/**
 * 输出全部已记录的违规，并在存在任何违规时以非零状态退出。`label` 用于
 * 末行的计数说明（如 "endpoint registration"）；仅当没有任何违规时才打印成功提示。
 */
export function finish(label: string): void {
  if (violationCount() === 0) return;
  printViolations();
  console.error(`\n${violationCount()} ${label} violation(s).`);
  process.exit(1);
}

/**
 * 按 `文件:行 规则编号 描述` 输出每条已记录的违规——这正是 AGENTS.md 为门禁
 * 规定的格式。判定于文件层级的规则使用行号 0。
 */
export function printViolations(): void {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} ${finding.rule} ${finding.message}`);
  }
}

/**
 * 递归收集 `directory` 下、基名满足 `isFile` 的全部文件，按字典序排序以保证
 * 门禁输出可复现。目录不存在时返回空列表，因此门禁可对尚不存在的目录树运行。
 */
export function walk(directory: string, isFile: (name: string) => boolean): string[] {
  const collected: string[] = [];
  if (!existsSync(directory)) return collected;
  for (const name of readdirSync(directory).sort()) {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) collected.push(...walk(entry, isFile));
    else if (isFile(name)) collected.push(entry);
  }
  return collected;
}
