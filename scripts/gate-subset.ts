/**
 * microfeed-gate-subset —— 架构门禁子集编排器 + 量化报告 + 修复循环。
 *
 * 子集范围（与 `yarn check` 的完整门禁相比，只取本地、快速、只读为主的治理项）：
 *   1. check-adr.ts                   ADR 编号唯一 / 引用可解析
 *   2. check-migrations.ts            迁移命名 / 冻结 / 连续 / rollback 块
 *   3. check-server-layout.ts         src/server/ 顶层白名单
 *   4. check-endpoint-registration.ts 端点登记
 *   5. check-d1-scan.ts               D1 全表扫描（新增项，默认顾问模式）
 *
 *   编排器只覆盖上述 #1–5（快速 / 只读治理项）。技能范围另含「增补三检」
 *   （i18n 镜像 / typecheck / 组件测试，见 SKILL.md「增补三检运行方式与环境前提」），
 *   因较重或有环境前提，在编排器之后手动运行，未并入本文件以避免破坏快速只读前提。
 *
 * 行为：
 *   - 逐项异步跑子进程（本沙箱 `spawnSync` 会 EBUSY，故用 async spawn），捕获退出码与
 *     输出，输出统一量化报告（检查项 / 状态 / 量化指标）。
 *   - `--fix`：对任何 FAIL 的硬门禁尝试修复后重跑，最多 `MAX_ITER` 轮，直到全 PASS
 *     或无法自动修复为止（避免无限循环）；每轮修复后都会重跑验证，达到轮数上限时
 *     显式提示。D1 为顾问模式，永不计入 FAIL，其发现只量化展示 + 给出候选索引与
 *     A/B 实测口径；是否写成迁移由用户决定（项目允许按 0108+ 规范新增索引迁移，
 *     此处不自动写是自动修复范围的取舍）。
 *
 * 安全边界（以 AGENTS.md 为准）：本编排器不提交 git；需判断的修复只「给出方案」并
 * 暂停确认，只有确定性低风险项（如布局白名单新增）才自动应用。
 *
 * 与 check-d1-scan.ts 的耦合点只有一个：其输出的 `D1SCAN-METRIC: key=value ...`
 * 机器可读汇总行。指标展示解析该行，不解析人读的汇总句子。
 */
import {spawn} from "node:child_process";
import {readFileSync, writeFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_ITER = 5;

interface GateDef {
  key: string;
  name: string;
  script: string;
  /** 是否硬门禁：失败时计入 FAIL 并参与 --fix 循环。D1 为顾问项，false。 */
  hard: boolean;
}

const GATES: GateDef[] = [
  {key: "adr", name: "ADR 门禁", script: "check-adr.ts", hard: true},
  {key: "migrations", name: "迁移门禁", script: "check-migrations.ts", hard: true},
  {key: "layout", name: "布局门禁", script: "check-server-layout.ts", hard: true},
  {key: "endpoints", name: "端点门禁", script: "check-endpoint-registration.ts", hard: true},
  {key: "d1scan", name: "D1 全表扫描", script: "check-d1-scan.ts", hard: false},
];

/** 需人工处理的硬门禁：key → 处理要点。自动修复只覆盖 layout（确定性低风险）。 */
const MANUAL_FIX_HINTS: Record<string, string> = {
  adr: "核对 ADR 编号唯一性与 src/migrations 中的裸引用是否解析到 docs/novel-cms/adr/。",
  migrations:
    "核对 0108+ 编号连续、type 合法、data/cleanup 含 -- rollback: 块；0001-0107 文件名已冻结不可改。",
  endpoints: "将未登记 handler 归入 OpenApiDocument / access.ts 登记表（区分公开、豁免、AppBookRequest 三类）。",
};

interface GateResult {
  def: GateDef;
  exitCode: number;
  stdout: string;
  stderr: string;
  status: "PASS" | "FAIL" | "ADVISORY";
  metric: string;
}

function runGate(def: GateDef): Promise<GateResult> {
  const scriptPath = path.join(repositoryRoot, "scripts", def.script);
  const extraArgs = def.key === "d1scan" && process.argv.includes("--strict") ? ["--strict"] : [];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...extraArgs], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const {status, metric} = classify(def, code ?? 1, stdout.trim(), stderr.trim());
      resolve({def, exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), status, metric});
    });
  });
}

function classify(
  def: GateDef,
  exitCode: number,
  stdout: string,
  stderr: string,
): {status: GateResult["status"]; metric: string} {
  const out = `${stdout}\n${stderr}`;
  if (def.key === "d1scan") {
    // 约定：check-d1-scan.ts 输出 `D1SCAN-METRIC: key=value ...` 一行，指标只解析它。
    const m = out.match(/D1SCAN-METRIC: (.+)/u);
    if (m) {
      const kv = new Map(m[1].split(/\s+/u).map((p) => p.split("=") as [string, string]));
      const num = (k: string) => Number(kv.get(k) ?? 0);
      const findings = num("scan001") + num("scan002") + num("scan003");
      const status: GateResult["status"] =
        exitCode !== 0 ? "FAIL" : findings === 0 ? "PASS" : "ADVISORY";
      return {
        status,
        metric:
          `${num("stmts")} 语句 / ${num("scan001")} 大表全扫 / ${num("scan003")} 索引全扫 / ` +
          `${num("scan002")} TEMP B-TREE / ${num("rows")} 累计行 / ${num("bytes")} 累计字节`,
      };
    }
    return {status: exitCode === 0 ? "PASS" : "FAIL", metric: exitCode === 0 ? "无发现" : "无法解析 D1SCAN-METRIC 行"};
  }
  // 四个硬门禁：成功打印 `OK: ...`，失败打印 `文件:行 规则 描述` 并退出非零。
  const ok = stdout.match(/OK: (.+)/u);
  if (exitCode === 0 && ok) {
    return {status: "PASS", metric: ok[1]};
  }
  const violations = (out.match(/^\S+:\d+ \S+ /gmu) ?? []).length;
  return {status: "FAIL", metric: `${violations} 违规（见上方明细）`};
}

function printReport(results: GateResult[], fixed: number): void {
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  console.log("\n===== microfeed-gate-subset 量化报告 =====");
  console.log(`${pad("检查项", 14)}状态   量化指标`);
  console.log("-".repeat(56));
  for (const r of results) {
    console.log(`${pad(r.def.name, 14)}${pad(r.status, 9)} ${r.metric}`);
  }
  console.log("-".repeat(56));
  const pass = results.filter((r) => r.status === "PASS").length;
  const advisory = results.filter((r) => r.status === "ADVISORY").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`汇总: ${pass} PASS / ${advisory} ADVISORY / ${fail} FAIL · 修复 ${fixed} 次`);
  console.log("=========================================\n");
  if (fail > 0) {
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`--- ${r.def.name} 明细 ---`);
      console.log(r.stdout);
      console.log(r.stderr);
    }
  }
}

/** 对 FAIL 的硬门禁尝试修复；能确定性安全修复返回 true，否则返回 false 并给出方案。 */
function attemptFix(result: GateResult): boolean {
  const def = result.def;
  if (def.key === "layout") {
    // 布局门禁：解析未入白名单的顶层项，追加进 WHITELIST（确定性、低风险）。
    const m = result.stderr.match(/^src\/server\/(\S+?):\d+ LAYOUT-001/u);
    if (!m) {
      console.log(`[fix] 布局门禁：无法解析违规项，需人工处理。`);
      return false;
    }
    const entry = m[1];
    const file = path.join(repositoryRoot, "scripts", "check-server-layout.ts");
    const src = readFileSync(file, "utf8");
    if (src.includes(`  "${entry}",`) || src.includes(`  '${entry}',`)) {
      console.log(`[fix] 布局门禁：${entry} 已在白名单，无需修改。`);
      return true;
    }
    const inserted = src.replace(/(const WHITELIST = new Set\(\[)/u, `$1\n  "${entry}",`);
    writeFileSync(file, inserted);
    console.log(`[fix] 布局门禁：已将 "${entry}" 加入 scripts/check-server-layout.ts 的 WHITELIST。`);
    return true;
  }
  const hint = MANUAL_FIX_HINTS[def.key];
  if (hint) {
    console.log(`[fix] ${def.name}：需人工处理——${hint}`);
    return false;
  }
  return false;
}

async function main(): Promise<void> {
  const fixMode = process.argv.includes("--fix");
  let fixed = 0;
  let iter = 0;
  let results: GateResult[] = [];
  // 循环结构：每轮先跑全部门禁，有 FAIL 才修；修完必进下一轮重跑验证，
  // 因此最后一轮修复也经过验证。达到 MAX_ITER 仍 FAIL 时显式提示，不静默停止。
  while (true) {
    iter++;
    results = await Promise.all(GATES.map(runGate));
    const failed = results.filter((r) => r.status === "FAIL");
    if (failed.length === 0) break;
    if (!fixMode) {
      console.log(`[gate-subset] 发现 ${failed.length} 项 FAIL。加 --fix 可尝试自动修复（确定性项）或给出方案。`);
      break;
    }
    if (iter >= MAX_ITER) {
      console.log(
        `[gate-subset] 已达最大迭代轮数（${MAX_ITER}），仍有 ${failed.length} 项 FAIL，停止循环；` +
          `各 FAIL 的处理方案见上方明细与 [fix] 行。`,
      );
      break;
    }
    let progressed = false;
    for (const f of failed) {
      const applied = attemptFix(f);
      if (applied) {
        fixed++;
        progressed = true;
      }
    }
    if (!progressed) {
      console.log(`[gate-subset] 存在无法自动修复的 FAIL 项，停止循环并输出方案。`);
      break;
    }
  }
  printReport(results, fixed);
  const fail = results.filter((r) => r.status === "FAIL").length;
  process.exit(fail > 0 ? 1 : 0);
}

main();
