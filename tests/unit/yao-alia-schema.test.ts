import {describe, expect, it} from "vitest";

import {
  yaoAliaCreateSchema,
  yaoAliaUpdateSchema,
} from "@/shared/YaoAlia";

/**
 * `@/shared/YaoAlia` 是新建/编辑载荷的**唯一真源**：UI 与 server 的
 * `handlers.ts` 都从这里 import，所以结构约束只在这一层断言。
 * 表约束（`yao_alia_bie_ming` UNIQUE）不归 schema 管，见 store 测试。
 */
describe("yaoAlia schemas", () => {
  it("accepts an alias with both required fields", () => {
    const parsed = yaoAliaCreateSchema.safeParse({
      bieMing: "术",
      yaoName: "白术",
    });
    expect(parsed.success).toBe(true);
  });

  it("trims leading/trailing whitespace on both text fields", () => {
    const parsed = yaoAliaCreateSchema.parse({
      bieMing: "  术  ",
      yaoName: "\t白术\n",
    });
    // 源数据两列实测行尾空格 0、别名内空格 0；trim 只挡人工输入的首尾空白，
    // 不改字段内部内容。
    expect(parsed.bieMing).toBe("术");
    expect(parsed.yaoName).toBe("白术");
  });

  it("rejects an empty or whitespace-only alias", () => {
    expect(yaoAliaCreateSchema.safeParse({bieMing: "", yaoName: "白术"}).success)
      .toBe(false);
    expect(yaoAliaCreateSchema.safeParse({bieMing: "   ", yaoName: "白术"}).success)
      .toBe(false);
  });

  it("rejects a missing canonical name", () => {
    expect(yaoAliaCreateSchema.safeParse({bieMing: "术"}).success).toBe(false);
  });

  it("rejects a text longer than the source column width (255)", () => {
    const tooLong = "别".repeat(256);
    expect(yaoAliaCreateSchema.safeParse({bieMing: tooLong, yaoName: "白术"}).success)
      .toBe(false);
    expect(yaoAliaCreateSchema.safeParse({bieMing: "术", yaoName: tooLong}).success)
      .toBe(false);
  });

  it("accepts an optional isEnable toggle and leaves it undefined when absent", () => {
    const withoutFlag = yaoAliaCreateSchema.parse({bieMing: "术", yaoName: "白术"});
    expect(withoutFlag.isEnable).toBeUndefined();
    const disabled = yaoAliaCreateSchema.parse({
      bieMing: "术",
      yaoName: "白术",
      isEnable: false,
    });
    expect(disabled.isEnable).toBe(false);
  });

  it("rejects null for the NOT NULL text columns", () => {
    expect(
      yaoAliaCreateSchema.safeParse({bieMing: null, yaoName: "白术"}).success,
    ).toBe(false);
    expect(
      yaoAliaUpdateSchema.safeParse({bieMing: "术", yaoName: null}).success,
    ).toBe(false);
  });

  it("update schema accepts a partial patch (one field only)", () => {
    const patch = yaoAliaUpdateSchema.parse({yaoName: "桂枝"});
    expect(patch.yaoName).toBe("桂枝");
    expect(patch.bieMing).toBeUndefined();
  });

  it("update schema accepts an empty object (handler rejects it, not the schema)", () => {
    // 「空 patch」是 handler 的 400 判定（`Object.keys(parsed.data).length === 0`），
    // schema 层不并入这条业务规则——两层职责分开，测试钉住这条分工。
    expect(yaoAliaUpdateSchema.safeParse({}).success).toBe(true);
  });
});
