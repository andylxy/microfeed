import {formatAdminDateTime24} from "@/client/admin-date-format";
import {useTranslation} from "@/client/i18n";

/**
 * A chapter's review versions, shown read-only inside the audit trail page.
 *
 * This list answers "what happened to the versions I saved?" — including the
 * ones already approved or rejected, which the review queue (pending only)
 * never shows again. Decisions live on `/admin/review/`; nothing here offers
 * an action, not even the archive toggle the audit rows have.
 */

export interface ReviewRecord {
  action: string;
  chapterNo: string | number | null;
  contentHtml: string;
  id: string;
  reviewedAt: number | null;
  status: string;
  submittedAt: number | null;
  title: string;
  volume: string | null;
}

interface Props {
  records: ReviewRecord[];
}

function formatTimestamp(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return formatAdminDateTime24(new Date(ms).toISOString()) ||
    new Date(ms).toISOString();
}

/** Status badge colouring: neutral for pending, green approved, red rejected. */
function statusBadgeClass(status: string): string {
  switch (status) {
    case "approved":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "rejected":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    default:
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

export default function ReviewRecords({records}: Props) {
  const {t} = useTranslation();
  if (records.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{t("review.records.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("review.records.intro")}
      </p>
      <ol className="space-y-3">
        {records.map((record) => {
          const submitted = formatTimestamp(record.submittedAt);
          const reviewed = formatTimestamp(record.reviewedAt);
          return (
            <li
              className="rounded-[14px] border bg-card p-4 shadow-xs"
              key={record.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(record.status)}`}
                >
                  {t(`review.records.status.${record.status}`)}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
                  {t(`audit.action.${record.action}`)}
                </span>
                {submitted ? (
                  <span className="text-xs text-muted-foreground">
                    {t("review.records.submittedAt", {submitted})}
                  </span>
                ) : null}
                {reviewed ? (
                  <span className="text-xs text-muted-foreground">
                    {t("review.records.reviewedAt", {reviewed})}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">{record.id}</span>
              </div>

              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
                <dt className="text-muted-foreground">
                  {t("review.records.titleLabel")}
                </dt>
                <dd>{record.title || t("review.untitled")}</dd>
                <dt className="text-muted-foreground">
                  {t("review.records.volume")}
                </dt>
                <dd>{record.volume ?? "—"}</dd>
                <dt className="text-muted-foreground">
                  {t("review.records.chapterNo")}
                </dt>
                <dd>{record.chapterNo ?? "—"}</dd>
              </dl>

              {record.contentHtml ? (
                <div
                  className="prose prose-sm mt-3 max-w-none rounded-md border bg-muted/30 p-3 dark:prose-invert"
                  dangerouslySetInnerHTML={{__html: record.contentHtml}}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
