// The run-heavy argv of an audit command (K-5; CLAUDE.md rule 1: every heavy command goes through tools/builder/run-heavy.mjs).
// runHeavyArgv({kind, repo, ref, command, env}) -> [<run-heavy path>, "--kind", kind, "--repo", repo, "--ref", ref, "--", ...command].
// The path comes from env KAURO_RUN_HEAVY and nowhere else (no default: E_RUN_HEAVY_PATH); the kit never emits --force-rerun and
// refuses it in a kind, repo, ref or command (E_RUN_HEAVY_ARG). The coordinator adds the run-heavy kind `audit`
// (estMin 15, minFreeGB 2, weight 1). The caller spawns `node` with this argv; the kit does not spawn.
import { fail } from "./record.mjs";

export function runHeavyArgv({ kind, repo, ref = "HEAD", command, env = process.env } = {}) {
  const path = env.KAURO_RUN_HEAVY;
  if (typeof path !== "string" || path === "") throw fail("E_RUN_HEAVY_PATH", "KAURO_RUN_HEAVY names the run-heavy script and is not set");
  if (typeof kind !== "string" || kind === "" || typeof repo !== "string" || repo === "" || !Array.isArray(command) || command.length === 0) {
    throw fail("E_RUN_HEAVY_ARG", "kind, repo and a non-empty command are required");
  }
  const argv = [path, "--kind", kind, "--repo", repo, "--ref", ref, "--", ...command];
  if (argv.some((a) => String(a).includes("--force-rerun"))) throw fail("E_RUN_HEAVY_ARG", "--force-rerun is never part of an audit run");
  return argv;
}
