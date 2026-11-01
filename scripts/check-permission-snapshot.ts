/**
 * 权限快照 `ext_user_permissions` 的双向不变量检查（ADR-0053「后果」第 3 层）。
 *
 * 快照是仓库里第二个镜像，权威仍在 `ext_user_roles` / `ext_roles` /
 * `ext_role_permissions` / `ext_permissions`。这个脚本把两侧算一遍再比对，
 * 报出四种漂移：
 *
 *   1. 有角色分配、没有快照行 —— 该账号会被判无权限（403）
 *   2. 有快照行、没有角色分配 —— 行该被删掉，留着就是幽灵权限
 *   3. 快照的 `codes` 与真源聚合结果不等 —— 权限码错
 *   4. `is_member` / `admin_login_allowed` 与真源不等 —— 会员档或后台准入错
 *
 * 手工工具，不进门禁：脱离真实数据跑没有意义。用 `--db` 指库、`--instance`
 * 指实例，或直接在 `.microfeed/instances/*` 里挑体积最大的业务库。
 *
 * 退出码：0 两侧一致 / 1 有漂移 / 2 前置条件不满足（库找不到、表不存在）。
 *
 * 用法：
 *   yarn tsx scripts/check-permission-snapshot.ts --instance ctwh-881019-xyz
 *   yarn tsx scripts/check-permission-snapshot.ts --db path/to/local.sqlite
 */

import {DatabaseSync} from "node:sqlite";
import {existsSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function collectDbFiles(dir: string): string[] {
  const d1 = path.join(dir, "local-state", "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(d1)) return [];
  return readdirSync(d1)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.join(d1, name));
}

function resolveDbPath(): string | null {
  const fromEnv = process.env.MICROFEED_GATE_DB;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const dbIdx = process.argv.findIndex((a) => a === "--db" || a === "-d");
  if (dbIdx >= 0 && process.argv[dbIdx + 1]) {
    const candidate = process.argv[dbIdx + 1]!;
    if (existsSync(candidate)) return candidate;
  }

  const instanceIdx = process.argv.findIndex(
    (a) => a === "--instance" || a === "-i",
  );
  const base = path.join(repositoryRoot, ".microfeed", "instances");
  const candidates: string[] = [];
  if (instanceIdx >= 0 && process.argv[instanceIdx + 1]) {
    candidates.push(...collectDbFiles(path.join(base, process.argv[instanceIdx + 1]!)));
  } else if (existsSync(base)) {
    for (const instance of readdirSync(base)) {
      candidates.push(...collectDbFiles(path.join(base, instance)));
    }
  }
  const business = candidates
    .filter((p) => !p.endsWith("metadata.sqlite"))
    .map((p) => ({p, size: statSync(p).size}))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.size - a.size);
  return business[0]?.p ?? null;
}

/** 真源聚合：与 `src/server/rbac/snapshot.ts` 的 AGGREGATE_SELECT 同形。 */
const TRUTH_SQL = `
SELECT ur.user_id AS user_id,
       COALESCE(
         json_group_array(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL),
         '[]'
       ) AS codes,
       MAX(r.is_member) AS is_member,
       MAX(r.allow_admin_login) AS admin_login_allowed
  FROM ext_user_roles ur
  JOIN ext_roles r ON r.id = ur.role_id
  LEFT JOIN ext_role_permissions rp ON rp.role_id = ur.role_id
  LEFT JOIN ext_permissions p ON p.id = rp.permission_id
 GROUP BY ur.user_id`;

interface TruthRow {
  admin_login_allowed: number;
  codes: string;
  is_member: number;
  user_id: string;
}

interface SnapshotRow {
  admin_login_allowed: number;
  codes: string;
  is_member: number;
  user_id: string;
}

function asCodeSet(raw: string): Set<string> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`codes 的值必须是 JSON 数组，实际收到 ${raw.slice(0, 40)}`);
  }
  return new Set(parsed.filter((code): code is string => typeof code === "string"));
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const code of left) if (!right.has(code)) return false;
  return true;
}

function main(): void {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    console.error("SNAPSHOT: 没找到本地 D1 业务库。");
    console.error("SNAPSHOT: 用 --db <path> 或 --instance <实例> 指定，或先跑 `yarn manage dev --local`。");
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath, {readOnly: true});
  const hasTable = db
    .prepare(
      "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'ext_user_permissions'",
    )
    .get() as {total: number} | undefined;
  if (!hasTable || hasTable.total === 0) {
    console.error(`SNAPSHOT: ${dbPath} 里没有 ext_user_permissions 表，迁移 0162 还没应用。`);
    db.close();
    process.exit(2);
  }

  const truth = new Map<string, TruthRow>();
  for (const row of db.prepare(TRUTH_SQL).all() as TruthRow[]) {
    truth.set(row.user_id, row);
  }
  const snapshot = new Map<string, SnapshotRow>();
  for (const row of db
    .prepare(
      `SELECT user_id, codes, is_member, admin_login_allowed
         FROM ext_user_permissions`,
    )
    .all() as SnapshotRow[]) {
    snapshot.set(row.user_id, row);
  }
  db.close();

  const findings: string[] = [];
  for (const [userId, expected] of truth) {
    const actual = snapshot.get(userId);
    if (!actual) {
      findings.push(`缺快照行 ${userId}：有角色分配，读侧会判无权限`);
      continue;
    }
    if (!sameSet(asCodeSet(actual.codes), asCodeSet(expected.codes))) {
      findings.push(`权限码不等 ${userId}：快照 ${actual.codes} / 真源 ${expected.codes}`);
    }
    if (Number(actual.is_member) !== Number(expected.is_member)) {
      findings.push(
        `会员标记不等 ${userId}：快照 ${actual.is_member} / 真源 ${expected.is_member}`,
      );
    }
    if (Number(actual.admin_login_allowed) !== Number(expected.admin_login_allowed)) {
      findings.push(
        `后台准入不等 ${userId}：快照 ${actual.admin_login_allowed} / 真源 ${expected.admin_login_allowed}`,
      );
    }
  }
  for (const userId of snapshot.keys()) {
    if (!truth.has(userId)) {
      findings.push(`多余快照行 ${userId}：没有角色分配，这行该被删掉`);
    }
  }

  console.log(
    `SNAPSHOT: ${dbPath}\n` +
      `SNAPSHOT: 真源 ${truth.size} 个账号 / 快照 ${snapshot.size} 行`,
  );
  if (findings.length === 0) {
    console.log("SNAPSHOT: 两侧一致。");
    process.exit(0);
  }
  for (const finding of findings) console.log(`  ${finding}`);
  console.log(`SNAPSHOT: ${findings.length} 处漂移。`);
  process.exit(1);
}

main();
