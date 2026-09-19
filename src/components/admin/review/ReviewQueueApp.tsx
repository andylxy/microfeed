import React, {useCallback, useEffect, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import AdminInput from "@/components/admin/shared/AdminInput";
import {ADMIN_URLS} from "@/shared/StringUtils";

/**
 * Review queue: chapters waiting for a decision. Approving publishes; rejecting
 * requires a reason; taking down unpublishes and marks the chapter so the
 * reading page can explain itself.
 *
 * `t` comes from `useTranslation`, NOT `i18n.t.bind(i18n)`: bind() returns a new
 * function on every render, which made every `useCallback([t])` here a new
 * identity and re-ran the load effect after each render — an endless request
 * loop that surfaced as a repeating "could not load" toast.
 */

interface QueueItem {
  id: string;
  title: string;
  reviewStatus: string;
  updatedAt: string;
}

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
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");

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

  async function act(itemId: string, action: string, actionReason?: string) {
    setBusyId(itemId);
    try {
      await requestJson(ADMIN_URLS.ajaxReviewItem(itemId), {
        body: JSON.stringify({action, reason: actionReason ?? null}),
        method: "POST",
      });
      showToast(t(`review.done.${action}`), "success");
      setRejectingId(null);
      setReason("");
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

  return (<div className="flex flex-col gap-6">
    <section className="rounded-[14px] border bg-card p-5 text-card-foreground shadow-xs">
      <h2 className="text-lg font-semibold">{t("review.pendingChapters")}</h2>
      {items.length === 0
        ? <p className="mt-2 text-sm text-muted-foreground">{t("review.noPendingChapters")}</p>
        : <ul className="mt-4 flex flex-col gap-3">
          {items.map((item) => (<li className="rounded-lg border p-3" key={item.id}>
            <a className="font-medium" href={ADMIN_URLS.reviewItem(item.id)}>
              {item.title || t("review.untitled")}
            </a>
            <div className="text-xs text-muted-foreground">{item.updatedAt}</div>

            {rejectingId === item.id
              ? <div className="mt-3 flex items-end gap-2">
                <AdminInput
                  label={t("review.rejectReason")}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)}
                  value={reason}
                />
                <Button
                  disabled={busyId === item.id || reason.trim().length === 0}
                  onClick={() => act(item.id, "reject", reason)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {t("review.confirmReject")}
                </Button>
                <Button
                  onClick={() => { setRejectingId(null); setReason(""); }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {t("common.cancel")}
                </Button>
              </div>
              : <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, "approve")}
                  size="sm"
                  type="button"
                >
                  {t("review.approve")}
                </Button>
                <Button
                  disabled={busyId === item.id}
                  onClick={() => setRejectingId(item.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {t("review.reject")}
                </Button>
                <Button
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, "takedown")}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {t("review.takedown")}
                </Button>
              </div>}
          </li>))}
        </ul>}
    </section>
  </div>);
}
