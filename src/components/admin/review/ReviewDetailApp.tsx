import {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * Audit detail for one chapter: every recorded action, the field-level diff it
 * produced, and a button to put the chapter back to that version.
 *
 * Above that sits the content-correction panel: review the rendered body,
 * propose a fix, and confirm (同意) it to write back to the chapter.
 *
 * `t` comes from `useTranslation`, NOT `i18n.t.bind(i18n)`: bind() returns a new
 * function every render, so every `useCallback([t])` changed identity and the
 * load effect re-ran after each render — which re-fetched and reset the draft
 * fields, wiping whatever was being typed.
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
  /** False when no checkpoint covers this row, so a restore would fail. */
  restorable: boolean;
}

interface Correction {
  id: string;
  itemId: string;
  status: "pending" | "approved" | "rejected";
  changes: FieldChange[];
  submittedBy: string | null;
  submittedAt: number | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reason: string | null;
}

/**
 * Who is acting. The dashboard has no per-user identity in v1 (single admin,
 * see §7.7), so this is the label recorded on the trail.
 */
const ACTOR = "admin";

function renderValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function ReviewDetailApp({itemId}: {itemId: string}) {
  const {t} = useTranslation();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [contentField, setContentField] = useState<string>("description");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftReason, setDraftReason] = useState("");
  const [busyCorrection, setBusyCorrection] = useState<string | null>(null);

  const loadCorrections = useCallback(async () => {
    try {
      const response = await fetch(
        `${ADMIN_URLS.ajaxReviewCorrections()}?itemId=${encodeURIComponent(itemId)}`,
        {headers: {"cache-control": "no-store"}},
      );
      const payload = await response.json().catch(() => null) as {
        corrections?: Correction[];
        currentData?: Record<string, unknown> | null;
      } | null;
      if (!response.ok) throw new Error(String(response.status));
      setCorrections(payload?.corrections ?? []);
      const data = payload?.currentData;
      if (data) {
        setDraftTitle(typeof data.title === "string" ? data.title : "");
        // The body lives in whichever field this item actually uses; write it
        // back to the same one so we never swap storage formats underneath.
        const field = ["description", "content_html", "content_text"]
          .find((key) => typeof data[key] === "string") ?? "description";
        setContentField(field);
        setDraftContent(String(data[field] ?? ""));
      }
    } catch {
      showToast(t("corrections.loadFailed"), "error");
    }
  }, [itemId, t]);

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
    void loadCorrections();
  }, [load, loadCorrections]);

  async function propose() {
    setBusyCorrection("new");
    try {
      const response = await fetch(ADMIN_URLS.ajaxReviewCorrections(), {
        body: JSON.stringify({
          actorId: ACTOR,
          itemId,
          proposedData: {title: draftTitle, [contentField]: draftContent},
          reason: draftReason || null,
        }),
        headers: {"Content-Type": "application/json"},
        method: "POST",
      });
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("corrections.saveFailed"));
      showToast(t("saveAction.saved"), "success");
      setDraftReason("");
      await loadCorrections();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("corrections.saveFailed"),
        "error",
      );
    } finally {
      setBusyCorrection(null);
    }
  }

  async function decide(correctionId: string, action: "approve" | "reject") {
    setBusyCorrection(correctionId);
    try {
      const response = await fetch(
        ADMIN_URLS.ajaxReviewCorrection(correctionId),
        {
          body: JSON.stringify({action, actorId: ACTOR}),
          headers: {"Content-Type": "application/json"},
          method: "POST",
        },
      );
      const data = await response.json().catch(() => ({})) as Record<string, any>;
      if (!response.ok) throw new Error(data.error ?? t("corrections.saveFailed"));
      showToast(t("saveAction.saved"), "success");
      await loadCorrections();
      await load();
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("corrections.saveFailed"),
        "error",
      );
    } finally {
      setBusyCorrection(null);
    }
  }

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

  return (<>
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{t("corrections.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("corrections.intro")}</p>

      <div className="mt-4 grid gap-3 rounded-lg border p-3">
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("corrections.titleLabel")}</span>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            onChange={(event) => setDraftTitle(event.target.value)}
            value={draftTitle}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("corrections.contentLabel")}</span>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            onChange={(event) => setDraftContent(event.target.value)}
            rows={8}
            value={draftContent}
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{t("corrections.reasonLabel")}</span>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            onChange={(event) => setDraftReason(event.target.value)}
            value={draftReason}
          />
        </label>
        <div>
          <Button
            disabled={busyCorrection === "new"}
            onClick={() => void propose()}
            size="sm"
            type="button"
          >
            {t("corrections.submitAction")}
          </Button>
        </div>
      </div>

      {corrections.length === 0
        ? <p className="mt-3 text-sm text-muted-foreground">
            {t("corrections.empty")}
          </p>
        : <ul className="mt-3 flex flex-col gap-3">
          {corrections.map((correction) => (
            <li className="rounded-lg border p-3" key={correction.id}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {correction.status === "pending"
                    ? t("corrections.pending")
                    : correction.status === "approved"
                      ? t("corrections.approved")
                      : t("corrections.rejected")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("corrections.submittedBy")}
                  {correction.submittedBy ?? "—"}
                </span>
                {correction.reviewedBy && <span className="text-xs text-muted-foreground">
                  {t("corrections.reviewedBy")}
                  {correction.reviewedBy}
                </span>}
              </div>

              {correction.reason && (
                <p className="mt-1 text-sm">{t("corrections.reasonLabel")}{correction.reason}</p>
              )}

              {correction.changes.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                  {correction.changes.map((change, index) => (
                    <li key={`${correction.id}-${index}`}>
                      <span className="font-semibold">{change.path}</span>
                      {change.op !== "add" && (
                        <span className="text-destructive">
                          {" "}{renderValue(change.before)}
                        </span>
                      )}
                      {change.op !== "remove" && (
                        <span className="text-emerald-600">
                          {" "}{renderValue(change.after)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {correction.status === "pending" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-sm">{t("corrections.confirmQuestion")}</span>
                  <Button
                    disabled={busyCorrection === correction.id}
                    onClick={() => void decide(correction.id, "approve")}
                    size="sm"
                    type="button"
                  >
                    {t("corrections.approveAction")}
                  </Button>
                  <Button
                    disabled={busyCorrection === correction.id}
                    onClick={() => void decide(correction.id, "reject")}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("corrections.rejectAction")}
                  </Button>
                  {correction.submittedBy === ACTOR && (
                    <span className="text-xs text-muted-foreground">
                      {t("corrections.selfApproveNote")}
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>}
    </div>

    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
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
              disabled={busyId === row.id || row.restorable === false}
              onClick={() => restore(row.id)}
              size="sm"
              title={row.restorable === false
                ? t("review.restoreUnavailableHint")
                : undefined}
              type="button"
              variant="outline"
            >
              {t("review.restoreThis")}
            </Button>
            {row.restorable === false && (
              <span className="ml-2 text-xs text-muted-foreground">
                {t("review.restoreUnavailableHint")}
              </span>
            )}
          </div>
        </li>))}
      </ol>}
  </div></>);
}
