// Shared fixture of the audit-kit tests (FA-kit-at14 lane K): a temporary git worktree with a bare `origin` whose directory name is
// the repository name, a fixed identity and `core.autocrlf=false`, so every sha in a test is made by this process alone and no
// test touches a developer clone. Plain Node ESM; the tests call `cleanup()` in a `finally`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const IDENTITY = ["-c", "user.name=Audit Kit", "-c", "user.email=audit-kit@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always"];

/** Runs git in `cwd` and returns trimmed stdout; throws with stderr on a non-zero exit. */
export function gitIn(cwd, args) {
  const r = spawnSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository `name` with a bare origin `<dir>/origin/<name>.git` and a worktree `<dir>/work/<name>`, one commit on `main`. */
export function makeFixture(name = "kauro-platform") {
  const dir = mkdtempSync(join(tmpdir(), "audit-kit-"));
  const origin = join(dir, "origin", `${name}.git`);
  const work = join(dir, "work", name);
  mkdirSync(origin, { recursive: true });
  mkdirSync(work, { recursive: true });
  gitIn(origin, ["init", "--bare"]);
  gitIn(work, ["init"]);
  gitIn(work, ["remote", "add", "origin", origin]);
  const fx = {
    dir,
    origin,
    work,
    name,
    git: (args) => gitIn(work, args),
    /** Writes `files` ({path: text, null deletes}) and commits them; returns the new sha. */
    commit(message, files) {
      for (const [rel, text] of Object.entries(files)) {
        const abs = join(work, rel);
        if (text === null) {
          rmSync(abs, { force: true });
        } else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text);
        }
      }
      gitIn(work, ["add", "-A"]);
      gitIn(work, ["commit", "--allow-empty", "-m", message]);
      return gitIn(work, ["rev-parse", "HEAD"]);
    },
    /** Creates branch `branchName` at `from` and checks it out. */
    branch(branchName, from) {
      gitIn(work, ["checkout", "-B", branchName, from]);
    },
    checkout(ref) {
      gitIn(work, ["checkout", ref]);
    },
    tree: (sha) => gitIn(work, ["rev-parse", `${sha}^{tree}`]),
    cleanup() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  fx.commit("initial", { "README.md": "fixture\n" });
  gitIn(work, ["push", "origin", "HEAD:refs/heads/main"]);
  return fx;
}
