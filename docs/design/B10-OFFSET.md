# B10-OFFSET: offsets are claims that yield; seller credit and noncash settlement are durable (design r5, D10-NEG-4..7)

Lane `B10-OFFSET` (branch `b10/offset`, builds after kit PR1 merges). r1 = 97839bd; r2 answers Codex design review r1
(`tools/review/out/b10-offset-design-97839bdc0b32`, REJECT, OFF-R1..R8); r3 answers design r2 on 18ca05b
(`tools/review/out/b10-offset-design-r2-18ca05bdf51e`, REJECT: OFF-R1..R3, R5, R7, R8 FIXED; OFF-R4, OFF-R6 PARTIAL; OFF-R2-01..04 new); r4 answers design r3 on af1ff58
(`tools/review/out/b10-offset-design-r3-af1ff58c9899`, REJECT, converging: r2 defects and release guards FIXED; OFF-R3-01, OFF-R3-02 new; OFF-R6 PARTIAL); r5 answers the internal design-closure adversary on 744dd25
(`.kauro/reviews/b05-r3-offset-r4-design-adversary.md`, NOT_READY: ADV-OFF-1 MAJOR, ADV-OFF-2..4 MINOR; §0.1). Supersedes D10-NEG-3 and the provisional
`0045_offset_capacity_holds.sql` (843bf01; reverted on the kit by f78af7b). Inputs: adversary ADV-3, ADV-9, ADV-10, ADV-14, ADV-15,
ADV-17, ADV-18. Governing text: 17 "Refunds after payout and negative balances" (the statement shows original accrual, payout,
adjustment and current balance), 17 "Accrual, eligibility and payout" (approved undisputed payable amounts; no minimum payout), 17
"Compensation adjustment follows the economic reversal", 17 "An unresolved claim dispute holds only the contested compensation
allocation"; R2-102, R2-104; registry machines CommissionLine and CommissionStatement (unlisted edges rejected: r2 adds no state and no
edge); design §6, §7, §10; D10-HOLD-1, D10-NEG-1, D10-NEG-2, D10-STMT-2, D10-STMT-4, D10-GAP-8, D10-GAP-12, D10-GAP-24.

## 0. Codex design r1 findings and their resolution

| finding | resolution (section) |
|---|---|
| OFF-R1 BLOCKING seller credit unpaid | durable append-only seller credit ledger `seller_credit_entries`, reconciled in the COMMIT of every writer that changes a settled line's due; consumed exactly once by CREDIT statement items paid in cash; oracle INV-S-16 proves no cent lost (§2.4, §4, ex. H, J) |
| OFF-R2 correction lock union | restricted source rule with a conservation proof: a transaction releases only claims it is applying, so its lock set is its lines plus their claims' sources, discovered, locked, re-discovered (§2.5, §5) |
| OFF-R3 CMD053 lock set | CMD053 (FAILED, RETURNED and SETTLED) prelocks its complete set, rows then subjects, before the first transition (§5) |
| OFF-R4 direct release guards | every release INSERT takes its receiving line's subject before reading live; settled claims refused; applied claims only through an atomic cancellation, checked at COMMIT; direct INSERT granted to the commission service only (§4) |
| OFF-R5 payout failure after full refund | zero-entitlement cancellation: no hold, no HELD; the application is cancelled with the predecessor CORRECTED, the claims released, the line carried at 0 (§2.3, ex. G0) |
| OFF-R6 matrix completeness | hold-RESOLVED, noncash, credit, CMD053 SETTLED rows added; explicit writer-pair table, each pair a held RACE test or a named serialization (§7) |
| OFF-R7 zero-cash settlement | noncash settlement fact `commission_noncash_settlements` at the pay date; the line stays PAYABLE and the statement ISSUED (registry), both frozen; source admission counts noncash settlement; paid_cents stays cash (§2.6, ex. I) |
| OFF-R8 MINOR three concepts | unapplied, applied, settled claims and the cancelled application, defined once (§2.1) and used by D10-NEG-4 |
| Q10-11 | closed (engineering): released to the source, newest first, final |
| Q10-12 | split: noncash lifecycle and credit recognition decided here; credit payout timing is the owner's (§9 OQ-2) |

r3 (design r2 findings):

| finding | resolution (section) |
|---|---|
| OFF-R2-01 BLOCKING concurrent CREDIT items | every CREDIT item INSERT (close, correction, direct) passes `statement_items_credit_guard`, which takes the line's subject before reading recognized and itemized credit; the deferred check stays as backstop; RACE C13 (§2.4, §4) |
| OFF-R2-02 CREDIT payout bypasses the hold fence | payout admission (`payout_lines_unpayable`, KC018 trigger, CMD052) takes the shared subject of every CREDIT item's line with its PAYABLE lines, ascending, and refuses an OPEN hold the statement does not withhold or funds not AVAILABLE on it; no PAYABLE state required (§2.4, §4; C11, S55, S56) |
| OFF-R2-03 noncash freeze vs increases | the freeze covers state edges, payable owner and the statement only; adjustments post in both directions through the KC015 chain and the credit reconcile records an increase (§2.6; C12, S49) |
| OFF-R2-04 cutoff misses offsets and credit payments | KAURO_COMMISSION_CUTOFF_V2 hashes offsets, releases, credit entries, CREDIT items with their statement state, noncash settlements (§2.8; S57, S58) |
| OFF-R4 PARTIAL release guards | the guard records the applying statement at INSERT; at COMMIT a release of an applied claim requires that statement CORRECTED with no AUTHORIZED, SUBMITTED or SETTLED intent, whatever the line's final state; settlement is refused at INSERT and again at COMMIT (§4; T28, T29) |
| OFF-R6 PARTIAL pairs | funds-observation, C-ST, HR-NC, I-NC, NC-NC, different-object pairs (HR-U, F-F, ST-ST, K-K) each a held RACE or a stated non-interaction; TIMEOUT cells for guarded INSERTs; discovery growth S54; NC retry S50 (§7) |
| (r4) OFF-R3-01 direct CREDIT insert lock inversion | every guarded INSERT guard takes the prefix rows its FKs will lock (statement row, then the line row, KEY SHARE) **before** the subject, so the FK's later KEY SHARE is already held; audit of all four guarded INSERTs (§4, §5.1); RACE C14, C15, T30, S59 |
| (r4) OFF-R3-02 cutoff misses funds | V2 hashes each close line's capture's latest funds observation (id, capture version, funds state); `observeFunds` takes the capture's line rows and subjects first (D10-GAP-24), so the close's locks hold them still (§2.8); S60, S61 |
| (r4) OFF-R6 PARTIAL | U-ST S62 and U-NC S63 (zero credit either order); RELEASED tests assert the order's credit and the conserved total (line cash + credit = entitlement); PARTIAL cells now inject a failure at a later write (Y24, C16, S64-S68) or are N/A for one INSERT; every pair in §7 is a cell or a written non-interaction proof |
| rule 16 (lock-set family, third round) | added to FAILURE-MATRIX-TEMPLATE.md; §5.1 sweeps every guarded aggregate: offsets, releases, credit entries, CREDIT items, noncash settlements, cutoff |

### 0.1 Revision r5: adversary findings (internal adversary on 744dd25)

| finding | closed in (section) | tests (exact titles in §6) |
|---|---|---|
| ADV-OFF-1 MAJOR multi-row lock order (credit entries, offsets, releases, CREDIT items, multi-statement sweeps) | §5 G-ORD-1 :235 (one blocking acquisition per transaction, then pre-locked or non-blocking; refusal `commission_lock_order`); §5 noncash sweep :266; §5.1 :280; §7 M15 :490; §8 :519; §9 OFF-C9 :551 | T31, T32, T33, Y26, C19, C20, C21, S70, S71, S72 |
| ADV-OFF-2 MINOR FK audit incomplete | §4 FK audit :194: all FKs of the five guarded INSERTs with their parent's lock position (offsets -> seller_agreements 0030:245; statement_items -> adjustment, hold, offset, project 0031:203-206) | S74 (projects, the only parent with an explicit FOR UPDATE holder); the others are proofs (append-only or no FOR UPDATE holder) |
| ADV-OFF-3 MINOR S60/S61 inconsistent | §2.8 :140 (the proposal's read position named); S61 retitled :417 | S60, S61 |
| ADV-OFF-4 MINOR noncash guard shared subjects | §4 noncash guard :189 takes **exclusive** subjects; §5 noncash sweep :266; §5.1 | S73 |

## 1. What is wrong on 0030 today (latent: `recordOffset` has no production caller, OQ-1)

ADV-3/14 admission ignores OPEN holds; ADV-9 PAYABLE receiving lines and never-paid sources admitted; ADV-10 no lock, two offsets that
each fit commit together; ADV-15 a refund, VOID or hold after the offset loses the unapplied part; E a refund after application loses
the applied part (R's position counts cash only); NEW-1 an INCREASE above what a settled line was paid, and the withheld part of a
partial hold released after payment, are never paid; OFF-C7 an all-offset statement never settles; ADV-17 pool-by-pool line locks.

## 2. Model

Per line L, cents: E = `cumulative_entitlement_cents`; P = `coalesce(paid_cents, 0)` (cash through L's own LINE item, INV-S-05,
unchanged); H = OPEN holds; live(o) = o.amount - releases of o; claims(L) = live claims against L; out(L) = live claims from L.

### 2.1 Claim states (OFF-R8)
- **Unapplied claim**: live, and no live PAYABLE LINE item of its receiving line R counts it (R in ACCRUED_PENDING, ELIGIBLE, HELD, VOID).
- **Applied claim**: counted in the `offset_cents` of R's live PAYABLE LINE item (statement ISSUED, DISPUTED or APPROVED, not CORRECTED,
  no noncash settlement), while that item can still pay. Holds and decreases never release it.
- **Settled claim**: its item's statement is PAID (cash) or carries a noncash settlement (§2.6). Irreversible: never released.
- **Cancelled application**: an applied claim whose item is superseded **in the same COMMIT** by a correcting statement (correction;
  CMD053 FAILED or RETURNED; the zero-entitlement cancellation), the predecessor having no AUTHORIZED, SUBMITTED or SETTLED intent
  (an APPROVED statement has no edge to CORRECTED). It becomes unapplied in that COMMIT: re-applied by the successor's item within
  capacity, the rest released (causes STATEMENT_COMPOSED, PAYMENT_CANCELLED).

### 2.2 Admission
An offset is admitted only against an ELIGIBLE R, only from a **settled** source N (PAID or ADJUSTED, or PAYABLE through a noncash-settled
item), within cap(R) - claims(R), cap(R) = max(0, E - P - H), and within pos(N) - out(N), pos(L) = P + A_in(L) + C_paid(L) - E, where
A_in = applied or settled claims against L (noncash settlement of L) and C_paid = CREDIT cents of L on PAID statements (cash).

### 2.3 Yield (holds and decreases are never refused because of offsets)
On an unapplied R, every write that lowers cap(R) below claims(R) releases the excess in its own COMMIT, newest offset first
(recorded_at DESC, offset_id DESC), never beyond live(o): append-only `commission_offset_releases` rows, causes HOLD_OPENED,
ENTITLEMENT_DECREASED, LINE_HELD. A release is final (a hold RELEASED later restores capacity, not the claim). The released cents are
N's position again. **Zero-entitlement cancellation (OFF-R5):** CMD053 FAILED or RETURNED on a statement with a PAYABLE line whose
unpaid E - P is 0 (refunded to zero while PAYABLE) opens no hold and moves no line to HELD (a 0-cent hold is impossible): the intent kept
FAILED or RETURNED with its evidence (terminal payout evidence), the predecessor CORRECTED by its successor in the same COMMIT, the line's
applications cancelled and released (PAYMENT_CANCELLED, cap 0), the line carried PAYABLE through the successor at payable 0, offset 0
(movePayableOwner, 0037); it settles with the successor (cash PAID, or noncash §2.6). Lines with unpaid > 0 take the HELD PAYOUT_FAILED
path, which releases at the HELD edge (LINE_HELD) under the same cancellation.

### 2.4 Seller credit (OFF-R1): a durable receivable, consumed exactly once
For a settled line L (PAID, ADJUSTED, or PAYABLE through a noncash-settled item): X(L) = E + Aout(L) - P - A_in(L) - H, where Aout =
applied or settled claims from L. X > 0 is owed to the seller: an INCREASE above what L settled (largest remainder, r3 R3-01), an
over-recovery (L's position shrank under claims already applied), or the cents a partial hold withheld when L settled, once RELEASED.
`seller_credit_entries` (append-only; RECOGNIZED +, REVERSED -) holds, per line, R - V = max(X(L), itemized(L)), itemized = CREDIT
cents of L in statements not CORRECTED (live or PAID). `kauro.seller_credit_reconcile(L)` writes the one difference row and is called,
under L's subject, in the COMMIT of every writer that changes X or itemized: line UPDATE of E or state (trigger), hold INSERT and
resolution on a settled line (trigger), application and cancellation of claims from L (close, correction, CMD053), the noncash settlement.
A REVERSED row can only reduce recognized credit not yet itemized (by construction of max). **Consumption:** each close (and correction)
itemizes outstanding(L) = (R - V) - itemized(L) > 0 as one CREDIT item (kind CREDIT, disposition CREDIT, payable_cents = outstanding),
included in the statement's payable and paid in cash by its payout (OQ-2 confirms timing); on PAID it is C_paid; on a FAILED payout the
successor carries it again in the correcting COMMIT. Every CREDIT item INSERT, on any path, takes L's subject before it reads R - V and itemized(L) and is refused
beyond (OFF-R2-01); a deferred check repeats it at COMMIT. **Payout of a CREDIT item (OFF-R2-02):** CMD052 and the intent INSERT
trigger take the shared subject of each CREDIT item's line together with the PAYABLE lines, ascending, and refuse (409 STALE_VERSION
LEDGER_CHANGED; KC018) a CREDIT line carrying an OPEN hold the statement does not withhold or whose capture's latest funds are not
AVAILABLE (D10-GAP-23); the line need not be PAYABLE. A hold opened after itemization keeps R - V = itemized while the item is live
(the item cannot pay); the correction that supersedes it reverses the now-unsupported credit (ITEM_CANCELLED) and itemizes only X.

### 2.5 Source position shrink, restricted rule (OFF-R2)
A transaction that applies claims (close, correction) applies from each source N at most allowance(N) = max(0, pos(N) - Aout(N)), Aout
excluding applications it is itself cancelling; the excess is released newest first **among the claims this transaction applies**
(POSITION_SHRANK), under their receiving lines' subjects, which it holds. Proof: after the COMMIT, Aout(N)' = Aout(N) + applied ≤ pos(N),
when it applies anything, and it applies nothing from N when Aout(N) already exceeds pos(N): no additional over-recovery (a prior
excess, from a shrink after application, is X(N) > 0, seller credit); releases only lower live(o) under R's subject; unapplied claims beyond allowance elsewhere stay unapplied and
face the same rule when applied. Over-recovery from applications made before the shrink is X(N) > 0: seller credit (§2.4).

### 2.6 Noncash settlement (OFF-R7; the engineering part of Q10-12)
An applied offset is noncash settlement; `paid_cents` stays cash. A statement ISSUED (not DISPUTED, not CORRECTED) with payable_cents =
0 and at least one PAYABLE LINE item is settled noncash by the PERIODS sweep on its pay date (`pay_due_on`, server clock, Bogota): one
`commission_noncash_settlements` row (statement id and version, its PAYABLE LINE items' ids and offset_cents, the applied offsets' ids
and live cents, the statement's cutoff hash, a digest of those, pay date, server instant) after the 0036 line fence (no OPEN hold the
statement does not withhold). No payout intent is created or faked. Registry states are unchanged (no new edge): its lines stay PAYABLE
and the statement ISSUED, both **frozen** by guards: the statement refuses every transition (no approval, no correction); the lines
refuse every state edge and every change of payable owner, while cumulative adjustments post **in both directions** through the KC015
chain (largest remainder can raise one share when the pool falls: 8/5/1 of 14 to 7/4/2 of 13), each reconciled as seller credit or
debt under the line's subject (OFF-R2-03). Its claims are settled; its lines are
settled sources (§2.2) and settled credit lines (§2.4). A mixed statement (cash payable > 0) settles its zero-cash lines with its payout
(PAYABLE to PAID, paid += 0) as today. The seller disputes before the pay date (ISSUED to DISPUTED stops it), as with a cash payout.

### 2.8 Cutoff (OFF-R2-04): KAURO_COMMISSION_CUTOFF_V2
The close's proposal hash (`commissionCutoffHash`, design-owned, not authority) moves to domain `KAURO_COMMISSION_CUTOFF_V2`: V1's
lines, adjustments and holds plus, for the close's lines, offsets (id, source, receiver, amount), releases (id, offset, amount, cause),
seller credit entries (id, line, kind, amount), CREDIT items with their statement's id and state, noncash settlements (id,
statement), and for each capture of the close's lines its latest funds observation (observation id, capture version, funds state),
which decides PAYABLE or AWAITING_FUNDS (D10-GAP-23; OFF-R3-02). Every economic input the composition reads is hashed: an offset recorded or a CREDIT item paid after the proposal changes
the hash and the close refuses STALE_VERSION LEDGER_CHANGED. Under the close's locks (all lines FOR UPDATE, then subjects) none of
these can change (each writer needs a line row or subject the close holds; a funds observation is written after its capture's line rows and
subjects, D10-GAP-24), so the second read equals what is composed. The proposal is read in its own unit before the close's locks
(ADV-OFF-3): an observation committed before that read is in the proposal and the close composes AWAITING_FUNDS (S61); one committed
after the read and before the close took the capture's line rows changes V2 and the close refuses LEDGER_CHANGED (S60); one arriving
after the close took those rows waits and lands after the close (S61). The close's
own releases and credit entries are written after the comparison, in its COMMIT.

### 2.7 Statement
OFFSET items report live(o) at the close (none at 0); N's balance left = pos(N) - out(N); a PAYABLE line whose E fell below its applied
claims reports pos > 0 as a negative balance (RECOVERY item without SIGNED terms); CREDIT items as §2.4. composeStatement never clips:
claims beyond an ELIGIBLE line's E - P - H, or applied beyond a source's allowance, are integrity faults (RangeError): the writers yield
first. Release causes: HOLD_OPENED, ENTITLEMENT_DECREASED, LINE_HELD, STATEMENT_COMPOSED, PAYMENT_CANCELLED, POSITION_SHRANK. Credit
causes: ENTITLEMENT_CHANGED, HOLD_CHANGED, LINE_SETTLED, CLAIMS_APPLIED, APPLICATION_CANCELLED, ITEM_CANCELLED (`COMMERCIAL_VOCABULARY`).

## 3. Worked examples (cents). N: paid 4000, E 3400, pos 600. R: ELIGIBLE, E 1000. o1 = 600 (N to R). Check: cash - entitlement = debt - credit

| # | event | today (0030; 0045 where named) | r2 |
|---|---|---|---|
| A | full refund of R: E 0, VOID | N left 0: **600 lost** | releases 600 (ENTITLEMENT_DECREASED); debt 600 = 4000 - 3400 |
| B | refund of R to 400 | clipped to 400, N left 0: **200 lost** | releases 200; close applies 400, payable 0; debt 200 = 4000 - 3800 |
| C | SELLER_DISPUTE hold 1000 on R | 0045 refuses the hold; 0030 holds it, claim stuck on HELD R | hold opens, releases 600 (HOLD_OPENED); RELEASED later: R paid 1000 cash, debt 600 = 5000 - 4400 |
| D | hold 500; UPHELD + correction -500 (one txn, X-B12-1) | 0030: clipped to 500, **100 lost** | hold releases 100; nothing more; close applies 500; debt 100 = 4000 - 3900 |
| E | R paid 400 cash with o1 applied, then refunded to 0 | pos(R) 400: **600 lost** | pos(R) = 400 + 600 - 0 = 1000 = 4400 - 3400 |
| F | pos(N) 1, 1-cent claim on ELIGIBLE R, N +1 cent | 1 cent over-recovered | the next close applies within allowance 0: releases 1 (POSITION_SHRANK) |
| G | R PAYABLE (offset 600, cash 400), payout FAILED | claim stuck on HELD R | R HELD PAYOUT_FAILED; the application cancelled, 600 released (LINE_HELD); successor shows debt 600 |
| G0 | as G but R refunded to 0 before the FAILED evidence | HELD impossible (0-cent hold): CMD053 cannot commit | zero-entitlement cancellation: no hold, intent FAILED, predecessor CORRECTED, 600 released (PAYMENT_CANCELLED), R carried at 0; debt 600 = 4000 - 3400 |
| H | as E without refund (R PAID: 400 cash + 600 applied), then N +1 (E 3401) | 1 cent never paid | X(N) = 3401 + 600 - 4000 = 1: RECOGNIZED 1 in the increase's COMMIT; next statement CREDIT 1 paid in cash: 4401 = 4401 |
| I | R E 600, o1 600 applied, statement payable 0 | NOTHING_PAYABLE forever; refund of R then lost (R never a source) | pay date: noncash settlement; R settled; refund of R to 0: pos(R) = 0 + 600 - 0 = 600, R admitted as a source |
| J | R E 1000, hold 300 OPEN at close, paid 700; hold RELEASED | 300 never paid | at PAID, X = 1000 - 700 - 300 = 0; RELEASED: X = 300, RECOGNIZED 300 (HOLD_CHANGED); next statement CREDIT 300 |

## 4. Guards and invariants

Database guards (named, each its own DENY test, rule 12):
- `commission_offsets_authorized`: KC017 (0030); `commission_offsets_amount` (23514) for each of: source never settled; amount >
  pos(N) - out(N); amount > cap(R) - claims(R); `commission_offsets_applicable` (23514): R not ELIGIBLE.
- `commission_offset_releases_guard` (BEFORE INSERT): takes the receiving line's row (KEY SHARE) and then its subject **before** reading live; records on the row
  `applying_statement_id` = the statement of the receiving line's live PAYABLE LINE item (not CORRECTED; the oldest when a successor is
  already in the same COMMIT), or NULL; refuses `commission_offset_releases_within_live` (amount > live) and
  `commission_offset_releases_settled` (the applying statement PAID, or noncash-settled, or the line PAID or ADJUSTED).
- `commission_offset_releases_applied` (deferred constraint, at COMMIT, every release of the transaction, whatever the receiving
  line's final state): a release with an applying statement commits only if that statement is CORRECTED and has no AUTHORIZED,
  SUBMITTED or SETTLED intent; `commission_offset_releases_settled` is checked again at COMMIT (a release followed by the applying
  statement's settlement in the same transaction is refused). OFF-R4.
- `seller_credit_entries_reconciled` (BEFORE INSERT, takes the line's row KEY SHARE, the lock its FK takes later, then its subject, before reading): the row equals the difference that brings
  R - V to max(X, itemized); anything else refused.
- `statement_items_credit_guard` (BEFORE INSERT WHEN kind CREDIT: the statement row KEY SHARE, then the line row KEY SHARE (the locks its
  FKs take after BEFORE triggers), then the line's subject, then reads; OFF-R3-01): itemized(L) + the item ≤
  R - V, and the line is settled; `statement_items_credit_within_recognized` (deferred) repeats it at COMMIT. OFF-R2-01.
- Payout admission (`payout_lines_unpayable`, re-issued over 0036/0043): CREDIT item lines join the PAYABLE lines in the ascending
  shared-subject loop; a CREDIT line with an OPEN hold the statement does not withhold, or funds not AVAILABLE, blocks (KC018). OFF-R2-02.
- `commission_noncash_settlements_admissible` (BEFORE INSERT; takes the statement row FOR UPDATE, then its item lines' rows KEY SHARE
  ascending, then their **exclusive** subjects
  ascending (ADV-OFF-4: the credit reconcile in the same transaction needs the exclusive subject; taking it first leaves no
  shared-to-exclusive upgrade; S73), before reading; UNIQUE statement_id): statement ISSUED, payable 0, at least one PAYABLE LINE item, pay date
  reached, 0036 fence clear, evidence digest matches; `commission_statements_noncash_frozen` (every state change) and `commission_lines_noncash_frozen` (state and payable owner only;
  cumulative adjustments in both directions pass, OFF-R2-03).
- FK audit (OFF-R3-01; completed in r5, ADV-OFF-2). An RI check locks its parent row FOR KEY SHARE after the BEFORE triggers. KEY SHARE
  conflicts only with FOR UPDATE (explicit, a DELETE or a key-column UPDATE), never with the FOR NO KEY UPDATE of an ordinary UPDATE.
  Census: the FOREIGN KEY clauses of the five guarded tables (0030, 0031, 0045, 0046) and, per parent, `grep -rnE "<parent>[^;]*FOR UPDATE"`
  over persistence src and migrations plus the callers of `projects.lock`. Each FK, its parent's position and why its wait cannot cycle:
  - commission_lines (offsets N and R; release's receiving line through the guard; credit entries L; statement_items.line_id; noncash
    item lines): level (1), taken by the guard first (G-ORD-1, §5), so the RI lock is re-entrant.
  - commission_statements (statement_items.statement_id; noncash statement_id): before (1), taken by the guard first; re-entrant.
  - commission_offsets (releases.offset_id; statement_items.offset_id 0031:205): append-only (0030:294, forbid_change on UPDATE or
    DELETE): never locked FOR UPDATE, the KEY SHARE never waits.
  - seller_agreements (offsets (seller_id, agreement_id), 0030:245): no DELETE (0029:708), key columns immutable (0029:704-705), no
    explicit FOR UPDATE in src or migrations: every UPDATE is NO KEY UPDATE; never waits.
  - commission_adjustments (statement_items.adjustment_id, 0031:203): append-only (0030:274); never waits.
  - commission_holds (statement_items.hold_id, 0031:204): level (3); no DELETE (0030:288), keys immutable, resolution is an UPDATE of
    state (NO KEY UPDATE); never waits.
  - projects (statement_items (agency_id, project_id), 0031:206): explicit FOR UPDATE by `projects.lock` (workspace.ts:258-260), called
    only by create-support-case.ts:51, execute-project.ts:56, create-revision.ts:49; none of those units takes a commission row,
    subject or statement (census: no commission port in the three handlers). An item insert may wait there; its holder waits on
    nothing B10 holds: no cycle (S74).
- Grants: INSERT on releases and credit entries to `kauro_commission` (and to the owner on `kauro_app` only for cause HOLD_OPENED /
  HOLD_CHANGED, the triggers of an owner-opened hold); the helper functions are EXECUTE for both; every path passes the guards above.

Oracle (`invariants.ts`), state invariants, one atomic why each with its own forged control:
- **INV-S-15 offset claims** (D10-NEG-4): (1) "release beyond its offset"; (2) "offset from a line never settled"; (3) "claims beyond
  the capacity of an unapplied line" (R in ACCRUED_PENDING, ELIGIBLE, HELD, VOID; claims > max(0, E - P - H)); (4) "applied claims not
  the payable item's offset" (R PAYABLE, PAID, ADJUSTED with `payable_statement_id`: claims <> that statement's LINE PAYABLE item offset).
- **INV-S-16 seller credit** (D10-NEG-5; no cent lost): per line, R - V vs max(X, itemized): (1) "credit recognized below the line's
  due" (a cent owed and not recorded); (2) "credit recognized above the line's due" (credit fabricated); (3) "credit on a line not settled".
- **INV-S-17 noncash settlement** (D10-NEG-6): (1) "noncash settlement of a statement with cash payable"; (2) "noncash-settled statement
  not ISSUED"; (3) "noncash settlement evidence not its items' applied offsets".
- **INV-S-07** why 1 "OFFSET item not its offset" becomes "OFFSET item beyond its offset" (releases may follow a statement).
- Not oracle (insert- or close-time facts, dedicated tests): admission bounds; unapplied claims beyond a shrunken source allowance
  (legal until applied, §2.5); OFFSET item = live at its close.

## 5. Lock order and lock sets (rule 11)

Global order after §10's prefix (... period, statement, payout intent): **(1) line rows, ascending** (FOR UPDATE by line writers; FOR
KEY SHARE by an offset insert, and by a hold insert through its FK) **(2) line subjects, ascending** (exclusive; shared for CMD052)
**(3) hold rows (4) offset releases, credit entries, noncash settlements**: every write in (4) is made under the subject of the line it
concerns (a release under its receiving line's, a credit entry under its line's), taken by the writer or by the INSERT guard. No
transaction requests a row or subject of (1)/(2) after taking any subject. Each writer computes its complete set first.

**G-ORD-1 (r5, ADV-OFF-1): one blocking acquisition per transaction, then pre-locked or non-blocking.** A per-row BEFORE guard cannot
order rows across a multi-row INSERT, several guarded INSERTs or a multi-statement sweep in one transaction. Every B10 line row lock and
line subject is taken through two functions (0045): `kauro.commission_lock_line_rows(lines uuid[], mode)` (sorted ascending, one
statement) and `kauro.take_commission_line_subject(line uuid, mode)`; both set the transaction-local flag `kauro.commission_lines_locked`
(`set_config(..., true)`). The 0036 hold fence (`take_commission_line_lock`), the line state fence (`commission_lines_line_fence`) and
`payout_lines_unpayable` are re-issued over them; holds get a BEFORE INSERT step `commission_holds_lock_order` with the same flag-on
non-blocking acquisition of the line row and subject, so the FK KEY SHARE that follows is re-entrant (Y26 reversed order: S72). A line
UPDATE takes its row implicitly, so only the writers listed below update lines, each after pre-locking them. Each of the five guards (offsets, releases, credit entries, CREDIT items, noncash
settlements): flag off -> takes its prefix (statement, then lines ascending: KEY SHARE; the noncash statement FOR UPDATE) and its subjects
ascending, blocking, as r4 (T30, C14, C15, S59 unchanged), and the flag is set; flag on -> takes the same set non-blocking (`FOR KEY
SHARE NOWAIT` / `FOR UPDATE NOWAIT`, `pg_try_advisory_xact_lock`): a lock this transaction already holds is granted at once (re-entrant:
the path of every pre-locked writer), one held by another transaction refuses `commission_lock_order` (SQLSTATE KC021, provisional: next
free KC code at merge) without waiting. So after its first subject no transaction waits for a row or subject of (1)/(2), across rows and
statements. In-product multi-row writers (close, correction, CMD053, yields, reconcile, the OQ-1 close-time writer) pre-lock their
complete set through the two functions before the first guarded INSERT; a direct multi-row INSERT gets its first row blocking and every
other row only if free or already held (fail closed). Census (S72): a pg_proc scan of live function bodies and a src grep find no
commission line row lock or line subject outside the two functions. A forged flag value only turns the first acquisition of a direct
INSERT non-blocking (more refusals) or a later one blocking (at worst a 40P01 that rolls the transaction back; no money effect); direct
INSERT is granted to kauro_commission only (§4 Grants). Lock sets:
- offset insert: N and R rows (KEY SHARE) ascending, both subjects ascending, then reads.
- hold insert / hold resolution: the line's row (FK KEY SHARE; resolution: `lockLine` FOR UPDATE first), its subject (0036 fence), then
  yield or credit reconcile. B12 (X-B12-1): UPHELD and its correction in one transaction after the capture's line rows and subjects.
- basis change and `observeFunds`: `lockPoolsOfCapture` locks the capture's lines in one ascending statement (ADV-17), then
  `fenceLinesOfCapture`, then writes (triggers yield and reconcile under subjects already held).
- close: all input lines FOR UPDATE ascending (exists), `fenceLines` over **all** input lines ascending (the cutoff's stability, §2.8), then yields, applications (§2.5), credit reconcile, compose.
- correction: discovery read → set = predecessor named lines ∪ lines of its CREDIT items ∪ sources of live claims against those lines;
  rows ascending, subjects ascending; re-discover; a set that grew refuses STALE_VERSION LEDGER_CHANGED; then recompose (§2.5 needs no
  other receiving line).
- CMD052: statement, cash, then shared subjects of its PAYABLE and CREDIT lines ascending (OFF-R2-02).
- CMD053: statement, intent, then FAILED/RETURNED: the set of its correction (above) ∪ the statement's PAYABLE lines; SETTLED: the
  statement's PAYABLE LINE and CREDIT lines; rows ascending, subjects ascending, before the first hold, transition or correction.
- noncash sweep: one statement per transaction (one unit per statement, as the PERIODS sweep's other items); statement FOR UPDATE, its
  item lines' rows ascending, exclusive subjects ascending, fence check, settlement, credit reconcile (ADV-OFF-1, ADV-OFF-4).

### 5.1 Rule 16 sweep: every guarded aggregate, its lock, its writers, its RACE cells

| aggregate | lock taken before any read of it | writers (incl. direct INSERT grants) | RACE cells (both orders) |
|---|---|---|---|
| offsets (capacity of R, position of N) | N and R rows KEY SHARE, then both subjects (guard trigger: every INSERT path) | offset INSERT (commission service; OQ-1 writer) | T11, T12, T13, T19, T23, Y17, Y18, S09, S15, S45; multi-row T33 |
| releases (live amount of o) | o's receiving line's row KEY SHARE, then its subject (guard trigger) | hold, line and close/correction/CMD053 yields; direct INSERT (commission service) | T24, T30, Y11, Y12, Y20, Y21, S29, S33; multi-row T31, T32, Y26; TIMEOUT T27 |
| seller credit entries (R - V of L) | L's row KEY SHARE, then its subject (guard trigger) | reconcile from line, hold, close, correction, CMD053, noncash; direct INSERT | C06, C08, C15, C17, C18, S14, S17, S42, S49; multi-row C19, C21; TIMEOUT C09 |
| CREDIT items (itemized of L) | the statement row, then L's row KEY SHARE, then L's subject (item guard trigger) | close, correction; direct INSERT | C13, C14, S47, S31; multi-row C20; TIMEOUT C10 |
| CREDIT payout admission (holds and funds of L) | L's shared subject (payout_lines_unpayable) | CMD052, intent INSERT trigger | S55, S56 |
| noncash settlements (statement) | statement row FOR UPDATE, its lines' rows KEY SHARE ascending, then their exclusive subjects (guard trigger) | PERIODS sweep (one statement per transaction); direct INSERT | S36, S39, S46, S48, S49, S50, S35, S38, S45, S59, S63; multi-statement S70; exclusive S73 |
| cutoff V2 (every hashed input, funds included) | the close's lines FOR UPDATE and subjects (all input lines) | every writer above, and `observeFunds`, needs one of them | S09, S38, S47, S57, S58, S60, S61 |
| lock order across rows of one transaction (G-ORD-1) | the flag; non-blocking after the first acquisition | every guard above, the pre-lock functions, the re-issued fences | T31, T32, T33, Y26, C19, C20, C21, S70, S71, S72 |

## 6. Tests (exact titles). Counts: F1 33, F2 26, F3 6, F4 74, F5 11, F6 21 = 171 (r5: +12)

F1 `packages/persistence/test/b10-offset-bounds.test.ts` (recreated). T01-T04, T06-T12, T16 kept verbatim from 843bf01:
- T01 "DENY: an offset of 101 cents against an unpaid 100-cent line with a 1000-cent negative position is refused commission_offsets_amount and writes nothing"
- T02 "DENY: offsets of one negative line against two receiving lines whose sum exceeds the negative position are refused at the cent that exceeds it"
- T03 "DENY: two negative lines of one seller each offset within its own position, a third offset exceeding one line's remaining position refused"
- T04 "DENY: two distinct negative lines of one seller, each within its own position, whose offsets against ONE receiving line together exceed that line's unpaid amount are refused at the cent that exceeds it"
- T05 "DENY: an offset beyond the receiving line's unpaid amount less its OPEN partial hold is refused commission_offsets_amount and writes nothing (held cents are never claimed, D10-NEG-4)"
- T06 "DENY: the capacity less an OPEN hold is shared by every offset against the line: a second negative line's offset beyond what the first left of unpaid-minus-held is refused"
- T07 "a RELEASED hold withholds nothing: the offset may use the line's whole unpaid amount again"
- T08 "DENY: an offset against a PAYABLE receiving line (payable through an ISSUED statement, which applies no later offset) is refused commission_offsets_applicable and writes nothing"
- T09 "DENY: an offset against an ACCRUED_PENDING receiving line, and against the same line once HELD under a covering hold, is refused commission_offsets_applicable and writes nothing"
- T10 "DENY: an offset FROM a line never paid (paid_cents NULL: no negative position) is refused commission_offsets_amount and writes nothing"
- T11 "RACE: two 600-cent offsets of two negative lines against ONE 1000-cent receiving line, both orders: the second waits on the first's line lock and is refused, exactly one commits"
- T12 "RACE: two 600-cent offsets of ONE negative line (a 1000-cent position) against two receiving lines, both orders: the second waits on the negative line's lock and is refused, exactly one commits"
- T13 "RACE: a 600-cent offset and a 500-cent hold on ONE 1000-cent ELIGIBLE line, both orders: the second waits on the first's line lock; hold first, the offset is refused beyond the 500 left; offset first, the hold opens and releases 100 of the offset (D10-NEG-4)"
- T14 "OK: a hold opened after an offset on an ELIGIBLE line opens whatever the offsets: 1000 unpaid, 900 offset, a 101-cent hold opens and releases 1 cent of the offset to the negative line (D10-NEG-4)"
- T15 "a hold on a PAYABLE line whose statement applied an offset opens and releases nothing: the issued item's 300 offset stands (the PAYOUT_FAILED covering hold, D10-NEG-4)"
- T16 "an UPHELD hold withholds nothing (its decision posts an AGREED_ERROR_CORRECTION decrease instead): the offset may use the line's whole unpaid amount"
- T17 "DENY: an offset from a paid line counts the offsets applied to it as paid: paid 400 through a statement that applied 600, refunded to 0, admits 1000 from it and refuses 1001 commission_offsets_amount"
- T18 "DENY: the negative position counts only live claims: after a refund released 200 of a 600-cent offset of a 1000-cent position, 600 more is admitted and 601 refused"
- T19 "RACE: a 600-cent offset and a refund lowering its 1000-cent receiving line to 400, both orders: refund first, the offset is refused beyond 400; offset first, the refund releases 200; never more than 400 claimed"
- T20 "RACE (timeout): an offset waiting on its receiving line's subject past its statement timeout rolls back and writes nothing; the holder's hold stands"
- T21 "RACE (crash before COMMIT): an offset written and its backend terminated before COMMIT leaves no offset"
- T22 "DENY: a release beyond its offset's live amount, written directly by the commission service, is refused commission_offset_releases_within_live and writes nothing"
- T23 "RACE: an offset from a negative line and a one-cent INCREASE of that line, both orders: increase first, the offset is refused beyond the shrunken position; offset first, the increase waits on the line's key-share lock and the excess cent is released at the next close"
- T24 "RACE: two direct 400-cent releases of one live 600-cent offset, both orders: the second waits on the receiving line's subject taken by the INSERT guard and is refused commission_offset_releases_within_live; 400 released"
- T25 "DENY: a release of an applied claim (its line PAYABLE through a live item) without that item's supersession in the same COMMIT is refused at COMMIT commission_offset_releases_applied and writes nothing"
- T26 "DENY: a release of a settled claim (its line PAID, or PAYABLE through a noncash-settled item) is refused commission_offset_releases_settled"
- T27 "RACE (timeout): a direct release waiting on its receiving line's subject past its statement timeout rolls back and writes nothing; the holder's release stands"
- T28 "DENY (OFF-R4): a release of an applied claim whose line is then moved to HELD in the same transaction without its applying statement CORRECTED is refused at COMMIT commission_offset_releases_applied"
- T29 "DENY (OFF-R4): a release of an applied claim followed in the same transaction by its applying statement's settlement is refused at COMMIT commission_offset_releases_settled"
- T30 "RACE (OFF-R3-01): a direct release INSERT and a period close holding its receiving line's row, both orders: the guard waits at the line row before any subject; no deadlock (40P01 never), the release refused or admitted after the close by live amount"
- T31 "RACE (ADV-OFF-1): two direct release INSERTs in one transaction, receiving lines L5 then L2, while a period close holds L2's row and waits for L5's: the L2 release is refused commission_lock_order without waiting, the transaction leaves neither release, the close commits; no deadlock (40P01 never)"
- T32 "RACE (ADV-OFF-1): two transactions inserting releases on L2 and L5 in opposite orders, both interleavings: the later transaction's acquisition of a line the other holds is refused commission_lock_order without waiting; the other commits both releases; no deadlock"
- T33 "RACE (ADV-OFF-1): two offset INSERTs in one transaction (N1 against R5, then N2 against R2) while a period close holds R2's row: the second is refused commission_lock_order without waiting; no offset written, no deadlock"

F2 `packages/persistence/test/b10-offset-yield.test.ts` (new):
- Y01 "OK (ADV-15 A, full refund): a refund of the receiving line's capture to 0 releases its whole 600-cent offset in the refund's COMMIT (ENTITLEMENT_DECREASED); the line VOID, the offset's live amount 0, the negative line's position 600 to recover"
- Y02 "OK (ADV-15 B, partial refund): a refund of the receiving line from 1000 to 400 releases 200 of its 600-cent offset; 400 stay claimed and the negative line keeps 200 to recover"
- Y03 "OK (ADV-15 C, dispute hold): a 1000-cent SELLER_DISPUTE hold on a 1000-cent ELIGIBLE line with a 600-cent offset opens and releases the 600 (HOLD_OPENED)"
- Y04 "OK: a RELEASED hold does not revive a released claim: after a 1000-cent hold released 600 and is RELEASED, the line's live claims stay 0"
- Y05 "OK (ADV-15 D, UPHELD): a 500-cent hold releases 100 of a 600-cent offset; its UPHELD resolution and its 500-cent AGREED_ERROR_CORRECTION in one transaction release nothing more; 500 stay claimed against 500"
- Y06 "OK (ADV-15 D, out of order): an UPHELD resolution committed alone lets 100 more be offset; the later 500-cent AGREED_ERROR_CORRECTION releases that newest 100 and the end state equals the one-transaction order"
- Y07 "OK: releases go newest first: offsets of 300 then 400 against 1000 unpaid, a refund to 500 releases 200 of the 400 and none of the 300"
- Y08 "OK: a hold and a decrease on a PAYABLE line whose statement applied a 600-cent offset release nothing: the issued item's offset stands"
- Y09 "OK (G): PAYABLE to HELD PAYOUT_FAILED with its statement CORRECTED in the same transaction releases the 600 cents the predecessor applied (LINE_HELD)"
- Y10 "RACE (retry): a redelivered refund adds no adjustment and releases nothing more"
- Y11 "RACE: a 500-cent hold and a refund to 700 on one 1000-cent line carrying a 600-cent offset, both orders: the second waits on the line's lock; either order ends with 400 released and 200 claimed"
- Y12 "RACE: holds of 500 and 400 on one 1000-cent line carrying a 600-cent offset, both orders: the second waits on the line's subject; either order ends with 500 released and 100 claimed, never more released than the offset"
- Y13 "RACE (ADV-17): a refund of a capture whose pools order its lines against ascending id and an offset between two of those lines, both orders: no deadlock (40P01 never), the waiter observed waiting at the first line row"
- Y14 "RACE (crash before COMMIT): a hold whose yield released 600 and whose backend is terminated before COMMIT leaves no hold and no release"
- Y15 "RACE (partial): a refund whose yield released 200 and whose second line's adjustment then fails leaves every line, adjustment and live amount as before"
- Y16 "RACE (timeout): a hold waiting on the receiving line's subject behind an offset past its statement timeout rolls back: no hold, no release; the offset stands"
- Y17 "RACE: an UPHELD resolution with its 500-cent correction (one transaction, X-B12-1 order) and a 600-cent offset on one 1000-cent line under a 500 hold, both orders: the second waits on the line's lock; no deadlock; claims end within 500"
- Y18 "RACE: a hold RELEASED and a 600-cent offset on one 1000-cent ELIGIBLE line under a 500 hold, both orders: the second waits on the line's subject; resolve first, 600 admitted; offset first, refused beyond 500"
- Y19 "RACE: an UPHELD resolution with its 500-cent correction and a refund to 700 of the same line carrying 500, both orders: the second waits on the line's row; claims end within the final capacity, equal in either order"
- Y20 "RACE: a hold RELEASED and a refund to 400 on one ELIGIBLE line carrying a 500-cent offset under a 500 hold, both orders: the second waits on the line's row; either order ends with 100 released and 400 claimed"
- Y21 "RACE: a hold opened and another hold RELEASED on one 1000-cent line carrying 500 under a 500 hold, both orders: the second waits on the line's subject; releases follow the order's capacities and never revive"
- Y22 "RACE: an UPHELD resolution with its correction and a new 300-cent dispute hold on the same line, both orders: the second waits on the line's subject; claims end within E - P - H in either order"
- Y23 "RACE: one hold RELEASED and another UPHELD with its correction on one line carrying 500, both orders: the second waits on the line's subject; claims, releases and credit equal in either order"
- Y24 "RACE (partial): a hold on a line carrying a 600-cent offset whose INSERT succeeded and whose release write is then failed by an injected fault leaves no hold and no release"
- Y25 "RACE: two UPHELD resolutions with their corrections on one line carrying an offset, both orders: the second waits on the line's row; claims end within the final capacity, equal in either order"
- Y26 "RACE (ADV-OFF-1): a hold INSERT on L5 (its fence sets the transaction's lock flag) and then a direct release INSERT on L2 in the same transaction while a period close holds L2's row: the release is refused commission_lock_order without waiting; no hold, no release, no deadlock"

F3 `packages/domain/test/b10-offset-compose.test.ts` (new, pure):
- P01 "composeStatement applies the live claims against an ELIGIBLE line (amount less releases) and reports each OFFSET item at its live cents; a fully released offset has no item"
- P02 "composeStatement refuses (RangeError) claims beyond an ELIGIBLE line's unpaid amount less its OPEN holds instead of clipping them"
- P03 "composeStatement counts the claims applied to a PAID line as paid: paid 400 with 600 applied, refunded to 0, is a 1000-cent negative position (E)"
- P04 "composeStatement reports the in-kind position of a PAYABLE line whose entitlement fell below its applied claims: 600 applied, entitlement 400, a 200-cent negative balance"
- P05 "composeStatement's balance left on a negative line is its position less its live claims: position 1000, a 600-cent offset of which 200 released, 600 left"
- P06 "composeStatement itemizes a line's outstanding seller credit (recognized less itemized) as one CREDIT item whose payable is in the statement's payable, and none when nothing is outstanding"

F4 `apps/api/test/b10-offset-statements.test.ts` (new; CMD051, correction, CMD053, PERIODS sweep through the commission service):
- S01 "R2-104 (ADV-15 A): after a full refund of the receiving line, the next statement reports its -1000 adjustment, no OFFSET item and a 600-cent negative balance"
- S02 "R2-104 (ADV-15 B): after a refund of the receiving line to 400, the statement applies 400 (payable 0), an OFFSET item of 400 and a 200-cent negative balance"
- S03 "R2-102 with R2-104 (ADV-15 C): a 1000-cent dispute hold on the receiving line opens; the statement itemizes the line HELD 1000 and a 600-cent negative balance"
- S04 "R2-102 with R2-104 (ADV-15 D): a 500-cent hold UPHELD with its 500-cent correction in one transaction: the statement applies 500 (payable 0) and a 100-cent negative balance"
- S05 "r3 R3-01 (F): a close after a one-cent INCREASE of an offset negative line applies within its allowance, releases that cent (POSITION_SHRANK) and pays the receiving line in full"
- S06 "CMD053 FAILED (G): the failed payout of a statement that applied a 600-cent offset cancels the application, releases it (LINE_HELD) and the correcting statement shows a 600-cent negative balance"
- S07 "CMD051 correction: a 500-cent hold on a PAYABLE line whose statement applied 600: the correction cancels the application, releases 100 (STATEMENT_COMPOSED) and its successor applies 500 beside a 500 HOLD item"
- S08 "R2-104 (E): a line paid 400 through a statement that applied 600, then refunded to 0, shows a 1000-cent negative balance at the next close"
- S09 "RACE: an offset and a period close over its receiving line, both orders: offset first, the statement applies it; close first, the line is PAYABLE and the offset is refused commission_offsets_applicable"
- S10 "RACE: a dispute hold and a period close on a line carrying a 600-cent offset, both orders: hold first, the line is itemized HELD and the 600 is the negative line's again; close first, the line is PAYABLE with 600 applied and the hold releases nothing"
- S11 "RACE: a refund to 400 and a period close on a line carrying a 600-cent offset, both orders: refund first, the statement applies 400; close first, the item applies 600 and the refund releases nothing"
- S12 "RACE: a correction and a 500-cent hold on its PAYABLE line carrying 600, both orders: hold first, the correction releases 100 and applies 500; correction first, the successor applies 600 and the hold releases nothing"
- S13 "RACE: a CMD053 FAILED reconciliation and an independent offset naming two of its lines, both orders: no deadlock, the whole set locked before any subject; the offset refused"
- S14 "RACE: a correction and a one-cent INCREASE of the source of a claim it applies, both orders: increase first, the correction applies within the allowance and releases the cent; correction first, the increase waits on the locked source and records a 1-cent credit"
- S15 "RACE: an offset and a correction that makes its receiving line PAYABLE again, both orders: offset first, the successor applies it; correction first, the offset is refused commission_offsets_applicable"
- S16 "RACE: a refund to 400 and a correction recomposing its PAYABLE line carrying 600, both orders: refund first, the correction releases 200 and applies 400; correction first, the successor applies 600 and the refund releases nothing"
- S17 "RACE: a one-cent INCREASE of an offset source and a period close, both orders: increase first, the close releases the cent; close first, the cent is applied and the increase records a 1-cent seller credit"
- S18 "OFF-R1 (H): the close after a 1-cent credit itemizes one CREDIT item of 1 in the statement's payable; once PAID the following close itemizes none"
- S19 "OFF-R1: a CREDIT item on a statement whose payout FAILED is itemized again by the correcting statement in the same COMMIT, exactly once"
- S20 "OFF-R5 (G0): a PAYABLE line refunded to 0 whose payout then FAILS: no hold, no HELD; the intent FAILED, the predecessor CORRECTED, 600 released (PAYMENT_CANCELLED), the line carried at 0, all in one COMMIT"
- S21 "OFF-R7 (I): an all-offset statement (payable 0) is settled noncash by the PERIODS sweep on its pay date: one noncash settlement with its applied offsets as evidence, no payout intent, the statement and its lines frozen"
- S22 "OFF-R7: a noncash-settled statement refuses approval and correction; its line refunded to 0 is admitted as an offset source of 600"
- S23 "OFF-R7: an all-offset statement DISPUTED before its pay date, or carrying an OPEN hold it does not withhold, is not settled noncash"
- S24 "OFF-R2: source position 599 with an older 300 applied to R1 and a newer 300 on R2 outside a correction: the correction re-applies R1's 300 and releases nothing; the next close applies 299 to R2 and releases 1"
- S25 "RACE (OFF-R3): CMD053 FAILED and SETTLED, each against an offset whose source sorts before its receiving line, both orders: CMD053 prelocks rows then subjects; no deadlock"
- S26 "RACE: CMD053 SETTLED and a refund of one of its PAYABLE lines, both orders: no deadlock; either order ends PAID with its applied claims settled and the same negative position"
- S27 "RACE: CMD053 SETTLED and a funds HELD observation of its capture, both orders: no deadlock; the settlement stands"
- S28 "RACE: an UPHELD resolution with its correction and a period close over its line, both orders: resolve first, the statement applies 500; close first, the item applies 500 and withholds 500, and the later correction changes neither"
- S29 "RACE: an independent 500-cent dispute hold and CMD053 FAILED on a PAYABLE line carrying 600 applied, both orders: the second waits on the line's lock; either order ends HELD with 600 released and both holds OPEN"
- S30 "RACE: a refund to 0 and CMD053 FAILED on a PAYABLE line carrying 600 applied, both orders: refund first, the zero-entitlement cancellation; failure first, HELD with 600 released, then the refund voids it"
- S31 "RACE: a period close and a correction of an earlier statement sharing a line, both orders: the second waits on the shared line's row; one live payable item per line and no claim applied twice"
- S32 "RACE: a hold RELEASED and a correction of the statement its PAYABLE line belongs to, both orders: release first, the successor applies 600; correction first, it releases 100 and applies 500"
- S33 "RACE: a dispute hold RELEASED and CMD053 FAILED on its PAYABLE line, both orders: either order ends HELD PAYOUT_FAILED with 600 released"
- S34 "RACE: a 500-cent hold RELEASED and a period close over its ELIGIBLE 1000-cent line, both orders: release first, no credit and the 500 in the line's payable; close first, the 500 withheld and, once the line is PAID, a 500-cent seller credit; in both, line cash plus credit is 1000"
- S35 "RACE: the noncash settlement sweep and a refund of one of its lines, both orders: no deadlock; either order ends settled with the same negative position"
- S36 "RACE: the noncash settlement sweep and a correction of the same statement, both orders: the second waits on the statement row; settle first, the correction is refused; correction first, the successor settles at its own pay date"
- S37 "RACE: a period close and CMD053 FAILED of an earlier statement, both orders: no deadlock; the failed line is itemized by exactly one live statement"
- S38 "RACE: a period close and the noncash settlement of an earlier statement, both orders: no deadlock; the settled lines are not itemized again"
- S39 "RACE: a dispute hold and the noncash settlement sweep on the same line, both orders: hold first, the statement is not settled; settle first, the hold opens on a settled line and releases nothing"
- S40 "RACE: a dispute hold and CMD053 SETTLED on its PAYABLE line carrying 600 applied, both orders: the settlement stands; the hold opens on the PAID line and releases nothing"
- S41 "RACE: a hold RELEASED and CMD053 SETTLED on its PAYABLE line, both orders: either order ends PAID with the withheld cents recognized as seller credit"
- S42 "RACE: CMD053 FAILED cancelling a claim of a source and a one-cent INCREASE of that source, both orders: the second waits on the source's row; credit and releases equal in either order"
- S43 "RACE: an UPHELD resolution with its correction and CMD053 FAILED on its PAYABLE line, both orders: the second waits on the line's row; either order ends HELD with every applied cent released and none lost"
- S44 "RACE: an UPHELD resolution with its correction and a correction of the statement its PAYABLE line belongs to, both orders: the second waits on the line's row; the successor applies within the final capacity"
- S45 "RACE: the noncash settlement sweep and an offset from one of its lines once refunded, both orders: settle first, the offset is admitted from the settled line; offset first, it waits on the line's row and is refused commission_offsets_amount (source not yet settled)"

- S46 "RACE: a funds HELD observation and the noncash settlement sweep on a statement whose line's capture it names, both orders: observation first, the statement is not settled; settle first, the settlement stands"
- S47 "RACE: a period close and CMD053 SETTLED of an earlier statement carrying a 300-cent CREDIT item, both orders: the second waits on the line's row; the close itemizes none of those 300 in either order, never 600 paid"
- S48 "RACE: a withheld hold RELEASED and the noncash settlement sweep on its line, both orders: release first, the statement is settled and the 300 become seller credit at settlement; settle first, the release records the 300 as seller credit"
- S49 "RACE (OFF-R2-03): a refund that raises a noncash-settled line by one cent (8/5/1 of 14 to 7/4/2 of 13) and the noncash settlement sweep, both orders: either order ends settled with the adjustment posted and a 1-cent credit"
- S50 "RACE (retry): two noncash settlement sweep passes over one statement, both orders: the second waits on the statement row and settles nothing; one settlement"
- S51 "RACE: CMD053 FAILED on two statements whose items name one line (PAYABLE in one, reported in the other), both orders: the second waits on the line's row; one cancellation, no claim released twice"
- S52 "RACE: CMD053 SETTLED of two statements each carrying a CREDIT item of one line, both orders: the second waits on the line's row; credit paid equals credit recognized"
- S53 "RACE: corrections of two statements that both name one line, both orders: the second waits on the line's row; one live payable item, no claim applied twice"
- S54 "RACE (OFF-R6): an offset whose source is outside the correction's discovered set commits between its discovery and its locks: the correction refuses STALE_VERSION LEDGER_CHANGED and commits no release"
- S55 "RACE (OFF-R2-02): CMD052 approval of a statement carrying a 300-cent CREDIT item and a dispute hold on that credit's line, both orders: hold first, the approval is refused LEDGER_CHANGED; approval first, the hold waits on the shared subject and lands after the intent"
- S56 "RACE (OFF-R2-02): CMD052 approval of a statement carrying a CREDIT item and a funds HELD observation of its line's capture, both orders: observation first, the approval is refused; approval first, the observation lands after the intent"
- S57 "DENY (OFF-R2-04): an offset recorded after the close's proposal changes KAURO_COMMISSION_CUTOFF_V2; the close is refused STALE_VERSION LEDGER_CHANGED and writes nothing"
- S58 "DENY (OFF-R2-04): a CREDIT item paid (its statement SETTLED) after the close's proposal changes KAURO_COMMISSION_CUTOFF_V2; the close is refused STALE_VERSION LEDGER_CHANGED"
- S59 "RACE (OFF-R3-01): a direct noncash-settlement INSERT and a period close sharing a line, both orders: the guard takes the statement row and the line rows before any subject; no deadlock"
- S60 "DENY (OFF-R3-02): a funds HELD observation of an ELIGIBLE line's capture after the close's proposal changes KAURO_COMMISSION_CUTOFF_V2; the close is refused STALE_VERSION LEDGER_CHANGED and writes nothing"
- S61 "RACE: a funds HELD observation and a period close over a capture's ELIGIBLE line carrying a 600-cent offset, both orders: the second waits on the line rows; observation committed before the close's proposal is read, the line AWAITING_FUNDS with no offset applied; close holding the line rows first, PAYABLE with 600 applied and the observation after it (an observation between the proposal and the close's locks is S60)"
- S62 "RACE (OFF-R6): an UPHELD resolution with its 300-cent correction and CMD053 SETTLED on a PAYABLE 1000-cent line with 300 withheld and 700 cash payable, both orders: the second waits on the line's row; zero seller credit in either order"
- S63 "RACE (OFF-R6): an UPHELD resolution with its 300-cent correction and the noncash settlement of an all-offset statement withholding those 300 on its line, both orders: zero seller credit in either order"
- S64 "RACE (partial): CMD053 FAILED whose release succeeded and whose correcting statement INSERT is then failed leaves the intent, the line, the claims and the predecessor as they were"
- S65 "RACE (partial, OFF-R6): CMD053 SETTLED whose line moved to PAID with 700 and whose credit recognition is then failed leaves neither the payment state nor any credit"
- S66 "RACE (partial): a close whose releases and CREDIT item succeeded and whose second statement INSERT is then failed leaves no statement, release, credit item or line change"
- S67 "RACE (partial): a correction whose cancellation releases succeeded and whose successor INSERT is then failed leaves the predecessor live with its applied claims"
- S68 "RACE (partial): a noncash settlement whose row succeeded and whose credit reconcile is then failed leaves no settlement and no credit"
- S69 "RACE: an independent correction and CMD053 FAILED of the same statement, both orders: the second waits on the statement row; one successor, the application cancelled once"
- S70 "RACE (ADV-OFF-1): two noncash-settlement INSERTs in one transaction for statements A then B while a period close holds a line row of B: B's guard is refused commission_lock_order without waiting; no settlement; the PERIODS sweep, one statement per transaction, settles both after the close"
- S71 "OK (ADV-OFF-1): a writer that pre-locks lines given in any order through commission_lock_line_rows and take_commission_line_subject takes them ascending (rows, then subjects) and then inserts releases, credit entries and CREDIT items for them in any order with no refusal and no wait"
- S72 "DENY (ADV-OFF-1): after a line subject is taken, a guard or a hold INSERT needing a row or subject another transaction holds refuses commission_lock_order without waiting; a pg_proc census of live function bodies and a src census find no commission line row lock or line subject outside the two lock functions"
- S73 "DENY (ADV-OFF-4): a direct noncash-settlement INSERT holds each item line's subject in exclusive mode before its credit reconcile reads (the session's pg_locks: ExclusiveLock and no ShareLock on every item line's subject); no shared-to-exclusive upgrade"
- S74 "RACE (ADV-OFF-2): CreateRevision holding its project row FOR UPDATE and a period close inserting statement items naming that project, both orders: the item's FK waits at the project row and completes after it; no deadlock; the close's items are unchanged"

F5 `packages/persistence/test/invariants.test.ts` (forged controls; positive controls stay silent):
- V1 "INV-S-15 fires on a release beyond its offset (money: 600 released twice from a 600-cent offset)"
- V2 "INV-S-15 fires on an offset from a line never settled"
- V3 "INV-S-15 fires on claims beyond the unpaid amount less OPEN holds of an ELIGIBLE line (money: 600 claimed against 400)"
- V4 "INV-S-15 fires on a PAYABLE line whose live claims are not its payable item's offset (money: 600 applied, 400 claimed)"
- V5 "INV-S-07 fires on an OFFSET item beyond its offset (money: 700 reported for a 600-cent offset)"
- V6 "INV-S-16 fires on credit recognized below a settled line's due (money: a 1-cent INCREASE above paid not recorded)"
- V7 "INV-S-16 fires on credit recognized above a settled line's due (money: 1 cent recognized on a line paid in full)"
- V8 "INV-S-16 fires on credit recognized on a line not settled"
- V9 "INV-S-17 fires on a noncash settlement of a statement with cash payable"
- V10 "INV-S-17 fires on a noncash-settled statement not ISSUED"
- V11 "INV-S-17 fires on a noncash settlement whose evidence is not its items' applied offsets"

F6 `packages/persistence/test/b10-seller-credit.test.ts` (new):
- C01 "OK (OFF-R1, H): a one-cent INCREASE of a source whose 600-cent claim is settled (paid 4000, entitlement 3400 to 3401) records a 1-cent RECOGNIZED credit in the increase's COMMIT"
- C02 "OK: an INCREASE of a PAID line above what it settled records the difference as seller credit"
- C03 "OK (J): a partial hold withheld when its line was PAID records nothing while OPEN; RELEASED records the held cents as credit; UPHELD with its correction records none"
- C04 "OK: a decrease after an unitemized credit reverses it (REVERSED) down to the line's due; a credit already itemized or paid is never reversed"
- C05 "DENY: a credit entry that is not the line's reconciled difference, written directly, is refused seller_credit_entries_reconciled and writes nothing"
- C06 "RACE: an INCREASE and a hold RELEASED on one PAID line, both orders: the second waits on the line's subject; either order records the same credit"
- C07 "DENY: a second live CREDIT item beyond the recognized credit is refused at COMMIT statement_items_credit_within_recognized"
- C08 "RACE: two direct credit-entry inserts for one line, both orders: the second waits on the line's subject and is refused seller_credit_entries_reconciled unless it is the difference left after the first"
- C09 "RACE (timeout): a credit-entry insert waiting on its line's subject past its statement timeout rolls back and writes nothing"
- C10 "RACE (timeout): a CREDIT item insert waiting on its line's subject past its statement timeout rolls back: no item, no statement"
- C11 "OK (OFF-R2-02): a dispute hold opened after a 300-cent credit was itemized keeps 300 recognized while the item is live; the correction that supersedes it reverses the 300 (ITEM_CANCELLED) and itemizes none"
- C12 "OK (OFF-R2-03): shares 5556/3333/1111 of a 14-cent pool (8/5/1) with the third line settled noncash: a refund to 13 (7/4/2) posts its INCREASE to 2 and records a 1-cent credit"
- C13 "RACE (OFF-R2-01): two 300-cent CREDIT items for one line's 300-cent recognized credit inserted in two statements, both orders: the second waits on the line's subject taken by the item guard and is refused statement_items_credit_within_recognized; 300 itemized"
- C14 "RACE (OFF-R3-01): a direct CREDIT item INSERT and a period close already holding its line's row, both orders: the item guard waits at the statement and line rows before the subject; no deadlock (40P01 never), 300 itemized once"
- C15 "RACE (OFF-R3-01): a direct credit-entry INSERT and a period close holding its line's row, both orders: the guard waits at the line row before the subject; no deadlock"
- C16 "RACE (partial): a hold RELEASED on a PAID line whose credit entry write is then failed leaves the hold OPEN and no credit"
- C17 "RACE: a hold opened and an INCREASE on one PAID line, both orders: the second waits on the line's subject; the same credit in either order"
- C18 "RACE: two holds RELEASED on one PAID line, both orders: the second waits on the line's subject; credit equals both withheld amounts"
- C19 "RACE (ADV-OFF-1): a direct two-row credit-entry INSERT (L5, then L2) while a period close holds L2's row and waits for L5's: the L2 row is refused commission_lock_order without waiting; no credit entry, the close commits, no deadlock"
- C20 "RACE (ADV-OFF-1): two CREDIT items inserted in one transaction into an ISSUED statement for L5 then L2 while a correction holds L2's row: the L2 item is refused commission_lock_order without waiting; no item, no deadlock"
- C21 "RACE (partial, ADV-OFF-1): a multi-row credit-entry INSERT whose first row passed its guard and whose second row is refused commission_lock_order leaves neither row and the line's recognized credit unchanged"

Family suites (kit `apps/api/test/b10-cells-support.ts`): CONS_TMO/CRB/CRA (refund, reversal), CMD_CRB/CRA of CMD051, the correction,
CMD053 and the PERIODS sweep (SWEEP_*) cover the new writes once each member's footprint includes `commission_offset_releases`,
`seller_credit_entries`, `commission_noncash_settlements` (FOOT-REL: an implementation obligation, closed by lane FOOT, not coverage until then).

## 7. Failure-mode matrix (C = test above, written first; all money cells tier 1)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| M1 offset INSERT | **C** pairs below (O-*); multi-row T33 | **C** T20 | N/A: no deadline governs an offset; R is already ELIGIBLE | **C** T21 | N/A: no response step; the writer (OQ-1) owns it | **GAP** OQ-1: the writer's idempotency identity | N/A: agreement terms immutable once signed (0029 `seller_agreements_immutable`, `learned_once`), read after the lock | N/A: one INSERT; DENY T01-T10, T17, T18 |
| M2 hold INSERT + yield + credit | **C** pairs (H-*) | **C** Y16 | N/A: review_at acts on nothing | **C** Y14 | **GAP** FOOT-REL (SWEEP_CRA, CONS_CRA members opening holds); the dispute command is B12's | N/A: own hold id; B12's key | N/A: B12's grant | **C** Y24 |
| M3 hold RESOLVED (RELEASED, UPHELD) + credit | **C** pairs (HR-*, U-*) | **GAP** FOOT-REL (ELIGIBILITY sweep timeout member) | N/A | **GAP** FOOT-REL (SWEEP_CRB ELIGIBILITY) | **GAP** FOOT-REL (SWEEP_CRA) | **C** resolveHold CAS (existing STALE on version) + C06 | N/A: commission service / B12 | **C** C16 |
| M4 line E change + yield + credit (refund, reversal; B12 correction) | **C** pairs (D-*) | **GAP** FOOT-REL CONS_TMO | N/A | **GAP** FOOT-REL CONS_CRB | **GAP** FOOT-REL CONS_CRA | **C** Y10 | **C** CONS_REV (kit, existing) | **C** Y15 |
| M5 CMD053 FAILED/RETURNED (cancellation, HELD or zero path, correction) | **C** pairs (F-*) | **GAP** FOOT-REL CMD053 member | N/A: evidence has no B10 deadline (B15) | **GAP** FOOT-REL CMD_CRB | **GAP** FOOT-REL CMD_CRA | **C** CMD053 RETRY cell (existing); S06, S20 one release | N/A: finance service fact | **C** S64 |
| M6 CMD053 SETTLED (lines PAID, claims settled, credit) | **C** pairs (ST-*) | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD053 RETRY (existing) | N/A | **C** S65 |
| M7 close CMD051 (yield, §2.5 applications, credit, CREDIT items) | **C** pairs (C-*) | **GAP** FOOT-REL | N/A here: the period's due date is CMD051's existing EXPIRY cell | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD051 RETRY (existing); S05, S18 | N/A | **C** S66 |
| M8 correction (lock set, cancellation, recompose) | **C** pairs (K-*) | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** existing "corrected once" | N/A | **C** S67 |
| M9 noncash settlement (PERIODS sweep) | **C** pairs (NC-*); multi-statement S70; exclusive subjects S73 | **GAP** FOOT-REL SWEEP_TMO | **C** S21 (before, at, after the pay date on the controlled clock) | **GAP** FOOT-REL SWEEP_CRB | **GAP** FOOT-REL SWEEP_CRA | **C** S50 | N/A: commission service | **C** S68 |
| M10 lock acquisition (pools, fence, prelocks) | **C** Y13, S13, S25, S71, S72 | N/A: M4/M5 | N/A | N/A: locks only | N/A | N/A | N/A | N/A: locks only |
| M11 release INSERT (guarded) | **C** T24, T30; multi-row T31, T32, Y26 | **C** T27 | N/A | N/A: single INSERT | N/A | **C** T24 (a second release refused beyond live) | N/A | **C** T31 (a transaction refused at its second release leaves neither); its guards are DENY T22, T25, T26, T28, T29 |
| M12 credit entry INSERT / CREDIT item INSERT (guarded) | **C** C06, C08, C13, C14, C15; multi-row C19, C20 | **C** C09, C10 | N/A | N/A: single INSERT | N/A | **C** C07 | N/A | **C** C21 (second row refused, neither row stays); its guards are DENY C05, C07 |
| M13 CMD052 with CREDIT items (shared subjects, holds, funds) | **C** S55, S56 | **C** CMD052 TIMEOUT cell (existing; CREDIT lines join its subject loop) | **C** CMD052 step-up EXPIRY cells (existing) | **C** CMD052 CRASH-BEFORE (existing) | **C** CMD052 CRASH-AFTER (existing) | **C** CMD052 RETRY (existing) | **C** CMD052 REVOCATION (existing: destination, step-up) | N/A: one intent INSERT; its KC018 trigger is the guard (S55) |
| M14 cutoff V2 (proposal vs close) | **C** S09, S47, S61 | N/A: hash comparison, no wait | N/A | N/A: read-only | N/A | **C** S57, S58, S60 (stale proposal refused) | N/A | N/A: read-only |
| M15 lock order across the rows of one transaction (G-ORD-1, r5) | **C** T31, T32, T33, Y26, C19, C20, S70 | N/A: after the first acquisition nothing waits (non-blocking); the first acquisition's waits are T27, C09, C10 | N/A: no deadline | N/A: locks only; the transaction's writes roll back with it (C21) | N/A: locks end at COMMIT, nothing durable | **C** S71 (the caller retries through the pre-lock functions and succeeds) | N/A: no authority read; the flag is transaction-local (forged values: §5) | **C** C21, T31 |

Writer pairs on one line. Writers: O offset, H hold opened, HR hold RELEASED, U UPHELD + its correction (X-B12-1 protocol, built here,
called by B12), D entitlement change (refund, reversal), I entitlement change of a settled source, C close, K correction, F CMD053
FAILED/RETURNED, ST CMD053 SETTLED, NC noncash sweep, FO funds observation, A CMD052 approval. A **cell** holds one actor at a named
lock and runs the other, both orders; a **proof** states why the two cannot change a common guarded aggregate and why their locks
cannot cycle (same order, §5).

| | cells | proofs |
|---|---|---|
| O | O-O T11, T12; O-H T13; O-HR Y18; O-U Y17; O-D T19; O-I T23; O-C S09; O-K S15; O-F S13; O-ST S25; O-NC S45 | O-FO: FO moves only ACCRUED_PENDING lines (an offset needs ELIGIBLE R and a settled N), rows then subjects on both sides. O-A: A takes shared subjects only and its lines are PAYABLE (an offset against them is refused); the offset's rows-then-subjects cannot wait on A while A waits on nothing it holds |
| H | H-H Y12; H-HR Y21; H-U Y22; H-D Y11; H-I C17; H-C S10; H-K S12; H-F S29; H-ST S40; H-NC S39; H-A S55 (on a CREDIT line; on PAYABLE lines the existing D10-GAP-8 cells) | H-FO: FO opens FUNDS_HELD holds only on ACCRUED_PENDING lines (no claim, no credit); two holds serialize on the line subject as H-H |
| HR | HR-HR C18; HR-U Y23; HR-D Y20; HR-I C06; HR-C S34; HR-K S32; HR-F S33; HR-ST S41; HR-NC S48 | HR-FO: the ELIGIBILITY sweep's FUNDS_HELD release and FO change only ACCRUED_PENDING/HELD funds lines (claims 0 by INV-S-15.3). HR-A: a release only removes a blocker; A reads holds after its shared subject: refused or admitted, never paying held cents |
| U | U-U Y25; U-D Y19; U-C S28; U-K S44; U-F S43; U-ST S62; U-NC S63 | U-I: both are entitlement writes of one line under its row lock (as D-D, kit CONS_DUP_LINE); U-FO as HR-FO; U-A: as HR-A plus a decrease on a PAYABLE line (existing D10-GAP-8 cells) |
| D, I | D-D, I-I, D-I: kit CONS_DUP_LINE (one capture's lines under pool and row locks); D-C S11; D-K S16; D-F S30; D-ST S26; D-NC S35; I-C S17; I-K S14; I-F S42; I-NC S49 | I-ST: ST settles R's applied claims (Aout(N) counts applied and settled alike, X(N) unchanged) and locks R, not N. D-FO, I-FO: one capture's rows then subjects in both (Y13, D10-GAP-24). D-A, I-A: existing D10-GAP-8 cells (a decrease on a PAYABLE line) |
| C | C-K S31; C-F S37; C-ST S47; C-NC S38; C-FO S61 | C-C: each close takes its period FOR UPDATE, then every input line FOR UPDATE ascending, then subjects ascending: two closes serialize on their first common line, the second composing from what the first committed (a line PAYABLE through the first is not re-itemized; INV-S-15.4). C-A: C takes its period, new statement rows, line rows then exclusive subjects; A takes its old statement row, cash, then shared subjects of its PAYABLE and CREDIT lines, never a row after a subject: no cycle. Common aggregate: a CREDIT line of A's statement; A's item is live, so C itemizes none of it (R - V - itemized), and A changes no itemized amount |
| K | K-K S53; K-F S69; K-NC S36 | K-ST, K-A on one statement: both take its row FOR UPDATE first; an APPROVED or PAID statement has no CORRECTED edge (registry CommissionStatement), so after A or ST the correction is refused, and before them A/ST find a CORRECTED statement and refuse. K-FO: K's lines are PAYABLE or settled, not moved by FO; locks rows then subjects on both |
| F, ST | F-F S51; ST-ST S52; ST-FO S27; F-ST on one intent: CMD053-RACE (existing, serialized settlement on the statement row) | F-NC, ST-NC: NC needs payable 0, F and ST need an intent (payable > 0): never the same statement; on a shared line both take its row FOR UPDATE before subjects (S51 is the same lock shape) |
| NC, FO, A | NC-NC S50; NC-FO S46; A-FO S56; A-A CMD052-RACE (existing: two approvals) | A-NC: A needs payable > 0, NC payable 0: never one statement; on a shared line, NC takes the line rows FOR UPDATE and A only shared subjects, both ascending. FO-FO: one fact per capture version (UNIQUE, 0030), the capture's line rows then subjects (D10-GAP-24) |

Discovery growth: S54. FOOT-REL (crash/timeout family footprints) stays an implementation obligation of lane FOOT, not coverage.

## 8. Migration plan (provisional numbers, contiguous; never edit 0030 or 0031: new migrations ALTER and CREATE OR REPLACE)

`0045_offset_claims_yield.sql` (replaces `0045_offset_capacity_holds.sql`): `kauro.new_uuid_v7()`; `commission_noncash_settlements`
(UNIQUE statement_id; admissible guard; frozen guards on statements and lines); `commission_offset_releases` (append-only, server
instant, guard, deferred applied check, RLS FORCE, grants §4); `kauro.commission_offsets_yield(line, cause)`, `_apply_within_allowance`
(§2.5, close and correction only); re-issued `commission_offsets_authorized` (settled source, live amounts, pos with A_in and C_paid);
triggers `commission_holds_offsets_yield` (AFTER INSERT, after line_fence) and `commission_lines_offsets_yield` (AFTER UPDATE OF
cumulative_entitlement_cents, state). No `commission_holds_offset_room`. G-ORD-1 (r5): `kauro.commission_lock_line_rows`,
`kauro.take_commission_line_subject` and the flag `kauro.commission_lines_locked`; `take_commission_line_lock` (0036) and the
`commission_lines_line_fence` trigger re-issued over them; `commission_holds_lock_order` (BEFORE INSERT on holds); each guard's flag-on non-blocking branch with SQLSTATE KC021
`commission_lock_order` (provisional); the noncash guard's exclusive subjects.
`0046_seller_credit.sql`: `payout_lines_unpayable` re-issued with the CREDIT branch (OFF-R2-02), its shared subjects through
`take_commission_line_subject`; `statement_items_credit_guard`; `seller_credit_entries` (append-only, reconciled guard, RLS FORCE, seller read own); `kauro.seller_credit_reconcile`;
credit triggers on commission_lines (E, state) and commission_holds (INSERT, state) for settled lines; `statement_items` ALTER: item_kind
and disposition CREDIT, `statement_items_payable_only_payable_line` replaced (payable on PAYABLE LINE or CREDIT items; amends D10-STMT-2),
deferred `statement_items_credit_within_recognized`. The `disposition = 'PAYABLE'` filters of 0037 and 0039 (one live payable item, payable owner) stay
correct because CREDIT items carry disposition CREDIT; the payout admission of 0036/0043 is re-issued with a CREDIT branch.
Code: `lockPoolsOfCapture` ascending; `applyBasisChange` fences; ports `yieldOffsets`, `fenceLines`, `lockSetOf` (discovery),
`reconcileCredit`, `settleNoncash`; `PeriodLedgerRows.offsetReleases?`, `credits?` (optional); composer §2.7; CMD052, CMD053, correction and
close lock sets §5; PERIODS sweep noncash step; `commissionCutoffHash` V2 (§2.8).

## 9. Decisions, owner questions and caveats

- OFF-C1 (D10-NEG-4): holds first (17 "approved undisputed payable amounts"; R2-102). T13, T14, Y03, S03.
- OFF-C2 (closes Q10-11, engineering): unapplied excess goes back to its source, newest first, final. Y04, Y07.
- OFF-C3 (D10-NEG-4, OFF-R8): applied claims are frozen; only a cancelled application (§2.1) releases them; settled claims never.
- OFF-C4 (OFF-R2): §2.5 restricted rule; releases serialize on the receiving line's subject. S05, S14, S17, S24.
- OFF-C6 (r3, D10-NEG-7): offsets, releases, credit entries, CREDIT items and noncash settlements are inside KAURO_COMMISSION_CUTOFF_V2; the close's own writes follow its comparison.
- X-B12-1: UPHELD and its correction in one transaction, rows and subjects first. Out of order is churn, not loss (Y06); races Y17-Y22, S28, S43, S44.
- **OQ-1 (owner, policy; was Q10-10): "Apply SIGNED_FUTURE_OFFSET terms automatically at each monthly close, oldest debt first, against the
  seller's ELIGIBLE lines, with no separate owner approval?"** Recommendation: **yes**. The signed terms already authorize it (17 "can
  offset future eligible commissions only under the signed legally valid agreement"); a close-time writer runs under the close's locks
  and inside its cutoff, is idempotent through the period's single close, and needs no step-up per seller; the statement discloses each
  offset. If **no** (owner act), the writer is a command with an Idempotency-Key (its identity: the owner's key, one offset per key) that may run at any time: V2 (§2.8) makes a close proposed before it refuse STALE. Either answer leaves the engineering of r3 unchanged. Until
  answered, offsets are admitted only by the commission service (tests) and R2-104 rests on its recovery-item path.
- **OQ-2 (owner, policy; part of Q10-12): "Pay recognized seller credit in cash on the next monthly statement, with no minimum and no
  netting against the seller's debts?"** Recommendation: **yes**. 17 "Compensation adjustment follows the economic reversal" and the
  no-minimum policy; netting would itself be an offset needing signed terms. If **no**, credit stays recognized and carried (INV-S-16 holds)
  until the owner's chosen rule; nothing is lost either way.
- OFF-C9 (r5, ADV-OFF-1, G-ORD-1): a guard waits only for the first acquisition of its transaction; every later acquisition is
  pre-locked (re-entrant) or non-blocking and refused `commission_lock_order`; in-product writers pre-lock; the PERIODS sweep settles one
  statement per transaction. 07 "Transaction discipline": "Multi-row invariants use explicit locking or bounded serializable retries. The
  implementation documents why the chosen isolation prevents the relevant interleaving." T31-T33, Y26, C19-C21, S70-S72.
- OFF-C10 (r5, ADV-OFF-2): FK parents audited (§4); the only parent with an explicit FOR UPDATE holder is projects, whose holders take no
  B10 lock (S74).
- No registry amendment is needed: noncash settlement adds no state or edge. An optional later amendment (PAYABLE to PAID on noncash
  evidence) would only rename the frozen state; not requested.
