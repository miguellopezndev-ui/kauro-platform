# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r8

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2-r7 answered design reviews 062a982 .. r7. r8 STEPS BACK (coordinator decision after r7):
proving that no runtime path reaches `pg_trigger_depth() >= 2` is unbounded (r3-r7 kept finding new PostgreSQL authority paths:
definers, callbacks, views/rules, parameter ACLs). New principle P1: **no guard's correctness depends on `pg_trigger_depth()` or on
which role or code path wrote the row; every guarded value is checked against FACTS visible in the same transaction**, so a nested
or direct writer, whatever its privilege path, can only write values the facts already justify. Section A is reduced to hardening
that is NOT relied on. AWS provisioning stays handed to B14 (appendix). Sections B2 (leases), B4 (allocation recount), the carve
events and the deferred recounts are kept.

## 0. Facts established from the code

- F1 Depth and role-identity provenance in migrations 0001-0044 (grep `pg_trigger_depth|is_control_session|rolsuper` on 21b310f):
  inventory in section 1. Tenant/actor context (`kauro.current_user_id()`, `current_agency_id()`, RLS policies) is authorisation of
  the acting person, not provenance of a derived value, and is out of scope.
- F2 Depth is forgeable by any session that can create or attach a trigger (pg_temp objects as runtime roles in our own tests:
  admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464; fault-harness.test.ts:1237).
- F3 Finding 1 also needs no nesting: kauro_control DELETE on leases (0006:374, policy 0006:366), no INSERT guard (0006:202-229);
  delete + insert at fence 2^63-1, claim (0021:637; `attempt_owns_lease` ignores expiry, 0021:265-279), bookkeeping (0021:686)
  copies it; `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79) throws for every reader.
- F4 Finding 3 needs no nesting: takeover compares caller-written `NEW.heartbeat_at` with `OLD.expires_at` (0006:213); claim,
  heartbeat, checkpoint take `p_now` (0006:239-320).
- F5 Money writers: carve hold/release `cost_grants_pool_hold` (0023:212-227, release run by kauro_control, apps/control/src/audit/
  grants.ts:96); dispatch reservation `request_journal_reserves_grant` (0023:262-288, BEFORE INSERT on request_journal by
  kauro_control); reconciliation `reconcileRequest` (src/audit/store.ts:582-600, a depth-1 UPDATE by kauro_control, the only src
  writer of reserved_cents); `cost_grants_version` (0023:115-116) exempts the two cents columns. Allocation: one capture per AFTER
  ROW invocation (0015:420-452).
- F6 Writer timing: `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) before the purchase insert (0028:517);
  `maintain_active_owner_count` adds +-1 per row (0002:329-355): only commit-time recounts fit them. Runtime transactions run under
  `SET LOCAL statement_timeout` (src/runtime-transaction.ts:56, 5 000 ms default :23), COMMIT included.

## 1. Inventory: every provenance guard in 0001-0044 and its fact binding (P1)

| # | Guard (file:line) | Protected value | Today's provenance | r8 fact binding (replacement; depth and role tests removed) |
|---|---|---|---|---|
| G1 | 0002:143 `guard_active_owner_count` | agencies.active_owner_count | depth >= 2 | B5: deferred recount = ACTIVE OWNER memberships of the agency (final row re-selected); KA001 (0002:349) stays immediate |
| G2 | 0015:98 `payment_orders_allocation_writer` | payment_orders.allocated_cents | depth >= 2 (+ monotone) | B4: deferred recount = Σ(service+tax) of COMPLETED/REVERSED captures; immediate monotone kept |
| G3 | 0021:466 `processing_jobs_workflow` | attempt_count, current_attempt_id, fence | depth >= 2 | B1: a real attempt of ordinal n+1 born now; fence = that CLAIMED attempt's fence claimed now and owning the lease; safe-int CHECKs |
| G4 | 0023:158 `cost_grants_workflow` | cost_grants.reserved_cents, reconciled_spend_cents | depth >= 2 OR `is_control_session()` (0023:119-121, 131) | B3: every change = exactly one consumed ledger event (HOLD, RELEASE, RESERVE, RECONCILE) with seq = OLD.ledger_seq + 1; no role exemption (Q1 closed) |
| G5 | 0023:162-165 pool changes "control only" | pool state/version/authorization_ref | `is_control_session()` | authorisation, not value provenance: kept as a role rule; the values it admits are already fact-checked (expiry on server clock 0023:170-190, transitions via enforce_listed_transition 0023:112); listed for completeness |
| G6 | 0023:453 `audits_workflow` | audits.fence | depth >= 2 | B6: fence change needs `NEW.fence = OLD.fence + 1` and an audit_steps row of this audit with `fence = NEW.fence` and `claimed_at = server_now()` (writer 0023:610-616; the step itself is born at audit fence + 1 under the audit row lock, 0023:575-590); safe-int CHECK |
| G7 | 0028:117 `commercial_transitions_recorded_by_trigger` | commercial_transitions rows | depth >= 2 | B7: the row's subject (machine -> table/id/state as passed in the writers' TG_ARGV, 0028:215 and the 0029:70 sibling writer, recorded in a registry `kauro.commercial_machines`) exists with `version = subject_version`, `state = to_state`, agency equal, and that version written now; UNIQUE (machine, subject_id, subject_version); from_state = the subject's previous history row's to_state |
| G8 | 0028:261 founding consumption | founding_slot_reservations CONSUMED | depth >= 2 AND a purchase naming it (fact) | already a fact; r8 adds `consumed_at = server_now()` and the purchase `confirmed_at = server_now()` (same transaction); depth removed |
| G9 | 0028:447 `agency_recurrence_designation_only` | agency_recurrence | depth >= 2 (+ shape) | B5: deferred recount = count/max(seq)/first of qualifying_purchases; immediate shape (first fixed, +1) kept |
| G10 | 0028:472 `qualifying_purchases_designation_only` | qualifying_purchases rows | depth >= 2 | B8: every column re-derived from facts: the commercial_authorizations row (rebinding_id NULL) born now, its capture (allocated_service_cents, provider_completed_at), order created_at, eligibility snapshot (founding basis), confirmation_seq = recurrence count; PK authorization_id; never UPDATE/DELETE |
| G11 | 0044:73 platform last admission | execution_capacity.last_admission_at | depth >= 2 AND server_now AND admission fact | already facts (server_now, strictly later, a job admitted now); depth conjunct removed (writing "now" again is idempotent) |
| G12 | 0044:96 agency last admission | agency_execution_capacity.last_admitted_at | same | already facts (server_now, later, this agency's job admitted now); depth removed |
| G13 | 0006:202 `leases_guard` | leases fence, owner, heartbeat, expiry, checkpoint | caller instants | B2: server clock, fence 1 at birth, +1 only after expiry, no shortening, no DELETE |
| G14 | 0021:740, 0022:606 consumption/delivery bounds | commercial_authorizations consumption/delivery | superuser skips the guard (D8-PEX-8) | not depth; a superuser can disable any trigger, the pool refuses superusers (src/pool.ts:182). Kept; Q6 asks whether to remove it (B09 fixtures) |

Catalog gate (R17): after this lane no kauro function reads `pg_trigger_depth()` and `is_control_session()` appears only in G5.

## A. Hardening (defence in depth, NOT relied on by any guard or test of section C)

A1 `0045_runtime_hardening.sql` (migrator): `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and from the seven groups;
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE EXECUTE ... FROM PUBLIC` on every kauro function returning trigger. It also
tries to revoke `pg_parameter_acl` grants to PUBLIC or runtime groups; parameters are owned by the bootstrap superuser, so this
succeeds only for a principal holding the grant option (SDP-19: database ownership is not enough, the RDS master is not assumed to
be a superuser); a remaining grant is reported, not silently accepted. 0045 fails if TEMPORARY or CREATE on the database
remains for a runtime group after its revokes (a no-op REVOKE by a non-owner only warns).
A2 Pool (src/pool.ts:100-105, 159-190): VERIFY_SQL additionally refuses a login with TEMPORARY or CREATE on the database, CREATE on
any schema, or `current_setting('session_replication_role') <> 'origin'`; `maxLifetimeSeconds: 600`.
A3 Migrations add no SECURITY DEFINER function (catalog gate R17; on 21b310f there is none, grep finds only comments 0001:6,
0008:14, 0032:8, 0033:9, 0034:15, 0035:11, 0036:18).
A4 Not done any more (r3-r7 material withdrawn): identity-closure audit, trusted identities, declared trigger/definer inventories,
view/rule/callback analysis, audit cutover. Retained sessions, definers, views, rules, callbacks or parameter grants can at most
write values that section B's facts justify; the C tests prove it with a superuser-owned writer.
A5 Existing tests that created pg_temp objects as runtime roles (admission-instants :218-250/:266-286, aggregate-kinds :445-470,
fault-harness :1232-1239) move to the kit's oracle-made probes (FIXED r2): same role, same connection, same assertions; the
aggregate-kinds shadow probes run on a separate login granted TEMPORARY by the oracle and revoked in finally.

## B. Fact bindings (P1)

Common: every replaced guard function is a faithful copy of its 0001-0044 body with only the cited lines changed; `now` =
`kauro.server_now()` (transaction clock, D-CLOCK-1). Fence/count columns get CHECK `<= 9007199254740991` (ADD NOT VALID; VALIDATE).
B1 processing_jobs (G3), `0046_job_fence_provenance.sql`, 0021:465-468 replaced: attempt_count/current_attempt_id change needs
`NEW.attempt_count = OLD.attempt_count + 1` and an attempt (agency, job, `attempt_id = NEW.current_attempt_id`, `ordinal =
NEW.attempt_count`, created_at = now); fence change needs `NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`,
that attempt CLAIMED at `fence = NEW.fence` with claimed_at = now, and `attempt_owns_lease`. jobRecord stays fail-closed.
B2 leases (G13, FIXED), `0047_lease_server_clock.sql`: INSERT fence 1, heartbeat/created/updated normalised to now,
`now < expires_at <= deadline_at`; DELETE refused and revoked from kauro_control; UPDATE of heartbeat/expiry/checkpoint/owner/fence
needs `heartbeat_at = now`, `expires_at > now`; same holder: `OLD.expires_at > now`, no shortening, checkpoint not NULL; takeover:
`OLD.expires_at <= now`, fence + 1, checkpoint rules 0006:216-224. All `p_now` overloads dropped (callers src/lease-store.ts:75/91/96,
src/audit/store.ts:488, src/execution/store.ts:456/620; the port keeps `now`, ignored, Q2).
B3 grant ledger (G4), `0048_grant_ledger_events.sql` (carve events kept and generalised):
- `kauro.cost_grant_ledger_events (source_kind HOLD|RELEASE|RESERVE|RECONCILE, source_id, grant_id, agency_id, seq, reserved_delta,
  spend_delta, recorded_at)`, PK (source_kind, source_id), UNIQUE (grant_id, seq), append-only. INSERT guard derives both deltas
  from the source fact, born or changed now: HOLD = carve AUDIT grant of this pool AUTHORIZED at now, +ceiling; RELEASE = that carve
  CLOSED at now, -ceiling and +its reconciled spend; RESERVE = request_journal row inserted now (reserved_at = now), +its
  reserved_cents on its grant; RECONCILE = that request now RECONCILED, -its reserved_cents and +actual_cents. `seq =
  grant.ledger_seq + 1` under the grant row lock; recorded_at := now. RLS mirrors the writers (kauro_app HOLD of its agency;
  kauro_control RELEASE, RESERVE, RECONCILE), SELECT for both.
- cost_grants: `ledger_seq bigint NOT NULL DEFAULT 0`, born 0; `GRANT UPDATE (ledger_seq)` to kauro_app and kauro_control;
  `cost_grants_version` exempts `reserved_cents,reconciled_spend_cents,ledger_seq`.
- writers: `cost_grants_pool_hold` (0023:212-227), `request_journal_reserves_grant` (0023:288) and `reconcileRequest`
  (src/audit/store.ts:595) each lock the grant, insert their event, then `UPDATE ... SET ledger_seq = ledger_seq + 1` with the
  event's deltas.
- guard (0023:155-160 replaced, `is_control_session()` no longer consulted for money): ANY change of reserved_cents,
  reconciled_spend_cents or ledger_seq, by any role, needs `NEW.ledger_seq = OLD.ledger_seq + 1` and the event (grant, NEW.ledger_seq)
  recorded now with equal deltas. Each source fact moves money once (PK) and each event once (seq). Q1 (trusted control) is closed.
B4 allocation (G2), `0049_allocation_recount.sql`: immediate monotone kept; DEFERRABLE INITIALLY DEFERRED constraint trigger AFTER
UPDATE OF allocated_cents: NEW identifies (agency_id, order_id), the final row is re-selected and must equal
`coalesce(Σ(allocated_service_cents + allocated_tax_cents), 0)` over COMPLETED/REVERSED captures of the order, KP002. Read-only.
B5 owner count (G1) and recurrence (G9), `0050_owner_recurrence_recount.sql`: deferred, read-only recounts (final rows
re-selected): active_owner_count = ACTIVE OWNER memberships (KA004); recurrence count/max(seq)/first_* = qualifying_purchases
(KC001); immediate rules KA001 (0002:349) and the recurrence shape (0028:447-460 minus depth) kept.
B6 audit fence (G6), in `0046`: copy of `audits_workflow` (0023:409-525) with 0023:453-455 replaced as in G6.
B7 commercial history (G7), `0051_commercial_facts.sql`: `kauro.commercial_machines (machine PK, table_name, id_column,
state_column)` seeded from the writers' TG_ARGV; INSERT guard of commercial_transitions checks, by dynamic `format('%I')` read
of the registered table, the subject row (id, version = subject_version, state = to_state, agency) and that this version was written
in this transaction (its updated_at, or created_at for a birth, = now); UNIQUE (machine, subject_id, subject_version); from_state =
the previous history row's to_state (NULL for a birth). The registry is migrator-written only.
B8 founding consumption (G8) and qualifying purchases (G10), in `0051`: G8 adds the two `= now` instants; G10 re-derives every
column of the inserted purchase from its facts as listed in the inventory (authorization born now, rebinding_id NULL, capture,
order, eligibility snapshot, confirmation_seq = recurrence count after the upsert).
B9 admission instants (G11, G12), in `0046`: copies of 0044:64-81 and 0044:88-103 with only the `pg_trigger_depth() < 2 OR` term removed.

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
H = `.../sec-depth-hardening.test.ts`, R = `.../sec-depth-root.test.ts`. All GAP cells are tier 1.

Independence proof (P1): every "superuser nested" title uses the kit's `nestedAsSuperuser(sql)`: the superuser oracle creates a
SECURITY DEFINER function it owns plus a probe table and AFTER INSERT trigger in schema `depth_probe`, grants INSERT on the probe
to the runtime group; the RUNTIME session (with its tenant context) inserts one probe row, so the forged write runs at depth 2 AS
SUPERUSER (no RLS, no column grant, `is_control_session()` true). It is the worst case of every r3-r7 path (temp objects, retained
sessions, definers, callbacks, views, rules, parameter grants). The test asserts the fact check's SQLSTATE and that nothing of the
transaction committed; its OK sibling writes the fact-consistent value the same way and commits (proving the check, not a
privilege, decides). N/A "guard": a predicate in the caller's statement with no own write, COMMIT, port call or lock; the caller's
crash/retry/timeout rows are the caller package's matrix, not claimed here. Added locks (B3) and commit-time work (B4/B5) have GAP
cells. A row lock alone is never a race proof (rule 1).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 hardening A (not relied on) | N/A | N/A | N/A | GAP SEC-03 R :: "DENY SEC-DEPTH (release): 0045 records no ledger row when its revokes leave TEMPORARY to a runtime group" | N/A | N/A | GAP SEC-18 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)"; SEC-05 R :: "DENY SEC-DEPTH: the pool refuses a login with TEMPORARY, schema CREATE or a non-origin session_replication_role" | N/A |
| R7 attempt insert -> attempt_count (0021:684) | GAP SEC-23 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-24 S :: "DENY SEC-DEPTH (superuser nested attempt_count): a superuser-owned nested attempt_count of n+1 with no attempt of that ordinal born now is refused KA080" | GAP SEC-25 S :: "DENY SEC-DEPTH (superuser nested current_attempt_id): a superuser-owned nested current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R8 attempt claim -> job fence (0021:686) | GAP SEC-26 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-27 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence"; SEC-27b S :: "OK SEC-DEPTH: the initial claim of an absent lease is fence 1 and no takeover" | N/A guard | N/A guard | GAP SEC-28 S :: "DENY SEC-DEPTH (superuser nested fence max): a superuser-owned nested fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job"; SEC-28b S :: "DENY SEC-DEPTH (superuser nested fence in range): a superuser-owned nested fence = OLD + 1 with no attempt claimed at it now is refused KA080" | N/A: claim and bookkeeping share one transaction holding the lease row lock (0006:253); SEC-26 proves the wait | N/A guard |
| R9 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-29 S :: "DENY SEC-DEPTH (lease delete): kauro_control cannot DELETE a lease"; SEC-30 S :: "DENY SEC-DEPTH (lease birth): an INSERT above fence 1 is refused and caller heartbeat/created instants are replaced by server_now" | N/A (DENY SEC-29/30) |
| R10 renew/heartbeat | GAP SEC-31 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of one lease, both orders held at the lease row; takeover only after expiry, the stale heartbeat NULL" | N/A | GAP SEC-32 S :: "DENY SEC-DEPTH (lease clock): an UPDATE that shortens expires_at or sets it at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-33 S :: "OK SEC-DEPTH: with the database clock held fixed, a different caller instant passed to the port changes no claim, heartbeat or checkpoint outcome" | GAP SEC-34 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R11 checkpoint | GAP SEC-35 S :: "RACE SEC-DEPTH: checkpoint_lease and a takeover of one expiring lease, both orders held at the lease row; the checkpoint lands only while live and the takeover names it" | N/A | GAP SEC-36 S :: "DENY SEC-DEPTH (expired checkpoint): a direct UPDATE of checkpoint_hash on an expired spending lease is refused"; supplemental SEC-36s S :: "checkpoint_lease on an expired lease returns NULL" | N/A | N/A | N/A single statement | N/A covered by SEC-34 | N/A |
| R12 carve HOLD (kauro_app) | GAP SEC-37 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, events seq n+1 and n+2, reserved = sum" | GAP SEC-38 M :: "RACE SEC-DEPTH (timeout): a carve authorization waiting on the pool lock past statement_timeout rolls back with no event, no hold and the carve PREPARED" | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-39 M :: "DENY SEC-DEPTH (superuser nested grant repetition): a second superuser-owned nested increment citing a real carve authorized now is refused KA083"; SEC-40 M :: "DENY SEC-DEPTH (superuser nested grant): reserved_cents raised with no ledger event is refused KA083"; SEC-40b M :: "... lowered ..." | GAP SEC-41 M :: "DENY SEC-DEPTH: a HOLD event for a carve of another pool, another agency, or not authorized now is refused" | SEC-42 M :: "OK SEC-DEPTH (multi-row): two carves authorized in one UPDATE hold their own ceilings and leave every pool version unchanged" |
| R13 carve RELEASE (kauro_control) | GAP SEC-43 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation of one pool, both orders held at the pool lock; reserved and spend exact" | N/A same lock and bound as SEC-38 | N/A | N/A guard | N/A guard | GAP SEC-44 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | N/A | SEC-45 M :: "OK SEC-DEPTH (multi-row): two carves closed in one UPDATE release their own ceilings and spends" |
| R14 capture -> allocated_cents | GAP SEC-46 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders held at the order lock, allocated = recount" | GAP SEC-46t M :: "RACE SEC-DEPTH (commit timeout): a deferred allocation recount slowed past statement_timeout at COMMIT rolls back captures, allocation and events, and a retry commits" | N/A | GAP SEC-47 M :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no capture, allocation or event of the transaction" | N/A guard | GAP SEC-48 M :: "DENY SEC-DEPTH (superuser nested allocation): allocated_cents above the recount at commit is refused KP002" | N/A | SEC-49 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R15 owner count (L3) | GAP SEC-50 H :: "RACE SEC-DEPTH: two owner removals, both orders held at the agency row; KA001 and the commit recount hold" | GAP SEC-50t H :: "RACE SEC-DEPTH (commit timeout): an owner recount slowed past statement_timeout at COMMIT rolls back the membership change, and a retry commits" | N/A | GAP SEC-51 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves the membership change unapplied" | N/A guard | N/A | GAP SEC-52 H :: "DENY SEC-DEPTH (superuser nested owner count): an inflated active_owner_count is refused at commit KA004" | SEC-53 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R16 recurrence (L3) | GAP SEC-54 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders held at the recurrence advisory lock, count = purchases" | GAP SEC-54t H :: "RACE SEC-DEPTH (commit timeout): a recurrence recount slowed past statement_timeout at COMMIT rolls back purchase, recurrence and consumption, and a retry commits" | N/A | GAP SEC-55 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no purchase, recurrence or consumption" | N/A guard | GAP SEC-56 H :: "DENY SEC-DEPTH (superuser nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001" | N/A | SEC-57 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R12b RESERVE (request_journal insert) | GAP SEC-70 M :: "RACE SEC-DEPTH: two dispatch reservations on one grant, both orders held at the grant lock, two events and reserved = sum" | N/A same lock and bound as SEC-38 | N/A grant expiry read unchanged (0023:283-284) | N/A guard | N/A guard | GAP SEC-71 M :: "DENY SEC-DEPTH (superuser nested reserve): reserved_cents moved by a request's amount without its RESERVE event, or twice for one request, is refused KA083" | N/A | N/A guard |
| R12c RECONCILE (control) | GAP SEC-72 M :: "RACE SEC-DEPTH: two reconciliations of different requests of one grant, both orders held at the grant lock, exact totals" | N/A same lock | N/A | N/A guard | N/A guard | GAP SEC-73 M :: "DENY SEC-DEPTH (superuser nested reconcile): a control-session UPDATE releasing reserve or adding spend with no RECONCILE event is refused KA083 (was accepted for kauro_control)"; SEC-74 M :: "DENY SEC-DEPTH: a second RECONCILE of one request is refused" | N/A | N/A guard |
| R18 audit fence (G6) | GAP SEC-75 S :: "RACE SEC-DEPTH: two step claims of one audit, both orders held at the audit row, one fence + 1" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-76 S :: "DENY SEC-DEPTH (superuser nested audit fence): audits.fence moved with no step claimed at it now, or by more than one, is refused KA080" | N/A | N/A guard |
| R19 commercial history (G7) | GAP SEC-77 H :: "RACE SEC-DEPTH: two transitions of one subject, both orders held at the subject row, two history rows of consecutive versions" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-78 H :: "DENY SEC-DEPTH (superuser nested history): a history row for a subject version not written now, another state, or a duplicate version is refused KA004" | N/A | N/A guard |
| R20 founding consumption (G8) | N/A covered by SEC-54 (same advisory lock) | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-79 H :: "DENY SEC-DEPTH (superuser nested consumption): CONSUMED with no purchase naming it confirmed now is refused KC001" | N/A | N/A guard |
| R21 qualifying purchase (G10) | N/A covered by SEC-54 | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-80 H :: "DENY SEC-DEPTH (superuser nested purchase): a purchase whose authorization was not born now, or whose amount, instant or basis differs from its facts, is refused KC001" | N/A | N/A guard |
| R22 admission instants (G11/G12) | N/A guard (only the depth term is removed; the 0044 race rows stand) | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-81 S :: "DENY SEC-DEPTH (superuser nested admission): a future, past or unadmitted last_admission_at / last_admitted_at is refused KA082" | N/A | N/A guard |
| R17 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: no kauro function reads pg_trigger_depth(), is_control_session() guards no value, and no kauro function is SECURITY DEFINER" |

Timeout bound for SEC-38/46t/50t/54t: the transaction's `SET LOCAL statement_timeout` (runtime-transaction.ts:56; the test sets
200 ms and slows the recount with an oracle-made `pg_sleep` hook), expecting 57014, the complete rollback footprint and a clean retry.

C1 Baseline proof. Must FAIL on 21b310f, each through base SQL only (the superuser-owned probe uses no new function or signature):
SEC-24, SEC-25, SEC-28, SEC-28b, SEC-29, SEC-30, SEC-32, SEC-34, SEC-36, SEC-39, SEC-40, SEC-40b, SEC-48, SEC-52, SEC-56, SEC-71,
SEC-73, SEC-76, SEC-78, SEC-80, SEC-18. SEC-79 and SEC-81 already refuse on main (G8 and 0044 bind facts today) and are
supplemental regression guards for the depth-term removal. OK siblings, RACE titles and R1 hardening checks other than SEC-18 are not baseline failures.

## D. Accepted packages touched (A6 owner rule: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool verification,
aggregate-kinds.test.ts:445; S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331,
execution-migrations :150), R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89,
audit-adapters :286, grant-reconciliation.test.ts:31, b08-end-to-end.test.ts:306); FH-R2 (r6). B09: R2-140, S058/S057
(b09-migrations.test.ts:278, :307). B10: d27uow, commercial history and qualifying purchases via L3, every 0028 trigger (EXECUTE
revoke). B08 also: audit fence (G6) and admission instants (G11/G12). B07: none.


## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAsSuperuser`, `slowRecountHook`), src/testing/index.ts | - | 30 min, 60k | claude-sonnet-5-5 |
| L1 hardening | migrations/0045, src/pool.ts, R, admission-instants, aggregate-kinds, fault-harness tests, catalog gate | R1, R17 | 60 min, 140k | claude-sonnet-5-5 |
| L2a jobs+leases+audit+admission | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R7-R11, R18, R22 | 140 min, 340k | Opus |
| L2b money | migrations/0048, 0049, src/audit/store.ts (:582-600 reconcileRequest), src/request-journal.ts (:60 only if the writer moves), M, audit-migrations and grant-reconciliation tests | R12-R14, R12b, R12c | 130 min, 320k | Opus |
| L3 commercial | migrations/0050, 0051, H | R15, R16, R19-R21 | 110 min, 260k | Opus |

src/audit/store.ts is split by line ranges between L2a (:488) and L2b (:582-600): L2a lands first, L2b rebases. Order K -> (L1 ||
L2a || L2b) -> L3. Done = every GAP rewritten to C with its title; C1 shown failing on 21b310f (log) and passing on the branch;
full suites green in ci-local (WSL + Windows). Total about 7.8 h agent time, 1.12M tokens.

## F. Decisions and open questions

- Q1 closed by B3: kauro_control moves money only through RECONCILE/RELEASE/RESERVE events (no role exemption).
- Q2 (accepted) port keeps `now`; every SQL `p_now` overload removed; port removal is a follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn: per-source events, no SUM.
- Q4 Section A is hardening only; no correctness claim rests on it, so its residual gaps (r3-r7 findings SDP-02/07/11/12/14/15/18/19)
  are accepted as hardening limits, not open security findings: the C superuser tests show they cannot produce an inconsistent value.
- Q5 B7 relies on each commercial subject stamping its version write with `server_now()`; the L3 designer lists the stamp column per
  machine from 0028/0029 before coding; a machine without one gets that column in 0051 (verify-before-spend).
- Q6 G14 (superuser skip in 0021:740, 0022:606, decision D8-PEX-8) is identity-based but not depth; P1 would remove it and move B09's
  critique/S059 fixtures to real facts. Proposed: out of this lane (superusers are outside the runtime threat model: the pool refuses
  them, src/pool.ts:182, and a superuser can disable triggers); coordinator to confirm.

## Appendix. Handed to B14 (S-A, Terraform/IAM): requirements + Codex findings r4-r6 verbatim

No design here; B14 designs and Codex-reviews it. Since r8 no database guard depends on which login writes (P1), so B14-R1..R3
protect credentials and least privilege, not guard correctness. Database facts B14 can rely on: A1 hardening and the A2 pool checks.
- B14-R1 Runtime credentials (pool and Data API) exist only for logins of A1 RUNTIME LOGIN shape for the intended group; an existing
  role is adopted only if it already has that exact shape, bound by name and oid; never any other login's credential.
- B14-R2 Secret identity (username, endpoint, database) and ARN ownership are validated BEFORE any password, secret version or label
  mutation; authentication failure never authorises adopting a differently named secret.
- B14-R3 Immediately before a credential becomes readable by a runtime principal, the login passes the A2 pool checks.
- B14-R4 Every external effect (secret write/promotion/deletion, IAM put/delete) is fenced against late completion after lock or
  session loss, for the same login as well as across logins; one IAM policy per login; bounded lock and call timeouts.
- B14-R5 Tests assert final working authentication and final IAM/secret access, not object counts; fake ports model the first
  secret version receiving AWSCURRENT automatically.

**r4 SDP-13 (MAJOR, OPEN): Provisioning does not serialize password and secret publication**

> Section A6/R4; family: multiple durable effects, concurrent recovery and credential rotation. Idempotence by login name supplies no serialization across role COMMIT, secret write and IAM publication. Concurrent runs can leave one role, one secret and one IAM entry while the secret contains the wrong password, satisfying SEC-09's counts. Retrying a completed login also rotates its password while its existing secret/IAM authority remains published, contradicting the stated fresh-provisioning crash states. Specify per-login coordination across the whole operation, durable recovery/version semantics, and separate handling of existing published credentials. Sweep same-login runs, provisioning versus revoke, and IAM updates by different login runs.
>
> REPRO: Run A commits password pA and pauses. Run B commits pB, writes secret pB and publishes IAM. Resume A, which writes pA and publishes IAM. Counts are correct but authentication fails because the role requires pB. Separately, rerun an already published login and crash after its password COMMIT; its old published secret is now invalid. Tests must assert working authentication and recovery, not only object counts.

**r5 SDP-16 (BLOCKING, OPEN): Credential publication does not prove the secret represents a runtime login**

> Sections A5/F-Q5; family: existing-object adoption and credential-to-identity binding. Step 1 establishes membership only when the role is absent. For an existing login outside all runtime groups, the global audit intentionally reports nothing about it. Steps 2-4 can consequently preserve or publish its working credentials. An authenticating stored secret can also name a different user unless its contents and authenticated session identity are checked. Being listed in runtime-secrets.json does not prove the database username has A1 shape. Before any password mutation or exposure, require the requested existing role to match the selected runtime group and complete shape; require the secret's username, target and authenticated session_user to match that role; bind every published ARN to that validated identity. This matters particularly for Data API, which does not execute pool VERIFY_SQL. See [Data API credential handling](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html).
>
> REPRO: Seed an ordinary existing LOGIN with no runtime-group membership and a direct TEMPORARY grant, plus a working secret. Provision that login for kauro_app. Step 1 skips creation, step 2 keeps the authenticating secret, and the global audit has no violation because the role is outside its runtime population. The specified publication gate lacks a target-shape rejection. Also test a registered runtime ARN whose secret names the migrator, another runtime group, or another database; each must be refused before password changes and IAM exposure.

**r5 SDP-13 (MAJOR, PARTIALLY_FIXED): Provisioning serialization still lacks recovery from late AWS effects**

> PARTIALLY_FIXED. A5's whole-run per-login lock resolves the original interleaving while both sessions remain alive, and preserving an authenticating secret resolves ordinary completed-run rotation. It does not fence an AWS request already in flight when the database session dies or the port times out. A retry can acquire the released lock, choose a new password and publish it, after which the abandoned PutSecretValue can complete and replace AWSCURRENT with the old password. Define durable operation/version recovery for ambiguous completion and prevent stale writes from replacing published credentials. Per-login locks also do not coordinate different logins updating the same IAM resource-set policy; specify that shared publication protocol and its revoke races. See [session advisory-lock lifetime](https://www.postgresql.org/docs/17/explicit-locking.html) and [PutSecretValue staging/idempotency](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).
>
> REPRO: With the fake AWS port, let run A commit password pA and submit PutSecretValue, but hold the external effect pending. Terminate A's database session. Run B acquires the lock, commits pB, writes/publishes pB and authenticates successfully. Then complete A's pending write as AWSCURRENT=pA; the published secret no longer authenticates. Cover this in TIMEOUT and CRASH-AFTER/RETRY cells, and test different-login publication versus revoke against the shared IAM policy.

**r6 SDP-16 (BLOCKING, PARTIALLY_FIXED): Secret identity is validated after the step that can overwrite it**

> PARTIALLY_FIXED. A5 step 0 correctly refuses existing roles outside the requested complete shape; OID rechecks and step 4's authenticated identity check improve publication binding. But secret username/target validation occurs in step 4, after step 2 may change the database password and replace the registered secret. A mismatched secret whose generation differs or whose credentials fail authentication takes the rotation branch. That branch can overwrite and promote a secret originally belonging to the migrator, another login or another target; step 4 then sees the newly corrected JSON and can accept it. Section/family: A5 steps 0-4, existing-object adoption and credential-to-identity binding. Analogous paths are AWSCURRENT/AWSPENDING recovery, wrong host/database/group and a registered ARN pointing at an unrelated secret. Validate existing secret identity and ARN ownership before any password, version or label mutation; authentication failure must not authorize adoption of a differently named secret. SEC-61 currently promises refusal before IAM, which is too late to prove this.
>
> REPRO: Create a valid runtime login with DB generation k. Register an existing secret ARN whose JSON names another login and generation k+1. Run provisioning. Step 0 passes; step 2 cannot retain the mismatched-generation value, so it rotates the requested login and writes its credentials into that ARN; step 3 promotes them; step 4 now sees matching identity and generation. Require refusal before ALTER ROLE, PutSecretValue or UpdateSecretVersionStage, and assert the original password and every secret version/label remain unchanged.

**r6 SDP-13 (MAJOR, PARTIALLY_FIXED): Secret-version recovery improves, but late same-login IAM effects remain unfenced**

> PARTIALLY_FIXED. Durable generations, idempotent pending writes and the AWSCURRENT expected-version check address the original late PutSecretValue overwrite. Separate per-login policies remove different-login shared-policy races. They do not fence requests already in flight for the same policy name after the advisory-lock session dies. A delayed DeleteRolePolicy from a failed revoke can delete the policy successfully republished by a later provisioning run. Delayed PutRolePolicy can likewise overwrite a replacement incarnation's policy. Secret deletion is another external effect without the version CAS protection. Section/family: A5 publication/revoke, ambiguous external completion after lock loss. Define durable recovery or fencing for all same-login publication and revoke effects; serialization while the database session lives is insufficient. AWS IAM exposes policy replacement/deletion by name without this design's generation condition: [PutRolePolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_PutRolePolicy.html), [DeleteRolePolicy](https://docs.aws.amazon.com/IAM/latest/APIReference/API_DeleteRolePolicy.html). The Secrets Manager expected-version behavior is supported by [UpdateSecretVersionStage](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html).
>
> REPRO: With the fake AWS port, hold revoke A's DeleteRolePolicy effect pending and terminate A's database session before it receives a result; the secret and database login remain. Provisioning B acquires the released lock, validates the working credential and successfully republishes kauro-secret-<login>. Complete A's pending delete afterward: B's published IAM policy disappears. Also delay PutRolePolicy across revoke/recreation and DeleteSecret across a recovery run. Assert final authorized Data API/secret access, not merely successful database authentication.

**r6 SDP-17 (MINOR, OPEN): The first Secrets Manager version automatically receives AWSCURRENT**

> A5 says a write never targets AWSCURRENT and describes crash-after-write as pending-only. AWS automatically attaches AWSCURRENT when PutSecretValue creates a secret's first version, even when stages are supplied. The publication gate can still preserve safety, but the initial state/recovery description and fake AWS behavior need this exception. Specify secret creation and promotion when AWSCURRENT is absent or already attached to op_id. Source: [PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).
>
> REPRO: Create an empty secret, write its first version with VersionStages=['AWSPENDING'], then crash before explicit promotion. Model the automatic AWSCURRENT label and require recovery to validate and publish the correct working generation.
