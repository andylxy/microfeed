import {useTranslation} from "@/client/i18n";

/**
 * A field-level change rendered the way `git diff` reads.
 *
 * Shared by the audit trail and the review queue: both answer the same question
 * ("what exactly moved?"), and both used to print a whole chapter body on one
 * line, which is unreadable the moment the value has more than a few words.
 *
 * The `FieldChange` shape is mirrored rather than imported because browser code
 * must not reach into `@/server/` (see
 * `tests/unit/source-architecture.test.ts`).
 */
export interface FieldChange {
  op: "add" | "update" | "remove";
  path: string;
  before?: unknown;
  after?: unknown;
}

/**
 * A chapter body is stored as one long line of HTML — Quill's output has no
 * newlines at all. Diffing that as a single line paints the whole chapter as one
 * `-` and one `+` line, which tells you nothing about what moved. So a body
 * without newlines is split at block boundaries instead, giving a paragraph-by-
 * paragraph diff. (Markdown-rendered bodies already carry newlines and are left
 * alone.)
 *
 * Deliberately uses replace-then-split rather than a lookbehind: lookbehind is
 * unsupported on older Safari, where it would throw while parsing the bundle.
 */
const BLOCK_END = /<\/(?:p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/giu;

export function toLines(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    if (value.includes("\n") || !/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/iu.test(value)) {
      return value.split("\n");
    }
    return value.replace(BLOCK_END, "$&\n").split("\n").filter(Boolean);
  }
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
 * the lines that actually moved. Very large values fall back to one delete
 * block + one add block (a DP table would be too big).
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

export function FieldDiff({change}: {change: FieldChange}) {
  const {t} = useTranslation();
  const lines = diffLines(change.before, change.after);
  if (lines.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {t("diff.unavailable")}
      </div>
    );
  }
  const hunks = buildHunks(lines);

  return (
    <div className="overflow-x-auto rounded-md border bg-muted/30">
      <div className="flex items-center gap-2 border-b bg-muted/45 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="text-foreground">{change.path}</span>
        <span>· {t(`diff.op.${change.op}`)}</span>
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

/** Every change of one record, as a stack of diff blocks. */
export function FieldDiffList({changes}: {changes: FieldChange[]}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {changes.map((change, index) => (
        <FieldDiff change={change} key={`${change.path}-${index}`} />
      ))}
    </div>
  );
}
