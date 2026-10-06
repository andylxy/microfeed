import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as announcementsIndex} from "@/pages/[adminPath]/ajax/announcements/index";
import {POST as announcementsSave} from "@/pages/[adminPath]/ajax/announcements/save";
import {
  ANNOUNCEMENT_STATUS,
  createAnnouncement,
  getAnnouncement,
  listAdminAnnouncements,
  setStatus,
  updateAnnouncement,
  validateAnnouncementDraft,
  validateWindow,
} from "@/server/app-announcement/store";
import {PERMISSION_CODES} from "@/shared/Constants";

/**
 * 公告管理看板的端点层（DESIGN §5.4/§5.6）。
 *
 * 锁住三件容易静默回归的事：
 * - 读写权限分离：`:read` 能看列表，`:manage` 才能改；只读账号写入必须 403
 *   （否则 UI 藏起按钮就成唯一防线，curl 直接绕过）。
 * - 「已过期」标签能同时捞出 `status=3` 和「status=2 但 valid_to 已过」——后者
 *   在公开端点早已不下发，若列表也不列出来，运营会以为公告还在线。
 * - 校验失败不写入：空标题 / 超长 / 窗口颠倒都必须在落库前被拒。
 */

const db = env.FEED_DB;
const READ_URL = "https://feed.example.com/admin/ajax/announcements/";
const SAVE_URL = "https://feed.example.com/admin/ajax/announcements/save/";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");

function locals(...codes: string[]) {
  return {
    authUser: {id: "u-ann"},
    rbacPermissions: new Set<string>(codes),
  };
}

function readLocals() {
  return locals(PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_READ);
}

function manageLocals() {
  return locals(
    PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_READ,
    PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_MANAGE,
  );
}

function getRequest(url: string): Request {
  return new Request(url);
}

function postRequest(body: unknown): Request {
  return new Request(SAVE_URL, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
}

async function callGet(url = READ_URL) {
  return announcementsIndex({locals: readLocals(), request: getRequest(url)} as never);
}

async function callPost(body: unknown, who = manageLocals()) {
  return announcementsSave({locals: who, request: postRequest(body)} as never);
}

beforeEach(async () => {
  await db.prepare("DELETE FROM ext_app_announcement").run();
});

describe("admin announcements list endpoint", () => {
  it("requires the read code", async () => {
    const denied = await announcementsIndex({
      locals: locals(),
      request: getRequest(READ_URL),
    } as never);
    expect(denied.status).toBe(403);
  });

  it("returns rows for the requested tab", async () => {
    await createAnnouncement(db, {title: "d1", status: ANNOUNCEMENT_STATUS.DRAFT}, NOW);
    await createAnnouncement(db, {title: "p1", status: ANNOUNCEMENT_STATUS.PUBLISHED}, NOW);

    const response = await callGet(`${READ_URL}?tab=draft`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {rows: Array<{title: string}>};
    expect(body.rows.map((r) => r.title)).toEqual(["d1"]);
  });

  it("lists time-expired published rows under the expired tab", async () => {
    // 端点的 `expired` 分支用**真实时钟**（`Date.now()`）判定 valid_to 是否已过，
    // 所以这里的过期时间必须相对当下构造，不能用固定的 NOW —— NOW 是上午
    // 12:00Z，若真实时间早于它，「已过期」的行就还没过期，测不到那条分支。
    const realNow = Date.now();
    await createAnnouncement(
      db,
      {title: "status-expired", status: ANNOUNCEMENT_STATUS.EXPIRED},
      NOW,
    );
    await createAnnouncement(
      db,
      {
        title: "time-expired",
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
        validTo: realNow - 1000,
      },
      NOW,
    );
    await createAnnouncement(
      db,
      {
        title: "live",
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
        validTo: realNow + 3_600_000,
      },
      NOW,
    );

    const response = await callGet(`${READ_URL}?tab=expired`);
    const body = (await response.json()) as {rows: Array<{title: string}>};
    expect(body.rows.map((r) => r.title).sort()).toEqual([
      "status-expired",
      "time-expired",
    ]);
  });

  it("rejects an unknown tab instead of silently falling back to all", async () => {
    const response = await callGet(`${READ_URL}?tab=nonsense`);
    expect(response.status).toBe(400);
  });

  it("defaults to the all tab when no tab is given", async () => {
    await createAnnouncement(db, {title: "a", status: ANNOUNCEMENT_STATUS.DRAFT}, NOW);
    await createAnnouncement(db, {title: "b", status: ANNOUNCEMENT_STATUS.PUBLISHED}, NOW);
    const response = await callGet();
    const body = (await response.json()) as {tab: string; rows: unknown[]};
    expect(body.tab).toBe("all");
    expect(body.rows).toHaveLength(2);
  });

  it("returns a single row by id for the edit form", async () => {
    // 票据 04 明文要求 index.ts 提供 list/get/setStatus 三个动作。
    const created = await createAnnouncement(
      db,
      {title: "single", body: "b", status: ANNOUNCEMENT_STATUS.DRAFT},
      NOW,
    );
    const response = await callGet(`${READ_URL}?id=${created.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {row: {id: number; title: string}};
    expect(body.row.id).toBe(created.id);
    expect(body.row.title).toBe("single");
  });

  it("404s an unknown id and 400s a malformed one", async () => {
    expect((await callGet(`${READ_URL}?id=999999`)).status).toBe(404);
    expect((await callGet(`${READ_URL}?id=abc`)).status).toBe(400);
    expect((await callGet(`${READ_URL}?id=0`)).status).toBe(400);
  });
});

describe("admin announcements save endpoint", () => {
  it("requires the manage code for every write", async () => {
    // 只读账号写入必须 403：UI 隐藏按钮不是防线，curl 能绕。
    const created = await callPost(
      {create: {title: "x", status: ANNOUNCEMENT_STATUS.DRAFT}},
      locals(PERMISSION_CODES.SYSTEM_ANNOUNCEMENT_READ),
    );
    expect(created.status).toBe(403);
    expect(await db.prepare("SELECT * FROM ext_app_announcement").all()).toMatchObject({
      results: [],
    });
  });

  it("creates an announcement", async () => {
    const response = await callPost({
      create: {title: "停服通知", body: "今晚 02:00 停服", status: ANNOUNCEMENT_STATUS.PUBLISHED},
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {ok: boolean; row: {title: string; version: number}};
    expect(body.ok).toBe(true);
    expect(body.row.title).toBe("停服通知");
    expect(body.row.version).toBe(1);
  });

  it("rejects an empty title without writing", async () => {
    const response = await callPost({create: {title: "   "}});
    expect(response.status).toBe(400);
    expect(await db.prepare("SELECT * FROM ext_app_announcement").all()).toMatchObject({
      results: [],
    });
  });

  it("rejects a window whose start is after its end", async () => {
    const response = await callPost({
      create: {title: "bad window", validFrom: NOW + 10_000, validTo: NOW},
    });
    expect(response.status).toBe(400);
    expect(await db.prepare("SELECT * FROM ext_app_announcement").all()).toMatchObject({
      results: [],
    });
  });

  it("edits an announcement and bumps version on content change", async () => {
    const created = await createAnnouncement(
      db,
      {title: "v1", body: "b1", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );

    const response = await callPost({
      update: {id: created.id, title: "v2", body: "b1", status: ANNOUNCEMENT_STATUS.PUBLISHED},
    });
    expect(response.status).toBe(200);
    const row = await getAnnouncement(db, created.id);
    expect(row?.title).toBe("v2");
    expect(row?.version).toBe(2);
  });

  it("404s an update to a missing id", async () => {
    const response = await callPost({update: {id: 999999, title: "nope"}});
    expect(response.status).toBe(404);
  });

  it("soft-deletes via setStatus and keeps the row", async () => {
    const created = await createAnnouncement(
      db,
      {title: "bye", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const response = await callPost({
      setStatus: {id: created.id, status: ANNOUNCEMENT_STATUS.DELETED},
    });
    expect(response.status).toBe(200);
    // 软删保留行（审计），只是不再生效。
    const row = await getAnnouncement(db, created.id);
    expect(row?.status).toBe(ANNOUNCEMENT_STATUS.DELETED);
  });

  it("rejects setStatus to draft (not a status action target)", async () => {
    const created = await createAnnouncement(
      db,
      {title: "keep", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const response = await callPost({
      setStatus: {id: created.id, status: ANNOUNCEMENT_STATUS.DRAFT},
    });
    expect(response.status).toBe(400);
  });

  it("404s a setStatus on a missing id", async () => {
    const response = await callPost({setStatus: {id: 999999, status: ANNOUNCEMENT_STATUS.EXPIRED}});
    expect(response.status).toBe(404);
  });

  it("rejects a payload with no recognised action", async () => {
    const response = await callPost({nonsense: true});
    expect(response.status).toBe(400);
  });

  it("stores LF when the admin submits CRLF from a textarea", async () => {
    // 全链路：后台 textarea 用 Enter 换行 → 浏览器提交 CRLF → 端点 → 入库。
    // 断言库里是 \n：TextView 遇到 \r 会多渲染一个空行。
    const response = await callPost({
      create: {
        title: "多行公告",
        body: "第一段\r\n\r\n第二段",
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {row: {id: number; body: string}};
    expect(body.row.body).toBe("第一段\n\n第二段");
    expect(body.row.body).not.toContain("\r");

    // 再读库确认（响应经过了 JSON 转义，读库更直接）。
    const stored = await getAnnouncement(db, body.row.id);
    expect(stored?.body).toBe("第一段\n\n第二段");
  });

  it("keeps a single newline as one line break", async () => {
    // 只有一个换行时不能变成两个空行。
    const response = await callPost({
      create: {title: "单换行", body: "上\r\n下", status: ANNOUNCEMENT_STATUS.PUBLISHED},
    });
    const body = (await response.json()) as {row: {body: string}};
    expect(body.row.body).toBe("上\n下");
  });
});

describe("announcement validation (pure)", () => {
  it("accepts a minimal valid draft", () => {
    expect(validateAnnouncementDraft({title: "ok"})).toEqual({ok: true});
  });

  it("rejects a blank or whitespace-only title", () => {
    expect(validateAnnouncementDraft({title: ""})).toEqual({
      ok: false,
      reason: "invalidTitle",
    });
    expect(validateAnnouncementDraft({title: "  \n "})).toEqual({
      ok: false,
      reason: "invalidTitle",
    });
  });

  it("treats an inverted window as invalid", () => {
    expect(validateWindow(NOW + 10, NOW)).toEqual({ok: false, reason: "invalidWindow"});
    expect(validateWindow(NOW, NOW + 10)).toEqual({ok: true});
    // 空端=无边界，单独一个端点不算错。
    expect(validateWindow(null, NOW)).toEqual({ok: true});
    expect(validateWindow(NOW, null)).toEqual({ok: true});
    expect(validateWindow(null, null)).toEqual({ok: true});
  });

  it("rejects an out-of-range priority", () => {
    expect(validateAnnouncementDraft({title: "t", priority: 99999})).toEqual({
      ok: false,
      reason: "invalidPriority",
    });
  });

  it("accepts every real status value", () => {
    // 回归防护：曾经用 `hasOwnProperty(ANNOUNCEMENT_STATUS, "2")` 判状态，
    // 而该对象的键是 DRAFT/PUBLISHED/…，于是**每个**合法状态都被判非法，
    // 新建公告一律 400。合法状态必须按「值」判定。
    for (const status of [
      ANNOUNCEMENT_STATUS.DRAFT,
      ANNOUNCEMENT_STATUS.PUBLISHED,
      ANNOUNCEMENT_STATUS.EXPIRED,
      ANNOUNCEMENT_STATUS.DELETED,
    ]) {
      expect(validateAnnouncementDraft({title: "t", status})).toEqual({ok: true});
    }
  });

  it("still rejects a status outside the enum", () => {
    expect(validateAnnouncementDraft({title: "t", status: 9 as never})).toEqual({
      ok: false,
      reason: "invalidStatus",
    });
  });
});

describe("updateAnnouncement keeps the window when the form omits it", () => {
  it("preserves validTo when only the title is edited", async () => {
    // 表单整存时总会带上两个时间，但 update 的契约是「缺省字段保持原值」，
    // 这里钉住它，免得将来改成「缺省即清空」把正在生效的公告提前下线。
    const created = await createAnnouncement(
      db,
      {
        title: "keep-window",
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
        validTo: NOW + 86_400_000,
      },
      NOW,
    );
    const updated = await updateAnnouncement(db, created.id, {title: "new-title"});
    expect(updated?.validTo).toBe(NOW + 86_400_000);
  });
});

describe("admin tab filter helper", () => {
  it("keeps the expired branch in sync with a freshly published row", async () => {
    // 直接打 store 的 expired 分支，确认它与端点用的是同一套判定。
    const created = await createAnnouncement(
      db,
      {title: "p", status: ANNOUNCEMENT_STATUS.PUBLISHED, validTo: NOW + 1000},
      NOW,
    );
    expect(await listAdminAnnouncements(db, "expired", NOW)).toHaveLength(0);
    await setStatus(db, created.id, ANNOUNCEMENT_STATUS.EXPIRED, NOW);
    expect(await listAdminAnnouncements(db, "expired", NOW)).toHaveLength(1);
  });
});
