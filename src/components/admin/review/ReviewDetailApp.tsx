import {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {
  FieldDiffList,
  type FieldChange,
} from "@/components/admin/shared/FieldDiff";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * The correction panel for one chapter: review the rendered body, propose a
 * fix, and confirm (同意) or reject it.
 *
 * Full history browsing and version restore live on `/admin/audit/` — this page
 * only decides what to do with what is still unconfirmed.
 *
 * `t` comes from `useTranslation`, NOT `i18n.t.bind(i18n)`: bind() returns a new
 * function every render, so every `useCallback([t])` changed identity and the
 * load effect re-ran after each render — which re-fetched and reset the draft
 * fields, wiping whatever was being typed.
 */


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


export default function ReviewDetailApp({itemId}: {itemId: string}) {
  const {t} = useTranslation();
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

  useEffect(() => {
    void loadCorrections();
  }, [loadCorrections]);

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
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : t("corrections.saveFailed"),
        "error",
      );
    } finally {
      setBusyCorrection(null);
    }
  }

  return (<>
    <div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{t("corrections.title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("corrections.intro")}</p>
      <p className="mt-1 text-sm">
        <a className="text-muted-foreground underline" href={ADMIN_URLS.auditItem(itemId)}>
          {t("audit.viewTrail")}
        </a>
      </p>

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
                <FieldDiffList changes={correction.changes} />
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
  </>);
}
