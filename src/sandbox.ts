import { WorkflowError } from "./domain.js";

const DENY = [
  /\brm\s+-rf\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bcurl\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bwget\b[^\n|]*\|\s*(sh|bash)\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bdd\s+if=/i,
];

export function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function assertCommandAllowed(command: string, args: string[], allowlist: string[], approved = false): void {
  const line = commandLine(command, args);
  if (DENY.some((pattern) => pattern.test(line))) {
    if (!approved) {
      throw new WorkflowError("COMMAND_DENIED", `Blocked destructive command: ${line}`);
    }
  }
  const allowed = allowlist.some((entry) => line === entry || line.startsWith(`${entry} `));
  if (!allowed) {
    throw new WorkflowError("COMMAND_DENIED", `Command is not on the allowlist: ${line}`);
  }
}

export function isDeniedCommand(line: string): boolean {
  return DENY.some((pattern) => pattern.test(line));
}
