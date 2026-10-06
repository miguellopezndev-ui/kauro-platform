# B10-OFFSET: offsets are claims that yield to decreases and holds (design, D10-NEG-4)

Lane `B10-OFFSET` (branch `b10/offset`, builds after kit PR1 merges). Supersedes D10-NEG-3 and the provisional migration
`0045_offset_capacity_holds.sql` (843bf01; reverted on the kit by f78af7b). Inputs: adversary ADV-3, ADV-9, ADV-10, ADV-14 (89df19e),
ADV-15, ADV-17 (843bf01), ADV-18 (457837c). Governing text: 17 "Refunds after payout and negative balances", 17 "Accrual, eligibility
and payout" ("Approved undisputed payable amounts are scheduled"; "no justified material refund/dispute hold applies"), 17 "An unresolved
claim dispute holds only the contested compensation allocation"; R2-102, R2-104; design §6 (Holds, Negative balance), §7, §10;
D10-HOLD-1, D10-NEG-1, D10-NEG-2, D10-STMT-2, D10-STMT-4, D10-GAP-8, D10-GAP-12, D10-GAP-24; kit invariants INV-S-01, INV-S-07.

## 1. What is wrong on 0030 today (all latent: `recordOffset` has no production caller, OFF-C5)

| id | gap | cents lost (N = negative line, R = receiving line) |
|---|---|---|
| ADV-3/14 | admission ignores R's OPEN holds; the close clips the offset to unpaid - held | the clipped part, consumed from N in full |
| ADV-9 | R admitted in PAYABLE (no statement applies it again); `paid_cents IS NULL` N admitted | the whole offset |
| ADV-10 | no lock, READ COMMITTED sums: two offsets that each fit commit together | the excess (1200 on 1000) |
| ADV-15 | a refund, reversal, VOID or hold on R after the offset: the close clips or skips R, N subtracts every recorded offset | the unapplied part |
| new (E) | R paid with an offset applied, then refunded: R's position counts only cash (`paid_cents`, INV-S-05) | the applied part |
| ADV-17 | `lockPoolsOfCapture` locks pool by pool: 40P01 against an ascending writer | none (abort), but breaks rule 11 |

## 2. Model (D10-NEG-4)

Terms, per line L, in cents: E = `cumulative_entitlement_cents`; P = `coalesce(paid_cents, 0)` (cash only, INV-S-05); H = sum of OPEN
holds; for an offset o: live(o) = o.amount - sum of its releases; claims(L) = sum of live(o) against L; out(N) = sum of live(o) from N.

1. **An offset is a claim on R's capacity**, cap(R) = max(0, E - P - H). It is admitted only when R is ELIGIBLE and only from an N that
   was paid (`paid_cents IS NOT NULL`), within cap(R) - claims(R) and within pos(N) - out(N).
2. **Unapplied vs applied.** R is *unapplied* in ACCRUED_PENDING, ELIGIBLE, HELD, VOID; *applied* in PAYABLE, PAID, ADJUSTED. A close (or
   correction) that makes R PAYABLE applies claims(R) exactly in R's PAYABLE item (`offset_cents`); from then on they are frozen: the issued
   item's payout pays as issued (§6 "a PAYABLE line keeps its state and the adjustment goes to the next statement"; D10-GAP-8), so a
   release there would count the same cents twice (once applied in the item, once back on N).
3. **Holds and decreases are never refused because of offsets** (17: disputed cents are not "approved undisputed payable"; R2-102). On
   an unapplied R, every write that lowers cap(R) below claims(R) **releases the excess in the same COMMIT**: one append-only
   `commission_offset_releases` row per offset touched, newest offset first (recorded_at DESC, offset_id DESC), never more than live(o).
   The released cents are N's position again: never lost, never negative.
4. **Applied claims count as settled.** pos(L) = P + claims(L) - E for L in PAYABLE, PAID, ADJUSTED. A refund of an applied R
   therefore makes R negative by exactly what it no longer earns (example E); nothing is released on applied lines.
5. **N's position shrinking** (r3 R3-01: a legal one-cent INCREASE of N) yields at the next close or correction that would apply an
   unapplied claim from N, under that close's locks: unapplied claims from N beyond max(0, pos(N) - applied claims from N) are released
   newest first (cause POSITION_SHRANK). Applied claims beyond pos(N) are the seller's credit: NEW-1 (section 9), not this lane.
6. **A release is final.** A hold RELEASED later restores capacity, not the claim; a new offset is a new row (OFF-C5's writer).
7. **The statement.** OFFSET items report live(o) at the close (a fully released offset has no item); N's balance left =
   pos(N) - out(N); a PAYABLE R whose E fell below its applied claims reports pos(R) > 0 as a negative balance (RECOVERY item without
   SIGNED terms), so no in-kind debt is invisible while its statement waits (OFF-C7). composeStatement never clips: claims beyond an
   ELIGIBLE line's E - P - H are an integrity fault (RangeError), because every writer yielded first.

Release causes (`COMMERCIAL_VOCABULARY`): HOLD_OPENED, ENTITLEMENT_DECREASED, LINE_HELD, STATEMENT_COMPOSED, POSITION_SHRANK.

## 3. Worked examples (cents). N: paid 4000, entitlement 3400, pos(N) = 600. R: ELIGIBLE, E 1000, unpaid. Offset o1 = 600 (N to R)

| # | event | today (0030, or 0045 where named) | D10-NEG-4 |
|---|---|---|---|
| A | full refund of R's capture: R E 0, VOID | close skips VOID R; N left = 600 - 600 = 0: **600 lost** | refund COMMIT releases 600 (ENTITLEMENT_DECREASED); live 0; statement: ADJUSTMENT -1000 on R, no OFFSET item, negative balance 600 |
| B | partial refund of R to 400 | close clips to 400 (payable 0); N left 0: **200 lost** | refund releases 200; live 400; close: R PAYABLE offset 400 payable 0, OFFSET item 400, N left 200 |
| C | SELLER_DISPUTE hold 1000 on R | 0045: hold **refused** 23514 (room 400), the disputed 600 repays N. 0030: hold opens, R HELD; the 600 stays claimed on a HELD line (N left 0): deferred if RELEASED, **600 lost** if UPHELD or R is then refunded | hold opens, releases 600 (HOLD_OPENED); R HELD 1000; N left 600. Hold RELEASED later: cap 1000, claims 0; R paid 1000 in cash at a later close; N's 600 awaits a new offset |
| D | hold 500, then UPHELD + AGREED_ERROR_CORRECTION -500 in one transaction (X-B12-1) | 0045: hold refused (room 400). 0030: close clips to 500, N left 0: **100 lost** | hold releases 100 (cap 500); UPHELD + decrease: cap 500 = claims 500, nothing; close: R offset 500 payable 0, N left 100. Out of order (UPHELD committed alone): room 1000, 100 more admissible, the later decrease releases that newest 100: same end state, churn only |
| E | R closed with o1 applied (payable 400), payout SETTLED (P 400), then refund to 0 | pos(R) = 400 - 0 = 400; N left 0: **600 lost** (seller entitled 3400, received 4400 cash: owes 1000) | pos(R) = 400 + 600 - 0 = 1000; N left 0; owed 1000 |
| F | r3 R3-01: pos(N) 1, a 1-cent claim on ELIGIBLE R, then N +1 cent (pos 0) | close applies 1 cent of a debt that no longer exists: seller loses 1 | next close releases 1 (POSITION_SHRANK) under R's lock; R payable in full |
| G | R PAYABLE (item offset 600, payable 400), payout FAILED | R HELD PAYOUT_FAILED; correction itemizes R HELD; N left 0: deferred until R is ELIGIBLE again, **600 lost** if R is refunded meanwhile (A) | PAYOUT_FAILED hold on PAYABLE R releases nothing (applied); R PAYABLE to HELD releases 600 (LINE_HELD) in CMD053's COMMIT; the correcting statement shows N's 600 |

## 4. Invariants

Database guards (named, each its own DENY test, rule 12):
- `commission_offsets_authorized` (re-issued): KC017 as 0030; `commission_offsets_amount` (23514) for **each** of: N never paid;
  amount > pos(N) - out(N); amount > cap(R) - claims(R); `commission_offsets_applicable` (23514): R not ELIGIBLE.
- `commission_offset_releases_within_live` (23514): a release row's amount > live(o) of its offset (backstop for a direct writer).

Oracle (`packages/persistence/src/testing/invariants.ts`), state invariants only, one atomic why each with its own forged control:
- **INV-S-15 offset claims** (decision D10-NEG-4): whys
  1. "release beyond its offset": sum of releases of o > o.amount;
  2. "offset from a line never paid": N.paid_cents IS NULL;
  3. "claims beyond the capacity of an unapplied line": R in (ACCRUED_PENDING, ELIGIBLE, HELD, VOID) and claims(R) > max(0, E - P - H);
  4. "applied claims not the payable item's offset": R in (PAYABLE, PAID, ADJUSTED) with `payable_statement_id` set and claims(R) <> the
     `offset_cents` of R's LINE PAYABLE item in that statement.
- **INV-S-07** first why changes from "OFFSET item not its offset" (equality: false once a release follows the statement) to
  "OFFSET item beyond its offset" (`offset_cents > amount_cents`). Its other five whys are unchanged.
- Not oracle (insert- or close-time facts, dedicated tests): the admission bounds (kit 2.3, r3 R3-01), N's unapplied claims within its
  shrunken position (legal between an INCREASE and the next close, model 5), OFFSET item = live at its close.

## 5. Lock order (rule 11: one order for every writer of either side)

Prefix unchanged (§10, D10-TX-1): ... commission period, statement, payout intent, then:
**(1) commission line rows, ascending line_id** (FOR UPDATE for line writers; FOR KEY SHARE for an offset insert and, through the FK, a
hold insert) **(2) their transition subjects ("kauro.commission_lines", id), ascending** (exclusive for writers, shared for CMD052)
**(3) hold rows (4) offset and release rows (no lock taken: every release of o is written under o's receiving line's subject, so two
releasers of one offset serialize there and each re-reads live(o) after it).** No transaction waits for a row or subject in (1)/(2)
after taking any subject. Concretely:
- offset insert: N and R rows FOR KEY SHARE ascending, then both subjects ascending, then every read (0045 shape, kept).
- hold insert: FK KEY SHARE on R, subject in `commission_holds_line_fence` (0036), then `commission_holds_offsets_yield` (AFTER INSERT,
  fires after line_fence by name).
- line UPDATE of `cumulative_entitlement_cents` or `state` on an unapplied state: `commission_lines_offsets_yield` (AFTER UPDATE) takes R's
  subject (re-entrant) and yields.
- basis change (`applyBasisChange`) and `observeFunds`: `lockPoolsOfCapture` locks **all lines of the capture in one ascending statement**
  (ADV-17), then `fenceLinesOfCapture` (ascending subjects; already in `observeFunds`, added to `applyBasisChange`), then writes.
- close (CMD051): lines FOR UPDATE ascending (exists), then `yieldOffsets(lineIds)`: subjects ascending, R-side yield, N-side yield
  (model 5), then compose. Correction: locks the union of its named lines **and the N lines of the claims it would apply**, ascending; a
  claim from an N outside the locked set after locking refuses STALE_VERSION LEDGER_CHANGED; then `yieldOffsets` with cause
  STATEMENT_COMPOSED also for lines PAYABLE through the predecessor (they are recomposed, so their claims are unapplied again).
- CMD053 FAILED: locks the statement's PAYABLE lines ascending and their subjects before the first transition (today: item order).
- B12 (X-B12-1): resolve UPHELD and post the AGREED_ERROR_CORRECTION in one transaction, after the capture's line rows ascending and
  their subjects; never resolve a hold before locking its line's row (the hold-row-then-subject order of `resolveHold` deadlocks with an
  offset insert holding R's key-share lock).

## 6. Tests (exact titles; ids are cited by the matrix). P = preserved verbatim from 843bf01, R = retitled, N = new

F1 `packages/persistence/test/b10-offset-bounds.test.ts` (recreated; kit f78af7b deleted it)
- T01 P "DENY: an offset of 101 cents against an unpaid 100-cent line with a 1000-cent negative position is refused commission_offsets_amount and writes nothing"
- T02 P "DENY: offsets of one negative line against two receiving lines whose sum exceeds the negative position are refused at the cent that exceeds it"
- T03 P "DENY: two negative lines of one seller each offset within its own position, a third offset exceeding one line's remaining position refused"
- T04 P "DENY: two distinct negative lines of one seller, each within its own position, whose offsets against ONE receiving line together exceed that line's unpaid amount are refused at the cent that exceeds it"
- T05 R "DENY: an offset beyond the receiving line's unpaid amount less its OPEN partial hold is refused commission_offsets_amount and writes nothing (held cents are never claimed, D10-NEG-4)"
- T06 P "DENY: the capacity less an OPEN hold is shared by every offset against the line: a second negative line's offset beyond what the first left of unpaid-minus-held is refused"
- T07 P "a RELEASED hold withholds nothing: the offset may use the line's whole unpaid amount again"
- T08 P "DENY: an offset against a PAYABLE receiving line (payable through an ISSUED statement, which applies no later offset) is refused commission_offsets_applicable and writes nothing"
- T09 P "DENY: an offset against an ACCRUED_PENDING receiving line, and against the same line once HELD under a covering hold, is refused commission_offsets_applicable and writes nothing"
- T10 P "DENY: an offset FROM a line never paid (paid_cents NULL: no negative position) is refused commission_offsets_amount and writes nothing"
- T11 P "RACE: two 600-cent offsets of two negative lines against ONE 1000-cent receiving line, both orders: the second waits on the first's line lock and is refused, exactly one commits"
- T12 P "RACE: two 600-cent offsets of ONE negative line (a 1000-cent position) against two receiving lines, both orders: the second waits on the negative line's lock and is refused, exactly one commits"
- T13 R "RACE: a 600-cent offset and a 500-cent hold on ONE 1000-cent ELIGIBLE line, both orders: the second waits on the first's line lock; hold first, the offset is refused beyond the 500 left; offset first, the hold opens and releases 100 of the offset (D10-NEG-4)"
- T14 R "OK: a hold opened after an offset on an ELIGIBLE line opens whatever the offsets: 1000 unpaid, 900 offset, a 101-cent hold opens and releases 1 cent of the offset to the negative line (D10-NEG-4)"
- T15 R "a hold on a PAYABLE line whose statement applied an offset opens and releases nothing: the issued item's 300 offset stands (the PAYOUT_FAILED covering hold, D10-NEG-4)"
- T16 P "an UPHELD hold withholds nothing (its decision posts an AGREED_ERROR_CORRECTION decrease instead): the offset may use the line's whole unpaid amount"
- T17 N "DENY: an offset from a paid line counts the offsets applied to it as paid: paid 400 through a statement that applied 600, refunded to 0, admits 1000 from it and refuses 1001 commission_offsets_amount"
- T18 N "DENY: the negative position counts only live claims: after a refund released 200 of a 600-cent offset of a 1000-cent position, 600 more is admitted and 601 refused"
- T19 N "RACE: a 600-cent offset and a refund lowering its 1000-cent receiving line to 400, both orders: refund first, the offset is refused beyond 400; offset first, the refund releases 200; never more than 400 claimed"
- T20 N "RACE (timeout): an offset waiting on its receiving line's subject past its statement timeout rolls back and writes nothing; the holder's hold stands"
- T21 N "RACE (crash before COMMIT): an offset written and its backend terminated before COMMIT leaves no offset"
- T23 N "RACE: an offset from a negative line and a one-cent INCREASE of that line, both orders: increase first, the offset is refused beyond the shrunken position; offset first, the increase waits on the line's key-share lock and the excess cent is released at the next close"
- T22 N "DENY: a release beyond its offset's live amount, written directly by the commission service, is refused commission_offset_releases_within_live and writes nothing"

F2 `packages/persistence/test/b10-offset-yield.test.ts` (new)
- Y01 "OK (ADV-15 A, full refund): a refund of the receiving line's capture to 0 releases its whole 600-cent offset in the refund's COMMIT (ENTITLEMENT_DECREASED); the line VOID, the offset's live amount 0, the negative line's position 600 to recover"
- Y02 "OK (ADV-15 B, partial refund): a refund of the receiving line from 1000 to 400 releases 200 of its 600-cent offset; 400 stay claimed and the negative line keeps 200 to recover"
- Y03 "OK (ADV-15 C, dispute hold): a 1000-cent SELLER_DISPUTE hold on a 1000-cent ELIGIBLE line with a 600-cent offset opens and releases the 600 (HOLD_OPENED)"
- Y04 "OK: a RELEASED hold does not revive a released claim: after a 1000-cent hold released 600 and is RELEASED, the line's live claims stay 0"
- Y05 "OK (ADV-15 D, UPHELD): a 500-cent hold releases 100 of a 600-cent offset; its UPHELD resolution and its 500-cent AGREED_ERROR_CORRECTION in one transaction release nothing more; 500 stay claimed against 500"
- Y06 "OK (ADV-15 D, out of order): an UPHELD resolution committed alone lets 100 more be offset; the later 500-cent AGREED_ERROR_CORRECTION releases that newest 100 and the end state equals the one-transaction order"
- Y07 "OK: releases go newest first: offsets of 300 then 400 against 1000 unpaid, a refund to 500 releases 200 of the 400 and none of the 300"
- Y08 "OK: a hold and a decrease on a PAYABLE line whose statement applied a 600-cent offset release nothing: the issued item's offset stands"
- Y09 "OK (G): PAYABLE to HELD PAYOUT_FAILED releases the 600 cents its statement applied (LINE_HELD) in the same COMMIT"
- Y10 "RACE (retry): a redelivered refund adds no adjustment and releases nothing more"
- Y11 "RACE: a 500-cent hold and a refund to 700 on one 1000-cent line carrying a 600-cent offset, both orders: the second waits on the line's lock; either order ends with 400 released and 200 claimed"
- Y12 "RACE: holds of 500 and 400 on one 1000-cent line carrying a 600-cent offset, both orders: the second waits on the line's subject; either order ends with 500 released and 100 claimed, never more released than the offset"
- Y13 "RACE (ADV-17): a refund of a capture whose pools order its lines against ascending id and an offset between two of those lines, both orders: no deadlock (40P01 never), the waiter observed waiting at the first line row"
- Y14 "RACE (crash before COMMIT): a hold whose yield released 600 and whose backend is terminated before COMMIT leaves no hold and no release"
- Y15 "RACE (partial): a refund whose yield released 200 and whose second line's adjustment then fails leaves every line, adjustment and live amount as before"
- Y16 "RACE (timeout): a hold waiting on the receiving line's subject behind an offset past its statement timeout rolls back: no hold, no release; the offset stands"

F3 `packages/domain/test/b10-offset-compose.test.ts` (new, pure)
- P01 "composeStatement applies the live claims against an ELIGIBLE line (amount less releases) and reports each OFFSET item at its live cents; a fully released offset has no item"
- P02 "composeStatement refuses (RangeError) claims beyond an ELIGIBLE line's unpaid amount less its OPEN holds instead of clipping them"
- P03 "composeStatement counts the claims applied to a PAID line as paid: paid 400 with 600 applied, refunded to 0, is a 1000-cent negative position (E)"
- P04 "composeStatement reports the in-kind position of a PAYABLE line whose entitlement fell below its applied claims: 600 applied, entitlement 400, a 200-cent negative balance"
- P05 "composeStatement's balance left on a negative line is its position less its live claims: position 1000, a 600-cent offset of which 200 released, 600 left"

F4 `apps/api/test/b10-offset-statements.test.ts` (new; CMD051, correction, CMD053 through the commission service)
- S01 "R2-104 (ADV-15 A): after a full refund of the receiving line, the next statement reports its -1000 adjustment, no OFFSET item and a 600-cent negative balance"
- S02 "R2-104 (ADV-15 B): after a refund of the receiving line to 400, the statement applies 400 (payable 0), an OFFSET item of 400 and a 200-cent negative balance"
- S03 "R2-102 with R2-104 (ADV-15 C): a 1000-cent dispute hold on the receiving line opens; the statement itemizes the line HELD 1000 and a 600-cent negative balance"
- S04 "R2-102 with R2-104 (ADV-15 D): a 500-cent hold UPHELD with its 500-cent correction in one transaction: the statement applies 500 (payable 0) and a 100-cent negative balance"
- S05 "r3 R3-01 (F): a close after a one-cent INCREASE of an offset negative line releases that cent (POSITION_SHRANK) and pays the receiving line in full"
- S06 "CMD053 FAILED (G): the failed payout of a statement that applied a 600-cent offset releases it (LINE_HELD) and the correcting statement shows a 600-cent negative balance"
- S07 "CMD051 correction: a 500-cent hold on a PAYABLE line whose statement applied 600: the correction releases 100 (STATEMENT_COMPOSED) and its successor applies 500 beside a 500 HOLD item"
- S08 "R2-104 (E): a line paid 400 through a statement that applied 600, then refunded to 0, shows a 1000-cent negative balance at the next close"
- S09 "RACE: an offset and a period close over its receiving line, both orders: offset first, the statement applies it; close first, the line is PAYABLE and the offset is refused commission_offsets_applicable"
- S10 "RACE: a dispute hold and a period close on a line carrying a 600-cent offset, both orders: hold first, the line is itemized HELD and the 600 is the negative line's again; close first, the line is PAYABLE with 600 applied and the hold releases nothing"
- S11 "RACE: a refund to 400 and a period close on a line carrying a 600-cent offset, both orders: refund first, the statement applies 400; close first, the item applies 600 and the refund releases nothing"
- S12 "RACE: a correction and a 500-cent hold on its PAYABLE line carrying 600, both orders: hold first, the correction releases 100 and applies 500; correction first, the successor applies 600 and the hold releases nothing"
- S13 "RACE: a CMD053 FAILED reconciliation and an offset naming two of its lines, both orders: no deadlock, the statement's lines locked ascending before any transition"
- S14 "RACE: a correction and a one-cent INCREASE of the negative line of a claim it applies, both orders: increase first, the correction releases the cent; correction first, the increase waits on the locked negative line"
- S15 "RACE: an offset and a correction that makes its receiving line PAYABLE again, both orders: offset first, the successor applies it; correction first, the offset is refused commission_offsets_applicable"
- S16 "RACE: a refund to 400 and a correction recomposing its PAYABLE line carrying 600, both orders: refund first, the correction releases 200 and applies 400; correction first, the successor applies 600 and the refund releases nothing"
- S17 "RACE: a one-cent INCREASE of an offset negative line and a period close, both orders: increase first, the close releases the cent; close first, the cent is applied and exceeds the negative line's position by 1 (NEW-1, characterized, not paid)"

F5 `packages/persistence/test/invariants.test.ts` (forged controls; positive controls of example 7 and r3 R3-01 must stay silent)
- V1 "INV-S-15 fires on a release beyond its offset (money: 600 released twice from a 600-cent offset)"
- V2 "INV-S-15 fires on an offset from a line never paid"
- V3 "INV-S-15 fires on claims beyond the unpaid amount less OPEN holds of an ELIGIBLE line (money: 600 claimed against 400)"
- V4 "INV-S-15 fires on a PAYABLE line whose live claims are not its payable item's offset (money: 600 applied, 400 claimed)"
- V5 "INV-S-07 fires on an OFFSET item beyond its offset (money: 700 reported for a 600-cent offset)"

Family suites (kit, `apps/api/test/b10-cells-support.ts`): CONS_TMO, CONS_CRB, CONS_CRA (refund/reversal consumer) and CMD_CRB/CMD_CRA of
CMD051 and CMD053 cover the yields in their COMMITs once the members' footprints include `commission_offset_releases` (gap FOOT-REL).

## 7. Failure-mode matrix (8 columns; C = test id above, written first; GAP codes are this lane's; all money cells tier 1)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| M1 offset INSERT (guard, locks N,R) | **C** T11 (O-O on R), T12 (O-O on N), T13 (O-H), T19 (O-D), T23 (O-I), S09 (O-C), S15 (O-K) | **C** T20 | N/A: no deadline governs an offset; R's eligibility instant already passed (it is ELIGIBLE) | **C** T21 | N/A: no response step; the caller (OFF-C5, latent) owns it | **GAP** OFF-C5: no idempotency key; a replay is a second claim within the bounds. Writer's package | N/A: agreement terms immutable once signed (0029 `seller_agreements_immutable`, `learned_once`); KC017 read after the lock | N/A: one INSERT; guards cited as DENY T01-T10, T17, T18 |
| M2 hold INSERT OPEN + yield (HOLD_OPENED) | **C** T13 (H-O), Y11 (H-D), Y12 (H-H), S10 (H-C), S12 (H-K) | **C** Y16 | N/A: review_at triggers nothing automatically | **C** Y14 | **GAP** FOOT-REL: holds opened by B10 sweeps and consumers (SWEEP_CRA, CONS_CRA members); the dispute command's is B12's | N/A: a hold has its own id; a replayed command is B12's key | N/A: B12's (corporate owner grant) | **C** Y14 asserts hold and release roll back together; T14, Y03 assert the amounts |
| M3 line cumulative DECREASE + yield (refund, reversal; B12 correction) | **C** Y11, T19, S11 (D-C), Y13 (lock order) | **GAP** FOOT-REL: CONS_TMO footprint + releases | N/A: no deadline | **GAP** FOOT-REL: CONS_CRB footprint + releases | **GAP** FOOT-REL: CONS_CRA footprint + releases | **C** Y10 | **C** CONS_REV kit (termination does not change rights already earned; releases follow the decrease) | **C** Y15 |
| M4 line PAYABLE to HELD (CMD053 FAILED) + yield (LINE_HELD) | **C** S13 (no deadlock with O) | **GAP** FOOT-REL CMD053 timeout member | N/A: evidence has no deadline in B10 (B15) | **GAP** FOOT-REL: CMD_CRB CMD053 | **GAP** FOOT-REL: CMD_CRA CMD053 | **C** CMD053's existing RETRY cell (B10-failure-matrix, CMD053 row); S06 asserts one release | N/A: finance service fact, no grant read mid-way | **C** S06 (hold, line, release and correction in one COMMIT) |
| M5 close CMD051 (yield both sides, compose, PAYABLE) | **C** S09 (C-O), S10 (C-H), S11 (C-D), S17 (C-I) | **GAP** FOOT-REL: CMD051 timeout member | N/A here: the period's due date is CMD051's existing EXPIRY cell (B10-failure-matrix, CMD051 row), not changed by the yield | **GAP** FOOT-REL: CMD_CRB CMD051 | **GAP** FOOT-REL: CMD_CRA CMD051 | **C** CMD051's existing RETRY cell (one statement per period, unchanged); S05 asserts exactly one release | N/A: commission service, no grant | **C** P02 (no silent clip); S01-S05, S08 assert every cent |
| M6 correction (union lock, yield, recompose) | **C** S12 (K-H), S14 (K-I), S15 (K-O), S16 (K-D) | **GAP** FOOT-REL correction member | N/A: no deadline | **GAP** FOOT-REL: correction CMD_CRB | **GAP** FOOT-REL: correction CMD_CRA | **C** existing "corrected once" (no edge from CORRECTED) | N/A: no grant | **C** S07 + existing LEDGER_CHANGED refusal rolls back releases (S12 hold-first branch asserts it) |
| M7 lockPoolsOfCapture + fence (basis change, funds) | **C** Y13 (both orders, 40P01 never) | N/A: covered by M3 TIMEOUT | N/A | N/A: lock-only step | N/A | N/A | N/A | N/A: lock-only step |
| M8 B12 UPHELD + correction (X-B12-1) | **C** Y05 (one txn), Y06 (out of order: churn, no loss) | PARTIAL: B12 | N/A | PARTIAL: B12 | PARTIAL: B12 | PARTIAL: B12 | PARTIAL: B12 | **C** Y06 shows the out-of-order end state equals the atomic one |
| M9 payout settle PAYABLE to PAID (applied claims frozen) | **C** PAY_APPROVE_VS_FAIL (existing, unchanged) | N/A: provider timeout is B15's | N/A | **C** CMD053 row cells (existing, unchanged: settle writes no release) | **C** same | **C** same | N/A: finance service | **C** S08 (E: applied counts as settled) |
| M10 release INSERT (direct) | N/A: serialized under R's subject by construction (Y12) | N/A | N/A | N/A: single INSERT | N/A | **C** T22 (a second release beyond live refused) | N/A | N/A: single INSERT, guard T22 |

Rule-11 writer pairs on one R (O offset, H hold, D decrease, C close, K correction, S CMD053 FAILED, I N's increase, U B12 uphold):
O-O T11/T12, O-H T13, O-D T19, O-C S09, O-K S15, O-S S13, H-H Y12, H-D Y11, H-C S10, H-K S12, D-C S11, D-K S16, K-I S14,
C-I S17, S-H N/A (CMD053 opens the PAYOUT_FAILED hold itself, in its own COMMIT), U-* Y05/Y06 + B12 (M8). I-O T23 (an offset FROM N and
N's INCREASE serialize on N's row: the capture's FOR UPDATE against the offset's KEY SHARE).

## 8. Migration plan (provisional number; never edit 0030)

Replace `0045_offset_capacity_holds.sql` with `0045_offset_claims_yield.sql` (the merge train renumbers; next free on main is 0045):
1. `kauro.new_uuid_v7()` (gen_random_uuid with the millisecond prefix; passes `kauro.is_uuid_v7`).
2. `kauro.commission_offset_releases` (release_id v7 PK, offset_id, seller_id, amount_cents money > 0, cause token CHECK of the five,
   released_at server instant, created_at; FK (offset_id, seller_id) to commission_offsets); append-only (`forbid_change` UPDATE, DELETE,
   TRUNCATE), `require_server_instant('released_at')`, guard `commission_offset_releases_within_live`; RLS FORCE: owner read, seller read
   own, owner INSERT (a hold opened by the owner writes its release), `kauro_commission` ALL; no DELETE grant.
3. `kauro.commission_offsets_yield(p_line uuid, p_cause text) RETURNS bigint`: takes p_line's subject, releases claims(p_line) - cap(p_line)
   newest first; `kauro.commission_offsets_yield_position(p_negative uuid) RETURNS bigint` (model 5; called only by close and correction,
   which hold every line involved). EXECUTE to kauro_commission and kauro_app.
4. `kauro.commission_offsets_authorized()` re-issued: 0045's locks and predicates with live amounts and pos(N) = P + claims(N) - E.
5. Triggers: `commission_holds_offsets_yield` AFTER INSERT WHEN OPEN (yields only if the line is unapplied);
   `commission_lines_offsets_yield` AFTER UPDATE OF cumulative_entitlement_cents, state (unapplied NEW.state only).
   No `commission_holds_offset_room` (0045's refusal is gone). Idempotent (CREATE OR REPLACE, IF NOT EXISTS, DROP TRIGGER IF EXISTS).
Code: `lockPoolsOfCapture` one ascending statement; `applyBasisChange` fences; ports `yieldOffsets(lineIds, cause)`,
`fenceLines(lineIds)`; `PeriodLedgerRows.offsetReleases?` (optional: existing row builders compile); composer per model 7.

## 9. Caveats and decisions (each is a cell or a decision; none left to the reviewer)

- OFF-C1 (decision, D10-NEG-4 model 3): holds first. Authority: 17 "Approved undisputed payable amounts are scheduled" + R2-102; an
  offset pays a debt with the commission, so a disputed or held cent cannot pay it. Cells T13, T14, Y03, S03.
- OFF-C2 (decision, authority silent): release order newest first; a release is final. Cells Y04, Y07.
- OFF-C3 (decision, refinement of the coordinator direction): applied claims never release; they count as settled (model 4). Reason:
  releasing an applied claim double counts when the issued item's payout settles as issued (§6; D10-GAP-8). Cells Y08, P03, S08, T17.
- OFF-C4 (decision, refinement): N's shrinking position yields lazily at close/correction, under the receiving line's lock, so every
  release of an offset serializes on one subject (no offset-row lock level, no new deadlock class). Cells S05, S14; why-5 is not oracle.
- OFF-C5 (GAP, tier 1, authority silent, owner: coordinator): no production writer of offsets (`recordOffset` latent): whether the close
  applies SIGNED_FUTURE_OFFSET terms automatically or an owner command does; its idempotency key (M1 RETRY); offsets are not inputs of
  KAURO_COMMISSION_CUTOFF_V1, so the writer must run inside the close or before the proposal. R2-104 stays EXECUTED_LOCAL on its
  recovery-item path; the offset path is evidence through the commission service's direct insert until then.
- OFF-C6 (decision): releases are outside the cutoff hash; each is caused by a hashed change (hold, adjustment, line state) or by the
  close itself in its own COMMIT. Cell S05.
- OFF-C7 (GAP, tier 1, preexisting, owner: B10 statements): an all-offset statement has payable 0, CMD052 refuses NOTHING_PAYABLE and its
  lines stay PAYABLE forever. This lane makes the debt visible (model 7, P04); the settlement of a zero-payable statement is not built.
- NEW-1 (GAP, tier 1 rights, preexisting, owner: B10 statements): an INCREASE above what a PAID/ADJUSTED line was paid (largest
  remainder, r3 R3-01) is never paid by composeStatement (position <= 0: nothing itemized); applied claims beyond a shrunken pos(N) are the
  same seller credit. 17 "Compensation adjustment follows the economic reversal". Not offset-specific; route to the coordinator.
- X-B12-1 (cross-package rule, B12): UPHELD and its AGREED_ERROR_CORRECTION in one transaction, line rows then subjects first (section 5).
  Out of order is churn, not loss (Y06), so the rule is consistency (INV-S-09) and deadlock-freedom, not the money guard.
