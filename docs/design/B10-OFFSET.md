# B10-OFFSET: offsets are claims that yield; seller credit and noncash settlement are durable (design r2, D10-NEG-4..6)

Lane `B10-OFFSET` (branch `b10/offset`, builds after kit PR1 merges). r1 = 97839bd; r2 answers Codex design review r1
(`tools/review/out/b10-offset-design-97839bdc0b32`, REJECT, OFF-R1..R8). Supersedes D10-NEG-3 and the provisional
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
successor carries it again in the correcting COMMIT. A deferred check refuses itemized(L) > R - V (never paid twice).

### 2.5 Source position shrink, restricted rule (OFF-R2)
A transaction that applies claims (close, correction) applies from each source N at most allowance(N) = max(0, pos(N) - Aout(N)), Aout
excluding applications it is itself cancelling; the excess is released newest first **among the claims this transaction applies**
(POSITION_SHRANK), under their receiving lines' subjects, which it holds. Proof: after the COMMIT, Aout(N)' = Aout(N) + applied ≤ pos(N),
so no new over-recovery; releases only lower live(o) under R's subject; unapplied claims beyond allowance elsewhere stay unapplied and
face the same rule when applied. Over-recovery from applications made before the shrink is X(N) > 0: seller credit (§2.4).

### 2.6 Noncash settlement (OFF-R7; the engineering part of Q10-12)
An applied offset is noncash settlement; `paid_cents` stays cash. A statement ISSUED (not DISPUTED, not CORRECTED) with payable_cents =
0 and at least one PAYABLE LINE item is settled noncash by the PERIODS sweep on its pay date (`pay_due_on`, server clock, Bogota): one
`commission_noncash_settlements` row (statement id and version, its PAYABLE LINE items' ids and offset_cents, the applied offsets' ids
and live cents, the statement's cutoff hash, a digest of those, pay date, server instant) after the 0036 line fence (no OPEN hold the
statement does not withhold). No payout intent is created or faked. Registry states are unchanged (no new edge): its lines stay PAYABLE
and the statement ISSUED, both **frozen** by guards: the statement refuses every transition (no approval, no correction), the lines
refuse every edge but `reconciled` decreases (§6 keeps a PAYABLE line's state on adjustment). Its claims are settled; its lines are
settled sources (§2.2) and settled credit lines (§2.4). A mixed statement (cash payable > 0) settles its zero-cash lines with its payout
(PAYABLE to PAID, paid += 0) as today. The seller disputes before the pay date (ISSUED to DISPUTED stops it), as with a cash payout.

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
- `commission_offset_releases_guard` (BEFORE INSERT): takes the receiving line's subject **before** reading live, then refuses
  `commission_offset_releases_within_live` (amount > live) and `commission_offset_releases_settled` (the claim is settled).
- `commission_offset_releases_applied` (deferred constraint, at COMMIT): a release of a claim against a line still PAYABLE through a live
  item commits only if that line's live PAYABLE item's offset_cents equals its claims (i.e. the item was superseded in the same COMMIT).
- `seller_credit_entries_reconciled` (BEFORE INSERT, under the line's subject): the row equals the difference that brings R - V to
  max(X, itemized); anything else refused. `statement_items_credit_within_recognized` (deferred): itemized(L) ≤ R - V.
- `commission_noncash_settlements_admissible` (BEFORE INSERT): statement ISSUED, payable 0, at least one PAYABLE LINE item, pay date
  reached, 0036 fence clear, evidence digest matches; `commission_statements_noncash_frozen` and `commission_lines_noncash_frozen`.
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
transaction requests a row or subject of (1)/(2) after taking any subject. Each writer computes its complete set first:
- offset insert: N and R rows (KEY SHARE) ascending, both subjects ascending, then reads.
- hold insert / hold resolution: the line's row (FK KEY SHARE; resolution: `lockLine` FOR UPDATE first), its subject (0036 fence), then
  yield or credit reconcile. B12 (X-B12-1): UPHELD and its correction in one transaction after the capture's line rows and subjects.
- basis change and `observeFunds`: `lockPoolsOfCapture` locks the capture's lines in one ascending statement (ADV-17), then
  `fenceLinesOfCapture`, then writes (triggers yield and reconcile under subjects already held).
- close: all input lines FOR UPDATE ascending (exists), `fenceLines` ascending, then yields, applications (§2.5), credit reconcile, compose.
- correction: discovery read → set = predecessor named lines ∪ lines of its CREDIT items ∪ sources of live claims against those lines;
  rows ascending, subjects ascending; re-discover; a set that grew refuses STALE_VERSION LEDGER_CHANGED; then recompose (§2.5 needs no
  other receiving line).
- CMD053: statement, intent, then FAILED/RETURNED: the set of its correction (above) ∪ the statement's PAYABLE lines; SETTLED: the
  statement's PAYABLE LINE and CREDIT lines; rows ascending, subjects ascending, before the first hold, transition or correction.
- noncash sweep: statement FOR UPDATE, its item lines' rows ascending, subjects ascending, fence check, settlement, credit reconcile.

## 6. Tests (exact titles). Counts: F1 26, F2 22, F3 6, F4 45, F5 11, F6 7 = 117

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
- S34 "RACE: a hold RELEASED and a period close over its ELIGIBLE line, both orders: release first, the statement pays the 500; close first, the 500 is withheld and becomes a 500-cent seller credit when the line is PAID"
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

Family suites (kit `apps/api/test/b10-cells-support.ts`): CONS_TMO/CRB/CRA (refund, reversal), CMD_CRB/CRA of CMD051, the correction,
CMD053 and the PERIODS sweep (SWEEP_*) cover the new writes once each member's footprint includes `commission_offset_releases`,
`seller_credit_entries`, `commission_noncash_settlements` (FOOT-REL: an implementation obligation, closed by lane FOOT, not coverage until then).

## 7. Failure-mode matrix (C = test above, written first; all money cells tier 1)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| M1 offset INSERT | **C** pairs below (O-*) | **C** T20 | N/A: no deadline governs an offset; R is already ELIGIBLE | **C** T21 | N/A: no response step; the writer (OQ-1) owns it | **GAP** OQ-1: the writer's idempotency identity | N/A: agreement terms immutable once signed (0029 `seller_agreements_immutable`, `learned_once`), read after the lock | N/A: one INSERT; DENY T01-T10, T17, T18 |
| M2 hold INSERT + yield + credit | **C** pairs (H-*) | **C** Y16 | N/A: review_at acts on nothing | **C** Y14 | **GAP** FOOT-REL (SWEEP_CRA, CONS_CRA members opening holds); the dispute command is B12's | N/A: own hold id; B12's key | N/A: B12's grant | **C** Y14 (hold and release roll back together) |
| M3 hold RESOLVED (RELEASED, UPHELD) + credit | **C** pairs (HR-*, U-*) | **GAP** FOOT-REL (ELIGIBILITY sweep timeout member) | N/A | **GAP** FOOT-REL (SWEEP_CRB ELIGIBILITY) | **GAP** FOOT-REL (SWEEP_CRA) | **C** resolveHold CAS (existing STALE on version) + C06 | N/A: commission service / B12 | **C** C03 (credit with the resolution, one COMMIT) |
| M4 line E change + yield + credit (refund, reversal; B12 correction) | **C** pairs (D-*) | **GAP** FOOT-REL CONS_TMO | N/A | **GAP** FOOT-REL CONS_CRB | **GAP** FOOT-REL CONS_CRA | **C** Y10 | **C** CONS_REV (kit, existing) | **C** Y15 |
| M5 CMD053 FAILED/RETURNED (cancellation, HELD or zero path, correction) | **C** pairs (F-*) | **GAP** FOOT-REL CMD053 member | N/A: evidence has no B10 deadline (B15) | **GAP** FOOT-REL CMD_CRB | **GAP** FOOT-REL CMD_CRA | **C** CMD053 RETRY cell (existing); S06, S20 one release | N/A: finance service fact | **C** S06, S20 (hold or none, line, release, credit, correction: one COMMIT) |
| M6 CMD053 SETTLED (lines PAID, claims settled, credit) | **C** pairs (ST-*) | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD053 RETRY (existing) | N/A | **C** S41 |
| M7 close CMD051 (yield, §2.5 applications, credit, CREDIT items) | **C** pairs (C-*) | **GAP** FOOT-REL | N/A here: the period's due date is CMD051's existing EXPIRY cell | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD051 RETRY (existing); S05, S18 | N/A | **C** P02, S01-S05, S08, S18 |
| M8 correction (lock set, cancellation, recompose) | **C** pairs (K-*) | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** existing "corrected once" | N/A | **C** S07, S12 (LEDGER_CHANGED rolls back releases) |
| M9 noncash settlement (PERIODS sweep) | **C** pairs (NC-*) | **GAP** FOOT-REL SWEEP_TMO | **C** S21 (before, at, after the pay date on the controlled clock) | **GAP** FOOT-REL SWEEP_CRB | **GAP** FOOT-REL SWEEP_CRA | **C** S36 (UNIQUE statement: a second pass settles nothing) | N/A: commission service | **C** S21 (settlement and credit, one COMMIT) |
| M10 lock acquisition (pools, fence, prelocks) | **C** Y13, S13, S25 | N/A: M4/M5 | N/A | N/A: locks only | N/A | N/A | N/A | N/A: locks only |
| M11 release INSERT (guarded) | **C** T24 | N/A: one guarded INSERT | N/A | N/A: single INSERT | N/A | **C** T24 (a second release refused beyond live) | N/A | **C** T22, T25, T26 |
| M12 credit entry INSERT (guarded) / CREDIT item | **C** C06 | N/A | N/A | N/A: single INSERT | N/A | **C** C07 | N/A | **C** C05, C07 |

Writer-pair table on one line (O offset, H hold opened, HR hold RELEASED, U UPHELD + correction (X-B12-1, built here as the protocol,
B12 calls it), D entitlement change, C close, K correction, F CMD053 FAILED/RETURNED, ST CMD053 SETTLED, NC noncash sweep, FO funds
observation, I source increase). Every cell holds one actor at a named lock, both orders:
O-O T11, T12; O-H T13; O-HR Y18; O-U Y17; O-D T19; O-I T23; O-C S09; O-K S15; O-F S13; O-ST S25; O-NC S45; H-H Y12; H-HR Y21; H-U Y22; H-D Y11; H-C S10;
H-K S12; H-F S29; H-ST S40; H-NC S39; HR-D Y20; HR-C S34; HR-K S32; HR-F S33; HR-ST S41; HR-I C06; U-D Y19; U-C S28; U-K S44;
U-F S43; D-C S11; D-K S16; D-F S30; D-ST S26; D-NC S35; I-C S17; I-K S14; I-F S42; C-K S31; C-F S37; C-NC S38; K-F: serialized on the
statement row (D10-GAP-12 existing cell; CMD053 corrects in its own COMMIT); K-NC S36; F-ST: one intent, one evidence (existing CMD053
cell); ST-FO S27; HR-U, F-F, ST-ST, K-K: same hold or statement, CAS (existing STALE cells).

## 8. Migration plan (provisional numbers, contiguous; never edit 0030 or 0031: new migrations ALTER and CREATE OR REPLACE)

`0045_offset_claims_yield.sql` (replaces `0045_offset_capacity_holds.sql`): `kauro.new_uuid_v7()`; `commission_noncash_settlements`
(UNIQUE statement_id; admissible guard; frozen guards on statements and lines); `commission_offset_releases` (append-only, server
instant, guard, deferred applied check, RLS FORCE, grants §4); `kauro.commission_offsets_yield(line, cause)`, `_apply_within_allowance`
(§2.5, close and correction only); re-issued `commission_offsets_authorized` (settled source, live amounts, pos with A_in and C_paid);
triggers `commission_holds_offsets_yield` (AFTER INSERT, after line_fence) and `commission_lines_offsets_yield` (AFTER UPDATE OF
cumulative_entitlement_cents, state). No `commission_holds_offset_room`.
`0046_seller_credit.sql`: `seller_credit_entries` (append-only, reconciled guard, RLS FORCE, seller read own); `kauro.seller_credit_reconcile`;
credit triggers on commission_lines (E, state) and commission_holds (INSERT, state) for settled lines; `statement_items` ALTER: item_kind
and disposition CREDIT, `statement_items_payable_only_payable_line` replaced (payable on PAYABLE LINE or CREDIT items; amends D10-STMT-2),
deferred `statement_items_credit_within_recognized`. Existing `disposition = 'PAYABLE'` filters (0036, 0037, 0039, 0043) stay correct
because CREDIT items carry disposition CREDIT.
Code: `lockPoolsOfCapture` ascending; `applyBasisChange` fences; ports `yieldOffsets`, `fenceLines`, `lockSetOf` (discovery),
`reconcileCredit`, `settleNoncash`; `PeriodLedgerRows.offsetReleases?`, `credits?` (optional); composer §2.7; CMD053, correction and
close lock sets §5; PERIODS sweep noncash step.

## 9. Decisions, owner questions and caveats

- OFF-C1 (D10-NEG-4): holds first (17 "approved undisputed payable amounts"; R2-102). T13, T14, Y03, S03.
- OFF-C2 (closes Q10-11, engineering): unapplied excess goes back to its source, newest first, final. Y04, Y07.
- OFF-C3 (D10-NEG-4, OFF-R8): applied claims are frozen; only a cancelled application (§2.1) releases them; settled claims never.
- OFF-C4 (OFF-R2): §2.5 restricted rule; releases serialize on the receiving line's subject. S05, S14, S17, S24.
- OFF-C6: releases and credit entries are outside KAURO_COMMISSION_CUTOFF_V1; each is caused by a hashed change or by the close itself.
- X-B12-1: UPHELD and its correction in one transaction, rows and subjects first. Out of order is churn, not loss (Y06); races Y17-Y22, S28, S43, S44.
- **OQ-1 (owner, policy; was Q10-10): "Apply SIGNED_FUTURE_OFFSET terms automatically at each monthly close, oldest debt first, against the
  seller's ELIGIBLE lines, with no separate owner approval?"** Recommendation: **yes**. The signed terms already authorize it (17 "can
  offset future eligible commissions only under the signed legally valid agreement"); a close-time writer runs under the close's locks
  and inside its cutoff, is idempotent through the period's single close, and needs no step-up per seller; the statement discloses each
  offset. If **no** (owner act), the writer is a command with an Idempotency-Key that runs before the proposal (STALE otherwise). Until
  answered, offsets are admitted only by the commission service (tests) and R2-104 rests on its recovery-item path.
- **OQ-2 (owner, policy; part of Q10-12): "Pay recognized seller credit in cash on the next monthly statement, with no minimum and no
  netting against the seller's debts?"** Recommendation: **yes**. 17 "Compensation adjustment follows the economic reversal" and the
  no-minimum policy; netting would itself be an offset needing signed terms. If **no**, credit stays recognized and carried (INV-S-16 holds)
  until the owner's chosen rule; nothing is lost either way.
- No registry amendment is needed: noncash settlement adds no state or edge. An optional later amendment (PAYABLE to PAID on noncash
  evidence) would only rename the frozen state; not requested.
