/**
 * 权限快照（`ext_user_permissions`，ADR-0053）的守卫。
 *
 * 这张表是仓库里第二个镜像。第一个（`auth_user.role`）出问题只是那一个字段错，
 * 这张出问题是权限错：写路径漏维护 → 该账号 403；漏删除 → 继续持旧权限。
 * 所以这里守三件事：
 *
 *   1. 快照的写入语句只出现在 `snapshot.ts`，别处不许就地拼 SQL；
 *   2. 每个改真源的函数都调了重算构造器；
 *   3. 重算语句是 DELETE 在前、INSERT 在后（零角色时只删不插）。
 *
 * 切分函数与识别调用都走 TypeScript 语法树，不做文本解析（AGENTS.md「不手写
 * parser」）。AST 顺带覆盖了箭头函数与嵌套写法，正则切函数体做不到。
 *
 * 本文件读文件不读库，断言不到「快照内容真的与真源一致」—— 那一半靠
 * `scripts/check-permission-snapshot.ts` 在真实库上跑。
 */
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import ts from "typescript";
import {describe, expect, it} from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

async function readSource(...segments: string[]): Promise<string> {
  return readFile(path.join(repositoryRoot, ...segments), "utf8");
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

interface FunctionEntry {
  body: ts.Node;
  name: string;
}

/** 顶层具名函数：函数声明，以及 `const name = () => {}` 这类变量声明。 */
function namedFunctions(source: ts.SourceFile): FunctionEntry[] {
  const entries: FunctionEntry[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      entries.push({body: statement.body ?? statement, name: statement.name.text});
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (!init) continue;
      if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
      if (!ts.isIdentifier(declaration.name)) continue;
      entries.push({body: init.body, name: declaration.name.text});
    }
  }
  return entries;
}

/** 子树里全部字符串字面量与模板片段的正文字。 */
function literalTexts(node: ts.Node): string[] {
  const texts: string[] = [];
  const visit = (child: ts.Node): void => {
    if (
      ts.isStringLiteral(child) ||
      ts.isNoSubstitutionTemplateLiteral(child) ||
      ts.isTemplateHead(child) ||
      ts.isTemplateMiddle(child) ||
      ts.isTemplateTail(child)
    ) {
      texts.push(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return texts;
}

const REFRESH_CALLEES = new Set([
  "refreshRoleMembersSnapshotStatements",
  "refreshUserSnapshotStatements",
]);

function callsRefresh(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      REFRESH_CALLEES.has(child.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** 改动真源、因而必须重算快照的 SQL 片段。 */
const TRUTH_WRITE_FRAGMENTS = [
  "INSERT OR IGNORE INTO ext_user_roles",
  "DELETE FROM ext_user_roles",
  "INSERT OR IGNORE INTO ext_role_permissions",
  "DELETE FROM ext_role_permissions",
  "SET is_member =",
  "SET allow_admin_login =",
];

/**
 * 有意不重算的函数：
 *   - `renameRbacRoleCode` 只把 `role_id` 从 `r_old` 换到 `r_new`，权限集合不变，
 *     快照存的是权限码、不含角色 id；
 *   - `renameRbacRole` 只改显示名；
 *   - `purgeRoleMembersAccess` 是缓存清理，不碰真源。
 */
const EXEMPT_FUNCTIONS = new Set([
  "purgeRoleMembersAccess",
  "renameRbacRole",
  "renameRbacRoleCode",
]);

describe("权限快照的写入收口", () => {
  it("快照表的写入语句只出现在 snapshot.ts 与删账号的清理里", async () => {
    const snapshot = await readSource("src", "server", "rbac", "snapshot.ts");
    expect(snapshot).toContain("DELETE FROM ext_user_permissions");
    expect(snapshot).toContain("INSERT INTO ext_user_permissions");

    // 删账号那条在 rbac-handlers.ts：不能依赖 D1 的外键强制开关，显式删一次。
    const handlers = await readSource("src", "server", "admin", "rbac-handlers.ts");
    expect(handlers.split("ext_user_permissions")).toHaveLength(2);
    expect(handlers).toContain("DELETE FROM ext_user_permissions WHERE user_id = ?");

    // 其余写路径只许调构造器，不许自己拼这张表的语句。
    const others = [
      ["src", "server", "auth", "bootstrap.ts"],
      ["src", "server", "auth", "password-setup.ts"],
      ["src", "server", "rbac", "seed.ts"],
    ] as const;
    for (const segments of others) {
      const source = await readSource(...segments);
      expect(source).not.toContain("ext_user_permissions");
    }
  });

  it("重算语句先 DELETE 再 INSERT", async () => {
    const source = parse(
      await readSource("src", "server", "rbac", "snapshot.ts"),
      "snapshot.ts",
    );
    for (const name of REFRESH_CALLEES) {
      const entry = namedFunctions(source).find((item) => item.name === name);
      expect(entry, `snapshot.ts 里没有 ${name}`).toBeDefined();

      const texts = literalTexts(entry!.body);
      const positions = (fragment: string): number[] =>
        texts
          .map((text) => text.indexOf(fragment))
          .filter((index) => index >= 0);
      // 字面量在函数体里出现的先后就是执行先后：两条语句都是独立 prepare。
      const deleteAt = texts.findIndex((text) =>
        text.includes("DELETE FROM ext_user_permissions"),
      );
      const insertAt = texts.findIndex((text) =>
        text.includes("INSERT INTO ext_user_permissions"),
      );
      expect(deleteAt, `${name} 缺少删除快照行的语句`).toBeGreaterThan(-1);
      expect(insertAt, `${name} 缺少写入快照行的语句`).toBeGreaterThan(deleteAt);
      expect(positions("DELETE FROM ext_user_permissions").length).toBe(1);
    }
  });
});

describe("每个改真源的函数都重算快照", () => {
  const files = [
    ["src", "server", "admin", "rbac-handlers.ts"],
    ["src", "server", "auth", "bootstrap.ts"],
    ["src", "server", "auth", "password-setup.ts"],
    ["src", "server", "rbac", "seed.ts"],
  ] as const;

  for (const segments of files) {
    it(`${segments.join("/")} 的写入点都调了重算`, async () => {
      const source = parse(await readSource(...segments), segments.join("/"));
      const missing: string[] = [];
      for (const {body, name} of namedFunctions(source)) {
        if (EXEMPT_FUNCTIONS.has(name)) continue;
        const touchesTruth = literalTexts(body).some((text) =>
          TRUTH_WRITE_FRAGMENTS.some((fragment) => text.includes(fragment)),
        );
        if (!touchesTruth) continue;
        if (!callsRefresh(body)) missing.push(name);
      }
      // 空数组表示没有遗漏。写路径漏调重算时，这里给出函数名。
      expect(missing).toEqual([]);
    });
  }
});

describe("迁移 0162 的回填", () => {
  it("用 FILTER 过滤空角色，不用 WHERE 丢整行", async () => {
    const source = await readSource(
      "migrations", "0162_schema_ext_user_permissions.sql",
    );
    expect(source).toContain("-- rollback:");

    // 剥掉注释行：注释里出现同样的词会干扰匹配。
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(body).toContain("CREATE TABLE IF NOT EXISTS ext_user_permissions");
    expect(body).toContain('REFERENCES "auth_user"');
    expect(body).toContain("ON DELETE CASCADE");
    // FILTER 不能换成 `WHERE p.code IS NOT NULL`：那会把「只有零授权角色」的
    // 账号整行滤掉，连 MAX(r.is_member) 一起丢掉。
    expect(body).toMatch(/FILTER\s*\(WHERE p\.code IS NOT NULL\)/u);
    expect(body).toContain("GROUP BY ur.user_id");
    // 布尔列不建索引：选择性近乎为零，且没有按它过滤的查询。
    expect(body).not.toContain("CREATE INDEX");
  });
});
