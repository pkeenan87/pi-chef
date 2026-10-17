import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitWorkspace } from "../git/workspace.js";
import type { CheckRunner } from "../review/review.js";

const exec = promisify(execFile);
const MAX_CACHED_CHECKS = 200;
/** Output a check may print before it is stopped. A test suite's log fits; a runaway loop does not. */
const CHECK_MAX_BUFFER = 64 * 1024 * 1024;
/** A check that runs longer than this is stopped and fails, so a hung check cannot stall /review or /build. */
export const CHECK_TIMEOUT_MS = 30 * 60_000;

/** Runs a command with execFile and reports its exit code instead of throwing. */
export const defaultRunner: CheckRunner = {
  async run(command, args, cwd) {
    try {
      const { stdout, stderr } = await exec(command, args, { cwd, encoding: "utf8", maxBuffer: CHECK_MAX_BUFFER, timeout: CHECK_TIMEOUT_MS });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number | string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string };
      // Say why a check was stopped, so the failure is not read as a test failure.
      const why =
        failed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? `\n[pi-chef: stopped after ${CHECK_MAX_BUFFER / 1024 / 1024} MB of output]`
          : failed.killed && failed.signal
            ? `\n[pi-chef: stopped after ${CHECK_TIMEOUT_MS / 60_000} minutes (${failed.signal})]`
            : "";
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: `${failed.stderr ?? ""}${why}` };
    }
  },
};

/** Tree sha of a clean checkout, or undefined when it is dirty or not a git directory. */
async function cleanTree(git: GitWorkspace, cwd: string): Promise<string | undefined> {
  const status = await git.git(["status", "--porcelain"], cwd);
  if (status.code !== 0 || status.stdout.trim()) return undefined;
  const tree = await git.git(["rev-parse", "HEAD^{tree}"], cwd);
  return tree.code === 0 ? tree.stdout.trim() : undefined;
}

/** Skips re-running a check that already passed on an identical clean tree. */
export function cachingRunner(git: GitWorkspace, runner: CheckRunner): CheckRunner {
  const passed = new Map<string, string>();
  return {
    run: async (command, args, cwd) => {
      const tree = await cleanTree(git, cwd);
      const key = tree ? `${tree}\u0000${command}\u0000${args.join("\u0000")}` : undefined;
      const cached = key ? passed.get(key) : undefined;
      if (cached) return { code: 0, stdout: cached, stderr: "" };
      const result = await runner.run(command, args, cwd);
      if (key && result.code === 0) {
        if (passed.size >= MAX_CACHED_CHECKS) passed.clear();
        passed.set(key, `cached: passed earlier on identical tree ${tree}\n${result.stdout.slice(0, 1000)}`);
      }
      return result;
    },
  };
}
