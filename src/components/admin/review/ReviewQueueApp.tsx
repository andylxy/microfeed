import {useCallback, useEffect, useState} from "react";

import {formatAdminTimestamp} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {
  FieldDiffList,
  type FieldChange,
} from "@/components/admin/shared/FieldDiff";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * Review queue: chapters with unconfirmed content versions.
 *
 * Every content change goes through one entry point that stores the pre-change
 * snapshot, so "pending" means "this chapter changed and nobody has confirmed it
 * yet". Confirming accepts the changes; rejecting restores the snapshot — a real
 * rollback, not just a relabel.
 *
 * `t` comes from `useTranslation`, NOT `i18n.t.bind(i18n)`: bind() returns a new
 * function on every render, which made every `useCallback([t])` here a new
 * identity and re-ran the load effect after each render — an endless request
 * loop that surfaced as a repeating "could not load" toast.
 */


interface QueueItem {
  itemId: string;
  /** Matches `PendingChapter.itemId`. Reading `id` here sent an undefined itemId, so every confirm/reject failed validation with a 400. */
  title: string;
  pendingCount: number;
  lastSubmittedBy: string | null;
  lastSubmittedAt: number | null;
  changes: FieldChange[];
  exists: boolean;
}

const ACTOR = "admin";

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    headers: {"Content-Type": "application/json"},
    ...init,
  });
  const payload = await response.json().catch(() => null) as
    | {error?: string}
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? String(response.status));
  }
  return payload;
}


export default function ReviewQueueApp() {
  const {t} = useTranslation();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await requestJson(ADMIN_URLS.ajaxReview());
      setItems(payload.items ?? []);
    } catch {
      showToast(t("review.loadFailed"), "error");
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(itemId: string, action: "approve" | "reject") {
    if (action === "reject" && !window.confirm(t("review.rejectConfirm"))) return;
    setBusyId(itemId);
    try {
      await requestJson(ADMIN_URLS.ajaxReview(), {
        body: JSON.stringify({action, actorId: ACTOR, itemId}),
        method: "POST",
      });
      showToast(
        action === "approve" ? t("review.approved") : t("review.rejected"),
        "success",
      );
      await load();
    } catch (error) {
      // Surface what the server actually said — a generic "action failed" hides
      // the real cause (invalid action, missing row, SQL error).
      const detail = error instanceof Error ? error.message : String(error);
      console.error("[review] action failed:", detail);
      showToast(`${t("review.actionFailed")} ${detail}`, "error");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">{t("review.loading")}</div>;
  }

  return (<div className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
    <h2 className="text-lg font-semibold">{t("review.queueTitle")}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t("review.queueIntro")}</p>

    {items.length === 0
      ? <p className="mt-3 text-sm text-muted-foreground">
          {t("review.noPendingChapters")}
        </p>
      : <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li className="rounded-lg border p-3" key={item.itemId}>
            <div className="flex flex-wrap items-center gap-2">
              <a
                className="font-medium hover:underline"
                href={ADMIN_URLS.reviewItem(item.itemId)}
              >
                {item.title || t("corrections.untitled")}
              </a>
              <span className="rounded-full border px-2 text-xs">
                {t("review.pendingCount", {count: item.pendingCount})}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("corrections.submittedBy")}
                {item.lastSubmittedBy ?? "—"}
              </span>
              {item.lastSubmittedAt && (
                <span className="text-xs text-muted-foreground">
                  {formatAdminTimestamp(item.lastSubmittedAt)}
                </span>
              )}
              {!item.exists && (
                <span className="text-xs text-destructive">
                  {t("review.chapterMissing")}
                </span>
              )}
            </div>

            {item.changes.length > 0 && <FieldDiffList changes={item.changes} />}

            <div className="mt-3 flex gap-2">
              <Button
                disabled={busyId === item.itemId}
                onClick={() => void decide(item.itemId, "approve")}
                size="sm"
                type="button"
              >
                {t("review.confirmChanges")}
              </Button>
              <Button
                disabled={busyId === item.itemId}
                onClick={() => void decide(item.itemId, "reject")}
                size="sm"
                type="button"
                variant="destructive"
              >
                {t("review.rejectAndRestore")}
              </Button>
            </div>
          </li>
        ))}
      </ul>}
  </div>);
}
