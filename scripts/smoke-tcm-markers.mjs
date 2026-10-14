// Fast smoke for the TCM marker render-gate fix.
//
// Why this exists: `yarn test` runs the whole unit suite (~1115 cases) plus the
// worker suite (~45 files) and takes 30-35 min. The render-gate change
// (src/server/tcm/markerPopover.ts two-gate split + mapStyles, and
// src/shared/TcmMarkers.ts markersToPlainText/hasTcmMarker) is guarded by exactly
// two unit files. This script runs ONLY those, so a warm run is <1s and even a
// cold run is ~1 min — not an hour.
//
// It does NOT run the full suite. Use `yarn test` (background) for the final gate.

import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, "..");
// On Windows the `node_modules/.bin/vitest` wrapper is a shell script; invoke the
// real JS entry directly so it runs under the Node we launch with.
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");

// The two files that directly guard the render-gate change. Keep this list tight:
// every file added here is paid for on every smoke run.
const files = [
  "tests/unit/tcm-markers.test.ts",
  "tests/unit/server/tcm-marker-popover.test.ts",
];

const start = Date.now();
const res = spawnSync(process.execPath, [vitest, "run", ...files], {
  cwd: root,
  stdio: "inherit",
  env: {...process.env, TZ: "UTC"},
});
const secs = ((Date.now() - start) / 1000).toFixed(1);

console.log(
  `\n[tcm-smoke] ran ${files.length} targeted file(s) in ${secs}s — exit ${res.status}`,
);
console.log("[tcm-smoke] scope: TCM marker render-gate guards only (not the full suite)");

process.exit(res.status ?? 1);
