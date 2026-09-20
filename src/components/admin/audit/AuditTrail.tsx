import {useCallback, useState} from "react";

import {formatAdminDateTime24} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {FieldDiff, type FieldChange} from "@/components/admin/shared/FieldDiff";
import {ADMIN_URLS} from "@/shared/StringUtils";

export type {FieldChange};


export interface AuditTrailRow {
  action: string;
  actorId: string | null;
  /** Hidden from the listing. Never deleted — the replay chain needs it. */
  archived: boolean;
  actorType: string;
  createdAt: string;
  diffData: FieldChange[];
  id: string;
  isCheckpoint: boolean;
  reason: string | null;
  restorable: boolean;
  reviewStatus: string | null;
}

interface Props {
  /** Chapter id — needed to re-fetch after a restore. */
  itemId: string;
  /** Set when the server could not read the trail, so the page shows why. */
  initialError?: string | null;
  initialRows: AuditTrailRow[];
}

function formatTimestamp(value: string): string {
  // Falls back to the raw value: the server normalises two `created_at` shapes,
  // and whatever is left had better still be visible than blanked out.
  return formatAdminDateTime24(value) || value;
}

export default function AuditTrail({
  initialError = null,
  initialRows,
  itemId,
}: Props) {
  const {t} = useTranslation();
  const [rows, setRows] = useState<AuditTrailRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAuditItem(itemId), {
        headers: {accept: "application/json"},
      });
      const payload = await response.json().catch(() => null) as
        | {rows?: AuditTrailRow[]; error?: string}
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t("audit.loadFailed"));
      }
      setRows(Array.isArray(payload?.rows) ? payload.rows : []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : t("audit.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [itemId, t]);

  async function restore(rowId: string) {
    setBusyId(rowId);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAuditItem(itemId), {
        body: JSON.stringify({auditRowId: rowId}),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as
        | {error?: string; unchanged?: boolean}
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t("audit.restoreFailed"));
      }
      // Clicking restore twice on the same row is a no-op, and the server says
      // so rather than adding another empty trail entry.
      showToast(
        payload?.unchanged ? t("audit.restoreUnchanged") : t("audit.restored"),
        "success",
      );
      if (!payload?.unchanged) await load();
    } catch (restoreError) {
      showToast(
        restoreError instanceof Error
          ? restoreError.message
          : t("audit.restoreFailed"),
        "error",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function setArchived(rowId: string, archived: boolean) {
    setBusyId(rowId);
    try {
      const response = await fetch(ADMIN_URLS.ajaxAuditItem(itemId), {
        body: JSON.stringify({archiveRowId: rowId, archived}),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as
          | {error?: string}
          | null;
        throw new Error(payload?.error ?? t("audit.archiveFailed"));
      }
      // Update in place: the row is still on the server, only the listing
      // changes, so a full reload would just lose the reader's place.
      setRows((current) => current.map((row) =>
        row.id === rowId ? {...row, archived} : row,
      ));
      showToast(archived ? t("audit.archived") : t("audit.unarchived"), "success");
    } catch (archiveError) {
      showToast(
        archiveError instanceof Error
          ? archiveError.message
          : t("audit.archiveFailed"),
        "error",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }
  const archivedCount = rows.filter((row) => row.archived).length;
  const visibleRows = showArchived
    ? rows
    : rows.filter((row) => !row.archived);

  if (rows.length === 0) {
    return (
      <div className="rounded-[14px] border bg-card p-8 text-center text-sm text-muted-foreground">
        {t("audit.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("audit.intro")}</p>
        {loading ? <AdminCollectionLoading label={t("audit.loading")} /> : null}
      </div>

      {archivedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <label className="inline-flex items-center gap-1.5">
            <input
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              type="checkbox"
            />
            {t("audit.showArchived")}
          </label>
          <span>{archivedCount} {t("audit.archivedCount")}</span>
        </div>
      ) : null}

      <ol className="space-y-3">
        {visibleRows.map((row) => (
          <li
            className={`rounded-[14px] border bg-card p-4 shadow-xs ${
              row.archived ? "opacity-60" : ""
            }`}
            key={row.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
                {t(`audit.action.${row.action}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatTimestamp(row.createdAt)}
              </span>
              {row.isCheckpoint ? (
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {t("audit.checkpoint")}
                </span>
              ) : null}
              {row.archived ? (
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {t("audit.archivedBadge")}
                </span>
              ) : null}
              {row.actorId ? (
                <span className="text-xs text-muted-foreground">
                  {row.actorId}
                </span>
              ) : null}
              {row.reason ? (
                <span className="text-xs text-muted-foreground">
                  {row.reason}
                </span>
              ) : null}
            </div>

            <div className="mt-3 space-y-2">
              {row.diffData.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  {t("audit.noChanges")}
                </div>
              ) : (
                row.diffData.map((change, index) => (
                  <FieldDiff change={change} key={`${row.id}-${change.path}-${index}`} />
                ))
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <Button
                disabled={busyId === row.id || !row.restorable}
                onClick={() => void restore(row.id)}
                size="sm"
                title={row.restorable ? undefined : t("audit.restoreUnavailableHint")}
                type="button"
                variant="outline"
              >
                {t("audit.restore")}
              </Button>
              <Button
                disabled={busyId === row.id}
                onClick={() => void setArchived(row.id, !row.archived)}
                size="sm"
                title={t("audit.archiveHint")}
                type="button"
                variant="ghost"
              >
                {row.archived ? t("audit.unarchive") : t("audit.archive")}
              </Button>
              {row.restorable ? null : (
                <span className="text-xs text-muted-foreground">
                  {t("audit.restoreUnavailableHint")}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
