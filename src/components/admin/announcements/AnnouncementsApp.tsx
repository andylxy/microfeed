import {useCallback, useEffect, useMemo, useState} from "react";

import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import AdminInput from "@/components/admin/shared/AdminInput";
import AdminTextarea from "@/components/admin/shared/AdminTextarea";
import AdminDialog from "@/components/admin/shared/AdminDialog";
import {formatAdminTimestamp} from "@/client/admin-date-format";
import {Button} from "@/components/ui/button";
import {useTranslation} from "@/client/i18n";
import {
  ANNOUNCEMENT_MAX_ROWS,
  ANNOUNCEMENT_SETTABLE_STATUSES,
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_TABS,
  announcementStatusLabelKey,
  type AnnouncementRow,
  type AnnouncementStatus,
  type AnnouncementTab,
} from "@/shared/AppAnnouncement";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * 公告管理看板（`/admin/announcements/`，DESIGN §5.4/§5.6）。
 *
 * 后端主动下发给App 的运营/系统消息在这里做全生命周期管理：新增、编辑、
 * 删除（软删→4）、过期（→3）、恢复发布（→2）。
 *
 * 两条容易踩的语义都在这里显式处理：
 * - **「已过期」是筛选标签而非单一 status**：它 = `status=3`，**或**
 *   `status=2 且valid_to 已过`。后者在列表里仍显示「已发布」，但客户端已经
 *   收不到——不单独列出来，运营会以为公告还在线（DESIGN §5.4）。
 * - **时间输入按管理员本地时区选、提交前转 UTC 毫秒**；后端原样入库不再换算
 *   （DESIGN §5.6）。所以这里用 `datetime-local` 读写，不做跨时区猜测。
 *
 * `canManage` 决定是否显示写操作；真正的权限判定在 ajax 端点里
 * （`system:announcement:manage`），前端只是不给出注定 403 的按钮。
 */

interface AnnouncementsResponse {
  tab?: string;
  rows?: AnnouncementRow[];
  truncated?: boolean;
  error?: string;
}

interface SaveResponse {
  ok?: boolean;
  row?: AnnouncementRow;
  error?: string;
}

interface Props {
  canManage?: boolean;
  itemsPerPage?: number;
}

type LabelKey =
  | "announcements.tabAll"
  | "announcements.tabDraft"
  | "announcements.tabPublished"
  | "announcements.tabExpired"
  | "announcements.tabDeleted";

const TAB_LABELS: Record<AnnouncementTab, LabelKey> = {
  all: "announcements.tabAll",
  draft: "announcements.tabDraft",
  published: "announcements.tabPublished",
  expired: "announcements.tabExpired",
  deleted: "announcements.tabDeleted",
};

// 状态 → 标签、以及「可设置的状态」，都放在 `@/shared/AppAnnouncement`
// （ANNOUNCEMENT_STATUS_LABEL_KEYS / announcementStatusLabelKey /
// ANNOUNCEMENT_SETTABLE_STATUSES）。原先这里、save.ts、store.ts 各写一份，
// 三处迟早分叉——加一个状态要改三个地方，漏一个就白屏或校验失效。

/** 表单里的时间输入：unix ms ↔ `datetime-local` 的本地时刻字符串。 */
function msToLocalInput(ms: number | null): string {
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * `datetime-local` 的字符串 → unix 毫秒。
 *
 * 用 `new Date(local)` 而非 `Date.parse`：后者把无时区的字符串按 **UTC** 解析，
 * 管理员在东八区填「12:00」会存成 UTC 12:00（= 本地 20:00），窗口整体偏移 8 小时
 * ——这种错不会报错，只会让公告在该弹的时候不弹。
 */
function localInputToMs(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 表单状态：null id 表示「新建」。 */
interface FormState {
  id: number | null;
  title: string;
  body: string;
  status: AnnouncementStatus;
  priority: number;
  validFrom: string;
  validTo: string;
}

function emptyForm(): FormState {
  return {
    id: null,
    title: "",
    body: "",
    status: ANNOUNCEMENT_STATUS.DRAFT,
    priority: 0,
    validFrom: "",
    validTo: "",
  };
}

function formFromRow(row: AnnouncementRow): FormState {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as AnnouncementStatus,
    priority: row.priority,
    validFrom: msToLocalInput(row.validFrom),
    validTo: msToLocalInput(row.validTo),
  };
}

export default function AnnouncementsApp({canManage, itemsPerPage}: Props) {
  const {t} = useTranslation();
  const [tab, setTab] = useState<AnnouncementTab>("all");
  const [rows, setRows] = useState<AnnouncementRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${ADMIN_URLS.ajaxAnnouncements()}?tab=${encodeURIComponent(tab)}`,
      );
      const data = (await response.json().catch(() => ({}))) as AnnouncementsResponse;
      if (!response.ok) throw new Error(data.error ?? t("announcements.loadFailed"));
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTruncated(data.truncated === true);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("announcements.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [tab, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const {pageRows, safePage, totalPages} = paginate(rows, itemsPerPage, page);

  /** 时间窗口的展示：空端=不限，两端皆空时只显示一次「不限」。 */
  const windowLabel = useMemo(
    () => (row: AnnouncementRow) => {
      if (row.validFrom === null && row.validTo === null) return t("announcements.noWindow");
      const from = row.validFrom === null
        ? t("announcements.noWindow")
        : formatAdminTimestamp(row.validFrom);
      const to = row.validTo === null
        ? t("announcements.noWindow")
        : formatAdminTimestamp(row.validTo);
      return t("announcements.fromTo", {from, to});
    },
    [t],
  );

  const post = useCallback(
    async (payload: unknown): Promise<SaveResponse> => {
      const response = await fetch(ADMIN_URLS.ajaxAnnouncementsSave(), {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(payload),
      });
      return (await response.json().catch(() => ({}))) as SaveResponse;
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    try {
      const draft = {
        title: form.title,
        body: form.body,
        status: form.status,
        priority: Number.isFinite(form.priority) ? form.priority : 0,
        validFrom: localInputToMs(form.validFrom),
        validTo: localInputToMs(form.validTo),
      };
      const result = form.id === null
        ? await post({create: draft})
        : await post({update: {id: form.id, ...draft}});
      if (!result.ok) {
        setError(result.error ?? t("announcements.saveFailed"));
        return;
      }
      setForm(null);
      setNotice(t("announcements.saved"));
      await load();
    } finally {
      setSaving(false);
    }
  }, [form, load, post, t]);

  const changeStatus = useCallback(
    async (row: AnnouncementRow, status: AnnouncementStatus) => {
      if (status === ANNOUNCEMENT_STATUS.DELETED
        && !globalThis.confirm(t("announcements.confirmDelete"))) {
        return;
      }
      const result = await post({setStatus: {id: row.id, status}});
      if (!result.ok) {
        setError(result.error ?? t("announcements.saveFailed"));
        return;
      }
      setNotice(t("announcements.saved"));
      await load();
    },
    [load, post, t],
  );

  if (loading && rows.length === 0) {
    return <AdminCollectionLoading label={t("announcements.title")} />;
  }

  if (error && rows.length === 0) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-xl font-semibold">{t("announcements.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("announcements.intro")}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("announcements.columnStatus")}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            onChange={(event) => {
              setTab(event.target.value as AnnouncementTab);
              setPage(0);
            }}
            value={tab}
          >
            {ANNOUNCEMENT_TABS.map((value) => (
              <option key={value} value={value}>
                {t(TAB_LABELS[value])}
              </option>
            ))}
          </select>
          {canManage && (
            <Button
              onClick={() => {
                setError(null);
                setForm(emptyForm());
              }}
              size="sm"
              variant="outline"
            >
              {t("announcements.add")}
            </Button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length}
          {/* 端点按 ANNOUNCEMENT_MAX_ROWS 截断，撞上限时必须说明这是截断值，
              否则运营会把这个数字当成总数来读。 */}
          {truncated
            ? ` · ${t("announcements.truncated", {count: ANNOUNCEMENT_MAX_ROWS})}`
            : ""}
        </span>
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      {notice && !error && (
        <p className="text-sm text-muted-foreground">{notice}</p>
      )}

      {rows.length === 0 ? (
        <section className="rounded-[14px] border bg-card p-8 text-center shadow-xs">
          <p className="text-sm text-muted-foreground">{t("announcements.empty")}</p>
        </section>
      ) : (
        <section className="overflow-hidden rounded-[14px] border bg-card shadow-xs">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnTitle")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnStatus")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnPriority")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnWindow")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnVersion")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {t("announcements.columnUpdatedAt")}
                </th>
                {canManage && <th className="px-4 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y">
              {pageRows.map((row) => {
                const status = row.status as AnnouncementStatus;
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-2">
                      <span className="block">{row.title}</span>
                      {row.body && (
                        <span className="block text-xs text-muted-foreground">
                          {row.body.length > 80 ? `${row.body.slice(0, 80)}…` : row.body}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {t(announcementStatusLabelKey(status))}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{row.priority}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs">
                      {windowLabel(row)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{row.version}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs">
                      {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}
                    </td>
                    {canManage && (
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            onClick={() => {
                              setError(null);
                              setForm(formFromRow(row));
                            }}
                            size="xs"
                            variant="outline"
                          >
                            {t("announcements.edit")}
                          </Button>
                          {ANNOUNCEMENT_SETTABLE_STATUSES
                            .filter((value) => value !== status)
                            .map((value) => (
                              <Button
                                key={value}
                                onClick={() => void changeStatus(row, value)}
                                size="xs"
                                variant={
                                  value === ANNOUNCEMENT_STATUS.DELETED
                                    ? "destructive"
                                    : "ghost"
                                }
                              >
                                {t(
                                  value === ANNOUNCEMENT_STATUS.PUBLISHED
                                    ? "announcements.restore"
                                    : value === ANNOUNCEMENT_STATUS.EXPIRED
                                      ? "announcements.expire"
                                      : "announcements.delete",
                                )}
                              </Button>
                            ))}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <AdminPagination
        onChange={setPage}
        page={safePage}
        totalPages={totalPages}
      />

      {form && (
        // 用共享的 AdminDialog，而不是手写 fixed/z-50 外层：
        // AGENTS.md「前端组件」要求优先扩展共享组件，手写遮罩会漏掉焦点陷阱、
        // Esc 关闭与滚动锁定，且与全站其他对话框的交互不一致。
        <AdminDialog
          onOpenChange={(open) => {
            if (!open) setForm(null);
          }}
          open
          title={
            form.id === null
              ? t("announcements.newOne")
              : t("announcements.editOne")
          }
        >
          <div className="grid gap-3">
              <AdminInput
                label={t("announcements.fieldTitle")}
                onChange={(event: {target: {value: string}}) => {
                  setForm({...form, title: event.target.value});
                }}
                value={form.title}
              />
              <AdminTextarea
                label={t("announcements.fieldBody")}
                maxRows={12}
                minRows={4}
                onChange={(event: {target: {value: string}}) => {
                  setForm({...form, body: event.target.value});
                }}
                value={form.body}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-sm font-semibold text-foreground">
                    {t("announcements.fieldStatus")}
                  </span>
                  <select
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    onChange={(event) => {
                      setForm({
                        ...form,
                        status: Number(event.target.value) as AnnouncementStatus,
                      });
                    }}
                    value={form.status}
                  >
                    {/*
                      草稿只在**新建**时可选：已存在的公告若被改回草稿，等于把它从
                      客户端「撤下」却还留在列表里，语义上应走「删除」或「过期」。
                      但选项必须**始终**包含当前值——否则编辑一条草稿时 select 匹配不到
                      任何 option，浏览器显示空白（实测），保存后状态还会被悄悄改掉。
                    */}
                    {form.status === ANNOUNCEMENT_STATUS.DRAFT && (
                      <option value={ANNOUNCEMENT_STATUS.DRAFT}>
                        {t(announcementStatusLabelKey(ANNOUNCEMENT_STATUS.DRAFT))}
                      </option>
                    )}
                    {ANNOUNCEMENT_SETTABLE_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {t(announcementStatusLabelKey(value))}
                      </option>
                    ))}
                  </select>
                </label>
                <AdminInput
                  label={t("announcements.fieldPriority")}
                  onChange={(event: {target: {value: string}}) => {
                    setForm({...form, priority: Number(event.target.value)});
                  }}
                  type="number"
                  value={String(form.priority)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1">
                  <span className="text-sm font-semibold text-foreground">
                    {t("announcements.fieldValidFrom")}
                  </span>
                  <input
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    onChange={(event) => {
                      setForm({...form, validFrom: event.target.value});
                    }}
                    type="datetime-local"
                    value={form.validFrom}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-sm font-semibold text-foreground">
                    {t("announcements.fieldValidTo")}
                  </span>
                  <input
                    className="rounded-md border bg-background px-3 py-2 text-sm"
                    onChange={(event) => {
                      setForm({...form, validTo: event.target.value});
                    }}
                    type="datetime-local"
                    value={form.validTo}
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("announcements.hintUnbounded")}
                <br />
                {t("announcements.hintLocalTime")}
              </p>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button
                disabled={saving}
                onClick={() => setForm(null)}
                variant="outline"
              >
                {t("announcements.cancel")}
              </Button>
              <Button disabled={saving} onClick={() => void submit()}>
                {t("announcements.save")}
              </Button>
            </div>
        </AdminDialog>
      )}
    </div>
  );
}
