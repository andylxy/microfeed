import {env} from "cloudflare:workers";
import {beforeEach, describe, expect, it} from "vitest";

import {GET as announcementsGet} from "@/pages/api/app/announcements";
import {
  ANNOUNCEMENT_STATUS,
  createAnnouncement,
  setStatus,
} from "@/server/app/announcement/store";
import {createLoginCredential} from "@/server/auth/login-credentials";
import {permissionId} from "@/server/rbac/seed";

/**
 * 端点 `GET /api/app/announcements` 的运行时契约（DESIGN §5.3）。
 *
 * 锁住三件客户端真正依赖的事：
 * - 空列表返回 `{announcements: []}` 而不是 404/空体 —— 客户端据此静默（INV-2）；
 * - 字段是驼峰 unix 毫秒，与 `/api/app/version` 同风格；
 * - **不写登录日志**（D4）：登录日志的写入点只有版本检查一处，若这里也写，
 *   「一次启动」会被计成两次登录。
 *
 * 2026-10-16：本端点**不再是匿名**，改为要求登录凭证 + 权限码 `app:announcement:read`
 * （与 `search-permission` / `mingci-permission` 同形）。夹具照
 * `tests/worker/app-search-permission.test.ts`：造账号 → 挂合成角色 → 授权限码 → 签凭证。
 */

const db = env.FEED_DB;
const URL_ = "https://app.example.com/api/app/announcements";
const NOW = Date.now();
const USER = "u_announcement";
const CODE = "app:announcement:read";

interface AnnouncementBody {
  announcements: Array<{
    id: number;
    title: string;
    body: string;
    priority: number;
    version: number;
    validFrom: number | null;
    validTo: number | null;
  }>;
}

async function seedUser(id: string): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO "auth_user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned) ' +
      "VALUES (?, ?, ?, 1, '2024-01-01', '2024-01-01', 'user', 0)",
  )
    .bind(id, id.toUpperCase(), `${id}@example.com`)
    .run();
}

async function grantCode(userId: string, code: string): Promise<void> {
  const roleId = `r_test_${userId}`;
  await db.prepare(
    "INSERT OR IGNORE INTO ext_roles (id, code, name) VALUES (?, ?, ?)",
  )
    .bind(roleId, roleId, roleId)
    .run();
  await db.prepare(
    "INSERT OR IGNORE INTO ext_user_roles (user_id, role_id) VALUES (?, ?)",
  )
    .bind(userId, roleId)
    .run();
  // 复用 seed 的 id 公式，不在本文件重写第三份 `p_${code.replace(...)}`。
  const permId = permissionId(code);
  await db.prepare(
    "INSERT OR IGNORE INTO ext_permissions (id, code, name) VALUES (?, ?, ?)",
  )
    .bind(permId, code, code)
    .run();
  await db.prepare(
    "INSERT OR IGNORE INTO ext_role_permissions (role_id, permission_id) VALUES (?, ?)",
  )
    .bind(roleId, permId)
    .run();
}

/** 默认凭证（持 `app:announcement:read`）；传 `null` 走匿名路径。 */
let bearer: string;

async function callGet(secret: string | null = bearer): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.authorization = `Bearer ${secret}`;
  return announcementsGet({request: new Request(URL_, {headers})} as never);
}

beforeEach(async () => {
  await db.prepare("DELETE FROM ext_app_announcement").run();
  await db.prepare("DELETE FROM ext_app_login_log").run();
  // `createLoginCredential` 有每用户数量上限，不清会撞 LoginCredentialLimitError
  // （照 tests/worker/app-search-permission.test.ts 的 beforeEach）。
  await db.prepare("DELETE FROM ext_login_credentials").run();
  await seedUser(USER);
  await grantCode(USER, CODE);
  bearer = (await createLoginCredential(db, {name: "api", userId: USER})).secret;
});

describe("GET /api/app/announcements", () => {
  it("returns an empty array when nothing is active", async () => {
    // INV-2：客户端只看这个数组决定弹不弹，所以空必须是 200 + `[]`，
    // 而不是 404 或空 body —— 后者会让客户端走进「解析失败」分支。
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({announcements: []});
  });

  it("returns an empty array when only drafts exist", async () => {
    await createAnnouncement(
      db,
      {title: "draft only", status: ANNOUNCEMENT_STATUS.DRAFT},
      NOW,
    );
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({announcements: []});
  });

  it("publishes an active announcement with camelCase fields", async () => {
    await createAnnouncement(
      db,
      {
        title: "服务器维护通知",
        body: "10月8日 02:00-04:00 停服",
        status: ANNOUNCEMENT_STATUS.PUBLISHED,
        priority: 10,
        validTo: NOW + 86_400_000,
      },
      NOW,
    );

    const response = await callGet();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as AnnouncementBody;
    expect(payload.announcements).toHaveLength(1);
    expect(payload.announcements[0]).toMatchObject({
      title: "服务器维护通知",
      body: "10月8日 02:00-04:00 停服",
      priority: 10,
      version: 1,
    });
    expect(typeof payload.announcements[0]?.id).toBe("number");
    expect(payload.announcements[0]?.validFrom).toBeNull();
    expect(payload.announcements[0]?.validTo).toBe(NOW + 86_400_000);
  });

  it("never leaks status or timestamps", async () => {
    await createAnnouncement(
      db,
      {title: "shape", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const payload = (await (await callGet()).json()) as AnnouncementBody;
    const row = payload.announcements[0]!;
    expect(Object.keys(row).sort()).toEqual([
      "body",
      "id",
      "priority",
      "title",
      "validFrom",
      "validTo",
      "version",
    ]);
  });

  it("is no-store so a cold start never reads a stale notice", async () => {
    const response = await callGet();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("stops serving an announcement once it is soft-deleted or expired", async () => {
    const keep = await createAnnouncement(
      db,
      {title: "keep", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const deleted = await createAnnouncement(
      db,
      {title: "deleted", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    const expired = await createAnnouncement(
      db,
      {title: "expired", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    await setStatus(db, deleted.id, ANNOUNCEMENT_STATUS.DELETED, NOW);
    await setStatus(db, expired.id, ANNOUNCEMENT_STATUS.EXPIRED, NOW);

    const payload = (await (await callGet()).json()) as AnnouncementBody;
    expect(payload.announcements.map((a) => a.id)).toEqual([keep.id]);
  });

  it("reports a read failure as 500 rather than an empty list", async () => {
    // 客户端对 500 与空列表都是静默，但运维必须能区分「服务端炸了」和「今天没公告」。
    // 临时改名表来制造 DB 错误，`finally` 保证复原。
    await db.prepare("ALTER TABLE ext_app_announcement RENAME TO ext_app_announcement_hidden")
      .run();
    try {
      const response = await callGet();
      expect(response.status).toBe(500);
    } finally {
      await db.prepare(
        "ALTER TABLE ext_app_announcement_hidden RENAME TO ext_app_announcement",
      ).run();
    }
  });
});

describe("login log write point (D4)", () => {
  it("does NOT record a login when the app pulls announcements", async () => {
    // 登录日志的写入点是 `/api/app/version`。若公告端点也写，一次启动会被
    // 计成两次登录，「登录次数 = 启动了几次」就断了。
    await createAnnouncement(
      db,
      {title: "any", status: ANNOUNCEMENT_STATUS.PUBLISHED},
      NOW,
    );
    await callGet();
    const rows = await db.prepare("SELECT * FROM ext_app_login_log").all();
    expect(rows.results ?? []).toHaveLength(0);
  });
});
