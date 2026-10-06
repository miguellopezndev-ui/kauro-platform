# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r3

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2 answered review 062a982 (SDP-01..06); r3 answers review 9cc894e (SDP-02, 06-10). Design only.

## 0. Facts established from the code

- F1 Ten guards treat `pg_trigger_depth() >= 2` as "our own trigger wrote this": 0002:143, 0015:98, 0021:466, 0023:158, 0023:453,
  0028:117, 0028:261, 0028:447, 0028:472, 0044:73/96 (0044 already binds to `server_now()` + an admission fact).
- F2 Depth is forgeable: PUBLIC keeps the default `TEMPORARY` on the database (no REVOKE in migrations/; 0001:41 revokes only
  `ON SCHEMA kauro`). Our tests do it as runtime roles: admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464;
  fault-harness.test.ts:1237.
- F3 No other depth-2 route for a fresh runtime session (Codex confirmed, r2 case D-PROV-1): no TRIGGER/ALL grant to a runtime
  role, USAGE only on kauro/kauro_meta (0001:73/78, 0013:45/47, 0028:41/43), PG 17 `public` has no PUBLIC CREATE (verify.yml:24/71),
  no FK declares ON DELETE/UPDATE actions (0 hits for CASCADE/SET in 412 REFERENCES). FKs do create internal `RI_FKey_*` triggers
  (pg_catalog functions), which A3 must recognise. Remaining routes are identity- and session-shaped: objects retained by a session
  opened before the revoke (pool caches verification per connection, src/pool.ts:164, :190), direct grants to a LOGIN, roles
  reachable by SET ROLE, logins outside the pool (Aurora Data API, authority r2 A9_CLOUD_AWS).
- F4 Finding 1 also has a route with no temp object: kauro_control holds DELETE on leases (0006:374, policy 0006:366) and leases have
  no INSERT guard (0006:202-229 is BEFORE UPDATE). Delete + insert the JOB_ATTEMPT lease at fence 2^63-1, claim a new attempt
  (0021:637; `attempt_owns_lease` ignores expiry, 0021:265-279) and the real bookkeeping (0021:686) copies it to the job;
  `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79 `Number.isSafeInteger`) then throws for every reader.
- F5 Finding 3 needs no nesting: kauro_control UPDATEs leases directly; takeover compares caller-written `NEW.heartbeat_at` with
  `OLD.expires_at` (0006:213); expires_at/checkpoint_hash are otherwise unguarded; claim/heartbeat/checkpoint take `p_now`
  (0006:239-320); journals-leases.test.ts:345-353 takes over with caller instants.
- F6 Finding 2: kauro_app has UPDATE(reserved_cents) (0023:1043) because the per-row AFTER writer `cost_grants_pool_hold`
  (0023:212-227) runs as invoker; `cost_grants_tenant_pool_hold` (0023:940-942) admits any AUTHORIZED pool. kauro_control closes
  AUDIT grants (apps/control/src/audit/grants.ts:96 -> `transitionGrant`), so the RELEASE half of the writer runs as kauro_control,
  and reconciles at depth 1 by design (0023:154-160; src/audit/store.ts:595). `cost_grants_version` (0023:115-116) exempts only
  reserved_cents and reconciled_spend_cents from the version bump.
- F7 0015:98: kauro_payment has UPDATE(allocated_cents) (0015:909); single legit writer `capture_facts_allocate` (0015:420-452), one
  capture per AFTER ROW invocation (0015:446); policy 0015:875-876 scopes kauro_payment to the current agency.
- F8 Writer timing: `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) BEFORE inserting the purchase
  (0028:517); `maintain_active_owner_count` adds +-1 per membership row (0002:329-355). Only commit-time recounts fit them.
- F9 Roles: the test DB is owned by the migrator, a LOGIN CREATEROLE non-superuser (temporary-postgres.ts:150-151) that creates the
  runtime groups in 0001:44-60; PG 16+ then records the creator as a member with ADMIN TRUE, INHERIT FALSE, SET FALSE. Runtime
  logins are created after migrations in tests (:165-171), before migrations in a deployment. The migrator holds neither
  pg_signal_backend nor pg_read_all_stats. RDS/Aurora ship provider roles (rdsadmin LOGIN, rds_superuser, rds_* NOLOGIN).

## A. Root cause: no runtime identity can create or keep an object (D-PROV-1)

A1 Migration `0045_runtime_no_session_objects.sql` (migrator): `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and from
each runtime group; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; creates `kauro_meta.trusted_identities (role_oid oid PK,
role_name, kind MIGRATOR|PLATFORM_ADMIN|PROVIDER, recorded_at)`, seeded with the database owner (`pg_database.datdba`, kind
MIGRATOR; stable whoever later calls) and the bootstrap superuser (oid 10, PROVIDER); further rows only by the migrator (no runtime
grant). Creates `kauro_meta.runtime_identity_audit()` (SECURITY INVOKER, read-only, uses only world-readable catalogs: pg_roles,
pg_auth_members, pg_database, pg_namespace, pg_class, pg_proc, pg_type, pg_trigger, pg_constraint) and RAISEs if it returns a row.
EXECUTE: migrator, every runtime group (readiness) and the PLATFORM_ADMIN roles (granted when they are recorded). Not chosen:
revoking plpgsql USAGE (no schema to create in; breaks harness DO blocks, fault-harness.test.ts:1230/:1246); SECURITY DEFINER
provenance roles (FORCE RLS binds the owner too, 0001:28).
A2 Identity model (SDP-07). Trusted T = rows of trusted_identities plus provider roles listed by the cutover from AWS's documented
inventory (rdsadmin, rds_superuser, rds_password, rds_replication, rds_iam, rds_ad, rdstopmgr, rds_reserved; recorded as PROVIDER).
Runtime seeds G = the seven groups. Runtime identities R = G, plus every role that holds a membership in a G role with INHERIT or SET
(direct or transitive), plus every LOGIN role not in T (this covers each Data API secret user), plus every role any of these can
reach by INHERIT or SET. A membership with ADMIN TRUE, INHERIT FALSE, SET FALSE held by a T role (the PG 16+ creator grant, F9)
confers no privilege and does not make the holder runtime. Violations:
- any R identity reaches a T role (membership, INHERIT or SET), or is superuser/createrole/createdb/bypassrls/replication, or is a
  member of pg_signal_backend, pg_write_all_data, pg_read_server_files, pg_write_server_files, pg_execute_server_program,
  pg_create_subscription, pg_maintain;
- any R identity, evaluated as itself and via PUBLIC (`aclexplode(datacl)`, `aclexplode(nspacl)`), has TEMPORARY or CREATE on the
  database, CREATE on any schema of the database (all of pg_namespace, extra schemas included), or owns a schema, the database, a
  relation, a function or a type;
- a LOGIN in R is not a member of exactly one G group (with INHERIT) and of nothing else.
A3 Object audit (SDP-01, SDP-08): zero relations, functions, types in any `pg_temp_%`/`pg_toast_temp_%` namespace. Triggers on
kauro/kauro_meta tables: a user trigger (`NOT tgisinternal`, migration CONSTRAINT TRIGGERs included) must call a function in schema
kauro owned by the MIGRATOR identity and named in the migrations' function list; an internal trigger (`tgisinternal`) is accepted only
when `tgconstraint` is a `pg_constraint` of `contype = 'f'` on that table or its referenced table, its function is an `RI_FKey_*`
function in pg_catalog owned by oid 10, and that constraint has `confupdtype` and `confdeltype` in ('a','r') (NO ACTION/RESTRICT), so
no FK action route can appear unnoticed. Any other trigger is a violation.
A4 Pool (src/pool.ts:100-105, 159-190): VERIFY_SQL runs the A2 per-identity clauses for `current_user` and refuses the connection
on any; `maxLifetimeSeconds: 600` so each connection re-verifies at least every 10 minutes.
A5 Cutover (B14 runbook; `tools/deploy/runtime-cutover.mjs`, run as a PLATFORM_ADMIN role, on RDS/Aurora the master user holding
pg_signal_backend + pg_read_all_stats; in tests the superuser oracle):
1. stop new runtime work (runtime services and Data API callers scaled to zero; ingress 503);
2. for every backend of an R identity: `pg_terminate_backend(pid, 5000)` (PG 14+: returns true only once the backend is gone); then
   poll `pg_stat_activity` every 250 ms for at most 30 s until no R backend remains; on timeout STOP fail-closed (runtime stays
   down, report the pids); record cutover instant T;
3. the migrator applies migrations with `applyMigrationsAs` (src/migrations/runner.ts:298);
4. run `runtime_identity_audit()` plus the backend clause (zero R backends with `backend_start < T`); any row -> stop, report;
5. start runtime; readiness runs `runtime_identity_audit()` every 5 minutes and fails the service on any row (detection only).
A6 Login provisioning gate (SDP-02, Data API): a runtime or Data API LOGIN is created only by `tools/deploy/provision-login.mjs` as the
migrator: one transaction `CREATE ROLE <login> LOGIN IN ROLE <one group>`, `runtime_identity_audit()`, COMMIT only when it returns no
row; only then is the Secrets Manager secret written and the IAM policy of the Data API caller scoped to that secret ARN. A LOGIN
created any other way is not trusted, is audited as R and fails readiness. Provisioning creates the database `OWNER <migrator>`.
A7 Existing tests that create session objects as a runtime role keep their assertions (Codex agreed): admission-instants :218-250
and :266-286 run through the kit's `nestedAs` (oracle-made SECURITY INVOKER function + probe table in schema `depth_probe`, INSERT
on the ORIGINAL runtime connection and context; for :266-286 the production deferred guard itself is attached as the constraint
trigger; the probe asserts `current_user` and `pg_trigger_depth()`; all probe objects dropped in finally); aggregate-kinds :445-470
part (1) runs on a separate direct login granted TEMPORARY by the oracle, connection closed and grant revoked in finally, plus a new
42501 assertion on the pooled login; fault-harness :1232-1239 uses an oracle-made `fault_probe.fault_undo_clock()`.

## B. Defence in depth: each value bound to its producing fact

B1 processing_jobs (D-PROV-2; Codex agreed), `0046_job_fence_provenance.sql`, faithful copy of 0021:418-528 with only 0021:465-468
replaced: attempt_count/current_attempt_id change needs depth >= 2, `NEW.attempt_count = OLD.attempt_count + 1` and an attempt
(agency, job, `attempt_id = NEW.current_attempt_id`, `ordinal = NEW.attempt_count`, created_at = server_now()); fence change needs
`NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`, that attempt CLAIMED at `fence = NEW.fence` with
claimed_at = server_now(), and `attempt_owns_lease`. CHECK `<= 9007199254740991` on processing_jobs.fence/attempt_count,
processing_attempts.fence, leases.fence (ADD NOT VALID; VALIDATE). jobRecord stays fail-closed.
B2 leases (D-PROV-3; Codex: fixed), `0047_lease_server_clock.sql`; `now` = `kauro.server_now()` (transaction clock, D-CLOCK-1):
- INSERT: fence must be 1 (refused otherwise); heartbeat_at, created_at, updated_at are NORMALISED to now (caller values
  overwritten, not refused); `now < expires_at <= deadline_at` refused otherwise.
- DELETE: refused KA005; `REVOKE DELETE ON kauro.leases FROM kauro_control` (no caller: `DELETE FROM kauro.leases` 0 hits).
- UPDATE changing heartbeat_at, expires_at, checkpoint_hash, owner or fence: `NEW.heartbeat_at = now` (refused KA005 LEASE_CLOCK)
  and `NEW.expires_at > now`. Same owner+fence: `OLD.expires_at > now` and `NEW.expires_at >= OLD.expires_at` (nothing in src shortens
  or releases a lease); a checkpoint change also needs `NEW.checkpoint_hash IS NOT NULL`. Owner/fence change (takeover):
  `OLD.expires_at <= now`, fence + 1, checkpoint rules 0006:216-224 unchanged. cancel_version rule unchanged (0006:206).
- claim/heartbeat/checkpoint: every old `p_now` overload DROPPED, new signatures without it. Callers: src/lease-store.ts:75/91/96,
  src/audit/store.ts:488, src/execution/store.ts:456/620. The port keeps `now`, ignored by PgLeaseStore, documented (Q2).
B3 cost_grants pool holds (D-PROV-4; SDP-09), `0048_grant_hold_events.sql`:
- table `kauro.cost_grant_hold_events (carve_grant_id, kind HOLD|RELEASE, pool_grant_id, agency_id, seq, cents, spend_cents,
  recorded_at)`, PK (carve_grant_id, kind), UNIQUE (pool_grant_id, seq), append-only (UPDATE/DELETE/TRUNCATE refused). RLS: kauro_app
  INSERT and SELECT `agency_id = current_agency_id() AND kind = 'HOLD'`; kauro_control INSERT `kind = 'RELEASE'` and SELECT all.
  Grants: INSERT, SELECT to both groups, nothing else. INSERT guard (any role): the carve is an AUDIT grant of this pool and agency;
  HOLD needs carve AUTHORIZED with authorized_at = now, `cents = ceiling`; RELEASE needs carve CLOSED with closed_at = now,
  `cents = ceiling`, `spend_cents = carve.reconciled_spend_cents`; `seq = pool.hold_seq + 1` read under the pool row lock;
  recorded_at := now.
- cost_grants: column `hold_seq bigint NOT NULL DEFAULT 0 CHECK (hold_seq >= 0)`; birth guard in cost_grants_workflow
  `NEW.hold_seq = 0`; `hold_seq` stays 0 on AUDIT grants (refused otherwise). `GRANT UPDATE (hold_seq)` to kauro_app and
  kauro_control (adds to 0023:1043/1045). `cost_grants_version` re-created with `enforce_version_bump('reserved_cents,
  reconciled_spend_cents,hold_seq')` (hold movement is not a version of the pool, as 0023:114 already says for reservations).
- writer `cost_grants_pool_hold` (faithful copy of 0023:212-227): `SELECT ... FOR UPDATE` the pool, insert the event, then
  `UPDATE pool SET hold_seq = hold_seq + 1, reserved_cents = reserved_cents + cents` (HOLD, as kauro_app) or `- cents,
  reconciled_spend_cents = ... + spend_cents` (RELEASE, as kauro_control).
- pool guard (faithful copy of 0023:125-205, 0023:155-160 replaced): ANY change of hold_seq by any role needs `NEW.hold_seq =
  OLD.hold_seq + 1` and the event (pool, seq = NEW.hold_seq) recorded now, with the reservation and spend deltas equal to the event's;
  for a non-control session no reservation change is allowed without such an event. Each carve yields at most one HOLD and one
  RELEASE (PK), each event moves the pool once (seq consumed): a repeated real carve is refused without relying on D-PROV-1. The
  AUDIT-grant branch (request_journal reservations, 0023:262-288, inserted by kauro_control) and control's direct reconciliation
  (store.ts:595) are unchanged; B3 gives no provenance against arbitrary kauro_control SQL (Q1, accepted for this lane).
B4 payment_orders (D-PROV-5), `0049_allocation_recount.sql`: the immediate guard (0015:91-106) keeps depth + monotonicity; a new
DEFERRABLE INITIALLY DEFERRED constraint trigger AFTER UPDATE OF allocated_cents uses NEW only to identify (agency_id, order_id),
RE-SELECTS the final order row and compares its current allocated_cents with `coalesce(Σ(allocated_service_cents +
allocated_tax_cents), 0)` over that order's capture_facts with status IN ('COMPLETED','REVERSED'), KP002 (SDP-10).
B5 L3 hardening, `0050_owner_recurrence_recount.sql`, deferred constraint triggers, writers unchanged; each uses NEW only to
identify the parent and re-selects the final row (SDP-10): `agencies.active_owner_count` = count of ACTIVE OWNER memberships (KA004;
KA001 at 0002:349 stays immediate); `agency_recurrence.confirmation_count` = count and max(confirmation_seq) of the agency's
qualifying_purchases and first_* = the seq-1 purchase (KC001). The purchase INSERT also checks its authorization row was born in
this transaction (column named by the L3 designer from 0028; KC001).
B6 Catalog gate (D-PROV-6): every kauro function whose prosrc reads `pg_trigger_depth` is in the test's allowlist with its binding
(fact, deferred recount, or D-PROV-1 only: 0023:453, 0028:117, 0028:261, 0028:472).

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
R = `.../sec-depth-root.test.ts`, H = `.../sec-depth-hardening.test.ts`. All GAP cells are tier 1 (authority or money).

N/A "guard" = the change is a check inside the caller's statement (no own write, COMMIT or port call); the caller's CRASH, RETRY and
TIMEOUT cells stay proven by the unchanged titles in table C2, and a refusal rolls back only the caller's statement, so PARTIAL is
N/A + the named DENY (template rule 4). A row lock is never cited as race proof (rule 1); every RACE cell holds one actor at the lock.

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 cutover A5 | GAP SEC-01 R :: "RACE SEC-DEPTH (retained session): a runtime connection opened before the revoke keeps a pg_temp nested writer; the cutover terminates it and the audit reports nothing after" | GAP SEC-02 R :: "RACE SEC-DEPTH (cutover timeout): a backend that outlives the 30 s termination bound stops the cutover fail-closed and runtime stays down" | N/A no deadline | GAP SEC-03 R :: "DENY SEC-DEPTH (release): 0045 aborts and records no ledger row when an audited identity keeps TEMPORARY" | GAP SEC-04 R :: "RACE SEC-DEPTH (cutover crash after migrate): a re-run cutover terminates, skips applied migrations and audits clean" | N/A covered by SEC-04 | GAP SEC-05 R :: "DENY SEC-DEPTH (readiness): a privilege granted to a live login fails readiness and the next verification of its connection" | N/A guard |
| R2 identities A2/A4 | N/A per-connection check | N/A | N/A | N/A read-only | N/A | N/A | GAP SEC-06a-e R (one test per route): "DENY SEC-DEPTH (identity): a pooled login with a direct TEMPORARY grant is refused and reported" / "... with CREATE on an extra schema ..." / "... with database CREATE ..." / "... owning a schema ..." / "... able to SET ROLE into a NOINHERIT role holding TEMPORARY ..." | N/A |
| R3 trusted set | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-07 R :: "OK SEC-DEPTH: a clean cluster built by the CREATEROLE migrator, with its ADMIN-only creator memberships and the oracle as platform admin, audits clean"; SEC-08 R :: "DENY SEC-DEPTH: a runtime login granted membership in a trusted role is reported" | N/A |
| R4 Data API logins A6 | N/A | N/A | N/A | GAP SEC-09 R :: "DENY SEC-DEPTH (provisioning): a login whose audit fails inside provision-login is never committed and no secret is written" | N/A | N/A | GAP SEC-10 R :: "DENY SEC-DEPTH (unpooled login): a LOGIN outside every runtime group and the trusted set, with TEMPORARY, is reported" | N/A |
| R5 root routes | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-11 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)"; supplemental (already refused on main) SEC-11s R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a schema or an object in public, kauro or kauro_meta" | N/A |
| R6 trigger audit A3 | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-12 R :: "OK SEC-DEPTH: the internal RI_FKey triggers of every kauro foreign key audit clean"; SEC-13 R :: "DENY SEC-DEPTH: a user trigger with a non-migration function, or a foreign key with ON DELETE CASCADE, is reported" | N/A |
| R7 attempt insert -> attempt_count (0021:684) | GAP SEC-14 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-15 S :: "DENY SEC-DEPTH (nested attempt_count): a depth-2 attempt_count of n+1 with no attempt of that ordinal born now is refused KA080" | GAP SEC-16 S :: "DENY SEC-DEPTH (nested current_attempt_id): a depth-2 current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R8 attempt claim -> job fence (0021:686) | GAP SEC-17 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-18 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence" and SEC-18b S :: "OK SEC-DEPTH: the initial claim of an absent lease is fence 1 and no takeover" | N/A guard | N/A guard | GAP SEC-19 S :: "DENY SEC-DEPTH (nested fence max): a depth-2 fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job"; SEC-19b S :: "DENY SEC-DEPTH (nested fence in range): a depth-2 fence = OLD + 1 with no attempt claimed at it now is refused KA080" | N/A: claim and bookkeeping share one transaction holding the lease row lock (claim_lease FOR UPDATE, 0006:253); SEC-17 proves the wait | N/A guard |
| R9 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-20 S :: "DENY SEC-DEPTH (lease delete): kauro_control cannot DELETE a lease"; SEC-21 S :: "DENY SEC-DEPTH (lease birth): an INSERT above fence 1 is refused and caller heartbeat/created instants are replaced by server_now" | N/A (DENY SEC-20/21) |
| R10 renew/heartbeat | GAP SEC-22 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of one lease, both orders held at the lease row; takeover only after expiry, the stale heartbeat NULL" | N/A | GAP SEC-23 S :: "DENY SEC-DEPTH (lease clock): an UPDATE that shortens expires_at or sets it at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-24 S :: "OK SEC-DEPTH: with the database clock held fixed, a different caller instant passed to the port changes no claim, heartbeat or checkpoint outcome" | GAP SEC-25 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R11 checkpoint | GAP SEC-26 S :: "RACE SEC-DEPTH: checkpoint_lease and a takeover of one expiring lease, both orders held at the lease row; the checkpoint lands only while live and the takeover names it" | N/A | GAP SEC-27 S :: "DENY SEC-DEPTH (expired checkpoint): a direct UPDATE of checkpoint_hash on an expired spending lease is refused"; supplemental SEC-27s S :: "checkpoint_lease on an expired lease returns NULL" (already so on main with honest time) | N/A | N/A | N/A single statement | N/A covered by SEC-25 | N/A |
| R12 carve HOLD (kauro_app) | GAP SEC-28 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, events seq n+1 and n+2, reserved = sum" | N/A guard | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-29 M :: "DENY SEC-DEPTH (nested grant repetition): a second depth-2 increment citing a real carve authorized now is refused KA083"; SEC-30 M :: "DENY SEC-DEPTH (nested grant): reserved_cents raised with no hold event is refused KA083"; SEC-30b M :: "... lowered ..." | GAP SEC-31 M :: "DENY SEC-DEPTH: a hold event for a carve of another pool, another agency, or not authorized now is refused" | N/A (DENY SEC-30); SEC-32 M :: "OK SEC-DEPTH (multi-row): two carves authorized in one UPDATE hold their own ceilings and leave every pool version unchanged" |
| R13 carve RELEASE (kauro_control) | GAP SEC-33 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation of one pool, both orders held at the pool lock; reserved and spend exact" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-34 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | N/A | SEC-35 M :: "OK SEC-DEPTH (multi-row): two carves closed in one UPDATE release their own ceilings and spends" |
| R14 capture -> allocated_cents | GAP SEC-36 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders held at the order lock, allocated = recount" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-37 M :: "DENY SEC-DEPTH (nested allocation): allocated_cents above the recount at commit is refused KP002" | N/A | SEC-38 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R15 owner count (L3) | GAP SEC-39 H :: "RACE SEC-DEPTH: two owner removals, both orders held at the agency row; KA001 and the commit recount hold" | N/A guard | N/A | N/A guard | N/A guard | N/A | GAP SEC-40 H :: "DENY SEC-DEPTH (nested owner count): an inflated active_owner_count is refused at commit KA004" | SEC-41 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R16 recurrence (L3) | GAP SEC-42 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders held at the recurrence advisory lock, count = purchases" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-43 H :: "DENY SEC-DEPTH (nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001" | N/A | SEC-44 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R17 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: every kauro function that reads pg_trigger_depth() is listed with its binding" |

C1 Baseline proof (SDP-06). Must FAIL on 21b310f by showing the forbidden behaviour through base SQL only (the attack path uses no
new helper, function or signature; `nestedAs` is oracle setup of base objects): SEC-01 (retained writer writes after a REVOKE issued
by the oracle), SEC-06a/b/c/e (route accepted by the pool), SEC-10, SEC-11, SEC-15, SEC-16, SEC-19, SEC-19b, SEC-20, SEC-21 (fence
2 accepted), SEC-23, SEC-25, SEC-27, SEC-29, SEC-30, SEC-30b, SEC-37, SEC-40, SEC-43. Supplemental checks that already pass on main
(SEC-11s, SEC-27s) and OK/RACE titles are not counted as baseline failures. Each title is one path.

C2 Caller coverage the N/A-guard cells rely on (unchanged titles):
- leases: packages/persistence/test/adapters-leases.test.ts :: "S090 through the adapter: claim, HELD, checkpoint under the fence,
  refused resumes (no or another checkpoint, reset deadline, another subject, another cost authority), a valid takeover that keeps
  subject, clock, cost and checkpoint identity, advances the fence and fences the old owner out"
- jobs: packages/persistence/test/execution-migrations.test.ts :: "S056 at the database: a staged manifest, a verification or a
  publication of an attempt whose fence is not its job lease's current fence is refused KA080, and an attempt's provider job
  identity is its own deterministic identity, learned once"; apps/control/test/job-execution.test.ts:91 (S056 duplicated admission)
- grants: packages/persistence/test/audit-migrations.test.ts :: "R2-044 at the database: an audit commits only with a reservation
  on an AUTHORIZED, unexpired grant with room under its ceiling, and a dispatch intent is refused KA083 unless its reservation fits a
  funded grant"; apps/control/test/grant-reconciliation.test.ts :: "GRANT_RECONCILIATION keeps an unknown usage reserved, releases
  only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no
  uncertain usage remains"
- allocation: packages/persistence/test/b09-migrations.test.ts :: "R2-140: a second real capture of a paid obligation is recorded
  in full as excess — one entitlement, the basis capped to the obligation" and :278 (S058/S057 allocated once and exactly)
- L3: B06 R2-043 row (B06-case-map.md:160) and B10 `[d27uow]` (B10-failure-matrix.md:702).

## D. Accepted packages touched (A6: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool verification,
aggregate-kinds.test.ts:445; S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331,
execution-migrations :150), R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89,
audit-adapters :286, grant-reconciliation.test.ts:31, b08-end-to-end.test.ts:306); FH-R2 (r6). B09: R2-140 and S058/S057
(b09-migrations.test.ts:278, :307). B10: d27uow via L3. B07: none.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAs`, `depthProbeTable`), src/testing/index.ts | - | 30 min, 60k | claude-sonnet-5-5 |
| L1 root | migrations/0045, src/pool.ts, src/migrations/runtime-audit.ts, tools/deploy/runtime-cutover.mjs, tools/deploy/provision-login.mjs, R, admission-instants, aggregate-kinds, fault-harness tests | R1-R6, R17 | 150 min, 380k | Opus |
| L2a jobs+leases | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R7-R11 | 120 min, 300k | Opus |
| L2b money | migrations/0048, 0049, M | R12-R14 | 100 min, 250k | Opus |
| L3 hardening | migrations/0050, H | R15-R16 | 60 min, 140k | Opus |

Order K -> (L1 || L2a || L2b) -> L3. Done = every GAP rewritten to C with its title; C1 list shown failing on 21b310f (log) and
passing on the branch; full suites green in ci-local (WSL + Windows). Total about 7.7 h agent time, 1.13M tokens.

## F. Decisions and open questions

- Q1 (accepted) kauro_control stays a trusted direct reconciler; future hardening = a uniquely consumed reconciliation fact on the
  B3 event pattern.
- Q2 (accepted) port keeps `now`; every SQL `p_now` overload removed; port removal is a follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn (accepted): per-carve events, no SUM.
- Q4 A5/A6 need the PLATFORM_ADMIN role at each deploy and at each login provisioning: a B14 runbook step, not an owner decision.
- Q5 The AWS provider-role list in A2 is taken from AWS's documented inventory at cutover; an unlisted provider LOGIN fails the
  audit (fail-closed) until recorded as PROVIDER by the migrator, which is the intended behaviour.
