// The subject of an audit record (R2 21:11 "subject commit/tree"): the commit and tree of a CLEAN worktree of the right repository.
// subjectOf({repo, cwd, timeoutMs, runner, save}) reads first (HEAD, its tree, the status, the origin url) and only then calls
// `save(subject)`, so a refused or timed-out call (E_DIRTY, E_REPO_MISMATCH, E_GIT_TIMEOUT) has written nothing (K-6).
import { git } from "./git.mjs";
import { fail } from "./record.mjs";

/** The repository name an origin url ends in (`.../kauro-platform.git` -> `kauro-platform`). */
export function repoNameOf(url) {
  const last = url.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

export function subjectOf({ repo, cwd, timeoutMs, runner, save } = {}) {
  const opts = { cwd, timeoutMs, runner };
  const commit = git(["rev-parse", "HEAD"], opts);
  const tree = git(["rev-parse", "HEAD^{tree}"], opts);
  const status = git(["status", "--porcelain", "--untracked-files=normal"], opts);
  if (status !== "") throw fail("E_DIRTY", `the worktree ${cwd} differs from ${commit}`, { status });
  const origin = git(["remote", "get-url", "origin"], opts);
  if (repoNameOf(origin) !== repo) throw fail("E_REPO_MISMATCH", `the worktree ${cwd} has origin ${origin}, not repository ${repo}`);
  const subject = { repo, commit, tree };
  if (save) save(subject);
  return subject;
}
