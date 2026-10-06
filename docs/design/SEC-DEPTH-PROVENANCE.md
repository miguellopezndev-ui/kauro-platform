# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix)

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex review p0-admission-r2 (on
0217109) findings 1-3 and the analogue in 0015. Design only; no product code. All line refs are on 21b310f.

## 0. Facts established from the code

- F1 Ten guards treat `pg_trigger_depth() >= 2` as "written by our own trigger": 0002:143 (active_owner_count), 0015:98
  (allocated_cents), 0021:466 (job attempt_count/current_attempt_id/fence), 0023:158 (grant reservations), 0023:453 (audit fence),
  0028:117, 0028:261, 0028:447, 0028:472 (commercial transitions, founding consumption, recurrence, qualifying purchases), 0044:73/96
  (already bound to `server_now()` + an admission fact).
- F2 Depth is forgeable today because every runtime login can create session objects: PUBLIC keeps the default `TEMPORARY` on the
  database (no REVOKE anywhere in migrations/; 0001:41 revokes only `ON SCHEMA kauro`). Proven by our own tests run as runtime roles:
  admission-instants.test.ts:220-242 (pg_temp trigger function + temp table, as kauro_control), :276 (temp table + kauro guard as
  constraint trigger), aggregate-kinds.test.ts:460-464 (temp shadow tables, as kauro_app), fault-harness.test.ts:1237 (pg_temp SQL
  function, as kauro_control_test).
- F3 No other depth-2 path exists for a runtime role: no FK has ON DELETE/UPDATE actions (grep `ON DELETE CASCADE|SET` in
  migrations: 0 hits), no TRIGGER/ALL grant to a runtime role (0 hits), no CREATE on any schema (0001:41/73, 0013:45, 0028:41 grant
  USAGE only; PG 17 `public` has no PUBLIC CREATE, verify.yml:24/71). So removing TEMPORARY makes depth real provenance.
- F4 Finding 1 has a second path that needs no temp object: kauro_control holds `DELETE` on leases (0006:374, policy 0006:366 USING
  true) and leases have no INSERT guard (0006:202-229 is BEFORE UPDATE only). Delete the JOB_ATTEMPT lease, insert it at fence
  9223372036854775807 for a new attempt, then a legitimate claim (0021:612-638 `attempt_owns_lease`, 0021:265-279 checks no expiry)
  makes the real bookkeeping trigger (0021:686) copy that fence to the job. `jobRecord` (src/execution/rows.ts:135 `int(r.fence)`,
  src/sql.ts:73-79 `Number.isSafeInteger`) then throws for every reader. A alone does NOT close finding 1.
- F5 Finding 3 needs no nesting at all: kauro_control may `UPDATE kauro.leases` directly; the takeover check compares
  `NEW.heartbeat_at < OLD.expires_at` (0006:213) and the caller writes `heartbeat_at`. claim/heartbeat/checkpoint take `p_now`
  (0006:239-320). journals-leases.test.ts:345-353 performs exactly such takeovers with caller instants.
- F6 Finding 2: kauro_app has `UPDATE(reserved_cents)` (0023:1043) because the carve hold (0023:212-227) runs as invoker;
  `cost_grants_tenant_pool_hold` (0023:940-942) admits every AUTHORIZED pool. kauro_control moves reservations at depth 1 by design
  ("or the control plane's reconciliation", 0023:154-160; src/audit/store.ts:595).
- F7 0015:98: kauro_payment holds `UPDATE(allocated_cents)` (0015:909); the guard checks only depth and monotonicity, the cap CHECK
  (0015:74) bounds it. The single legit writer is `capture_facts_allocate` (0015:420-452).
- F8 Role model: test cluster creates the database `OWNER` = migrator (temporary-postgres.ts:150-151), runtime logins are created
  after migrations (:165-171); the pool refuses superuser/BYPASSRLS/CREATEROLE/CREATEDB/db-owner logins (src/pool.ts:100-105,
  178-186) but not TEMPORARY. A9_CLOUD_AWS (authority r2): Aurora PostgreSQL Serverless v2 + Data API, fallback RDS PostgreSQL 17.

## A. Root cause decision: no runtime role can create a session object (D-PROV-1)

Decision: migration `0045_runtime_no_session_objects.sql` (run by the migrator, which owns the database):
1. `EXECUTE format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', current_database())`, and the same FROM each runtime group
   (kauro_app, kauro_control, kauro_assurance, kauro_validator, kauro_ingress, kauro_payment, kauro_commission).
2. `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (no-op on PG 15+, protects a restore into an older default).
3. Post-condition DO block (REVOKE by a non-owner only WARNs, it does not fail): for every runtime group,
   `has_database_privilege(g, current_database(), 'TEMPORARY')`, `... 'CREATE'` and any `has_schema_privilege(g, n.oid, 'CREATE')`
   over pg_namespace must be false, else RAISE (migration aborts). This is what makes RDS/Aurora safe when the database owner is not
   the migrator: the deploy fails loudly instead of running unprotected.
4. Pool verification (src/pool.ts VERIFY_SQL :100-105, refusal :178-186) adds three columns and refuses a login that has TEMPORARY on
   the database, CREATE on the database, or CREATE on any schema (`PrivilegedRoleError`, same path as CREATEDB). Catches a login
   granted directly (PUBLIC revoke does not remove a direct grant).
5. Not chosen: revoking `USAGE ON LANGUAGE plpgsql`. With no schema to create in, a function cannot be created; revoking it would
   also break DO blocks that the harness self-test uses as kauro_control (fault-harness.test.ts:1230, :1246) for no extra safety.
6. Not chosen: SECURITY DEFINER provenance roles. Owner-defined functions are still bound by FORCE RLS (0001:28) and an extra role
   multiplies the role model; facts (section B) plus D-PROV-1 suffice.

Deployment (B14): provisioning creates the database `OWNER <migrator>` (as temporary-postgres.ts:151 does). Aurora Data API
connections do not pass our pool's verification, so item 3 is the guarantee there. No owner decision needed; a B14 note.

### Tests that create session objects as a runtime role (must change; assertion kept, not weakened)

| Test (file:line) | What it proves today | Change |
|---|---|---|
| admission-instants.test.ts:218-250 (4 nested writes, KA082) | 0044 guards bind to server_now()+admission even at depth 2 | Split: (a) NEW "DENY SEC-DEPTH ... cannot create" proves creation is 42501; (b) the KA082 assertions stay, the nested write now runs through the kit's `nestedAs(role, sql)` (oracle-made invoker function + table in schema `depth_probe`, INSERT granted to the runtime group) so the guard is still proven at depth 2 as kauro_control |
| admission-instants.test.ts:266-286 (KA081, temp LIKE table + constraint trigger) | the consumption guard refuses evidence from another transaction | the probe table is created by the oracle in `depth_probe` with the same deferred constraint trigger; INSERT stays as kauro_control. Same assertion, same role |
| aggregate-kinds.test.ts:445-470 part (1) | bind functions ignore pg_temp shadows (pinned search_path) | (1a) NEW assertion: CREATE TEMP TABLE as kauro_app is 42501; (1b) keep the shadow probes on a direct client after the superuser grants `TEMPORARY` to that one test login inside a try/finally (revoked after). Proves the pin still holds should TEMPORARY ever reappear. Part (2) and the catalog assert (:491-497) unchanged |
| fault-harness.test.ts:1232-1239 (FH-R2 r6, function-body undo) | a clock undo hidden in a function body is detected | the function is created by the oracle as `fault_probe.fault_undo_clock()` (schema already exists, :46-48), EXECUTE granted to kauro_control_test; `set_config(..., true)` stays transaction-local to the caller. Same title, same expectation |
| b10-failure-cells-conversion.test.ts:50-69 | owner-created kauro triggers | unaffected (not a runtime role) |

## B. Defence in depth: each value bound to the fact that produces it

B1 processing_jobs (D-PROV-2), `0046_job_fence_provenance.sql`, faithful copy of `processing_jobs_workflow` (0021:418-528) with
only the 0021:465-468 block replaced:
- attempt_count/current_attempt_id change: require depth >= 2 AND `NEW.attempt_count = OLD.attempt_count + 1` AND EXISTS attempt
  (agency, job, attempt_id = NEW.current_attempt_id, ordinal = NEW.attempt_count, created_at = kauro.server_now()).
- fence change: require depth >= 2 AND `NEW.current_attempt_id = OLD.current_attempt_id` AND `NEW.fence > OLD.fence` AND EXISTS
  attempt (attempt_id = NEW.current_attempt_id, state 'CLAIMED', fence = NEW.fence, claimed_at = kauro.server_now()) AND
  `kauro.attempt_owns_lease(job, attempt, NEW.fence)`. KA080, same message.
- CHECK `fence <= 9007199254740991` and `attempt_count <= 9007199254740991` on processing_jobs, `fence <= 9007199254740991` on
  processing_attempts and leases (ADD ... NOT VALID; VALIDATE). The reader can then never throw on a stored row; jobRecord stays
  fail-closed (no tolerant parse).
B2 leases (D-PROV-3), `0047_lease_server_clock.sql` (also closes F4):
- `leases_guard` becomes BEFORE INSERT OR UPDATE OR DELETE. INSERT: fence = 1; heartbeat_at, created_at, updated_at :=
  kauro.server_now(); expires_at > heartbeat_at. UPDATE: if heartbeat_at, expires_at, owner or fence change then
  `NEW.heartbeat_at = kauro.server_now()` (refuse otherwise, KA005 'LEASE_CLOCK'); a renewal (same owner+fence) needs
  `OLD.expires_at > server_now()`; a takeover needs `OLD.expires_at <= server_now()` (replaces 0006:213), fence + 1 and the
  checkpoint rules unchanged (0006:216-224). DELETE: refused (KA005); `REVOKE DELETE ON kauro.leases FROM kauro_control` (no caller:
  grep `DELETE FROM kauro.leases` = 0 hits).
- claim_lease / heartbeat_lease / checkpoint_lease: DROP the `p_now` signatures, CREATE without it, every instant =
  kauro.server_now(). Callers: src/lease-store.ts:75/91/96 (PgLeaseStore ignores the port's `now`; the port keeps it this lane, see
  Q2), src/audit/store.ts:488, src/execution/store.ts:456/620 (drop the trailing `kauro.server_now()` arg). Governing rule: the
  EXPIRY column of FAILURE-MATRIX-TEMPLATE ("the database clock decides") and B07 D-CLOCK-1 (temporary-postgres.ts:103-109).
B3 cost_grants (D-PROV-4), `0048_grant_reservation_provenance.sql`, faithful copy of `cost_grants_workflow` (0023:125-205) with the
0023:155-160 block replaced. For a non-control session a reservation change must be explained by a fact of this transaction:
- increase on a PLATFORM_MONTHLY pool: depth >= 2 AND `NEW.reconciled_spend_cents = OLD.reconciled_spend_cents` AND EXISTS an AUDIT
  carve c (pool_grant_id = pool, state 'AUTHORIZED', authorized_at = server_now(), agency = current agency) with
  `NEW.reserved_cents - OLD.reserved_cents = c.ceiling_cents`;
- decrease: EXISTS a carve CLOSED with closed_at = server_now() and delta = -c.ceiling_cents and spend delta = c.reconciled_spend_cents;
- otherwise KA083. Control path (depth 1) unchanged by decision of 0023:154; see Q1.
- Residual R-GRANT-1 (tier 1): a nested writer could re-apply one real carve's delta twice in its transaction. Only D-PROV-1 closes
  it (every marker the legit nested path can write, a nested attacker can write too). Proven by T1; recorded, not deferred.
B4 payment_orders (D-PROV-5), `0049_allocation_recount.sql`: `payment_orders_allocation_writer` (0015:91-106) also requires
`NEW.allocated_cents = Σ(allocated_service_cents + allocated_tax_cents)` of the order's capture_facts with status IN
('COMPLETED','REVERSED') (visible to kauro_payment, policy 0015:875). Equality to a recount: no repetition residual.
B5 Catalog gate (D-PROV-6): a test lists every kauro function whose `prosrc` contains `pg_trigger_depth` and asserts the set equals
`SEC-DEPTH` allowlist in the test, each entry naming its binding (fact or D-PROV-1 only). A new depth guard fails the gate.
Hardening wave (lane L3, same rule): 0002:143 active_owner_count = recount of ACTIVE OWNER memberships (authority, S050/R2-043);
0028:447 agency_recurrence confirmation_count = recount of qualifying_purchases (money). 0023:453, 0028:117/261/472 are D-PROV-1 only.

## C. Failure matrix (8 columns; cells C / GAP / N/A). Proposed tests: S = `packages/persistence/test/sec-depth-provenance.test.ts`

Shared N/A reason "guard": the change is a check inside the caller's statement; it adds no write, no COMMIT and no port call, so
CRASH-BEFORE/CRASH-AFTER/RETRY/TIMEOUT are those of the calling command, whose own rows stand unchanged (B08 S056, B06 S090, B09
R2-140 matrices); a refusal rolls back the caller's statement (rule 4: a guard is no PARTIAL test, so PARTIAL is N/A + DENY).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 release 0045 + pool verify | N/A: DDL under the migrator's advisory lock | N/A: no lock wait beyond the migration's | N/A | GAP SEC-01: 0045 fails post-condition -> whole migration rolls back, ledger unchanged; S :: "DENY SEC-DEPTH (release): 0045 aborts and records nothing when a runtime group keeps TEMPORARY" | N/A: re-run is the runner's skip (checksum) | C runner re-apply skip (existing migrations.test.ts) | GAP SEC-02 (tier 1 authority): a login granted TEMPORARY after deploy is refused by the pool; S :: "DENY SEC-DEPTH: a runtime login cannot create a temporary table or a pg_temp function (42501) and the pool refuses a login that can" | N/A guard |
| R2 job attempt insert -> attempt_count (0021:684) | C existing FOR SHARE ordering (0021:588-590) + GAP SEC-03 two takeovers of one job in both orders, one 40001/KA080: S :: "RACE SEC-DEPTH: two attempts racing for ordinal n+1 leave attempt_count = n+1 bound to the committed one" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-04: nested repeat of the bookkeeping update refused (ordinal != count+1) | GAP SEC-05 (tier 1): cancel_command between insert and bookkeeping: existing KA081 (0021:595) stands; S :: "DENY SEC-DEPTH (nested): attempt bookkeeping cites a real attempt created in this transaction" | N/A guard |
| R3 attempt claim -> job fence (0021:686) | GAP SEC-06: two claimants of an expired lease, both orders, one fence wins, job fence = winner's | N/A guard | GAP SEC-07: claim at server_now = lease expires_at -1 ms refused, = expires_at accepted (test clock) | N/A guard | N/A guard | GAP SEC-08 (tier 1): S :: "DENY SEC-DEPTH (nested): a depth-2 write of fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job" | GAP SEC-09: lease taken over between claim and bookkeeping -> attempt_owns_lease false, KA080 | N/A guard |
| R4 lease INSERT / DELETE | C claim_lease FOR UPDATE (0006:253) | N/A | N/A | N/A single statement | N/A | GAP SEC-10 (tier 1): S :: "DENY SEC-DEPTH (lease delete): kauro_control can neither DELETE a lease nor INSERT one above fence 1" | N/A | N/A single statement (DENY SEC-10) |
| R5 lease renew/heartbeat/checkpoint | C row lock (0006:253, :297 UPDATE) | N/A | GAP SEC-11 (tier 1): S :: "DENY SEC-DEPTH (lease clock): heartbeat and checkpoint stamp kauro.server_now() whatever the caller sends; an expired holder renews nothing" | N/A | N/A | C existing adapters-leases.test.ts :: "S090 through the adapter: ..." (moved to test clock) | GAP SEC-12: a takeover commits between read and heartbeat -> heartbeat NULL (fenced out) | N/A |
| R6 lease takeover (UPDATE owner/fence) | GAP SEC-13: two takeovers of one expired lease both orders, exactly one fence+1 | N/A | GAP SEC-14 (tier 1): S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" (fails on 21b310f: journals-leases :345 pattern) | N/A | N/A | C B06-R1 tests (journals-leases.test.ts:335, adapters-leases.test.ts:123/158) re-based on the test clock | C checkpoint rules unchanged (0006:216-224) | N/A |
| R7 carve AUTHORIZED -> pool hold (0023:216) | C pool row lock (0023:208-210 comment) + existing R2-044 test audit-migrations.test.ts:89 | N/A | C pool expiry read on server_now (0023:218) | N/A guard | N/A guard | GAP SEC-15 (tier 1 money): S :: "DENY SEC-DEPTH (nested grant): a depth-2 write of a pool's reserved_cents with no carve authorized in the transaction is refused KA083, up and down" | GAP SEC-16: carve state re-checked under the pool lock | N/A guard |
| R8 carve CLOSED -> pool release (0023:222) | GAP SEC-17: close vs control reconcile on the same pool, both orders | N/A | N/A | N/A guard | N/A guard | GAP SEC-18 (tier 1): release cites a carve closed now, by -ceiling, spend by its own | N/A | N/A guard |
| R9 control reconcile (store.ts:595) | C existing | N/A | N/A | N/A unchanged | N/A unchanged | N/A unchanged | N/A | N/A unchanged; Q1 |
| R10 capture -> allocated_cents (0015:446) | C order FOR UPDATE (0015:433) | N/A | N/A | N/A guard | N/A guard | GAP SEC-19 (tier 1 money): S :: "DENY SEC-DEPTH (nested allocation): allocated_cents that differs from the recount of the order's captures is refused KP002" | N/A | N/A guard |
| R11 catalog gate | N/A read-only | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: every kauro function that reads pg_trigger_depth() is listed with its binding" |

OK row (must pass before and after): S :: "OK SEC-DEPTH: admission, takeover, carve authorize/close, dispatch reservation,
reconciliation and capture allocation commit with bound values". Must FAIL on 21b310f: SEC-02, SEC-08, SEC-10, SEC-11, SEC-14,
SEC-15, SEC-19 (each is accepted today). Nested cases use the kit's `nestedAs`, so they hold even if D-PROV-1 regresses.

## D. Accepted packages touched (A6: re-verify only these titles)

- B06: S090, B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242); pool verification
  (08 Database isolation tests); FOUNDATION aggregate kinds (aggregate-kinds.test.ts:445). L3 only: S050/R2-043.
- B08: S056 (execution-migrations.test.ts:261, execution-adapters.test.ts:331 caller), R2-046 (admission-instants.test.ts:218-286),
  R2-044 / S041 / IC-12 (audit-migrations.test.ts:89, audit-adapters.test.ts:286 caller). Fault harness FH-R2 (r6).
- B09: R2-140 (allocation; b09-migrations.test.ts allocation titles). B10: none unless L3 (b10-recurrence-adapters d27uow). B07: none.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Cells | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (new: `nestedAs`, `depthProbeTable`), src/testing/index.ts export | none | 30 min, 60k | claude-sonnet-5-5 |
| L1 root | migrations/0045, src/pool.ts, test/sec-depth-root.test.ts (new), test/admission-instants.test.ts, test/aggregate-kinds.test.ts, test/fault-harness.test.ts, pool test file | R1, R11, SEC-01/02 | 60 min, 150k | Opus |
| L2a jobs+leases | migrations/0046, 0047, src/lease-store.ts, src/audit/store.ts:488 line only, src/execution/store.ts, test/sec-depth-provenance.test.ts (job/lease part), journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R2-R6 | 100 min, 250k | Opus |
| L2b grants+allocation | migrations/0048, 0049, test/sec-depth-money.test.ts (new) | R7-R10 | 60 min, 150k | Opus |
| L3 hardening | migrations/0050, test/sec-depth-hardening.test.ts | owner count, recurrence | 45 min, 100k | claude-sonnet-5-5 |

Order: K -> (L1 || L2a || L2b) -> L3. Migration numbers reserved as listed. Done = every GAP above rewritten to C with its
title; the 7 must-fail tests shown failing on 21b310f (log) and passing on the branch; full persistence/api/control suites green
(ci-local, WSL+Windows). Total about 4.9 h agent time, 710k tokens.

## F. Open questions (decisions proposed; Codex may overrule)

- Q1 kauro_control reconciles grants at depth 1 (0023:154). Proposed: unchanged in this lane (the control plane is the trusted
  reconciler of D8-GRANT-2); binding it to RECONCILED journal rows is the same repetition problem as R-GRANT-1.
- Q2 The domain port `LeaseStore.claim(claim, now)` keeps `now`, ignored by PgLeaseStore. Removing it touches B06 domain and three
  dispatchers (apps/api payments/commissions, apps/control); proposed as a follow-up, not here.
- Q3 Verify-before-spend for B3: before L2b codes, run the increase/decrease binding as a read-only oracle query over the B08 suite's
  final database; if any legit transaction authorizes or closes two carves of one pool at once, the binding becomes a Σ over carves
  of this instant.
