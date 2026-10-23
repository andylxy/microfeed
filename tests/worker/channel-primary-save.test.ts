import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {POST as feedPost} from "@/pages/[adminPath]/ajax/feed";

/**
 * 主频道保存链路（`/admin/ajax/feed` 的 channel 分支）。
 *
 * 本地库里 channels 表被书籍与系统容器（方剂/本草/名词）占用，没有任何
 * is_primary=1 的行，getContent 因此返回 _defaultChannel() 内存占位，
 * 编辑频道页拿到的载荷不带 id/status/is_primary。旧写路径把这三个
 * undefined 直接绑进 UPDATE，D1 抛出 D1_TYPE_ERROR，保存恒为 500。现在
 * putContent 会先确认主频道行（没有就按出厂数据建一行），载荷里没有的
 * 列也不再进 SET 子句。
 */

const ORIGIN = "https://feed.example.com";

/** An authenticated admin `locals`; defaults to a super admin (`*`). */
function adminLocals(permissions: string[] = ["*"]) {
  return {
    authUser: {id: "u_admin"},
    rbacBanned: false,
    rbacDeviceRevoked: false,
    rbacMustChangePassword: false,
    rbacPermissions: new Set(permissions),
  };
}

function feedRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/admin/ajax/feed/`, {
    body: JSON.stringify(body),
    headers: {"content-type": "application/json"},
    method: "POST",
  });
}

async function primaryChannelRow() {
  return env.FEED_DB.prepare(
    "SELECT id, status, is_primary, data FROM channels WHERE is_primary = 1 LIMIT 1",
  ).first<{id: string; status: number; is_primary: number; data: string}>();
}

async function insertPrimaryChannel(id: string, title: string) {
  await env.FEED_DB.prepare(
    "INSERT INTO channels (id, status, is_primary, data) VALUES (?, 1, 1, ?)",
  ).bind(id, JSON.stringify({title})).run();
}

beforeEach(async () => {
  await env.FEED_DB.prepare("DELETE FROM channels WHERE is_primary = 1").run();
});

describe("admin primary channel save", () => {
  it("creates the primary channel row on the first save when none exists", async () => {
    expect(await primaryChannelRow()).toBeNull();

    const response = await feedPost({
      locals: adminLocals(),
      request: feedRequest({
        channel: {
          title: "自愈建行的主频道",
          language: "zh-cn",
          description: "首次保存",
        },
      }),
    } as never);

    expect(response.status).toBe(200);
    const row = await primaryChannelRow();
    expect(row).not.toBeNull();
    expect(row!.status).toBe(1);
    const data = JSON.parse(row!.data) as Record<string, unknown>;
    expect(data.title).toBe("自愈建行的主频道");
    expect(data.language).toBe("zh-cn");
  });

  it("updates the existing primary channel row in place", async () => {
    await insertPrimaryChannel("chanPrimary1", "旧标题");

    const response = await feedPost({
      locals: adminLocals(),
      request: feedRequest({
        channel: {
          id: "chanPrimary1",
          status: 1,
          is_primary: 1,
          title: "新标题",
          language: "zh-cn",
        },
      }),
    } as never);

    expect(response.status).toBe(200);
    const row = await primaryChannelRow();
    expect(row!.id).toBe("chanPrimary1");
    const data = JSON.parse(row!.data) as Record<string, unknown>;
    expect(data.title).toBe("新标题");
  });

  it("keeps status and is_primary when the payload omits them", async () => {
    await insertPrimaryChannel("chanPrimary2", "旧标题");

    const response = await feedPost({
      locals: adminLocals(),
      request: feedRequest({channel: {id: "chanPrimary2", title: "只改标题"}}),
    } as never);

    expect(response.status).toBe(200);
    const row = await primaryChannelRow();
    expect(row!.id).toBe("chanPrimary2");
    expect(row!.status).toBe(1);
    expect(row!.is_primary).toBe(1);
    const data = JSON.parse(row!.data) as Record<string, unknown>;
    expect(data.title).toBe("只改标题");
  });
});
