/**
 * `auth_user.role` is a *derived mirror* of the RBAC `super_admin` grant, not an
 * independent authorization source (ADR-0011 D4; `BETTER_AUTH_ADMIN_ROLE` in
 * `src/shared/Rbac.ts`).
 *
 * Better Auth's own admin plugin reads that column, so it has to stay in step
 * with `ext_user_roles`. A second code path that wrote it without touching the
 * RBAC tables would silently split authorization in two — the exact drift D4
 * warns about. This is the tripwire: it pins every writer of the column, so a
 * new one fails the suite and forces a review instead of a quiet divergence.
 */
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");

/**
 * `UPDATE ["<"]auth_user[">] SET ["<"]role[">] =` — the mirror write. Quotes are
 * optional on both identifiers so a quoted variant (the repo already writes
 * `INSERT INTO "auth_user"`) cannot slip past the tripwire.
 */
const MIRROR_WRITE = /UPDATE\s+"?auth_user"?\s+SET\s+"?role"?\s*=/giu;

/** `INSERT INTO ["<"]auth_user` — the account-creation write. */
const USER_INSERT = /INSERT\s+INTO\s+"?auth_user\b/giu;

/**
 * The mapping every mirror write must carry: holding `super_admin` becomes the
 * Better Auth admin role, anything else the plain user role. Pinning the whole
 * ternary — not just "the file mentions the constants" — is what stops a flipped
 * mapping from passing.
 */
const MIRROR_MAPPING =
  /includes\(SUPER_ADMIN\)\s*\?\s*BETTER_AUTH_ADMIN_ROLE\s*:\s*BETTER_AUTH_USER_ROLE/gu;

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

/** Files under `src/` whose text matches `pattern`, relative to the repo root. */
async function writersOf(pattern: RegExp): Promise<string[]> {
  const files = await sourceFiles(sourceRoot);
  const hits: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    // The patterns are global, so `test` advances `lastIndex`; reset per file.
    pattern.lastIndex = 0;
    if (pattern.test(source)) {
      hits.push(path.relative(repositoryRoot, file));
    }
  }
  return hits.sort();
}

describe("auth_user.role stays a derived mirror of the RBAC super_admin grant", () => {
  it("mutates the mirror column only in rbac-handlers.ts", async () => {
    const writers = await writersOf(MIRROR_WRITE);
    expect(writers).toEqual([
      path.join("src", "server", "admin", "rbac-handlers.ts"),
    ]);

    const source = await readFile(
      path.join(sourceRoot, "server", "admin", "rbac-handlers.ts"),
      "utf8",
    );
    // Exactly two mirror writes — `replaceUserRoles` and `createAdminRbacUser` —
    // and each one carries the super_admin -> admin mapping. A flipped or dropped
    // mapping fails here rather than silently authorizing the wrong way.
    expect(source.match(MIRROR_WRITE) ?? []).toHaveLength(2);
    expect(source.match(MIRROR_MAPPING) ?? []).toHaveLength(2);
  });

  it("creates an auth_user row with a role only in the two owner paths", async () => {
    const writers = await writersOf(USER_INSERT);
    expect(writers).toEqual([
      path.join("src", "server", "auth", "bootstrap.ts"),
      path.join("src", "server", "auth", "password-setup.ts"),
    ]);
  });
});

/**
 * 安装向导建所有者时，`auth_user` 行与 super_admin 授予必须同批提交：授予若留在
 * 批次之后，一旦失败就留下「role = 'admin' 却没有 super_admin」的越权行，
 * 而迁移只能事后订正，堵不住再生。这里守两件事：授予语句在批次之内，且批次校验
 * 只看前 3 条（授予是 `INSERT OR IGNORE`，已存在时返回 0 changes）。
 */
describe("password-setup grants the owner role inside the create batch", () => {
  it("keeps exactly one grant statement inside the create batch", async () => {
    const source = await readFile(
      path.join(sourceRoot, "server", "auth", "password-setup.ts"),
      "utf8",
    );
    expect(source.match(/INSERT OR IGNORE INTO ext_user_roles/gu) ?? [])
      .toHaveLength(1);

    // 授予必须写在建号批次的方括号之内：移到批次之后就会重新出现「账号已建、
    // 授权失败」的越权窗口。
    const batchStart = source.indexOf("results = await database.batch([");
    expect(batchStart).toBeGreaterThan(-1);
    const batchEnd = source.indexOf("]);", batchStart);
    expect(batchEnd).toBeGreaterThan(batchStart);

    const grantAt = source.indexOf("INSERT OR IGNORE INTO ext_user_roles");
    expect(grantAt).toBeGreaterThan(batchStart);
    expect(grantAt).toBeLessThan(batchEnd);

    // 授予是批次里的第 4 条：它前面有 3 条各自 `.bind(...)` 结尾的语句
    // （建账号、建凭证、删 token），批次校验只读这 3 条。
    const bindsBefore = source
      .slice(batchStart, grantAt)
      .match(/\.bind\(/gu) ?? [];
    expect(bindsBefore).toHaveLength(3);
    expect(source).toContain("results.slice(0, 3)");
  });
});

/**
 * 存量漂移的订正放在一个 data 迁移里（`role` 是派生值，两侧不一致即为缺陷）。
 * 这里守的是迁移的**分支完整性**：以后有人编辑该文件时删掉某一支，测试立即报，
 * 不靠人工复核 SQL。本文件读文件不读库，所以断言不到「漂移真的被改掉」——
 * 那一半只能靠部署后跑运维查询。
 */
describe("auth_user.role drift correction migration", () => {
  it("covers all three drift branches and keys on the role code", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "migrations",
        "0161_data_sync_auth_user_role.sql",
      ),
      "utf8",
    );
    expect(source).toContain("-- rollback:");

    // 先剥掉注释行：rollback 块里的示例语句与说明会干扰匹配。
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(body).toMatch(/UPDATE\s+"auth_user"/u);
    expect(body).toMatch(/"role"\s+IS\s+NULL/u);
    expect(body).toMatch(/"role"\s*=\s*'admin'\s+AND\s+NOT\s+EXISTS/u);
    expect(body).toMatch(/"role"\s*=\s*'user'\s+AND\s+EXISTS/u);
    // 判据是角色码，不是角色主键：各环境的 id 未必一致。
    expect(body).toMatch(/r\."code"\s*=\s*'super_admin'/u);
    expect(body).not.toMatch(/r\."id"\s*=\s*'r_super_admin'/u);
  });
});
