# PV1 route: PV1R-07 r4 root fix design (session authority fenced inside the effect's own transaction)

Finding: `tools/review/out/pv1-route-r4-ac9a2ed0c21a/review.json` PV1R-07 (BLOCKING, family crash, PARTIALLY_FIXED on ac9a2ed). PV1R-02 FIXED.
Governing authority: 08 "Browser, API and cache isolation" (revocation invalidates server-side access immediately); 08 "Database
isolation" (RLS USING and WITH CHECK, FORCE RLS, runtime roles not owners, SECURITY DEFINER only with specific justification); B06
D-EVID-1 (request handlers consume the assurance group's output, never write it); B11 D-AUTH-1 (amended here, §3); ACH-ROUTE §7.3 (I3).

## 1. Defect class (why every "check the holder" patch fails)
The r3 fix judges the session under a row lock held by a SEPARATE transaction on the kauro_assurance pool (`web-sessions.ts:220-253`
`hold`), while the effect commits (or the view is built) in the kauro_app unit of work. The two transactions have independent lifetimes:
1. I3 takes the hold (assurance backend A: `SELECT ... FOR UPDATE`, touch, idle in transaction) and returns a cached record (`service.ts:236`).
2. Backend A dies (terminated, network, failover). PostgreSQL aborts A and releases the row lock; `pool.ts:208` only reports to the sink.
3. Logout takes the row FOR UPDATE and commits `revoked_at`.
4. I3 judges `liveAt` on the cached `revokedAt = null` (`instructions.ts:351`), builds the secret view, its app unit COMMITs.
5. `release()` fails (COMMIT on a dead connection) and `request-authority.ts:46` swallows it: 200 with account, routing and reference.
Same for verify/enable/disable/replace-details (`route-config.ts:233`), I1/I2 (`instructions.ts:166`), getBankRoute (`:498`) and the
shared replay (`runtime.ts:309`). Any liveness check of A before the app COMMIT (a `SELECT 1` on A, `pg_stat_activity`) leaves the window
check -> A dies -> revocation commits -> app COMMIT. The lock and the effect must share one transaction.

Pools, evidence: `apps/api/src/composition.ts:147` builds the assurance pool with `host`, `port` and `database` taken from the runtime
pool's connection (`connection.host/.port/.database`), with its own login only (`config.ts:344`). Both pools hit the same database,
so one transaction can lock the session row and commit the effect.

## 2. Options considered
| Option | Verdict | Failing interleaving / reason |
|---|---|---|
| (A) Session row `FOR SHARE` inside the effect's own kauro_app unit, granted lock-only (column grants + UPDATE policy WITH CHECK false) | **CHOSEN** | none: lock, judgment read, effect and COMMIT are one transaction on one backend; losing the backend aborts all of them; every writer of the row (UPDATE, DELETE, explicit FOR UPDATE, now and future) conflicts with FOR SHARE by PostgreSQL's row-lock table, not by convention |
| (A') same, through a new SECURITY DEFINER `kauro.fence_session(hash, user)` | rejected | correct, but needs a second definer (B07 allowlist `source-migrations.test.ts:482`, `migrations.test.ts`), owner policies TO CURRENT_USER on web_sessions, and an owner that is not minimal (the migration role owns every table); 08 requires justification that (A) removes |
| (B1) two-phase commit: PREPARE the assurance hold and the app unit, COMMIT PREPARED both | rejected | Node dies after `PREPARE TRANSACTION` of the hold and before `COMMIT PREPARED`: the prepared hold keeps the session row FOR UPDATE with no connection, every logout waits to its 5 s bound and fails until a new resolver sweep runs (08: revocation immediate); also `max_prepared_transactions` is 0 by default on RDS (an S-A parameter-group change) |
| (B2) advisory lock: app unit `pg_advisory_xact_lock_shared(k(hash))`, a BEFORE UPDATE trigger on web_sessions takes it exclusive, judgment read on the assurance pool | rejected | correct only while every writer passes the trigger (a DELETE or a new writer bypasses it unless each is added); the judgment state is still read on another connection while the app unit holds its locks (pool coupling, the pattern this finding condemns); 64-bit key collisions block unrelated sessions |
| (C1) check the holder is alive before COMMIT | rejected | check returns alive -> holder dies -> revoke commits -> app COMMIT: effect after revocation |
| (C2) one login that SET ROLEs between kauro_assurance and kauro_app in one transaction | rejected | the request handlers could become the assurance group (08 role separation; B06 D-EVID-1) |
| (C3) SERIALIZABLE for the judge and the revoke, no lock | rejected | app reads live -> logout commits 204 -> app commits; SSI orders the app before the revoke but in real time the effect commits after the logout answered |

## 3. Chosen design
### 3.1 Database (new migration `0047_session_fence.sql`, provisional, renumbered at merge)
```sql
-- kauro_app locks and reads the liveness of the one session its own transaction presents (kauro.session_sha256, set transaction-locally)
-- for the identity it binds (kauro.user_id); it never changes it. PostgreSQL requires UPDATE on one column for SELECT ... FOR SHARE: the
-- grant names session_id, which web_sessions_immutable refuses to change, and the UPDATE policy's WITH CHECK (false) refuses every new row.
CREATE POLICY web_sessions_request_read ON kauro.web_sessions FOR SELECT TO kauro_app
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id());
CREATE POLICY web_sessions_request_lock ON kauro.web_sessions FOR UPDATE TO kauro_app
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id()) WITH CHECK (false);
GRANT SELECT (secret_sha256, user_id, revoked_at, idle_expires_at, absolute_expires_at) ON kauro.web_sessions TO kauro_app;
GRANT UPDATE (session_id) ON kauro.web_sessions TO kauro_app;
```
No function, no SECURITY DEFINER, no table-level grant, no INSERT/DELETE. kauro_app cannot read provider, subject_hash, the verification
instants, last_seen_at or step_up_*; it sees a row only when its transaction presents that row's hash AND binds its person.
B11 D-AUTH-1 "kauro_app has no privilege on it" becomes "kauro_app holds only the lock-only path of 0047 on the session its transaction
presents" (amendment row in `docs/design/B11-agency-app.md`, citing 08 "Browser, API and cache isolation" + this doc). B06 D-EVID-1 holds:
the request handlers consume (read, lock) and never write (WITH CHECK false, immutable column, no column of what a session is).

### 3.2 Fence statement (persistence, same client as the unit)
`PgUnitOfWork` gains `sessionFence` (new `packages/persistence/src/session-fence.ts`, constructed with the unit's `client`):
`lockPresented(secretSha256, userId)` runs (1) `SELECT set_config('kauro.session_sha256', $1, true)` and (2)
`SELECT revoked_at, idle_expires_at, absolute_expires_at FROM kauro.web_sessions WHERE secret_sha256 = $1 AND user_id = $2 FOR SHARE`,
returning the row as locked (READ COMMITTED returns the latest committed version after a wait) or null. The clock is never read in this
statement (rule 16). Accessor `sessionFenceOf(uow)` mirrors `bankRoutesOf` (`unit-of-work.ts:595`).

### 3.3 Application and transport
- Port `SessionFence` (`ports/sessions.ts`): `lockPresented(uow: UnitOfWork, secretSha256, userId) -> {revokedAt, idleExpiresAt, absoluteExpiresAt} | null`.
- `SessionService.hold(secret)` is replaced by `holdIn(uow, secret, userId)`: fence row -> `liveAt(nowMs)` = `isLive` (`service.ts:140`) over the
  locked row. No touch, no release. Deps gain `fence`; composition passes the persistence adapter (`composition.ts:368`).
- `RequestAuthority.hold(uow)`; `judgedUnderHold(authority, uow, clock, between)` (`authority.ts:26,40`). Bearer: re-verified as it stands
  (unchanged, no row). `CredentialHold` keeps `liveAt` only.
- `authenticator.ts` `holdRequest(request, uow)` / `HeldCredential` without `release`; `sessions.ts:104-125` calls `service.holdIn`.
- `request-authority.ts`: no release list, no sink, no per-request cache (a second hold in one unit re-locks in the same transaction:
  PostgreSQL never makes a transaction wait on its own lock); `RequestAuthorityHandle.release` removed.
- Removed: `web-sessions.ts` `hold` + `HeldStoredWebSession`, port `hold` + `HeldWebSession`, `held.release()` at
  `bank-route-routes.ts:111,155,179` and `server.ts:759`.
- Release-failure rule: the release IS the unit's COMMIT, checked at `unit-of-work.ts:487-490`; its failure throws before the handler
  returns, so no byte of the answer is sent. No authority-bearing transaction remains whose end is only logged.

### 3.4 Paths (lock order: access -> journal -> project -> subject -> route -> quote -> session FOR SHARE, LAST, in the app unit)
| Path | Where the fence is taken (same unit) | After it, before COMMIT |
|---|---|---|
| verify/enable/disable/replace-details CMD202-205 | `route-config.ts:233` beforeCommit: `judgedUnderHold(authority, uow, ...)` | proof read + effect clock (plain reads), liveAt, COMMIT |
| I1/I2 issuance CMD028 | `instructions.ts:166` beforeCommit | effect clock + window checks, liveAt, COMMIT |
| I3 read | `instructions.ts:342` `request.authority.hold(uow)` (after the route FOR SHARE :327 and the instructions re-read) | effect clock, judgments, liveAt, view, COMMIT |
| getBankRoute | `route-config.ts:498` | liveAt, COMMIT |
| shared replay (CMD028 + CMD201-205 replays, request-refund, approve-refund) | `runtime.ts:309` | liveAt, stored body returned, COMMIT |
| writers: resume touch, logout/revoke, sign-in replacement, step-up record | kauro_assurance, `FOR UPDATE` first (`web-sessions.ts:184,253,279`) | conflict with FOR SHARE: wait until the effect's COMMIT/ROLLBACK |
Deadlock argument: the session share is the last lock; after it only plain reads (proof, effect clock) and COMMIT, so its holder never
waits. Writers hold no app lock. Invariant (cell LK in H1): no kauro_assurance call of the request after the fence (I3's
`stillAuthenticated` at :325 precedes it). Pool nesting app -> assurance in beforeCommit (r3 fix-proof) disappears.

## 4. Failure-mode matrix (FAILURE-MATRIX-TEMPLATE, 8 columns; cell ids in §5)
| Row (step) | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| F: session fence (FOR SHARE in the app unit) + judgment | C F1, F4 (both orders), S1 | C F5 (fence waits past the unit bound: nothing commits) | C E1 (idle crossed while the fence waits), ADV-1 :2547 | C F2, H1-H6 (holder = effect backend killed; lock and effect die together) | C H7 | C F6 (re-lock in one tx never waits; re-taken after ROLLBACK) | C R1, :2798, F1 | N/A: lock, judgment and effect are one transaction, one checked COMMIT (rule 4); the old hold's separate touch COMMIT no longer exists |
| I3 read | C :2798 / R1 | C F5 | C E1, :2547 | C H1 (before judgment), H2 (before COMMIT) | N/A: a read; the view answered after COMMIT was judged under the lock before any revocation could commit (caveat K1) | C R1 (next request) | C :2798, R1, H1 | N/A read-only |
| getBankRoute | C S1 | C F5 | C :2726 | C H5 (before COMMIT; N/A between lock and judgment: no await between the fence statement and the judgment) | N/A read (K1) | N/A no key | C H5, S1 | N/A read-only |
| CMD202-205 (x4) | C :2874, S1 | C F5 | C PV1R-03 r2 cells (proof expiry at COMMIT) | C H3 x2 positions | C H7 pattern via replay rows (shared runtime.ts) | C ADV-2 r6 :3007 (shared replay) | C :2874, H3 | N/A here (the commands' own L-ROUTE rows) |
| CMD028 I1/I2 | C :2893, S1 | C F5 | C :2616 ADV-3, window cells | C H4 x2 positions | C H7 | C :3007, H6 | C :2893, H4 | N/A here (I2 rows, ACH-M-I2-PARTIAL) |
| shared replay | C :3007 | C F5 | N/A (no deadline judged but the session's, E1 pattern) | C H6 (before COMMIT; N/A between lock and judgment: no await between them) | C H7 | C :3007 | C :3007, H6 | N/A (one read + journal) |
| writers vs fence (resume touch, revoke, step-up) | C :2726, :2981, A r6 :3077 | C T2 (revoke), T3 (resume) past the 5 s bound | C :2994, :3088 | N/A here (B11 writer rows; the writer's abort leaves the session as it was) | N/A here (B11) | N/A here (B11) | N/A (the writer is the revocation) | N/A here (B11: revoke + fact are B11 rows) |
Every money/authority cell is C; no GAP remains open in this design. Tier 1: H1-H7, F1-F4, P1.

## 5. Cells (test-designer writes them first; red expected on ac9a2ed)
Holder discovery (design-neutral, exact): a superuser holder connection (`openHolder`) runs `BEGIN; SET LOCAL lock_timeout='10s';
SELECT 1 FROM kauro.web_sessions WHERE secret_sha256=$1 FOR UPDATE` without awaiting; poll the oracle `SELECT pg_blocking_pids($probe)`
until non-empty; assert exactly one pid; `SELECT pg_terminate_backend($pid)`, wait until gone (as `terminateBackend`,
`packages/persistence/src/testing/faults/points.ts:327`); the probe then gets the row: ROLLBACK, end. Record the holder's
`application_name` and whether `pid === connectionPid(conn client)` (`points.ts:314`).
Pause points: I3 final effect read = first `kauro.effect_now()` statement on `conn` after the route lock statement
`FROM kauro.bank_routes WHERE route_id = $1 FOR SHARE` (`repositories/bank-routes.ts:181`) -- design-neutral arming that replaces
`FINAL_I3_RESUME`; "before the final judgment" in commands = `.after` of the last `kauro.effect_now()` of the unit (nth from a control run's
statement log); "before COMMIT" = `.before` of the `COMMIT` statement on `conn` (fallback: `.after` of that last effect read).
Expected post-fix answer on holder loss: the unit's connection failure; observed and pinned: 500 INTERNAL_ERROR (K2: no SQLSTATE on the
dead socket, so the 57P01 -> CAPACITY_UNAVAILABLE mapping at `sqlstate.ts:174` is not reached). File A = `apps/api/test/ach-route-cells.test.ts`.

| Id | file :: title | Red on ac9a2ed (expected failing assertion) |
|---|---|---|
| H1 | A :: `PV1R-07 r4 DENY ACH-M-I3-REVOCATION (session-lock holder lost during the effect-clock wait): an instructions read held at its final effect-clock read whose session-row lock holder backend is terminated, the session then revoked through the product (committed), never answers secrets: no 2xx, no account or routing digits, no reference; the next request is refused 401; the only lock holder was the read's own unit backend and no authentication-boundary backend was in a transaction` | `the read whose lock holder was lost is not served` actual `200 SUCCESS -` |
| H2 | A :: `PV1R-07 r4 DENY ACH-M-I3-REVOCATION (session-lock holder lost after the view was built, before COMMIT): ...same assertions` | `200 SUCCESS -` |
| H3 | A :: `PV1R-07 r4 DENY ACH-M-R2-REVOCATION (session-lock holder lost ${at}, ${c.name}): the ${c.name} command whose session-lock holder backend is terminated ${at}, the session then revoked through the product, commits nothing: no 2xx, route, version, participant, event and outbox state unchanged, no journal entry; the next request is refused 401` (`at` in {before the final judgment, before COMMIT}; c in AT_COMMIT) | `${c.name}: nothing commits under a lost lock` actual `200 SUCCESS -` (8 cells) |
| H4 | A :: `PV1R-07 r4 DENY ACH-M-I2-REVOCATION (session-lock holder lost ${at}, issuance): ... nothing issued (no order, no instructions, no accepted quote, no event), no journal entry; next issuance 401` | `201 SUCCESS -` (2 cells) |
| H5 | A :: `PV1R-07 r4 DENY ACH-M-R2-REVOCATION (session-lock holder lost before COMMIT, getBankRoute): no 2xx and no route view; next request 401` | `200 SUCCESS -` |
| H6 | A :: `PV1R-07 r4 DENY ACH-M-I2-REVOCATION (session-lock holder lost before COMMIT, CMD028 replay): the replay of a committed issuance key whose session-lock holder backend is terminated before the replay unit's COMMIT, the session then revoked, never returns the stored body (no reference); next request 401` | `201 SUCCESS -` |
| H7 | A :: `PV1R-07 r4 RACE (crash after COMMIT) ACH-M-I2-REVOCATION: an issuance whose COMMIT succeeded under a live session and whose answer was lost (uow.after-commit), replayed with the same key after the session was revoked through the product, is refused 401 without the stored body; replayed by a live session it answers the stored response` | green (regression); red proof = mutation: drop the judgment at `runtime.ts:309` |
| S1 | A :: `PV1R-07 r4 OK (surviving session-lock holder, ${path}): held at the same point without a termination, a revocation started during the hold waits (WAITING) until the effect commits, the effect is served or committed, then the revocation commits and the next request is refused 401` (path in I3, getBankRoute, issuance, verify) | green (control) |
| E1 | A :: `PV1R-02 r4 DENY ACH-M-I3-EXPIRY (idle deadline crossed while the final session fence waits): ...` replaces the :2748 test (holder FOR UPDATE taken when `conn` passes the route lock; `blockedBehind(holder)`; cross; release) | green (repair; `docs/review/pv1-route-test-repairs.md`) |
| R1 | A :: `PV1R-07 r4 DENY ACH-M-I3-REVOCATION (revocation committed before the final session fence): ...` replaces :2827 (revoke committed at the route-lock step instead of the 3rd assurance acquisition) | green (repair) |
| F1-F6, T2, T3 (P2: not a cell; listed in error, none written) | `packages/persistence/test/session-fence.test.ts` (new, temporary Postgres, logins `kauro_app_test`/`kauro_assurance_test`/`postgres`): F1 `RACE PV1R-07 r4 (fence vs revoke started after the lock)`; F2 `RACE PV1R-07 r4 (crash before COMMIT of the fence holder): the effect write and the lock die together; the waiting revoke commits`; F3 `DENY PV1R-07 r4 (lock-only privileges of kauro_app on web_sessions)` (other hash, other user, unbound, UPDATE revoked_at, UPDATE session_id=session_id, SELECT provider, INSERT, DELETE all refused; binding cleared after COMMIT, after ROLLBACK and on pooled reuse); F4 `RACE PV1R-07 r4 (fence waits behind a committing revoke): the row returns revoked`; F5 `RACE PV1R-07 r4 (timeout, fence)`; F6 `RACE PV1R-07 r4 (retry): re-lock in one transaction never waits; re-taken after ROLLBACK`; T2 `RACE PV1R-07 r4 (timeout, revoke behind a fence past 5 s): 57014, session unrevoked, retry revokes`; T3 same for resume | red: `permission denied for table web_sessions` (42501) |
| P1 | `packages/persistence/test/runtime-boundary.test.ts` :: existing N11/B06 title; assertions :53-57 amended to pin kauro_app exactly `{SELECT:[absolute_expires_at, idle_expires_at, revoked_at, secret_sha256, user_id], UPDATE:[session_id]}`, no table privilege, and the two policies | builder-owned (fixture) |
RULE16-SELF-WAIT (:2917) tests `requestAuthorityOf` caching that no longer exists; replaced by F6 (rule 14 repair, recorded).

## 6. Proposed amendment to FAILURE-MATRIX-TEMPLATE rule 16 (append to rule 16)
> **The lock is held by the transaction that commits the effect or builds the view: same connection, same transaction, same lifetime
> (PV1 L-ROUTE Codex r4, PV1R-07).** A lock held by another transaction (another pool, another connection, a hold kept open beside the
> effect) is not a fence: its backend can die while the effect's transaction lives on, the database releases the lock, the revocation
> commits and the effect commits on a judgment of a row no longer held; no liveness check of the other holder closes this (the check and
> the COMMIT are two instants). The authority's state is read by the locking statement in that same transaction, never from a record
> cached by another one. The release is that transaction's COMMIT: a failed COMMIT or release of any authority-bearing transaction fails
> the request before any byte of the answer is sent and is never only logged. When the effect's role holds no privilege on the authority's
> row, grant the narrowest lock-only path (column SELECT of the judged columns, UPDATE on one immutable column, an UPDATE policy WITH
> CHECK (false)) before any SECURITY DEFINER. Cells: the backend holding the lock is terminated between the lock and the judgment and
> between the judgment and the COMMIT, the authority is then revoked and committed, and the effect is released: nothing commits, no
> successful view, the next request is refused; one assertion names the effect's own backend as the only holder (pg_blocking_pids).

## 7. Caveats (decided, each with a cell)
- K1: a view or effect whose COMMIT succeeded before a revocation could commit is answered even if the logout lands while the bytes are in
  flight: it was decided while the revocation waited (08: access invalidated immediately = no decision after the revocation commits;
  08 does not promise remote erasure of downloaded data). Cells :2798, S1.
- K2: holder loss answers 500 INTERNAL_ERROR, not 401 (the transaction carrying the judgment is gone); the acceptance criterion requires no
  effect and no successful view, and the next request is 401. Cells H1-H6 pin exactly 500: a terminated backend surfaces to the unit as a
  connection loss with no SQLSTATE reaching `sqlstate.ts` (57P01 is not delivered on the dead socket), so CAPACITY_UNAVAILABLE (503) is not
  produced. A retry with the same idempotency key settles the outcome: nothing was committed, and after the revocation it is refused (H7).
- K3: concurrent requests of one session: a resume touch waits behind an effect's fence (bounded by the unit; the fence is the last lock).
  Logout/resume past 5 s fail retryable with nothing changed (B11 D-W3-9: the page keeps the CSRF token to retry). Cells T2, T3.
- K4: bearer credentials have no row lock (re-verified as they stand), unchanged from r3 and out of PV1R-07's scope.
- K5: privilege change on an accepted package's table (B11 0025) and B06 boundary matrix: recorded in `pv1-route-touched-B06.md`; F3, P1.

## 8. Accepted-package touches
B06: `runtime-boundary.json`, `runtime-boundary.test.ts:53-59`, `unit-of-work.ts` (PgUnitOfWork.sessionFence + accessor),
`migrations.test.ts` (list +0047). B11: privileges on `kauro.web_sessions` (0047), `web-sessions.ts` (hold removed), `ports/sessions.ts`,
`sessions/service.ts`, `apps/api/src/sessions.ts`, `authenticator.ts`, `B11-agency-app.md` D-AUTH-1 amendment row. B07: none (definer
allowlist unchanged; it must stay green untouched). `composition.ts` is an integration file (Codex doc-review of that commit).

## 9. Context packet: kauro-builder (Sonnet 5.5), after the test-designer commit
Goal: implement §3 in `C:\Projects\Kauro\repos\pw-pv1-route` (branch pv1/route) until H1-H6, F1-F6, T2, T3 turn green and every other
cell of `ach-route-cells.test.ts` stays green. Do not edit `apps/api/test/ach-route-cells.test.ts` or `session-fence.test.ts`.
Files (ac9a2ed lines): migration NEW `packages/persistence/migrations/0047_session_fence.sql` (§3.1 verbatim + header in the 0046 style);
NEW `packages/persistence/src/session-fence.ts` (§3.2); `unit-of-work.ts:150-200` (field), `:595` (accessor pattern), export in
`src/index.ts:31` (drop HeldStoredWebSession); `web-sessions.ts:94-99,220-253` (remove hold); `application/src/ports/sessions.ts:81-86,115-119`
(remove hold/HeldWebSession, add SessionFence) + `ports/index.ts:122`; `sessions/service.ts:70-79,89-105,232-237` (holdIn, deps.fence);
`api/authority.ts:16-49` (hold(uow), judgedUnderHold(authority, uow, clock, between)); callers `instructions.ts:166,342`,
`route-config.ts:229-234,498`, `request/runtime.ts:309`; `apps/api/src/authenticator.ts:27-40`, `sessions.ts:104-125`,
`request-authority.ts` (rewrite: hold(uow), no release/sink/cache), `payments/bank-route-routes.ts:104-112,151-157,172-181`,
`server.ts:546,748-760`, `composition.ts:368` (fence dep). Fixture `packages/persistence/test/fixtures/runtime-boundary.json`
(kauro_app columns + 2 policies), `runtime-boundary.test.ts:53-59` (P1), `migrations.test.ts:71` list. Docs: B11-agency-app.md D-AUTH-1
amendment row; FAILURE-MATRIX-TEMPLATE rule 16 (§6 verbatim); `pv1-route-touched-B06.md` (§8); new `pv1-route-codex-r4-fix-proof.md`.
Done: (1) `pnpm --filter @kauro/persistence --filter @kauro/application --filter @kauro/api run build` clean; (2) persistence:
`node --test --test-name-pattern="PV1R-07 r4|N11/B06|SECURITY DEFINER|0046|0047" dist/test/session-fence.test.js dist/test/runtime-boundary.test.js
dist/test/source-migrations.test.js dist/test/migrations.test.js` green (source-migrations unchanged); (3) api, concurrency 1:
`node --test --test-concurrency=1 --test-name-pattern="PV1R-0|ADV-|RULE16|r6|r7" dist/test/ach-route-cells.test.js` green;
(4) revert proof per rule 3: stash `session-fence.ts` + the `authority.ts` change, rebuild, H1 and H3(verify) red with the recorded
assertion; restore; (5) ci-local Linux green on the merge with origin/main; one commit series, no push. Budget 300k tokens, 180 min
(stop-loss 360 min). Report: sha, cells green/red table, revert-proof text, files touched, open risks (<= 25 lines).

## 10. Context packet: kauro-test-designer (Opus), first, on ac9a2ed
Goal: write §5 cells red on ac9a2ed (src untouched), record the failing assertions in new `docs/review/pv1-route-codex-r4-red.md`.
Owns: `apps/api/test/ach-route-cells.test.ts` (new section after :3150; helper `sessionLockHolder(session)` per §5; design-neutral I3
arming replacing `FINAL_I3_RESUME` in `readHeldAtEffectRead` :2527, `resumeBlockedAcrossIdle` :2698, the :2748 and :2827 tests; delete
RULE16-SELF-WAIT :2917 + its `requestAuthorityOf` import :31), NEW `packages/persistence/test/session-fence.test.ts`,
`docs/review/pv1-route-test-repairs.md` (E1, R1, RULE16-SELF-WAIT -> F6). Harness: `on`/`open`/`openHolder`/`q`/`n` (:84-116),
`heldAtCommitUnder` :2853, `revocationStanding` :2779, `nextRefused` :2789, `withNthSessionTransaction` :2645, `blockedBehind` :2677,
`revokeThroughProduct` :2686, `routeFootprint`, `issuedFootprint`, `NOTHING_ISSUED`, `bw.iw.w.journal(key)`; faults API
`packages/persistence/src/testing/faults/index.ts:10` (`terminateBackend`, `connectionPid`), SqlStep `apps/api/test/fault-support.ts:22`
(label, match, nth, when; points `db.<label>.before|.after`); `startTemporaryPostgres`, `clientConfig(LoginRole)`
(`testing/temporary-postgres.ts:39,48`). Done: H1-H6 red (actual 200/201), F1-F6/T2/T3 red (42501), H7/S1/E1/R1 and all migrated cells
green on ac9a2ed, two consecutive runs; no src change. Budget 150k tokens, 90 min.
