import {useCallback, useEffect, useMemo, useState} from "react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import {useTranslation} from "@/client/i18n";
import {
  LOGIN_LOG_MAX_ROWS,
  type LoginLogRange,
  type LoginLogRow,
} from "@/shared/AppLoginLog";
import {ADMIN_URLS} from "@/shared/StringUtils";

/** i18n 键名类型：写错键会在编译期报错，而不是等 `i18n:check` 才发现。 */
type RangeLabelKey =
  | "loginLogs.rangeDay"
  | "loginLogs.rangeWeek"
  | "loginLogs.rangeMonth"
  | "loginLogs.rangeQuarter"
  | "loginLogs.rangeHalfYear"
  | "loginLogs.rangeYear";

/** 标签值与 `LOGIN_LOG_RANGES` 的键一一对应（ADR-0002 的六个时间标签）。 */
const RANGE_OPTIONS: {value: LoginLogRange; labelKey: RangeLabelKey}[] = [
  {value: "day", labelKey: "loginLogs.rangeDay"},
  {value: "week", labelKey: "loginLogs.rangeWeek"},
  {value: "month", labelKey: "loginLogs.rangeMonth"},
  {value: "quarter", labelKey: "loginLogs.rangeQuarter"},
  {value: "halfYear", labelKey: "loginLogs.rangeHalfYear"},
  {value: "year", labelKey: "loginLogs.rangeYear"},
];

interface LoginLogsResponse {
  range?: string;
  rows?: LoginLogRow[];
  error?: string;
}

interface Props {
  itemsPerPage?: number;
}

/**
 * Login log board (`/admin/login-logs/`, ADR-0002).
 *
 * Answers需求 3's「找出启动的 App」: one row per device per day, filtered by a
 * rolling time window. Deliberately separate from the device board — that one
 * keeps a single overwritten `last_seen_at` per device and therefore cannot
 * show *when* a device was active over a window.
 *
 * Read-only by design: the log is an audit trail, so this page has no write
 * verbs. The `system:login-log:read` guard is enough; `:manage` exists only to
 * mirror the governance permission pair.
 */
export default function LoginLogsApp({itemsPerPage}: Props) {
  const {t} = useTranslation();
  const [range, setRange] = useState<LoginLogRange>("day");
  const [rows, setRows] = useState<LoginLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${ADMIN_URLS.ajaxLoginLogs()}?range=${encodeURIComponent(range)}`,
      );
      const data = (await response.json().catch(() => ({}))) as LoginLogsResponse;
      if (!response.ok) throw new Error(data.error ?? t("loginLogs.loadFailed"));
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("loginLogs.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [range, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Free-text filtering client-side: one request already returns the whole
  // window, so a keystroke must not hit the server.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.deviceId.toLowerCase().includes(needle) ||
        (row.userName ?? "").toLowerCase().includes(needle) ||
        (row.userEmail ?? "").toLowerCase().includes(needle),
    );
  }, [rows, query]);

  const {pageRows, safePage, totalPages} = paginate(visible, itemsPerPage, page);

  if (loading && rows.length === 0) {
    return <AdminCollectionLoading label={t("loginLogs.title")} />;
  }

  if (error && rows.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t("loginLogs.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("loginLogs.intro")}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
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
          <select
            aria-label={t("loginLogs.range")}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            onChange={(event) => {
              setRange(event.target.value as LoginLogRange);
              setPage(0);
            }}
            value={range}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </div>
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
                    {row.userName ? (
                      <>
                        <span>{row.userName}</span>
                        {row.userEmail && (
                          <span className="block text-xs text-muted-foreground">
                            {row.userEmail}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("loginLogs.notLoggedIn")}
                      </span>
                    )}
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
