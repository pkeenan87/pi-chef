import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitWorkspace } from "../git/workspace.js";
import type { CheckRunner } from "../review/review.js";

const exec = promisify(execFile);
const MAX_CACHED_CHECKS = 200;

/** Runs a command with execFile and reports its exit code instead of throwing. */
export const defaultRunner: CheckRunner = {
  async run(command, args, cwd) {
    try {
      const { stdout, stderr } = await exec(command, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
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
