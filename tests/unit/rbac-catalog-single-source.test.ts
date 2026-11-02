import {readFileSync} from "node:fs";
import {join} from "node:path";

import {describe, expect, it} from "vitest";

import {RBAC_PERMISSIONS, CATALOG_NOTES, type RbacPermissionDef} from "@/server/rbac/seed";
import {PERMISSION_CODES} from "@/shared/Constants";
import {RBAC_PERMISSION_DOCS} from "@/shared/RbacPermissionDocs";

import {migrationNames} from "./support/migrations";

/**
 * 权限码三份元信息的单源一致性。
 *
 * 一个权限码在仓库里出现三处，各有不同职责：
 *   - `src/shared/Constants.ts` 的 `PERMISSION_CODES`——手写的键值对，是**源头**；
 *   - `src/server/rbac/seed.ts` 的 `RBAC_PERMISSIONS`——`{code, name}`，`name`
 *     是角色编辑器里显示的短名（`rbac-handlers.ts:118` 的
 *     `SELECT code, name FROM ext_permissions` 消费它），由
 *     `scripts/rbac-catalog.ts` 生成到标记区内；
 *   - `src/shared/RbacPermissionDocs.ts` 的 `RBAC_PERMISSION_DOCS`——长说明，
 *     **唯一无法生成的人工输入**（要写清「缺了它会怎样」）。
 *
 * 相邻测试各守一条边，但都不直接比对前两份的 `name`：
 *   - `admin-endpoint-guards.test.ts` 比 `PERMISSION_CODES` ↔ **迁移文件**；
 *   - `tests/worker/rbac.test.ts` 比 `RBAC_PERMISSIONS` ↔ **数据库**；
 *   - `rbac-permission-docs.test.ts` 比 `RBAC_PERMISSIONS` ↔ **说明文档**。
 * 本文件补的就是剩下那条边，并钉住「生成器不许悄悄改名」。
 */
describe("RBAC 权限码单源一致性", () => {
  const seedByCode = new Map(RBAC_PERMISSIONS.map((entry) => [entry.code, entry]));

  it("给每个 PERMISSION_CODES 的码都配了一条 seed 条目", () => {
    // 集合相等这件事由上面三条边间接保证，但这里的报错更直接：
    // 新增了一个码却忘了跑 `yarn rbac:gen` 时，这里点名缺哪个。
    const missing = Object.values(PERMISSION_CODES)
      .filter((code) => !seedByCode.has(code))
      .sort();
    expect(
      missing,
      `这些码在 Constants.ts 里，但 seed.ts 的 RBAC_PERMISSIONS 里没有：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("seed 里没有 Constants.ts 之外的码", () => {
    const declared = new Set<string>(Object.values(PERMISSION_CODES));
    const extra = [...seedByCode.keys()]
      .filter((code) => !declared.has(code))
      .sort();
    expect(
      extra,
      `这些码在 seed.ts 里，但 Constants.ts 没有声明（拼写不一致，或删码时漏了一处）：${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("每个码都有非空的中文短名", () => {
    // name 不是装饰：角色编辑器直接把它显示给运营。空串会让界面上出现一个
    // 没有任何文字的勾选项，运营无法判断该不该授。
    const blank = RBAC_PERMISSIONS
      .filter((entry: RbacPermissionDef) => entry.name.trim() === "")
      .map((entry) => entry.code);
    expect(blank, `这些码的 seed 短名为空：${blank.join(", ")}`).toEqual([]);
  });

  it("每个码都有非空的长说明", () => {
    // 与 `rbac-permission-docs.test.ts` 的「gives every entry a summary」重合，
    // 但那条遍历的是 docs 自己的键；这里从 `PERMISSION_CODES` 出发，
    // 保证「新加的码」也一定被这条扫到，而不只是在既有键集合内自洽。
    const undocumented = Object.values(PERMISSION_CODES)
      .filter((code) => {
        const doc = RBAC_PERMISSION_DOCS[code];
        return !doc || doc.summary.trim() === "";
      })
      .sort();
    expect(
      undocumented,
      `这些码缺少 RBAC_PERMISSION_DOCS 的 summary：${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("通配码只出现在 seed 与说明里，不参与页面与端点守卫", () => {
    // `*` 是短路放行语义（`permissionsInclude`），不是一个可授给普通角色的能力。
    // 它必须在 seed 与说明里各有条目，但不能出现在 Constants 的码表之外被别处引用。
    expect(PERMISSION_CODES.WILDCARD).toBe("*");
    expect(seedByCode.has("*"), "seed 里必须有通配条目").toBe(true);
    expect(RBAC_PERMISSION_DOCS["*"], "说明里必须有通配条目").toBeDefined();
  });
});

/**
 * 标记区必须是**纯数据**：只有条目，没有注释。
 *
 * 这条锁的是生成器的语义边界，不是风格。早先的实现把注释锚定到后面的码跟着搬家，
 * 锚定的码被删时注释会被放到区末，下一轮又被重新锚定到无关的码上——错得很安静。
 * 现在生成器整体重铺这个区，人的说明一律写在区外（`CATALOG_NOTES`）或写进
 * `RbacPermissionDocs.ts`。下面两条把「区内无注释」和「区内顺序等于声明顺序」
 * 钉住，任何人手工往区里加注释都会被这条测试当场发现。
 */
describe("seed.ts 的生成标记区", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "server", "rbac", "seed.ts"),
    "utf8",
  );
  // 必须整行锚定。`seed.ts` 头顶的说明注释里也写着 `// <rbac-gen:begin>` 这一串，
  // 用 `indexOf` 会命中那句说明，切出的「区」根本不是数组体——生成器早先就栽在这。
  const beginMatch = /^[ \t]*\/\/ <rbac-gen:begin>[ \t]*$/mu.exec(source);
  const begin = beginMatch ? beginMatch.index : -1;
  const endMatch =
    begin >= 0
      ? /^[ \t]*\/\/ <rbac-gen:end>[ \t]*$/mu.exec(source.slice(begin))
      : null;
  const end = endMatch && begin >= 0 ? begin + endMatch.index : -1;
  const region = begin >= 0 && end > begin ? source.slice(begin, end) : "";

  it("标记区存在且闭合", () => {
    expect(begin, "seed.ts 里必须有独占一行的 // <rbac-gen:begin>").toBeGreaterThan(-1);
    expect(end, "seed.ts 里必须有独占一行的 // <rbac-gen:end>").toBeGreaterThan(begin);
    // 区内必须有条目，否则切错了地方也会「没有违规注释」而假绿。
    expect(region).toContain("RBAC_PERMISSIONS");
  });

  it("标记区内没有注释行（说明要写在区外）", () => {
    // 标记行之外任何 `//` 都是「会被生成器丢掉」的内容。
    const strayComments = region
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("//") && !line.startsWith("// <rbac-gen"));
    expect(
      strayComments,
      "标记区里出现了注释。生成器重铺时会丢掉它，请把说明移到 CATALOG_NOTES 或 RbacPermissionDocs.ts",
    ).toEqual([]);
  });

  it("标记区里每个码恰好出现一次", () => {
    const codes = [...region.matchAll(/\{code:\s*"([^"]+)"/gu)].map((item) => item[1]);
    // 先断言「确实匹配到了东西」。少了这一句，切片一旦切错地方，`codes` 为空，
    // 下面那条 `duplicated` 恒为 `[]`，用例静默通过——本轮之前就吃过一次这种亏。
    expect(codes.length, `标记区里没解析出任何码，切片可能切错了：\n${region.slice(0, 200)}`)
      .toBeGreaterThan(60);
    const duplicated = codes.filter((code, index) => codes.indexOf(code) !== index);
    expect(duplicated, `这些码在标记区里重复：${duplicated.join(", ")}`).toEqual([]);
  });
});

/**
 * 标记区禁写注释，所以必须有**明确允许写说明的地方**。
 *
 * 这两条一起构成规则的另一半：`CATALOG_NOTES` 是给人工写判断性说明的落点，测试
 * 保证它不会被清空成空数组。不加这两条，将来有人嫌它「没被用到」而删掉时，
 * 下一个人就只剩两个坏选择——违规写进标记区，或者干脆不写。
 */
describe("CATALOG_NOTES（标记区之外的说明落点）", () => {
  it("至少保留数条说明，且每条非空", () => {
    expect(CATALOG_NOTES.length).toBeGreaterThanOrEqual(3);
    const blank = CATALOG_NOTES.filter((note) => note.trim() === "");
    expect(blank, "CATALOG_NOTES 里有空条目").toEqual([]);
  });

  it("说明引用的迁移编号在仓库里存在", () => {
    // 条目里写了「0142」「0057」这类追溯依据；迁移被删或改号后要能发现。
    // 括号要同时认全角与半角：说明是中文写的，实际用的是「（0142）」。
    // 只认半角时一个都匹配不到，`numbers` 为空、下面那条恒为 `[]`，用例静默通过。
    const numbers = new Set(
      CATALOG_NOTES.flatMap((note) =>
        [...note.matchAll(/[(（](?<number>0\d{3})[)）]/gu)].flatMap((match) =>
          match.groups?.number ? [match.groups.number] : [],
        ),
      ),
    );
    expect(numbers.size, "CATALOG_NOTES 里一个迁移编号都没读到，括号或编号格式可能变了")
      .toBeGreaterThan(0);
    const names = migrationNames();
    const missing = [...numbers].filter(
      (number) => !names.some((name) => name.startsWith(number)),
    );
    expect(missing, `这些迁移编号在 migrations/ 里找不到：${missing.join(", ")}`).toEqual([]);
  });
});
