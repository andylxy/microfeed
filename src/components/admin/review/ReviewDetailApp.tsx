import {useCallback, useEffect, useState} from "react";

import i18n from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * Audit detail for one chapter: every recorded action, the field-level diff it
 * produced, and a button to put the chapter back to that version.
 *
 * The diff model is the one the audit engine stores, so the rendering here is
 * the only place that decides how a change reads.
 */

interface FieldChange {
  op: "add" | "update" | "remove";
  path: string;
  before?: unknown;
  after?: unknown;
}

interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  diffData: FieldChange[];
  isCheckpoint: boolean;
  reviewStatus: string | null;
  reason: string | null;
  createdAt: string;
}

function renderValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function ReviewDetailApp({itemId}: {itemId: string}) {
  const t = i18n.t.bind(i18n);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(ADMIN_URLS.ajaxReviewItem(itemId), {
        headers: {"cache-control": "no-store"},
      });
      const payload = await response.json().catch(() => null) as {rows?: AuditRow[]} | null;
      if (!response.ok) throw new Error(String(response.status));
      setRows(payload?.rows ?? []);
    } catch {
      showToast(t("review.loadFailed"), "error");
    } finally {
      setLoading(false);
    }
  }, [itemId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(rowId: string) {
    setBusyId(rowId);
    try {
      const response = await fetch(ADMIN_URLS.ajaxReviewItem(itemId), {
        body: JSON.stringify({auditRowId: rowId}),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      if (!response.ok) throw new Error(String(response.status));
      showToast(t("review.restored"), "success");
      await load();
    } catch {
      showToast(t("review.restoreFailed"), "error");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t("review.loading")}</div>;
  }

  return (<div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
    <h2 className="text-lg font-semibold">{t("review.auditTrail")}</h2>
    {rows.length === 0
      ? <p className="mt-2 text-sm text-muted-foreground">{t("review.noAuditRows")}</p>
      : <ol className="mt-4 flex flex-col gap-4">
        {rows.map((row) => (<li className="rounded-lg border p-3" key={row.id}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t(`review.action.${row.action}`)}</span>
            <span className="text-xs text-muted-foreground">
              {row.actorType}{row.actorId ? ` · ${row.actorId}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">{row.createdAt}</span>
            {row.isCheckpoint && <span className="rounded-full border px-2 text-xs">
              {t("review.checkpoint")}
            </span>}
          </div>

          {row.reason && <p className="mt-2 text-sm">{t("review.reasonLabel")}{row.reason}</p>}

          {row.diffData.length > 0 && <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
            {row.diffData.map((change, index) => (<li key={`${row.id}-${index}`}>
              <span className={
                change.op === "add"
                  ? "text-emerald-600"
                  : change.op === "remove"
                    ? "text-destructive"
                    : "text-amber-600"
              }>
                {change.op === "add" ? "+" : change.op === "remove" ? "-" : "~"}
              </span>{" "}
              <span className="font-semibold">{change.path}</span>
              {change.op !== "add" && <span className="text-destructive">
                {" "}{renderValue(change.before)}
              </span>}
              {change.op !== "remove" && <span className="text-emerald-600">
                {" "}{renderValue(change.after)}
              </span>}
            </li>))}
          </ul>}

          <div className="mt-3">
            <Button
              disabled={busyId === row.id}
              onClick={() => restore(row.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("review.restoreThis")}
            </Button>
          </div>
        </li>))}
      </ol>}
  </div>);
}
