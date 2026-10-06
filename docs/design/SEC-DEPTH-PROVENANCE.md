# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r5

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2-r6 answer design reviews 062a982, 9cc894e, 56c873b, a6ccbf7, 00a19e3 (r6: SDP-15 parameter/routine authority, SDP-16 credential adoption, SDP-13 provisioning recovery; nothing else changed). r5 steps back on the identity
family (SDP-02/07/11/12/13/14, four rounds): section A is redesigned as a closed allowlist of SHAPES built only by our own tools,
instead of an audit of arbitrary PostgreSQL roles. Sections B (bindings) and the FIXED rows are unchanged.

## 0. Facts established from the code

- F1 Ten guards treat `pg_trigger_depth() >= 2` as "our own trigger wrote this": 0002:143, 0015:98, 0021:466, 0023:158, 0023:453,
  0028:117, 0028:261, 0028:447, 0028:472, 0044:73/96 (0044 already binds to `server_now()` + an admission fact).
- F2 Depth is forgeable: PUBLIC keeps the default `TEMPORARY` on the database (no REVOKE in migrations/; 0001:41 revokes only
  `ON SCHEMA kauro`). Our tests do it as runtime roles: admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464;
  fault-harness.test.ts:1237.
- F3 Routes to depth 2 (inventory confirmed by Codex r3/r4 case D-PROV-1): session objects (TEMPORARY), schema or database CREATE,
  and TRIGGER on a relation (attaches an EXISTING function, e.g. generic `kauro.record_commercial_transition` 0028:94/215; kauro
  trigger functions keep PUBLIC EXECUTE, only 8 EXECUTE grant/revoke lines in migrations). Every one of them is a privilege held
  by the session's identity, by an identity it reaches (membership INHERIT/SET, or ADMIN to grant itself one), or by PUBLIC, plus
  objects retained by a session opened earlier. No FK declares ON DELETE/UPDATE actions (0 CASCADE/SET in 412 REFERENCES).
- F4 Finding 1 also has a route with no temp object: kauro_control holds DELETE on leases (0006:374, policy 0006:366), leases have no
  INSERT guard (0006:202-229 is BEFORE UPDATE); delete + insert at fence 2^63-1, claim (0021:637; `attempt_owns_lease` ignores expiry,
  0021:265-279), bookkeeping (0021:686) copies it; `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79) throws.
- F5 Finding 3 needs no nesting: takeover compares caller-written `NEW.heartbeat_at` with `OLD.expires_at` (0006:213); claim,
  heartbeat and checkpoint take `p_now` (0006:239-320).
- F6 Finding 2: kauro_app UPDATE(reserved_cents) (0023:1043) for the invoker writer `cost_grants_pool_hold` (0023:212-227); policy
  0023:940-942 admits any AUTHORIZED pool; kauro_control closes AUDIT grants (apps/control/src/audit/grants.ts:96) and reconciles at
  depth 1 by design (0023:154-160; src/audit/store.ts:595); `cost_grants_version` (0023:115-116) exempts only the two cents columns.
- F7 0015:98: kauro_payment UPDATE(allocated_cents) (0015:909); writer `capture_facts_allocate` adds one capture per AFTER ROW
  invocation (0015:420-452); policy 0015:875-876 scopes kauro_payment to its agency.
- F8 `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) before the purchase insert (0028:517);
  `maintain_active_owner_count` adds +-1 per row (0002:329-355): only commit-time recounts fit them.
- F9 The migrator (database owner, LOGIN CREATEROLE non-superuser, temporary-postgres.ts:150-151) creates the seven groups
  (0001:44-60, 0013:36, 0028:32); PG 16+ records it as their member with ADMIN TRUE, INHERIT FALSE, SET FALSE. Runtime transactions
  run under `SET LOCAL statement_timeout` (src/runtime-transaction.ts:56, default 5 000 ms at :23), and COMMIT (with its deferred
  triggers) is a statement under that bound.

## A. Root cause: runtime identities have one fixed shape; nothing else is reachable (D-PROV-1)

A1 Shapes (the only thing the audit checks; anything else is a violation, nothing is classified):
- RUNTIME GROUP: exactly the seven named groups. NOLOGIN, no attribute (superuser, createrole, createdb, bypassrls, replication),
  member of NO role (no pg_auth_members row with `member = group`, whatever its options, so no INHERIT, SET or ADMIN edge leaves a
  group), owns nothing. Rows with `roleid = group` are allowed only for its runtime logins (below) and for the ADMIN-only creator
  edge of the database owner (`member = datdba`, ADMIN TRUE, INHERIT FALSE, SET FALSE, F9).
- RUNTIME LOGIN: every role that has any membership in a runtime group. LOGIN, INHERIT, no attribute, exactly ONE pg_auth_members
  row as member: (that group, ADMIN FALSE, INHERIT TRUE, SET TRUE); rows with `roleid = login` only for the database owner's
  ADMIN-only creator edge; owns nothing.
- PUBLIC: no TEMPORARY or CREATE on the database, no CREATE on any schema, no TRIGGER on any relation.
- Privileges of a group or login (each checked with `has_database_privilege`, `has_schema_privilege`, `has_table_privilege`,
  which resolve NULL ACL defaults and include PUBLIC): no TEMPORARY or CREATE on the database, no CREATE on any schema, no TRIGGER
  on any relation of any schema, no EXECUTE on any function in schema kauro returning `trigger`.
- Configuration and routine authority (SDP-15): no row of `pg_parameter_acl` may grant SET or ALTER SYSTEM on ANY parameter to a
  runtime group, a runtime login or PUBLIC (`aclexplode(paracl)`; the shape needs none, so the rule is absolute, not a list of
  dangerous parameters); no `pg_db_role_setting` row for the database (setrole 0) or for a runtime group or login may set
  `session_replication_role`; and outside schemas kauro and kauro_meta a runtime group or login holds NO direct ACL entry on any
  function, relation, schema, large object or foreign object (only CONNECT on the database and USAGE on kauro/kauro_meta), while
  PUBLIC holds no EXECUTE on the superuser-default file routines (`lo_import(text)`, `lo_import(text,oid)`, `lo_export(oid,text)`,
  `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`, every overload; `has_function_privilege` per overload).
  Why replica mode is the whole family: `session_replication_role` is superuser-context, so a non-superuser changes it only through
  a SET grant in pg_parameter_acl (PG 15+) or an admin-made database/role setting, both now shape violations; the pool also asserts
  `current_setting('session_replication_role') = 'origin'` per connection. The other trigger bypasses need ownership or superuser,
  which the shapes forbid: `ALTER TABLE ... DISABLE TRIGGER` (table owner; all kauro tables are migrator-owned, 0001:28),
  `ALTER SYSTEM` (superuser or an ALTER SYSTEM parameter grant, covered above), dropping or replacing a trigger/function (owner).
  `SET CONSTRAINTS ... IMMEDIATE` only moves a deferred check earlier; it cannot skip it.
Why this closes the family by construction: from a runtime login the reachable identities are {login, its group, PUBLIC}; none can
create a session object, create or attach a trigger, or grant itself anything (no ADMIN edge leaves a runtime identity, SDP-14).
Logins outside a runtime group are not runtime and are irrelevant: no runtime session can reach them and no runtime caller is
given their credentials (A5). pg_catalog trigger functions (e.g. `suppress_redundant_updates_trigger()`) keep PUBLIC EXECUTE and are
out of scope: attaching anything needs TRIGGER, which no reachable identity holds (SDP-12).
A2 Migration `0045_runtime_no_session_objects.sql` (migrator): `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and from
each group; `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE EXECUTE ... FROM PUBLIC` on every kauro function returning trigger
(owner-resolved: `aclexplode(coalesce(proacl, acldefault('f', proowner)))`). The migration runner (src/migrations/runner.ts, apply
loop; `applyMigrationsAs` :298) repeats that kauro trigger-function revoke at the end of EVERY later migration, in the migration's
own transaction, so new trigger functions (B4/B5 recounts included) never keep PUBLIC EXECUTE. 0045 also revokes every
`pg_parameter_acl` grant to PUBLIC or a runtime role (`REVOKE SET, ALTER SYSTEM ON PARAMETER <p> FROM ...`, loop over aclexplode;
only the database owner or a superuser can, so a remaining row makes the self-check fail), then calls the audit and RAISEs on any
row.
A3 Declared triggers (SDP-11): `kauro_meta.declared_triggers (relation text, tgname text, definition text, enabled char, migration
int)`, PK (relation, tgname), written ONLY by migrations, each in the same transaction as its CREATE TRIGGER. Bootstrap for
0001-0044 (already applied, checksums frozen): 0045 inserts literal rows from `migrations/declared-triggers-0044.sql`, a generated
file committed to the repo and produced from a FRESH cluster migrated to 0044 (never from a live database) as `pg_get_triggerdef`
text of every `NOT tgisinternal` trigger. A CI test re-generates it on a fresh cluster and fails on any difference; another fails
when a fresh cluster at head has a user trigger with no declared row (a migration forgot its insert). The audit: every user
trigger of the database (all schemas) must have a declared row with identical `pg_get_triggerdef` and `tgenabled`, and every
declared row must exist; a trigger attached before cutover is unexplained and fails the audit before runtime starts. Internal
triggers: unchanged FIXED rule (only `RI_FKey_*` in pg_catalog owned by oid 10 for a `contype = 'f'` constraint of that table with
`confupdtype`/`confdeltype` in ('a','r')). Temporary namespaces: no relation, function or type in any `pg_temp_%`/`pg_toast_temp_%`.
A4 Audit function: `kauro.runtime_identity_audit()` SECURITY DEFINER owned by the migrator, `SET search_path = pg_catalog`, STABLE,
no arguments, read-only (FIXED r3). EXECUTE revoked from PUBLIC, granted to the seven groups (readiness) only; the migrator owns it.
No other caller exists: the platform admin runs only termination and the backend check (A5), as plain SQL on pg_stat_activity, so
no admin needs USAGE on kauro (SDP-07). Pool (src/pool.ts:100-105, 159-190): VERIFY_SQL refuses a connection whose `current_user`
is not a RUNTIME LOGIN of A1 shape (calls the audit restricted to itself); `maxLifetimeSeconds: 600`.
A5 Credentials. Runtime logins are created ONLY by `tools/deploy/provision-login.mjs` (migrator connection + AWS deploy principal).
Serialization: the run sets `lock_timeout = '10s'` and takes the session advisory lock `pg_advisory_lock(hashtext('kauro.provision:'
|| login))` for the WHOLE run (revoke takes the same lock); a wait past 10 s fails 55P03 and the run exits BUSY having changed
nothing. Every AWS call is bounded (10 s) and an unanswered call is treated as possibly applied (recovered below, never assumed).
Durable generation (SDP-13): `kauro_meta.provisioning_generations (role_oid PK, login, grp, generation bigint, op_id uuid,
updated_at)`, migrator-only. Each secret value carries `{username, host, dbname, generation, op_id}`.
0. bind (SDP-16): read the role by name; if it EXISTS it must already be a RUNTIME LOGIN of A1 shape for the REQUESTED group,
   checked by `kauro.runtime_login_shape(oid, group)` (migrator-owned SECURITY DEFINER, same predicates as A1 restricted to that
   role, EXECUTE to the migrator only), else refuse with no password change and nothing written or published; a login outside every
   group, in another group, or with any extra grant is never adopted. Record (name, oid, group); every later step re-reads
   name -> oid and refuses if it changed (dropped and recreated);
1. if the role is absent: `CREATE ROLE <login> LOGIN INHERIT PASSWORD <random> IN ROLE <group>` (A1 shape) and its generation row
   (generation 0), one COMMIT; record its oid;
2. recover or rotate. Read the secret's versions. If AWSCURRENT authenticates and its generation equals the DB generation: no change.
   Else if a version labelled AWSPENDING has generation = DB generation and authenticates: go to 3 with it (recovery after a crash
   between write and promotion; no rotation). Else rotate: in ONE transaction `ALTER ROLE <login> PASSWORD <new>` and
   `generation = generation + 1, op_id = <new uuid>` (row locked), COMMIT; then `PutSecretValue(ClientRequestToken = op_id,
   VersionStages = ['AWSPENDING'])`. A retry of an unanswered PutSecretValue re-sends the same token and value (idempotent by
   AWS's ClientRequestToken). A write NEVER targets AWSCURRENT directly;
3. promote by compare-and-swap, still holding the lock in a live session: re-read the DB generation (must equal the pending
   version's generation, else stop) and the version id currently labelled AWSCURRENT, then `UpdateSecretVersionStage(AWSCURRENT,
   MoveToVersionId = op_id, RemoveFromVersionId = <that id>)`; AWS refuses the move if AWSCURRENT has moved meanwhile, so a stale
   run cannot replace a newer published value. A late PutSecretValue of a dead run only adds or relabels an AWSPENDING version; its
   generation is below the DB's, so no later step promotes it;
4. audit gate in a fresh transaction: `runtime_identity_audit()` returns no row AND `runtime_login_shape(oid, group)` returns no
   row; the AWSCURRENT JSON names exactly that username, the cluster endpoint, the database and the DB generation; connecting with
   it yields `session_user` = login and `(SELECT oid FROM pg_roles WHERE rolname = session_user)` = the recorded oid; else stop;
5. publish: ONE IAM policy per login, inline policy `kauro-secret-<login>` on that runtime service's own role (`PutRolePolicy`
   replaces by name, idempotent), resource = exactly this login's secret ARN, bound to (login, oid, group) in
   `deploy/runtime-secrets.json`. No policy lists two logins, so provisioning and revoke of different logins touch disjoint
   policies; then release the lock. Revoke: under the lock, delete the login's policy, then the secret, then the role.
States: crash after 1 or in 2 before PutSecretValue = role whose password nobody holds, nothing exposed; rerun rotates. Crash after
PutSecretValue = AWSPENDING at the DB generation; rerun recovers it in 2 and promotes in 3. Crash after 3 = working AWSCURRENT, no
policy; rerun does 4-5. A completed login rerun changes nothing and re-publishes the same policy. Database created
`OWNER <migrator>` at provisioning.
A6 Cutover (B14 runbook, `tools/deploy/runtime-cutover.mjs`; FIXED r3): stop runtime work; as a role holding pg_signal_backend +
pg_read_all_stats (RDS master; tests: superuser oracle) `pg_terminate_backend(pid, 5000)` every backend of a runtime login and
poll `pg_stat_activity` every 250 ms for at most 30 s, else stop fail-closed; record T; migrator applies migrations; migrator calls
the audit (it owns it) and the admin checks no runtime backend has `backend_start < T`; start runtime; readiness re-runs the audit
every 5 minutes (detection only; exposure is gated by A5 step 4 and the pool).
A7 Existing tests keep their assertions (FIXED): admission-instants :218-250/:266-286 via the kit's `nestedAs` (oracle-made invoker
probe, original runtime connection and context, `current_user`/depth asserted, cleanup in finally); aggregate-kinds :445-470 part
(1) on a separate login granted TEMPORARY by the oracle, revoked and closed in finally, plus a 42501 assertion on the pooled login;
fault-harness :1232-1239 via oracle-made `fault_probe.fault_undo_clock()`. Test fixtures that add owner-made triggers (e.g.
b10-failure-cells-conversion.test.ts:50-69) never share a cluster with an audit assertion, or insert their declared rows.

## B. Defence in depth: each value bound to its producing fact (unchanged from r4; FIXED)

B1 processing_jobs (D-PROV-2), `0046_job_fence_provenance.sql`, faithful copy of 0021:418-528 with only 0021:465-468 replaced:
attempt_count/current_attempt_id change needs depth >= 2, `NEW.attempt_count = OLD.attempt_count + 1` and an attempt (agency, job,
`attempt_id = NEW.current_attempt_id`, `ordinal = NEW.attempt_count`, created_at = server_now()); fence change needs
`NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`, that attempt CLAIMED at `fence = NEW.fence` with
claimed_at = server_now(), and `attempt_owns_lease`. CHECK `<= 9007199254740991` on processing_jobs.fence/attempt_count,
processing_attempts.fence, leases.fence (ADD NOT VALID; VALIDATE). jobRecord stays fail-closed.
B2 leases (D-PROV-3), `0047_lease_server_clock.sql`; `now` = `kauro.server_now()` (transaction clock, D-CLOCK-1):
- INSERT: fence must be 1; heartbeat_at, created_at, updated_at NORMALISED to now; `now < expires_at <= deadline_at` else refused.
- DELETE: refused KA005; `REVOKE DELETE ON kauro.leases FROM kauro_control` (no caller: `DELETE FROM kauro.leases` 0 hits).
- UPDATE changing heartbeat_at, expires_at, checkpoint_hash, owner or fence: `NEW.heartbeat_at = now` (KA005 LEASE_CLOCK) and
  `NEW.expires_at > now`. Same owner+fence: `OLD.expires_at > now`, `NEW.expires_at >= OLD.expires_at`; a checkpoint change also
  needs `NEW.checkpoint_hash IS NOT NULL`. Takeover: `OLD.expires_at <= now`, fence + 1, checkpoint rules 0006:216-224 unchanged.
- claim/heartbeat/checkpoint: every old `p_now` overload DROPPED, new signatures without it. Callers: src/lease-store.ts:75/91/96,
  src/audit/store.ts:488, src/execution/store.ts:456/620. The port keeps `now`, ignored by PgLeaseStore, documented (Q2).
B3 cost_grants pool holds (D-PROV-4), `0048_grant_hold_events.sql`:
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
capture_facts with status IN ('COMPLETED','REVERSED'), KP002. Read-only: no row lock.
B5 L3, `0050_owner_recurrence_recount.sql`, deferred, NEW identifies the parent, final row re-selected, read-only:
`active_owner_count` = count of ACTIVE OWNER memberships (KA004; KA001 at 0002:349 stays immediate);
`agency_recurrence.confirmation_count` = count and max(confirmation_seq) of the agency's qualifying_purchases, first_* = the seq-1
purchase (KC001); the purchase INSERT checks its authorization row was born in this transaction (column named by the L3 designer).
B6 Catalog gate (D-PROV-6): every kauro function whose prosrc reads `pg_trigger_depth` is in the test's allowlist with its binding
(fact, deferred recount, or D-PROV-1 only: 0023:453, 0028:117, 0028:261, 0028:472).

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
R = `.../sec-depth-root.test.ts`, H = `.../sec-depth-hardening.test.ts`, P = `tools/deploy/test/provision-login.test.ts` (real
Postgres; fake Secrets Manager/IAM ports, AWS half SIMULATED until B14). All GAP cells are tier 1.

N/A "guard": a predicate inside the caller's statement with no own write, COMMIT, port call or lock; it cannot change the caller's
crash/retry/timeout behaviour, which is the caller package's matrix and NOT claimed here. Added locks (B3) and added commit-time work
(B4/B5) have GAP cells. A row lock alone is never a race proof (rule 1).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 cutover A6 | GAP SEC-01 R :: "RACE SEC-DEPTH (retained session): a runtime connection opened before the revoke keeps a pg_temp nested writer; the cutover terminates it and the audit reports nothing after" | GAP SEC-02 R :: "RACE SEC-DEPTH (cutover timeout): a backend that outlives the 30 s termination bound stops the cutover fail-closed and runtime stays down" | N/A no deadline | GAP SEC-03 R :: "DENY SEC-DEPTH (release): 0045 aborts and records no ledger row when a runtime group keeps TEMPORARY" | GAP SEC-04 R :: "RACE SEC-DEPTH (cutover crash after migrate): a re-run cutover terminates, skips applied migrations and audits clean" | N/A covered by SEC-04 | GAP SEC-05 R :: "DENY SEC-DEPTH (readiness): a privilege granted to a live login fails readiness and the next verification of its connection" | N/A guard |
| R2 shapes A1 | N/A per-connection check | N/A | N/A | N/A read-only | N/A | N/A | GAP SEC-06a-n R, one test each, each refused by the pool and reported: "DENY SEC-DEPTH (shape): a login with a direct TEMPORARY grant" / "... a group with CREATE on an extra schema" / "... PUBLIC with database CREATE" / "... a login owning a schema" / "... a login with a second membership (SET ROLE into a NOINHERIT role)" / "... a group holding ADMIN on another role (Codex SDP-14 repro)" / "... TRIGGER on a table of an extra schema" / "... EXECUTE on a kauro trigger function" / i "... SET ON PARAMETER session_replication_role granted to a group" / j "... granted to a login" / k "... granted to PUBLIC" / l "... ALTER SYSTEM on any parameter granted to a runtime identity" / m "... a database or role setting of session_replication_role" / n "... EXECUTE on lo_export granted to a login"; supplemental SEC-59 R :: "DENY SEC-DEPTH: a runtime role cannot SET session_replication_role (42501) and the pool sees origin" | N/A |
| R3 healthy shape + callers | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-07 R :: "OK SEC-DEPTH: a clean cluster built by the CREATEROLE migrator, with its ADMIN-only creator edges and PUBLIC-executable pg_catalog trigger functions, audits clean when called by each of the seven runtime logins and the migrator"; SEC-07b R :: "OK SEC-DEPTH: a trigger function created by a later migration has no PUBLIC EXECUTE after the runner applies it" | N/A |
| R4 provisioning A5 | GAP SEC-09 P :: "RACE SEC-DEPTH (provisioning): two runs for one login, the second held on the advisory lock, end with one role whose password the published secret authenticates"; SEC-67 P :: "RACE SEC-DEPTH: provisioning one login and revoking another concurrently change only their own IAM policies" ; SEC-09b P :: "RACE SEC-DEPTH: a revoke and a provisioning of one login serialize on the lock" | GAP SEC-10 P :: "RACE SEC-DEPTH (provisioning timeout): a Secrets Manager call past its bound leaves no IAM entry and a rerun completes with a working credential"; SEC-63 P :: "RACE SEC-DEPTH (lock timeout): a run waiting more than lock_timeout on the provisioning lock exits BUSY and changes no role, generation, secret or policy" | N/A | GAP SEC-11 P :: "DENY SEC-DEPTH (provisioning): a login whose audit gate fails is never published in IAM" | GAP SEC-12 P :: "RACE SEC-DEPTH (crash after role COMMIT): nothing is exposed; a rerun sets a password, writes the secret, audits and publishes, and the secret authenticates"; SEC-13 P :: "RACE SEC-DEPTH (crash after pending write): a rerun promotes the pending version of the current generation without rotating, and the secret authenticates"; SEC-64 P :: "RACE SEC-DEPTH (late write): a dead run's PutSecretValue completing after a newer run published leaves AWSCURRENT at the newer generation, which still authenticates"; SEC-65 P :: "DENY SEC-DEPTH (stale promotion): a promotion whose RemoveFromVersionId is no longer AWSCURRENT is refused" | GAP SEC-14 P :: "OK SEC-DEPTH: a rerun of a completed provisioning keeps the published secret valid and creates no second role, secret or IAM statement"; SEC-66 P :: "OK SEC-DEPTH: a re-sent PutSecretValue with the same ClientRequestToken creates no second version" | GAP SEC-15 P :: "DENY SEC-DEPTH: an IAM resource set naming a non-runtime secret is refused"; SEC-60 P :: "DENY SEC-DEPTH (adoption): an existing LOGIN outside every group, in another group or with an extra grant is refused before any password change and nothing is published"; SEC-61 P :: "DENY SEC-DEPTH (secret binding): a registered ARN whose secret names the migrator, another runtime login or another database is refused before IAM"; SEC-62 P :: "DENY SEC-DEPTH: a login dropped and recreated under the same name during the run is refused (oid changed)" | GAP SEC-17 P :: "RACE SEC-DEPTH (partial): an IAM publication failure leaves role and secret unexposed and --revoke removes all three" |
| R5 root routes | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-18 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)"; supplemental SEC-18s R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a schema or an object in public, kauro or kauro_meta" | N/A |
| R6 declared triggers A3 | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-19 R :: "OK SEC-DEPTH: every user trigger of a fresh cluster equals its declared row and the internal RI_FKey triggers audit clean"; SEC-20 R :: "DENY SEC-DEPTH: record_commercial_transition attached to a table of another schema before cutover (TRIGGER revoked afterwards) is reported"; SEC-21 R :: "DENY SEC-DEPTH: a declared trigger with altered definition or enabled state, or a missing one, is reported"; SEC-22 R :: "DENY SEC-DEPTH: a foreign key with ON DELETE CASCADE is reported"; SEC-22b :: "the generated declared-triggers-0044.sql equals a fresh cluster at 0044" | N/A |
| R7 attempt insert -> attempt_count (0021:684) | GAP SEC-23 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-24 S :: "DENY SEC-DEPTH (nested attempt_count): a depth-2 attempt_count of n+1 with no attempt of that ordinal born now is refused KA080" | GAP SEC-25 S :: "DENY SEC-DEPTH (nested current_attempt_id): a depth-2 current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R8 attempt claim -> job fence (0021:686) | GAP SEC-26 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-27 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence"; SEC-27b S :: "OK SEC-DEPTH: the initial claim of an absent lease is fence 1 and no takeover" | N/A guard | N/A guard | GAP SEC-28 S :: "DENY SEC-DEPTH (nested fence max): a depth-2 fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job"; SEC-28b S :: "DENY SEC-DEPTH (nested fence in range): a depth-2 fence = OLD + 1 with no attempt claimed at it now is refused KA080" | N/A: claim and bookkeeping share one transaction holding the lease row lock (0006:253); SEC-26 proves the wait | N/A guard |
| R9 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-29 S :: "DENY SEC-DEPTH (lease delete): kauro_control cannot DELETE a lease"; SEC-30 S :: "DENY SEC-DEPTH (lease birth): an INSERT above fence 1 is refused and caller heartbeat/created instants are replaced by server_now" | N/A (DENY SEC-29/30) |
| R10 renew/heartbeat | GAP SEC-31 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of one lease, both orders held at the lease row; takeover only after expiry, the stale heartbeat NULL" | N/A | GAP SEC-32 S :: "DENY SEC-DEPTH (lease clock): an UPDATE that shortens expires_at or sets it at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-33 S :: "OK SEC-DEPTH: with the database clock held fixed, a different caller instant passed to the port changes no claim, heartbeat or checkpoint outcome" | GAP SEC-34 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R11 checkpoint | GAP SEC-35 S :: "RACE SEC-DEPTH: checkpoint_lease and a takeover of one expiring lease, both orders held at the lease row; the checkpoint lands only while live and the takeover names it" | N/A | GAP SEC-36 S :: "DENY SEC-DEPTH (expired checkpoint): a direct UPDATE of checkpoint_hash on an expired spending lease is refused"; supplemental SEC-36s S :: "checkpoint_lease on an expired lease returns NULL" | N/A | N/A | N/A single statement | N/A covered by SEC-34 | N/A |
| R12 carve HOLD (kauro_app) | GAP SEC-37 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, events seq n+1 and n+2, reserved = sum" | GAP SEC-38 M :: "RACE SEC-DEPTH (timeout): a carve authorization waiting on the pool lock past statement_timeout rolls back with no event, no hold and the carve PREPARED" | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-39 M :: "DENY SEC-DEPTH (nested grant repetition): a second depth-2 increment citing a real carve authorized now is refused KA083"; SEC-40 M :: "DENY SEC-DEPTH (nested grant): reserved_cents raised with no hold event is refused KA083"; SEC-40b M :: "... lowered ..." | GAP SEC-41 M :: "DENY SEC-DEPTH: a hold event for a carve of another pool, another agency, or not authorized now is refused" | SEC-42 M :: "OK SEC-DEPTH (multi-row): two carves authorized in one UPDATE hold their own ceilings and leave every pool version unchanged" |
| R13 carve RELEASE (kauro_control) | GAP SEC-43 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation of one pool, both orders held at the pool lock; reserved and spend exact" | N/A same lock and bound as SEC-38 | N/A | N/A guard | N/A guard | GAP SEC-44 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | N/A | SEC-45 M :: "OK SEC-DEPTH (multi-row): two carves closed in one UPDATE release their own ceilings and spends" |
| R14 capture -> allocated_cents | GAP SEC-46 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders held at the order lock, allocated = recount" | GAP SEC-46t M :: "RACE SEC-DEPTH (commit timeout): a deferred allocation recount slowed past statement_timeout at COMMIT rolls back captures, allocation and events, and a retry commits" | N/A | GAP SEC-47 M :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no capture, allocation or event of the transaction" | N/A guard | GAP SEC-48 M :: "DENY SEC-DEPTH (nested allocation): allocated_cents above the recount at commit is refused KP002" | N/A | SEC-49 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R15 owner count (L3) | GAP SEC-50 H :: "RACE SEC-DEPTH: two owner removals, both orders held at the agency row; KA001 and the commit recount hold" | GAP SEC-50t H :: "RACE SEC-DEPTH (commit timeout): an owner recount slowed past statement_timeout at COMMIT rolls back the membership change, and a retry commits" | N/A | GAP SEC-51 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves the membership change unapplied" | N/A guard | N/A | GAP SEC-52 H :: "DENY SEC-DEPTH (nested owner count): an inflated active_owner_count is refused at commit KA004" | SEC-53 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R16 recurrence (L3) | GAP SEC-54 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders held at the recurrence advisory lock, count = purchases" | GAP SEC-54t H :: "RACE SEC-DEPTH (commit timeout): a recurrence recount slowed past statement_timeout at COMMIT rolls back purchase, recurrence and consumption, and a retry commits" | N/A | GAP SEC-55 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no purchase, recurrence or consumption" | N/A guard | GAP SEC-56 H :: "DENY SEC-DEPTH (nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001" | N/A | SEC-57 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R17 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: every kauro function that reads pg_trigger_depth() is listed with its binding" |

Timeout bound for SEC-38/46t/50t/54t: the transaction's `SET LOCAL statement_timeout` (runtime-transaction.ts:56, 5 000 ms default,
:23); the test sets it to 200 ms and slows the recount with an oracle-made `pg_sleep` hook attached in a test-only schema (its
declared row inserted by the fixture), expecting SQLSTATE 57014 and the complete rollback footprint, then a clean retry.

C1 Baseline proof. Must FAIL on 21b310f by showing the forbidden behaviour through base SQL only (attack paths use no new helper,
function or signature; `nestedAs` and grants are oracle setup of base objects; shape tests grant the route and show the pool
accepts the connection and the route works; SEC-06i/j/k show replica mode raising a pool's reserved_cents with no hold event):
SEC-01, SEC-06a-n, SEC-18, SEC-20 (the attached writer records a fabricated history
row), SEC-24, SEC-25, SEC-28, SEC-28b, SEC-29, SEC-30, SEC-32, SEC-34, SEC-36, SEC-39, SEC-40, SEC-40b, SEC-48, SEC-52, SEC-56.
Supplemental checks that already pass on main (SEC-18s, SEC-36s), OK, RACE and P tests of new tooling are not baseline failures.

C2 Caller references (context only, not claimed): adapters-leases.test.ts:32; execution-migrations.test.ts:261,
apps/control/test/job-execution.test.ts:91; audit-migrations.test.ts:89, apps/control/test/grant-reconciliation.test.ts:31;
b09-migrations.test.ts:278, :307; B06-case-map.md:160; B10-failure-matrix.md:702. Section D re-runs them unchanged.

## D. Accepted packages touched (A6 owner rule: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool verification,
aggregate-kinds.test.ts:445; S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331,
execution-migrations :150), R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89,
audit-adapters :286, grant-reconciliation.test.ts:31, b08-end-to-end.test.ts:306); FH-R2 (r6). B09: R2-140, S058/S057
(b09-migrations.test.ts:278, :307). B10: d27uow via L3 and every 0028 trigger (EXECUTE revoke). B07: none.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAs`, `depthProbeTable`, `slowRecountHook`), src/testing/index.ts | - | 30 min, 60k | claude-sonnet-5-5 |
| L1 root | migrations/0045, migrations/declared-triggers-0044.sql (generated), tools/gen-declared-triggers.mjs, src/pool.ts, src/migrations/runner.ts, R, admission-instants, aggregate-kinds, fault-harness tests | R1-R3, R5, R6, R17 | 150 min, 360k | Opus |
| L1b provisioning | tools/deploy/provision-login.mjs, tools/deploy/runtime-cutover.mjs, deploy/runtime-secrets.json, P | R4 (+ R1 tool) | 70 min, 160k | Opus |
| L2a jobs+leases | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R7-R11 | 120 min, 300k | Opus |
| L2b money | migrations/0048, 0049, M | R12-R14 | 110 min, 260k | Opus |
| L3 hardening | migrations/0050, H | R15-R16 | 70 min, 150k | Opus |

Order K -> (L1 || L2a || L2b) -> L1b -> L3. Migrations 0046-0050 each insert their declared_triggers rows (L1 lands 0045 first,
the others rebase). Done = every GAP rewritten to C with its title; C1 shown failing on 21b310f (log) and passing on the branch;
full suites green in ci-local (WSL + Windows). Total about 9 h agent time, 1.29M tokens.

## F. Decisions and open questions

- Q1 (accepted) kauro_control stays a trusted direct reconciler; future hardening = a consumed reconciliation fact (B3 pattern).
- Q2 (accepted) port keeps `now`; every SQL `p_now` overload removed; port removal is a follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn (accepted): per-carve events, no SUM.
- Q4 A5/A6 need an AWS deploy principal and the RDS master (termination only) at each deploy: a B14 runbook step.
- Q5 r5 removes the trusted-identity table, the provider-role list and the classification of arbitrary roles (r3-r4): with A1's
  shapes no runtime login reaches any of them, so they no longer matter. Credential rotation of a published login is out of scope
  (B14 procedure); provisioning never rotates a working secret.
