// git for the audit kit (K-6): git(args, {cwd, timeoutMs = 60000, runner = spawnSync}) through spawnSync with a timeout; a call past it is
// E_GIT_TIMEOUT (the caller has written nothing yet: every audit tool reads with git first and writes afterwards). The runner is
// injectable so a test can stand in a slow git. A non-zero exit is E_GIT with err.stderr, except the codes in `okCodes`
// (e.g. `merge-base --is-ancestor` answers 1 for "no").
import { spawnSync } from "node:child_process";
import { fail } from "./record.mjs";

export const GIT_TIMEOUT_MS = 60000;

/** Runs git and returns {status, stdout, stderr} without judging the exit code. */
export function gitStatus(args, { cwd, timeoutMs = GIT_TIMEOUT_MS, runner = spawnSync } = {}) {
  const r = runner("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error?.code === "ETIMEDOUT") throw fail("E_GIT_TIMEOUT", `git ${args.join(" ")} did not finish in ${timeoutMs} ms`);
  if (r.error) throw fail("E_GIT", `git ${args.join(" ")} could not run: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Runs git and returns trimmed stdout; throws E_GIT on an exit code outside `okCodes`. */
export function git(args, { okCodes = [0], ...options } = {}) {
  const r = gitStatus(args, options);
  if (!okCodes.includes(r.status)) throw fail("E_GIT", `git ${args.join(" ")} exited ${r.status}: ${r.stderr.trim()}`, { status: r.status, stderr: r.stderr });
  return r.stdout.trim();
}
