import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {
  ANNOUNCEMENT_STATUS,
  createAnnouncement,
  getAnnouncement,
  listActiveAnnouncements,
  listAdminAnnouncements,
  normalizeMultilineText,
  setStatus,
  updateAnnouncement,
  type AnnouncementDraft,
} from "@/server/app-announcement/store";

/**
 * Announcements 数据层（DESIGN §5.1/§5.2）。锁住三件事，它们都容易静默回归：
 *
 * - 公开查询只取 status=2 且落在生效窗口内的行（空端 = 无边界）；
 * - 排序严格 priority DESC、再 updated_at DESC；
 * - `updateAnnouncement` 只在 title/body 改动时 version+1，改状态/窗口不动 version。
 */
const db = env.FEED_DB;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");

async function seed(draft: AnnouncementDraft, now: number = NOW): Promise<number> {
  const row = await createAnnouncement(db, draft, now);
  return row.id;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM ext_app_announcement").run();
});

describe("listActiveAnnouncements", () => {
  it("only returns published rows inside the active window", async () => {
    await seed({title: "active", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    await seed({title: "draft", status: ANNOUNCEMENT_STATUS.DRAFT});
    await seed({title: "deleted", status: ANNOUNCEMENT_STATUS.DELETED});
    await seed({title: "expired-status", status: ANNOUNCEMENT_STATUS.EXPIRED});

    const rows = await listActiveAnnouncements(db, NOW);
    expect(rows.map((r) => r.title)).toEqual(["active"]);
  });

  it("hides rows whose valid_to has passed", async () => {
    await seed({
      title: "past-due",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validTo: NOW - 1000,
    });
    const rows = await listActiveAnnouncements(db, NOW);
    expect(rows).toHaveLength(0);
  });

  it("hides rows whose valid_from is in the future", async () => {
    await seed({
      title: "not-yet",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validFrom: NOW + 1000,
    });
    const rows = await listActiveAnnouncements(db, NOW);
    expect(rows).toHaveLength(0);
  });

  it("treats null window ends as unbounded", async () => {
    await seed({
      title: "forever",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validFrom: null,
      validTo: null,
    });
    const rows = await listActiveAnnouncements(db, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validFrom).toBeNull();
    expect(rows[0]!.validTo).toBeNull();
  });

  it("orders by priority desc, then updated_at desc", async () => {
    // 同 priority 时，updated_at 更晚（now 更大）的排前。
    const lowOld = await seed(
      {title: "low-old", priority: 1, status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW - 5000,
    );
    const lowNew = await seed(
      {title: "low-new", priority: 1, status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW - 1000,
    );
    const high = await seed(
      {title: "high", priority: 10, status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW - 3000,
    );

    const rows = await listActiveAnnouncements(db, NOW);
    expect(rows.map((r) => r.id)).toEqual([high, lowNew, lowOld]);
  });

  it("caps the result at the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seed({
        title: `a${i}`,
        priority: i,
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
      });
    }
    const rows = await listActiveAnnouncements(db, NOW, 3);
    expect(rows).toHaveLength(3);
  });

  it("does not leak status or timestamps in the public shape", async () => {
    const id = await seed({title: "shape", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    const [row] = await listActiveAnnouncements(db, NOW);
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
    expect("status" in row!).toBe(false);
    expect("createdAt" in row!).toBe(false);
  });
});

describe("updateAnnouncement version bump", () => {
  it("bumps version when title changes", async () => {
    const id = await seed({title: "v1", body: "b", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    const updated = await updateAnnouncement(db, id, {title: "v2"});
    expect(updated?.version).toBe(2);
    expect(updated?.title).toBe("v2");
  });

  it("bumps version when body changes", async () => {
    const id = await seed({title: "t", body: "b1", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    const updated = await updateAnnouncement(db, id, {body: "b2"});
    expect(updated?.version).toBe(2);
  });

  it("does NOT bump version when only the time window changes", async () => {
    const id = await seed({
      title: "t",
      body: "b",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validTo: NOW + 100_000,
    });
    const updated = await updateAnnouncement(db, id, {validTo: NOW + 200_000});
    expect(updated?.version).toBe(1);
    expect(updated?.validTo).toBe(NOW + 200_000);
  });

  it("does NOT bump version when only the status changes", async () => {
    const id = await seed({title: "t", body: "b", status: ANNOUNCEMENT_STATUS.DRAFT});
    const updated = await updateAnnouncement(db, id, {
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
    });
    expect(updated?.version).toBe(1);
    expect(updated?.status).toBe(ANNOUNCEMENT_STATUS.PUBLISHED);
  });

  it("returns null for a missing id", async () => {
    expect(await updateAnnouncement(db, 99999, {title: "x"})).toBeNull();
  });
});

describe("setStatus", () => {
  it("soft-deletes (status=4) without touching version", async () => {
    const id = await seed({title: "t", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    const after = await setStatus(db, id, ANNOUNCEMENT_STATUS.DELETED);
    expect(after?.status).toBe(ANNOUNCEMENT_STATUS.DELETED);
    expect(after?.version).toBe(1);
    // 软删后公开查询不再返回。
    expect(await listActiveAnnouncements(db, NOW)).toHaveLength(0);
  });
});

describe("listAdminAnnouncements tabs", () => {
  it("expired tab catches both status=3 and time-expired published rows", async () => {
    await seed({title: "status-expired", status: ANNOUNCEMENT_STATUS.EXPIRED});
    await seed({
      title: "time-expired",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validTo: NOW - 1000,
    });
    await seed({title: "active", status: ANNOUNCEMENT_STATUS.PUBLISHED});

    const expired = await listAdminAnnouncements(db, "expired", NOW);
    expect(expired.map((r) => r.title).sort()).toEqual([
      "status-expired",
      "time-expired",
    ]);
  });

  it("published tab only returns status=2 (including time-expired ones)", async () => {
    await seed({title: "still-pub", status: ANNOUNCEMENT_STATUS.PUBLISHED});
    await seed({
      title: "pub-but-expired",
      status: ANNOUNCEMENT_STATUS.PUBLISHED,
      validTo: NOW - 1000,
    });
    const published = await listAdminAnnouncements(db, "published", NOW);
    expect(published).toHaveLength(2);
  });

  it("all tab returns every row regardless of status", async () => {
    await seed({title: "a", status: ANNOUNCEMENT_STATUS.DRAFT});
    await seed({title: "b", status: ANNOUNCEMENT_STATUS.DELETED});
    const all = await listAdminAnnouncements(db, "all", NOW);
    expect(all).toHaveLength(2);
  });

  it("round-trips through getAnnouncement", async () => {
    const id = await seed({title: "round", body: "xyz"});
    const row = await getAnnouncement(db, id);
    expect(row?.title).toBe("round");
    expect(row?.body).toBe("xyz");
  });
});

describe("公告正文的换行规范化（提示窗口优化第 4 条）", () => {
  it("normalizes CRLF to LF so mobile does not render doubled line breaks", () => {
    // 后台 textarea 提交的是 CRLF；原样入库会让移动端 TextView 把一个换行
    // 渲染成两行（多出空行），运营看到的排版与用户看到的不一致。
    expect(normalizeMultilineText("第一行\r\n第二行")).toBe("第一行\n第二行");
    // 孤立的 CR（老 Mac 风格）也要归一。
    expect(normalizeMultilineText("第一行\r第二行")).toBe("第一行\n第二行");
    // 已经是 LF 的不能被动过。
    expect(normalizeMultilineText("第一行\n第二行")).toBe("第一行\n第二行");
    // 连续多个换行按原样保留（运营有意留空行）。
    expect(normalizeMultilineText("a\r\n\r\nb")).toBe("a\n\nb");
    // 空值安全。
    expect(normalizeMultilineText(null)).toBe("");
    expect(normalizeMultilineText(undefined)).toBe("");
    expect(normalizeMultilineText("")).toBe("");
  });

  it("stores the body with LF only", async () => {
    const created = await createAnnouncement(
      db,
      {title: "换行", body: "第一行\r\n第二行", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const row = await getAnnouncement(db, created.id);
    expect(row?.body).toBe("第一行\n第二行");
    expect(row?.body).not.toContain("\r");
  });

  it("does not bump version when an update only differs by CRLF", async () => {
    // 回归防护：库里已存 LF，textarea 再次提交 CRLF 时，若拿原始值比较会把
    // 「只有行尾差异」判定为「内容变了」→ version 每次 +1 → 客户端每次都重弹同一条公告。
    // 注意：create 用纯 LF、update 用真 CRLF，二者语义相同但字节不同，
    // 只有 normalize 真的生效，version 才保持 1（删掉 normalize 此测试会红）。
    const created = await createAnnouncement(
      db,
      {title: "标题", body: "第一行\n第二行", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    // 模拟 textarea 再次提交（CRLF），内容语义完全没变。
    const updated = await updateAnnouncement(db, created.id, {
      title: "标题",
      body: "第一行\r\n第二行",
    });
    expect(updated?.version).toBe(1);
  });

  it("still bumps version when the body genuinely changes", async () => {
    const created = await createAnnouncement(
      db,
      {title: "标题", body: "正文", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const updated = await updateAnnouncement(db, created.id, {
      title: "标题",
      body: "改过的正文",
    });
    expect(updated?.version).toBe(2);
    expect(updated?.body).toBe("改过的正文");
  });
});
