# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r2

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2 answers Codex design review REJECT on 062a982 (SDP-01..06). Design only; refs are on 21b310f.

## 0. Facts established from the code

- F1 Ten guards treat `pg_trigger_depth() >= 2` as "our own trigger wrote this": 0002:143, 0015:98, 0021:466, 0023:158, 0023:453,
  0028:117, 0028:261, 0028:447, 0028:472, 0044:73/96 (0044 already binds to `server_now()` + an admission fact).
- F2 Depth is forgeable: PUBLIC keeps the default `TEMPORARY` on the database (no REVOKE in migrations/; 0001:41 revokes only
  `ON SCHEMA kauro`). Our tests do it as runtime roles: admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464;
  fault-harness.test.ts:1237.
- F3 Other depth-2 routes for a fresh runtime session, checked: no FK with ON DELETE/UPDATE actions (0 hits), no TRIGGER/ALL grant to
  a runtime role (0 hits), runtime groups get USAGE only on kauro/kauro_meta (0001:73/78, 0013:45/47, 0028:41/43), PG 17 `public` has
  no PUBLIC CREATE (verify.yml:24/71). Codex confirmed rules, INSTEAD OF, event triggers, extensions, DO/prepared statements give no
  route (review case D-PROV-1). Remaining routes are identity- and session-shaped: objects RETAINED by a session opened before the
  revoke (SDP-01; pool caches verification per physical connection, src/pool.ts:164, :190), direct grants to a LOGIN, roles reachable by
  SET ROLE, and logins that bypass the pool (Aurora Data API, authority r2 A9_CLOUD_AWS) (SDP-02).
- F4 Finding 1 also has a route with no temp object: kauro_control holds DELETE on leases (0006:374, policy 0006:366) and leases have
  no INSERT guard (0006:202-229 is BEFORE UPDATE). Delete + insert the JOB_ATTEMPT lease at fence 2^63-1, claim a new attempt
  (0021:637 `attempt_owns_lease`, which ignores expiry, 0021:265-279), and the real bookkeeping (0021:686) copies the fence to the job;
  `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79 `Number.isSafeInteger`) then throws for every reader.
- F5 Finding 3 needs no nesting: kauro_control UPDATEs leases directly; takeover compares caller-written `NEW.heartbeat_at` with
  `OLD.expires_at` (0006:213); expires_at and checkpoint_hash are otherwise unguarded; claim/heartbeat/checkpoint take `p_now`
  (0006:239-320); journals-leases.test.ts:345-353 takes over with caller instants.
- F6 Finding 2: kauro_app has UPDATE(reserved_cents) (0023:1043) because the per-row AFTER writer `cost_grants_pool_hold`
  (0023:212-227) runs as invoker; `cost_grants_tenant_pool_hold` (0023:940-942) admits any AUTHORIZED pool. kauro_control reconciles
  at depth 1 by design (0023:154-160; src/audit/store.ts:595).
- F7 0015:98: kauro_payment has UPDATE(allocated_cents) (0015:909); single legit writer `capture_facts_allocate` (0015:420-452) adds
  one capture per AFTER ROW invocation (0015:446); policy 0015:875-876 scopes kauro_payment to the current agency.
- F8 Writer timing (SDP-04): `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) BEFORE inserting the
  qualifying purchase (0028:517); `maintain_active_owner_count` adds +-1 per membership row (0002:329-355). Immediate recounts reject
  legit writes; deferred (commit-time) recounts do not.
- F9 Roles: test cluster DB owned by the migrator (temporary-postgres.ts:150-151), runtime logins created AFTER migrations
  (:165-171), so a check inside 0045 sees no logins in tests; in a deployment logins exist before migrations. The migrator is not
  superuser and holds neither pg_signal_backend nor pg_read_all_stats.

## A. Root cause: no runtime identity can create or keep an object (D-PROV-1)

A1 Migration `0045_runtime_no_session_objects.sql` (migrator): `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and from
each runtime group; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `kauro_meta.runtime_identity_audit()` (SECURITY INVOKER, read-only,
returns violation rows, EXECUTE to the migrator only) and a final `PERFORM`-and-RAISE of it. Not chosen: revoking plpgsql USAGE (no
schema to create in; breaks harness DO blocks, fault-harness.test.ts:1230/:1246); SECURITY DEFINER provenance roles (FORCE RLS binds
the owner too, 0001:28).
A2 The audit's identity set (SDP-02) is the closure, not the groups: (a) the seven runtime groups; (b) every role that is a member,
direct or indirect, of a runtime group; (c) every LOGIN role that is not on an explicit allowlist (migrator `current_user`, the
platform admin named by `kauro_meta.platform_admin_roles` seeded at provisioning) — this covers Data API secret users whatever their
membership; (d) every role any of (a)-(c) can SET ROLE into (`pg_auth_members` with `set_option`, PG16+) or inherits. For each
identity, evaluated as itself (not via inheritance): no rolsuper/createrole/createdb/bypassrls/replication; not a member of
pg_signal_backend, pg_write_all_data, pg_read_server_files, pg_write_server_files, pg_execute_server_program, pg_create_subscription,
pg_maintain; no TEMPORARY or CREATE on the database (`aclexplode(datacl)` for the role itself and PUBLIC, plus
`has_database_privilege`); no CREATE on any schema and owns no schema, no database, no kauro object, no function, no type. A login of
(b)/(c) must be a member of exactly one runtime group and of nothing else (also enforced per connection by the pool, A4).
A3 Object audit (SDP-01): zero relations, functions, types or triggers in any `pg_temp_%`/`pg_toast_temp_%` namespace; zero objects
owned by an identity of A2; every `pg_trigger` on a kauro/kauro_meta table calls a function owned by the migrator and created by a
migration (function name in the migrations' catalog list); zero backends (`pg_stat_activity`) of an A2 identity whose `backend_start`
precedes the audit's cutover instant. The backend clause needs pg_read_all_stats, so the audit runs twice: inside 0045 (catalog
clauses) and in the cutover (all clauses).
A4 Pool (src/pool.ts:100-105, 159-186): VERIFY_SQL adds the A2 per-identity clauses for `current_user` and refuses also any login whose
membership closure is not exactly one runtime group (SET ROLE route), plus `maxLifetimeSeconds: 600` so a connection re-verifies at
least every 10 minutes (a privilege granted to a live login is caught by the next verification and the readiness audit, A5).
A5 Cutover procedure (B14 runbook; executable as `tools/deploy/runtime-cutover.mjs`, run by the platform admin role, which on
RDS/Aurora is the master user holding pg_signal_backend + pg_read_all_stats):
1. stop new runtime work (scale runtime services and Data API callers to zero; ingress returns 503);
2. `pg_terminate_backend` every backend of an A2 identity; record cutover instant T;
3. migrator applies migrations (0045 included) with `applyMigrationsAs` (src/migrations/runner.ts:298);
4. run `runtime_identity_audit(T)` with all clauses; any row -> stop, keep runtime down, report;
5. start runtime; the pool verifies every fresh connection; readiness runs the catalog clauses every 5 minutes and fails the service
   on any row. Provisioning (B14) creates the database `OWNER <migrator>`; Data API secret users are never on the allowlist
   and are audited as (c). In tests the superuser oracle plays the platform admin.
A6 Existing tests that create session objects as a runtime role keep their assertions (Codex agreed, review "existing-test-rewrites"):
admission-instants :218-250 and :266-286 run through the kit's `nestedAs` (oracle-made SECURITY INVOKER function + probe table in
schema `depth_probe`, INSERT on the ORIGINAL runtime connection and context; the test asserts `current_user` and `pg_trigger_depth()`
inside the probe and drops all probe objects in finally); aggregate-kinds :445-470 part (1) runs on a separate direct login granted
TEMPORARY by the oracle, connection closed and grant revoked in finally, plus a new 42501 assertion on the pooled login;
fault-harness :1232-1239 uses an oracle-made `fault_probe.fault_undo_clock()`. b10-failure-cells-conversion :50-69 is owner-made.

## B. Defence in depth: each value bound to its producing fact

B1 processing_jobs (D-PROV-2; Codex agreed), `0046_job_fence_provenance.sql`, faithful copy of 0021:418-528, only 0021:465-468
replaced: attempt_count/current_attempt_id change needs depth >= 2, `NEW.attempt_count = OLD.attempt_count + 1` and an attempt
(agency, job, `attempt_id = NEW.current_attempt_id`, `ordinal = NEW.attempt_count`, created_at = server_now()); fence change needs
`NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`, that attempt CLAIMED at `fence = NEW.fence` with
claimed_at = server_now(), and `attempt_owns_lease`. CHECK `<= 9007199254740991` on processing_jobs.fence/attempt_count,
processing_attempts.fence, leases.fence (ADD NOT VALID; VALIDATE). jobRecord stays fail-closed.
B2 leases (D-PROV-3; SDP-03), `0047_lease_server_clock.sql`. `leases_guard` becomes BEFORE INSERT OR UPDATE OR DELETE; `now` below
is `kauro.server_now()`:
- INSERT: fence = 1, checkpoint as given, heartbeat_at/created_at/updated_at := now, `now < expires_at <= deadline_at`.
- DELETE: refused KA005; `REVOKE DELETE ON kauro.leases FROM kauro_control` (no caller: `DELETE FROM kauro.leases` 0 hits).
- UPDATE, any change of heartbeat_at, expires_at, checkpoint_hash, owner or fence: `NEW.heartbeat_at = now` (KA005 LEASE_CLOCK) and
  `NEW.expires_at > now`. Same owner+fence (renewal or checkpoint): `OLD.expires_at > now` (live) and `NEW.expires_at >=
  OLD.expires_at` (no shortening: nothing in src shortens or releases a lease, grep `expires_at =` in src 0 lease hits); a checkpoint
  change additionally needs `NEW.checkpoint_hash IS NOT NULL`. Owner or fence change (takeover): `OLD.expires_at <= now`, fence + 1,
  checkpoint rules 0006:216-224 unchanged. cancel_version rule unchanged (0006:206).
- claim_lease / heartbeat_lease / checkpoint_lease: DROP the `p_now` overloads completely, CREATE without it, every instant = now.
  Callers: src/lease-store.ts:75/91/96, src/audit/store.ts:488, src/execution/store.ts:456/620. The port keeps `now`, ignored by
  PgLeaseStore and documented (Q2, Codex agreed); a test proves a different caller `now` changes no outcome.
B3 cost_grants (D-PROV-4; SDP-05 kept per-carve, R-GRANT-1 closed without D-PROV-1), `0048_grant_hold_events.sql`:
- new `kauro.cost_grant_hold_events (carve_grant_id, kind HOLD|RELEASE, pool_grant_id, agency_id, seq, cents, spend_cents,
  recorded_at)`, PK (carve_grant_id, kind), UNIQUE (pool_grant_id, seq); pool gets `hold_seq bigint NOT NULL DEFAULT 0`. RLS: kauro_app
  INSERT/SELECT own agency; kauro_control SELECT all. INSERT guard: the carve is of this pool and agency; HOLD needs carve state
  AUTHORIZED with authorized_at = now and `cents = ceiling`; RELEASE needs carve CLOSED with closed_at = now, `cents = ceiling`,
  `spend_cents = carve.reconciled_spend_cents`; recorded_at := now; append-only.
- writer `cost_grants_pool_hold` (faithful copy of 0023:212-227): lock the pool FOR UPDATE, insert the event with
  `seq = pool.hold_seq + 1`, then `UPDATE pool SET hold_seq = hold_seq + 1, reserved_cents = reserved_cents +- cents,
  reconciled_spend_cents = ... + spend_cents` (release).
- pool guard in `cost_grants_workflow` (faithful copy of 0023:125-205; 0023:155-160 replaced): for a non-control session a change of
  reserved_cents, reconciled_spend_cents or hold_seq needs `NEW.hold_seq = OLD.hold_seq + 1` and the event (pool, seq = NEW.hold_seq)
  recorded now with delta = +cents (HOLD) or -cents and spend +spend_cents (RELEASE). Each carve yields at most one HOLD and one RELEASE
  (PK) and each event moves the pool once (seq consumed): a repeated real carve is refused independently of D-PROV-1. Per-row timing:
  two carves authorized in one UPDATE produce two events and two increments, each checked against its own event (no transaction SUM;
  Q3 withdrawn). Control reconciliation (0023:154; store.ts:595) remains a trusted direct writer in this lane: B3 gives no provenance
  against arbitrary kauro_control SQL (Q1, stated exception; Codex agreed for this lane).
B4 payment_orders (D-PROV-5; SDP-04), `0049_allocation_recount.sql`: the immediate guard (0015:91-106) keeps depth + monotonicity; a
new DEFERRABLE INITIALLY DEFERRED constraint trigger AFTER UPDATE OF allocated_cents checks at commit `allocated_cents =
coalesce(Σ(allocated_service_cents + allocated_tax_cents), 0)` over the order's capture_facts (same agency) with status IN
('COMPLETED','REVERSED'), KP002. Multi-capture statements pass (the check runs after every per-row increment).
B5 L3 hardening (SDP-04), `0050_owner_recurrence_recount.sql`, deferred constraint triggers, writers unchanged:
`agencies.active_owner_count` = count of ACTIVE OWNER memberships (KA004; preserves KA001 at 0002:349 which stays immediate);
`agency_recurrence.confirmation_count` = count and max(confirmation_seq) of the agency's qualifying_purchases, first_* = the
seq-1 purchase (KC001). The qualifying-purchase INSERT also checks its authorization row was born in this transaction (column named
by the L3 designer from 0028; KC001).
B6 Catalog gate (D-PROV-6): every kauro function whose prosrc reads `pg_trigger_depth` must be in the test's allowlist with its binding
(fact, deferred recount, or D-PROV-1 only: 0023:453 audit fence, 0028:117, 0028:261, 0028:472).

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
R = `.../sec-depth-root.test.ts`, H = `.../sec-depth-hardening.test.ts`. All GAP cells are tier 1 (authority or money).

N/A "guard": the change is a check inside the caller's statement (no own write, COMMIT or port call); CRASH-BEFORE/AFTER, RETRY of
the caller and TIMEOUT stay the caller's existing rows (B08 S056, B06 S090, B09 R2-140, B10 d27uow) and a refusal rolls back the
caller's statement, so PARTIAL is N/A + the named DENY (template rule 4). A row lock is never cited as a race proof (rule 1).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 cutover A5 | GAP SEC-01 R :: "RACE SEC-DEPTH (retained session): a runtime connection opened before the revoke keeps a pg_temp nested writer; the cutover terminates it and the audit reports nothing after" | N/A: termination is synchronous per pid; audit re-run | N/A | GAP SEC-02 R :: "DENY SEC-DEPTH (release): 0045 aborts and records no ledger row when an audited identity keeps TEMPORARY" | GAP SEC-03 R :: "RACE SEC-DEPTH (cutover crash after migrate): a re-run cutover terminates, skips applied migrations and audits clean" | N/A covered by SEC-03 | GAP SEC-04 R :: "DENY SEC-DEPTH (readiness): a privilege granted to a live login fails readiness and the next verification of its connection" | N/A guard |
| R2 identities A2/A4 | N/A per-connection check | N/A | N/A | N/A read-only | N/A | N/A | GAP SEC-05 R :: "DENY SEC-DEPTH (identity): a login with a direct TEMPORARY grant, a schema CREATE, database CREATE, a schema it owns, or SET ROLE into a NOINHERIT role holding one is refused by the pool and reported by the audit" (one sub-test per route) | N/A |
| R3 Data API logins | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-06 R :: "DENY SEC-DEPTH (unpooled login): a LOGIN outside every runtime group and the allowlist, with TEMPORARY, is reported by the audit" | N/A |
| R4 root routes | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-07 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table, a pg_temp function, a schema, or an object in public, kauro or kauro_meta (42501)" | N/A |
| R5 attempt insert -> attempt_count (0021:684) | GAP SEC-08 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-09 S :: "DENY SEC-DEPTH (nested attempt_count): a depth-2 attempt_count not equal to a real attempt's ordinal born now is refused KA080" | GAP SEC-10 S :: "DENY SEC-DEPTH (nested current_attempt_id): a depth-2 current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R6 attempt claim -> job fence (0021:686) | GAP SEC-11 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-12 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence; the initial claim at fence 1 is not a takeover" | N/A guard | N/A guard | GAP SEC-13 S :: "DENY SEC-DEPTH (nested fence): a depth-2 write of fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job" | N/A: claim and bookkeeping run in one transaction holding the lease row lock (claim_lease FOR UPDATE, 0006:253), no takeover can interleave; SEC-11 proves the wait | N/A guard |
| R7 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-14 S :: "DENY SEC-DEPTH (lease delete): kauro_control can neither DELETE a lease nor INSERT one above fence 1 or with a caller instant" | N/A (DENY SEC-14) |
| R8 renew/heartbeat | GAP SEC-15 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of the same lease, both orders, the takeover only after expiry and the stale heartbeat NULL" | N/A | GAP SEC-16 S :: "DENY SEC-DEPTH (lease clock): a renewal that shortens or sets expires_at at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-17 S :: "OK SEC-DEPTH: a caller instant passed to the port changes no claim, heartbeat or checkpoint outcome" | GAP SEC-18 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R9 checkpoint | N/A covered by SEC-15 | N/A | GAP SEC-19 S :: "DENY SEC-DEPTH (expired checkpoint): an expired spending lease takes no checkpoint by direct UPDATE or checkpoint_lease, so it stays unresumable" | N/A | N/A | N/A | N/A covered by SEC-18 | N/A |
| R10 carve HOLD | GAP SEC-20 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, two events seq n+1 and n+2 and reserved = sum" | N/A guard | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-21 M :: "DENY SEC-DEPTH (nested grant repetition): a second depth-2 increment citing a real carve authorized now is refused KA083" ; SEC-22 M :: "DENY SEC-DEPTH (nested grant): reserved_cents moved with no hold event is refused KA083, up and down" | GAP SEC-23 M :: "DENY SEC-DEPTH: a hold event for a carve of another pool, agency, or not authorized now is refused" | N/A (DENY SEC-22); multi-row OK SEC-24 M :: "OK SEC-DEPTH: two carves authorized in one UPDATE hold their own ceilings" |
| R11 carve RELEASE | GAP SEC-25 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation on one pool, both orders, reserved and spend exact" | N/A | N/A | N/A guard | N/A guard | GAP SEC-26 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | N/A | N/A guard |
| R12 capture -> allocated_cents | GAP SEC-27 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders, allocated = recount" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-28 M :: "DENY SEC-DEPTH (nested allocation): allocated_cents differing from the recount at commit is refused KP002" | N/A | GAP SEC-29 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R13 owner count (L3) | GAP SEC-30 H :: "RACE SEC-DEPTH: two owner removals, both orders, the recount at commit and KA001 still hold" | N/A guard | N/A | N/A guard | N/A guard | N/A | GAP SEC-31 H :: "DENY SEC-DEPTH (nested owner count): an inflated active_owner_count is refused at commit KA004" | GAP SEC-32 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R14 recurrence (L3) | GAP SEC-33 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders at the recurrence lock, count = purchases" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-34 H :: "DENY SEC-DEPTH (nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001" | N/A | GAP SEC-35 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R15 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: every kauro function that reads pg_trigger_depth() is listed with its binding" |

Must FAIL on 21b310f by demonstrating the forbidden behaviour with base SQL only (no new helper or signature in the attack path):
SEC-01 (retained writer still writes after REVOKE), SEC-05/06 (route accepted), SEC-07 (create succeeds), SEC-09, SEC-10, SEC-13,
SEC-14, SEC-16, SEC-18, SEC-19, SEC-21, SEC-22, SEC-28, SEC-31, SEC-34 (each accepted). Nested attacks use `nestedAs` (base-SQL
oracle setup), so they hold even if D-PROV-1 regresses. Each title is one path; compound titles are split into sub-tests.

## D. Accepted packages touched (A6: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool verification,
aggregate-kinds.test.ts:445; S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331,
execution-migrations :150), R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89,
audit-adapters :286); fault harness FH-R2 (r6). B09: R2-140 (b09-migrations allocation titles). B10: d27uow via L3. B07: none.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAs`, `depthProbeTable`), src/testing/index.ts | - | 30 min, 60k | claude-sonnet-5-5 |
| L1 root | migrations/0045, src/pool.ts, src/migrations/runtime-audit.ts, tools/deploy/runtime-cutover.mjs, R, admission-instants, aggregate-kinds, fault-harness tests | R1-R4, R15 | 120 min, 300k | Opus |
| L2a jobs+leases | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R5-R9 | 120 min, 300k | Opus |
| L2b money | migrations/0048, 0049, M | R10-R12 | 90 min, 220k | Opus |
| L3 hardening | migrations/0050, H | R13-R14 | 60 min, 140k | Opus |

Order K -> (L1 || L2a || L2b) -> L3. Done = every GAP rewritten to C with its title; must-fail list shown failing on 21b310f (log)
and passing on the branch; full suites green in ci-local (WSL + Windows). Total about 7 h agent time, 1.0M tokens.

## F. Decisions and open questions

- Q1 (accepted by Codex for this lane) kauro_control stays a trusted direct reconciler; future hardening = a uniquely consumed
  reconciliation fact on the same event pattern as B3.
- Q2 (accepted) port keeps `now`; SQL overloads removed; removal from the domain port is a follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn: per-carve events replace any SUM.
- Q4 A5 needs the platform admin role (RDS master) at each deploy; this is a B14 runbook step, not an owner decision.
