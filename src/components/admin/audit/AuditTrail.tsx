import {Fragment, useCallback, useState} from "react";

import {useTranslation} from "@/client/i18n";
import {showToast} from "@/client/ToastUtils";
import {Button} from "@/components/ui/button";
import {
  AdminCollectionError,
  AdminCollectionLoading,
} from "@/components/admin/shared/AdminCollectionState";
import {ADMIN_URLS} from "@/shared/StringUtils";

/** Mirrored locally: browser code must not import from `@/server/` (see
 *  `tests/unit/source-architecture.test.ts`). */
export interface FieldChange {
  op: "add" | "update" | "remove";
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface AuditTrailRow {
  action: string;
  actorId: string | null;
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {hour12: false});
}

function toLines(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.split("\n");
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

type DiffLine =
  | {kind: "context"; text: string}
  | {kind: "add"; text: string}
  | {kind: "del"; text: string};

/**
 * Line-level diff with an LCS table, so a change inside a long body shows only
 * the lines that actually moved — the way `git diff` reads. Very large values
 * fall back to one delete block + one add block (a DP table would be too big).
 */
/** `noUncheckedIndexedAccess` is on, so every read is funnelled through here. */
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}

function countAt(table: number[], index: number): number {
  return table[index] ?? 0;
}

function diffLines(before: unknown, after: unknown): DiffLine[] {
  const left = toLines(before);
  const right = toLines(after);
  if (left.length * right.length > 400_000) {
    return [
      ...left.map((text): DiffLine => ({kind: "del", text})),
      ...right.map((text): DiffLine => ({kind: "add", text})),
    ];
  }

  const width = right.length + 1;
  const lcs = new Array<number>((left.length + 1) * width).fill(0);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = lineAt(left, i) === lineAt(right, j)
        ? countAt(lcs, (i + 1) * width + j + 1) + 1
        : Math.max(countAt(lcs, (i + 1) * width + j), countAt(lcs, i * width + j + 1));
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (lineAt(left, i) === lineAt(right, j)) {
      out.push({kind: "context", text: lineAt(left, i)});
      i += 1;
      j += 1;
    } else if (countAt(lcs, (i + 1) * width + j) >= countAt(lcs, i * width + j + 1)) {
      out.push({kind: "del", text: lineAt(left, i)});
      i += 1;
    } else {
      out.push({kind: "add", text: lineAt(right, j)});
      j += 1;
    }
  }
  while (i < left.length) {
    out.push({kind: "del", text: lineAt(left, i)});
    i += 1;
  }
  while (j < right.length) {
    out.push({kind: "add", text: lineAt(right, j)});
    j += 1;
  }
  return out;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Group the diff into `@@` hunks the way git does: a few unchanged lines around
 * each change, with the untouched stretches in between collapsed. A chapter body
 * is hundreds of lines; without this every record would print all of them.
 */
function buildHunks(lines: DiffLine[], context = 3): Hunk[] {
  const oldNumbers: number[] = [];
  const newNumbers: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    if (line.kind !== "add") oldLine += 1;
    if (line.kind !== "del") newLine += 1;
    oldNumbers.push(oldLine);
    newNumbers.push(newLine);
  }

  const ranges: Array<[number, number]> = [];
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  if (ranges.length === 0) {
    ranges.push([0, Math.max(0, lines.length - 1)]);
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end + 1);
    const from = oldNumbers[start] ?? 0;
    const to = newNumbers[start] ?? 0;
    const oldCount = slice.filter((line) => line.kind !== "add").length;
    const newCount = slice.filter((line) => line.kind !== "del").length;
    return {
      header: `@@ -${from},${oldCount} +${to},${newCount} @@`,
      lines: slice,
    };
  });
}

function ChangeDiff({change}: {change: FieldChange}) {
  const {t} = useTranslation();
  const lines = diffLines(change.before, change.after);
  if (lines.length === 0) {
    return <div className="px-3 py-2 text-xs text-muted-foreground">{t("audit.diffUnavailable")}</div>;
  }
  const hunks = buildHunks(lines);

  return (
    <div className="overflow-x-auto rounded-md border bg-muted/30">
      <div className="flex items-center gap-2 border-b bg-muted/45 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="text-foreground">{change.path}</span>
        <span>· {t(`audit.op.${change.op}`)}</span>
      </div>
      {hunks.map((hunk, hunkIndex) => (
        <div className="pb-1.5" key={`${hunk.header}-${hunkIndex}`}>
          <div className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
            {hunk.header}
          </div>
          {hunk.lines.map((line, index) => {
            const tone = line.kind === "add"
              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              : line.kind === "del"
                ? "bg-red-500/12 text-red-700 dark:text-red-300"
                : undefined;
            const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
            return (
              <div
                className={`whitespace-pre-wrap break-all px-3 font-mono text-xs leading-relaxed ${tone ?? ""}`}
                key={`${index}-${line.text.slice(0, 24)}`}
              >
                {marker}
                {line.text || " "}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
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
        | {error?: string}
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? t("audit.restoreFailed"));
      }
      showToast(t("audit.restored"), "success");
      await load();
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

  if (error) {
    return <AdminCollectionError message={error} retry={() => void load()} />;
  }
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

      <ol className="space-y-3">
        {rows.map((row) => (
          <li
            className="rounded-[14px] border bg-card p-4 shadow-xs"
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
                row.diffData.map((change) => (
                  <Fragment key={`${row.id}-${change.path}`}>
                    <ChangeDiff change={change} />
                  </Fragment>
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
