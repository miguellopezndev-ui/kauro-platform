# Builder gates

`pnpm run verify:fast` generates contracts, prepares the minimum compiled imports, typechecks every workspace, runs
`node --test "tools/test/**/*.test.mjs"`, and checks architecture, fixture clocks, OpenAPI, the web client, and the matrix.
<!-- Skips full workspace and Next.js builds, workspace/database tests, and clean-consume. -->

Workspace exports name `dist` declarations. Tools checks also import contracts, domain, application, persistence, data-plane,
authorization and API runtime source. `prepare-fast.mjs` emits only that source (with `--noCheck`, since the following
typecheck checks everything), UI declarations, the identity server fixture, and the web identity adapter's two entry files.
It does not compile the workspace test suites or build Next.js. The identity seam tools test sends streams through the real
fake server request listener; it needs no listening socket. Its assertions remain the same.

`pnpm run verify` runs the fast gate first, then the full workspace builds, all workspace test runners, and clean-consume.
`build-generated.mjs` uses the existing package build scripts, but runs the contracts compiler and asset copier directly
because generation already ran. Tools tests and the other fast checks run only once. `pnpm run build` and `pnpm run test`
remain usable independently.

```sh
node tools/red-proof.mjs <base> <head> --tests apps/api/test/example.test.ts,packages/domain/test/example.test.ts
node tools/red-proof.mjs <base> <head> --tests apps/api/test/example.test.ts --out /tmp/red-proof.json
node tools/stress-cells.mjs apps/api/dist/test/example.test.js 20
node tools/stress-cells.mjs packages/persistence/dist/test/example.test.js 50 --concurrency 2
```

Red proof resolves both revisions to commits, creates a shared temporary clone and a detached Git worktree, and reverts
every changed source or persistence migration path to base. Tests and their support files remain at head. It installs with
the caller's pnpm store, trying frozen offline installation first and retrying online only for missing cached packages.
Only the named packages and their workspace dependency closure are built. Plain TypeScript builds emit with `--noCheck`:
head tests can refer to types introduced by the fix, so the negative control must reach execution; `verify:fast` checks types.
Each named file must fail with reverted source
and pass with unchanged head source. Both gates read structured events from the reporter exported by `tools/test-runner.mjs`,
which adds error identity to `tools/test-events-reporter.mjs`'s JSON lines in `KAURO_TEST_EVENTS`, never spec text. Red means at least one leaf test failed
its own body (`testCodeFailure`); hook failures, cancellations, load errors, timeouts and runs that executed no test are
INCONCLUSIVE (exit 2). Green at head needs at least one passing leaf test, no failure, and every base-failing test passing
at the same full path (file, all ancestor suite/test names, leaf name), recorded as `baseFailedPaths`. Preparation errors cannot count as a failing test. Added, removed and renamed source
paths are restored correctly; emitted artifacts are cleared before each phase. The caller's worktree and Git metadata are
untouched, including when `.git` is read-only. Temporary clone and worktree cleanup runs on success, errors and handled signals.
Both gates track active runner groups and kill them on SIGINT, SIGTERM, SIGHUP and exit before red-proof removes its
checkout. Unix runners own a detached process group; Windows runners stay attached to Node's kill-on-exit job object
and timeout cleanup uses `taskkill /T /F`.
After a timeout kill, the runner has at most ten seconds to close. A kill error or unconfirmed stop is recorded with
its reason; red-proof returns INCONCLUSIVE and stress-cells fails, without starting another phase or iteration.

Body failures reporting `TypeError` with “is not a function” or “is not a constructor”, `ERR_MODULE_NOT_FOUND`, or
`ECONNREFUSED` are also INCONCLUSIVE (exit 2), with the error recorded as the reason: base may lack an API added by the fix,
an import, or a required service. This classification is conservative, not proof of causality. Residual: other exceptions,
or assertions against missing API/data, can still appear red for a prerequisite failure; review the recorded assertion
and keep regression fixtures and services available in both phases.

The JSON report contains resolved commits, reverted paths, each test's two outcomes and durations in milliseconds, the
first error/assertion line, preparation errors, and a `PASS`/`FAIL` verdict. Exit codes are 0 for PASS, 1 for FAIL and 2 for
INCONCLUSIVE or usage errors. Test arguments are repository files relative to the current directory (absolute paths also work).

Stress cells runs one compiled file in a fresh Node process per iteration, sequentially. It passes the concurrency from
the nearest package's `test` script (Node's default when absent), or the explicit override. An iteration passes only with at least one passing leaf test and no failed, cancelled or
file-level (load/top-level throw) result; TODO-only, skipped-only and suite-only files fail. It writes `stress-cells.json` in the current directory, including every iteration's
outcome, duration, and first error/assertion line. It exits 0 only when all N iterations pass, 1 on failure and 2 for usage
errors. It does not install or build; compile the file first.
