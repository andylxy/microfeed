import {describe, expect, it} from "vitest";

import {
  getAppAllYao,
  getAppBookFang,
  getAppChapterContent,
  getAppYaoAliases,
} from "@/server/tcm/reads";

/**
 * 进 24h 共享桶的读取函数（ADR-0049 D1）在 D1 故障时就地抛出：
 * 失败不降级为空值，端点得以 5xx 返回、`cachedAppResponse` 不会把空响应
 * 写进桶。不进桶的读取（GetAllMingCi / GetTipsStyleConfig / 后台别名板）
 * 维持 withEmpty 降级，不在本断言范围。
 */

/** prepare 即抛的故障 D1 桩：模拟瞬时故障（连接断开 / 配额拒绝）。 */
const brokenDb = {
  prepare() {
    throw new Error("d1 unavailable");
  },
} as unknown as D1Database;

describe("bucket-fed app reads rethrow on D1 failure (ADR-0049 D1)", () => {
  it("getAppChapterContent rethrows instead of degrading to []", async () => {
    await expect(
      getAppChapterContent(brokenDb, "chap0000001", "public"),
    ).rejects.toThrow("d1 unavailable");
  });

  it("getAppBookFang rethrows instead of degrading to []", async () => {
    await expect(
      getAppBookFang(brokenDb, "book0000001", "public"),
    ).rejects.toThrow("d1 unavailable");
  });

  it("getAppAllYao rethrows instead of degrading to []", async () => {
    await expect(getAppAllYao(brokenDb)).rejects.toThrow("d1 unavailable");
  });

  it("getAppYaoAliases rethrows instead of degrading to []", async () => {
    await expect(getAppYaoAliases(brokenDb)).rejects.toThrow("d1 unavailable");
  });
});
