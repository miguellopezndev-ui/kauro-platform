# B06 evidence bundles

Each directory here is the evidence bundle of one candidate commit on one platform, written by `pnpm run evidence`
(`tools/evidence.mjs`, design decision D-EVIDENCE-1) from a working tree identical to that commit, and committed after the
commit it names. The directory is named `<first 12 hex digits of the commit>-<platform>`.

| file | content |
|---|---|
| `truth.json` | The case map sealed before anything ran: every case row's status, the tests it cites and what a sealed check observes, with the SHA-256 of the file, of the canonical rows and of the observations. |
| `environment.json` | The subject (commit, tree, branch), the node, pnpm and PostgreSQL versions, the operating system, when the truth was sealed and the SHA-256 of `truth.json`. |
| `inputs.json` | The SHA-256 of the lockfile, of every migration, of every registry file, of the OpenAPI document, of the state/command/event matrix and of the case map. |
| `junit/<suite>.xml` | The JUnit report of each test suite, run exactly as its package's `test` script runs it (the tool refuses a drifted script). |
| `results.json` | Each step (the build, then every suite): its command, working directory, exit status, start and end, and its test counts. |
| `cases.json` | Every test each case cites, found by file and name in the reports, with its outcome (PASSED, FAILED, SKIPPED or MISSING), and whether every cited test of the case PASSED. |
| `MANIFEST.sha256` | The SHA-256 of every other file of the bundle; `sha256sum -c MANIFEST.sha256` in the bundle directory checks it. |

`pnpm run evidence` exits 0 only when the build and every suite exit 0 and every cited test of every case PASSED. A bundle is
evidence of the commit it names and of nothing else: a later commit does not borrow it (registry CMD011 verification: "A
failed harness or changed binary cannot borrow a previous green result"). What the bundles prove and what they do not — the
PARTIAL cases, their SIMULATED clauses and owners, and the gates — is stated in `docs/design/B06-case-map.md`.
