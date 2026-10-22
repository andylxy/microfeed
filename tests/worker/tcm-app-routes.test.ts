/**
 * TCM app-route wire-contract test (CI 可跑，不依赖 golden 抓取文件)。
 *
 * 覆盖 code-review 暴露的真实缺口：7 个内容端点 + GetTipsStyleConfig 此前只在
 * `tests/unit/tcm-golden.test.ts` 里被比对，而该组在 CI 因 golden 快照不入 git
 * 整组跳过，等同零覆盖。本测试直接命中 14 个 `src/pages/api/AppBookRequest/*`
 * 路由处理器，锁定：
 *   - 14 个端点一律走 `{code:200, data, msg:"请求成功"}` 信封（与旧后端逐字节同形）。
 *     2026-10-16（ADR-0028 D4）：GetTipsStyleConfig 此前是唯一例外（故意发裸 `{styles}`），
 *     已改为同形 —— App 的声明 `HttpCallback<HttpData<…>>` 要信封，裸包实测解析失败。
 *
 * 数据用独立前缀 `rt*` 播种，afterEach 清理，与 tcm-app-reads.test.ts 互不干扰。
 */
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {env} from "cloudflare:workers";

import * as GetAliaZhongYao from "@/pages/api/AppBookRequest/GetAliaZhongYao";
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
/** 会员书用例专用：独立 id，避免撞上同文件早前用例写进的公开桶缓存。 */
const MEMBER_BOOK = "rtbook002";
const MEMBER_CHAP = "rtchap002";

const INSERTED: string[] = [];
/** 播种的频道（含用例里另建的会员书），afterEach 一并清掉。 */
const SEEDED_CHANNELS: string[] = [CH];

/**
 * 构造 Astro APIContext（仅路由实际用到的字段）；`as never` 让 tsc 放行。
 * `locals` 给空对象：GetNav 会读 `locals.appMember`（非会员走公开桶）。
 */
function ctx(path: string): never {
  return {locals: {}, url: new URL(ORIGIN + path)} as never;
}
/** 端点上下文：`appMember` 由鉴权写进 locals，端点据此选档（会员 / 公开）。 */
function ctxTier(path: string, appMember: boolean): never {
  return {locals: {appMember}, url: new URL(ORIGIN + path)} as never;
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
        // `_microfeed.genre` 必须给：迁移 0113 的 `AFTER INSERT` 触发器会用
        // `json_extract(NEW.data, '$._microfeed.genre')` 覆写 `genre` 列（JSON 是 SSOT、
        // 列是镜像）。只写列不写 JSON ⇒ 列被覆盖成 NULL ⇒ `getAppNav` 的
        // `ch.genre = c.id` JOIN 匹配不上，分类凭空消失（本测试曾因此失败）。
        _microfeed: {
          author: "张仲景",
          chengShu: "汉",
          sourceImagePath: "Upload/a.jpg",
          case: "5",
          genre: CAT,
        },
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
  const channelIds = SEEDED_CHANNELS.map((id) => `'${id}'`).join(",");
  if (channelIds) await db.exec(`DELETE FROM channels WHERE id IN (${channelIds});`);
  await db.exec(`DELETE FROM ext_category WHERE id = '${CAT}';`);
  INSERTED.length = 0;
  SEEDED_CHANNELS.length = 0;
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
    // Fang.ID 是「本方在本书内的 0-based 序号」而非 11 位 tcmId：App Gson 的
    // IntegerTypeAdapter 只接受数值/数值字符串，下发 tcmId 会让 App 崩。
    // 2026-10-03 拍板 A（.scratch/tcm-import/golden/compare.mts:36-39）。
    // 本断言曾写 toBe(FANG)（11 位 id），21eb535 改实现后未同步。
    expect(rows[0]!.ID).toBe("0");
    expect(rows[0]!.yaoCount).toBe("5");
    expect(rows[0]!.standardYaoList[0]!.weight).toBe("300");
  });

  it("会员书：公开档端点读不到，会员档端点能读到（接线到 locals.appMember）", async () => {
    INSERTED.push(MEMBER_BOOK);
    SEEDED_CHANNELS.push(MEMBER_BOOK);
    await db
      .prepare(
        "INSERT OR REPLACE INTO channels (id, status, is_primary, data, genre) VALUES (?, 10, NULL, ?, ?)",
      )
      .bind(
        MEMBER_BOOK,
        JSON.stringify({
          title: "会员书",
          description: "测试",
          _microfeed: {author: "张仲景", genre: CAT},
        }),
        CAT,
      )
      .run();
    await insertItem(MEMBER_CHAP, "chapter", null, MEMBER_BOOK, 1, {
      title: "会员章",
      description: "<p>会员条文</p>",
      content_format: "html",
      _microfeed: {bookId: MEMBER_BOOK, section: 1},
    });

    const chaptersOf = async (appMember: boolean) => {
      const body = await bodyOf(await GetBookChapter.GET(ctxTier(
        `/api/AppBookRequest/GetBookChapter?bookId=${MEMBER_BOOK}`,
        appMember,
      )));
      return body.data as Array<{bookNo: string}>;
    };
    expect(await chaptersOf(false)).toEqual([]);
    expect((await chaptersOf(true)).length).toBeGreaterThan(0);

    const contentOf = async (appMember: boolean) => {
      const body = await bodyOf(await GetChapterContent.GET(ctxTier(
        `/api/AppBookRequest/GetChapterContent?chapterId=${MEMBER_CHAP}`,
        appMember,
      )));
      return body.data as unknown[];
    };
    expect(await contentOf(false)).toEqual([]);
    expect((await contentOf(true)).length).toBeGreaterThan(0);
  });

  it("GetAllZhongYao / GetAliaZhongYao return envelope + array data", async () => {
    for (const route of [GetAllZhongYao, GetAliaZhongYao]) {
      const body = await bodyOf(await route.GET(ctx("/api/AppBookRequest/x")));
      expect(body.code).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  // GetAllMingCi 现已加服务端纵深防御（需 `app:mingci:view`），单独由
  // tests/worker/app-mingci-getall.test.ts 覆盖（含码 / 缺码 / 无凭证三类）。

  it("GetTipsStyleConfig wraps the envelope and carries a server version", async () => {
    // 2026-10-16（ADR-0028 D4）：本端点曾**故意**发裸 `{styles}` —— 旧注释称「App 用本地兜底、
    // RequestHandler 对非 HttpData 不做拆包」。但 App 的实际声明是 `HttpCallback<HttpData<…>>`
    // （要信封、会拆包），联调实测裸包 `Http request fail`。且 `enableStyleConfig` 长期为 false
    // ⇒ 历史上没有任何已发布 App 真正调用过它，没有在野消费者 ⇒ 改成与其余端点同形。
    const res = await GetTipsStyleConfig.GET(ctx("/api/AppBookRequest/GetTipsStyleConfig"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: {styles?: unknown[]; version?: number};
    };
    expect(body.code).toBe(200);
    expect(body.msg).toBe("请求成功");
    expect(Array.isArray(body.data?.styles)).toBe(true);
    expect(body.data!.styles!.length).toBeGreaterThanOrEqual(13);
    // 版本号 = MAX(updated_at_ms)，App 靠它判断手里的缓存是否最新（ADR-0028 D3）。
    expect(typeof body.data!.version).toBe("number");
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
