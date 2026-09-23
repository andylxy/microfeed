/**
 * Verifies the admin i18n resources against how the code actually uses them.
 *
 * `translate()` returns the key itself when it cannot resolve it, so a missing
 * key renders as `errors.foo.bar` in the dashboard. `tsc` cannot catch that:
 * keys are plain strings at every call site. This script is the only guard.
 *
 * It asserts five things:
 *   unresolved       - a referenced key that `translate()` cannot resolve.
 *   only en / only zh - the two resource files drifted apart.
 *   placeholder mis  - same key, different `{{placeholders}}` per language.
 *   self-ref in en   - a value that starts with "errors." means a bulk
 *                      literal-to-key replacement overwrote en.ts's own value.
 *
 * Run with `yarn i18n:check`. It exits non-zero when anything is wrong.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {ADMIN_MENU_CODES} from "../src/shared/Constants";
import {en} from "../src/shared/i18n/en";
import {flatten, translate} from "../src/shared/i18n/index";
import {zhCN} from "../src/shared/i18n/zh-CN";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");

function walk(directory: string, out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (statSync(entry).isDirectory()) walk(entry, out);
    else if (/\.(ts|tsx|astro)$/u.test(entry)) out.push(entry);
  }
  return out;
}

// Deliberately permissive: it covers all three literal forms. Each one was a
// real blind spot that produced a false "0 missing".
//   - "..." and '...'  (with escape handling, so `Cloudflare's` is not
//     truncated at the apostrophe)
//   - `...`            (backtick strings with NO interpolation)
// Template literals that contain ${} are NOT matched - check those by hand.
const literal =
  '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`[^`$]*`)';

// Every AppError subclass that takes an i18n key as its first argument.
const ERROR_CONSTRUCTORS =
  "AppError|PageRequestError|WebhookRequestError|PageConflictError|" +
  "PageThemeUnsupportedError|WebhookUnavailableError|WebhookEndpointLimitError|" +
  "SiteFileConflictError|SiteFileRequestError";

const PATTERNS = [
  new RegExp(`\\btranslate\\(\\s*(${literal})`, "gu"),
  new RegExp(`\\blocalizedError\\(\\s*[^,()]+,\\s*(${literal})`, "gu"),
  new RegExp(`\\blocalizedTextError\\(\\s*[^,()]+,\\s*(${literal})`, "gu"),
  new RegExp(`\\bnew\\s+(?:${ERROR_CONSTRUCTORS})\\(\\s*(${literal})`, "gu"),
  new RegExp(`\\bt\\(\\s*(${literal})`, "gu"),
  new RegExp(`\\bi18n\\.t\\(\\s*(${literal})`, "gu"),
];

const referenced = new Set<string>();
for (const file of walk(sourceRoot)) {
  const source = readFileSync(file, "utf8");
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      referenced.add(match[1].slice(1, -1));
    }
  }
}

const flatEnglish = flatten(en as never);
const flatChinese = flatten(zhCN as never);
const placeholders = (value: string): string =>
  (value.match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/gu) ?? []).sort().join(",");

const unresolved = [...referenced].filter((key) => translate(key) === key);
const onlyEnglish = Object.keys(flatEnglish).filter((key) => !(key in flatChinese));
const onlyChinese = Object.keys(flatChinese).filter((key) => !(key in flatEnglish));
const mismatchedPlaceholders = Object.keys(flatEnglish).filter(
  (key) => key in flatChinese &&
    placeholders(flatEnglish[key]) !== placeholders(flatChinese[key]),
);
const selfReferential = Object.entries(flatEnglish)
  .filter(([, value]) => value.startsWith("errors."))
  .map(([key]) => key);

// The sidebar renders its labels through a dynamic key (`menu.item.${id}`), so
// the literal scan above cannot see them: a missing one would render the raw
// key name in the dashboard. Enumerate the ids instead - this is the gap that
// let three novel-cms navigation labels ship untranslated.
const missingNavLabels = Object.values(ADMIN_MENU_CODES)
  .map((id) => `menu.item.${id}`)
  .filter((key) => translate(key) === key);

// The review pages render labels through dynamic keys that the literal scan
// above cannot see, so a missing one would silently render the raw key name:
//   - `review.done.${action}`   (REVIEW_ACTIONS)
//   - `review.action.${row.action}` (the audit-row actions)
//   - `review.category.${category}` (REPORT_CATEGORIES)
// Enumerate each value set and flag any key that does not resolve.
const REVIEW_ACTIONS = ["submit", "approve", "reject", "takedown"] as const;
const REVIEW_AUDIT_ACTIONS = [
  "edit", "submit", "approve", "reject", "takedown", "restore", "auto_flag",
] as const;
const REPORT_CATEGORIES = [
  "plagiarism", "pornography", "violence", "advertising", "other",
] as const;
const missingReviewLabels = [
  ...REVIEW_ACTIONS.map((action) => `review.done.${action}`),
  ...REVIEW_AUDIT_ACTIONS.map((action) => `review.action.${action}`),
  ...REPORT_CATEGORIES.map((category) => `review.category.${category}`),
].filter((key) => translate(key) === key);

const failures: string[] = [];
if (unresolved.length > 0) {
  failures.push(
    `unresolved keys (${unresolved.length}) - translate() would render the key ` +
      `itself:\n    ${unresolved.slice(0, 20).join("\n    ")}`,
  );
}
if (onlyEnglish.length > 0) {
  failures.push(
    `keys missing from zh-CN (${onlyEnglish.length}):\n    ` +
      onlyEnglish.slice(0, 20).join("\n    "),
  );
}
if (onlyChinese.length > 0) {
  failures.push(
    `keys missing from en (${onlyChinese.length}):\n    ` +
      onlyChinese.slice(0, 20).join("\n    "),
  );
}
if (mismatchedPlaceholders.length > 0) {
  failures.push(
    `placeholder mismatches (${mismatchedPlaceholders.length}):\n    ` +
      mismatchedPlaceholders.slice(0, 20).join("\n    "),
  );
}
if (selfReferential.length > 0) {
  failures.push(
    `en values that are themselves keys (${selfReferential.length}):\n    ` +
      selfReferential.slice(0, 20).join("\n    "),
  );
}
if (missingNavLabels.length > 0) {
  failures.push(
    `navigation labels with no translation (${missingNavLabels.length}) - the ` +
      `sidebar would show the key itself:\n    ` +
      missingNavLabels.join("\n    "),
  );
}
if (missingReviewLabels.length > 0) {
  failures.push(
    `review labels with no translation (${missingReviewLabels.length}) - the ` +
      `review pages would show the key itself:\n    ` +
      missingReviewLabels.join("\n    "),
  );
}

console.log(`referenced keys    ${referenced.size}`);
console.log(`en / zh-CN         ${Object.keys(flatEnglish).length} / ${Object.keys(flatChinese).length}`);

if (failures.length > 0) {
  console.error(`\ni18n check failed:\n\n${failures.join("\n\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("i18n check passed");
}
