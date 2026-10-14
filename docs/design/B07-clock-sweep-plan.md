# CLOCK-SWEEP-B07: deadline judgments on the effect clock (plan, base main 99266f52)

Defect (B15-18 plan rev2, CV-9): `uow.serverInstant()` is `kauro.server_now()` = `transaction_timestamp()` (0009:42-44; persistence
`source/rows.ts:33`, `unit-of-work.ts:434`), fixed when the unit's transaction began. B07 handlers compare deadlines with it after lock
waits, so a deadline that passes while the unit waits is judged on a stale instant. Fix: `effectNowOf(uow)` (domain
`ports/unit-of-work.ts:154`) -> `PgUnitOfWork.effectInstant` (`persistence/src/unit-of-work.ts:318`, inherited by `PgSourceUnitOfWork`) ->
`kauro.effect_now()` (0038:12 = server_now + clock_timestamp() - transaction_timestamp()), rounded UP to the ms, read after the last await.

## 1. Authority first (rule 6)
- R-1 upload deadline. R2 09 "Upload reservation": "Reservation expiry is twenty-four hours from initiation. Polling and browser refresh do
  not extend it." R2 09 "Resumable session security": "The application enforces its shorter twenty-four-hour reservation deadline by
  cancelling the provider session and refusing acceptance after expiry." Predicate (inputs only): refuse iff E >= application_expires_at,
  where E = database effect instant read after the unit's last await before the judgment.
- R-2 reuse window. R2 09 "Retention schedule", row "Unpaid audit sources and derived data": "No later than fourteen days from sealing".
  R2 09 "Quotes, reuploads and retention": "The hard fourteen-day ordinary and thirty-day staged capture caps remain unchanged." and "It
  does not revive expired data". Predicate: a selection/seal that includes bytes is refused iff first_real_seal(bytes) + 1209600 s <= E
  (bytes never sealed: their upload's application_expires_at <= E). Design D-RET-3 (first seal anchors the cap) follows R2.
- R2 does not say which instant judges a command that waited on a lock. Conservative reading, chosen: the later one (E). It can only
  refuse more and never keeps data or takes a byte past a hard cap.
- R-3 backstop. R2 07 "Transaction discipline": "Application checks improve messages but cannot be the sole protection." The DB guards
  backing R-1 and R-2 judge on server_now: 0009:507/:528 (`clock := kauro.server_now()`; `clock >= OLD.application_expires_at`) and 0011:565
  (`first_seal + interval '1209600 seconds' <= NEW.sealed_at`, sealed_at = server_now). **They do NOT cover the stale-instant case.** With the
  old app line kept, both layers accept, so every app cell below is red on the old line. The DB side is lane L2 (sec. 4).

## 2. Clock-source census, measured on 99266f52 (sources folder: `packages/application/src/sources/**`)
Database clock: `uow.serverInstant()` appears 7 times in code plus 2 doc lines (shared.ts:8, :87) = the census's 9. `effectNowOf` appears 0 times.
Process clock (Clock port `runtime.clock`, injected at apps/api/src/composition.ts:systemClock): stamps intake.ts:99, reads.ts:195, :222,
reserve-upload.ts:216, :301, :420; `nowMs()` reserve-upload.ts:158 against `entry.reservedAt`. The journal stamps that value with the same
Clock port (persistence `command-journal.ts:105` `this.clock.now()`), so it is one clock. It is read after the last await (`journal.reserve`
:153). Out of scope, unchanged. Monotonic: provider-holds.ts:35 (CK3 injection point `provider-holds.ts:performance.now`).

| Site | Kind | Judgment line | Decision |
|---|---|---|---|
| S1 complete-upload.ts:49 | JUDGMENT R-1 | :63 | -> `effectNowOf(uow)`, same place |
| S2 reserve-upload.ts:198 (unit 2) | JUDGMENT R-1 | :199, :200 | -> `effectNowOf(uow)`, same place |
| S3 reserve-upload.ts:359 (resume) | JUDGMENT R-1 | :360 | -> `effectNowOf(uow)`, same place |
| S4 seal-revision.ts:249 | JUDGMENT R-2 | :252 | moves after `firstSeals` :250 |
| S5 selection-rules.ts:100 | JUDGMENT R-2 (+R-1 for never-sealed bytes) | :88, :91 | removed; read inside `reuseAvailable` after :87 and after :90 |
| S6 projections.ts:170 | DISPLAY judgment (blocker INTAKE_DEADLINE_PASSED, :197) | :197 | -> `effectNowOf(uow)` (decision D-CS-2) |
| S7 request-deletion.ts:42 | STAMP (port arg `now` of projects.transition; the Pg adapter ignores it, `repositories/workspace.ts:291 _now`) | none | stays `serverInstant`, allowlisted |
Result: 6 judgment sites (5 binding + 1 display), 1 stamp. `shared.ts:8` and `:87` (D-CLOCK-1 doc of `reachedOnServer`) are rewritten:
"every lifecycle instant is the database's transaction time (stamps); a deadline is judged at the effect instant `effectNowOf(uow)`
(kauro.effect_now(), 0038) read after the unit's last await before the judgment, never with `uow.serverInstant()` nor the process clock."
`reachedOnServer` handles 1-6 fractional digits (shared.ts:80-92), so the ms-precision effect instant needs no change.

- D-CS-1: no new KA/KC code. L2 reuses KA072 (sqlstate.ts:126 -> INTEGRITY_FAILURE LIFECYCLE_BINDING_MISSING), so no uniqueness-test change.
- D-CS-2: S6 is display only ("informative, never authority", projections.ts:202-205). It still moves to E. Reasons: one judging clock in
  the folder makes the census exact, and the change is monotone (the blocker can only appear at or after the real deadline). The read is
  already the last expression after the awaits :162-:169, so it stays in place.

## 3. Rule-25 await tables (every await from the unit start to the judgment; L = lock wait)
Common prefix of every B06-pipeline command (packages/application/src/commands/runtime.ts): :246 `authorizer.authorize` (L: the membership's
transition lock, held to unit end, comment :244-245), :250 `journal.reserve` (L: identity unique index), :264 `authorizer.assure`.
ReserveUpload has its own copy (reserve-upload.ts:152 `authorized`, :153 reserve, :163 assure).

- S1 CMD014: prefix -> :41 uploads.get -> :44 revisions.lock (L, FOR NO KEY UPDATE, persistence source/revisions.ts:179) -> :45 uploads.lock
  (L, FOR UPDATE, source/uploads.ts:222) = LAST -> read :49 -> judge :63 -> effect :87 transition. Between :63 and :87 only :70 parse and :74
  digest run, and both are sync: no await (rule 15 holds). Every production writer of the upload locks the revision first (upload-inspection.ts:166-167,
  :250-251; storage-work.ts:249-250, :272-273; upload-deadlines.ts:36-37; cancel-upload.ts:40-41; request-deletion.ts:74/:79;
  create-revision.ts:61/:108). So in production the wait happens at :44, and :45 is the last await but never waits.
- S2 CMD013 unit 2: :194 authorized (L membership) -> :195 revisions.lock (L) -> :196 uploads.lock (L) = LAST -> read :198 -> judge :199-200
  -> :208 sessionSecrets.store (await; an INSERT whose FK KEY SHARE is on the row this unit holds FOR UPDATE: no wait) -> effect :219
  transition session_issued. Rule-15 caveat C-1: one await between the judgment and the effect. Final judgment at the effect statement =
  DB 0009:528, moved to effect_now by L2. Static check pins :208 as the only await between them.
- S3 CMD013 resume: :152-:153 (L) -> grace :158 (process clock, see sec. 2) -> :354 uploads.get -> :356 revisions.lock (L) -> :357 uploads.lock
  (L) = LAST -> read :359 -> judge :360 -> effect :361 claimSessionAttempt. Nothing between the judgment and the effect.
- S4 CMD017 main unit (the hold unit :107 is earlier and separate): prefix -> :117 revisions.lock (L) -> :124 inStates -> :129 selections.get
  -> :130 evaluations.get -> :131 projects.get -> :140 files.lockShared per INCLUDE entry (L: the file's transition lock, D-FILE-1) -> :163
  tables -> :225 inStates -> [old read :249] -> :250 seals.firstSeals = LAST -> NEW read -> judge :252 -> effects :268 seals.insert ... :303
  transition, with awaits between (:268, :277, :279, :280, :290). C-2: the final judgment is the deferred COMMIT trigger 0011:565, moved
  to effect_now by L2.
- S5 CMD016: prefix -> select-input-tables.ts:51 revisions.lock (L) = last lock wait -> :58 inStates -> :60 selections.get -> :67 inventory
  -> :71 checkAgainstInventory: [old read selection-rules.ts:100] -> :101 listForRevision -> :111 files.get (per entry) -> reuseAvailable
  :87 firstSeals = LAST for :88 -> NEW read -> judge :88; or :90 uploads.get = LAST for :91 -> NEW read -> judge :91. Effect
  select-input-tables.ts:76 transition, with awaits between (loop, :133). C-3: the binding is not the retention effect. The seal re-judges
  R-2 (S4 + 0011:565 at COMMIT), so a window that closes after the binding is refused at the seal.
- S6 revisionFacts: :162 projects.get -> :163 agencies.get -> :164 capabilities.get -> :165 inStates -> :166 files -> :167 retention -> :168
  evaluations (when bound) -> :169 inventory (when mutable) = LAST -> read :170 -> judge :197 (view only, no effect).

## 4. Lane cut (by file ownership; no kit needed)
| Lane | Branch | Files owned | Cells | Est. | Model |
|---|---|---|---|---|---|
| L1 CLOCK-SWEEP-B07 | b07/clock-sweep | application/src/sources/handlers/{complete-upload,reserve-upload,seal-revision,selection-rules,projections,shared}.ts; NEW apps/api/test/b07-clock-sweep.test.ts; NEW packages/application/test/sources-clock-census.test.ts | CS-1P..CS-6, CS-C | test-designer 90k tok / 60 min (Opus); builder 30k / 20 min (claude-sonnet-5-5) |
| L2 FCG-B07-DEADLINES | fix/clock-gates-b07 | NEW persistence/migrations/0072_b07_deadlines_at_effect.sql (provisional; tools/renumber-migration.mjs at batch); NEW persistence/test/b07-deadlines-at-effect.test.ts; persistence/test/b05-clock-gates.test.ts `ownerOfFile` (one line: tag -> "B07") | CS-7, CS-7-OK, CS-8, CS-8-OK | 40k / 30 min (Opus design+tests), 20k / 15 min builder |
L1 and L2 share no file. They can run in parallel and land in the same batch. clock-gates.json is a generated file: the coordinator
regenerates it at the batch (KAURO_CLOCK_GATES=write). The `ownerOfFile` line conflicts with FCG-B06-LEASE-1 if both run at once, so the
coordinator serializes that one line. L2 body: in `upload_sessions_window_clock` the acceptance edge (0009:528) becomes `kauro.effect_now()
>= OLD.application_expires_at`. Stamps stay `clock` (= server_now). The EXPIRED edge 0009:531 stays on `clock`: CHECK 0009:464 needs
expired_at (= server_now) >= application_expires_at, so expiry must stay on transaction time (monotone). In `dataset_revisions_sealed_subject`
(0011:565) the refusal becomes `first_seal + interval '1209600 seconds' <= kauro.effect_now()`, read at the deferred COMMIT. effect_now
>= sealed_at always, so this subsumes the old predicate. The record-anchor check 0011:568-575 is unchanged. Both are CREATE OR REPLACE.
Done L1: every cell red on 99266f52 with red-proof (`node tools/red-proof.mjs`, failing assertion text recorded) and green on head;
the census test green and its plants red; the cmd013/014/016/017/042 api tests and source-reads green; acceptance-touch run (B07 files).
Done L2: CS-7/CS-8 red on base and green on head; persistence migrations test and b05-clock-gates green after regeneration;
apps/control upload-inspection and upload-deadlines tests green (impact: an admission whose effect clock passed the deadline now gets KA072).

## 5. Failure-mode matrix (rows the lane touches; only EXPIRY changes)
"keep" = not changed by this lane (clock source only); the existing cells in that row's test file stay, and rule 14 applies to any repair.
| Row | RACE | TIMEOUT | EXPIRY | CRASH-B | CRASH-A | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| CMD014 completion (S1) | keep cmd014 RACE | N/A no port in unit | GAP->CS-1P, CS-1L | keep | keep | keep | keep (prefix lock, runtime.ts:244) | keep |
| CMD013 unit 2 (S2) | keep cmd013 RACE | keep (PROVIDER_CALL_TIMEOUT_MS outside unit) | GAP->CS-2P, CS-2L | keep | keep | keep | keep | keep |
| CMD013 resume (S3) | keep | N/A | GAP->CS-3P | keep | keep | keep (resume test cmd013:157) | keep | keep |
| CMD017 seal (S4) | keep cmd017 :501 | keep | GAP->CS-4P, CS-4L | keep | keep | keep | keep | keep |
| CMD016 selection (S5) | keep | N/A | GAP->CS-5a, CS-5b | keep | keep | keep | keep | keep |
| revision view (S6) | N/A read | N/A | GAP->CS-6 (+OK sibling) | N/A | N/A | N/A | N/A | N/A |
| DB 0009:528 edge (L2) | N/A one statement | N/A | GAP->CS-7 (+OK) | N/A rule 4 | N/A | N/A | N/A | N/A rule 4 |
| DB 0011:565 at COMMIT (L2) | N/A | N/A | GAP->CS-8 (+OK) | N/A | N/A | N/A | N/A | N/A |
Tier: R-1 decides whether bytes are accepted (an authority over customer data); R-2 decides retention past a hard cap (rights). Every
EXPIRY GAP above is tier 1 (rule 9). Rule 16 is N/A: the deadline is a stored row fact, not a revocable authority. The judge already
holds the row lock (FOR UPDATE/NO KEY UPDATE) and keeps it to COMMIT. Rule 13/21: no lock is added or moved.

## 6. Cells (all EXECUTED_LOCAL, temporary PG clusters; file apps/api/test/b07-clock-sweep.test.ts unless noted)
Mechanism (no support.ts edit): a per-file World made with `wrapUnitOfWork` (support.ts:545, precedent cmd060-request-retention-extension.test.ts:20-57).
The wrapper proxies one store method of the target unit. For lock legs it proxies `revisions.lock`/`uploads.lock`: before calling the inner
method it places the unit's effect clock EFFECT_CLOCK_MARGIN_MS (500 ms) before the deadline on that unit's own client (local copy of
b10-cells-support.ts:230 `effectClockBefore`: set_config offset from the transaction's elapsed time). The test then runs
`crossedWhileWaiting`-style probes from the oracle (b10-cells-support.ts:244-268: began_before, waiting on the holder, remaining <= margin,
then past) and only then releases the holder. For pause legs it proxies the LAST await's method: after the inner call returns it places the
clock 500 ms before, asserts `kauro.server_now() < deadline` on the same client, polls `kauro.effect_now() >= deadline` on that client
(it is idle at the pause), then returns. The offset stays fixed while the wall clock crosses. So the transaction time (old line) stays
before the deadline and E is past it: the old line accepts (red), the new line refuses.
Holders: production = `heldAdmission` (source-support.ts:421; UPLOAD_INSPECTION's decision unit, revision row then upload, mirrors
upload-inspection.ts:351-352 -> :250-251) or `retentionSweeper` (writers.ts:72) taking `revisions.lock` as retention.ts:128 does.
Placement holder = `tenantWriter` running `LOCKS.upload ... FOR UPDATE` (source-support.ts:97; not a production writer, rule-25 leg only).
Observation: `waitForWriterLockWait` / `waitForLockWait(oracle, applicationName, LOCKS.revision|LOCKS.upload)`.
Meeting point (rule 24): request vs UPLOAD_INSPECTION / retention sweeper = the dataset_revisions row of R (NO KEY UPDATE x NO KEY UPDATE).
The control actor takes no membership lock or journal index. Removing the holder's revision lock makes the request never wait (cell
asserts "waiting" first, so it fails loudly).
- CS-1P (R2-051, CMD014-RACE) "EXPIRY: CompleteUpload waiting on the revision row held by UPLOAD_INSPECTION of a sibling upload while its
  deadline passes on the database clock -> 409 RESERVATION_EXPIRED, upload UPLOADING at its version, no completion_reported event". Red
  on base: 202 ACCEPTED, state VERIFYING (both layers judged at transaction time).
- CS-1L "EXPIRY: CompleteUpload paused at its last await (the upload row lock) across the deadline -> 409 RESERVATION_EXPIRED". Red: 202.
- CS-2P (CMD013-RACE) "EXPIRY: ReserveUpload's issuance unit waiting on the revision row while the reservation deadline passes -> the
  attempt is abandoned: upload RESERVED, no session secret, no session_issued event, the provider session cancelled (fake), journal
  committed, reply 201 with delivery UNAVAILABLE SESSION_PENDING". The wrapper gates on the request's 2nd source unit and reads the
  deadline on that unit's connection. Red: upload UPLOADING with a secret.
- CS-2L same, paused at uploads.lock :196 (placement holder). Red: UPLOADING.
- CS-3P "EXPIRY: a resumed ReserveUpload (pending past PENDING_RESUME_GRACE_SECONDS, w.processClock.advance as cmd013:197) waiting on the
  revision row while the deadline passes -> no new session attempt (session_attempt unchanged), no provider session created, journal
  committed with the RESERVED view". Red: a new attempt is claimed and the session issued.
- CS-4P (CMD017-RACE) "EXPIRY: SealRevision of reused bytes waiting on the revision row held by the retention sweeper while the first
  seal's fourteen days pass -> 409 REUSE_NOT_AVAILABLE, no sealed manifest, revision READY_TO_SEAL, its holds REFUSED". Fixture: the
  reuseReadyAt setup (source-support.ts:766); the request unit's clock placed 500 ms before first.sealedAt + 1209600 s. Red: 200 SEALED.
- CS-4L same, paused after `seals.firstSeals` :250 returns. Red: 200.
- CS-5a (CMD016-RACE) "EXPIRY: SelectInputTables including a reused file, paused after firstSeals while the first seal's fourteen days
  pass -> 409 REUSE_NOT_AVAILABLE, revision unchanged, no selection_changed event". Red: 200 bound.
- CS-5b "EXPIRY: SelectInputTables including never-sealed reused bytes, paused after the origin upload read while its intake deadline
  passes -> 409 REUSE_NOT_AVAILABLE". Red: 200.
- CS-6 "EXPIRY: GetRevision of an UPLOADING revision whose every upload is UPLOADING, paused after the inventory read while the deadlines
  pass -> blockers include INTAKE_DEADLINE_PASSED" plus OK sibling "... read before the deadline -> no INTAKE_DEADLINE_PASSED". No test
  asserts this blocker today (grep: 0 hits in apps/api/test, packages/application/test). Red: blocker absent.
- CS-C (packages/application/test/sources-clock-census.test.ts) "DENY clock census (sources): uow.serverInstant( only at
  request-deletion.ts:42; every reachedOnServer( reads an instant from effectNowOf in the same function; process clocks only at the listed
  stamps; between each judgment and its effect only the declared awaits (S1/S3 none, S2 [:208], S4/S5 listed)". Plants: a copy of
  complete-upload.ts with `await uow.serverInstant()` fails; a copy with an await planted between :63 and :87 fails (rule 25 static).
- L2 (packages/persistence/test/b07-deadlines-at-effect.test.ts, direct SQL on the request role): CS-7 "DENY: UPLOADING -> VERIFYING in a
  transaction whose server_now precedes the deadline and whose effect_now is past it -> KA072" (red on 0009:528); CS-7-OK "... effect_now
  before -> applied"; plus "EXPIRED edge unchanged: refused while server_now < deadline". CS-8 "DENY: a seal whose sealed_at precedes
  first_seal + 14 d and whose COMMIT effect_now is past it -> KA072 at COMMIT"; CS-8-OK "... before -> commits".
Rule 24c: with L2 merged, reverting only the L1 line makes CS-1P/2P/4P answer 500 INTEGRITY_FAILURE (KA072) instead of 409. They stay red
because they assert the exact 409 reason. CS-7/CS-8 are the DB guard's own controls.

## 7. Impact inventory (grep on 99266f52)
- Fixtures that read serverInstant for stamps, unaffected: source-support.ts:311, :351, :552, :729, :831. cmd042:223, cmd060:261 (NOT_DUE
  probes). B10 tests (statements-support, b10-correction-*) are another package.
- The in-memory UnitOfWork has `effectInstant` (application/src/testing/in-memory-ports.ts:290-292). No in-memory source uow test reaches
  these handlers.
- Existing deadline tests stay green: cmd014:104-146 (past deadline by 25 h), cmd017:139-166 and :373-379 (REUSE_NOT_AVAILABLE by 15 d).
  E is later than transaction time, so every refusal they assert still holds.
- L2: apps/control UPLOAD_INSPECTION admission (an ADMITTED edge on 0009:528) and upload-deadlines (stays on server_now,
  upload-deadlines.ts:39-40). The test-designer greps apps/control/test for admissions near a deadline.

## 8. Caveats and decisions (none left to the reviewer)
- C-1/C-2/C-3: awaits between the judgment and the effect at S2/S4/S5 (sec. 3). Each is closed by the final judgment at the effect statement
  or at COMMIT (L2), or by the seal (S5). CS-C pins the exact await list.
- C-4 boundary: the app instant is rounded UP to the ms (unit-of-work.ts:313-322). The DB judges at a later statement. If the deadline falls
  between the two, the DB raises KA072 -> 500 INTEGRITY_FAILURE instead of 409. This fails closed with no effect (tier 3). Decision: accept
  and document. CS-7 proves nothing commits.
- C-5: reserve-upload.ts:158 grace stays on the Clock port. Both sides are the same clock (sec. 2); it is not a deadline of R-1/R-2.
- C-6: the upload row lock is FOR UPDATE (uploads.ts:222), against rule 11a. Not this lane (no lock change). It is routed to LOCK-NOKEY-P1's sweep.

## 9. Deferred (FCG-B07 remainder; on main, not a moving interface; recorded, not designed here)
Binding requirement for each: a deadline judged at kauro.effect_now() after the last lock wait, with an EXPIRY cell red on the old body.
0009:969 session-secret read policy `application_expires_at > kauro.server_now()` (a bearer credential could be delivered up to one
transaction's duration late; acceptance stays refused by S1/0009:528. Tier 1 under rule 9, conservative). 0010:318 (not analysed by this
plan; clock-gates.json OUTSIDE_B05). The 0009:726-740 and 0012:18 primitives (B05-cores.md:642-645). 0011:488/:495 retention_expires edges
and upload-deadlines.ts:39 stay on server_now (an early instant only delays expiry: MONOTONE_REFUSAL), recorded in the regenerated clock-gates.

## 10. Context packets
TEST-DESIGNER (Opus, worktree C:\Projects\Kauro\repos\b07-clock-sweep, branch b07/clock-sweep; budget 90k tok / 60 min):
Goal: write CS-1P..CS-6 (+OK) in NEW apps/api/test/b07-clock-sweep.test.ts and CS-C in NEW packages/application/test/sources-clock-census.test.ts.
They must fail on 99266f52 for the stated reason. Read only: this plan sec. 3, 6; apps/api/test/support.ts:120-160, :239-252, :545, :678-679;
source-support.ts:97-103, :222-260, :384-437, :660-716, :766-800; writers.ts:10-100; b10-cells-support.ts:185-268 (copy logic, no import of
b10 world binding); cmd060-request-retention-extension.test.ts:20-60; cmd013-reserve-upload.test.ts:157-205; cmd014-complete-upload.test.ts:104-150;
cmd017-seal-revision.test.ts:139-170, :490-510; persistence/src/testing/faults/bounds.ts (EFFECT_CLOCK_MARGIN_MS, LOCK_WAIT_*). Harness API:
@kauro/persistence/testing {waitForLockWait, clockAt, EFFECT_CLOCK_MARGIN_MS, openConnection, connectionPid}. Never sleep longer than the
remainder the DB reports (<= margin). Every cell asserts "waiting on the holder" before the crossing. Report: titles, red assertion text per cell.
BUILDER (claude-sonnet-5-5, same worktree, after the tests; budget 30k / 20 min): replace S1 :49, S2 :198, S3 :359 by `await effectNowOf(uow)`
(import from @kauro/domain). Move S4 to after :250. Delete S5 :100 and the `serverNow` parameter; read inside reuseAvailable after :87 and
:90. S6 :170 -> effectNowOf. Rewrite shared.ts:8 and :87-88 docs (text in sec. 2). S7 unchanged. Done: the new tests green; cmd013/014/015/016/017/042,
source-reads, source-role-matrix green (focused, through run-heavy); red-proof on base 99266f52; no other file touched.
L2 packet: written by the coordinator from sec. 4 + 6 (CS-7/8) when the lane opens. Migration number provisional; renumber at batch.
