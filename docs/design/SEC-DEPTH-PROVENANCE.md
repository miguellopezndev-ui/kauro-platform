# SEC-DEPTH-PROVENANCE: trigger depth is no provenance (design + failure matrix), r9

Target path: `docs/design/SEC-DEPTH-PROVENANCE.md`. Base: kauro-platform `main` 21b310f. Closes Codex p0-admission-r2 (on 0217109)
findings 1-3 and the 0015 analogue. r2-r8 answered design reviews 062a982 .. 8cb7299. r8 stepped back to P1 (below). r9 answers
Codex design r8 (8cb7299, REJECT, SDP-20..28), one line each:
- SDP-20: KA001 and every other immediate decision read the membership facts under the agency lock, never the counter (B5a).
- SDP-21: the grant ledger is checked both ways plus its complete final relation; reconciliation facts are frozen; the ledger, the
  request journal and the grants cannot be deleted (B3).
- SDP-22: RESERVE and RECONCILE accounting run in AFTER ROW triggers of their source rows; the BEFORE trigger only authorises (B3).
- SDP-23: Q6 REVERSED by the coordinator: both `rolsuper` skips are removed (B10); B09/B10 fixtures move to real execution facts
  (D1); the guard-execution boundary is stated and enforced for runtime roles (P2).
- SDP-24: the history registry carries a scope per machine; all 11 attachments are enumerated; recorded_at and actor are normalised (B7).
- SDP-25: a same-holder update keeps a stored checkpoint; it never requires one (B2).
- SDP-26: compositional cells added to C; every DENY has a named OK sibling (C2).
- SDP-27: B14-R1 states the login shape itself (appendix).
- SDP-28: agency_recurrence is bound column by column, last_confirmed_at included (B5b).
Root cause: three families were seen twice in r8 (SDP-20/28, SDP-21/26, SDP-22/24/25): they are template rules 11-13
(`docs/design/FAILURE-MATRIX-TEMPLATE.md`) and section 2 sweeps every analogous path in the inventory.

## 0. Facts established from the code

- F1 Depth and role-identity provenance in migrations 0001-0044 (grep `pg_trigger_depth|is_control_session|rolsuper|pg_has_role|
  current_user` on 21b310f): inventory in section 1. Tenant/actor context (`kauro.current_user_id()`, `current_agency_id()`, RLS) is
  authorisation of the acting person, not provenance of a derived value, and is out of scope.
- F2 Depth is forgeable by any session that can create or attach a trigger (pg_temp objects as runtime roles in our own tests:
  admission-instants.test.ts:220-242, :276; aggregate-kinds.test.ts:460-464; fault-harness.test.ts:1237).
- F3 Finding 1 needs no nesting: kauro_control DELETE on leases (0006:374, policy 0006:366), no INSERT guard (0006:202-229); delete +
  insert at fence 2^63-1, claim (0021:637; `attempt_owns_lease` ignores expiry, 0021:265-279), bookkeeping (0021:686) copies it;
  `jobRecord` (src/execution/rows.ts:135 -> src/sql.ts:73-79) throws for every reader.
- F4 Finding 3 needs no nesting: takeover compares caller-written `NEW.heartbeat_at` with `OLD.expires_at` (0006:213); claim,
  heartbeat, checkpoint take `p_now` (0006:239-320).
- F5 Money writers: carve hold/release `cost_grants_pool_hold` (0023:212-227, AFTER UPDATE OF state); dispatch reservation
  `request_journal_reserves_grant` (0023:262-288, BEFORE INSERT, its grant UPDATE at :288 runs before the request row exists);
  reconciliation `reconcileRequest` (src/audit/store.ts:582-600: request UPDATE, then a separate grant UPDATE). Allocation: one
  capture per AFTER ROW invocation (0015:420-452); its decision reads the cached `allocated_cents` (0015:437).
- F6 Writer timing: `designate_qualifying_purchase` upserts agency_recurrence (0028:513-516) before the purchase insert (0028:517);
  `maintain_active_owner_count` adds +-1 per row (0002:329-355). Runtime transactions run under `SET LOCAL statement_timeout`
  (src/runtime-transaction.ts:56, 5 000 ms default :23), COMMIT included.
- F7 Owner counter consumers: KA001 (0002:349) decides on the counter its own UPDATE returned (0002:341-344); the founding-owner
  birth (0002:219) reads `active_owner_count = 0` AND `NOT EXISTS` membership (0002:221). No policy or src reader decides on it.
- F8 Reconciliation sources: `usage_state`/`actual_cents` are written by reconcileRequest (store.ts:585), `reconcileUsage`
  (src/request-journal.ts:99-105, no grant write) and `storeResponse` (:78-81, any usage state); request_journal_guard (0006:143-159)
  freezes neither; kauro_control has UPDATE (0006:373). The CLOSED edge (0023:187-200) admits KNOWN-but-unreconciled usage; the
  control sweep reconciles every KNOWN usage before its edges in the same transaction (apps/control/src/audit/grants.ts:61-98).
- F9 History attachments (11): FoundingReservation 0028:215 via `record_commercial_transition` (agency = subject's); ten via
  `record_corporate_transition` (0029:70, agency NULL always): 0029:698, :724, :735, :758, :775; 0030:270, :287; 0031:321, :336,
  :353. Both writers skip an unchanged state (0028:102, 0029:66); CommissionLine lists ADJUSTED->ADJUSTED. Every subject has
  `touch_updated_at` (updated_at := now() = server_now(), 0001:124, 0009:44); only 4 of 11 births are server-stamped.
- F10 G14 (`rolsuper` skip, 0021:740, 0022:606) is relied on by: execution-migrations.test.ts:783-795 (asserts the exemption),
  b09-critique.test.ts:346-349 (consumption), apps/api/test/b09-scenarios.test.ts:299-315 (S059), apps/api/test/commission-
  support.ts:707-730 `deliveredByTheExecutionPackage` (callers b10-commission-service.test.ts:211, b10-failure-cells-accrual.test.ts
  :507, :766). Real writers exist in src/testing/execution-fixtures.ts: queueJob :87, admitJob :121, launchJob :147, stageJob :185,
  verifyJob :207, publishJob :270, endJob :297.
- F11 Checkpoint-free live operations: same-holder re-claim (0006:262-276), heartbeat (0006:279-292), S090 heartbeat of a NULL-
  checkpoint JOB_ATTEMPT (journals-leases.test.ts:312-316); SWEEP and OUTBOX_DISPATCH never store a checkpoint.

## P1, P2

P1: no guard's correctness depends on `pg_trigger_depth()` or on which role or code path wrote the row; every guarded value is
checked against FACTS visible in the same transaction, and no immediate decision reads a value that is checked only at commit.
P2 (guard-execution boundary, SDP-23): the guarantees hold in every session in which kauro's triggers and constraint triggers fire.
The principals that can stop them form the trusted computing base (TCB) and are outside the guarantee: superusers (local oracle;
no RDS login is assumed superuser), the table owner (migrator: DISABLE TRIGGER, DROP), any role with SET or ALTER SYSTEM on
`session_replication_role` (replica mode skips ordinary, constraint and FK triggers), and any SECURITY DEFINER routine owned by
one of them that a runtime role can execute. Runtime roles are kept out of the TCB as a correctness assumption, not hardening:
0045 FAILS (not reports) when a runtime group, login or PUBLIC has `has_parameter_privilege(.., 'session_replication_role', 'SET')`,
owns a kauro/kauro_meta object, or can EXECUTE a SECURITY DEFINER routine in kauro, kauro_meta or public; the pool refuses a
non-origin value at connect (A2). Production TCB membership is B14's (B14-R6). `SET CONSTRAINTS ALL IMMEDIATE` is no bypass: it runs
the pending checks earlier, and a later write of the row queues a new check (SEC-106). No guard exempts by identity: `rolsuper`,
`current_user`, `session_user` and `is_control_session()` decide no value (R17).

## 1. Inventory: every provenance guard in 0001-0044 and its fact binding

| # | Guard (file:line) | Protected value | Today | r9 fact binding (depth and role tests removed) |
|---|---|---|---|---|
| G1 | 0002:143, KA001 0002:349 | agencies.active_owner_count; last-owner decision | depth >= 2; KA001 reads the counter | B5a: KA001 = no ACTIVE OWNER membership left, read after the agency row lock; counter = deferred recount (KA004); 0002:219 conjunct replaced by the membership fact |
| G2 | 0015:98, decision 0015:437 | payment_orders.allocated_cents | depth >= 2 (+ monotone) | B4: still-owed computed from captures, not the counter; deferred recount; monotone kept |
| G3 | 0021:466 | attempt_count, current_attempt_id, fence | depth >= 2 | B1 (unchanged from r8) |
| G4 | 0023:158 | cost_grants.reserved_cents, reconciled_spend_cents | depth >= 2 OR `is_control_session()` | B3: two-way ledger (event->source immediate, source->event and complete relation deferred), frozen evidence |
| G5 | 0023:162-165 | pool state/version/authorization_ref | `is_control_session()` | authorisation of pool edges, not value provenance; values fact-checked (0023:170-190, 0023:112); kept |
| G6 | 0023:453 | audits.fence | depth >= 2 | B6 (unchanged from r8) |
| G7 | 0028:117 | commercial_transitions rows | depth >= 2 | B7: registry of the 11 attachments with scope; subject facts; from != to; recorded_at/actor normalised |
| G8 | 0028:261 | founding_slot_reservations CONSUMED | depth >= 2 AND purchase (fact) | B8: + `consumed_at = server_now()`; reverse check purchase RESERVED_SLOT <=> reservation CONSUMED by it |
| G9 | 0028:447 | agency_recurrence (all 9 columns) | depth >= 2 (+ shape) | B5b: every column bound immediately to server_now/shape and at commit to the purchases |
| G10 | 0028:472 | qualifying_purchases rows | depth >= 2 | B8: all 14 columns from facts; three founding-basis cases |
| G11 | 0044:73 | execution_capacity.last_admission_at | depth AND facts | facts already; depth conjunct removed |
| G12 | 0044:96 | agency_execution_capacity.last_admitted_at | same | same |
| G13 | 0006:202 | leases fence, owner, heartbeat, expiry, checkpoint | caller instants | B2: server clock; same holder keeps a stored checkpoint, never needs one |
| G14 | 0021:740, 0022:606 | authorization CONSUMED / DELIVERED | `rolsuper` skips the fact check | B10: skip removed; the existing fact checks bind every role |

## 2. Family sweep (root cause; template rules 11-13)

| Family (rule) | r8 findings | Paths checked in 0001-0044 | Outcome |
|---|---|---|---|
| CACHE: an immediate decision reads a value checked only at commit, or a derived row is partly bound (11) | SDP-20, SDP-28 | KA001 counter; founding birth 0002:219; allocation decision 0015:437; designation seq from the recurrence count 0028:515; RESERVE room 0023:285; EXHAUSTED->AUTHORIZED room 0023:176-179; 0023:436 room; derived rows: recurrence, ledger events, history, purchases, leases, admission instants | fixed: KA001 (B5a), 0015:437 (B4), 0002:219 (B5a); bound already: seq (immediate +1 shape, a decrease is refused, so a transient inflation cannot be restored before the KC001 recount), grant rooms (money moves only with an immediate event, B3, nothing deferred); every derived row now lists all columns (B3, B5b, B7, B8) |
| RECIPROCAL: a source->derived relation checked one way, or evidence mutable after use (12) | SDP-21, SDP-26 | ledger; reservation <=> purchase; job ADMITTED <=> authorization CONSUMED (0021:700, :740); job READY <=> package AVAILABLE <=> DELIVERED (0022:580, :606); history <=> subject; allocation, owner count, recurrence | fixed: ledger (B3), reservation<=>purchase (B8); the two 0021/0022 pairs are both-way already and bind every role after B10; history: writer is an AFTER trigger of the subject (structural) + B7; recounts are complete relations. Frozen: usage after RECONCILED, CLOSED grant money, carve spend after CLOSED; ledger, history, purchases append-only; journal and grants undeletable |
| VALID WRITER: a new predicate rejects an unchanged production writer (13) | SDP-22, SDP-24, SDP-25 | RESERVE visibility; corporate scope; checkpoint-free renewal; renewal with a shorter TTL; B1 retry attempts; B8 basis NONE/UNBACKED; CLOSED-needs-reconciled vs the sweep; multi-row RESERVE; recurrence instants | fixed: B3 AFTER phase, B7 scope, B2 checkpoint, B2 TTL (functions take GREATEST, the guard refuses only a direct shortening); each has an OK sibling in C2 |
| IDENTITY exemption (single; P1) | SDP-23 | grep of F1 | only G14 (removed) and G5 (authorisation, kept) |

## A. Hardening (defence in depth; P2 lists what is NOT hardening)

A1 `0045_runtime_hardening.sql` (migrator): `REVOKE TEMPORARY, CREATE ON DATABASE <current> FROM PUBLIC` and the seven groups;
`REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE EXECUTE ... FROM PUBLIC` on every kauro trigger function; revokes
`pg_parameter_acl` grants to PUBLIC or runtime groups where it holds the grant option (SDP-19: database ownership is not enough, the
RDS master is not assumed superuser). It fails if TEMPORARY or CREATE on the database remains for a runtime group, and on the P2
conditions.
A2 Pool (src/pool.ts:100-105, 159-190): VERIFY_SQL refuses a login with TEMPORARY or CREATE on the database, CREATE on any schema, or
`current_setting('session_replication_role') <> 'origin'`; `maxLifetimeSeconds: 600`. Data API does not run VERIFY_SQL (B14-R3).
A3 No SECURITY DEFINER function in kauro migrations (R17; on 21b310f none, comments only 0001:6, 0008:14, 0032:8, 0033:9, 0034:15,
0035:11, 0036:18).
A4 Withdrawn (r3-r7): identity-closure audit, trusted identities, declared trigger/definer inventories, view/rule/callback analysis,
audit cutover. Sessions, definers, views, rules or callbacks OUTSIDE the TCB can at most write values section B's facts justify;
principals that stop guard execution are the TCB (P2) and are not covered by any claim here.
A5 Rewritten existing tests (FIXED r2, requirements explicit per Codex r8): the original runtime-execution assertions keep an
oracle-created SECURITY INVOKER fixture (not `nestedAsSuperuser`); the copied admission row gets the real deferred consumption guard
attached and is written as runtime, keeping the cross-transaction assertion (admission-instants :218-250/:266-286); temporary
shadows live in the tested runtime connection through a test login granted TEMPORARY by the oracle and revoked in finally
(aggregate-kinds :445-470); the clock-reset helper keeps its hidden SELECT reset (fault-harness :1232-1239).

## B. Fact bindings

Common: each replaced guard is a copy of its 0001-0044 body with only the cited lines changed; `now` = `kauro.server_now()`
(transaction clock, D-CLOCK-1). Safe-integer CHECK `<= 9007199254740991` (ADD NOT VALID; VALIDATE) on processing_jobs.fence,
.attempt_count; processing_attempts.fence, .ordinal; leases.fence, .cancel_version; audits.fence; audit_steps.fence;
cost_grants.ledger_seq; cost_grant_ledger_events.seq.
B1 processing_jobs (G3), `0046_job_fence_provenance.sql`, 0021:465-468 replaced: attempt_count/current_attempt_id change needs
`NEW.attempt_count = OLD.attempt_count + 1` and an attempt (agency, job, `attempt_id = NEW.current_attempt_id`, `ordinal =
NEW.attempt_count`, created_at = now); fence change needs `NEW.current_attempt_id = OLD.current_attempt_id`, `NEW.fence > OLD.fence`,
that attempt CLAIMED at `fence = NEW.fence` with claimed_at = now, and `attempt_owns_lease`. jobRecord stays fail-closed.
B2 leases (G13), `0047_lease_server_clock.sql`: INSERT fence 1, heartbeat/created/updated := now, `now < expires_at <= deadline_at`;
DELETE/TRUNCATE refused and DELETE revoked from kauro_control. UPDATE of heartbeat/expiry/checkpoint/owner/fence needs
`heartbeat_at = now` and `expires_at > now`. Same holder (owner and fence unchanged): `OLD.expires_at > now`; `NEW.expires_at >=
OLD.expires_at`; `OLD.checkpoint_hash IS NOT NULL => NEW.checkpoint_hash IS NOT NULL` (a stored checkpoint is never cleared; a NULL
one may stay NULL or be stored; SDP-25). Takeover: `OLD.expires_at <= now`, fence + 1, checkpoint rules 0006:216-224. claim_lease
and heartbeat_lease compute `expires_at = GREATEST(OLD.expires_at, LEAST(now + ttl, deadline_at))`, so a shorter TTL renews without
refusal. All `p_now` overloads dropped (callers src/lease-store.ts:75/91/96, src/audit/store.ts:488, src/execution/store.ts:456/620).
B3 grant ledger (G4), `0048_grant_ledger_events.sql`:
- `kauro.cost_grant_ledger_events (source_kind HOLD|RELEASE|RESERVE|RECONCILE|OPENING, source_id, grant_id, agency_id, seq,
  reserved_delta, spend_delta, recorded_at)`, PK (source_kind, source_id), UNIQUE (grant_id, seq); UPDATE/DELETE/TRUNCATE refused
  by trigger, no UPDATE/DELETE grant. RLS mirrors the writers (kauro_app HOLD of its agency; kauro_control the rest); SELECT both.
- request_journal: `reconciled_at timestamptz`, CHECK `(usage_state = 'RECONCILED') = (reconciled_at IS NOT NULL)`. Birth with
  usage_state <> 'RECONCILED'. Entering RECONCILED sets `reconciled_at := now`; once RECONCILED, usage_state, actual_cents and
  reconciled_at never change (KA004). DELETE/TRUNCATE refused on request_journal and cost_grants.
- cost_grants: `ledger_seq bigint NOT NULL DEFAULT 0`; `GRANT UPDATE (ledger_seq)` to kauro_app and kauro_control;
  `cost_grants_version` exempts `reserved_cents,reconciled_spend_cents,ledger_seq`.
- Writers, each a trigger of its source row (no source change escapes them outside the TCB), lock order source row -> grant row:
  HOLD/RELEASE `cost_grants_pool_hold` (0023:212-227, AFTER UPDATE OF state): event, then pool UPDATE. RESERVE: the BEFORE INSERT
  `request_journal_reserves_grant` keeps only its authorisation checks (model task, audit, lease fence, grant AUTHORIZED, unexpired,
  scope, room) WITHOUT a row lock and loses its UPDATE (0023:288); new `request_journal_reserve_account` AFTER INSERT FOR EACH ROW
  locks the grant, re-checks state, expiry, scope and room (earlier rows of a multi-row INSERT are already accounted: AFTER ROW events
  run in row order at statement end), inserts the RESERVE event (its guard now sees the request row, SDP-22), updates the grant;
  failure raises KA083 and the statement rolls back whole. RECONCILE: new `request_journal_reconcile_account` AFTER UPDATE OF
  usage_state WHEN (OLD.usage_state <> 'RECONCILED' AND NEW.usage_state = 'RECONCILED'): locks the grant, refuses a CLOSED grant,
  inserts RECONCILE (-reserved_cents, +actual_cents), updates the grant. reconcileRequest (store.ts:582-600) keeps its request
  UPDATE, drops its grant UPDATE and re-reads the grant; reconcileUsage and storeResponse thereby account too.
- Event INSERT guard (event -> source, immediate): HOLD = carve of this pool AUTHORIZED with authorized_at = now, +ceiling;
  RELEASE = that carve CLOSED with closed_at = now, -ceiling, +its reconciled_spend_cents; RESERVE = request row with request_id =
  source_id and cost_grant_id = grant, +reserved_cents (once per request by PK; reserved_at is caller data and is not used);
  RECONCILE = that request RECONCILED with reconciled_at = now, -reserved_cents, +actual_cents; OPENING refused after 0048.
  `seq = grant.ledger_seq + 1` read under the grant row lock; recorded_at := now.
- Grant guard (immediate; 0023:155-160 replaced, `is_control_session()` not consulted for money): any change of reserved_cents,
  reconciled_spend_cents or ledger_seq needs `NEW.ledger_seq = OLD.ledger_seq + 1` and the event (grant, NEW.ledger_seq) with deltas
  = NEW - OLD; refused when OLD.state = 'CLOSED'. The CLOSED edge (0023:187) additionally needs every request naming the grant
  RECONCILED and reserved_cents = 0.
- Deferred, read-only, final rows re-selected (KA083): (i) per inserted event, its grant's ledger_seq = max(seq) = count(events),
  reserved_cents = sum(reserved_delta), reconciled_spend_cents = sum(spend_delta): an unconsumed or orphan event fails its own
  transaction and never blocks the next writer; (ii) per inserted request its RESERVE event, per request entering RECONCILED its
  RECONCILE event, per carve entering AUTHORIZED/CLOSED its HOLD/RELEASE event.
- Data step in 0048 before the guards exist: each existing grant with money gets one OPENING event (seq 1, current values) and
  ledger_seq = 1; each existing RECONCILED request gets reconciled_at = updated_at.
B4 allocation (G2), `0049_allocation_recount.sql`: capture_facts_allocate (0015:437) computes still owed as `expected_amount_cents -
coalesce(sum(allocated_service + allocated_tax) of the order's other COMPLETED/REVERSED captures, 0)`, not `o.allocated_cents`;
immediate monotone kept; DEFERRABLE INITIALLY DEFERRED trigger AFTER UPDATE OF allocated_cents re-selects the order and requires
the same sum over all its COMPLETED/REVERSED captures, KP002. Read-only.
B5a owner count (G1), `0050_owner_recurrence_recount.sql`: `maintain_active_owner_count` (0002:329-355) on delta <> 0: `SELECT state
FROM agencies WHERE agency_id = target FOR UPDATE` (lock order membership row -> agency row, as today), then KA001 when delta < 0,
state NOT IN (CLOSING, CLOSED) and NOT EXISTS an ACTIVE OWNER membership of target (a fresh statement snapshot after the lock sees a
removal committed while waiting; under REPEATABLE READ the counter UPDATE below raises 40001), then the counter UPDATE. The counter
decides nothing; deferred recount = ACTIVE OWNER memberships (KA004). 0002:219: `a.active_owner_count = 0` becomes NOT EXISTS an
ACTIVE OWNER membership. CLOSING never returns to ACTIVE (0002:154-160), so a transient closing cannot be restored.
B5b recurrence (G9), in `0050`: immediate (0028:447-460 without depth): INSERT count = 1, first_confirmed_at = last_confirmed_at =
created_at = updated_at = now; UPDATE count = OLD + 1, first_* and created_at fixed, last_confirmed_at = updated_at = now and >= OLD
(an older transaction designating after a newer one is refused KC001 and retried, unchanged 0028:458, SEC-110). Deferred (KC001):
count = number of the agency's purchases = max(confirmation_seq); first_* = the seq-1 purchase (FK 0028:438); last_confirmed_at =
max(confirmed_at) of the purchases.
B6 audit fence (G6), in `0046`: copy of `audits_workflow` (0023:409-525) with 0023:453-455 replaced: fence change needs
`NEW.fence = OLD.fence + 1` and an audit_steps row of this audit with fence = NEW.fence and claimed_at = now.
B7 commercial history (G7), `0051_commercial_facts.sql`: `kauro.commercial_machines (machine PK, table_name, id_column,
state_column, history_scope TENANT|CORPORATE)`, migrator-written, seeded with exactly:

| machine | table | id | scope | birth stamp |
|---|---|---|---|---|
| FoundingReservation | founding_slot_reservations | reservation_id | TENANT | caller |
| Seller / Prospect | sellers / prospects | seller_id / prospect_id | CORPORATE | caller |
| PayoutDestination | seller_payout_destinations | destination_id | CORPORATE | server (0029:721) |
| AttributionClaim (agency nullable) | attribution_claims | claim_id | CORPORATE | server (0029:756) |
| CommissionEntitlement / CommissionLine (agency set) | commission_entitlements / commission_lines | entitlement_id / line_id | CORPORATE | caller |
| CommissionHold (agency set) | commission_holds | hold_id | CORPORATE | server (0030:285) |
| CommissionPeriod / CommissionStatement | commission_periods / commission_statements | period_id / statement_id | CORPORATE | caller |
| PayoutIntent | payout_intents | intent_id | CORPORATE | server (0031:351) |

State column is `state` for all 11. INSERT guard of commercial_transitions: registered machine; subject row (dynamic `format('%I')`
read) with id = subject_id, `version = subject_version`, `state = to_state`; scope TENANT => agency_id = subject.agency_id (NOT
NULL), CORPORATE => agency_id IS NULL (even when the subject names an agency); subject_version greater than every history version
of the subject and from_state = to_state of the greatest one (NULL only for version 1, CHECK 0028:88); `from_state IS DISTINCT FROM
to_state` (the writers never record an unchanged state, F9); version > 1 => subject.updated_at = now() (touch stamp; births are
covered by the PK and version = 1 since 7 of 11 birth stamps are caller data); `recorded_at := now`, `actor_user_id :=
kauro.current_user_id()` (normalised, as both writers set them). R17 asserts the 11 attachments' tgargs equal the registry.
B8 founding consumption (G8) and purchases (G10), in `0051`: G8 adds `consumed_at = now` and the purchase's confirmed_at = now.
G10 binds every column: authorization_id, agency_id, project_id, quote_id, order_id, capture_id = the commercial_authorizations row
(rebinding_id NULL, created_at = now); confirmation_seq = recurrence count after the upsert; confirmed_at = created_at = now;
provider_completed_at, allocated_service_cents = its capture; order_created_at = its order; founding basis: NONE iff the snapshot's
founding_discount_bps = 0; RESERVED_SLOT iff a RESERVED/RECONCILIATION_HOLD reservation of (agency, quote, founding_slot_ref) exists,
founding_reservation_id = it; UNBACKED otherwise. Deferred reverse (KC001): a RESERVED_SLOT purchase's reservation is CONSUMED with
consumed_by_authorization_id = the purchase's authorization.
B9 admission instants (G11, G12), in `0046`: copies of 0044:64-81 and 0044:88-103 with only the `pg_trigger_depth() < 2 OR` removed.
B10 authorization bounds (G14), in `0046`: copies of 0021:736-752 and 0022:602-618 without the `rolsuper` block (0021:740-742,
0022:606-608). The fact checks themselves are unchanged and now bind every role, the oracle included.

## C. Failure matrix. S = `packages/persistence/test/sec-depth-provenance.test.ts`, M = `.../sec-depth-money.test.ts`,
H = `.../sec-depth-hardening.test.ts`, R = `.../sec-depth-root.test.ts`. All GAP cells are tier 1 (rule 9).

Independence proof (P1): every "superuser nested" title uses the kit's `nestedAsSuperuser(sql)`: the superuser oracle creates a
SECURITY DEFINER function it owns plus a probe table and AFTER INSERT trigger in schema `depth_probe`, grants INSERT on the probe to
the runtime group; the RUNTIME session (tenant context) inserts one probe row, so the forged write runs at depth 2 AS SUPERUSER (no
RLS, no column grant, `is_control_session()` true, triggers ENABLED). It proves the check does not depend on depth, role, RLS or
grants; it claims nothing against TCB code that stops triggers (P2). Each test asserts the SQLSTATE and that nothing of the
transaction committed; its named OK sibling (C2) writes the fact-consistent value through the production writer and commits. N/A
"guard": a predicate in the caller's statement with no own write, COMMIT, port call or lock; callers' crash/retry/timeout rows are
their package's matrix. Added locks (B3, B5a) and commit-time work (B3, B4, B5, B8) have GAP cells. A row lock alone is never a
race proof (rule 1).

| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R1 hardening A | N/A | N/A | N/A | GAP SEC-03 R :: "DENY SEC-DEPTH (release): 0045 records no ledger row when its revokes leave TEMPORARY to a runtime group" | N/A | N/A | GAP SEC-18 R :: "DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)"; SEC-05 R :: "DENY SEC-DEPTH: the pool refuses a login with TEMPORARY, schema CREATE or a non-origin session_replication_role" | N/A |
| R2 P2 boundary | N/A | N/A | N/A | GAP SEC-112 R :: "DENY SEC-DEPTH (release): 0045 fails when a runtime group, login or PUBLIC holds SET on session_replication_role, owns a kauro object or can execute a definer in kauro, kauro_meta or public" | N/A | N/A | GAP SEC-59 R :: "DENY SEC-DEPTH: a runtime login cannot SET LOCAL session_replication_role = replica (42501)" | N/A |
| R7 attempt -> attempt_count (0021:684) | GAP SEC-23 S :: "RACE SEC-DEPTH: two attempts for ordinal n+1, both orders held at the job's FOR SHARE, leave attempt_count = n+1 naming the committed attempt" | N/A guard | N/A no deadline read | N/A guard | N/A guard | GAP SEC-24 S :: "DENY SEC-DEPTH (superuser nested attempt_count): a superuser-owned nested attempt_count of n+1 with no attempt of that ordinal born now is refused KA080" | GAP SEC-25 S :: "DENY SEC-DEPTH (superuser nested current_attempt_id): a superuser-owned nested current_attempt_id naming another job's or an older attempt is refused KA080" | N/A guard |
| R8 claim -> job fence (0021:686) | GAP SEC-26 S :: "RACE SEC-DEPTH (takeover): two claimants of an expired JOB_ATTEMPT lease, both orders held at the lease row, one fence wins and the job's fence is the winner's" | N/A guard | GAP SEC-27 S :: "EXPIRY SEC-DEPTH: a takeover claim at server_now = expires_at - 1 ms is HELD, at expires_at it advances the fence"; SEC-27b S :: "OK SEC-DEPTH: the initial claim of an absent lease is fence 1 and no takeover" | N/A guard | N/A guard | GAP SEC-28 S :: "DENY SEC-DEPTH (superuser nested fence max): a superuser-owned nested fence = 9223372036854775807 on an ACTIVE job is refused KA080 and jobRecord still reads the job"; SEC-28b S :: "DENY SEC-DEPTH (superuser nested fence in range): a superuser-owned nested fence = OLD + 1 with no attempt claimed at it now is refused KA080" | N/A: claim and bookkeeping share one transaction holding the lease row lock (0006:253); SEC-26 proves the wait | N/A guard |
| R9 lease INSERT/DELETE | N/A single statement | N/A | N/A | N/A | N/A | N/A | GAP SEC-29 S :: "DENY SEC-DEPTH (lease delete): kauro_control cannot DELETE a lease"; SEC-30 S :: "DENY SEC-DEPTH (lease birth): an INSERT above fence 1 is refused and caller heartbeat/created instants are replaced by server_now" | N/A (DENY SEC-29/30) |
| R10 renew/heartbeat | GAP SEC-31 S :: "RACE SEC-DEPTH: a heartbeat and a takeover of one lease, both orders held at the lease row; takeover only after expiry, the stale heartbeat NULL" | N/A | GAP SEC-32 S :: "DENY SEC-DEPTH (lease clock): an UPDATE that shortens expires_at or sets it at or before server_now is refused, so expiry cannot be manufactured before a takeover" | N/A | N/A | GAP SEC-33 S :: "OK SEC-DEPTH: with the database clock held fixed, a different caller instant passed to the port changes no claim, heartbeat or checkpoint outcome"; SEC-105 S :: "OK SEC-DEPTH (lease ttl): a renewal with a shorter TTL commits and keeps expires_at" | GAP SEC-34 S :: "DENY SEC-DEPTH (lease clock): a takeover of a live lease with a future heartbeat_at is refused KA005" | N/A |
| R10b live renewal without checkpoint (SDP-25) | N/A covered by SEC-31 | N/A | GAP SEC-103 S :: "OK SEC-DEPTH (checkpoint-free renewal): a live JOB_ATTEMPT and MODEL_TASK with no checkpoint, a SWEEP and an OUTBOX_DISPATCH re-claim and heartbeat under the same fence" | N/A guard | N/A guard | N/A single statement | GAP SEC-104 S :: "DENY SEC-DEPTH (superuser nested checkpoint clear): a same-holder UPDATE setting a stored checkpoint_hash to NULL is refused KA005" | N/A guard |
| R11 checkpoint | GAP SEC-35 S :: "RACE SEC-DEPTH: checkpoint_lease and a takeover of one expiring lease, both orders held at the lease row; the checkpoint lands only while live and the takeover names it" | N/A | GAP SEC-36 S :: "DENY SEC-DEPTH (expired checkpoint): a direct UPDATE of checkpoint_hash on an expired spending lease is refused"; supplemental SEC-36s S :: "checkpoint_lease on an expired lease returns NULL" | N/A | N/A | N/A single statement | N/A covered by SEC-34 | N/A |
| R12 carve HOLD (kauro_app) | GAP SEC-37 M :: "RACE SEC-DEPTH: two agencies' carves on one pool, both orders held at the pool lock, events seq n+1 and n+2, reserved = sum" | GAP SEC-38 M :: "RACE SEC-DEPTH (timeout): a carve authorization waiting on the pool lock past statement_timeout rolls back with no event, no hold and the carve PREPARED" | N/A pool expiry read unchanged (0023:218) | N/A guard | N/A guard | GAP SEC-39 M :: "DENY SEC-DEPTH (superuser nested grant repetition): a second superuser-owned nested increment citing a real carve authorized now is refused KA083"; SEC-40 M :: "DENY SEC-DEPTH (superuser nested grant): reserved_cents raised with no ledger event is refused KA083"; SEC-40b M :: "DENY SEC-DEPTH (superuser nested grant): reserved_cents lowered with no ledger event is refused KA083" | GAP SEC-41 M :: "DENY SEC-DEPTH: a HOLD event for a carve of another pool, another agency, or not authorized now is refused" | SEC-42 M :: "OK SEC-DEPTH (multi-row): two carves authorized in one UPDATE hold their own ceilings and leave every pool version unchanged" |
| R13 carve RELEASE (kauro_control) | GAP SEC-43 M :: "RACE SEC-DEPTH: a carve close and a control reconciliation of one pool, both orders held at the pool lock; reserved and spend exact" | N/A same lock and bound as SEC-38 | N/A | N/A guard | N/A guard | GAP SEC-44 M :: "DENY SEC-DEPTH: a second RELEASE of one carve is refused" | GAP SEC-93 M :: "DENY SEC-DEPTH (closed grant): a reconciliation of a request of a CLOSED grant and any money change of a CLOSED grant are refused KA083" | SEC-45 M :: "OK SEC-DEPTH (multi-row): two carves closed in one UPDATE release their own ceilings and spends" |
| R12b RESERVE (request insert) | GAP SEC-70 M :: "RACE SEC-DEPTH: two dispatch reservations on one grant, both orders held at the grant lock, two events and reserved = sum"; SEC-109 M :: "RACE SEC-DEPTH (lock order): a reservation naming upstream U and the reconciliation of U on the same grant, both orders held at the grant lock, commit without deadlock and with exact totals" | N/A same lock and bound as SEC-38 | N/A grant expiry read unchanged (0023:283-284) | GAP SEC-97 M :: "RACE SEC-DEPTH (commit): a ledger relation failure at COMMIT leaves no request, event, money or RECONCILED usage of the transaction" | N/A guard | GAP SEC-71 M :: "DENY SEC-DEPTH (superuser nested reserve): reserved_cents moved by a request's amount without its RESERVE event, or twice for one request, is refused KA083" | N/A | GAP SEC-88 M :: "DENY SEC-DEPTH (multi-row reserve): an INSERT of two requests whose second exceeds the ceiling at its AFTER re-check rolls back both rows, both events and the grant (KA083)" |
| R12c RECONCILE (request usage) | GAP SEC-72 M :: "RACE SEC-DEPTH: two reconciliations of different requests of one grant, both orders held at the grant lock, exact totals" | GAP SEC-96t M :: "RACE SEC-DEPTH (commit timeout): a ledger relation check slowed past statement_timeout at COMMIT rolls back request, events and grant, and a retry commits" | N/A | covered by SEC-97 | GAP SEC-98 M :: "RACE SEC-DEPTH (crash after COMMIT): reconcileRequest whose response is lost and is retried refuses PRECONDITION_FAILED and the grant moved once" | GAP SEC-73 M :: "DENY SEC-DEPTH (superuser nested reconcile): a control-session UPDATE releasing reserve or adding spend with no RECONCILE event is refused KA083 (was accepted for kauro_control)"; SEC-74 M :: "DENY SEC-DEPTH: a second RECONCILE of one request is refused"; SEC-90 M :: "DENY SEC-DEPTH (frozen usage): after reconciliation, a change of actual_cents, usage_state or reconciled_at is refused KA004"; SEC-92 M :: "DENY SEC-DEPTH (orphan event): a correct RECONCILE event at seq n+1 without the grant advancing is refused at COMMIT KA083 and the next reservation commits at n+1" | GAP SEC-94 M :: "DENY SEC-DEPTH (close): a grant with a KNOWN unreconciled request cannot reach CLOSED (KA083)" | GAP SEC-89p M :: "RACE SEC-DEPTH (partial reconcile): a reconciliation whose actual exceeds the room under the ceiling fails at the grant write and leaves the request KNOWN with no event (design §9 ceiling, 0023:92)" |
| R12d ledger evidence | N/A | N/A | N/A | N/A | N/A | N/A | GAP SEC-95 M :: "DENY SEC-DEPTH (superuser nested delete): DELETE or UPDATE of a ledger event, DELETE of a request_journal or cost_grants row is refused" | N/A (DENY SEC-95) |
| R14 capture -> allocated_cents | GAP SEC-46 M :: "RACE SEC-DEPTH: two captures of one order in two transactions, both orders held at the order lock, allocated = recount" | GAP SEC-46t M :: "RACE SEC-DEPTH (commit timeout): a deferred allocation recount slowed past statement_timeout at COMMIT rolls back captures, allocation and events, and a retry commits" | N/A | GAP SEC-47 M :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no capture, allocation or event of the transaction" | N/A guard | GAP SEC-48 M :: "DENY SEC-DEPTH (superuser nested allocation): allocated_cents above the recount at commit is refused KP002"; SEC-113 M :: "DENY SEC-DEPTH (superuser nested inflate before capture): an allocation raised before a capture does not shrink the capture's applied amount and is refused at commit KP002" | N/A | SEC-49 M :: "OK SEC-DEPTH (multi-row): two captures completed by one statement allocate 40 + 60 to a 100-cent order" |
| R15 owner count | GAP SEC-50 H :: "RACE SEC-DEPTH: removals of the last two ACTIVE owners, both orders held at the agency row; the second is refused KA001 by the membership count" | GAP SEC-50t H :: "RACE SEC-DEPTH (commit timeout): an owner recount slowed past statement_timeout at COMMIT rolls back the membership change, and a retry commits" | N/A | GAP SEC-51 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves the membership change unapplied" | N/A guard | GAP SEC-85 H :: "DENY SEC-DEPTH (founding owner): a founding OWNER birth with the counter zeroed while an ACTIVE OWNER membership exists is refused KA008" | GAP SEC-52 H :: "DENY SEC-DEPTH (superuser nested owner count): an inflated active_owner_count is refused at commit KA004"; SEC-82 H :: "DENY SEC-DEPTH (inflate, remove, restore): a superuser-owned nested count raise, the demotion of the sole ACTIVE owner, and a nested restore are refused KA001 at the demotion" | SEC-53 H :: "OK SEC-DEPTH (multi-row): one statement adding two owners commits count + 2" |
| R16 recurrence | GAP SEC-54 H :: "RACE SEC-DEPTH: two first captures of one agency, both orders held at the recurrence advisory lock, count = purchases"; SEC-110 H :: "RACE SEC-DEPTH (older transaction): a designation in a transaction older than a committed designation is refused KC001 and its retry commits with seq n+1" | GAP SEC-54t H :: "RACE SEC-DEPTH (commit timeout): a recurrence recount slowed past statement_timeout at COMMIT rolls back purchase, recurrence and consumption, and a retry commits" | N/A | GAP SEC-55 H :: "RACE SEC-DEPTH (commit): a recount failure at COMMIT leaves no purchase, recurrence or consumption" | N/A guard | GAP SEC-56 H :: "DENY SEC-DEPTH (superuser nested recurrence): a confirmation_count not equal to the purchases at commit is refused KC001"; SEC-86 H :: "DENY SEC-DEPTH (recurrence instant): a nested future last_confirmed_at in an otherwise valid designation is refused KC001 and the next designation commits" | N/A | SEC-57 H :: "OK SEC-DEPTH: the first designation (upsert before purchase insert) commits" |
| R18 audit fence (G6) | GAP SEC-75 S :: "RACE SEC-DEPTH: two step claims of one audit, both orders held at the audit row, one fence + 1" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-76 S :: "DENY SEC-DEPTH (superuser nested audit fence): audits.fence moved with no step claimed at it now, or by more than one, is refused KA080" | N/A | N/A guard |
| R19 commercial history (G7) | GAP SEC-77 H :: "RACE SEC-DEPTH: two transitions of one subject, both orders held at the subject row, two history rows of consecutive versions" | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-78 H :: "DENY SEC-DEPTH (superuser nested history): a history row for a subject version not current, another state, or a duplicate version is refused KA004"; SEC-100 H :: "DENY SEC-DEPTH (history scope): a corporate row carrying its subject's agency, and a FoundingReservation row with NULL or another agency, are refused KA004"; SEC-101 H :: "DENY SEC-DEPTH (history self-edge): a forged CommissionLine ADJUSTED to ADJUSTED row for a version bumped without a state change is refused KA004" | GAP SEC-102 H :: "OK SEC-DEPTH (history attribution): a nested history row with a future recorded_at or another actor persists server_now and the session's user" | SEC-99 H :: "OK SEC-DEPTH (history scope): each of the 11 attachments records a birth and a transition; the 10 corporate rows carry NULL agency, CommissionEntitlement, CommissionLine and CommissionHold included" |
| R20 founding consumption (G8) | N/A covered by SEC-54 (same advisory lock) | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-79 H :: "DENY SEC-DEPTH (superuser nested consumption): CONSUMED with no purchase naming it confirmed now is refused KC001" | N/A | N/A guard |
| R21 qualifying purchase (G10) | N/A covered by SEC-54 | N/A guard | N/A | GAP SEC-111 H :: "DENY SEC-DEPTH (reservation reverse): a RESERVED_SLOT purchase whose reservation is not CONSUMED by its authorization at COMMIT is refused KC001" | N/A guard | GAP SEC-80 H :: "DENY SEC-DEPTH (superuser nested purchase): a purchase whose authorization was not born now, or whose amount, instant or basis differs from its facts, is refused KC001" | N/A | N/A guard |
| R22 admission instants (G11/G12) | N/A guard (0044 race rows stand) | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-81 S :: "DENY SEC-DEPTH (superuser nested admission): a future, past or unadmitted last_admission_at / last_admitted_at is refused KA082" | N/A | N/A guard |
| R23 authorization bounds (G14) | N/A guard (B08's 0021/0022 race rows stand) | N/A guard | N/A | N/A guard | N/A guard | GAP SEC-106 S :: "DENY SEC-DEPTH (superuser definer flush): a superuser-owned definer consuming an ACTIVE authorization with no admission, with its event and SET CONSTRAINTS ALL IMMEDIATE, is refused KA081"; SEC-107 S :: "DENY SEC-DEPTH (superuser definer flush): CONSUMED to DELIVERED with no READY job and AVAILABLE package is refused KA081" | GAP SEC-108 S :: "OK SEC-DEPTH (real execution facts): consumption through queueJob and admitJob and delivery through publishJob commit for the oracle-free fixtures" | N/A guard |
| R17 catalog gate | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A; S :: "SEC-DEPTH catalog: no kauro function reads pg_trigger_depth() or rolsuper, is_control_session() guards no value, no kauro function is SECURITY DEFINER, and the 11 history attachments equal kauro.commercial_machines" |

Timeout bound for SEC-38/46t/50t/54t/96t: the transaction's `SET LOCAL statement_timeout` (runtime-transaction.ts:56; the test sets
200 ms and slows the check with an oracle-made `pg_sleep` hook), expecting 57014, the complete rollback footprint and a clean retry.

C1 Baseline proof. Must FAIL on 21b310f through base SQL only (the superuser-owned probe uses no new function or signature):
SEC-24, 25, 28, 28b, 29, 30, 32, 34, 36, 39, 40, 40b, 48, 52, 56, 71, 73, 76, 78, 80, 18, and new in r9: SEC-82, 86, 90, 93, 94,
95, 100, 101, 102, 104, 106, 107, 111, 113. New-ledger-only (no baseline object; fail with the B3 deferred checks reverted): SEC-92,
SEC-96t, SEC-97. Supplemental (already refuse on main): SEC-79, SEC-81, SEC-85, SEC-88, SEC-59. OK siblings, RACE titles and R1/R2
checks other than SEC-18 are not baseline failures; SEC-103 additionally FAILS against the r8 literal B2 predicate (regression proof).

C2 OK siblings (each DENY above -> the production-writer title that must commit; S/M/H as the DENY's file):
SEC-24/25 -> "OK SEC-DEPTH: admission and a retry attempt advance attempt_count to the attempt born now"; SEC-28/28b -> "OK
SEC-DEPTH: a takeover claim moves the job fence to the attempt claimed now"; SEC-29/30 -> SEC-27b; SEC-32/34 -> "OK SEC-DEPTH: a
heartbeat on the server clock renews a live lease"; SEC-36 -> "OK SEC-DEPTH: checkpoint_lease on a live lease stores the checkpoint";
SEC-104 -> SEC-103; SEC-39/40/40b/41 -> SEC-42; SEC-44 -> SEC-45; SEC-71/88 -> "OK SEC-DEPTH (reserve): single-row, multi-row and
separate-statement reservations commit with one RESERVE event each"; SEC-73/74/90/92/93 -> "OK SEC-DEPTH (reconcile):
reconcileRequest, reconcileUsage and storeResponse with RECONCILED each move the grant once through one RECONCILE event"; SEC-94 ->
"OK SEC-DEPTH (close): the control sweep reconciles KNOWN usage and closes the grant in one transaction"; SEC-95 -> none (no
production writer deletes; stated); SEC-48/113 -> SEC-49; SEC-52/82 -> "OK SEC-DEPTH: demoting one of two ACTIVE owners commits with
count 1"; SEC-85 -> "OK SEC-DEPTH: CreateAgency's founding owner is born ACTIVE"; SEC-56/86 -> SEC-57 and "OK SEC-DEPTH: a second
designation commits with last_confirmed_at = its confirmed_at"; SEC-76 -> "OK SEC-DEPTH: a step claim moves audits.fence by one to
the step claimed now"; SEC-78/100/101 -> SEC-99; SEC-79 -> SEC-57; SEC-80/111 -> "OK SEC-DEPTH: designations with founding basis NONE,
RESERVED_SLOT and UNBACKED commit with every column equal to its facts"; SEC-81 -> "OK SEC-DEPTH: an admission stamps
last_admission_at and last_admitted_at with server_now"; SEC-106/107 -> SEC-108; SEC-05/18/59/112 -> "OK SEC-DEPTH: the pool admits a
clean runtime login and 0045 passes on a clean cluster".

## D. Accepted packages touched (A6: re-verify only these titles)

B06: S090/B06-R1 (journals-leases.test.ts:268, :312-316, :335; adapters-leases.test.ts:32, :123, :158, :217, :242), pool
verification, aggregate-kinds.test.ts:445, adapters-journals-outbox.test.ts:265 (reconcileUsage now accounts; its grant must have
room), S050/R2-043 via L3. B08: S056 (execution-migrations.test.ts:261; callers execution-adapters :331, execution-migrations :150),
R2-046 (admission-instants.test.ts:218-286), R2-044/S041/IC-12 (audit-migrations.test.ts:89, audit-adapters :286,
grant-reconciliation.test.ts:31, b08-end-to-end.test.ts:306), the D8-PEX-8 test (execution-migrations.test.ts:783-795, inverted),
FH-R2; audit fence (G6), admission instants (G11/G12). B09: R2-140, S058/S057 (b09-migrations.test.ts:278, :307), B09-F2
(b09-critique.test.ts:346), S059 (b09-scenarios.test.ts:299). B10: d27uow, history, purchases, recurrence via L3; every 0028
trigger (EXECUTE revoke); commission-support.ts:707 callers (b10-commission-service.test.ts:211, b10-failure-cells-accrual.test.ts
:507, :766). B07: none.

D1 G14 fixture moves (SDP-23; the kit helpers drive only production writers, never the oracle):
- execution-migrations.test.ts:783-795: the stand-in now expects KA081 at COMMIT (title "D8-PEX-8 withdrawn: the superuser oracle is
  bound by the consumption and delivery edges"); SEC-106/107 cover the definer route.
- b09-critique.test.ts:346-349: `consumeThroughExecution(h, A, second.authorizationId)` (queueJob -> admitJob); `endJob` after the
  KP013 assertion frees the ACTIVE slot (R2-046 capacity).
- apps/api/test/b09-scenarios.test.ts:299-315 and apps/api/test/commission-support.ts:707-730: `deliverThroughExecution(h, agency,
  authorizationId)` (queueJob -> admitJob -> launchJob -> stageJob -> verifyJob -> publishJob); commission-support returns the
  DELIVERED event id read from domain_events. The "B08 is not on this branch" comments are removed.
- Verify-before-spend (kit lane): run each caller once with the helper on base 21b310f before L2a removes the skips; a world that
  lacks a fact the admission needs fails with the helper's message, never falls back to the oracle.

## E. Lanes (file ownership; kit first)

| Lane | Files owned | Rows | Est. | Model |
|---|---|---|---|---|
| K kit | src/testing/depth-probe.ts (`nestedAsSuperuser`, `slowCheckHook`), src/testing/execution-delivery.ts (`consumeThroughExecution`, `deliverThroughExecution`), src/testing/index.ts | - | 45 min, 90k | claude-sonnet-5-5 |
| L0 fixtures | b09-critique.test.ts, apps/api/test/b09-scenarios.test.ts, apps/api/test/commission-support.ts | D1 | 40 min, 100k | claude-sonnet-5-5 |
| L1 hardening | migrations/0045, src/pool.ts, R, admission-instants, aggregate-kinds, fault-harness tests | R1, R2, R17 | 70 min, 160k | claude-sonnet-5-5 |
| L2a jobs+leases+audit+admission+bounds | migrations/0046, 0047, src/lease-store.ts, src/execution/store.ts, src/audit/store.ts (:488 only), S, journals-leases, adapters-leases, execution-adapters, execution-migrations, audit-adapters tests | R7-R11, R10b, R18, R22, R23 | 160 min, 380k | Opus |
| L2b money | migrations/0048, 0049, src/audit/store.ts (:582-600), M, audit-migrations, grant-reconciliation, adapters-journals-outbox tests | R12-R14, R12b-d | 170 min, 420k | Opus |
| L3 commercial | migrations/0050, 0051, H | R15, R16, R19-R21 | 140 min, 330k | Opus |

src/audit/store.ts is split by line ranges (L2a :488, L2b :582-600): L2a lands first, L2b rebases. Order K -> L0 -> (L1 || L2a ||
L2b) -> L3; L2a needs L0 merged (B10 removes the skip the old fixtures used). Done = every GAP rewritten to C with its title; C1
shown failing on 21b310f (log) and passing on the branch; C2 siblings green; full suites green in ci-local (WSL + Windows). Total
about 10.4 h agent time, 1.48M tokens.

## F. Decisions and open questions

- Q1 closed by B3 r9: money moves only through events, events only from their sources, both directions and the complete relation are
  checked, and the evidence is frozen.
- Q2 (accepted) the port keeps `now`; every SQL `p_now` overload removed; SEC-33 keeps clock independence; port removal is a
  follow-up (B06 domain + 3 dispatchers).
- Q3 withdrawn: per-source events, no SUM.
- Q4 Section A is hardening; P2 states the guard-execution boundary and enforces the runtime half.
- Q5 answered by the B7 registry table (11 attachments, scope, stamps).
- Q6 REVERSED by the coordinator in r9: both `rolsuper` skips are removed (B10); D1 lists the fixture moves.
- Caveats turned into cells (no "by design" left to the reviewer): an over-ceiling reconciliation is refused and stays KNOWN
  (design §9 ceiling CHECK 0023:92, D8-GRANT-2; SEC-89p); an older-transaction designation is refused and retried, never recorded
  out of order (0028:458; SEC-110); the CLOSED edge now needs every request RECONCILED (the sweep already does so, F8; SEC-94).
- No owner act is needed.

## Appendix. Handed to B14 (S-A, Terraform/IAM): requirements + Codex findings r4-r6 verbatim

No design here; B14 designs and Codex-reviews it. Since r8 no database guard depends on which login writes (P1), so B14-R1..R3
protect credentials and least privilege; the P2 boundary (runtime roles outside the TCB) is a correctness assumption B14 must keep.
Database facts B14 can rely on: A1 hardening, the P2 failure conditions of 0045 and the A2 pool checks.
- B14-R1 Runtime credentials (pool and Data API) exist only for a login of this RUNTIME LOGIN shape for the intended group G (one
  of the seven): LOGIN, INHERIT, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOBYPASSRLS, NOREPLICATION; exactly one pg_auth_members row
  with member = login, namely (roleid = G, admin_option FALSE, inherit_option TRUE, set_option TRUE); rows with roleid = login only
  for the database owner's ADMIN-only creator edge (admin TRUE, inherit FALSE, set FALSE); owns no object in any database; no
  database or role setting; no direct ACL entry outside kauro and kauro_meta; no pg_parameter_acl entry. An existing role is adopted
  only if it already has exactly this shape (an extra outgoing membership, an option or an attribute refuses it), bound by name and
  oid; never any other login's credential.
- B14-R2 Secret identity (username, endpoint, database) and ARN ownership are validated BEFORE any password, secret version or label
  mutation; authentication failure never authorises adopting a differently named secret.
- B14-R3 Immediately before a credential becomes readable by a runtime principal, the login passes the A2 pool checks.
- B14-R4 Every external effect (secret write/promotion/deletion, IAM put/delete) is fenced against late completion after lock or
  session loss, for the same login as well as across logins; one IAM policy per login; bounded lock and call timeouts.
- B14-R5 Tests assert final working authentication and final IAM/secret access, not object counts; fake ports model the first
  secret version receiving AWSCURRENT automatically.
- B14-R6 (P2) Production TCB: the RDS master and the migrator are the only principals that own kauro objects or hold SET on
  session_replication_role; neither credential is readable by a runtime principal; no SECURITY DEFINER routine owned by them is
  executable by a runtime group outside the RDS-provided set, which B14 lists by name and verifies at provisioning.

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
