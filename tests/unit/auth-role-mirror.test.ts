/**
 * 反向守卫：`auth_user.role` 不再是 `ext_user_roles` 的派生镜像。
 *
 * 这一列曾由六处代码写入、供 Better Auth 的 admin 插件端点鉴权。插件移除后它
 * 无写者、无读者，唯一的风险是被谁「顺手补回来」——那样会重新长出第二条授权面。
 * 本文件守的就是这件事。
 *
 * 原条款见 ADR-0052 决策 2，该条已由 ADR-0054 撤回。
 */
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

import {AUTH_USER_COLUMNS} from "@/shared/AdminAccountColumns";
import {
  authUserInsertFromSetupSql,
  credentialAccountFromSetupStatement,
} from "@/server/auth/account-insert";
import {makeD1, makeSqlite} from "./server/helpers/d1";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");
const cliRoot = path.join(repositoryRoot, "manage-cli");

/**
 * `UPDATE ["<"]auth_user[">] SET ["<"]role[">] =` —— 镜像写入。两个标识符的引号
 * 都可选，带引号的写法不能从这条规则下溜过去。
 */
const MIRROR_WRITE = /UPDATE\s+"?auth_user"?\s+SET\s+"?role"?\s*=/iu;

/**
 * `auth_user` 后面紧跟括号的地方就是建号列清单。前导的 `INSERT INTO` 可能是模板
 * 变量（`${head}`）或转义引号（`\"auth_user\"`），所以只认表名本身。
 */
const USER_INSERT = /auth_user\\?"?\s*\(/gu;

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(filename);
      }
      return /\.tsx?$/u.test(entry.name) ? [filename] : [];
    }),
  );
  return files.flat();
}

/** 目录树下文本命中 `pattern` 的文件，路径相对仓库根。 */
async function writersOf(
  pattern: RegExp,
  roots: readonly string[],
): Promise<string[]> {
  const hits: string[] = [];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      if (pattern.test(source)) {
        hits.push(path.relative(repositoryRoot, file));
      }
    }
  }
  return hits.sort();
}

/**
 * 每条 `INSERT INTO "auth_user"` 之后的列清单窗口。列名可能由常量拼出，窗口
 * 就只能按位置取；`\brole\b` 不会命中 `roles`。
 */
async function insertWindows(
  roots: readonly string[],
): Promise<{file: string; text: string}[]> {
  const windows: {file: string; text: string}[] = [];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(USER_INSERT)) {
        windows.push({
          file: path.relative(repositoryRoot, file),
          text: source.slice(match.index, match.index + 600),
        });
      }
    }
  }
  return windows;
}

describe("auth_user.role 不再有任何写入点", () => {
  it("src/ 与 manage-cli/ 里都没有针对该列的 UPDATE", async () => {
    expect(await writersOf(MIRROR_WRITE, [sourceRoot, cliRoot])).toEqual([]);
  });

  it("建号语句的列清单都不含 role", async () => {
    const windows = await insertWindows([sourceRoot, cliRoot]);
    // 三条路径共用 `account-insert.ts` 的两条语句，加上 manage-cli 的一份，
    // 命中数不为零才说明扫描器真的看到了建号语句。
    expect(windows.length).toBeGreaterThanOrEqual(3);
    for (const window of windows) {
      expect(`${window.file}: ${/\brole\b/iu.test(window.text)}`).toBe(
        `${window.file}: false`,
      );
    }
  });

  it("列清单常量不含 role 且恰好八列", () => {
    expect(AUTH_USER_COLUMNS).not.toContain("role");
    // 列清单是全仓唯一一份：两条 `INSERT INTO "auth_user"` 语句都由它拼出。
    expect(AUTH_USER_COLUMNS).toHaveLength(8);
  });

  it("better-auth 实例不再加载 admin 插件", async () => {
    const source = await readFile(
      path.join(sourceRoot, "server", "auth", "better-auth.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/better-auth\/plugins\/admin/u);

    const pluginsAt = source.indexOf("plugins: [");
    expect(pluginsAt).toBeGreaterThan(-1);
    const pluginsEnd = source.indexOf("\n    ],", pluginsAt);
    expect(pluginsEnd).toBeGreaterThan(pluginsAt);
    const plugins = source.slice(pluginsAt, pluginsEnd);

    // 剩下的三个插件是 passkey / username / oauthProvider。
    // 切片里出现 `adminUrl(...)` 与 `adminPath` 是正常的，这里只认插件调用形态。
    expect(plugins).not.toMatch(/(?:^|[\s,])admin\s*\(/mu);
    expect(plugins).toMatch(/\bpasskey\s*\(/u);
    expect(plugins).toMatch(/\busername\s*\(/u);
    expect(plugins).toMatch(/\boauthProvider\s*\(/u);
  });
});

/** 安装流程用到的四张表，只保留本组断言需要的列。 */
const SETUP_SCHEMA = `
CREATE TABLE "auth_user" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "banned" INTEGER NOT NULL DEFAULT 0,
  "signup_source" TEXT NOT NULL DEFAULT 'email'
);
CREATE TABLE "auth_account" (
  "id" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "password" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);
CREATE TABLE "auth_password_setup" (
  "id" TEXT PRIMARY KEY,
  "purpose" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "userId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL
);
CREATE TABLE "ext_user_roles" (
  "user_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "role_id")
);
`;

async function insertSetupRow(
  db: D1Database,
  input: {expiresAt: string; now: string; tokenHash: string},
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO "auth_password_setup" ("id", "purpose", "email", ' +
        '"userId", "tokenHash", "createdAt", "expiresAt") ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      "owner",
      "initial",
      "owner@example.com",
      null,
      input.tokenHash,
      input.now,
      input.expiresAt,
    )
    .run();
}

/**
 * 复刻安装流程批次里与令牌相关的前三条语句。`at` 是与 `expiresAt` 比较的「当前
 * 时刻」，由调用方给，便于构造过期场景。
 */
async function runCreateBatch(
  db: D1Database,
  tokenHash: string,
  at: string,
): Promise<void> {
  const userId = "user-1";
  await db.batch([
    db
      .prepare(authUserInsertFromSetupSql({}))
      .bind(userId, at, at, "owner", "initial", tokenHash, at),
    credentialAccountFromSetupStatement(db, {
      accountId: "account-1",
      passwordHash: "hash",
      purpose: "initial",
      setupId: "owner",
      timestamp: at,
      tokenHash,
      userId,
    }),
    db
      .prepare(
        'DELETE FROM "auth_password_setup" WHERE "id" = ? AND "purpose" = ? ' +
          'AND "tokenHash" = ? AND "expiresAt" > ?',
      )
      .bind("owner", "initial", tokenHash, at),
  ]);
}

async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM "${table}"`)
    .first<{total: number}>();
  return Number(row?.total ?? 0);
}

/**
 * 安装向导建所有者时，`auth_user` 行、凭证行、授予与快照必须同批提交：授予若
 * 留在批次之后，一旦失败就留下「账号已建、没有 super_admin」的越权行，而迁移只能
 * 事后订正，堵不住再生。
 *
 * 两条断言：批次结构（授予语句在 batch 方括号之内）与真实行为（令牌只能用一次）。
 */
describe("password-setup 的建号批次", () => {
  it("授予语句与两条建号语句在同一个 batch 内", async () => {
    const source = await readFile(
      path.join(sourceRoot, "server", "auth", "password-setup.ts"),
      "utf8",
    );
    expect(source.match(/INSERT OR IGNORE INTO ext_user_roles/gu) ?? [])
      .toHaveLength(1);

    const batchStart = source.indexOf("results = await database.batch([");
    expect(batchStart).toBeGreaterThan(-1);
    const batchEnd = source.indexOf("]);", batchStart);
    expect(batchEnd).toBeGreaterThan(batchStart);

    const grantAt = source.indexOf("INSERT OR IGNORE INTO ext_user_roles");
    expect(grantAt).toBeGreaterThan(batchStart);
    expect(grantAt).toBeLessThan(batchEnd);

    // 建号两条改由公共函数给出，仍在同一批次内。
    for (const builder of [
      "authUserInsertFromSetupSql(",
      "credentialAccountFromSetupStatement(",
    ]) {
      const at = source.indexOf(builder);
      expect(at).toBeGreaterThan(batchStart);
      expect(at).toBeLessThan(batchEnd);
    }

    // 批次校验只读前 3 条（建账号、建凭证、删 token）；授予是 `INSERT OR IGNORE`，
    // 已存在时返回 0 changes，算进去会让重放场景误报 410。
    expect(source).toContain("results.slice(0, 3)");
  });

  it("首跑三条语句都生效，重放不新增账号", async () => {
    const database = makeSqlite(SETUP_SCHEMA);
    const db = makeD1(database);
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await insertSetupRow(db, {expiresAt: future, now, tokenHash: "token"});

    await runCreateBatch(db, "token", now);
    expect(await countRows(db, "auth_user")).toBe(1);
    expect(await countRows(db, "auth_account")).toBe(1);
    expect(await countRows(db, "auth_password_setup")).toBe(0);

    // 令牌行已被上一条 DELETE 消费掉，重放时 SELECT 命中 0 行。
    await runCreateBatch(db, "token", now);
    expect(await countRows(db, "auth_user")).toBe(1);
    expect(await countRows(db, "auth_account")).toBe(1);
  });

  it("令牌过期时一条都不写", async () => {
    const database = makeSqlite(SETUP_SCHEMA);
    const db = makeD1(database);
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    await insertSetupRow(db, {expiresAt: past, now, tokenHash: "token"});

    await runCreateBatch(db, "token", now);
    expect(await countRows(db, "auth_user")).toBe(0);
    expect(await countRows(db, "auth_account")).toBe(0);
    // 过期行不会被删：WHERE 里的 `expiresAt > ?` 不成立。
    expect(await countRows(db, "auth_password_setup")).toBe(1);
  });
});
