/**
 * 权限码生成器：把「加一个权限码」从 6 处手工同步压到 3 步。
 *
 * ## 它解决什么
 *
 * 一个权限码的元信息散在三处 TypeScript 与 N 个迁移里。原先加一个码要手改：
 *
 *   1. `src/shared/Constants.ts` 的 `PERMISSION_CODES`（源头，手写）
 *   2. `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS`（`{code, name}`）
 *   3. `src/shared/RbacPermissionDocs.ts` 的长说明（**唯一无法生成的人工输入**）
 *   4. 迁移 SQL 的 `INSERT INTO ext_permissions`
 *   5. 迁移 SQL 的 `INSERT INTO ext_permission_nodes`（父级本就该由人定，见下）
 *   6. `src/shared/AdminPageGuards.ts`（仅当新码守卫一个新页面）
 *
 * 其中 2 / 4 是同一事实的重复，本脚本负责；3 保留人工（要写清「缺了它会
 * 怎样」，自动化掉就失去价值）；1 是源头；6 只在真有新页面时才动。
 *
 * ## 生成的边界
 *
 * - `seed.ts` 只重写 `// <rbac-gen:begin>` 与 `// <rbac-gen:end>` 之间的内容，
 *   且**区内只有纯条目、没有注释**。判断性说明写在区外，或写进
 *   `RbacPermissionDocs.ts`（那里有码做键，不会随重排漂移）。
 * - 迁移**只新建文件**，绝不改写已有迁移。已发布的迁移改内容会让
 *   `d1_migrations` 台账与磁盘对不上（MIG-002 冻结 0001–0107 也是这个道理）。
 *   曾经有过「并入上一份生成的迁移」的实现，因无法判断该文件是否已 apply 而删掉。
 * - **默认不写节点行。** 页面节点的 code 是 `page_<旧菜单 code>`，与路由没有可靠
 *   映射；`page_unmapped` 这个老兜底也已由 `0129` 删除。静态信息下判不出父级，
 *   就不写一条指向不存在父级的行。生成的迁移头部会写明该补什么。
 *
 * ## 为什么这不削弱 `admin-endpoint-guards.test.ts`
 *
 * 那条测试比对的是 `PERMISSION_CODES` 与**磁盘上的迁移文件重放结果**。本脚本
 * 只是写文件的工具，测试仍然独立解析磁盘产物；它不会变成「代码自己检查自己」。
 * 而 `seed.ts` 与代码目录的一致性由 `tests/unit/rbac-catalog-single-source.test.ts`
 * 负责。两条边分开守，是本脚本刻意保留的设计。
 *
 * ## 用法
 *
 *   yarn rbac:gen              按当前 Constants.ts 重新生成（幂等）
 *   yarn rbac:check            只校验，有漂移、缺迁移、空 name、缺说明即非零退出
 *
 * 新增权限码的完整流程：改 `Constants.ts` → 跑 `yarn rbac:gen`（标记区会多出一行
 * 空 name）→ 把 name 填对 → 再跑一次 → 补 `RbacPermissionDocs.ts` 的 summary。
 */

import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";

import {ADMIN_PAGE_GUARDS} from "../src/shared/AdminPageGuards";
import {PERMISSION_CODES} from "../src/shared/Constants";

const ROOT = process.cwd();
const SEED_PATH = join(ROOT, "src", "server", "rbac", "seed.ts");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const DOCS_PATH = join(ROOT, "src", "shared", "RbacPermissionDocs.ts");

const BEGIN = "// <rbac-gen:begin>";
const END = "// <rbac-gen:end>";

/**
 * 整行锚定的标记正则。多行模式 + `^\s*…\s*$`，只认「这一行除了标记没别的」，
 * 于是 `seed.ts` 头顶那句同时提到两个标记的说明注释不会被当成区首。
 */
const MARKER_BEGIN = /^[ \t]*\/\/ <rbac-gen:begin>[ \t]*$/mu;
const MARKER_END = /^[ \t]*\/\/ <rbac-gen:end>[ \t]*$/mu;

/** 兜底页面节点：没有专属页面的权限码挂这里，侧栏不显示但角色编辑器可勾选。 */
const CHECK = process.argv.includes("--check");

/**
 * 标记区里的一行条目。**标记区只放条目，不放注释。**
 *
 * 曾经有过「注释锚定」的实现：把每段 `//` 注释绑到它后面第一个码，重排时跟着
 * 搬家。它有两个毛病：
 *
 * 1. 锚定的码被删时，注释移到区末的「已移除」段；下一轮读取时，那个段又被
 *    重新锚定到**下一个正常码**上（实测锚到了 `content:book:read`），于是那句
 *    「只授 super_admin」跑到无关码上方，而 `check` 不再点名——错的看起来正常。
 * 2. 为此要维护跨行注释块、缩进归一、孤儿段封皮等一堆状态，全是自找的复杂度。
 *
 * 现在的做法：标记区是**纯数据**，由生成器整体重铺，人的注释写在区外。区的
 * 上方有固定的说明段，讲「这里的字段是什么、要改去哪里改」；条目之间不再承载
 * 判断性注释——这类判断写在 `RbacPermissionDocs.ts` 的 summary 里，那里有码做键，
 * 天然不会漂移。
 */
interface SeedEntry {
  code: string;
  name: string;
}

/**
 * 定位标记区。必须按「整行只有这一个标记」来认，不能 `indexOf`：
 * `seed.ts` 顶部的说明注释里就写着 `// <rbac-gen:begin>` … `// <rbac-gen:end>`
 * 这一串（讲标记区是什么），直接搜子串命中的是那句说明，于是区首进了说明里、
 * 区末跑到区首前面。用行锚定后，说明那句里还夹了反引号与省略号，不会被误认。
 * `readRegion` 与 `rewriteSeed` 共用这一处，避免两边口径分叉。
 */
function locateMarkers(source: string): {start: number; end: number} {
  const start = MARKER_BEGIN.exec(source);
  if (!start) return {start: -1, end: -1};
  const end = MARKER_END.exec(source.slice(start.index + start[0].length));
  return {
    start: start.index,
    end: end ? start.index + start[0].length + end.index : -1,
  };
}

/**
 * 从标记区读出「码 → name」。
 *
 * 只认条目行，忽略一切 `//` 与空行。标记区若混进了注释（人手工加的），会被
 * **静默丢弃**——这是刻意的：生成器整体重铺这个区，任何区的内注释放不进来。
 * 想加说明就写在区外，或写进 `RbacPermissionDocs.ts`。
 */
function readRegion(source: string): Map<string, string> {
  const {start, end} = locateMarkers(source);
  const region = start >= 0 && end > start ? source.slice(start, end) : source;

  const names = new Map<string, string>();
  for (const line of region.split("\n")) {
    const trimmed = line.trim();
    const entry =
      /\{code:\s*(?<quote>["'])(?<code>[^"']+)\k<quote>,\s*name:\s*["'](?<name>[^"']*)["']\s*\}/u
        .exec(trimmed);
    if (entry?.groups?.code) {
      names.set(entry.groups.code, entry.groups.name ?? "");
      continue;
    }
    // 通配条目写的是 `RBAC_WILDCARD`，正则匹配不到字面量。
    if (/code:\s*RBAC_WILDCARD/u.test(trimmed)) {
      names.set("*", /name:\s*["']([^"']*)["']/u.exec(trimmed)?.[1] ?? "");
    }
  }
  return names;
}

/**
 * 生成标记区内的数组体。**纯数据，不产出任何注释。**
 *
 * 顺序跟 `PERMISSION_CODES` 的声明顺序（那是有意义的分组排列），通配码固定最后。
 * 没有 `name` 的新码**留空**并在报告里点名——刻意不自动捏名字：短名直接显示给
 * 运营，机器起的名字会长期留在界面上。
 */
function renderSeedBody(names: Map<string, string>): {text: string; unnamed: string[]} {
  const ordered = Object.values(PERMISSION_CODES).filter((code) => code !== "*");
  const unnamed: string[] = [];
  const lines: string[] = [];

  for (const code of ordered) {
    const name = names.get(code) ?? "";
    if (!name.trim()) unnamed.push(code);
    lines.push(`  {code: ${JSON.stringify(code)}, name: ${JSON.stringify(name)}},`);
  }
  lines.push(
    `  {code: RBAC_WILDCARD, name: ${JSON.stringify(names.get("*") ?? "超级管理员（全部）")}},`,
  );

  return {text: lines.join("\n"), unnamed};
}

/** 把 `seed.ts` 里的数组体替换成新内容；标记缺失即报错，不做猜测式修补。 */
function rewriteSeed(source: string, body: string): string {
  const {start, end} = locateMarkers(source);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `seed.ts 里找不到 ${BEGIN} / ${END} 标记区，无法安全重写。请先补上标记再跑。`,
    );
  }
  // 数组体从 `= [` 之后开始。不能只找第一个 `[`：声明里有类型注解
  // `RbacPermissionDef[]`，那个 `[` 也在同一行，按「第一个方括号」定位会把
  // 类型注解吃掉，写出来的源码变成 `RbacPermissionDef[` + 换行 + 条目。
  const declaration = /RBAC_PERMISSIONS:\s*RbacPermissionDef\[\]\s*=\s*\[/u
    .exec(source.slice(start, end));
  if (!declaration) {
    throw new Error(
      "seed.ts 的标记区内找不到 `RBAC_PERMISSIONS: RbacPermissionDef[] = [` 声明，无法安全重写。",
    );
  }
  const bodyStart = start + declaration.index + declaration[0].length;
  const bodyEnd = source.lastIndexOf("]", end);
  if (bodyEnd < bodyStart) {
    throw new Error("seed.ts 的 RBAC_PERMISSIONS 数组结尾识别失败。");
  }
  return `${source.slice(0, bodyStart)}\n${body}\n${source.slice(bodyEnd)}`;
}

/**
 * 从全部迁移里重放「当前已种下的码 → 最后一次写入的 name」。
 *
 * 与 `tests/unit/admin-endpoint-guards.test.ts` 的 `readCatalogCodes` 同一口径：
 * 先剥行注释（回滚块里写的是反向语句），再按文件顺序应用 DELETE 与 INSERT。
 * 这里多取一个 `name`，用来判断「新码是否真的还没有迁移」。
 */
function replayCatalog(): Map<string, string> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4}_.*\.sql$/u.test(file))
    .sort();
  const catalog = new Map<string, string>();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
      .replaceAll(/--[^\n]*/gu, " ");
    for (const match of sql.matchAll(
      /DELETE\s+FROM\s+ext_permissions[\s\S]*?code\s+(?:=\s*'(?<single>[^']+)'|IN\s*\((?<list>[^)]*)\)|LIKE\s*'(?<prefix>[^']+)')/giu,
    )) {
      const single = match.groups?.single;
      if (single) catalog.delete(single);
      for (const literal of (match.groups?.list ?? "").matchAll(/'([^']+)'/gu)) {
        catalog.delete(literal[1] ?? "");
      }
      const prefix = match.groups?.prefix;
      if (prefix) {
        const stem = prefix.replace(/%$/u, "");
        for (const code of [...catalog.keys()]) {
          if (code.startsWith(stem)) catalog.delete(code);
        }
      }
    }
    for (const match of sql.matchAll(
      /\(\s*'p_[^']*'\s*,\s*'(?<code>[^']+)'\s*,\s*'(?<name>[^']*)'\s*\)/gu,
    )) {
      const code = match.groups?.code;
      if (code) catalog.set(code, match.groups?.name ?? "");
    }
  }
  return catalog;
}

/**
 * 找一个守卫码等于该权限码的后台页面路由。
 *
 * 只用于**报告**「这个码守卫着哪个页面」，不用于推导节点父级。理由见
 * `renderMigration` 的注释：页面节点的 code 是 `page_<旧菜单 code>`，与路由没有
 * 可靠的字符串关系。
 */
function pageForCode(code: string): string | null {
  for (const [route, guard] of Object.entries(ADMIN_PAGE_GUARDS)) {
    if (guard === code) return route;
  }
  return null;
}

/** 迁移文件名前缀：取现有最大编号 +1，保证 MIG-001 的连续性。 */
function nextMigrationNumber(): string {
  const numbers = readdirSync(MIGRATIONS_DIR)
    .map((file) => Number(/^(\d{4})_/u.exec(file)?.[1] ?? 0))
    .filter((value) => value > 0);
  return String(Math.max(...numbers) + 1).padStart(4, "0");
}

/** 把权限码变成迁移文件名与节点 id 里可用的片段。 */
function slugOf(code: string): string {
  return code.replace(/[^a-z0-9]+/giu, "_").replace(/^_+|_+$/gu, "").toLowerCase();
}

/**
 * 为新码生成一份追加迁移。**只种权限码，不写节点行。**
 *
 * `type = data`（MIG-003 要求 `NNNN_<type>_<desc>.sql`）。MIG-004 要求 data /
 * cleanup 带 `-- rollback:` 块，所以 INSERT 配了反向 DELETE。
 *
 * ## 为什么不写节点行
 *
 * 节点行要 `parent_code` 指向一个**真实存在**的父级。曾经拼
 * `page_<route 转下划线>`、兜底写 `page_unmapped`，两个都错：
 *
 * - `page_unmapped` 已由 `0129:86` 删除，挂上去就是孤儿节点，而
 *   `admin-page-guards.test.ts` 的「contains no orphan entries」正好会红。
 * - 页面节点的 code 是 `page_<旧菜单 code>`（`0133:35` 的 `'page_' || m.code`），
 *   与路由没有可靠关系（`page_all_items` 对 `all-items`、`page_edit_channel` 对
 *   `channels/primary`）。37 个页面节点里只有少数恰好同名。
 * - 想查 `path` 也查不到：25 个页面的 `path` 是 `0133` 当时联 `ext_menu` 回填的，
 *   而 `ext_menu` 已由 `0168` 删除，磁盘上只剩 `page_rbac_audit` 一个明写的值。
 *
 * 所以静态信息下**无法可靠推导父级**。生成器只种权限码，把它该补什么写在迁移
 * 头部，而不是拿一个假父级让库先坏掉。节点行由人在 `ext_permission_nodes` 现状
 * 上手工补。
 *
 * 曾经留过一个 `parentCode?` 参数作「显式指定父级」的口子，但全仓没有任何调用
 * 点传它，于是那条分支永不执行、`nodeId` 成了死变量。留一个没人用的口子比不留
 * 更糟：它让「能按需写节点行」看起来存在。所以删掉了。
 */
function renderMigration(code: string, name: string): {file: string; text: string} {
  const number = nextMigrationNumber();
  const slug = slugOf(code);
  const permissionId = `p_${code.replace(/:/gu, "_")}`;
  const nodeId = `pn_${code.replace(/:/gu, "_")}`;
  const route = pageForCode(code);
  const fileName = `${number}_data_seed_${slug}_permission.sql`;

  const header = `-- ${fileName}
--
-- 新增权限码 \`${code}\`（\`yarn rbac:gen\` 生成，说明见 docs/zh/14-authorization-data-model.md）。
--
-- 为什么用 data 而不是 seed：seed 类是建表后的初始数据，由 00xx 系列承担；
-- 0108 之后新增的码一律走 data，与 0142 / 0154 的既有做法一致。
`;

  const why = route
    ? `-- 本码守卫后台页面 \`${route}\`，但页面节点的 code 与路由没有可靠映射（原因见
-- 脚本里 renderMigration 的注释），所以本迁移不写节点行。要让它出现在权限树时，
-- 在 \`ext_permission_nodes\` 现状上补一条：
--
--   INSERT OR IGNORE INTO ext_permission_nodes
--     (id, code, kind, parent_code, sort, audience, permission_code, name_zh, name_en,
--      icon, i18n_key, is_visible, source, created_at_ms, path, entry_code) VALUES
--     ('${nodeId}', '${code}', 'code', '<父级页面节点>', 0, 'desktop',
--      '${code}', '${escapeSqlLiteral(name)}', NULL, NULL, NULL, 1, 'seed',
--      CAST(strftime('%s', 'now') AS INTEGER) * 1000, '${route}', '${code}');
--
-- 注意 \`0133\` 的触发器要求：写 entry_code 就必须同时写非空 path。`
    : `-- 本码没有守卫任何后台页面（\`ADMIN_PAGE_GUARDS\` 里查不到），属能力码。
-- 能力码通常仍需一个 kind='code' 节点才能在角色编辑器里勾选，但父级取决于它
-- 归属哪个功能组，静态信息无法判定，所以本迁移不写节点行。`;

  const text = `${header}--
${why}
--
-- type = data。回滚块反向删除；执行器不会自动跑它。
-- rollback:
--   （本迁移没有节点行）
--   DELETE FROM ext_permissions WHERE code = '${code}';

INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES
  ('${permissionId}', '${code}', '${escapeSqlLiteral(name)}');
`;
  return {file: fileName, text};
}

/** 单引号转义。SQL 字面量里 `'` 必须写成 `''`，否则名字带撇号就产出坏 SQL。 */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/gu, "''");
}

/**
 * 把新码写进一份迁移。**一个码一个文件，不做合并。**
 *
 * 曾经有过「并入上一份本脚本产出的迁移」的实现，它直接改写已存在的 `.sql`。
 * 那份文件如果在某个环境已经 `apply` 过，二次并入的 INSERT 永远不会执行——
 * 库与文件不一致，而 `d1_migrations` 台账不会察觉。生成器无从判断某份迁移
 * 是否已被应用（那需要读库，不该由生成器做），所以合并没有安全形态。
 *
 * 代价是连续加三个码会产生三个文件，但那正是可执行的真相：每份独立记账。
 */

function main(): void {
  const seedSource = readFileSync(SEED_PATH, "utf8");
  const names = readRegion(seedSource);
  const {text: body, unnamed} = renderSeedBody(names);
  const nextSeed = rewriteSeed(seedSource, body);

  const declared = Object.values(PERMISSION_CODES).filter((code) => code !== "*");
  const catalog = replayCatalog();
  const missingFromSql = declared.filter((code) => !catalog.has(code));

  // summary 与 name 的空值判定放在两分支共用处：`--check` 与生成模式都要看同一份
  // 事实，避免「生成时警告、检查时静默」这种一边松一边紧的口径分叉。
  const docs = readFileSync(DOCS_PATH, "utf8");
  const undocumentedCodes = declared.filter((code) => !docs.includes(`"${code}":`));

  if (CHECK) {
    const problems: string[] = [];
    if (nextSeed !== seedSource) {
      problems.push("seed.ts 的标记区与 PERMISSION_CODES 不同步（跑 `yarn rbac:gen` 修）");
    }
    if (missingFromSql.length > 0) {
      problems.push(
        `这些码没有迁移把它们种进 ext_permissions：${missingFromSql.join(", ")}`,
      );
    }
    if (unnamed.length > 0) {
      problems.push(
        `这些码在 seed.ts 里没有中文短名（会变成角色编辑器里没有标签的勾选项）：${unnamed.join(", ")}`,
      );
    }
    if (undocumentedCodes.length > 0) {
      problems.push(
        `这些码在 src/shared/RbacPermissionDocs.ts 里没有长说明：${undocumentedCodes.join(", ")}`,
      );
    }
    if (problems.length > 0) {
      console.error("rbac:check 失败：");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`rbac:check 通过：${declared.length} 个码，seed、迁移、说明都齐。`);
    return;
  }

  if (nextSeed !== seedSource) writeFileSync(SEED_PATH, nextSeed);

  // 只为「还没有任何迁移种下」的码生成迁移，已存在的码不重复插。
  //
  // ⚠️ 缺中文短名时**不生成迁移**。`ext_permissions.name` 会进角色编辑器的勾选
  // 列表，空串写进去就是一个没有标签的选项，比少一条迁移更难发现。所以要求先
  // 在 `seed.ts` 标记区把 name 补上（这一步只能人工：短名是业务语言，不是码的
  // 机械变换），再跑一次本命令。
  const written: string[] = [];
  const deferred: string[] = [];
  for (const code of missingFromSql) {
    const name = (names.get(code) ?? "").trim();
    if (!name) {
      deferred.push(code);
      continue;
    }
    const {file, text} = renderMigration(code, name);
    writeFileSync(join(MIGRATIONS_DIR, file), text);
    written.push(`${code} → 新建 ${file}`);
  }

  console.log(`seed.ts 标记区：${nextSeed === seedSource ? "无变化" : "已重写"}`);
  if (written.length > 0) {
    console.log("生成的迁移：");
    for (const line of written) console.log(`  ${line}`);
  } else if (deferred.length > 0) {
    // 有码在等短名，说「都已种下」是错的——那正是最容易把人误导过去的一句。
    console.log(`迁移：无新增（${deferred.length} 个码在等中文短名，见下方提示）`);
  } else {
    console.log("迁移：无新增（所有码都已有种子迁移）");
  }
  if (deferred.length > 0) {
    console.error(
      `⚠️ 这些码没有中文短名，已跳过生成迁移（空 name 会变成角色编辑器里没有标签的勾选项）。` +
        `先在 seed.ts 标记区把 name 写对，再跑一次：${deferred.join(", ")}`,
    );
  }
  if (undocumentedCodes.length > 0) {
    console.error(
      `⚠️ 这些码还没有长说明，请补 src/shared/RbacPermissionDocs.ts 的 summary（这一步不做自动化）：${undocumentedCodes.join(", ")}`,
    );
  }
}

main();
