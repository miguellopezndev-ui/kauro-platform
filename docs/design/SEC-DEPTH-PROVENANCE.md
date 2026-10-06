# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r4

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2/r3/r4 answer design reviews 062a982, 9cc894e, 56c873b (r4: SDP-02, 06, 07, 11). Design only.

## 0. Facts established from the code

- F1 Ten guards treat `pg_trigger_depth() >= 2` as "our own trigger wrote this": 0002:143, 0015:98, 0021:466, 0023:158, 0023:453,
  0028:117, 0028:261, 0028:447, 0028:472, 0044:73/96 (0044 already binds to `server_now()` + an admission fact).
- F2 Depth is forgeable: PUBLIC keeps the default `TEMPORARY` on the database (no REVOKE in migrations/; 0001:41 revokes only
  `ON SCHEMA kauro`). Our tests do it as runtime roles: admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464;
  fault-harness.test.ts:1237.
- F3 Routes to depth 2 for a fresh runtime session, inventoried (Codex confirmed the inventory, r3 case D-PROV-1): session objects
  (TEMPORARY), schema CREATE (none granted: USAGE only, 0001:73/78, 0013:45/47, 0028:41/43; PG 17 `public` has no PUBLIC CREATE),
  database CREATE, and TRIGGER privilege on any relation, which attaches an EXISTING function without CREATE (none granted on main:
  0 hits for TRIGGER/ALL grants; but trigger functions keep PUBLIC EXECUTE, only 8 EXECUTE grant/revoke lines exist in
  migrations, e.g. generic `kauro.record_commercial_transition` 0028:94 taking table/column arguments 0028:215). No FK declares
  ON DELETE/UPDATE actions (0 CASCADE/SET in 412 REFERENCES); FKs create internal `RI_FKey_*` triggers (pg_catalog). Identity
  routes: retained sessions (pool caches verification per connection, src/pool.ts:164, :190), direct grants to a LOGIN, SET ROLE
  reachability, logins outside the pool (Aurora Data API, authority r2 A9_CLOUD_AWS).
- F4 Finding 1 also has a route with no temp object: kauro_control holds DELETE on leases (0006:374, policy 0006:366) and leases have
  no INSERT guard (0006:202-229 is BEFORE UPDATE). Delete + insert the JOB_ATTEMPT lease at fence 2^63-1, claim a new attempt
  (0021:637; `attempt_owns_lease` ignores expiry, 0021:265-279) and the real bookkeeping (0021:686) copies it to the job;
  `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79 `Number.isSafeInteger`) then throws for every reader.
- F5 Finding 3 needs no nesting: kauro_control UPDATEs leases directly; takeover compares caller-written `NEW.heartbeat_at` with
  `OLD.expires_at` (0006:213); expires_at/checkpoint_hash otherwise unguarded; claim/heartbeat/checkpoint take `p_now` (0006:239-320).
- F6 Finding 2: kauro_app has UPDATE(reserved_cents) (0023:1043) because the per-row AFTER writer `cost_grants_pool_hold`
  (0023:212-227) runs as invoker; `cost_grants_tenant_pool_hold` (0023:940-942) admits any AUTHORIZED pool. kauro_control closes
  AUDIT grants (apps/control/src/audit/grants.ts:96), so RELEASE runs as kauro_control; it also reconciles at depth 1 by design
  (0023:154-160; src/audit/store.ts:595). `cost_grants_version` (0023:115-116) exempts only reserved/reconciled cents.
- F7 0015:98: kauro_payment has UPDATE(allocated_cents) (0015:909); single legit writer `capture_facts_allocate` (0015:420-452), one
  capture per AFTER ROW invocation (0015:446); policy 0015:875-876 scopes kauro_payment to the current agency.
- F8 Writer timing: `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) BEFORE inserting the purchase
  (0028:517); `maintain_active_owner_count` adds +-1 per membership row (0002:329-355). Only commit-time recounts fit them.
- F9 Roles: the test DB is owned by the migrator, a LOGIN CREATEROLE non-superuser (temporary-postgres.ts:150-151) that creates the
  runtime groups (0001:44-60); PG 16+ records the creator as a member with ADMIN TRUE, INHERIT FALSE, SET FALSE. kauro_meta USAGE is
  granted only to app, control (0001:78), payment (0013:47), commission (0028:43); all seven groups have USAGE on kauro. The migrator
  holds neither pg_signal_backend nor pg_read_all_stats. RDS/Aurora ship provider roles (rdsadmin LOGIN, rds_superuser, rds_*).

## A. Root cause: no runtime identity can create, attach or keep an executable object (D-PROV-1)

A1 Migration `0045_runtime_no_session_objects.sql` (migrator):
- `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and from each runtime group; `REVOKE CREATE ON SCHEMA public FROM
  PUBLIC`; `REVOKE EXECUTE` FROM PUBLIC on every function returning `trigger` in kauro (loop over pg_proc, prorettype =
  'trigger'::regtype). Firing a trigger does not check EXECUTE; CREATE TRIGGER does, so attachment needs EXECUTE + TRIGGER and both
  are now absent for runtime identities. No runtime code calls a trigger function directly (they cannot be called).
- `kauro_meta.trusted_identities (role_oid oid PK, role_name, kind MIGRATOR|PLATFORM_ADMIN|PROVIDER, recorded_at)`, no grant to any
  other role. Seeded IN 0045, before its self-check: the database owner (`pg_database.datdba`, MIGRATOR); oid 10 (PROVIDER); every
  existing role of AWS's documented provider inventory (rdsadmin, rds_superuser, rds_password, rds_replication, rds_iam, rds_ad,
  rdstopmgr, rds_reserved) as PROVIDER; every superuser and every member of rds_superuser as PLATFORM_ADMIN; a role that is a member
  of any runtime group is never seeded. Later rows only via `kauro_meta.trust_identity(role, kind)` (migrator-only EXECUTE).
- `kauro_meta.trigger_inventory (relid, tgname, tgtype, tgfoid, tgargs, tgattr, tgqual_md5, tgdeferrable, tginitdeferred,
  tgenabled)` and migrator-only `kauro_meta.record_trigger_inventory()`, which snapshots every `NOT tgisinternal` pg_trigger row
  of the database. Called by 0045 and by the migration runner after each apply (src/migrations/runner.ts:298 `applyMigrationsAs`),
  inside the migrator's connection. Sound because at those instants no runtime identity can create a trigger (this section) and
  the cutover (A5) has removed retained sessions; test fixtures that add owner-made triggers re-record or drop them.
- `kauro.runtime_identity_audit()` returns violation rows; 0045 RAISEs if it returns any. Decision (SDP-07): SECURITY DEFINER,
  owned by the migrator, `SET search_path = pg_catalog`, STABLE, no arguments, read-only, every object schema-qualified; EXECUTE
  revoked from PUBLIC and granted to the seven runtime groups (readiness) and to PLATFORM_ADMIN roles (cutover). Justification:
  invoker would need SELECT on trusted_identities/trigger_inventory and kauro_meta USAGE for assurance/validator/ingress (F9),
  widening runtime read access to trust data; a definer with no input, no write and a pinned path exposes only the violation list.
  It is placed in schema kauro (USAGE for all seven groups). It is not a trigger function and cannot be attached.
- Not chosen: revoking plpgsql USAGE (no schema to create in; breaks harness DO blocks, fault-harness.test.ts:1230/:1246); a
  definer-based writer provenance (FORCE RLS binds the owner, 0001:28).
A2 Identity model. Trusted T = trusted_identities. Runtime seeds G = the seven groups. Runtime identities R = G, plus every role
holding a membership in a G role with INHERIT or SET (direct or transitive), plus every LOGIN not in T (each Data API secret user),
plus every role any of these reaches by INHERIT or SET. A membership with ADMIN TRUE, INHERIT FALSE, SET FALSE held by a T role
(the PG 16+ creator grant, F9) confers nothing and does not make the holder runtime. Violations:
- any R identity reaches a T role, or is superuser/createrole/createdb/bypassrls/replication, or a member of pg_signal_backend,
  pg_write_all_data, pg_read_server_files, pg_write_server_files, pg_execute_server_program, pg_create_subscription, pg_maintain;
- any R identity, as itself or via PUBLIC (`aclexplode` of datacl, nspacl, relacl, proacl): TEMPORARY or CREATE on the database;
  CREATE on any schema; TRIGGER on any relation of any schema (`has_table_privilege(r, c.oid, 'TRIGGER')` covers inherited);
  EXECUTE on any function returning trigger; ownership of a schema, the database, a relation, a function or a type;
- a LOGIN in R is not a member of exactly one G group (with INHERIT) and of nothing else.
A3 Object audit: zero relations, functions, types in any `pg_temp_%`/`pg_toast_temp_%` namespace. Every user trigger
(`NOT tgisinternal`) on ANY relation of the database must equal one trigger_inventory row on all recorded columns (table, name,
timing/events via tgtype, function, arguments, column list, WHEN clause, deferrability, enabled state); an extra, missing or altered
trigger is a violation. An internal trigger is accepted only when its `tgconstraint` is a `pg_constraint` of `contype = 'f'` on that
table or its referenced table, its function is an `RI_FKey_*` function in pg_catalog owned by oid 10, and that constraint has
`confupdtype` and `confdeltype` in ('a','r').
A4 Pool (src/pool.ts:100-105, 159-190): VERIFY_SQL runs the A2 per-identity clauses for `current_user` and refuses the connection;
`maxLifetimeSeconds: 600` so each connection re-verifies at least every 10 minutes.
A5 Cutover (B14 runbook; `tools/deploy/runtime-cutover.mjs` as a PLATFORM_ADMIN role holding pg_signal_backend + pg_read_all_stats, on
RDS/Aurora the master user; in tests the superuser oracle): 1. stop runtime work (services and Data API callers scaled to zero,
ingress 503); 2. `pg_terminate_backend(pid, 5000)` for every R backend, then poll `pg_stat_activity` every 250 ms for at most 30 s;
on timeout STOP fail-closed (runtime stays down, pids reported); record instant T; 3. migrator applies migrations; 4.
`kauro.runtime_identity_audit()` plus the backend clause (no R backend with `backend_start < T`, plain SQL in the tool); any row ->
stop; 5. start runtime; readiness calls the audit every 5 minutes and fails the service on any row (detection only).
A6 Login provisioning (SDP-02, Data API): `tools/deploy/provision-login.mjs`, idempotent by login name, run by the migrator plus an AWS
deploy principal; three durable effects in this order:
1. DB transaction: `CREATE ROLE <login> LOGIN PASSWORD <generated> IN ROLE <one group>` (or, if it exists, `ALTER ROLE ... PASSWORD`
   after checking it is in exactly that group), `kauro.runtime_identity_audit()`, COMMIT only when clean;
2. a fresh audit in a new transaction, then `PutSecretValue` (secret id derived from the login name; overwrites on retry);
3. publish the Data API caller's IAM policy: the statement's resource set is exactly the registered runtime secret ARNs
   (`deploy/runtime-secrets.json`); the tool refuses a set containing any trusted/admin secret ARN.
Crash after 1: the role exists, its password is unknown to anyone, no secret, no IAM: no usable credential; a rerun resets the
password and continues. Crash after 2: a secret no runtime caller can read (IAM not yet published); a rerun overwrites it and
publishes. Failure at 3: same state; rerun. `--revoke <login>` drops IAM entry, secret and role in reverse order. A LOGIN created
any other way is untrusted, audited as R and fails readiness. Provisioning creates the database `OWNER <migrator>`.
A7 Existing tests that create session objects as a runtime role keep their assertions (Codex agreed): admission-instants :218-250
and :266-286 run through the kit's `nestedAs` (oracle-made SECURITY INVOKER function + probe table in schema `depth_probe`, INSERT
on the ORIGINAL runtime connection and context; for :266-286 the oracle attaches the production deferred guard itself; the probe
asserts `current_user` and `pg_trigger_depth()`; probe objects dropped in finally); aggregate-kinds :445-470 part (1) on a separate
direct login granted TEMPORARY by the oracle, closed and revoked in finally, plus a 42501 assertion on the pooled login;
fault-harness :1232-1239 uses an oracle-made `fault_probe.fault_undo_clock()`.

## B. Defence in depth: each value bound to its producing fact

B1 processing_jobs (D-PROV-2; Codex agreed), `0046_job_fence_provenance.sql`, faithful copy of 0021:418-528 with only 0021:465-468
replaced: attempt_count/current_attempt_id change needs depth >= 2, `NEW.attempt_count = OLD.attempt_count + 1` and an attempt
(agency, job, `attempt_id = NEW.current_attempt_id`, `ordinal = NEW.attempt_count`, created_at = server_now()); fence change needs
`NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`, that attempt CLAIMED at `fence = NEW.fence` with
claimed_at = server_now(), and `attempt_owns_lease`. CHECK `<= 9007199254740991` on processing_jobs.fence/attempt_count,
processing_attempts.fence, leases.fence (ADD NOT VALID; VALIDATE). jobRecord stays fail-closed.
B2 leases (D-PROV-3; Codex: fixed), `0047_lease_server_clock.sql`; `now` = `kauro.server_now()` (transaction clock, D-CLOCK-1):
- INSERT: fence must be 1; heartbeat_at, created_at, updated_at NORMALISED to now; `now < expires_at <= deadline_at` else refused.
- DELETE: refused KA005; `REVOKE DELETE ON kauro.leases FROM kauro_control` (no caller: `DELETE FROM kauro.leases` 0 hits).
- UPDATE changing heartbeat_at, expires_at, checkpoint_hash, owner or fence: `NEW.heartbeat_at = now` (KA005 LEASE_CLOCK) and
  `NEW.expires_at > now`. Same owner+fence: `OLD.expires_at > now`, `NEW.expires_at >= OLD.expires_at`; a checkpoint change also
  needs `NEW.checkpoint_hash IS NOT NULL`. Takeover: `OLD.expires_at <= now`, fence + 1, checkpoint rules 0006:216-224 unchanged.
- claim/heartbeat/checkpoint: every old `p_now` overload DROPPED, new signatures without it. Callers: src/lease-store.ts:75/91/96,
  src/audit/store.ts:488, src/execution/store.ts:456/620. The port keeps `now`, ignored by PgLeaseStore, documented (Q2).
B3 cost_grants pool holds (D-PROV-4; Codex: fixed in r3), `0048_grant_hold_events.sql`:
- `kauro.cost_grant_hold_events (carve_grant_id, kind HOLD|RELEASE, pool_grant_id, agency_id, seq, cents, spend_cents,
  recorded_at)`, PK (carve_grant_id, kind), UNIQUE (pool_grant_id, seq), append-only. RLS: kauro_app INSERT/SELECT own agency and
  `kind = 'HOLD'`; kauro_control INSERT `kind = 'RELEASE'`, SELECT all. INSERT guard: carve is an AUDIT grant of this pool and agency;
  HOLD needs carve AUTHORIZED, authorized_at = now, `cents = ceiling`; RELEASE needs carve CLOSED, closed_at = now, `cents =
  ceiling`, `spend_cents = carve.reconciled_spend_cents`; `seq = pool.hold_seq + 1` under the pool row lock; recorded_at := now.
- cost_grants.hold_seq `bigint NOT NULL DEFAULT 0 CHECK (>= 0)`, born 0, stays 0 on AUDIT grants; `GRANT UPDATE (hold_seq)` to
  kauro_app and kauro_control; `cost_grants_version` re-created exempting `reserved_cents,reconciled_spend_cents,hold_seq`.
- writer `cost_grants_pool_hold` (copy of 0023:212-227): pool `FOR UPDATE`, insert event, `UPDATE pool SET hold_seq = hold_seq + 1`
  with +cents (HOLD, kauro_app) or -cents and +spend_cents (RELEASE, kauro_control).
- pool guard (copy of 0023:125-205, 0023:155-160 replaced): any hold_seq change needs `NEW.hold_seq = OLD.hold_seq + 1` and the
  event (pool, NEW.hold_seq) recorded now with equal deltas; a non-control session moves no reservation without one. The
  request_journal branch (0023:262-288) and control reconciliation (store.ts:595) are unchanged (Q1).
B4 payment_orders (D-PROV-5), `0049_allocation_recount.sql`: immediate guard (0015:91-106) keeps depth + monotonicity; a DEFERRABLE
INITIALLY DEFERRED constraint trigger AFTER UPDATE OF allocated_cents uses NEW only to identify (agency_id, order_id), RE-SELECTS the
final row and requires `allocated_cents = coalesce(Σ(allocated_service_cents + allocated_tax_cents), 0)` over the order's
capture_facts with status IN ('COMPLETED','REVERSED'), KP002.
B5 L3, `0050_owner_recurrence_recount.sql`, deferred, NEW identifies the parent, final row re-selected: `active_owner_count` = count
of ACTIVE OWNER memberships (KA004; KA001 at 0002:349 stays immediate); `agency_recurrence.confirmation_count` = count and max
(confirmation_seq) of the agency's qualifying_purchases, first_* = the seq-1 purchase (KC001); the purchase INSERT checks its
authorization row was born in this transaction (column named by the L3 designer from 0028; KC001).
B6 Catalog gate (D-PROV-6): every kauro function whose prosrc reads `pg_trigger_depth` is in the test's allowlist with its binding
(fact, deferred recount, or D-PROV-1 only: 0023:453, 0028:117, 0028:261, 0028:472).

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
R = `.../sec-depth-root.test.ts`, H = `.../sec-depth-hardening.test.ts`, P = `tools/deploy/test/provision-login.test.ts`. All GAP
cells are tier 1. P uses real Postgres and fake Secrets Manager/IAM ports (AWS half SIMULATED; EXECUTED_LOCAL at B14).

N/A "guard" (SDP-06): the change is a predicate inside the caller's statement and adds no write, no COMMIT, no port call and no new
lock, so it cannot change the caller's crash, retry or timeout behaviour; whether that behaviour is proven belongs to the caller's
own package matrix and is NOT claimed here. Where this lane adds a lock (B3 pool `FOR UPDATE`) or commit-time work (B4/B5 deferred
recounts) the cell is a GAP below. A row lock alone is never a race proof (rule 1).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 cutover A5 | GAP SEC-01 R :: "RACE SEC-DEPTH (retained session): a runtime connection opened before the revoke keeps a pg_temp nested writer; the cutover terminates it and the audit reports nothing after" | GAP SEC-02 R :: "RACE SEC-DEPTH (cutover timeout): a backend that outlives the 30 s termination bound stops the cutover fail-closed and runtime stays down" | N/A no deadline | GAP SEC-03 R :: "DENY SEC-DEPTH (release): 0045 aborts and records no ledger row when an audited identity keeps TEMPORARY" | GAP SEC-04 R :: "RACE SEC-DEPTH (cutover crash after migrate): a re-run cutover terminates, skips applied migrations and audits clean" | N/A covered by SEC-04 | GAP SEC-05 R :: "DENY SEC-DEPTH (readiness): a privilege granted to a live login fails readiness and the next verification of its connection" | N/A guard |
| R2 identities A2/A4 | N/A per-connection check | N/A | N/A | N/A read-only | N/A | N/A | GAP SEC-06a-g R, one test each: "DENY SEC-DEPTH (identity): a pooled login with a direct TEMPORARY grant is refused and reported" / "... with CREATE on an extra schema ..." / "... with database CREATE ..." / "... owning a schema ..." / "... able to SET ROLE into a NOINHERIT role holding TEMPORARY ..." / "... with TRIGGER on a table of an extra schema ..." / "... with EXECUTE on a kauro trigger function ..." | N/A |
| R3 trusted set + audit caller | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-07 R :: "OK SEC-DEPTH: a clean cluster built by the CREATEROLE migrator audits clean when the audit is called by each of the seven runtime logins, the migrator and the platform admin"; SEC-08 R :: "DENY SEC-DEPTH: a runtime login granted membership in a trusted role is reported" | N/A |
| R4 provisioning A6 | GAP SEC-09 P :: "RACE SEC-DEPTH (provisioning): two runs for one login, held after the role COMMIT, end with one role, one secret and one IAM entry" | GAP SEC-10 P :: "RACE SEC-DEPTH (provisioning timeout): a Secrets Manager call past its bound leaves no IAM entry and a rerun completes" | N/A | GAP SEC-11 P :: "DENY SEC-DEPTH (provisioning): a login whose audit fails is never committed and no secret is written" | GAP SEC-12 P :: "RACE SEC-DEPTH (crash after role COMMIT): no usable credential exists; a rerun resets the password, writes the secret and publishes IAM"; SEC-13 P :: "RACE SEC-DEPTH (crash after secret write): the secret is unreadable to runtime callers until a rerun publishes IAM" | GAP SEC-14 P :: "OK SEC-DEPTH: a rerun of a completed provisioning creates no second role, secret or IAM statement" | GAP SEC-15 P :: "DENY SEC-DEPTH: an IAM resource set naming a trusted or admin secret is refused" ; SEC-16 R :: "DENY SEC-DEPTH (unpooled login): a LOGIN outside every runtime group and the trusted set, with TEMPORARY, is reported" | GAP SEC-17 P :: "RACE SEC-DEPTH (partial): an IAM publication failure leaves role and secret unusable and --revoke removes all three" |
| R5 root routes | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-18 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)"; supplemental SEC-18s R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a schema or an object in public, kauro or kauro_meta" | N/A |
| R6 trigger audit A3 | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-19 R :: "OK SEC-DEPTH: every migration trigger matches the inventory and the internal RI_FKey triggers audit clean"; SEC-20 R :: "DENY SEC-DEPTH: record_commercial_transition attached by an owner-made trigger to a table of another schema is reported"; SEC-21 R :: "DENY SEC-DEPTH: an inventoried trigger with altered arguments, events or enabled state is reported"; SEC-22 R :: "DENY SEC-DEPTH: a foreign key with ON DELETE CASCADE is reported" | N/A |
| R7 attempt insert -> attempt_count (0021:684) | GAP SEC-23 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-24 S :: "DENY SEC-DEPTH (nested attempt_count): a depth-2 attempt_count of n+1 with no attempt of that ordinal born now is refused KA080" | GAP SEC-25 S :: "DENY SEC-DEPTH (nested current_attempt_id): a depth-2 current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R8 attempt claim -> job fence (0021:686) | GAP SEC-26 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-27 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence"; SEC-27b S :: "OK SEC-DEPTH: the initial claim of an absent lease is fence 1 and no takeover" | N/A guard | N/A guard | GAP SEC-28 S :: "DENY SEC-DEPTH (nested fence max): a depth-2 fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job"; SEC-28b S :: "DENY SEC-DEPTH (nested fence in range): a depth-2 fence = OLD + 1 with no attempt claimed at it now is refused KA080" | N/A: claim and bookkeeping share one transaction holding the lease row lock (claim_lease FOR UPDATE, 0006:253); SEC-26 proves the wait | N/A guard |
| R9 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-29 S :: "DENY SEC-DEPTH (lease delete): kauro_control cannot DELETE a lease"; SEC-30 S :: "DENY SEC-DEPTH (lease birth): an INSERT above fence 1 is refused and caller heartbeat/created instants are replaced by server_now" | N/A (DENY SEC-29/30) |
| R10 renew/heartbeat | GAP SEC-31 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of one lease, both orders held at the lease row; takeover only after expiry, the stale heartbeat NULL" | N/A | GAP SEC-32 S :: "DENY SEC-DEPTH (lease clock): an UPDATE that shortens expires_at or sets it at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-33 S :: "OK SEC-DEPTH: with the database clock held fixed, a different caller instant passed to the port changes no claim, heartbeat or checkpoint outcome" | GAP SEC-34 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R11 checkpoint | GAP SEC-35 S :: "RACE SEC-DEPTH: checkpoint_lease and a takeover of one expiring lease, both orders held at the lease row; the checkpoint lands only while live and the takeover names it" | N/A | GAP SEC-36 S :: "DENY SEC-DEPTH (expired checkpoint): a direct UPDATE of checkpoint_hash on an expired spending lease is refused"; supplemental SEC-36s S :: "checkpoint_lease on an expired lease returns NULL" | N/A | N/A | N/A single statement | N/A covered by SEC-34 | N/A |
| R12 carve HOLD (kauro_app) | GAP SEC-37 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, events seq n+1 and n+2, reserved = sum" | GAP SEC-38 M :: "RACE SEC-DEPTH (timeout): a carve authorization waiting on the pool lock past its statement timeout rolls back with no event, no hold and the carve PREPARED" | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-39 M :: "DENY SEC-DEPTH (nested grant repetition): a second depth-2 increment citing a real carve authorized now is refused KA083"; SEC-40 M :: "DENY SEC-DEPTH (nested grant): reserved_cents raised with no hold event is refused KA083"; SEC-40b M :: "... lowered ..." | GAP SEC-41 M :: "DENY SEC-DEPTH: a hold event for a carve of another pool, another agency, or not authorized now is refused" | SEC-42 M :: "OK SEC-DEPTH (multi-row): two carves authorized in one UPDATE hold their own ceilings and leave every pool version unchanged" |
| R13 carve RELEASE (kauro_control) | GAP SEC-43 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation of one pool, both orders held at the pool lock; reserved and spend exact" | N/A same lock as SEC-38, taken by control | N/A | N/A guard | N/A guard | GAP SEC-44 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | N/A | SEC-45 M :: "OK SEC-DEPTH (multi-row): two carves closed in one UPDATE release their own ceilings and spends" |
| R14 capture -> allocated_cents | GAP SEC-46 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders held at the order lock, allocated = recount" | N/A recount adds no lock | N/A | GAP SEC-47 M :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no capture, allocation or event of the transaction" | N/A guard | GAP SEC-48 M :: "DENY SEC-DEPTH (nested allocation): allocated_cents above the recount at commit is refused KP002" | N/A | SEC-49 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R15 owner count (L3) | GAP SEC-50 H :: "RACE SEC-DEPTH: two owner removals, both orders held at the agency row; KA001 and the commit recount hold" | N/A | N/A | GAP SEC-51 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves the membership change unapplied" | N/A guard | N/A | GAP SEC-52 H :: "DENY SEC-DEPTH (nested owner count): an inflated active_owner_count is refused at commit KA004" | SEC-53 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R16 recurrence (L3) | GAP SEC-54 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders held at the recurrence advisory lock, count = purchases" | N/A | N/A | GAP SEC-55 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no purchase, recurrence or consumption" | N/A guard | GAP SEC-56 H :: "DENY SEC-DEPTH (nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001" | N/A | SEC-57 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R17 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: every kauro function that reads pg_trigger_depth() is listed with its binding" |

C1 Baseline proof. Must FAIL on 21b310f by showing the forbidden behaviour through base SQL only (the attack path uses no new
helper, function or signature; `nestedAs` and grants are oracle setup of base objects; for identity routes the test grants the
route and asserts the pool accepts the connection and the route works): SEC-01, SEC-06a-g, SEC-16, SEC-18, SEC-20 (the attached
writer records a fabricated history row), SEC-24, SEC-25, SEC-28, SEC-28b, SEC-29, SEC-30, SEC-32, SEC-34, SEC-36, SEC-39, SEC-40,
SEC-40b, SEC-48, SEC-52, SEC-56. Supplemental checks that already pass on main (SEC-18s, SEC-36s), OK, RACE and the P tests of new
tooling are not counted as baseline failures. Each title is one path.

C2 Caller references (context only, not claimed as coverage by this lane): leases adapters-leases.test.ts:32; jobs
execution-migrations.test.ts:261 and apps/control/test/job-execution.test.ts:91; grants audit-migrations.test.ts:89 and
apps/control/test/grant-reconciliation.test.ts:31; allocation b09-migrations.test.ts:278, :307; L3 B06-case-map.md:160 and
B10-failure-matrix.md:702. A6 re-verification (section D) re-runs them unchanged.

## D. Accepted packages touched (A6: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool verification,
aggregate-kinds.test.ts:445; S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331,
execution-migrations :150), R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89,
audit-adapters :286, grant-reconciliation.test.ts:31, b08-end-to-end.test.ts:306); FH-R2 (r6). B09: R2-140, S058/S057
(b09-migrations.test.ts:278, :307). B10: d27uow via L3 and every 0028 trigger (EXECUTE revoke, A1). B07: none.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAs`, `depthProbeTable`), src/testing/index.ts | - | 30 min, 60k | claude-sonnet-5-5 |
| L1 root | migrations/0045, src/pool.ts, src/migrations/runner.ts (inventory call), src/migrations/runtime-audit.ts, tools/deploy/runtime-cutover.mjs, R, admission-instants, aggregate-kinds, fault-harness tests | R1-R3, R5, R6, R17 | 170 min, 420k | Opus |
| L1b provisioning | tools/deploy/provision-login.mjs, deploy/runtime-secrets.json, P | R4 | 60 min, 140k | Opus |
| L2a jobs+leases | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R7-R11 | 120 min, 300k | Opus |
| L2b money | migrations/0048, 0049, M | R12-R14 | 100 min, 250k | Opus |
| L3 hardening | migrations/0050, H | R15-R16 | 60 min, 140k | Opus |

Order K -> (L1 || L2a || L2b) -> L1b -> L3. Done = every GAP rewritten to C with its title; C1 shown failing on 21b310f (log) and
passing on the branch; full suites green in ci-local (WSL + Windows). Total about 9 h agent time, 1.31M tokens.

## F. Decisions and open questions

- Q1 (accepted) kauro_control stays a trusted direct reconciler; future hardening = a consumed reconciliation fact (B3 pattern).
- Q2 (accepted) port keeps `now`; every SQL `p_now` overload removed; port removal is a follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn (accepted): per-carve events, no SUM.
- Q4 A5/A6 need the PLATFORM_ADMIN role and an AWS deploy principal at each deploy and login provisioning: a B14 runbook step.
- Q5 An unlisted provider LOGIN fails the audit (fail-closed) until the migrator records it via `trust_identity`: intended.
- Q6 SECURITY DEFINER for the audit (A1) is the one definer in this design; its safety rests on no input, no write, pinned path,
  schema-qualified reads, and it is covered by SEC-07 called from all nine identities.
