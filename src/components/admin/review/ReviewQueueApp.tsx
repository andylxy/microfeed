import {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
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

interface FieldChange {
  op: "add" | "update" | "remove";
  path: string;
  before?: unknown;
  after?: unknown;
}

interface QueueItem {
  id: string;
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

function renderValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
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
    } catch {
      showToast(t("review.actionFailed"), "error");
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
          <li className="rounded-lg border p-3" key={item.id}>
            <div className="flex flex-wrap items-center gap-2">
              <a
                className="font-medium hover:underline"
                href={ADMIN_URLS.reviewItem(item.id)}
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
                  {new Date(item.lastSubmittedAt).toLocaleString()}
                </span>
              )}
              {!item.exists && (
                <span className="text-xs text-destructive">
                  {t("review.chapterMissing")}
                </span>
              )}
            </div>

            {item.changes.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                {item.changes.map((change, index) => (
                  <li key={`${item.id}-${index}`}>
                    <span className={
                      change.op === "add"
                        ? "text-emerald-600"
                        : change.op === "remove"
                          ? "text-destructive"
                          : "text-amber-600"
                    }>
                      {change.op === "add"
                        ? "+"
                        : change.op === "remove"
                          ? "-"
                          : "~"}
                    </span>{" "}
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

            <div className="mt-3 flex gap-2">
              <Button
                disabled={busyId === item.id}
                onClick={() => void decide(item.id, "approve")}
                size="sm"
                type="button"
              >
                {t("review.confirmChanges")}
              </Button>
              <Button
                disabled={busyId === item.id}
                onClick={() => void decide(item.id, "reject")}
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
