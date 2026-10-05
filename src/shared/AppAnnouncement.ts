/**
 * 公告（Announcements）的跨端 DTO、状态定义与纯校验。
 *
 * 这些形状跨越服务端/客户端边界——`ajax/announcements` 负责序列化，
 * `AnnouncementsApp` 负责反序列化——所以统一放在 `src/shared/`
 * （两端都可导入的运行时中立层），而不是各写一份然后各自漂移
 * （AGENTS.md「源码架构」：React 客户端组件绝不能从 `src/server/` 导入）。
 *
 * 运行时中立是刻意的：不依赖 D1、不依赖 `cloudflare:workers`、不碰 DOM。
 * 对应数据表见 `migrations/0086_ext_app_announcement.sql`，服务端读写在
 * `src/server/app-announcement/store.ts`。
 */

/** 公告状态。与迁移 0086 的 `status` 列一一对应。 */
export const ANNOUNCEMENT_STATUS = {
  DRAFT: 1,
  PUBLISHED: 2,
  EXPIRED: 3,
  DELETED: 4,
} as const;

export type AnnouncementStatus =
  (typeof ANNOUNCEMENT_STATUS)[keyof typeof ANNOUNCEMENT_STATUS];

/** 管理后台列表的筛选标签（DESIGN §5.4）。 */
export type AnnouncementTab = "all" | "draft" | "published" | "expired" | "deleted";

export const ANNOUNCEMENT_TABS: readonly AnnouncementTab[] = [
  "all",
  "draft",
  "published",
  "expired",
  "deleted",
];

export function isAnnouncementTab(value: string): value is AnnouncementTab {
  return Object.prototype.hasOwnProperty.call(
    Object.fromEntries(ANNOUNCEMENT_TABS.map((tab) => [tab, true])),
    value,
  );
}

/**
 * 「状态动作」可用的目标：已发布 / 已过期 / 已删除。
 *
 * <p>刻意**不含** draft（1）：草稿是新建时的初值，不是把线上公告改回去的动作。
 * 后台表单、AJAX 校验与列表动作三处都从这里取，避免各写一份而分叉。</p>
 */
export const ANNOUNCEMENT_SETTABLE_STATUSES: readonly AnnouncementStatus[] = [
  ANNOUNCEMENT_STATUS.PUBLISHED,
  ANNOUNCEMENT_STATUS.EXPIRED,
  ANNOUNCEMENT_STATUS.DELETED,
];

export function isSettableStatus(value: unknown): value is AnnouncementStatus {
  return (
    typeof value === "number" &&
    (ANNOUNCEMENT_SETTABLE_STATUSES as readonly number[]).includes(value)
  );
}

/** 状态 → 后台列表用的 i18n 键。集中一处，免得三处各写一份映射。 */
export const ANNOUNCEMENT_STATUS_LABEL_KEYS = {
  [ANNOUNCEMENT_STATUS.DRAFT]: "announcements.statusDraft",
  [ANNOUNCEMENT_STATUS.PUBLISHED]: "announcements.statusPublished",
  [ANNOUNCEMENT_STATUS.EXPIRED]: "announcements.statusExpired",
  [ANNOUNCEMENT_STATUS.DELETED]: "announcements.statusDeleted",
} as const satisfies Record<AnnouncementStatus, string>;

export function announcementStatusLabelKey(
  status: number,
): (typeof ANNOUNCEMENT_STATUS_LABEL_KEYS)[AnnouncementStatus] {
  return ANNOUNCEMENT_STATUS_LABEL_KEYS[status as AnnouncementStatus] ??
    ANNOUNCEMENT_STATUS_LABEL_KEYS[ANNOUNCEMENT_STATUS.DRAFT];
}

/** 公开端点下发给客户端的形态：不含 status/时间戳。 */
export interface PublicAnnouncement {
  id: number;
  title: string;
  body: string;
  priority: number;
  version: number;
  validFrom: number | null;
  validTo: number | null;
}

/** 管理后台看到的完整行，含 status 与时间戳。 */
export interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  /**
   * 存的是 {@link AnnouncementStatus}，但 D1 列是 INTEGER。
   *
   * <p>刻意**不用** {@code AnnouncementStatus} 联合类型：D1 会把列读成 {@code number}，
   * 标成联合类型就得到一个「声称是联合类型、实际可能越界」的属性（编译器无法校验），
   * 于是每个读它的调用方都要写一次 {@code as AnnouncementStatus} 断言。用
   * {@code number} + {@link isSettableStatus} 这类真守卫，非法值在**校验点**被拒，
   * 而不是靠调用方的断言无声吞掉。</p>
   */
  status: number;
  priority: number;
  validFrom: number | null;
  validTo: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 新建公告的输入。title 必填，其余可选（缺省取迁移里的默认值）。 */
export interface AnnouncementDraft {
  title: string;
  body?: string;
  status?: AnnouncementStatus;
  priority?: number;
  validFrom?: number | null;
  validTo?: number | null;
}

/** 编辑公告的输入，全部可选；缺省字段保持原值。 */
export type AnnouncementUpdate = Partial<AnnouncementDraft>;

/** 标题长度上限。弹窗标题按一行排版，过长会被截断成无意义的一行。 */
export const ANNOUNCEMENT_TITLE_MAX = 200;

/** 正文长度上限。停服通知最多也就几百字，1 万字足够且能挡住误粘整篇日志。 */
export const ANNOUNCEMENT_BODY_MAX = 10_000;

/** 优先级范围。越大越先弹；限制区间避免手滑写个 10^9 之后没法排序。 */
export const ANNOUNCEMENT_PRIORITY_MIN = -1000;
export const ANNOUNCEMENT_PRIORITY_MAX = 1000;

/** 管理后台列表单页上限。公告是运营位而非流水账，量级很小。 */
export const ANNOUNCEMENT_MAX_ROWS = 200;

/**
 * 公开端点单次最多下发多少条生效公告。
 *
 * <p>防超大 payload（DESIGN §6.4）。客户端另有 {@code K=3} 的展示上限，
 * 两者是不同的一层限制，**都要保留**：后端这条防传输量，客户端那条防打扰次数。
 * 服务端默认值与端点显式上限都从这里取，避免两处各写一个 20 而悄悄分叉。</p>
 */
export const ANNOUNCEMENT_FETCH_LIMIT = 20;

/** 校验结果。`ok: false` 时 `reason` 是稳定的机器可读原因，供 i18n 键使用。 */
export type AnnouncementValidation =
  | {ok: true}
  | {ok: false; reason: "invalidTitle" | "titleTooLong" | "bodyTooLong" | "invalidPriority" | "invalidWindow" | "invalidStatus"};

/**
 * 校验一个「完整的」公告草稿（新建与整存时用）。
 *
 * 纯函数、无IO，便于端点与单测共用同一份口径。
 */
export function validateAnnouncementDraft(
  draft: AnnouncementDraft,
): AnnouncementValidation {
  const title = draft.title?.trim() ?? "";
  if (!title) return {ok: false, reason: "invalidTitle"};
  if (title.length > ANNOUNCEMENT_TITLE_MAX) {
    return {ok: false, reason: "titleTooLong"};
  }
  if ((draft.body ?? "").length > ANNOUNCEMENT_BODY_MAX) {
    return {ok: false, reason: "bodyTooLong"};
  }
  if (draft.priority !== undefined && !isValidPriority(draft.priority)) {
    return {ok: false, reason: "invalidPriority"};
  }
  if (draft.status !== undefined && !isValidStatus(draft.status)) {
    return {ok: false, reason: "invalidStatus"};
  }
  return validateWindow(draft.validFrom, draft.validTo);
}

/** 校验生效窗口。两端都可空；非空时必须是有限整数，且 from <= to。 */
export function validateWindow(
  validFrom: number | null | undefined,
  validTo: number | null | undefined,
): AnnouncementValidation {
  if (validFrom !== undefined && validFrom !== null && !Number.isInteger(validFrom)) {
    return {ok: false, reason: "invalidWindow"};
  }
  if (validTo !== undefined && validTo !== null && !Number.isInteger(validTo)) {
    return {ok: false, reason: "invalidWindow"};
  }
  if (
    typeof validFrom === "number" &&
    typeof validTo === "number" &&
    validFrom > validTo
  ) {
    // from 晚于 to = 永远不生效的窗口，安静存下来只会让运营困惑（列表里看不出问题，
    // 但客户端永远收不到）。直接拒收并报错。
    return {ok: false, reason: "invalidWindow"};
  }
  return {ok: true};
}

function isValidPriority(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= ANNOUNCEMENT_PRIORITY_MIN &&
    value <= ANNOUNCEMENT_PRIORITY_MAX
  );
}

/**
 * 状态合法性：按**值**（1/2/3/4）判定，不是按键名。
 *
 * ⚠️ 这里踩过一个坑：`ANNOUNCEMENT_STATUS` 的键是 `DRAFT/PUBLISHED/…`，
 * 所以 `hasOwnProperty(ANNOUNCEMENT_STATUS, "2")` 恒为 false——用键去查数值
 * 会让**每一个**合法状态都被判为非法，新建公告一律 400。必须查值。
 */
function isValidStatus(value: unknown): value is AnnouncementStatus {
  return (
    typeof value === "number" &&
    (Object.values(ANNOUNCEMENT_STATUS) as number[]).includes(value)
  );
}
