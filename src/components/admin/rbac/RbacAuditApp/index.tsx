import {useMemo, useState} from "react";

import {formatAdminDateTime} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import AdminPagination, {
  paginate,
} from "@/components/admin/shared/AdminPagination";
import {Input} from "@/components/ui/input";
import {RBAC_AUDIT_ACTIONS, type RbacAuditRow} from "@/shared/RbacAudit";

interface Props {
  rows: RbacAuditRow[];
  /** Permission code -> 中文名, so grant diffs render names instead of codes. */
  permissionNames: Record<string, string>;
  /** Role code -> 名称, for role diffs, role targets, and account role lists. */
  roleNames: Record<string, string>;
  /** Page size from Settings → Items (`webGlobalSettings.itemsPerPage`). */
  itemsPerPage?: number;
}

/** Actions the board can label; anything else falls back to the raw code. */
const KNOWN_ACTIONS = new Set<string>(RBAC_AUDIT_ACTIONS);

/** `user.profile` records only which columns moved, so translate the column. */
const PROFILE_FIELD_KEYS: Record<string, string> = {
  displayUsername: "rbacAudit.field.displayUsername",
  email: "rbacAudit.field.email",
  name: "rbacAudit.field.name",
  username: "rbacAudit.field.username",
};

/**
 * A row's detail, resolved to what actually changed.
 *
 * The trail stores comma-joined CODES, and both the before and after list. The
 * board must not print either list wholesale — most of it is unchanged, and a
 * wall of codes is unreadable. So this reduces each row to the set difference
 * (added / removed) rendered with 中文名, which is the only part a reader cares
 * about.
 */
type DetailModel =
  | {kind: "diff"; added: string[]; removed: string[]}
  | {kind: "text"; text: string}
  | {kind: "names"; names: string[]}
  | {kind: "empty"};

function splitCodes(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

function namesOf(codes: string[], names: Record<string, string>): string[] {
  return codes.map((code) => names[code] ?? code);
}

/**
 * Set difference of two comma-joined code lists, resolved to display names.
 *
 * Shared by `role.permissions` (permission codes) and `user.roles` (role
 * codes): the two differ only in which catalogue the names come from.
 */
function diffCodes(
  before: string | null,
  after: string | null,
  names: Record<string, string>,
): {added: string[]; removed: string[]} {
  const beforeSet = new Set(splitCodes(before));
  const afterSet = new Set(splitCodes(after));
  return {
    added: namesOf([...afterSet].filter((code) => !beforeSet.has(code)).sort(), names),
    removed: namesOf([...beforeSet].filter((code) => !afterSet.has(code)).sort(), names),
  };
}

function buildDetail(
  row: RbacAuditRow,
  permissionNames: Record<string, string>,
  roleNames: Record<string, string>,
  t: (key: string) => string,
): DetailModel {
  switch (row.action) {
    case "role.permissions":
      return {
        ...diffCodes(row.beforeDetail, row.detail, permissionNames),
        kind: "diff",
      };
    case "user.roles":
      return {
        ...diffCodes(row.beforeDetail, row.detail, roleNames),
        kind: "diff",
      };
    case "role.create":
    case "role.rename":
      return row.detail ? {kind: "text", text: row.detail} : {kind: "empty"};
    case "role.renameCode":
      return row.detail
        ? {kind: "text", text: `${row.target} → ${row.detail}`}
        : {kind: "empty"};
    case "user.create":
      return row.detail
        ? {kind: "names", names: namesOf(splitCodes(row.detail), roleNames)}
        : {kind: "empty"};
    case "user.profile":
      return row.detail
        ? {
            kind: "names",
            names: splitCodes(row.detail).map((field) =>
              PROFILE_FIELD_KEYS[field] ? t(PROFILE_FIELD_KEYS[field]) : field,
            ),
          }
        : {kind: "empty"};
    default:
      return row.detail ? {kind: "text", text: row.detail} : {kind: "empty"};
  }
}

/** Plain-text form of a detail, for the filter box. */
function detailSearchText(detail: DetailModel): string {
  switch (detail.kind) {
    case "diff":
      return [...detail.added, ...detail.removed].join(" ");
    case "text":
      return detail.text;
    case "names":
      return detail.names.join(" ");
    default:
      return "";
  }
}

function DetailCell({detail}: {detail: DetailModel}) {
  const {t} = useTranslation();
  if (detail.kind === "diff") {
    if (detail.added.length === 0 && detail.removed.length === 0) {
      return <span className="text-xs text-muted-foreground">{t("rbacAudit.noChange")}</span>;
    }
    return (
      <span className="flex flex-wrap gap-1.5">
        {detail.added.map((name) => (
          <span
            className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
            key={`add-${name}`}
          >
            ＋{name}
          </span>
        ))}
        {detail.removed.map((name) => (
          <span
            className="rounded bg-red-500/12 px-1.5 py-0.5 text-xs text-red-700 line-through dark:text-red-300"
            key={`del-${name}`}
          >
            －{name}
          </span>
        ))}
      </span>
    );
  }
  if (detail.kind === "text") return <span>{detail.text}</span>;
  if (detail.kind === "names") return <span>{detail.names.join("、")}</span>;
  return <span className="text-muted-foreground">—</span>;
}

/**
 * RBAC audit board (`/admin/rbac/audit/`, C3).
 *
 * The trail records role and grant mutations; this is its read side. It used to
 * be a server-rendered Astro table that printed the raw `before → after` code
 * lists; a client island is needed now because the reader wants to *filter* the
 * rows and because the detail column has to diff the lists and resolve codes to
 * names (both cheap, both only make sense on the client).
 *
 * Read-only by design — the log is an audit trail, so there are no write verbs.
 * Pagination is client-side over the already-≤100-row window, sized from
 * Settings → Items like every other admin list board.
 */
export default function RbacAuditApp({
  rows,
  permissionNames,
  roleNames,
  itemsPerPage,
}: Props) {
  const {t} = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  const decorated = useMemo(
    () =>
      rows.map((row) => ({
        actionLabel: KNOWN_ACTIONS.has(row.action)
          ? t(`rbacAudit.actionLabel.${row.action}`)
          : row.action,
        detail: buildDetail(row, permissionNames, roleNames, t),
        row,
        targetLabel: row.action.startsWith("role.")
          ? roleNames[row.target] ?? row.target
          : row.target,
      })),
    [rows, permissionNames, roleNames, t],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return decorated;
    return decorated.filter(({actionLabel, detail, row, targetLabel}) =>
      [
        row.actorLabel ?? "",
        actionLabel,
        targetLabel,
        row.action,
        detailSearchText(detail),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [decorated, query]);

  const {pageRows, safePage, totalPages} = paginate(visible, itemsPerPage, page);

  if (rows.length === 0) {
    return (
      <section className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
        <p className="text-sm text-muted-foreground">{t("rbacAudit.empty")}</p>
      </section>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          className="max-w-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder={t("rbacAudit.filterPlaceholder")}
          type="search"
          value={query}
        />
        <span className="text-xs text-muted-foreground">
          {t("rbacAudit.count", {count: visible.length})}
        </span>
      </div>

      <section className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("rbacAudit.noMatch")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">{t("rbacAudit.time")}</th>
                  <th className="py-2 pr-4">{t("rbacAudit.actor")}</th>
                  <th className="py-2 pr-4">{t("rbacAudit.action")}</th>
                  <th className="py-2 pr-4">{t("rbacAudit.target")}</th>
                  <th className="py-2">{t("rbacAudit.detail")}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map(({actionLabel, detail, row, targetLabel}) => (
                  <tr className="border-b align-top last:border-0" key={row.id}>
                    <td className="py-2 pr-4 whitespace-nowrap tabular-nums">
                      {formatAdminDateTime(row.createdAtMs)}
                    </td>
                    <td className="py-2 pr-4">{row.actorLabel ?? "—"}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{actionLabel}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{targetLabel || "—"}</td>
                    <td className="py-2">
                      <DetailCell detail={detail} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AdminPagination onChange={setPage} page={safePage} totalPages={totalPages} />
    </div>
  );
}
