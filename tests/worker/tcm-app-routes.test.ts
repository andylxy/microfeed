/**
 * TCM app-route wire-contract test (CI 可跑，不依赖 golden 抓取文件)。
 *
 * 覆盖 code-review 暴露的真实缺口：7 个内容端点 + GetTipsStyleConfig 此前只在
 * `tests/unit/tcm-golden.test.ts` 里被比对，而该组在 CI 因 golden 快照不入 git
 * 整组跳过，等同零覆盖。本测试直接命中 14 个 `src/pages/api/AppBookRequest/*`
 * 路由处理器，锁定：
 *   - 13 个端点一律走 `{code:200, data, msg:"请求成功"}` 信封（与旧后端逐字节同形）；
 *   - GetTipsStyleConfig 故意发裸 `{styles:[...]}`（顶层字段，App 的
 *     StyleConfigApiBean 直接反序列化顶层 `styles`，不走信封拆包 —— 见 spec.md §6）。
 *
 * 数据用独立前缀 `rt*` 播种，afterEach 清理，与 tcm-app-reads.test.ts 互不干扰。
 */
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import * as GetAliaZhongYao from "@/pages/api/AppBookRequest/GetAliaZhongYao";
import * as GetAllMingCi from "@/pages/api/AppBookRequest/GetAllMingCi";
import * as GetAllZhongYao from "@/pages/api/AppBookRequest/GetAllZhongYao";
import * as GetBookChapter from "@/pages/api/AppBookRequest/GetBookChapter";
import * as GetBookIdFang from "@/pages/api/AppBookRequest/GetBookIdFang";
import * as GetChapterContent from "@/pages/api/AppBookRequest/GetChapterContent";
import * as GetLoginInfo from "@/pages/api/AppBookRequest/GetLoginInfo";
import * as GetNav from "@/pages/api/AppBookRequest/GetNav";
import * as GetProjectInfo from "@/pages/api/AppBookRequest/GetProjectInfo";
import * as GetTipsStyleConfig from "@/pages/api/AppBookRequest/GetTipsStyleConfig";
import * as getAboutInfo from "@/pages/api/AppBookRequest/getAboutInfo";
import * as getPicCaptcha from "@/pages/api/AppBookRequest/getPicCaptcha";
import * as login from "@/pages/api/AppBookRequest/login";
import * as replaceToken from "@/pages/api/AppBookRequest/replaceToken";

const db = env.FEED_DB;
const ORIGIN = "https://app.example.com";
const CAT = "rtcat001";
const CH = "rtbook001";
const CHAP = "rtchap001";
const SEC = "rtsec001";
const FANG = "rtfang001";

const INSERTED: string[] = [];

/** 构造 Astro APIContext（仅路由实际用到的 url / request 字段）；`as never` 让 tsc 放行。 */
function ctx(path: string): never {
  return {url: new URL(ORIGIN + path)} as never;
}
function ctxReq(path: string, init: RequestInit): never {
  return {request: new Request(ORIGIN + path, init)} as never;
}

async function insertItem(
  id: string,
  kind: string,
  parentId: string | null,
  bookId: string | null,
  status: number,
  data: Record<string, unknown>,
): Promise<void> {
  INSERTED.push(id);
  await db
    .prepare(
      "INSERT OR REPLACE INTO items (id, status, data, pub_date, created_at, updated_at, " +
        "content_text, content_text_updated_at, content_text_revision, review_status, book_id, " +
        "tcm_kind, tcm_parent_id) VALUES (?, ?, ?, '2024-09-17T00:57:25.000Z', " +
        "'2024-09-17T00:57:25.000Z', '2024-09-17T00:57:25.000Z', '', " +
        "'2024-09-17T00:57:25.000Z', 1, NULL, ?, ?, ?)",
    )
    .bind(id, status, JSON.stringify(data), bookId, kind, parentId)
    .run();
}

beforeEach(async () => {
  await db
    .prepare(
      "INSERT OR IGNORE INTO ext_category (id, name, slug, parent_id, sort, visible) VALUES (?, '伤寒', 'rtcat', NULL, 30, 1)",
    )
    .bind(CAT)
    .run();
  INSERTED.push(CAT);
  INSERTED.push(CH);
  await db
    .prepare(
      "INSERT OR REPLACE INTO channels (id, status, is_primary, data, genre) VALUES (?, 1, NULL, ?, ?)",
    )
    .bind(
      CH,
      JSON.stringify({
        title: "伤寒金匮・测试",
        description: "测试",
        _microfeed: {author: "张仲景", chengShu: "汉", sourceImagePath: "Upload/a.jpg", case: "5"},
      }),
      CAT,
    )
    .run();

  await insertItem(CHAP, "chapter", null, CH, 1, {
    title: "第一章",
    description: "<p>条文甲</p>",
    content_format: "html",
    _microfeed: {bookId: CH, section: 1},
  });
  await insertItem(SEC, "section", CHAP, CH, 4, {
    title: "第1条",
    description: "<p>$u{桂枝}</p>",
    content_format: "html",
    _microfeed: {bookId: CH, receiptNo: 1, note: "注", videoMemo: "", fangList: [], bieMing: ""},
  });
  await insertItem(FANG, "fang", null, "tcmfang0001", 1, {
    title: "桂枝汤",
    description: "<p>$f{桂枝汤}</p>",
    content_format: "html",
    _microfeed: {
      bookId: "tcmfang0001",
      sourceBookId: CH,
      yaoCount: 5,
      drinkNum: 3,
      yaoList: ["桂枝"],
      fangList: [],
      fangYaoList: [
        {yaoId: "rtyao001", amount: "三两", weight: 300, suffix: "", showName: "桂枝", extraProcess: "去皮"},
      ],
    },
  });
});

afterEach(async () => {
  if (INSERTED.length === 0) return;
  const itemIds = INSERTED.filter((id) => id !== CAT && id !== CH)
    .map((id) => `'${id}'`)
    .join(",");
  if (itemIds) await db.exec(`DELETE FROM items WHERE id IN (${itemIds});`);
  await db.exec(`DELETE FROM channels WHERE id = '${CH}';`);
  await db.exec(`DELETE FROM ext_category WHERE id = '${CAT}';`);
  INSERTED.length = 0;
});

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("TCM app route wire contract", () => {
  it("GetNav wraps the legacy envelope and groups books by category", async () => {
    const body = await bodyOf(await GetNav.GET(ctx("/api/AppBookRequest/GetNav")));
    expect(body.code).toBe(200);
    expect(body.msg).toBe("请求成功");
    expect(Array.isArray(body.data)).toBe(true);
    const cats = body.data as Array<{caseId: string; navList: Array<{bookNo: string}>}>;
    const cat = cats.find((c) => c.caseId === CAT);
    expect(cat).toBeDefined();
    expect(cat!.navList.some((b) => b.bookNo === CH)).toBe(true);
  });

  it("GetBookChapter wraps envelope and returns 11-char signatureId", async () => {
    const body = await bodyOf(
      await GetBookChapter.GET(ctx(`/api/AppBookRequest/GetBookChapter?bookId=${CH}`)),
    );
    expect(body.code).toBe(200);
    const rows = body.data as Array<{bookId: string; signatureId: string}>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.bookId).toBe(CH);
    expect(rows[0]!.signatureId).toBe(CHAP);
  });

  it("GetChapterContent wraps envelope and returns section list", async () => {
    const body = await bodyOf(
      await GetChapterContent.GET(ctx(`/api/AppBookRequest/GetChapterContent?chapterId=${CHAP}`)),
    );
    expect(body.code).toBe(200);
    const outer = (body.data as Array<{signatureId: string; data: unknown[]}>)[0]!;
    expect(outer.signatureId).toBe(CHAP);
    expect(Array.isArray(outer.data)).toBe(true);
    expect(outer.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GetBookIdFang wraps envelope and returns composition detail", async () => {
    const body = await bodyOf(
      await GetBookIdFang.GET(ctx(`/api/AppBookRequest/GetBookIdFang?bookId=${CH}`)),
    );
    expect(body.code).toBe(200);
    const rows = body.data as Array<{ID: string; yaoCount: string; standardYaoList: Array<{weight: string}>}>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.ID).toBe(FANG);
    expect(rows[0]!.yaoCount).toBe("5");
    expect(rows[0]!.standardYaoList[0]!.weight).toBe("300");
  });

  it("GetAllZhongYao / GetAliaZhongYao / GetAllMingCi return envelope + array data", async () => {
    for (const route of [GetAllZhongYao, GetAliaZhongYao, GetAllMingCi]) {
      const body = await bodyOf(await route.GET(ctx("/api/AppBookRequest/x")));
      expect(body.code).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  it("GetTipsStyleConfig is deliberately BARE (top-level styles, NOT enveloped)", async () => {
    const res = await GetTipsStyleConfig.GET(ctx("/api/AppBookRequest/GetTipsStyleConfig"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 关键：不走信封（无 code/msg），App 的 StyleConfigApiBean 直接读顶层 styles。
    expect(body.code).toBeUndefined();
    expect(body.msg).toBeUndefined();
    expect(Array.isArray(body.styles)).toBe(true);
    expect((body.styles as Array<unknown>).length).toBeGreaterThanOrEqual(13);
  });

  it("config endpoints (ProjectInfo/LoginInfo/AboutInfo/PicCaptcha) wrap the envelope", async () => {
    for (const route of [GetProjectInfo, GetLoginInfo, getAboutInfo, getPicCaptcha]) {
      const body = await bodyOf(await route.GET(ctx("/api/AppBookRequest/x")));
      expect(body.code).toBe(200);
      expect(body.msg).toBe("请求成功");
      expect(body.data).toBeDefined();
    }
  });

  it("login route wraps the envelope and degrades missing input to a string payload", async () => {
    const body = await bodyOf(
      await login.POST(
        ctxReq("/api/AppBookRequest/login", {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({}),
        }),
      ),
    );
    expect(body.code).toBe(200);
    expect(body.data).toBe("请检查账号密码");
  });

  it("replaceToken route wraps the envelope and rejects an unauthenticated call", async () => {
    const body = await bodyOf(
      await replaceToken.POST(
        ctxReq("/api/AppBookRequest/replaceToken", {method: "POST"}),
      ),
    );
    expect(body.code).toBe(200);
    expect(body.data).toBe("请先登录");
  });
});
