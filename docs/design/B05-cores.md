# B05 plan: integrate MC 3.0.0 + IC 0.6.0 behind the core ports (S045, S046, S047; gate G-MONO)

Planner, 2026-10-06. Base: platform origin/main a7315df; MC v3.0.0 (3b4b0ae, release 404110602, tgz sha256 2686ee65...5312);
IC frozen tree ic/b04-integrate 4fee8d1 (0.6.0, NOT released). Inputs: skill b05-integrate, B05-port-drift.md (corrected in §0).
Authority cited: 07 "Platform topology"; 04 "Architecture and dependency boundary", "Resources"; 06 "Budget algebra",
"Cancellation and deadlines"; reference/HASHING "Hash domain separation", "Version and namespace bridges"; B08 design §10, D8-PORT-1..4.

## 0. Corrections to the port-drift report (each is now a decision or a cell)
1. Canonical JSON is NOT consistent. IC `canonicalJson` sorts keys by UTF-16 unit (`a < b`), skips undefined members, accepts
   lone surrogates and unsafe integers; platform `canonicalize` sorts by code point and rejects all four (HASHING "Hash domain
   separation": the profile rejects invalid Unicode and unsupported numeric ranges). Differs on keys mixing astral chars with
   U+E000..U+FFFF. -> D5-3, tests C01..C03.
2. IC 0.6.0 `LedgerStore` has an async `barrier(runId, length, point)` (BEFORE_DISPATCH, AFTER_RESPONSE, BEFORE_VALIDATION,
   AFTER_RESULT); a refused barrier is the fence. Buffering flushes at barriers, not "around one run()". -> D5-4.
3. IC takes `dispatchAdmission.admit/settle` in MICROS and a gateway that declares its evidence class. -> D5-10, D5-11.
4. A sync ScratchStore cannot cross a process: with MC in a child, `io.scratch` is not handed to the core. -> D5-2.
5. `ExecutionSubject`/`ProfileRequest` carry no source list; the adapter is built per attempt from `AttemptCapability`. -> D5-5.
6. MC refuses HUBSPOT/SALESFORCE without host-supplied attestation authorities; the port has none. -> D5-7.

## 1. Decisions
- **D5-1 Consumption.** Each core is a pinned tarball under `vendor/`: `kauro-migration-core-3.0.0.tgz` (published asset copied
  verbatim, checked against the release SHA256SUMS line, kept as `vendor/SHA256SUMS.mc-3.0.0`) and
  `kauro-intelligence-core-0.6.0.tgz` (PROVISIONAL_UNRELEASED: `npm ci && npm run build` in a clean clone of the frozen sha, `npm
  pack`, refused unless the file list holds `dist/src/index.js`; never `tools/pack.mjs` on an unbuilt tree). `vendor/MANIFEST.json`
  uses IC's KAURO_VENDORED_DEPENDENCY shape (+ `status` RELEASED | PROVISIONAL_UNRELEASED). Wrappers declare exact versions
  (`kauro-migration-core: "3.0.0"`; IC wrapper also `kauro-migration-core: "3.0.0"` for IC's peer); `pnpm-workspace.yaml`
  overrides map both names to `file:vendor/...`; pnpm-lock carries sha512 integrity. `tools/vendor-cores.mjs check [--release]`
  proves sha256 == MANIFEST == SHA256SUMS and lockfile integrity == file sha512, refuses `link:`/`workspace:`/sibling paths,
  and with `--release` refuses PROVISIONAL. Runs first in `verify` and in `clean-consume` (consumer gets the same overrides
  with absolute vendor paths, imports both wrappers and smoke-calls them). No network/credential needed (S045 clean checkout).
  Rule-1 spike first (10 min): pnpm 10.16.1 resolves an override to a `file:` tarball and records integrity.
- **D5-2 MC adapter.** `MigrationCoreAdapter` in `packages/data-plane/src/cores/` (adapter layer: needs node:child_process,
  fs and AttemptScratchStore; application may not import data-plane) implements Execution/Profile/Validate/PackageVerifier
  ports, constructed per attempt `{capability, scratchRoot, clock, pollIntervalMs=1000}`. Execute: (E0) deadline + cancel check,
  create `<scratchRoot>/kauro-core-<attemptId>/{input,output,scratch}` (exists -> refuse); (E1) stream each accepted generation
  to `input/<sha256>`, verify bytes+sha; (E2) spawn the core child with data-plane's `sandboxFlags` (permission model, empty
  env, no network, heap = limits.memoryBudgetBytes) plus an AbortSignal kill (new `core-child-runner.ts`; `runner.ts` untouched);
  the child builds its OWN AttemptScratchStore (quota = scratchBudgetBytes - io.scratch usage - input bytes), runs `runMigration`,
  (E3) `writePackage(output)`, `verifyPackage(output, fresh scratch)`, returns one record {cause, reconciliation, files[{path,
  sha256, bytes}], usage, maxRSS}; parent polls `cancellation.check()` each interval, timer = min(executionDeadlineAt - clock,
  wallClockMs); (E4) re-hash each file vs the child's claim, stage via `writer.open/write/close`, cancel+deadline check
  between artifacts; (E5) remove child dirs; a cleanup failure is residual inventory, never the primary cause (04 "Resources").
  A retry/new worker never restarts the deadline: the subject's `executionDeadlineAt` is the only clock authority.
- **D5-4 IC adapter (provisional).** `IntelligenceCoreAdapter` in `packages/application/src/adapters/cores/intelligence/`
  (in-process: IC is async and cancellable) implements InterpretPort + PlanCompilerPort. Per interpret: seed = `journal.read`;
  `BufferedLedgerStore.append` is sync/in-memory with the core's expectedLength; `barrier` flushes buffered events in order via
  `journal.append(runId, ev, idx)`; LENGTH_MISMATCH -> re-read: same event at idx by canonical digest = landed (crash-after);
  otherwise refused `{ok:false}` and the store is sticky-fenced (no later append/flush); KA080 stale fence -> refused FENCED.
  Cancellation polled -> `core.cancel(runId)`. SYSTEM_DRAFT -> COMPILED only after AFTER_RESULT flushed, a fresh
  `cancellation.check()` CONTINUE and clock < interpretationDeadlineAt ("Version and namespace bridges"; 06 "Cancellation").
- **D5-3 Canonical authority.** The platform profile governs (HASHING). The platform never adopts a core digest: it recomputes;
  disagreement = INTEGRITY_FAILURE. Values crossing IC->platform pass `assertCanonicalAgreement` (wrapper
  `@kauro/intelligence-core`): canonicalize(v) === canonicalJson(v) else refuse (fail closed). IC issue filed for 0.6.x/0.7
  (code-point order, reject lone surrogate/unsafe int); not changed in the frozen campaign subject.
- **D5-5 Input layout.** inputRoot = `<sha256>` per accepted generation (no customer filename); Profile and Execute use the same
  function, so profile file paths equal execution paths (M16). Format comes from the config, not the extension.
- **D5-6 Wrappers.** `@kauro/migration-core`, `@kauro/intelligence-core` (layer core) re-export each core's root API exactly
  (K04 compares export names); raw `kauro-*-core` importable only by its wrapper, at its root (A01).
- **D5-7 Attestation.** The adapter never sets `attestationPolicy` nor invents authorities; CRM modes answer REFUSED until the
  subject carries the attestation (PARTIAL -> B15). CLEAN_ONLY<->CLEAN through one tested enum-only bridge (M14).
- **D5-8 Cause mapping.** quota/ENOSPC -> SCRATCH_EXHAUSTED; short write -> SHORT_WRITE; self-verify fail or parent re-hash
  mismatch -> CORRUPT_INTERMEDIATE; known MigrationError refusal -> REFUSED; source mismatch -> throw AttemptEnvelopeFailure
  SOURCE_INTEGRITY_FAILED; child ERR_ACCESS_DENIED -> OUTSIDE_CAPABILITY; close failure -> ARTIFACT_CLOSE_FAILED; child lost
  without record / OOM -> reject (worker WORKER_ERROR). No non-COMPLETED outcome lists a staged artifact.
- **D5-9 Version strings.** Comments claiming the real core version -> 3.0.0; fake tokens `contract-fake-migration-core-2.0.3`
  unchanged (they name the fake's edition; port unchanged 2.0.3->3.0.0; avoids touching B08 test fixtures).
- **D5-10 Evidence class.** Port evidenceClass EXECUTED_LOCAL (real core in-process/child); the gateway's own class (SIMULATED
  or EXECUTED_PROVIDER) is recorded on the dispatch intent; a test transport is labelled SIMULATED in both places.
- **D5-11 Micros->cents (money, tier 1).** admit reserves ceil(maxChargeMicros/10_000) cents via the audit store's
  createModelTask+beginDispatch; settle posts ceil(charged/10_000); a charge above reservation is liability and blocks new
  dispatch; unknown usage stays reserved (06 "Budget algebra"; D8-GRANT-1/2, D8-AUD-3).

## 2. Case map skeleton
| Case | Class | Proving tests |
|---|---|---|
| S045 | EXECUTED_LOCAL (MC half) / PARTIAL -> L4 pin swap (IC half, provisional pin) | K01..K04, `pnpm run clean-consume` log (Linux+Win legs), M01, T01..T03 real binding |
| S046 | EXECUTED_LOCAL | A01..A04 (+ existing domain->persistence fixture kept) |
| S047 | EXECUTED_LOCAL on provisional IC; PARTIAL -> L4 until the pin is RELEASED | C01..C03 (presealed digests from an independent Python oracle) |
Registry "verification" clause (crash/loss of response) for S045..S047: N/A with reason (build/consume and pure functions; no
durable state); the adapter crash cells live in §3 and are B05 work, not new cases.

## 3. Failure-mode matrix (G:x = GAP closed by test x, written first; T1 = tier 1 money/authority; N/A with reason)
Columns: RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL
**MC-EXEC (ExecutionEnvelopePort.execute)**
- E0 guard+dirs: G:M12 | N/A local mkdir, no port | G:M08 | N/A no durable record; dead worker -> new attemptId (D8-ATT), old dir removeAttemptScratch | same N/A | G:M11 | G:M07 T1 | G:M11 (failed mkdir removes root)
- E1 inputs (SourceReader.open, stream, verify): N/A sealed immutable generations (D8-STG-1), mismatch is M13 | G:M09 | G:M08 | N/A scratch only | N/A scratch only | N/A same attempt refused at E0 | G:M07 T1 | G:M13
- E2 child runMigration: G:M12 | G:M08 (silent child killed at deadline) | G:M08 | G:M02 (core throws mid-run) | N/A no commit; see E3 | G:M11 | G:M06 cancel, G:M07 lease T1 | G:M03 scratch full
- E3 writePackage+verifyPackage (child): N/A child-private output (M12 shows disjoint) | G:M08 | G:M08 | G:M10 (killed after writePackage) | G:M10 (record lost after verify) | G:M11 | G:M06, G:M07 T1 | G:M04 verify fails after write
- E4 stage artifacts (writer close per file): G:M07 (fence held at close k, both orders) T1 | G:M08 (hung close past deadline not listed) | G:M08 | PARTIAL -> B14 (worker dies mid-staging; manifest never written, D8-STG-3) | PARTIAL -> B14 | G:M11 | G:M07 T1 | G:M05 close k fails; G:M04 re-hash mismatch
- E5 cleanup: N/A attempt-owned dir | N/A local rm | N/A after terminal | N/A residue swept (B08) | N/A | N/A | N/A | G:M17
**MC-PROFILE / MC-VALIDATE / MC-VERIFY (same child; read-only over sealed inputs; caller records under its fence, B08)**
- P1/Q1/V1: N/A private dirs | G:M16 (wallClockMs cap) | G:M16 | N/A no durable write | N/A caller's | N/A deterministic, M16 runs twice | G:M16 cancel | V1 G:T01; P1/Q1 N/A single result
**IC-INTERPRET (provisional on IC 0.6.0)**
- J0 journal.read seed: G:I02 | G:I06 | G:I06 | N/A read | N/A read | G:I07 | N/A refusal lands at append (I02) | N/A one read
- J1 buffered append: N/A one sync core run per call | N/A memory | N/A | G:I04 T1 (lost buffer -> nothing sent) | N/A no commit | G:I03 | N/A checked at flush | N/A
- J2 barrier flush (k appends): G:I02 both orders, real PG T1 | G:I06 T1 | G:I06 | G:I03 | G:I03 T1 | G:I03 | G:I02 KA080 T1 | G:I02 k-th refused, prefix stays T1
- J3 admit+send: G:I04 two admissions vs one grant room, both orders (KA083) T1 | G:I08 send ambiguous stays reserved T1 | G:I06 T1 | G:I04 T1 | G:I08 T1 | G:I07 no double reservation T1 | G:I05 T1 | G:I04 task without intent, state named T1
- J3s settle micros->cents: N/A one row per intent under its lock (B08) | G:I08 | N/A settle after send | G:I11 T1 | G:I11 T1 | G:I11 T1 | N/A settle allowed after cancel (06) | G:I11 T1
- J4 outcome map: G:I05 cancel committed between core return and answer T1 | N/A pure | G:I05 | N/A no write | N/A | G:I07 | G:I05 T1 | N/A pure
- J5 compile, planCandidates: N/A pure, no write, no spend (all 8); DENY I09, I10; OK T04

## 4. Tests (exact titles; `<B>` = `ContractFakeMigrationCore` in CPF, `MigrationCoreAdapter` in CPR)
MCA = packages/data-plane/test/cores/migration-core-adapter.test.ts
- M01 "OK S045 (EXECUTED_LOCAL): execute runs vendored kauro-migration-core 3.0.0 in an isolated child over the attempt's accepted generations and stages every package file through the ArtifactWriter with the package's own reconciliation"
- M02 "RACE (core throws mid-run): a MigrationError refusal answers REFUSED with its code, an unclassified throw rejects; neither stages an artifact nor leaves child scratch"
- M03 "RACE (scratch full): a child quota below the run's need answers SCRATCH_EXHAUSTED, the counter never passes the quota and nothing is staged"
- M04 "RACE (partial): verifyPackage refusing the package writePackage wrote, or a parent re-hash mismatch, answers CORRUPT_INTERMEDIATE and opens no artifact"
- M05 "RACE (partial): the k-th artifact close failing rejects ARTIFACT_CLOSE_FAILED; artifacts 1..k-1 stay as staging residue, none is returned and nothing after k is opened"
- M06 "RACE (cancel): CANCELLED during the child run kills it within one poll interval; between two artifacts no further artifact opens; answers CANCELLED"
- M07 "RACE (revocation): FENCED mid-run or held at an artifact close, in both orders, kills the child and writes nothing after the fence; answers FENCED"
- M08 "RACE (expiry): a deadline past at entry answers DEADLINE_EXCEEDED with no child; reached mid-run kills it; reached in staging opens no artifact; a new attempt does not restart it"
- M09 "RACE (timeout): a SourceReader.open that never settles is bounded by the execution deadline and no child starts"
- M10 "RACE (crash after the package is written): the child killed after writePackage, and after verify before its record, rejects with nothing staged and its scratch removed"
- M11 "RACE (retry): a second execute for one attemptId, same or other subject, refuses ATTEMPT_SCRATCH_EXISTS and leaves the first directory untouched"
- M12 "RACE (two attempts): two attempts of one job held mid-run in both orders keep disjoint child directories; the fenced one ends FENCED"
- M13 "DENY input: a generation whose bytes or sha256 differ from the capability rejects SOURCE_INTEGRITY_FAILED before any child starts"
- M14 "DENY attestation: HUBSPOT or SALESFORCE without host attestation answers REFUSED, attestationPolicy is never restated, and CLEAN_ONLY maps to CLEAN only through the bridge"
- M15 "OK isolation: the core child runs under the permission model with the attempt scratch as its only writable directory, an empty environment and no network; peak memory is the child's maxRSS"
- M16 "OK profile, validate, verify: the same child and input layout; profile paths equal execution paths; two runs give equal hashes; cancellation and wallClockMs end each"
- M17 "DENY cleanup: a failed removal is reported as residual inventory and never replaces the primary terminal cause"
CPF = packages/application/test/core-port-contract.fake.test.ts; CPR = packages/data-plane/test/cores/core-port-contract.real.test.ts
(table `packages/application/src/testing/core-port-contract.ts`, bindings supply `provoke.{scratchFull,shortWrite,corrupt}`)
- T01 "<B>: verify checks only the caller's expected authority; a missing, duplicated, extra or foreign artifact and a false summary are each INVALID"
- T02 "<B>: execute reaches only its HostIo and answers SCRATCH_EXHAUSTED, SHORT_WRITE or CORRUPT_INTERMEDIATE for a provoked full scratch, short write or corrupt intermediate"
- T03 "<B>: every record carries the binding's evidence class and names its core version"
- T04 (IC table, CPF-IC/CPR-IC) "<B>: planCandidates plans a complete manifest with no dispatch or spend; interpret compiles a stored response before any new dispatch and never dispatches without a reservation"
ICA = packages/application/test/cores/intelligence-adapter.test.ts; IJR = apps/control/test/b05-interpret-journal.test.ts (real PG, faults harness)
- I01 (ICA) "OK interpret: appends are buffered and made durable at each IC barrier in order, and the journal read back equals the core's ledger"
- I02 (IJR) "RACE (journal fence conflict, both orders): a newer step's append or a stale fence (KA080) refuses the barrier; the landed prefix stays, no intent is reserved after it, outcome FAILED"
- I03 (IJR) "RACE (crash after COMMIT): an append whose commit answer is lost is recognised at its index by canonical digest and not appended twice; another event there is a conflict"
- I04 (IJR) "RACE (money): no send without a durable SEND_STARTED and a reserved intent; two admissions racing for one grant room in both orders reserve at most the ceiling; a refused barrier or admission sends and spends nothing"
- I05 (ICA) "RACE (cancel): cancellation during run cancels the core; a SYSTEM_DRAFT returned after cancellation or past the deadline answers FAILED, never COMPILED"
- I06 (ICA) "RACE (expiry): interpretationDeadlineAt reached mid-run or during a hung append ends FAILED with no further dispatch"
- I07 (IJR) "RACE (retry): a second interpret of the step reads the journal, compiles the stored response first and reserves nothing twice"
- I08 (IJR) "RACE (crash after reservation): an intent reserved but not sent, or sent ambiguously, stays reserved and is never re-sent without the core's recovery rule"
- I09 (ICA) "DENY compile: IC compiler rejections map to MALFORMED_PATCH, UNKNOWN_CANDIDATE, UNKNOWN_FIELD or EFFECT_NOT_PERMITTED"
- I10 (ICA) "DENY digest claims: a core hash the platform profile does not recompute is INTEGRITY_FAILURE, never substituted"
- I11 (IJR) "RACE (money rounding): 1 micro reserves 1 cent, 10000k+1 micros k+1 cents; a charge above the reservation is liability and blocks the next admission; a crash around settle posts it once"
VC = tools/test/vendor-cores.test.mjs; AG = tools/test/architecture-gate.test.mjs; CI = packages/intelligence-core/test/canonical-interop.test.ts
- K01 (VC) "S045 OK: each vendored core's sha256 equals MANIFEST and SHA256SUMS and pnpm-lock integrity equals the file's sha512"
- K02 (VC) "S045 DENY: a tampered tarball, a MANIFEST mismatch, a lockfile integrity mismatch, a sibling file:../ path, link: or workspace: spec each fail with its reason"
- K03 (VC) "S045 DENY: check --release refuses a PROVISIONAL_UNRELEASED pin"
- K04 (VC) "S045 OK: each wrapper's export names equal its core's root exports and the installed core files equal the tarball's"
- A01 (AG) "S046 DENY: a deep import into a raw core or a wrapper, or a raw core imported outside its wrapper, is rejected while the wrapper root import passes"
- A02 (AG) "S046 DENY: ui or web importing a wrapper or raw core is rejected as server-only, and domain importing persistence still fails in the same tree"
- A03 (AG) "S046 DENY: production source importing kauro-intelligence-core/benchmark is rejected"
- A04 (AG) "S046 OK: the checked-in tree with both wrappers and the cores adapter passes, and the same tree with one injected deep core import fails"
- C01 (CI) "S047 OK: Unicode (NFC and NFD distinct, astral, escapes), large integer strings and ordered arrays give identical bytes and sha256 under canonicalize and IC canonicalJson, equal to the presealed digests"
- C02 (CI) "S047 DENY: code-point vs UTF-16 key order, a lone surrogate, an unsafe integer or an undefined member is refused by the platform or by assertCanonicalAgreement; never two silent digests"
- C03 (CI) "S047 OK: structuredDigest(domain, version, payload) recomputed from IC canonicalJson of the same wrapper equals the platform's"

## 5. Lanes (file ownership; branch `b05/<lane>`; worktrees `repos/pw-b05-<lane>`)
| Lane | Files owned | Cells/tests | Done | Est (agent tok, min), model |
|---|---|---|---|---|
| L0 kit (first) | vendor/**, pnpm-workspace.yaml, pnpm-lock.yaml, root package.json, tools/vendor-cores.mjs, tools/test/vendor-cores.test.mjs, tools/clean-consume.mjs, architecture.rules.json, tools/architecture-gate.mjs, tools/test/architecture-gate.test.mjs, packages/migration-core/**, packages/intelligence-core/** (minus L2 files), docs/design/B05-design.md (§0-§1) | K01-K04, A01-A04 | ci-local green; clean-consume green Win+WSL; red-proof per test | TD Opus 120k/40 + builder Sonnet 300k/120 |
| L1 mc-adapter (after L0) | packages/data-plane/src/cores/**, data-plane src/index.ts, package.json, README.md, src/attempt/scratch-store.ts (comment), test/cores/**, test/fixtures/cores/**; application src/testing/core-port-contract.ts, src/testing/cores.ts, test/core-port-contract.fake.test.ts, src/ports/core-ports.ts + testing/contract-fake-migration-core.ts (comments); docs/design/B05-matrix-mc.md | M01-M17, T01-T03 | all MC cells C; adversary PASS; Codex lane review (authority: lease/fence) | TD Opus 180k/60 + Sonnet 450k/200 |
| L2 canon (after L0) | packages/intelligence-core/src/canonical-agreement.ts (+ its index line), test/canonical-interop.test.ts, test/fixtures/canonical-interop.json, tools/canonical-oracle.py | C01-C03 | presealed fixture committed before code; red-proof | TD Opus 60k/25 + Sonnet 100k/45 |
| L3 ic-adapter (after L0; cores.ts line after L1 merges) | packages/application/src/adapters/cores/intelligence/**, application src/index.ts, package.json, test/cores/**, src/testing/core-port-contract-intelligence.ts, test/core-port-contract-intelligence.fake.test.ts; apps/control/test/b05-interpret-journal.test.ts; docs/design/B05-matrix-ic.md | I01-I11, T04 | all IC cells C on provisional pin; Codex lane review (tier-1 money) | TD Opus 180k/60 + Sonnet 400k/180 |
| L4 ic-pin (after IC 0.6.0 release) | vendor/** IC entries, MANIFEST, pnpm-lock.yaml | K01, K03 --release, rerun C*, I*, T04 | vendor-check --release green | Sonnet 40k/30 |
| L5 close (coordinator) | docs/design/B05-case-map.md, tools/test/b05-case-map.test.mjs, docs/acceptance/README.md | case map | full verify CI Win+Linux; Codex close | adversary Opus 150k/45 + Haiku verifier |
Total ~2.1M agent tokens, ~14 agent-hours; wall ~1.5 days with L1 || L2 || L3. Plus Codex: 1 design-time review (this
matrix), lane reviews L1, L3 (tier 1), 1 close. Stop-loss: L1 past 400 min -> split Profile/Validate/Verify into L1b.

## 6. Context packets (each <= 3k tokens; coordinator pastes, agents do not re-read)
- **L0 (TD then builder)**: goal D5-1, D5-6; read `tools/clean-consume.mjs` 1-116, `tools/architecture-gate.mjs` 60-170,
  `architecture.rules.json` 1-30, `tools/test/architecture-gate.test.mjs` 1-80 (fixture helper `pkg`), `repos/ic-b04/vendor/
  MANIFEST.json` (shape); cells K01-K04, A01-A04; harness: none (fixture trees in tmp, as AG does). Done: §5 row.
- **L1**: goal D5-2, D5-5, D5-7, D5-8; read `core-ports.ts` 144-301, `data-plane/src/sandbox/runner.ts` 1-132, `child.ts`
  1-60, `attempt/scratch-store.ts` 44-90 and 159-200, `attempt/failure.ts`, `ports/worker-host.ts` 78-94 and 214-227,
  `test/core-port-fakes.test.ts` 36-240 (helpers + 3 tests to tabulate); MC API: `runMigration(RunInput)` (run-migration.ts
  66-153), `writePackage`, `verifyPackage(dir,{scratch,observe})` (verify-package.ts 424-472), `listPackageFiles`,
  `createFilesystemScratchStore`, `CORE_VERSION`. Harness: data-plane may not import persistence (layer) -> own controlled
  clock + named hold points via an injected `hooks` object (pattern of `faults/points.ts` FaultPoints: pause/arm crash by
  name); child kill points via a test-only env-free payload flag. Cells M01-M17, T01-T03.
- **L2**: goal D5-3; read `contracts/src/canonical.ts` (whole, 199 lines), IC `src/contracts/canonical.ts` 1-66; oracle:
  Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` UTF-8 sha256, run once, digests committed.
- **L3**: goal D5-4, D5-10, D5-11; read `core-ports.ts` 336-400, `persistence/src/audit/journal.ts` 1-33,
  `domain/src/ports/audit-store.ts` ~220-240 (createModelTask, beginDispatch), `apps/control/src/audit/orchestration.ts`
  277-330, `apps/control/test/grant-reconciliation.test.ts` 1-90, `apps/control/test/support/audit-world.ts`; IC:
  `src/kernel/ledger.ts` 101-125, `src/kernel/admission.ts` 60-63, `src/ports/ports.ts` 329-375. Harness:
  `@kauro/persistence/testing` faults (`FaultPoints`, `instrumentPort`, `bothOrders`, `mustWait`, `controlledClock`,
  `faultCell`) in IJR only. Step 1 scout (15 min): how IC run() uses `validationPort` (platform VALIDATE is its own step).

## 7. Waits, blockers, caveats
- Waits on IC 0.6.0 release (AWS account D-14 by 10-12, then B04 paid campaign): L4, S045/S047 IC half -> EXECUTED_LOCAL, L5.
- Waits on B02 ACCEPTED: B05 status stays REVIEW_ACCEPTED after Codex close until B02 (and B04) are ACCEPTED (A6).
- No owner act needed. B14 (worker host) depends on B05 and inherits the E4 crash cells.
- Acceptance touch: L1 edits comments in B08 files (core-ports.ts, contract-fake-migration-core.ts) and data-plane
  scratch-store.ts (B08); run `tools/acceptance-touch.mjs` and list them in the Codex prompt.
- Risk: D5-3 guard fails closed on customer-derived object keys with astral/private-use characters until IC aligns its
  comparator; test C02 shows refusal, not a wrong digest. IC fix is an IC release item, not B05.
- Board fix: B05-ports "files" lists application/src/adapters/cores/** only; MC adapter moves to data-plane (D5-2).
