import {useCallback, useEffect, useMemo, useState} from "react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import AdminDatetimePicker from "@/components/admin/shared/AdminDatetimePicker";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {
  LOGIN_LOG_MAX_ROWS,
  type LoginLogRow,
  type LoginLogWindow,
} from "@/shared/AppLoginLog";
import {ADMIN_URLS} from "@/shared/StringUtils";
import {datetimeLocalStringToMs} from "@/shared/TimeUtils";

/** i18n 键名类型：写错键会在编译期报错，而不是等 `i18n:check` 才发现。 */
type QuickLabelKey =
  | "loginLogs.quickToday"
  | "loginLogs.quick7Days"
  | "loginLogs.quick30Days"
  | "loginLogs.quick90Days"
  | "loginLogs.quickHalfYear"
  | "loginLogs.quickYear";

/**
 * 快捷按钮：一键把起止控件填成「最近 N 个日历日」，填完仍可手改。
 *
 * 这六档刻意沿用旧版六个时间标签的口径（日/周/月/最近三个月/半年/年）：运维原本
 * 就是按这些区间排查的，换成日期控件不该顺手把他的习惯删掉——控件负责**任意**区间，
 * 按钮负责**常用**区间，两者是加法关系而不是替换关系。
 */
const QUICK_RANGES: {days: number; labelKey: QuickLabelKey}[] = [
  {days: 1, labelKey: "loginLogs.quickToday"},
  {days: 7, labelKey: "loginLogs.quick7Days"},
  {days: 30, labelKey: "loginLogs.quick30Days"},
  {days: 90, labelKey: "loginLogs.quick90Days"},
  {days: 182, labelKey: "loginLogs.quickHalfYear"},
  {days: 365, labelKey: "loginLogs.quickYear"},
];

/** 打开页面时的默认窗口，与第一个快捷按钮无关，单独写清楚。 */
const DEFAULT_WINDOW_DAYS = 30;

interface LoginLogsResponse {
  rows?: LoginLogRow[];
  error?: string;
}

interface Props {
  itemsPerPage?: number;
}

/** 本地时区某天的 00:00。日期按天推进，不受夏令时影响。 */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * 「最近 N 天」= `[N-1 天前的 00:00, 明天 00:00)`。
 *
 * 上界取**明天零点**是因为服务端区间是右开的：只用今天零点会漏掉今天整天。
 * 今天是 N 天里的最后一天，所以下界是 N-1 天前（含今天共 N 个日历日）。
 */
function lastDaysWindow(days: number, now: number = Date.now()): LoginLogWindow {
  return {
    fromMs: startOfDay(addDays(now, -(days - 1))),
    toMs: startOfDay(addDays(now, 1)),
  };
}

/**
 * Login log board (`/admin/login-logs/`, ADR-0002).
 *
 * Answers需求 3's「找出启动的 App」: one row per device per day, filtered by a
 * time window chosen with the same datetime control the item editor uses.
 * Deliberately separate from the device board — that one keeps a single
 * overwritten `last_seen_at` per device and therefore cannot show *when* a
 * device was active over a window.
 *
 * Read-only by design: the log is an audit trail, so this page has no write
 * verbs. The `system:login-log:read` guard is enough; `:manage` exists only to
 * mirror the governance permission pair.
 */
export default function LoginLogsApp({itemsPerPage}: Props) {
  const {t} = useTranslation();
  // `applied` 是真正拿去请求的窗口；`draft` 是控件里正在编辑的值。
  // 分成两份是因为 datetime-local 在输入过程中会不断给出不完整的值，
  // 若每次按键都重拉会把一次查询拆成一串请求。
  const [applied, setApplied] = useState<LoginLogWindow>(() =>
    lastDaysWindow(DEFAULT_WINDOW_DAYS),
  );
  const [draft, setDraft] = useState<LoginLogWindow>(applied);
  const [rows, setRows] = useState<LoginLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(
    async (window: LoginLogWindow) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (window.fromMs != null) params.set("from", String(window.fromMs));
        if (window.toMs != null) params.set("to", String(window.toMs));
        const suffix = params.toString();
        const response = await fetch(
          `${ADMIN_URLS.ajaxLoginLogs()}${suffix === "" ? "" : `?${suffix}`}`,
        );
        const data = (await response
          .json()
          .catch(() => ({}))) as LoginLogsResponse;
        if (!response.ok) {
          throw new Error(data.error ?? t("loginLogs.loadFailed"));
        }
        setRows(Array.isArray(data.rows) ? data.rows : []);
        setError(null);
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("loginLogs.loadFailed"),
        );
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(applied);
  }, [applied, load]);

  // Free-text filtering client-side: one request already returns the whole
  // window, so a keystroke must not hit the server.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.deviceId.toLowerCase().includes(needle) ||
        (row.userName ?? "").toLowerCase().includes(needle) ||
        (row.userId ?? "").toLowerCase().includes(needle) ||
        (row.userEmail ?? "").toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const {pageRows, safePage, totalPages} = paginate(visible, itemsPerPage, page);

  /**
   * 控件清空时 `datetime-local` 给的是空串，`Date.parse` 得到 NaN。
   * 这种情况保持原值不动——受控 input 会把显示拉回原值，比塞一个 NaN 进
   * 查询参数（服务端只能回 400）友好，也避免和 `value == null` 的显示语义打架。
   */
  const editBound = (side: "fromMs" | "toMs", rawValue: string) => {
    const parsed = datetimeLocalStringToMs(rawValue);
    if (!Number.isFinite(parsed)) return;
    setDraft((previous) => ({...previous, [side]: parsed}));
  };

  const applyQuickRange = (days: number) => {
    const next = lastDaysWindow(days);
    setDraft(next);
    setApplied(next);
    setPage(0);
  };

  const applyDraft = () => {
    setApplied({fromMs: draft.fromMs, toMs: draft.toMs});
    setPage(0);
  };

  if (loading && rows.length === 0) {
    return <AdminCollectionLoading label={t("loginLogs.title")} />;
  }

  if (error && rows.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load(applied)} />;
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t("loginLogs.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("loginLogs.intro")}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-[16rem_16rem_1fr]">
        <AdminDatetimePicker
          label={t("loginLogs.from")}
          onChange={(event: {target: {value: string}}) =>
            editBound("fromMs", event.target.value)
          }
          value={draft.fromMs}
        />
        <AdminDatetimePicker
          label={t("loginLogs.to")}
          onChange={(event: {target: {value: string}}) =>
            editBound("toMs", event.target.value)
          }
          value={draft.toMs}
        />
        <div className="flex flex-wrap items-end gap-2">
          {QUICK_RANGES.map((option) => (
            <Button
              key={option.days}
              onClick={() => applyQuickRange(option.days)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t(option.labelKey)}
            </Button>
          ))}
          <Button onClick={applyDraft} size="sm" type="button">
            {t("loginLogs.apply")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          className="w-full max-w-sm rounded-md border bg-background px-3 py-2 text-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder={t("loginLogs.searchPlaceholder")}
          type="search"
          value={query}
        />
        <span className="text-xs text-muted-foreground">
          {t("loginLogs.count", {count: visible.length})}
          {/* 端点有 MAX_LIMIT 截断：条数撞到上限时必须说明这是截断值，
              否则「一年」标签下会把这个数字当成总数来读。 */}
          {rows.length >= LOGIN_LOG_MAX_ROWS
            ? ` · ${t("loginLogs.truncated", {count: LOGIN_LOG_MAX_ROWS})}`
            : ""}
        </span>
      </div>

      {visible.length === 0 ? (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <p className="text-sm text-muted-foreground">{t("loginLogs.empty")}</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">
                  {t("loginLogs.user")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("loginLogs.deviceId")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("loginLogs.lastLogin")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("loginLogs.loginCount")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.map((row) => (
                <tr key={`${row.deviceId}:${row.logDate}`}>
                  <td className="px-4 py-2">
                    {/* 与设备看板同一个办法：`username ?? userId`，账号名可以为空，
                        账号 id 不会。早先把「没有用户名」当成「没有账号」，于是整列
                        落成「未登录」——真实库里多数账号恰恰只有邮箱。
                        副行补邮箱，让只知道邮箱的运维也能认出来。 */}
                    <div className="flex flex-col">
                      <span>
                        {row.userName ??
                          row.userId ??
                          t("loginLogs.anonymous")}
                      </span>
                      {row.userEmail && (
                        <span className="text-xs text-muted-foreground">
                          {row.userEmail}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {row.deviceId}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {new Date(row.loginAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 tabular-nums">
                    {row.loginCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <AdminPagination
        onChange={setPage}
        page={safePage}
        totalPages={totalPages}
      />
    </div>
  );
}
