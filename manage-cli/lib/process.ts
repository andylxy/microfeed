import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
import {fileURLToPath} from "node:url";

import type {
  CommandResult,
  CommandRunner,
  RunOptions,
} from "../types";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);

export function relativePathFromDirectory(
  directory: string,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const relative = platformPath.relative(directory, filename);
  if (platformPath.isAbsolute(relative)) return undefined;
  return relative.replaceAll(platformPath.sep, "/") || ".";
}

interface PackageBinaryMetadata {
  bin?: string | Record<string, string>;
}

function packageBinaryJavaScript(
  packageName: string,
  binaryName: string,
): string {
  const metadataPath = require.resolve(`${packageName}/package.json`);
  const metadata = require(metadataPath) as PackageBinaryMetadata;
  const binary = typeof metadata.bin === "string"
    ? metadata.bin
    : metadata.bin?.[binaryName];
  if (!binary) {
    throw new Error(
      `The installed ${packageName} package does not provide ${binaryName}.`,
    );
  }
  return path.resolve(path.dirname(metadataPath), binary);
}

export const runCommand: CommandRunner = (
  executable,
  args,
  options: RunOptions = {},
) => new Promise((resolve, reject) => {
  const runsWithNode = [".cjs", ".js", ".mjs"].includes(
    path.extname(executable).toLowerCase(),
  );
  // A long-running child keeps a private stdin pipe that is never ended, so no
  // ancestor layer can deliver an EOF that Vite's dev server would treat as a
  // shutdown request. Its stdout/stderr stay inherited so output streams live.
  const streamsLive = Boolean(options.interactive || options.longRunning);
  const child = spawn(
    runsWithNode ? process.execPath : executable,
    runsWithNode ? [executable, ...args] : [...args],
    {
      cwd: options.cwd ?? repositoryRoot,
      env: {...process.env, ...options.env},
      shell: false,
      stdio: streamsLive
        ? [options.interactive ? "inherit" : "pipe", "inherit", "inherit"]
        : ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";

  if (!streamsLive) {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  }

  child.once("error", (error) => {
    cleanupListeners();
    if (streamsLive) child.stdin?.end();
    reject(error);
  });

  // Long-running interactive children (e.g. `astro dev` launched by
  // `yarn manage dev`) must survive termination signals that only reach the
  // parent process. Without forwarding, a SIGTERM sent to manage-cli (for
  // example by a non-interactive launcher) kills astro out of band, leaving a
  // stale dev lock and surfacing as a misleading "… failed (exit code 143)".
  // Forwarding lets astro shut down gracefully and release its lock.
  const forwardSignal = streamsLive
    ? (received: NodeJS.Signals) => {
        try {
          child.kill(received);
        } catch {
          /* child may already have exited */
        }
      }
    : undefined;
  const cleanupListeners = () => {
    if (forwardSignal) {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    }
  };
  if (forwardSignal) {
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
  }

  child.once("close", (exitCode, signal) => {
    cleanupListeners();
    // The child is gone, so the keep-alive pipe has no reader left; close our
    // end to release the file descriptor instead of leaking it until the
    // parent process exits.
    if (streamsLive) child.stdin?.end();
    const result: CommandResult = {
      exitCode: exitCode ?? 1,
      stderr,
      stdout,
    };
    if (result.exitCode !== 0 && !options.allowFailure) {
      const detail = stderr.trim() || stdout.trim();
      reject(new Error(
        `${path.basename(executable)} ${args.join(" ")} failed` +
        (detail ? `:\n${detail}` : ".") +
        // An interactive child prints straight to the terminal, so its output
        // never reaches `detail`; the exit status is then the only clue left.
        ` (exit code ${result.exitCode}${signal ? `, signal ${signal}` : ""})`,
      ));
      return;
    }
    resolve(result);
  });
});

export function runWrangler(
  runner: CommandRunner,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  // JavaScript entry points are executed directly with Node by runCommand, so
  // Windows never needs a command shim or shell parsing.
  return runner(packageBinaryJavaScript("wrangler", "wrangler"), args, {
    cwd: repositoryRoot,
    ...options,
  });
}

export function runYarnScript(
  runner: CommandRunner,
  script: string,
  options: RunOptions = {},
): Promise<CommandResult> {
  const yarnJavaScript = (
    options.env?.MICROFEED_YARN_JAVASCRIPT ??
    process.env.MICROFEED_YARN_JAVASCRIPT
  )?.trim() || packageBinaryJavaScript("@yarnpkg/cli-dist", "yarn");
  return runner(yarnJavaScript, [script], {
    cwd: repositoryRoot,
    ...options,
  });
}

export function runAstroDev(
  runner: CommandRunner,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  // The dev server is started directly with Node instead of through
  // `yarn run dev:astro`. The Yarn middle layer forwards its own stdin to the
  // script child, so an EOF anywhere above the CLI (a closed terminal, a
  // hidden launcher console, a redirected pipe) reaches `astro dev` and shuts
  // Vite down; it can also exit while its child keeps running and surface as a
  // bare "yarn.js dev:astro failed." with no diagnostic output. Running the
  // same command the package.json `dev:astro` script runs (`astro dev --host
  // 0.0.0.0`) removes that layer and keeps the server attached to the CLI.
  const binDirectory = path.join(repositoryRoot, "node_modules", ".bin");
  const searchPath = process.env.PATH ?? process.env.Path ?? "";
  return runner(packageBinaryJavaScript("astro", "astro"), args, {
    cwd: repositoryRoot,
    ...options,
    // `yarn run` prepends node_modules/.bin to PATH for scripts; reproduce it
    // so binaries spawned by the dev server resolve exactly the same entries.
    env: {
      ...options.env,
      PATH: [binDirectory, searchPath]
        .filter((entry) => entry.length > 0)
        .join(path.delimiter),
    },
    longRunning: true,
  });
}

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;

export async function repositoryCommitSha(
  runner: CommandRunner,
  sourceRoot = repositoryRoot,
): Promise<string> {
  const markerPath = path.join(sourceRoot, ".microfeed-runtime.json");
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      sourceCommit?: unknown;
    };
    if (
      typeof marker.sourceCommit !== "string" ||
      !FULL_GIT_SHA.test(marker.sourceCommit)
    ) {
      throw new Error(
        "The packaged microfeed deployment source commit is invalid.",
      );
    }
    return marker.sourceCommit;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const result = await runner(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    {cwd: sourceRoot},
  );
  const sha = result.stdout.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(sha)) {
    throw new Error(
      "Unable to determine the current Git commit for this deployment.",
    );
  }
  return sha;
}

export function openUrl(
  runner: CommandRunner,
  url: string,
): Promise<CommandResult> {
  if (process.platform === "darwin") {
    return runner("open", [url], {interactive: true});
  }
  if (process.platform === "win32") {
    return runner("cmd.exe", ["/c", "start", "", url], {interactive: true});
  }
  return runner("xdg-open", [url], {interactive: true});
}
