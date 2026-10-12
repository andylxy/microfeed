/**
 * App 消息通知（Announcements）的数据访问层。
 *
 * <p>对应迁移 {@code 0086_ext_app_announcement}。本模块是公告功能的唯一数据入口，
 * 公开端点（02 工单）与管理后台（04 工单）都只通过这里读写，不直拼 SQL。</p>
 *
 * <p><b>状态</b>：{@code 1 draft / 2 published / 3 expired / 4 deleted}（软删，置 4 即可）。</p>
 *
 * <p><b>version</b>：客户端去重用的「内容指纹」。{@link updateAnnouncement} 仅在
 * <b>title/body 被改动</b>时自增；只改时间窗口或状态不增——否则只是改了生效期，
 * 不该让用户已关闭的公告因为「改了过期时间」又弹一次（DESIGN §5.2 / D2）。</p>
 *
 * <p><b>时间字段</b>：{@code validFrom}/{@code validTo} 是 unix 毫秒（UTC），可空；
 * 空端 = 无边界。客户端只比较大小，本层不涉时区（§5.6）。</p>
 */

// `D1Database` 是 @cloudflare/workers-types 提供的全局环境类型（与 login-log.ts 同款写法），
// 无需 import —— 显式 import 反而会因模块解析失败报 ts(2307)。

// 同一模块只导入一次、再原样转出：既给服务端调用方一个入口，又不重复定义 DTO。
// 形状的唯一定义在 `@/shared/AppAnnouncement`（React 组件也从那里导入）。
export {
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_SETTABLE_STATUSES,
  normalizeMultilineText,
  ANNOUNCEMENT_STATUS_LABEL_KEYS,
  announcementStatusLabelKey,
  isAnnouncementTab,
  isSettableStatus,
  validateAnnouncementDraft,
  validateWindow,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_FETCH_LIMIT,
  ANNOUNCEMENT_MAX_ROWS,
  ANNOUNCEMENT_PRIORITY_MAX,
  ANNOUNCEMENT_PRIORITY_MIN,
  ANNOUNCEMENT_TABS,
  ANNOUNCEMENT_TITLE_MAX,
} from "@/shared/AppAnnouncement";
export type {
  AnnouncementDraft,
  AnnouncementRow,
  AnnouncementStatus,
  AnnouncementTab,
  AnnouncementUpdate,
  AnnouncementValidation,
  PublicAnnouncement,
} from "@/shared/AppAnnouncement";

import type {
  AnnouncementDraft,
  AnnouncementRow,
  AnnouncementStatus,
  AnnouncementTab,
  AnnouncementUpdate,
  PublicAnnouncement,
} from "@/shared/AppAnnouncement";

import {
  ANNOUNCEMENT_FETCH_LIMIT,
  ANNOUNCEMENT_STATUS,
  normalizeMultilineText,
} from "@/shared/AppAnnouncement";

/**
 * 取「当前生效」的公告，供公开端点下发。
 *
 * <p>筛选条件：{@code status=2} 且落在 {@code [valid_from, valid_to]} 窗口内
 * （空端视为无边界）。按 {@code priority DESC, updated_at DESC} 排序后截断到
 * {@code limit}（默认 20，防超大 payload，DESIGN §6.4）。</p>
 *
 * <p>返回 {@link PublicAnnouncement}——**不含** status 与时间戳，与契约一致。</p>
 */
export async function listActiveAnnouncements(
  db: D1Database,
  now: number = Date.now(),
  limit: number = ANNOUNCEMENT_FETCH_LIMIT,
): Promise<PublicAnnouncement[]> {
  const result = await db
    .prepare(
      `SELECT id, title, body, priority, version,
              valid_from AS validFrom, valid_to AS validTo
         FROM ext_app_announcement
        WHERE status = ?
          AND (valid_from IS NULL OR valid_from <= ?)
          AND (valid_to   IS NULL OR valid_to   >= ?)
        ORDER BY priority DESC, updated_at DESC
        LIMIT ?`,
    )
    .bind(ANNOUNCEMENT_STATUS.PUBLISHED, now, now, limit)
    .all<PublicAnnouncement>();
  return result.results ?? [];
}

/**
 * 管理后台列表。按标签过滤：
 *
 * - `all`      全部（含已删除，供审计）
 * - `draft`    status=1
 * - `published`status=2
 * - `deleted`  status=4
 * - `expired`  status=3 **或** status=2 且 valid_to 已过（时间到期但仍 published，
 *             §5.4 明确要求单独分支，公开生效查询不涵盖这部分）
 *
 * 默认按 updated_at 倒序（最近改动在前）。
 */
export async function listAdminAnnouncements(
  db: D1Database,
  tab: AnnouncementTab,
  now: number = Date.now(),
): Promise<AnnouncementRow[]> {
  let where: string;
  switch (tab) {
    case "draft":
      where = "WHERE status = 1";
      break;
    case "published":
      where = "WHERE status = 2";
      break;
    case "deleted":
      where = "WHERE status = 4";
      break;
    case "expired":
      where = "WHERE status = 3 OR (status = 2 AND valid_to IS NOT NULL AND valid_to < ?)";
      break;
    case "all":
    default:
      where = "";
      break;
  }
  const sql =
    `SELECT id, title, body, status, priority,
            valid_from AS validFrom, valid_to AS validTo, version,
            created_at AS createdAt, updated_at AS updatedAt
       FROM ext_app_announcement
       ${where}
       ORDER BY updated_at DESC`;
  const stmt = where.includes("?")
    ? db.prepare(sql).bind(now)
    : db.prepare(sql);
  const result = await stmt.all<AnnouncementRow>();
  return result.results ?? [];
}

/** 按 id 取一条完整行；不存在返回 null。 */
export async function getAnnouncement(
  db: D1Database,
  id: number,
): Promise<AnnouncementRow | null> {
  const result = await db
    .prepare(
      `SELECT id, title, body, status, priority,
              valid_from AS validFrom, valid_to AS validTo, version,
              created_at AS createdAt, updated_at AS updatedAt
         FROM ext_app_announcement
        WHERE id = ?`,
    )
    .bind(id)
    .all<AnnouncementRow>();
  return result.results?.[0] ?? null;
}

/**
 * 新建一条公告。返回创建后的完整行。
 *
 * <p>`version` 起始为 1（迁移默认值）；`created_at`/`updated_at` 取 now。</p>
 */
export async function createAnnouncement(
  db: D1Database,
  draft: AnnouncementDraft,
  now: number = Date.now(),
): Promise<AnnouncementRow> {
  const status = draft.status ?? ANNOUNCEMENT_STATUS.DRAFT;
  const priority = draft.priority ?? 0;
  // 入库前统一换行：textarea 提交 CRLF，原样存会让移动端多出空行（详见 normalizeMultilineText）。
  const title = normalizeMultilineText(draft.title);
  const body = normalizeMultilineText(draft.body);
  const {validFrom, validTo} = normalizeWindow(draft.validFrom, draft.validTo);
  await db
    .prepare(
      `INSERT INTO ext_app_announcement
         (title, body, status, priority, valid_from, valid_to, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(title, body, status, priority, validFrom, validTo, now, now)
    .run();
  const row = await db
    .prepare("SELECT last_insert_rowid() AS id")
    .first<{id: number}>();
  if (!row) throw new Error("announcement insert failed to return an id");
  const created = await getAnnouncement(db, row.id);
  if (!created) throw new Error("announcement insert failed to read back");
  return created;
}

/**
 * 编辑一条公告。
 *
 * <p><b>version 规则</b>：仅当传入的 {@code title}/{@code body} 与当前值**不同**
 * 时 {@code version += 1}；只改时间窗口/状态不增（DESIGN §5.2）。</p>
 */
export async function updateAnnouncement(
  db: D1Database,
  id: number,
  update: AnnouncementUpdate,
  now: number = Date.now(),
): Promise<AnnouncementRow | null> {
  const current = await getAnnouncement(db, id);
  if (!current) return null;

  // 先规范化再比较：库里存 LF、客户端送 CRLF 时，若拿原始值比较会把「只有行尾差异」
  // 判定为内容变更 → version 每次 +1 → 客户端每次都重弹同一条公告。
  const title =
    update.title === undefined ? current.title : normalizeMultilineText(update.title);
  const body =
    update.body === undefined ? current.body : normalizeMultilineText(update.body);
  // 不写 `as AnnouncementStatus`：status 列在 D1 里是 INTEGER，读出来就是 number。
  // 断言只会把「可能是越界值」伪装成「已校验」，而 bind() 本就接受 number。
  const status: number = update.status ?? current.status;
  const priority = update.priority ?? current.priority;
  const {validFrom, validTo} = normalizeWindow(
    update.validFrom,
    update.validTo,
    current,
  );

  // 规范化后的值与库中值相同即视为「内容未变」，version 不动。
  const contentChanged = title !== current.title || body !== current.body;
  const nextVersion = contentChanged ? current.version + 1 : current.version;

  await db
    .prepare(
      `UPDATE ext_app_announcement
          SET title = ?, body = ?, status = ?, priority = ?,
              valid_from = ?, valid_to = ?, version = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(
      title,
      body,
      status,
      priority,
      validFrom,
      validTo,
      nextVersion,
      now,
      id,
    )
    .run();
  return getAnnouncement(db, id);
}

/**
 * 仅改状态（删除→4 / 过期→3 / 恢复发布→2）。不动 version（状态变化不算内容改动）。
 */
export async function setStatus(
  db: D1Database,
  id: number,
  status: AnnouncementStatus,
  now: number = Date.now(),
): Promise<AnnouncementRow | null> {
  await db
    .prepare(
      `UPDATE ext_app_announcement SET status = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(status, now, id)
    .run();
  return getAnnouncement(db, id);
}

/**
 * 把传入的生效窗口归一到可入库值。
 *
 * <p>调用方可能只传其中一个端点（另一个保持原值），所以 {@code current} 可选：
 * 缺省时未传的端点按 undefined 处理（→ null）。</p>
 */
function normalizeWindow(
  validFrom: number | null | undefined,
  validTo: number | null | undefined,
  current?: AnnouncementRow,
): {validFrom: number | null; validTo: number | null} {
  const resolve = (
    incoming: number | null | undefined,
    fallback: number | null,
  ): number | null => {
    if (incoming === undefined) return fallback;
    return incoming; // null 或具体毫秒都原样
  };
  return {
    validFrom: resolve(validFrom, current ? current.validFrom : null),
    validTo: resolve(validTo, current ? current.validTo : null),
  };
}
