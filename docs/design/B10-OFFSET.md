# B10-OFFSET: offsets are claims that yield; seller credit and noncash settlement are durable (design r11, D10-NEG-4..7)

Lane `B10-OFFSET` (branch `b10/offset`, builds after kit PR1 merges). r1 = 97839bd; r2 answers Codex design review r1
(`tools/review/out/b10-offset-design-97839bdc0b32`, REJECT, OFF-R1..R8); r3 answers design r2 on 18ca05b
(`tools/review/out/b10-offset-design-r2-18ca05bdf51e`, REJECT: OFF-R1..R3, R5, R7, R8 FIXED; OFF-R4, OFF-R6 PARTIAL; OFF-R2-01..04 new); r4 answers design r3 on af1ff58
(`tools/review/out/b10-offset-design-r3-af1ff58c9899`, REJECT, converging: r2 defects and release guards FIXED; OFF-R3-01, OFF-R3-02 new; OFF-R6 PARTIAL); r5 answers the internal design-closure adversary on 744dd25
(`.kauro/reviews/b05-r3-offset-r4-design-adversary.md`, NOT_READY: ADV-OFF-1 MAJOR, ADV-OFF-2..4 MINOR; §0.1); r6 answers Codex design r4 on e7b8a92
(`tools/review/out/b10-offset-design-r4-e7b8a92e657b`, REJECT: OFF-R1..R8 and ADV-OFF-1..4 FIXED; OFF-R4-01, OFF-R4-02 MAJOR, OFF-R4-03, OFF-R4-04 MINOR new; §0.2); r7 answers Codex design r5 on 2a64de6
(`tools/review/out/b10-offset-design-r5-2a64de6*`, REJECT: OFF-R4-02, OFF-R4-03 FIXED; OFF-R4-01, OFF-R4-04 PARTIAL; OFF-R5-01 new; §0.3); r8 answers the internal adversary on e3da3e7 (`.kauro/reviews/b10-offset-e3da3e7-design-adversary.md`, FAIL: ADV-1 BLOCKING, ADV-2..4 MAJOR, ADV-5 MINOR) and Codex r5's open OFF-R4-01, OFF-R5-01 (§0.4); r9 answers the internal adversary on 04f271c (`.kauro/reviews/b10-offset-04f271c-design-adversary.md`, PASS: ADV-1, ADV-2 MINOR) and renumbers the lock-order code KC021 -> KC027 (§0.5); r10 answers the internal adversary on a431f8f (`.kauro/reviews/b10-offset-a431f8f-design-adversary.md`, PASS: ADV-1..5 MINOR) and hands the code check to lane B10 6c's KC registry (§0.6); r11 answers the internal adversary on e464047 (`.kauro/reviews/b10-offset-e464047-design-adversary.md`, PASS: ADV-1..4 MINOR) (§0.7). **Dependency (r11): OFFSET's build does not merge until lane B10 6c's `tools/test/kc-codes.test.mjs` (with `docs/design/KC-CODES.md`) is on main** (the only required check of KC022/KC027; §8 Deferred; the board carries it machine-readably). Supersedes D10-NEG-3 and the provisional
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
| rule 17 (lock-set family, third round) | added to FAILURE-MATRIX-TEMPLATE.md; §5.1 sweeps every guarded aggregate: offsets, releases, credit entries, CREDIT items, noncash settlements, cutoff |

### 0.1 Revision r5: adversary findings (internal adversary on 744dd25)

| finding | closed in (section) | tests (exact titles in §6) |
|---|---|---|
| ADV-OFF-1 MAJOR multi-row lock order (credit entries, offsets, releases, CREDIT items, multi-statement sweeps) | §5 G-ORD-1 :235 (one blocking acquisition per transaction, then pre-locked or non-blocking; refusal `COMMISSION_LOCK_ORDER`); §5 noncash sweep :266; §5.1 :280; §7 M15 :490; §8 :519; §9 OFF-C9 :551 | T31, T32, T33, Y26, C19, C20, C21, S70, S71, S72 |
| ADV-OFF-2 MINOR FK audit incomplete | §4 FK audit :194: all FKs of the five guarded INSERTs with their parent's lock position (offsets -> seller_agreements 0030:245; statement_items -> adjustment, hold, offset, project 0031:203-206) | S74 (projects) and, since r6, S76 (agencies): the two parents with an explicit FOR UPDATE holder; the others are proofs (append-only or no FOR UPDATE holder) |
| ADV-OFF-3 MINOR S60/S61 inconsistent | §2.8 :140 (the proposal's read position named); S61 retitled :417 | S60, S61 |
| ADV-OFF-4 MINOR noncash guard shared subjects | §4 noncash guard :189 takes **exclusive** subjects; §5 noncash sweep :266; §5.1 | S73 |

### 0.2 Revision r6: Codex design r4 findings (e7b8a92)

| finding | closed in (section) | tests (exact titles in §6) |
|---|---|---|
| OFF-R4-01 MAJOR M15 RETRY claimed without a refusal or a recovery | §5 G-ORD-2 (KC027 is a transient refusal with one contract: complete rollback, bounded in-transaction retry by the unit of work, then a retryable CAPACITY_UNAVAILABLE / LOCK_ORDER_CONTENTION answered per caller family: API command, outbox consumer, PERIODS); §7 M15 RETRY now cites K00-K10; §8 sqlstate + unit-of-work rows | K00-K10 (F7: one per affected caller, each with an actual KC027, full rollback incl. the journal reservation, recovery after contention ends, exactly one economic result) |
| OFF-R4-02 MAJOR C20 unreachable (ISSUED statement refuses the first item KA004) | C20 retitled onto the issuance lifecycle: items into a DRAFT statement before its DRAFT -> ISSUED edge (commercial-statements.ts:780/816) | C20 |
| OFF-R4-03 MINOR session-settable flag | §5 G-ORD-1: the custom setting `kauro.commission_lines_locked` is removed; "this transaction holds a B10 lock" is a transaction-scoped shared advisory marker read from pg_locks; an xact advisory lock has no explicit unlock, so no SET, local reset or session value can turn a later acquisition blocking; a session-level marker only makes a first acquisition non-blocking (more KC027, never a wait) | S75 |
| OFF-R4-04 MINOR FK census misses agencies and sellers | §4 FK audit: statement_items.agency_id -> agencies (0031:184; FOR UPDATE by `agencies.lock`, tenancy.ts:192, callers CMD002 activate-agency.ts:50 and CMD043 close-agency.ts:69, which take no commission row, subject or statement and whose triggers touch no commission table) and commission_offsets.seller_id / commission_statements.seller_id -> sellers (0030:235, 0031:121; only FOR NO KEY UPDATE, commercial-sales.ts:369, never conflicts with KEY SHARE); OFF-C10 corrected: two parents have an explicit FOR UPDATE holder, projects and agencies, and neither holder takes a B10 lock | S74, S76 |

### 0.3 Revision r7: Codex design r5 findings (2a64de6) (its K01, K08 and single-line (d) argument are superseded by §0.4)

| finding | closed in (section) | tests |
|---|---|---|
| OFF-R4-01 PARTIAL hold paths grouped under redelivery | §5 G-ORD-2 (c) now names each caller by its real invocation boundary: funds-hold release is the ELIGIBILITY sweep item (sweeps.ts:197, failure reported and left for the next pass, sweeps.ts:48-53), not an outbox delivery; hold opening is the funds-observation consumer (K07) or an owner command (API family). (d) single-line paths: `take_commission_line_subject` takes the line's row FOR KEY SHARE before the subject (re-entrant when held), so every subject holder holds the row; a single-line writer whose first acquisition is the line row FOR UPDATE therefore waits there (its one allowed wait) and its later subject is re-entrant or free: KC027 is unreachable on that path. K08 split: K08 proves the wait (no KC027, one release); K08b proves the sweep recovery with the KC027 injected at the subject call by the kit fault harness (the only way to reach a refusal the lock order makes unreachable) | K08, K08b |
| OFF-R5-01 MAJOR K01 unreachable (CMD052 holds the global payout-cash lock) | K01/K02 holder is no longer a CMD052: a second session calls the production `kauro.take_commission_line_subject(L5, exclusive)` (row KEY SHARE + exclusive subject, no cash lock), so the approval takes its cash lock, statement and line rows (KEY SHARE vs KEY SHARE: granted), its L2 subject, and is refused KC027 at L5's shared subject; the holder commits only after the observation | K01, K02 |
| OFF-R4-04 PARTIAL lockShared described as FOR SHARE; §0.1 "only projects" | §4: `lockShared` is `awaitTransition` + a plain SELECT (tenancy.ts:200-203), no row lock; §0.1 row corrected (projects and agencies) | S76 |

### 0.4 Revision r8: internal adversary on e3da3e7 (FAIL) and Codex r5's open findings (2a64de6)

Authority for every ruling below, first: 08 "Database isolation": "SECURITY DEFINER functions require a specific justification, fixed
search_path, minimal owner privileges and no public execute grant. [...] Every such function receives dedicated isolation tests."; 07
"Transaction discipline": "Multi-row invariants use explicit locking or bounded serializable retries. The implementation documents why the
chosen isolation prevents the relevant interleaving". Census of the code they apply to: §5.3 (measured on e3da3e7, file:line).

| finding | closed in (section) | cells (§6) |
|---|---|---|
| ADV-1 BLOCKING the r7 row KEY SHARE cannot run as kauro_app (SELECT only 0030:634; FOR SELECT policies under FORCE RLS 0030:602-604) | §5 G-ORD-1 (vi): lock-only path `GRANT UPDATE (created_at)` (immutable, 0030:263-264) + policy `commission_lines_owner_lock` FOR UPDATE TO kauro_app USING (acting_corporate_owner()) WITH CHECK (false); the lock functions compare the rows locked with the set and raise KC022 NOT_FOUND on any difference (RLS filters before the lock: no lock, no wait, no probe); SECURITY DEFINER evaluated and rejected (§9 OFF-C11); §4 Grants; §8 | S77; K01 (CMD052 as kauro_app) |
| ADV-2 MAJOR KC027 unreachable for FOR UPDATE pre-lockers | §5 G-ORD-1 (i)-(iii): a FOR UPDATE caller takes rows in its first call and its subjects non-blocking after; every protocol holder of a subject holds the row, so it is a row wait; KC027 only from protocol-external contention (a bare subject key, no row); §5.2 traces | RACE K03, K03s, K04, K05, K06, K07, K08, K08c, K08d, K09; recovery K03r, K03sr, K04r, K05r, K06r, K07r, K08b, K08cr, K08dr, K09r |
| ADV-3 MAJOR K08 unproducible; `releaseFundsHold` hold row first; K08b fault cannot fire | §5 lock sets, §8 Code: `releaseFundsHold` (the only `resolveHold` caller, ledger-effects.ts:381-383) takes the line row FOR UPDATE, then the subject, then `resolveHold` (hold row, level 3); K08 on a HELD line (FUNDS_HELD, funds AVAILABLE): zero credit; K08b uses a bare-key holder (the harness raises only KT001 trigger faults, fault-support.ts:174-208); credit on RELEASED of a PAID line is B12's (§9 X-B12-2) | K08, K08b |
| ADV-4 MAJOR caller sweep partial | §5 G-ORD-2 (c): every production caller by boundary (API commands, outbox, the three ELIGIBILITY items, PERIODS close and noncash); (d) B12's owner hold commands and the OQ-1 offset writer (`recordOffset` commercial-ledger.ts:701) are later-package obligations, not covered callers | K08c, K08cr (sweeps.ts:200-207), K08d, K08dr (sweeps.ts:210-223) |
| ADV-5 MINOR first call, K01 order, retry determinism, loops | §5 G-ORD-1 (i), (iv), (v): blocking only inside the first lock call; for a KEY SHARE caller that call includes the subjects (the 0036:10-12 wait is kept); in-product loops replaced by one set call; K01 order statement (approve-payout.ts:68; :67 only builds the repository) then cash (:83); G-ORD-2 (a): hold point `LOCK_ORDER_RETRY` and an injected sleeper in the retry loop (unit-of-work.ts:391-397) | K00, K01, K02, S78 |
| OFF-R4-01 PARTIAL (Codex r5) | as ADV-2..4: no recovery through a nonexistent hold delivery (consumer.ts:72-100 has none); contention placed on an acquisition that can refuse | the recovery cells above |
| OFF-R5-01 MAJOR (Codex r5) K01 behind payout-cash | the holder takes no cash lock; CMD052 takes statement, cash, its rows (KEY SHARE beside the holder's) and waits at L5's subject inside its first call; KC027 is unreachable for CMD052 by construction, so K01/K02 are RACE wait cells and the retry cell is K00 | K01, K02, K00 |
| own, rule 13 sweep: CMD053 line pre-lock vs payout-cash | §5 lock sets: CMD053 pre-locks lines only after `transitionIntent` took payout-cash (commercial-statements.ts:939); lines first would deadlock with CMD052 (cash :83, then lines :89) on a shared CREDIT line | S79 |
| own, rule 15 sweep: hold opening judges funds before its lock | §5.3, §8 Code: the hold-opening item re-reads state, due (an instant read after the lock), latest funds and covering hold under the row lock, as the eligibility item does (sweeps.ts:214-219) | S80 |

Counts: F4 76 -> 80 (S77-S80), F7 12 -> 24; total 185 -> 201.

### 0.5 Revision r9: internal adversary on 04f271c (PASS, 2 MINOR) and the KC027 renumber

Authority first. 07 "Transaction discipline": "Multi-row invariants use explicit locking or bounded serializable retries. The
implementation documents why the chosen isolation prevents the relevant interleaving" (ADV-2: which lines the close's and the
correction's one call covers). 17 "Accrual, eligibility and payout": "The monthly statement closes on the fifth business day after
month-end in America/Bogota. Approved undisputed payable amounts are scheduled by the tenth business day" (OFF-C12: a correction itemizes
credit only of its own lines; the next monthly close itemizes the rest). The renumber has no R2 ruling: it is the builder's code-claim
rule (one meaning per code, nothing renumbered at merge). Predicates and census below are input-only and measured on main 843bf01.

| finding | closed in (section) | cells (§6) |
|---|---|---|
| ADV-1 MINOR S77 vacuous (version not granted: 42501 by privilege) or false (a new created_at: KA004 first) | S77 runs `UPDATE kauro.commission_lines SET created_at = created_at WHERE line_id = L` as the acting owner (kauro_app): column privilege granted (0045), USING passes, every BEFORE UPDATE trigger passes (0030:261 touch; :262 version: only the exempt updated_at changed, 0001:131-147; :263-264 immutable: unchanged; :265 learned_once; :429 paid only by payout), the OF-state triggers do not fire, then WITH CHECK (false) raises 42501. Red when WITH CHECK (false) is replaced by true or omitted (an UPDATE policy without WITH CHECK uses its USING): the UPDATE commits and updated_at advances; §5.2 | S77 |
| ADV-2 MINOR the close's one call vs CREDIT-candidate lines and re-proposal lines | §5 G-ORD-1 (v) r9 paragraph and lock sets: (a) close: the one call takes every line of the :147 read; `periodInputs` selects every line created before the cutoff with no state, period or seller filter (commercial-statements.ts:501), so every CREDIT candidate (a settled line, composed by an earlier close) is in it; (b) correction: CREDIT items only for lines of its composition (correct-statement.ts:104 `lines` ⊆ `named` :87, which holds every item's line, :86), all in the one call (:89-91); (c) re-proposal (:149): the comparison (:151-155) precedes every later lock call (`fenceLines` and every guarded INSERT run over the locked set); a line first visible at :149 changes the hash (`commissionCutoffHash` hashes every line, domain statements.ts:86-93) and the close refuses STALE_VERSION LEDGER_CHANGED before any lock on it; on a match the :149 set equals the locked set | RACE K09c, K04c; K09n |
| own (code claim, 10-10 rule): KC021 is lane B10 6c's (`CLAIM_EXPIRED`, pw-b10-6c sqlstate.ts:72, :157; 0048:109) | the lock-order code is KC027 `COMMISSION_LOCK_ORDER` everywhere (§5, §6, §7, §8); KC022 `COMMISSION_LINE_NOT_FOUND` stays OFFSET's; claims and grep evidence §9 OFF-C13 | CK01 |

Counts: F7 24 -> 27 (K04c, K09c, K09n), F8 new 1 (CK01); total 201 -> 205.

### 0.6 Revision r10: internal adversary on a431f8f (PASS, 5 MINOR) and the KC registry

Authority: as §0.5 (07 "Transaction discipline"; 17 "Accrual, eligibility and payout"). All file:line below are measured on the branch
base 843bf01 (r9 cited sweeps.ts from origin/main 5e732e8, where ACCRUAL moved to :120-145; corrected here).

| finding | closed in (section) | cells (§6) |
|---|---|---|
| ADV-1 MINOR K09n clock claim false; cell nondeterministic | §5.3 r10 clock bullet: the close's cutoff is `now` = `serverNow` (routes.ts:76 -> ledger-effects.ts:47-50, `uow.serverInstant()` cut to milliseconds; unit-of-work.ts:344 -> source/rows.ts:30-37, `kauro.server_now()` = transaction_timestamp(), 0009:42-44; under the test clock plus the offset, temporary-postgres.ts:111-113, :127), not `effect_now`; a production line's created_at is now() of its transaction (commercial-ledger.ts:450). K09n (and K09m) pin W's created_at to W's own `kauro.server_now() - interval '1 second'` in a transaction opened before the close's, and assert created_at < the cutoff the hold point reports before going on | K09n, K09m |
| ADV-2 MINOR ACCRUAL citations | the ACCRUAL item is sweeps.ts:120-129 (agency subject :123, instant and `accruePurchase` :126); its INSERT is reached through `accruePool` (ledger-effects.ts:225, :251) -> commercial-ledger.ts:446-450; ledger-effects.ts:207 is the definition. Fixed in §5 G-ORD-1 (v), §5.3, §9 X-ACC-1 | none (text) |
| ADV-3 MINOR KC registry and raise tokens | CK01 dropped. The one code check is lane B10 6c's `docs/design/KC-CODES.md` + `tools/test/kc-codes.test.mjs` (6c ae9c546 6c-r2-plan.md:97-104), which reserves KC022 and KC027 for OFFSET. Final message prefixes: `COMMISSION_LINE_NOT_FOUND:` (KC022) and `COMMISSION_LOCK_ORDER:` (KC027), equal to the SQLSTATE names; "provisional" and the lowercase names are gone. OFFSET's build flips its two rows RESERVED -> RAISED in the commit that adds the raises; it is DEFERRED behind 6c's merge (§8 Deferred, §9 OFF-C13) | none here (6c's test) |
| ADV-4 MINOR CMD053 CREDIT line and correction re-discovery unproven | K03c: CMD053 FAILED with a CREDIT item of R under HK(R) waits at R's row in its one call; S54 extended: the new source's subject held, refusal before any lock on it, zero LOCK_ORDER_RETRY passes; §5.2 | K03c, S54 |
| ADV-5 MINOR X-ACC-1 branch (ii) without a cell | K09m: a line committed during the close's BEFORE_COMMIT hold (service.ts:110) is absent from the close and itemized once, ACCRUED_PENDING, by the next period's close | K09m |

Counts: F7 27 -> 29 (K03c, K09m), F8 removed (CK01 -> 6c's kc-codes.test.mjs); total 205 -> 206.

### 0.7 Revision r11: internal adversary on e464047 (PASS, 4 MINOR)

| finding | closed in (section) | cells (§6) |
|---|---|---|
| ADV-1 MINOR K09n/K09m determinism argued from a false "same cluster offset" | W's created_at is pinned to M.ends_at - 1 s (M = the period being closed), an explicit column value of W's INSERT. Real reason it is below the cutoff in every clock world: the close of M runs only once M has ended on the server clock (PERIODS lists ended OPEN periods, commission-service-access.ts:141-145) and CMD051 refuses before its close date (close-period.ts:135), so cutoff >= M.ends_at > created_at by at least 1 s whatever offset the close's unit stands at. World: `statementsWorld` (statements-support.ts:139), the close's units through `StandingUnits` (:53-59), which may stand behind real time (a past month); W's connection sets no clock (it needs none). The worlds whose helpers set an offset without `greatest(0, ...)` (commission-support.ts:252, :590) are not used by these cells and no longer matter; the hold-point precondition stays as a setup assertion; §5.2, §5.3, §6 | K09n, K09m |
| ADV-2 MINOR K09m red claim depended on fixture dates | with created_at in M (ends_at - 1 s), both mutations go red: a calendar window (created_at within the closing period) excludes it from M+1's close, and a window after the previous close's cutoff excludes it as well (created_at < M's cutoff); §5.2, §9 X-ACC-1 | K09m |
| ADV-3 MINOR merge-order dependency only in prose | header dependency line (above); §8 Deferred unchanged (RESERVED -> RAISED flip in the build packet; KC027 token COMMISSION_LOCK_ORDER, §9 OFF-C13); the board dependency is the coordinator's | none (6c's test) |
| ADV-4 MINOR SET_DISCOVERED in the shared `supersedeStatement`; K03c cite | `supersedeStatement` (correct-statement.ts:75) gains the caller's command (`"CMD051"` from the correction entry, correct-statement.ts:46; `"CMD053"` from reconcile-payout.ts:151) and reports `SET_DISCOVERED` with it; S54 acts only on (CMD051, SET_DISCOVERED) and passes every other report through. `LINES_LOCKED` fires only in the close's body (close-period.ts, after the one call); K09n acts on (CMD051, LINES_LOCKED), K09m on (CMD051, BEFORE_COMMIT) in runs where no correction executes. K03c: the HELD loop is reconcile-payout.ts:143-147 (ISSUED again :141, `supersedeStatement` :151); §8, §5.2 | S54, K03c |

Counts unchanged: 206.

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
  - agencies (statement_items.agency_id, 0031:184, inline REFERENCES; r6, OFF-R4-04): explicit FOR UPDATE by `agencies.lock`
    (tenancy.ts:192), called only by CMD002 activate-agency.ts:50 and CMD043 close-agency.ts:69 (every other agency reader uses
    `lockShared`: `awaitTransition` then a plain SELECT, tenancy.ts:200-203, no row lock, so no FK wait). Neither unit takes a commission row, subject or statement: their
    repository (commercial-agency-lifecycle.ts) touches no commission table and no trigger on agencies, quotes, founding slots, closures or
    acceptances writes one. An item insert may wait at the agency row; its holder waits on nothing B10 holds: no cycle (S76).
  - sellers (commission_offsets.seller_id 0030:235 and commission_statements.seller_id 0031:121, inline REFERENCES): no FOR UPDATE in src
    or migrations; the only explicit lock is FOR NO KEY UPDATE (commercial-sales.ts:369), which does not conflict with KEY SHARE; no
    DELETE path: never waits.
  Census method (r6): every `REFERENCES` in the CREATE TABLE bodies of the guarded tables (0030, 0031, 0045, 0046), both
  `CONSTRAINT ... FOREIGN KEY` clauses and inline column references, each listed above.
- Grants: INSERT on releases and credit entries to `kauro_commission` (and, for B12's owner hold commands, X-B12-1, to the owner on
  `kauro_app` only for cause HOLD_OPENED / HOLD_CHANGED, the triggers of an owner-opened hold; no caller today, §5 G-ORD-2 (d)); the two
  lock functions are SECURITY INVOKER, REVOKE ALL FROM PUBLIC, EXECUTE to both; kauro_app's lock-only path (r8, ADV-1): `UPDATE (created_at)`
  on commission_lines and policy `commission_lines_owner_lock` FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK
  (false) (§5 G-ORD-1 (vi), §9 OFF-C11); every path passes the guards above.

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

Global order after §10's prefix (... period, statement, payout-cash advisory lock sql.ts:123-124, payout intent): **(1) line rows, ascending** (FOR UPDATE by line writers; FOR
KEY SHARE by an offset insert, and by a hold insert through its FK) **(2) line subjects, ascending** (exclusive; shared for CMD052)
**(3) hold rows (4) offset releases, credit entries, noncash settlements**: every write in (4) is made under the subject of the line it
concerns (a release under its receiving line's, a credit entry under its line's), taken by the writer or by the INSERT guard. No
transaction waits for a row or subject of (1)/(2) outside its first B10 lock call (G-ORD-1, r8). Each writer computes its complete set first.

**G-ORD-1 (r5, ADV-OFF-1; r8, ADV-1, ADV-2, ADV-5): a transaction blocks only inside its first B10 lock call; every later call is
re-entrant or non-blocking.** A per-row BEFORE guard cannot order rows across a multi-row INSERT, several guarded INSERTs or a
multi-statement sweep in one transaction. Every B10 line row lock and line subject is taken through two SECURITY INVOKER functions (0045;
`REVOKE ALL ... FROM PUBLIC`, EXECUTE to kauro_app and kauro_commission): `kauro.commission_lock_line_rows(lines uuid[], row_mode text,
subject_mode text DEFAULT NULL)` and `kauro.take_commission_line_subject(line uuid, subject_mode text)`, which is
`commission_lock_line_rows(ARRAY[line], 'KEY SHARE', subject_mode)` (r7: the row before the subject, so every holder of a line subject holds
that line's row). Each reads the flag ONCE at entry and then takes the marker: "flag on" is `kauro.commission_lines_locked()`, this backend
holds the transaction-scoped shared advisory marker `pg_advisory_xact_lock_shared(<B10 lock-order class>, 0)` (pg_locks: pid =
pg_backend_pid(), locktype advisory, the marker key, granted) (r6, OFF-R4-03; replaces the r5 custom setting). A transaction-level advisory
lock has no explicit unlock (pg_advisory_unlock* releases only session-level locks) and ends only at COMMIT or ROLLBACK, so once any B10
lock is taken no statement can turn the flag off, and no custom setting is read.
- (i) Flag off at entry (the first call): the distinct sorted set's rows in ONE statement (`... WHERE line_id = ANY($1) ORDER BY line_id
  FOR <row_mode>`; LockRows runs above the sort, so rows lock ascending), blocking; then, when `subject_mode` is given, the subjects
  ascending, blocking. KEY SHARE callers pass `subject_mode` (CMD052's `payout_lines_unpayable`, the noncash guard, the four row guards
  of §4, the hold step `commission_holds_lock_order`, a single `take_commission_line_subject`): they wait for a hold or line change in
  flight on ANY line of their set, as 0036:10-12 documents ("A hold in flight is waited for and read") (S55, S56, the CMD052 TIMEOUT cell,
  K01, K02, K10, S78). FOR UPDATE callers (close, correction, CMD053, basis change, funds observation, the three ELIGIBILITY items) pass
  none: their subjects follow in later calls.
- (ii) Flag on at entry (every later call): the same acquisitions non-blocking (`FOR <mode> NOWAIT`, `pg_try_advisory_xact_lock[_shared]`):
  a lock this transaction holds is granted at once (re-entrant; a FOR UPDATE row covers a later KEY SHARE request); one another
  transaction holds refuses `COMMISSION_LOCK_ORDER` (SQLSTATE KC027, SQLSTATE name and message prefix `COMMISSION_LOCK_ORDER:`; KC021 is lane B10 6c's) without waiting (55P03 from NOWAIT is caught and
  re-raised as KC027).
- (iii) Invariant: a line subject is taken only by these functions (census S72, S78), always after the line's row, and both are held to
  COMMIT. After a FOR UPDATE row set is granted, no other transaction holds a KEY SHARE on those rows, hence none holds their subjects: the
  caller's later subject calls are free, and a contended one can only be protocol-external (an advisory key on the line's subject with no
  row lock, which any role can take: `kauro.transition_key` and `pg_advisory_xact_lock` are PUBLIC-executable, 0001:267-269). It is refused
  KC027, not waited for: a wait there is outside the order and could close a cycle. So FOR UPDATE callers wait only at rows against a
  protocol holder (K03-K09: `pg_locks` shows the waiter's ungranted lock as transactionid or tuple, never advisory), and their KC027
  recovery is exercised against a bare-key holder (K03r-K09r, K08b, K08cr, K08dr).
- (iv) No cycle: a transaction blocks only in its first call, whose acquisitions follow one total order (rows ascending, then subjects
  ascending), after its prefix (§10: period, statement, payout-cash, payout intent). The holder of an awaited object took it in its own
  first call, in the same order, or re-entrantly; after its first call it never waits for a line row or subject; after a line lock it
  requests a prefix lock only re-entrantly (its own statement, the cash it holds) or as a new-row INSERT that waits on no B10 holder
  (CMD052's intent :97 under its own statement row; the close's and the correction's new statements and items, whose FK parents' FOR
  UPDATE holders, projects S74 and agencies S76, take no B10 lock). A wait-for chain therefore strictly ascends the order and cannot close.
- (v) In product code a loop of single-line calls is forbidden: the first call would block on its first line only, and every other line
  would refuse KC027 under ordinary contention instead of the documented wait. Every in-product multi-line caller passes its complete set
  to ONE call: `payout_lines_unpayable` (PAYABLE and CREDIT lines, KEY SHARE + SHARE), the close (close-period.ts:148 loop), the
  correction (correct-statement.ts:89-91 loop), CMD053 (reconcile-payout.ts:134, :144 become re-entrant), `lockPoolsOfCapture` (the
  per-pool loop commercial-ledger.ts:485-487 becomes one call over the capture's lines), the noncash guard. Census S78. A direct
  multi-row INSERT (kauro_commission only) keeps the fail-closed per-row behaviour: first row blocking, later rows KC027 (C19, C20, C21,
  T31-T33, S70).
  r9 (ADV-2): which lines the one call covers, verified on main. Close: the call takes every line of the :147 read, and
  `periodInputs` (commercial-statements.ts:496-501) selects every line created before the cutoff whatever its state, period or seller;
  a line carrying seller credit (case J, S18) is settled, so an earlier close composed it and it is in that set: its CREDIT item guard
  (statement row KEY SHARE, then [L] KEY SHARE + EXCLUSIVE) is re-entrant on the close's FOR UPDATE row and subject (K09c). Correction:
  `named` (correct-statement.ts:85-87) holds the predecessor's lines, every item's line (:86, CREDIT items included) and its input lines;
  the composition reads only `lines` ⊆ `named` (:104) and the correction itemizes CREDIT only for those (OFF-C12), so every CREDIT
  guard call is re-entrant on the one call (:89-91 replaced) (K04c). Re-proposal: no lock is taken on a line that first appears at :149.
  The comparison (:151-155) precedes `fenceLines` and every guarded INSERT, which run over the locked set; a new line changes the hash
  (`commissionCutoffHash` hashes every line, domain statements.ts:86-93) and the close refuses STALE_VERSION LEDGER_CHANGED (PERIODS:
  item `REFUSED LEDGER_CHANGED`, periods.ts:75; the next tick re-proposes). On a match the sets are equal: the request's proposal was
  read before CMD051 began (periods.ts:61-65), lines are never deleted (0030:271) and created_at never changes (0030:263-264), so the
  proposal's lines ⊆ :147's ⊆ :149's, and equal hashes make :149's equal to the proposal's (K09n). Production reaches the window (r10
  cites): the ACCRUAL item (sweeps.ts:120-129) takes only its agency's subject (:123), then `accruePurchase` (:126) inserts its pool and
  lines through `accruePool` (ledger-effects.ts:225, :251; commercial-ledger.ts:446-450, created_at = now(), :450) and takes no period
  lock (only consumer.ts:71 and ledger-effects.ts:275 call `shareOpenPeriods`), so a line of a transaction that began before the close's
  can commit between :147 and :149 with a created_at before the close's cutoff (K09n), or after :149 (K09m; §9 X-ACC-1).
- (vi) Privileges and RLS (r8, ADV-1). kauro_commission: SELECT, INSERT and UPDATE on commission_lines (0030:640-641), policy FOR ALL
  USING (true) (0030:605): its locks are unfiltered. kauro_app (CMD052 in the OPERATOR context; B12's owner hold commands later): SELECT
  only (0030:634) and FOR SELECT policies under FORCE RLS (0030:602-604); a row-locking clause needs UPDATE on one column and the UPDATE
  policy's USING, so r7 raised 42501. 0045 grants the narrowest lock-only path (template rule 17; §9 OFF-C11): `GRANT UPDATE (created_at)
  ON kauro.commission_lines TO kauro_app` (created_at is immutable, 0030:263-264) and `CREATE POLICY commission_lines_owner_lock ON
  kauro.commission_lines FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (false)`: the acting owner can lock the
  lines it reads and update none (WITH CHECK false; column immutable); a seller or agency session locks none. RLS filters a row before
  LockRows, so a line the invoker cannot lock is neither locked nor waited for; the functions compare the rows locked with the distinct set
  and raise KC022 (message prefix `COMMISSION_LINE_NOT_FOUND:`; NOT_FOUND) on any difference, the same answer for an invisible and a
  nonexistent id (no probe) (S77). No SECURITY DEFINER.
The 0036 hold fence (`take_commission_line_lock`), the line state fence (`commission_lines_line_fence`), `fenceLinesOfCapture`
(commercial-ledger.ts:492-495) and `payout_lines_unpayable` are re-issued over the two functions; holds get a BEFORE INSERT step
`commission_holds_lock_order` (`take_commission_line_subject`, so the FK KEY SHARE that follows is re-entrant; Y26 reversed order: S72).
A line UPDATE takes its row implicitly, so only the writers listed below update lines, each after its row set. The five guards (offsets,
releases, credit entries, CREDIT items, noncash settlements) call the functions with their prefix (statement row KEY SHARE; the noncash
statement FOR UPDATE) taken first: first call -> blocking as r4 (T30, C14, C15, S59); later -> non-blocking. Census (S72, S78): a pg_proc
scan of live function bodies and a src grep find no commission line row lock or line subject outside the two functions. The only
forgeable input is a session-level marker taken before the transaction: it makes the first call non-blocking (more KC027, then G-ORD-2),
never a later one blocking; SET, SET LOCAL and set_config change nothing (S75). Direct INSERT is granted to kauro_commission only (§4).

**G-ORD-2 (r6, OFF-R4-01; r8, ADV-2, ADV-4, ADV-5): KC027 outcome and recovery by the caller's real boundary.** KC027 is raised only
before any wait, by a lock function (directly, from a guard, the hold step or a re-issued fence), and aborts the whole transaction: every
write of the attempt rolls back, including the command journal reservation, outbox rows, a reconciliation row and the marker. (a) Unit of
work (`unit-of-work.ts`): `transientSqlState` (:305-308) adds KC027 with its own budget `LOCK_ORDER_RETRIES = 3` at every isolation level,
independent of `maxRetries` (:388; READ_COMMITTED keeps 0 retries for 40001/40P01). Between attempts, after the failed attempt's ROLLBACK
and the connection's release, the loop (:391-397) awaits `deps.lockOrderHold?.("LOCK_ORDER_RETRY", { attempt, correlationId })` (a named
hold point, tests only, as `CommissionHold` assembly.ts:19-21) and then a jittered 5-40 ms backoff through `deps.sleep` (default
setTimeout; jitter from `deps.random`). The r6 "backoff on the injected clock" is withdrawn (a controlled clock never advances in a cell).
Cells count attempts and release holders at the hold point, never by sleeping: every K cell is deterministic. The work function re-runs
whole with the same logical identity; `now` is read inside the unit on each attempt (runtime.ts:306, service.ts:108). (b) Exhausted:
`sqlstate.ts` MAP `KC027: { code: "CAPACITY_UNAVAILABLE", reason: "LOCK_ORDER_CONTENTION", retryable: true }` (as 55P03 today), never
INTERNAL_ERROR; `KC022: { code: "NOT_FOUND", reason: "COMMISSION_LINE_NOT_FOUND" }`. (c) Production callers by boundary (ADV-4), each
with its RACE wait cell and, where KC027 is reachable, its recovery cell:
- API commands (journal reservation inside the unit, service.ts:101, runtime.ts:298; a retryable failure leaves no journal row and the
  client's retry with the same key executes once): CMD052 (approve-payout.ts:89; KEY SHARE first call, KC027 unreachable: K01, K02, the
  existing CMD052 TIMEOUT cell); CMD053 FAILED/RETURNED (K03, K03r) and SETTLED (K03s, K03sr); the correction (correct-statement.ts:53;
  K04, K04r).
- Outbox consumer (consumer.ts:66-93; a retryable failure settles the delivery FAILED with retryAt, dispatcher.ts:101; DEAD_LETTER only
  after MAX_DELIVERY_ATTEMPTS; the redelivery applies once, inbox dedup): refund (K05, K05r), reversal (K06, K06r), funds observation with
  the holds it opens (K07, K07r).
- ELIGIBILITY sweep items (sweeps.ts:48-53: the item reports `FAILED <code>` and the next pass redoes it; there is no hold delivery,
  consumer.ts:72-100): funds-hold release (sweeps.ts:196-198; K08, K08b), hold opening on held funds (sweeps.ts:200-207; K08c, K08cr),
  eligibility (sweeps.ts:210-223; K08d, K08dr).
- PERIODS (periods.ts:59-75): the close through CMD051 as the commission service (exhausted: item `REFUSED LOCK_ORDER_CONTENTION`, the
  period OPEN; the next tick closes once under `periodCloseKey`: K09, K09r); the noncash step, one statement per unit (KEY SHARE first
  call in its guard, KC027 unreachable: K10).
- Direct guarded INSERT by a kauro_commission session (no product caller): first row waits, later rows fail closed (C19, C20, C21,
  T31-T33, S70); the session owns any retry.
(d) Not existing callers (later-package obligations, not coverage): B12's owner dispute-hold open, RELEASED and UPHELD (kauro_app under
0030:617-618; X-B12-1, X-B12-2: the hold step is its first call, so it waits, and its KC027 recovery is B12's API-command cell); the OQ-1
offset writer (`recordOffset`, commercial-ledger.ts:701, no caller today): it passes N and R to one call (KEY SHARE, EXCLUSIVE) before
its INSERT and, as a close-time writer, inherits K09's boundary. Lock sets (§5.2 has each cell's trace with file:line):
- offset insert: the guard's call over N and R (rows KEY SHARE, subjects EXCLUSIVE; first -> blocking), then reads.
- hold insert: `commission_holds_lock_order` (`take_commission_line_subject`; re-entrant after a writer's FOR UPDATE row set), FK KEY
  SHARE (re-entrant), the AFTER fence (re-entrant), yield, credit reconcile. Funds-hold release (r8, ADV-3): `releaseFundsHold` takes
  `commission_lock_line_rows([L], 'UPDATE')`, then `take_commission_line_subject(L, 'EXCLUSIVE')`, then `resolveHold` (hold row, level
  3), never the hold row before the line row. B12 (X-B12-1): UPHELD and its correction in one transaction after the capture's line rows.
- basis change and `observeFunds`: open periods FOR SHARE (consumer.ts:71; ledger-effects.ts:275 re-entrant), the agency's commission
  subject (consumer.ts:50, accrual), pools FOR UPDATE (commercial-ledger.ts:483), the capture's lines in one FOR UPDATE call, then
  `fenceLinesOfCapture` (subjects, non-blocking), then writes (triggers yield and reconcile under subjects already held).
- close: period FOR UPDATE (close-period.ts:127), the :147 read's lines (every line, CREDIT candidates included) in one FOR UPDATE call,
  re-proposal (:149) and the comparison (:151-155, LEDGER_CHANGED before any further lock), then `fenceLines` over the locked set (the
  cutoff, §2.8), yields, applications (§2.5), credit reconcile, compose, CREDIT items (guard re-entrant) (r9: K09c, K09n).
- correction: predecessor FOR UPDATE (correct-statement.ts:53), discovery read -> set = named lines ∪ lines of its CREDIT items ∪ sources
  of live claims against them; one FOR UPDATE call; subjects over that set; re-discover; a set that grew refuses STALE_VERSION LEDGER_CHANGED before any further lock;
  CREDIT items only for lines of the composition (correct-statement.ts:104 ⊆ :87; OFF-C12), each guard re-entrant (r9: K04c).
- CMD052: statement FOR UPDATE (approve-payout.ts:68 -> commercial-statements.ts:828), payout-cash (approve-payout.ts:83 ->
  commercial-statements.ts:880 -> sql.ts:124), then `payout_lines_unpayable` (approve-payout.ts:89): ONE first call over its PAYABLE and
  CREDIT lines (rows KEY SHARE, subjects SHARE, blocking), reads; the intent INSERT (:97 -> commercial-statements.ts:909 own statement
  re-entrant) whose KC018 trigger re-runs the function, all re-entrant.
- CMD053: statement FOR UPDATE (reconcile-payout.ts:103), reconciliation INSERT (:129), `transitionIntent` (:130 ->
  commercial-statements.ts:937 own statement, :939 payout-cash, the intent row), and only then one FOR UPDATE call over FAILED/RETURNED:
  its correction's set ∪ the PAYABLE lines; SETTLED: the PAYABLE LINE and CREDIT lines; subjects; then :132-:151. Never before :130:
  CMD052 takes cash then lines, so lines then cash would deadlock on a shared CREDIT line (S79).
- noncash sweep: one statement per unit; statement FOR UPDATE, the guard's first call (rows KEY SHARE, subjects EXCLUSIVE, blocking),
  fence check, settlement, credit reconcile (ADV-OFF-1, ADV-OFF-4).
- ELIGIBILITY items: hold opening (sweeps.ts:204 -> `transitionLine` commercial-ledger.ts:579, the FOR UPDATE call; S80 re-reads under
  it; `openHold` :585 -> the hold step; line UPDATE :613, its fence re-entrant); eligibility (sweeps.ts:214 `lockLine`, the FOR UPDATE call;
  instant :218; :220 line UPDATE -> `commission_lines_line_fence`, subject non-blocking).

### 5.1 Rule 17 sweep: every guarded aggregate, its lock, its writers, its RACE cells

| aggregate | lock taken before any read of it | writers (incl. direct INSERT grants) | RACE cells (both orders) |
|---|---|---|---|
| offsets (capacity of R, position of N) | N and R rows KEY SHARE, then both subjects (guard trigger: every INSERT path) | offset INSERT (commission service; OQ-1 writer) | T11, T12, T13, T19, T23, Y17, Y18, S09, S15, S45; multi-row T33 |
| releases (live amount of o) | o's receiving line's row KEY SHARE, then its subject (guard trigger) | hold, line and close/correction/CMD053 yields; direct INSERT (commission service) | T24, T30, Y11, Y12, Y20, Y21, S29, S33; multi-row T31, T32, Y26; TIMEOUT T27 |
| seller credit entries (R - V of L) | L's row KEY SHARE, then its subject (guard trigger) | reconcile from line, hold, close, correction, CMD053, noncash; direct INSERT | C06, C08, C15, C17, C18, S14, S17, S42, S49; multi-row C19, C21; TIMEOUT C09 |
| CREDIT items (itemized of L) | the statement row, then L's row KEY SHARE, then L's subject (item guard trigger) | close, correction; direct INSERT | C13, C14, S47, S31, K09c, K04c, K03c; multi-row C20; TIMEOUT C10 |
| CREDIT payout admission (holds and funds of L) | L's row KEY SHARE and shared subject in CMD052's one first call (payout_lines_unpayable; kauro_app lock-only path) | CMD052, intent INSERT trigger (re-entrant) | S55, S56, K01, K02, S77 |
| noncash settlements (statement) | statement row FOR UPDATE, its lines' rows KEY SHARE ascending, then their exclusive subjects (guard trigger) | PERIODS sweep (one statement per transaction); direct INSERT | S36, S39, S46, S48, S49, S50, S35, S38, S45, S59, S63; multi-statement S70; exclusive S73 |
| cutoff V2 (every hashed input, funds included) | the close's lines FOR UPDATE and subjects (all input lines) | every writer above, and `observeFunds`, needs one of them | S09, S38, S47, S57, S58, S60, S61; a line new at re-proposal K09n; a line committed after it K09m |
| lock order across rows of one transaction (G-ORD-1) | the flag; blocking only in the first call (KEY SHARE callers: rows and subjects; FOR UPDATE callers: rows), non-blocking after | every guard above, the two lock functions, the re-issued fences, every in-product caller in one call (S78) | T31, T32, T33, Y26, C19, C20, C21, S70, S71, S72, S78; row waits K03-K09; recovery K00, K03r-K09r |


### 5.2 Lock traces of the r8, r9 and r10 cells (actor by actor, in acquisition order; template rule 13)

Notation: St statement row FOR UPDATE; P open periods; Cash the payout-cash advisory lock (sql.ts:123-124); M the marker; R(L)ks / R(L)fu
the line row KEY SHARE / FOR UPDATE; S(L)x / S(L)s the line subject exclusive / shared; "call" = one `commission_lock_line_rows` call.
Roles: kauro_commission units (service commands, consumer, sweeps) lock unfiltered (0030:605, :641); CMD052 runs as kauro_app through
`commission_lines_owner_lock` (G-ORD-1 (vi)). Holders (test sessions, kit `b10-cells-support.ts`):
- HK(L), protocol holder: a kauro_commission_test session, `BEGIN; SELECT kauro.take_commission_line_subject(L, 'EXCLUSIVE')` -> M, R(L)ks,
  S(L)x, held to its COMMIT (the production function and privileges; the same locks as a hold step or a credit-entry guard).
- HB(L), protocol-external holder: a kauro_commission_test session, `BEGIN; SELECT pg_advisory_xact_lock(kauro.transition_key(
  'kauro.commission_lines', L))` -> S(L)x only, no row, no marker (PUBLIC functions, 0001:267-269).
"Red" names the fix whose removal turns the cell red.

| cell | refused or waiting actor: acquisitions in order | holder | observed | red when removed |
|---|---|---|---|---|
| K00 | kauro_commission unit, work = call [L2] FOR UPDATE (M, R(L2)fu, blocking, granted), then `take_commission_line_subject(L5,'EXCLUSIVE')` (flag on: R(L5)ks NOWAIT granted beside HK, S(L5)x try -> KC027) | HK(L5) | attempts counted at LOCK_ORDER_RETRY; (a) HK committed inside the hook at attempt 2: success at attempt 3; (b) HK kept: 4 attempts, then CAPACITY_UNAVAILABLE LOCK_ORDER_CONTENTION retryable | KC027 in `transientSqlState` (0 hook calls, INTERNAL_ERROR) or in the MAP (INTERNAL_ERROR) |
| K01 | CMD052 (kauro_app): St approve-payout.ts:68; Cash :83; :89 first call [L2, L5]: M, R(L2)ks, R(L5)ks (KEY SHARE beside HK's KEY SHARE: compatible), S(L2)s, S(L5)s waits | HK(L5) | waiter's ungranted lock advisory on S(L5); no KC027; HK commits; one intent, statement APPROVED | (a) the lock-only grant: 42501 at R(L2); (b) subjects in the first call: split into rows then a subject loop, S(L5)s raises KC027 and no wait is observed |
| K02 | CMD052 as K01, then the intent INSERT :97 -> KC018 trigger -> `payout_lines_unpayable` again (flag on: every lock re-entrant) | HB(L5) | wait at S(L5)s (advisory), no KC027; after HB ends, the INSERT adds no ungranted lock and no new lock entry; one intent | as K01 (b) |
| K03 | CMD053 FAILED (kauro_commission): St reconcile-payout.ts:103; reconciliation INSERT :129; :130 -> St re-entrant commercial-statements.ts:937, Cash :939, intent UPDATE; call [L2, L5 ∪ correction set] FOR UPDATE: R(L2)fu, R(L5)fu waits | HK(L5) | ungranted transactionid/tuple wait on HK's xid, no advisory wait, no KC027; one HELD set, one successor | the r7 row in `take_commission_line_subject`: R(L5)fu granted, S(L5)x try -> KC027, no row wait |
| K03r | as K03; R(L5)fu granted (no row holder); subjects: S(L2)x free, S(L5)x try -> KC027 | HB(L5) through 4 attempts | CAPACITY_UNAVAILABLE retryable, no journal row, intent, lines, holds and predecessor unchanged; HB ends; the client's retry with the same key applies FAILED once | KC027 out of the transient set or the MAP |
| K03s, K03sr | CMD053 SETTLED: as K03 to Cash; call [PAYABLE LINE ∪ CREDIT lines] FOR UPDATE; contended line = a CREDIT line L7 | HK(L7); HB(L7) | as K03; as K03r (statement still APPROVED, lines PAYABLE, no credit consumed) | as K03; as K03r |
| K04, K04r | correction (kauro_commission): St correct-statement.ts:53; discovery; call [set] FOR UPDATE (r8: replaces the :89-91 loop); subjects | HK(N) on a claim source N; HB(N) | row wait, one successor; KC027 -> CAPACITY_UNAVAILABLE, predecessor live, the retry corrects once | as K03; as K03r |
| K05, K05r, K06, K06r | refund / reversal consumer: P FOR SHARE consumer.ts:71; agency commission subject consumer.ts:50; P re-entrant ledger-effects.ts:275; pools FOR UPDATE commercial-ledger.ts:483; call [capture's lines] FOR UPDATE; `fenceLinesOfCapture` subjects | HK(L); HB(L) | row wait, one adjustment per line, one yield; KC027 -> delivery FAILED with retryAt, nothing written; the redelivery applies once | as K03; KC027 out of the MAP (INTERNAL_ERROR, not retryable) |
| K07, K07r | funds observation: P consumer.ts:71; pools ledger-effects.ts:351 -> :483; call [capture's lines] FOR UPDATE; fence :352 | HK(L); HB(L) | row wait, one observation, HELD once; KC027 -> FAILED retryAt, no observation; redelivery records one | as K05 |
| K08 | ELIGIBILITY release item (kauro_commission, sweeps.ts:197): call [L] FOR UPDATE waits; then S(L)x try; `resolveHold` commercial-ledger.ts:641 (hold row); AFTER fence re-entrant | HK(L) on a HELD line, FUNDS_HELD hold, funds AVAILABLE | transactionid wait; one RELEASED, zero credit entries (HELD line); the same pass's eligibility item (list :210 read after the release loop) makes L ELIGIBLE once | `releaseFundsHold` row-first: without it the hold row is updated first and the AFTER fence's first call waits at S(L) (advisory wait) |
| K08b | as K08: R(L)fu granted; S(L)x try -> KC027 | HB(L) through 4 attempts | item `FAILED CAPACITY_UNAVAILABLE`; hold OPEN, line HELD, no credit; HB ends; next pass RELEASED once, ELIGIBLE once | KC027 out of the transient set or the MAP (`FAILED INTERNAL_ERROR`) |
| K08c, K08cr | hold-opening item: now sweeps.ts:203; :204 -> commercial-ledger.ts:579 call [L] FOR UPDATE; S80 re-read; `openHold` :585 -> `commission_holds_lock_order` (row re-entrant, S(L)x try); FK re-entrant; line UPDATE :613 | HK(L); HB(L) | row wait, one hold, HELD; KC027 -> `FAILED CAPACITY_UNAVAILABLE`, no hold, line ACCRUED_PENDING; next pass HELD once with one hold | as K03; as K08b |
| K08d, K08dr | eligibility item: sweeps.ts:214 `lockLine` = call [L] FOR UPDATE; instant :218; :220 line UPDATE -> line fence S(L)x try | HK(L); HB(L) | row wait, ELIGIBLE once; KC027 -> `FAILED CAPACITY_UNAVAILABLE`, line unchanged; next pass ELIGIBLE once | as K03; as K08b |
| K09, K09r | PERIODS close (CMD051, kauro_commission): journal service.ts:101; instant :108; period FOR UPDATE close-period.ts:127; call [:147 lines] FOR UPDATE (replaces :148 loop); :149; comparison :151-155; `fenceLines` over the locked set | HK(L); HB(L) | row wait, one statement set; KC027 -> item `REFUSED LOCK_ORDER_CONTENTION`, period OPEN, no statement; next tick closes once | as K03; as K03r |
| K10 | PERIODS noncash item: St FOR UPDATE; INSERT -> guard first call [item lines] (rows KEY SHARE, S x, blocking) waits at S(L) | HK(L), then HB(L) | advisory wait in both, no KC027; one settlement after the holder ends | subjects in the guard's first call (a non-blocking subject phase raises KC027) |
| K09c | PERIODS close as K09; R = a PAID line of seller s with 300 RECOGNIZED credit (case J); call [:147 lines, R among them: commercial-statements.ts:501]: R(R)fu waits on HK's KEY SHARE; after HK commits: :149, comparison equal, `fenceLines` S(R)x free; CREDIT item INSERT -> guard: own new statement row KEY SHARE, [R] KEY SHARE + S(R)x, both re-entrant | HK(R) | ungranted transactionid/tuple, never advisory; zero LOCK_ORDER_RETRY passes; one statement of s with one CREDIT item of 300; period CLOSED | R left out of the one call (a set of the period's open lines, or credit lines in a later call): the guard's S(R)x try meets HK -> KC027, a LOCK_ORDER_RETRY pass, no waiter seen |
| K04c | correction (kauro_commission) of ISSUED S1 carrying a CREDIT item of R: St correct-statement.ts:53; named :85-87 (R through its item, :86); call [named] FOR UPDATE (replaces :89-91): R(R)fu waits; subjects over the set; re-discover equal; successor CREDIT item of R: guard re-entrant | HK(R) | row wait as K09c; zero LOCK_ORDER_RETRY passes; one successor carrying the CREDIT item once, S1 CORRECTED | R outside the call (CREDIT lines taken after it): KC027 at the guard |
| K03c | (r10) CMD053 FAILED (kauro_commission) on APPROVED S1 carrying a CREDIT item of R and PAYABLE L2: St reconcile-payout.ts:103; reconciliation INSERT :129; `transitionIntent` :130 -> commercial-statements.ts:937 own statement (re-entrant), :939 payout-cash, the intent row; then ONE call [S1's correction set (correct-statement.ts:85-87: R through its CREDIT item, :86) ∪ PAYABLE lines] FOR UPDATE: R(R)fu waits on HK's KEY SHARE; after HK: subjects; ISSUED again :141; lines HELD :143-147 (re-entrant); at :151 `supersedeStatement` (correct-statement.ts:75): its call over `named` re-entrant; the successor's CREDIT item guard on R re-entrant | HK(R) | ungranted transactionid/tuple, never advisory; zero LOCK_ORDER_RETRY passes; one successor carrying R's CREDIT item once; S1 CORRECTED; L2 HELD with one hold | CMD053's call over the PAYABLE lines only: `supersedeStatement`'s later call meets HK at R(R)fu NOWAIT -> 55P03 -> KC027, a LOCK_ORDER_RETRY pass |
| S54 | (r10 extension) correction (CMD051 id, correct-statement.ts:46; kauro_commission): St :53; discovery read (set D = `named` ∪ sources of live claims against them); hold point `SET_DISCOVERED`, reported by `supersedeStatement` with its caller's command (r11; the cell acts on (CMD051, SET_DISCOVERED) only). At the hold an offset writer (kauro_commission) INSERTs an offset from N' (outside D) to R ∈ D: guard [N', R] rows KEY SHARE + subjects (R not yet locked by the correction), COMMIT; then HK(N'). Release: one call [D] FOR UPDATE (free); subjects over D; re-discover: D ∪ {N'} | HK(N') | STALE_VERSION LEDGER_CHANGED; no release committed; no lock entry of the correction on N'; zero LOCK_ORDER_RETRY passes | the re-discovered set locked before the comparison: R(N')fu NOWAIT meets HK -> KC027, a LOCK_ORDER_RETRY pass; the growth check removed: a release is committed |
| K09n | (r10; r11 pin) World `statementsWorld` (statements-support.ts:139). W (kauro_commission_test, the ACCRUAL item's shape) opens first: `BEGIN`; INSERTs a fresh pool and its line L_new (kit fixture, INSERT grant 0030:640; balanced at COMMIT, 0030:394, :509) with created_at = M.ends_at - 1 s as an explicit value (no clock read, no offset set); stays open (invisible to the close's reads; holds only its new rows and FK KEY SHAREs the close never takes). Then PERIODS: proposal unit periods.ts:61-65 (no lock); CMD051 (kauro_commission): journal service.ts:101; cutoff :108 (serverNow, §5.3); period FOR UPDATE close-period.ts:127; :141, :147 reads (no L_new); one call [:147 lines] FOR UPDATE; hold point `LINES_LOCKED` with `{ cutoffAt }` (StatementServiceHold, runtime.ts:48 extended, tests only; the sweep passes it, periods.ts:42). At the hold: precondition L_new.created_at < cutoffAt (holds in every clock world: the close of M runs only after M ended, commission-service-access.ts:141-145, close-period.ts:135, so cutoff >= M.ends_at; a violated precondition fails the cell as a setup error, never a pass); W COMMITs; HK(L_new). Release: :149 includes L_new, the hash differs (:153) | HK(L_new) | STALE_VERSION LEDGER_CHANGED, item `REFUSED LEDGER_CHANGED`; no lock entry of the close on L_new; zero LOCK_ORDER_RETRY passes; period OPEN, no statement; after HK ends the next tick closes once with L_new | the comparison moved after `fenceLines` or after a guard over the :149 lines: S(L_new)x try meets HK -> KC027, a LOCK_ORDER_RETRY pass |
| K09m | (r10, X-ACC-1 (ii); r11 pin) World and W as K09n (created_at = M.ends_at - 1 s, transaction opened before CMD051). CMD051 as K09 through :149 (no L_new), :153 equal, `fenceLines`, compose, statements and items INSERTed (FK KEY SHAREs on sellers, agencies, projects), period CLOSED, then hold point `BEFORE_COMMIT` (service.ts:110, runtime.ts:48). The hold callback acts on (CMD051, BEFORE_COMMIT) only. At the hold: precondition created_at < the close's cutoff (reported by `LINES_LOCKED` of the same attempt; true in every clock world as in K09n); W COMMITs (its row locks were taken at its INSERT, before CMD051; none conflicts with the close's); release; close COMMITs. Next: the controlled clock past the next month's end; PERIODS closes that period: :147 includes L_new (`periodInputs` unfiltered, :501) | none | the first close's statements: no item and no inputLineIds entry for L_new; the next period's statement of L_new's seller itemizes it exactly once, ACCRUED_PENDING (its cents in accruedPendingCents once); no other close or correction names it | a calendar window on `periodInputs` (created_at within the closing period: L_new, in M, is outside M+1) or a window after the previous close's cutoff (L_new is before M's), or a composer that drops lines created before the previous cutoff: L_new is never itemized |
| S77 | CMD052 as K01 without a holder; then the acting owner (kauro_app, OPERATOR) runs `UPDATE kauro.commission_lines SET created_at = created_at WHERE line_id = L`: column privilege (0045 grant), UPDATE policy USING (`acting_corporate_owner()`), BEFORE triggers 0030:261, :262, :263-264, :265, :429 all pass, no OF-state trigger fires, then WITH CHECK (false); a seller session and an agency session call `take_commission_line_subject` | a FOR UPDATE holder of the line (kauro_commission) | owner locks and approves; the UPDATE: 42501, updated_at and version unchanged; seller/agency: KC022 at once, no wait | WITH CHECK (false) replaced by true or omitted: the UPDATE commits (updated_at advances); grant/policy removed: 42501 at the lock; set comparison removed: silent no-lock |
| S79 | CMD052 on S2: St(S2), Cash, call [.., L7 ..]; CMD053 FAILED on S1: St(S1), :130 Cash, call [.., L7 ..] | each other, both orders | the second waits at Cash, never 40P01 | CMD053's call moved before :130 -> 40P01 |

### 5.3 Template rules 13, 15, 17 over the whole lane (r8)

- Census (measured on e3da3e7). Line row locks in src: commercial-ledger.ts:486 (pool's lines FOR UPDATE), :564 (`lockLine`), :579
  (`transitionLine` HELD). `lockLine` callers: close-period.ts:148, :201; correct-statement.ts:90, :160; reconcile-payout.ts:134, :144;
  sweeps.ts:214 (and ledger-fixtures.ts, test). Line subjects: commercial-ledger.ts:494; 0036:25, :44, :76; 0037:104; 0043:22; 0045 of
  843bf01 :41. r8 routes every one through the two functions (§8); S72/S78 keep the census live.
- r9 census (main 843bf01; r10 cites): the only line-creating INSERT is commercial-ledger.ts:446-450 (fixtures aside), reached through
  `accruePool` (ledger-effects.ts:225, :251) inside `accruePurchase` (defined :207) from consumer.ts:56 (after the period share :71) and
  sweeps.ts:126 (ACCRUAL item, agency subject :123, no period lock: X-ACC-1). The close's CREDIT
  candidates ⊆ `periodInputs` lines (no filter, :501); the correction's ⊆ `lines` (:104) ⊆ `named` (:87). Rule 15 for K09n (r10,
  ADV-1, corrected): the close's cutoff is `now` = `serverNow` (service.ts:108 -> routes.ts:76 -> ledger-effects.ts:47-50: the
  microsecond `uow.serverInstant()` cut to milliseconds; unit-of-work.ts:344 -> source/rows.ts:30-37: `kauro.server_now()`, which a
  deployment defines as transaction_timestamp(), 0009:42-44, and the test cluster as transaction_timestamp() plus
  `kauro_test.clock_offset_seconds`, temporary-postgres.ts:111-113, :127). A production line's created_at is now() of its creating
  transaction (commercial-ledger.ts:450). In a deployment both are the database's transaction start instants; under a nonzero test-clock
  offset they differ by it (a seam older than this lane, B07 D-CLOCK-1), so (r11) K09n and K09m pin W's created_at to M.ends_at - 1 s:
  the close of M runs only after M ended (commission-service-access.ts:141-145; close-period.ts:135), so cutoff >= M.ends_at in every clock
  world (`StandingUnits` may stand the close behind real time, statements-support.ts:48-59); the hold point's precondition is a setup check. The cutoff is read before the close's waits: it judges no
  deadline and no authority, only which close composes a line, and K09m proves a line on the late side is composed by the next close.
- Rule 13 (every new lock placed in the order with the locks already held): the marker (taken first in a call, shared, never conflicts),
  the row lock of each call and each subject are placed in §5 and traced in §5.2; payout-cash is placed between statement and intent and
  CMD053's lines after it (S79); the lock-only grant adds no lock. Each opposite-order pair has its RACE cell red without its guard (§5.2).
- Rule 15 (a time judgment uses an instant read after the last await): CMD052's step-up at the effect (approve-payout.ts:94, after :89,
  the last wait; the database repeats it at the write, 0038/0040), and K02 shows the intent INSERT adds no wait. The eligibility item reads
  its instant after the row lock (sweeps.ts:214, :218). The hold-opening item read funds and due at list time (commission-service-access.ts
  :112-127) and its instant before the row lock (sweeps.ts:203): r8 re-reads state, due at an instant read after the lock, latest funds
  and covering hold under the lock (S80). `observeFunds` judges due with the consumer's `now` (consumer.ts:91) before its locks: due is
  monotone (FINAL + 720 h <= now stays true), so an earlier instant only holds fewer lines (the sweep holds the rest; conservative). The
  noncash pay-date check is in the guard's SQL after its locks (S21). Each retry attempt reads `now` inside its unit (G-ORD-2 (a)).
- Rule 16 (authority judged under a lock conflicting with its revoker, same transaction): no new authority judgment; CMD052's step-up and
  destination keep their existing cells (M13), now inside one transaction that also holds its line locks. The rule's privilege clause
  decides ADV-1: the narrowest lock-only path before any SECURITY DEFINER (G-ORD-1 (vi), §9 OFF-C11).

## 6. Tests (exact titles). Counts: F1 33, F2 26, F3 6, F4 80, F5 11, F6 21, F7 29 = 206 (r5: +12; r6: +13: S75, S76, K00-K10; r7: +1 K08b; r8: +16: S77-S80, F7 rebuilt 12 -> 24; r9: +4: K04c, K09c, K09n, CK01; r10: +2 K03c, K09m, -1 CK01 moved to lane B10 6c's kc-codes.test.mjs)

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
- T31 "RACE (ADV-OFF-1): two direct release INSERTs in one transaction, receiving lines L5 then L2, while a period close holds L2's row and waits for L5's: the L2 release is refused COMMISSION_LOCK_ORDER without waiting, the transaction leaves neither release, the close commits; no deadlock (40P01 never)"
- T32 "RACE (ADV-OFF-1): two transactions inserting releases on L2 and L5 in opposite orders, both interleavings: the later transaction's acquisition of a line the other holds is refused COMMISSION_LOCK_ORDER without waiting; the other commits both releases; no deadlock"
- T33 "RACE (ADV-OFF-1): two offset INSERTs in one transaction (N1 against R5, then N2 against R2) while a period close holds R2's row: the second is refused COMMISSION_LOCK_ORDER without waiting; no offset written, no deadlock"

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
- Y26 "RACE (ADV-OFF-1): a hold INSERT on L5 (its fence sets the transaction's lock flag) and then a direct release INSERT on L2 in the same transaction while a period close holds L2's row: the release is refused COMMISSION_LOCK_ORDER without waiting; no hold, no release, no deadlock"

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
- S54 "RACE (OFF-R6): an offset whose source is outside the correction's discovered set commits between its discovery and its locks: the correction refuses STALE_VERSION LEDGER_CHANGED and commits no release; with the new source's row and subject then held by a second session, the refusal comes without any lock of the correction on the new source and without a LOCK_ORDER_RETRY pass (r10)"
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
- S70 "RACE (ADV-OFF-1): two noncash-settlement INSERTs in one transaction for statements A then B while a period close holds a line row of B: B's guard is refused COMMISSION_LOCK_ORDER without waiting; no settlement; the PERIODS sweep, one statement per transaction, settles both after the close"
- S71 "OK (ADV-OFF-1): a writer that pre-locks lines given in any order through commission_lock_line_rows and take_commission_line_subject takes them ascending (rows, then subjects) and then inserts releases, credit entries and CREDIT items for them in any order with no refusal and no wait"
- S72 "DENY (ADV-OFF-1): after a line subject is taken, a guard or a hold INSERT needing a row or subject another transaction holds refuses COMMISSION_LOCK_ORDER without waiting; a pg_proc census of live function bodies and a src census find no commission line row lock or line subject outside the two lock functions"
- S73 "DENY (ADV-OFF-4): a direct noncash-settlement INSERT holds each item line's subject in exclusive mode before its credit reconcile reads (the session's pg_locks: ExclusiveLock and no ShareLock on every item line's subject); no shared-to-exclusive upgrade"
- S75 "DENY (OFF-R4-03): a transaction that took L5's subject and then runs SET LOCAL kauro.commission_lines_locked = false (and, separately, a fresh transaction under a session-level SET of it) still gets KC027 COMMISSION_LOCK_ORDER without waiting at L2's held row; a session-level marker taken before the transaction makes even its first acquisition refuse KC027 instead of waiting; both roll back completely"
- S76 "RACE (OFF-R4-04): CMD043 close-agency holding its agency row FOR UPDATE and a period close inserting statement items naming that agency, both orders: the item's FK waits at the agency row and completes after it; no deadlock; the close's items are unchanged"
- S74 "RACE (ADV-OFF-2): CreateRevision holding its project row FOR UPDATE and a period close inserting statement items naming that project, both orders: the item's FK waits at the project row and completes after it; no deadlock; the close's items are unchanged"
- S77 "DENY (ADV-1, r8): CMD052 as kauro_app locks its lines' rows FOR KEY SHARE through the lock-only grant (a third session's FOR UPDATE NOWAIT on each line fails 55P03 while the approval holds them) and approves; the acting owner's UPDATE kauro.commission_lines SET created_at = created_at on one of those lines is refused 42501 by commission_lines_owner_lock's WITH CHECK (false) with updated_at and version unchanged (with WITH CHECK true or omitted it commits and the test fails); a seller session and an agency session calling take_commission_line_subject on a line, and on a nonexistent id, get the same KC022 NOT_FOUND at once while a commission session holds that line FOR UPDATE (never seen waiting, no lock left); a call naming one visible and one invisible line raises KC022 and leaves no lock"
- S78 "DENY (ADV-5, r8): a transaction whose first call is take_commission_line_subject(L) waits for L's row behind a FOR UPDATE holder and then for L's subject behind a bare-key holder and is never refused; its second call on a held L' refuses KC027 COMMISSION_LOCK_ORDER without waiting; a src and pg_proc census finds every in-product multi-line caller (payout_lines_unpayable, close, correction, CMD053, lockPoolsOfCapture, the noncash guard) passing its complete set to one commission_lock_line_rows call and no lockLine or take_commission_line_subject loop before it"
- S79 "RACE (rule 13, r8): CMD052 approving S2 and CMD053 FAILED on S1, both carrying a CREDIT item of line L7, both orders: each takes payout-cash before any line lock (approve-payout.ts:83; CMD053 after transitionIntent, commercial-statements.ts:939), the second waits at payout-cash and completes after the first, never 40P01; with CMD053's line call moved before transitionIntent the pair deadlocks and the test fails"
- S80 "RACE (rule 15, r8): a funds AVAILABLE observation committing while the ELIGIBILITY hold-opening item waits at the line's row: the item re-reads state, funds, covering hold and due (at an instant read after the lock) and settles without a hold; the same pass's eligibility item makes the line ELIGIBLE; with the re-read removed the line goes HELD under a FUNDS_HELD hold of AVAILABLE funds and the test fails"

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
- C19 "RACE (ADV-OFF-1): a direct two-row credit-entry INSERT (L5, then L2) while a period close holds L2's row and waits for L5's: the L2 row is refused COMMISSION_LOCK_ORDER without waiting; no credit entry, the close commits, no deadlock"
- C20 "RACE (ADV-OFF-1, OFF-R4-02): two CREDIT items inserted in one transaction into a DRAFT statement (the issuance lifecycle: items before the DRAFT -> ISSUED edge) for L5 then L2, both with recognized credit, while a correction holds L2's row: the L5 item succeeds and holds L5's row and subject, the L2 item is refused KC027 COMMISSION_LOCK_ORDER (not KA004) without waiting; both items roll back, no deadlock; with the cross-row protection removed the L2 item waits and the test fails"
- C21 "RACE (partial, ADV-OFF-1): a multi-row credit-entry INSERT whose first row passed its guard and whose second row is refused COMMISSION_LOCK_ORDER leaves neither row and the line's recognized credit unchanged"

Family suites (kit `apps/api/test/b10-cells-support.ts`): CONS_TMO/CRB/CRA (refund, reversal), CMD_CRB/CRA of CMD051, the correction,
CMD053 and the PERIODS sweep (SWEEP_*) cover the new writes once each member's footprint includes `commission_offset_releases`,
`seller_credit_entries`, `commission_noncash_settlements` (FOOT-REL: an implementation obligation, closed by lane FOOT, not coverage until then).

F7 `apps/api/test/b10-lock-order-recovery.test.ts` (new, r6, OFF-R4-01; r8: two kinds, traces in §5.2. RACE: the protocol holder HK
holds the line's row KEY SHARE and subject; the caller is observed waiting at the named lock (the kit helper reads the waiter's ungranted
`pg_locks` locktype), completes after HK commits with no KC027 and one economic result. RETRY (K00, K08b, suffix r): the holder, HK for K00
and the bare-key holder HB otherwise, is kept through LOCK_ORDER_RETRIES, counted at the unit of work's LOCK_ORDER_RETRY hold point (never by
sleeping); the cell asserts the boundary's answer and complete rollback (journal reservation, outbox, reconciliation, holds, adjustments,
releases, credit entries, observations), releases the holder and asserts the boundary's recovery commits exactly one economic result; it
fails with the recovery step removed (KC027 out of `transientSqlState` or out of the sqlstate MAP)):
- K00 "RETRY (OFF-R4-01, ADV-5): a commission unit refused KC027 by take_commission_line_subject after its first call is retried at READ_COMMITTED with maxRetries 0, each retry passing the LOCK_ORDER_RETRY hold point; released at the second hold it succeeds on the third attempt; kept, it raises CAPACITY_UNAVAILABLE LOCK_ORDER_CONTENTION retryable after LOCK_ORDER_RETRIES, never INTERNAL_ERROR"
- K01 "RACE (OFF-R5-01, ADV-1, ADV-5): CMD052 as kauro_app for a statement with L2 and L5 while a second session holds L5's row KEY SHARE and exclusive subject through take_commission_line_subject: the approval takes its statement, payout-cash, both rows KEY SHARE and L2's subject in one first call and waits at L5's subject (advisory wait, no KC027); after the holder commits it approves exactly one intent"
- K02 "RACE (ADV-5): CMD052 while a session holds only L5's bare subject key: the approval waits at that subject inside its first call and is never refused KC027; after release the intent INSERT's KC018 backstop re-runs payout_lines_unpayable with every lock re-entrant (no new wait, no new lock entry) and one intent is approved"
- K03 "RACE (ADV-2): CMD053 FAILED while a second session holds L5's row KEY SHARE and subject: after statement, intent and payout-cash it waits at L5's row (transactionid wait, no advisory wait, no KC027) and after the holder commits applies FAILED once: lines HELD with one hold each, one successor"
- K03r "RETRY (ADV-2, OFF-R4-01): CMD053 FAILED against a bare subject key on L5 kept through LOCK_ORDER_RETRIES: KC027 at L5's subject after the row set, answer CAPACITY_UNAVAILABLE with no journal row and intent, lines, holds and predecessor unchanged; after release the client's retry with the same key applies FAILED once"
- K03s "RACE (ADV-2): CMD053 SETTLED of a statement with a CREDIT item of L7 while a second session holds L7's row KEY SHARE and subject: it waits at L7's row and settles once (lines PAID, the credit consumed once)"
- K03sr "RETRY (ADV-2): CMD053 SETTLED against a bare subject key on the CREDIT line L7: CAPACITY_UNAVAILABLE, statement APPROVED and no credit consumed; the same key after release settles once"
- K03c "RACE (r10, ADV-4): CMD053 FAILED on an approved statement carrying a CREDIT item of line R while a second session holds R's row KEY SHARE and subject: after statement, intent and payout-cash its one lock call includes R and waits at R's row (transactionid wait, no advisory wait), never passes LOCK_ORDER_RETRY, and after the holder commits one successor carries R's CREDIT item once and the predecessor is CORRECTED"
- K04 "RACE (ADV-2): a correction whose set includes the claim source N while a second session holds N's row KEY SHARE and subject: it waits at N's row and corrects once with one successor"
- K04r "RETRY (ADV-2, OFF-R4-01): a correction against a bare subject key on N: CAPACITY_UNAVAILABLE, predecessor live, no journal row; the retry with the same key corrects once"
- K05 "RACE (ADV-2): a refund basis change consumer while a second session holds a capture line's row KEY SHARE and subject: after periods, agency subject and pools it waits at the line's row and applies one adjustment per line and one yield"
- K05r "RETRY (ADV-2, OFF-R4-01): a refund basis change consumer against a bare subject key on a capture line: the delivery settles FAILED with a retryAt and nothing written; the redelivery after release applies one adjustment per line and one yield"
- K06 "RACE (ADV-2): a reversal basis change consumer waits at a capture line's row held KEY SHARE with its subject and applies once"
- K06r "RETRY (ADV-2): a reversal basis change consumer against a bare subject key settles FAILED with a retryAt; the redelivery applies once"
- K07 "RACE (ADV-2): a funds HELD observation while a second session holds a due capture line's row KEY SHARE and subject: it waits at the row and records one observation and one HELD transition with one hold"
- K07r "RETRY (ADV-2, OFF-R4-01): a funds observation against a bare subject key on a capture line settles FAILED with a retryAt and no observation; the redelivery records one observation and holds the line once"
- K08 "RACE (OFF-R4-01, ADV-3): the ELIGIBILITY release item for a FUNDS_HELD hold of a HELD line whose funds are AVAILABLE, while a second session holds the line's row KEY SHARE and subject: releaseFundsHold waits at the line's row before the hold row (transactionid wait, no KC027), then releases once with zero credit entries, and the same pass makes the line ELIGIBLE once"
- K08b "RETRY (OFF-R4-01, ADV-3): the ELIGIBILITY release item against a bare subject key on the line kept through LOCK_ORDER_RETRIES is reported FAILED CAPACITY_UNAVAILABLE with the hold OPEN, the line HELD and no credit; the next pass after release releases it once and makes the line ELIGIBLE once"
- K08c "RACE (ADV-4): the ELIGIBILITY hold-opening item for a due line on held funds while a second session holds its row KEY SHARE and subject: it waits at the row, then opens one FUNDS_HELD hold and moves the line HELD once"
- K08cr "RETRY (ADV-4): the ELIGIBILITY hold-opening item against a bare subject key: FAILED CAPACITY_UNAVAILABLE, no hold, line ACCRUED_PENDING; the next pass after release opens one hold and moves the line HELD once"
- K08d "RACE (ADV-4): the ELIGIBILITY eligibility item while a second session holds the line's row KEY SHARE and subject: it waits at the row, then makes the line ELIGIBLE once"
- K08dr "RETRY (ADV-4): the ELIGIBILITY eligibility item against a bare subject key: FAILED CAPACITY_UNAVAILABLE at the line fence, line unchanged; the next pass after release makes it ELIGIBLE once"
- K09 "RACE (ADV-2): a PERIODS close while a second session holds an input line's row KEY SHARE and subject: after the period it waits at the line's row and closes once"
- K09r "RETRY (ADV-2, OFF-R4-01): a PERIODS close against a bare subject key on an input line: item REFUSED LOCK_ORDER_CONTENTION, period OPEN, no statement, no journal row; the next tick after release closes it once"
- K09c "RACE (r9, ADV-2): a PERIODS close whose seller has 300 recognized credit on a PAID line R (case J) while a second session holds R's row KEY SHARE and subject: the close's one lock call includes R and waits at its row (transactionid wait, no advisory wait), never passes LOCK_ORDER_RETRY, and after the holder commits issues one statement with one CREDIT item of 300"
- K04c "RACE (r9, ADV-2): a correction of a statement carrying a CREDIT item of line R while a second session holds R's row KEY SHARE and subject: R is in the correction's one lock call, which waits at its row and never passes LOCK_ORDER_RETRY; after the holder commits one successor carries the CREDIT item once and the predecessor is CORRECTED"
- K09n "RACE (r9, ADV-2; r10 pinned): a line inserted by a transaction opened before the close, with created_at one second before the closing period's end (asserted below the close's cutoff at the LINES_LOCKED hold), committed after the close's line lock call and before its re-proposal, its subject then held by a second session: the close answers STALE_VERSION LEDGER_CHANGED (item REFUSED LEDGER_CHANGED) without any lock on that line and without a LOCK_ORDER_RETRY pass, the period stays OPEN with no statement, and the next tick after release closes once including the line"
- K09m "RACE (r10, X-ACC-1): a line inserted as in K09n (created_at one second before the closing period's end) but committed while the close waits at its BEFORE_COMMIT hold: the close commits without it (no item, not among the statements' input lines) and the next period's close itemizes it exactly once as ACCRUED_PENDING in its seller's statement"
- K10 "RACE (ADV-2, ADV-5): the PERIODS noncash item for one statement while a second session holds an item line's subject, first with its row KEY SHARE and then as a bare key: the guard's first call waits at the subject (never KC027) and one settlement commits after release"


## 7. Failure-mode matrix (C = test above, written first; all money cells tier 1)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| M1 offset INSERT | **C** pairs below (O-*); multi-row T33 | **C** T20 | N/A: no deadline governs an offset; R is already ELIGIBLE | **C** T21 | N/A: no response step; the writer (OQ-1) owns it | **GAP** OQ-1: the writer's idempotency identity | N/A: agreement terms immutable once signed (0029 `seller_agreements_immutable`, `learned_once`), read after the lock | N/A: one INSERT; DENY T01-T10, T17, T18 |
| M2 hold INSERT + yield + credit | **C** pairs (H-*); hold step first call S78; owner (kauro_app) path is B12's (X-B12-1) | **C** Y16 | N/A: review_at acts on nothing | **C** Y14 | **GAP** FOOT-REL (SWEEP_CRA, CONS_CRA members opening holds); the dispute command is B12's | **C** K07r, K08cr (KC027 recovery of the two production hold openers); own hold id otherwise | N/A: B12's grant | **C** Y24 |
| M3 hold RESOLVED (RELEASED, UPHELD) + credit | **C** pairs (HR-*, U-*); ELIGIBILITY release row-first K08 | **GAP** FOOT-REL (ELIGIBILITY sweep timeout member) | N/A | **GAP** FOOT-REL (SWEEP_CRB ELIGIBILITY) | **GAP** FOOT-REL (SWEEP_CRA) | **C** resolveHold CAS (existing STALE on version) + C06; KC027 K08b | N/A: commission service / B12 | **C** C16 |
| M4 line E change + yield + credit (refund, reversal; B12 correction) | **C** pairs (D-*); row waits K05, K06 | **GAP** FOOT-REL CONS_TMO | N/A | **GAP** FOOT-REL CONS_CRB | **GAP** FOOT-REL CONS_CRA | **C** Y10; KC027 K05r, K06r | **C** CONS_REV (kit, existing) | **C** Y15 |
| M5 CMD053 FAILED/RETURNED (cancellation, HELD or zero path, correction) | **C** pairs (F-*); row wait K03; CREDIT line wait K03c; cash before lines S79 | **GAP** FOOT-REL CMD053 member | N/A: evidence has no B10 deadline (B15) | **GAP** FOOT-REL CMD_CRB | **GAP** FOOT-REL CMD_CRA | **C** CMD053 RETRY cell (existing); S06, S20 one release; KC027 K03r | N/A: finance service fact | **C** S64 |
| M6 CMD053 SETTLED (lines PAID, claims settled, credit) | **C** pairs (ST-*); row wait K03s; S79 | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD053 RETRY (existing); KC027 K03sr | N/A | **C** S65 |
| M7 close CMD051 (yield, §2.5 applications, credit, CREDIT items) | **C** pairs (C-*); row wait K09; CREDIT line wait K09c; line new at re-proposal K09n; line committed after it K09m (X-ACC-1) | **GAP** FOOT-REL | N/A here: the period's due date is CMD051's existing EXPIRY cell | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** CMD051 RETRY (existing); S05, S18; KC027 K09r | N/A | **C** S66 |
| M8 correction (lock set, cancellation, recompose) | **C** pairs (K-*); row wait K04; CREDIT line wait K04c; discovery growth S54 | **GAP** FOOT-REL | N/A | **GAP** FOOT-REL | **GAP** FOOT-REL | **C** existing "corrected once"; KC027 K04r | N/A | **C** S67 |
| M9 noncash settlement (PERIODS sweep) | **C** pairs (NC-*); multi-statement S70; exclusive subjects S73; first-call wait K10 | **GAP** FOOT-REL SWEEP_TMO | **C** S21 (before, at, after the pay date on the controlled clock) | **GAP** FOOT-REL SWEEP_CRB | **GAP** FOOT-REL SWEEP_CRA | **C** S50 (KC027 unreachable: first call, K10) | N/A: commission service | **C** S68 |
| M10 lock acquisition (pools, fence, prelocks) | **C** Y13, S13, S25, S71, S72 | N/A: M4/M5 | N/A | N/A: locks only | N/A | N/A | N/A | N/A: locks only |
| M11 release INSERT (guarded) | **C** T24, T30; multi-row T31, T32, Y26 | **C** T27 | N/A | N/A: single INSERT | N/A | **C** T24 (a second release refused beyond live) | N/A | **C** T31 (a transaction refused at its second release leaves neither); its guards are DENY T22, T25, T26, T28, T29 |
| M12 credit entry INSERT / CREDIT item INSERT (guarded) | **C** C06, C08, C13, C14, C15; multi-row C19, C20 | **C** C09, C10 | N/A | N/A: single INSERT | N/A | **C** C07 | N/A | **C** C21 (second row refused, neither row stays); its guards are DENY C05, C07 |
| M13 CMD052 with CREDIT items (one first call: rows KEY SHARE, shared subjects; kauro_app lock-only path) | **C** S55, S56, K01, K02, S79; privilege and isolation S77 | **C** CMD052 TIMEOUT cell (existing; CREDIT lines join its first call) | **C** CMD052 step-up EXPIRY cells (existing) | **C** CMD052 CRASH-BEFORE (existing) | **C** CMD052 CRASH-AFTER (existing) | **C** CMD052 RETRY (existing); KC027 unreachable (first call: K01, K02) | **C** CMD052 REVOCATION (existing: destination, step-up) | N/A: one intent INSERT; its KC018 trigger is the guard (S55), re-entrant (K02) |
| M14 cutoff V2 (proposal vs close) | **C** S09, S47, S61, K09n, K09m | N/A: hash comparison, no wait | N/A | N/A: read-only | N/A | **C** S57, S58, S60 (stale proposal refused) | N/A | N/A: read-only |
| M15 lock order across the rows of one transaction (G-ORD-1, r5; G-ORD-2, r6; first call, r8) | **C** T31, T32, T33, Y26, C19, C20, S70, S75, S78; row waits of FOR UPDATE callers K03, K03s, K04-K09, K08c, K08d, K04c, K09c, K03c | N/A: after the first call nothing waits (non-blocking); the first call's waits are T27, C09, C10 and the CMD052 TIMEOUT cell | N/A: no deadline | N/A: locks only; the transaction's writes roll back with it (C21) | N/A: locks end at COMMIT, nothing durable | **C** K00 (unit of work, hold point), K03r, K03sr, K04r, K05r, K06r, K07r, K08b, K08cr, K08dr, K09r (an actual KC027 per caller boundary, complete rollback, recovery after contention, one result); S71 uncontended | **C** S77 (kauro_app lock-only path, no cross-tenant lock); the marker is a transaction-scoped advisory lock with no explicit unlock (S75) | **C** C21, T31 |
| M16 funds observation (consumer; the holds it opens) | **C** NC-FO S46, A-FO S56, ST-FO S27, C-FO S61; row wait K07 | **GAP** FOOT-REL CONS_TMO (funds member) | N/A: due is monotone; an earlier instant holds fewer lines (§5.3) | **GAP** FOOT-REL CONS_CRB | **GAP** FOOT-REL CONS_CRA | **C** K07r (KC027); one fact per capture version (UNIQUE, 0030) | N/A: provider fact through the inbox | **GAP** FOOT-REL (fault at a hold after the observation INSERT); tier 2: ACCRUED_PENDING lines, no claim, no credit (rule 9 not met) |
| M17 ELIGIBILITY items: hold opening (sweeps.ts:200-207) and eligibility (sweeps.ts:210-223) | **C** row waits K08c, K08d; funds re-read under the lock S80 | **GAP** FOOT-REL (ELIGIBILITY sweep timeout member) | N/A: review_at acts on nothing; due is judged at an instant read after the row lock (sweeps.ts:218; S80) | **GAP** FOOT-REL SWEEP_CRB | **GAP** FOOT-REL SWEEP_CRA | **C** K08cr, K08dr (KC027 -> FAILED, next pass once) | N/A: commission service | hold opening: **GAP** FOOT-REL (fault at the line UPDATE after the hold INSERT), tier 2 as M16; eligibility: N/A, one line UPDATE (its guard KC007 is a DENY) |

Writer pairs on one line. Writers: O offset, H hold opened, HR hold RELEASED, U UPHELD + its correction (X-B12-1 protocol, built here,
called by B12), D entitlement change (refund, reversal), I entitlement change of a settled source, C close, K correction, F CMD053
FAILED/RETURNED, ST CMD053 SETTLED, NC noncash sweep, FO funds observation, A CMD052 approval. A **cell** holds one actor at a named
lock and runs the other, both orders; a **proof** states why the two cannot change a common guarded aggregate and why their locks
cannot cycle (same order, §5).

| | cells | proofs |
|---|---|---|
| O | O-O T11, T12; O-H T13; O-HR Y18; O-U Y17; O-D T19; O-I T23; O-C S09; O-K S15; O-F S13; O-ST S25; O-NC S45 | O-FO: FO moves only ACCRUED_PENDING lines (an offset needs ELIGIBLE R and a settled N), rows then subjects on both sides. O-A: A takes rows KEY SHARE and shared subjects only, in one first call (r8), and its lines are PAYABLE (an offset against them is refused); the offset's rows-then-subjects cannot wait on A while A waits on nothing it holds |
| H | H-H Y12; H-HR Y21; H-U Y22; H-D Y11; H-I C17; H-C S10; H-K S12; H-F S29; H-ST S40; H-NC S39; H-A S55 (on a CREDIT line; on PAYABLE lines the existing D10-GAP-8 cells) | H-FO: FO opens FUNDS_HELD holds only on ACCRUED_PENDING lines (no claim, no credit); two holds serialize on the line subject as H-H |
| HR | HR-HR C18; HR-U Y23; HR-D Y20; HR-I C06; HR-C S34; HR-K S32; HR-F S33; HR-ST S41; HR-NC S48 | HR-FO: the ELIGIBILITY sweep's FUNDS_HELD release and FO change only ACCRUED_PENDING/HELD funds lines (claims 0 by INV-S-15.3). HR-A: a release only removes a blocker; A reads holds after its shared subject: refused or admitted, never paying held cents |
| U | U-U Y25; U-D Y19; U-C S28; U-K S44; U-F S43; U-ST S62; U-NC S63 | U-I: both are entitlement writes of one line under its row lock (as D-D, kit CONS_DUP_LINE); U-FO as HR-FO; U-A: as HR-A plus a decrease on a PAYABLE line (existing D10-GAP-8 cells) |
| D, I | D-D, I-I, D-I: kit CONS_DUP_LINE (one capture's lines under pool and row locks); D-C S11; D-K S16; D-F S30; D-ST S26; D-NC S35; I-C S17; I-K S14; I-F S42; I-NC S49 | I-ST: ST settles R's applied claims (Aout(N) counts applied and settled alike, X(N) unchanged) and locks R, not N. D-FO, I-FO: one capture's rows then subjects in both (Y13, D10-GAP-24). D-A, I-A: existing D10-GAP-8 cells (a decrease on a PAYABLE line) |
| C | C-K S31; C-F S37; C-ST S47; C-NC S38; C-FO S61 | C-C: each close takes its period FOR UPDATE, then every input line FOR UPDATE ascending, then subjects ascending: two closes serialize on their first common line, the second composing from what the first committed (a line PAYABLE through the first is not re-itemized; INV-S-15.4). C-A: C takes its period, its input line rows FOR UPDATE, then exclusive subjects (non-blocking after its rows), then new statement rows; A takes its old statement row, cash, then its PAYABLE and CREDIT lines' rows KEY SHARE and shared subjects in one first call (r8): each blocks only in its first call, in the one order (G-ORD-1 (iv)): no cycle. Common aggregate: a CREDIT line of A's statement; A's item is live, so C itemizes none of it (R - V - itemized), and A changes no itemized amount |
| K | K-K S53; K-F S69; K-NC S36 | K-ST, K-A on one statement: both take its row FOR UPDATE first; an APPROVED or PAID statement has no CORRECTED edge (registry CommissionStatement), so after A or ST the correction is refused, and before them A/ST find a CORRECTED statement and refuse. K-FO: K's lines are PAYABLE or settled, not moved by FO; locks rows then subjects on both |
| F, ST | F-F S51; ST-ST S52; ST-FO S27; F-ST on one intent: CMD053-RACE (existing, serialized settlement on the statement row) | F-NC, ST-NC: NC needs payable 0, F and ST need an intent (payable > 0): never the same statement; on a shared line F/ST take its row FOR UPDATE and NC takes it KEY SHARE then its exclusive subject, each in its first call: the second waits at the row (G-ORD-1 (iii), (iv)) |
| NC, FO, A | NC-NC S50; NC-FO S46; A-FO S56; A-A CMD052-RACE (existing: two approvals) | A-NC: A needs payable > 0, NC payable 0: never one statement; on a shared line both take the rows KEY SHARE and then the subjects (NC exclusive, A shared) ascending in one first call: the second waits at the subject (G-ORD-1 (i), (iv)). FO-FO: one fact per capture version (UNIQUE, 0030), the capture's line rows then subjects (D10-GAP-24) |

Discovery growth: S54. FOOT-REL (crash/timeout family footprints) stays an implementation obligation of lane FOOT, not coverage.

## 8. Migration plan (provisional numbers, contiguous; never edit 0030 or 0031: new migrations ALTER and CREATE OR REPLACE)

`0045_offset_claims_yield.sql` (replaces `0045_offset_capacity_holds.sql`): `kauro.new_uuid_v7()`; `commission_noncash_settlements`
(UNIQUE statement_id; admissible guard; frozen guards on statements and lines); `commission_offset_releases` (append-only, server
instant, guard, deferred applied check, RLS FORCE, grants §4); `kauro.commission_offsets_yield(line, cause)`, `_apply_within_allowance`
(§2.5, close and correction only); re-issued `commission_offsets_authorized` (settled source, live amounts, pos with A_in and C_paid);
triggers `commission_holds_offsets_yield` (AFTER INSERT, after line_fence) and `commission_lines_offsets_yield` (AFTER UPDATE OF
cumulative_entitlement_cents, state). No `commission_holds_offset_room`. G-ORD-1 (r5): `kauro.commission_lock_line_rows`,
`kauro.take_commission_line_subject` and the marker function `kauro.commission_lines_locked()` (r6: transaction-scoped shared advisory marker, no custom setting); `take_commission_line_lock` (0036) and the
`commission_lines_line_fence` trigger re-issued over them; `commission_holds_lock_order` (BEFORE INSERT on holds); each guard's flag-on non-blocking branch with SQLSTATE KC027
(message prefix `COMMISSION_LOCK_ORDER:`); the noncash guard's exclusive subjects. Application (r6, G-ORD-2): `sqlstate.ts` KC027 ->
CAPACITY_UNAVAILABLE LOCK_ORDER_CONTENTION retryable; `unit-of-work.ts` `transientSqlState` adds KC027 with its own LOCK_ORDER_RETRIES budget.
`0046_seller_credit.sql`: `payout_lines_unpayable` re-issued with the CREDIT branch (OFF-R2-02), its shared subjects through
`take_commission_line_subject`; `statement_items_credit_guard`; `seller_credit_entries` (append-only, reconciled guard, RLS FORCE, seller read own); `kauro.seller_credit_reconcile`;
credit triggers on commission_lines (E, state) and commission_holds (INSERT, state) for settled lines; `statement_items` ALTER: item_kind
and disposition CREDIT, `statement_items_payable_only_payable_line` replaced (payable on PAYABLE LINE or CREDIT items; amends D10-STMT-2),
deferred `statement_items_credit_within_recognized`. The `disposition = 'PAYABLE'` filters of 0037 and 0039 (one live payable item, payable owner) stay
correct because CREDIT items carry disposition CREDIT; the payout admission of 0036/0043 is re-issued with a CREDIT branch.
Code: `lockPoolsOfCapture` ascending; `applyBasisChange` fences; ports `yieldOffsets`, `fenceLines`, `lockSetOf` (discovery),
`reconcileCredit`, `settleNoncash`; `PeriodLedgerRows.offsetReleases?`, `credits?` (optional); composer §2.7; CMD052, CMD053, correction and
close lock sets §5; PERIODS sweep noncash step; `commissionCutoffHash` V2 (§2.8).
r8 (ADV-1..5): 0045 adds the lock-only path (`GRANT UPDATE (created_at) ON kauro.commission_lines TO kauro_app`; policy
`commission_lines_owner_lock` FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (false)); both lock functions
SECURITY INVOKER, `SET search_path = pg_catalog`, `REVOKE ALL ... FROM PUBLIC`, EXECUTE to kauro_app and kauro_commission; the flag read
once at entry; KEY SHARE first calls take their subjects in the same call; NOWAIT's 55P03 re-raised as KC027; the locked set compared with
the requested set (KC022, message prefix `COMMISSION_LINE_NOT_FOUND:`). `sqlstate.ts`: KC022 -> NOT_FOUND COMMISSION_LINE_NOT_FOUND.
`unit-of-work.ts`: `UnitOfWorkDependencies.lockOrderHold?` (point `LOCK_ORDER_RETRY`, tests only) and `sleep?` (default setTimeout),
awaited in `#retrying` (:391-397) after a KC027 attempt and before the next. `ledger-effects.ts` `releaseFundsHold(uow, holdId, lineId,
version, now)`: `commission_lock_line_rows([lineId], 'UPDATE')`, `take_commission_line_subject(lineId, 'EXCLUSIVE')`, then `resolveHold`;
sweeps.ts:197 passes `hold.lineId` (the work item carries it, commission-service-access.ts:108). `commercial-ledger.ts`: `lockLine` (:564)
and `transitionLine`'s HELD lock (:579) through `commission_lock_line_rows`; `lockPoolsOfCapture` takes the capture's lines in one call
(replaces the per-pool loop :485-487); `fenceLinesOfCapture` (:492-495) over `take_commission_line_subject`. close-period.ts:148 and
correct-statement.ts:89-91: one call over the set (r9: the close's set is the :147 read, CREDIT candidates included; the comparison
:151-155 before `fenceLines` and every guarded INSERT; `StatementServiceHold` (runtime.ts:48, tests only; r10) becomes `(command, point: "BEFORE_COMMIT" | "LINES_LOCKED" |
"SET_DISCOVERED", detail?: { cutoffAt }) => Promise<void>`: `LINES_LOCKED` only in the close's body after its one call, with the close's cutoff
(reported as CMD051); `SET_DISCOVERED` in `supersedeStatement` after the discovery read, before its call, reported with the caller's command
(r11: `supersedeStatement(rt, uow, predecessor, now, command)`, "CMD051" from correct-statement.ts:46, "CMD053" from reconcile-payout.ts:151);
cells select their (command, point) pair and pass every other report through; the correction itemizes CREDIT
only for its composition's lines). `sqlstate.ts`: `COMMISSION_LINE_NOT_FOUND: "KC022"` (MAP NOT_FOUND COMMISSION_LINE_NOT_FOUND),
`COMMISSION_LOCK_ORDER: "KC027"` (MAP CAPACITY_UNAVAILABLE LOCK_ORDER_CONTENTION retryable); every raise uses the message prefix equal to
the name (`COMMISSION_LINE_NOT_FOUND:`, `COMMISSION_LOCK_ORDER:`).
**Deferred (rule 7, r10): the KC registry.** `docs/design/KC-CODES.md` and `tools/test/kc-codes.test.mjs` are lane B10 6c's (planned at
ae9c546, not on main). Binding requirements for OFFSET's build: it merges after that PR; in the commit that adds the raises it flips the
two OFFSET rows RESERVED -> RAISED with token = SQLSTATE name = `COMMISSION_LINE_NOT_FOUND` (KC022) and `COMMISSION_LOCK_ORDER` (KC027),
MAP as above, lane B10-OFFSET; it adds no second code check. If 6c has not merged, OFFSET's build waits for it (no adapter, no own test). reconcile-payout.ts: the line call after `transitionIntent` (:130), before :132/:141.
sweeps.ts:200-207: under the row lock the item re-reads state, latest funds, covering hold and due at an instant read after the lock, and
answers SETTLED without a write when any changed (S80; the eligibility item's pattern, sweeps.ts:214-219). Kit (`b10-cells-support.ts`,
lane kit first): holders HK and HB (§5.2), the waiter's ungranted locktype probe, the LOCK_ORDER_RETRY hook wiring through the test world.

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
  pre-locked (re-entrant) or non-blocking and refused `COMMISSION_LOCK_ORDER`; in-product writers pre-lock; the PERIODS sweep settles one
  statement per transaction. 07 "Transaction discipline": "Multi-row invariants use explicit locking or bounded serializable retries. The
  implementation documents why the chosen isolation prevents the relevant interleaving." T31-T33, Y26, C19-C21, S70-S72, S75; the
  refusal's bounded retry and per-caller recovery (G-ORD-2): K00-K10 and, since r8, the RACE/recovery pairs of §6 F7 (first-call semantics, §5 G-ORD-1 (i)-(v)).
- OFF-C10 (r5, ADV-OFF-2; r6, OFF-R4-04): FK parents audited (§4), constraint and inline references; two parents have an explicit FOR
  UPDATE holder, projects (S74) and agencies (S76), and neither holder takes a B10 lock.
- OFF-C11 (r8, ADV-1): kauro_app locks commission lines through the lock-only path, not a SECURITY DEFINER. Authority: 08 "Database
  isolation" ("SECURITY DEFINER functions require a specific justification, fixed search_path, minimal owner privileges and no public
  execute grant"); template rule 17 ("grant the narrowest lock-only path (column SELECT of the judged columns, UPDATE on one immutable
  column, an UPDATE policy WITH CHECK (false)) before any SECURITY DEFINER"). Predicate measured on the schema: a lock-only path exists
  (`created_at` immutable, 0030:263-264; RLS FORCE with per-role policies, 0030:602-605), so no specific justification for a definer
  exists. Also verified: a definer cannot test the invoker's visibility, because `kauro.current_seller_id()` and
  `kauro.acting_corporate_owner()` are SECURITY INVOKER and read sellers and corporate roles through the caller's policies (0029:164-177):
  inside a definer they would run as its owner and need grants on those tables, widening it; on the lock-only path RLS filters before
  the lock. No definer exists in the schema (0001:6-7 "none is used here"; 0032:8, 0034:15, 0035:11). Residual: kauro_app could issue any
  row-lock mode on owner-visible lines from raw SQL; S72/S78's census forbids any line lock outside the two functions. The coordinator's
  suggested definer variant (NOLOGIN owner) is recorded as evaluated and rejected for these reasons; S77 is the dedicated isolation test.
- X-B12-2 (r8, ADV-3): credit on RELEASED of a hold on a PAID or ADJUSTED line is recorded by the database protocol built here (credit
  trigger on the hold's state change; C03, C06, C16, C18 drive it through a commission-service session: SIMULATED caller) and its production
  caller is B12's RELEASED command. The ELIGIBILITY release never meets it: FUNDS_HELD holds open only on ACCRUED_PENDING lines
  (ledger-effects.ts:369; sweeps.ts:200-207 via commission-service-access.ts:118) and HELD leads only to ELIGIBLE or VOID, so K08 asserts
  zero credit entries.
- OFF-C12 (r9, ADV-2): a correction itemizes seller credit only for lines of its own composition (correct-statement.ts:104), all in
  its one lock call; credit recognized on any other line is itemized by the next monthly close, whose set is every line (:501). 17
  "Accrual, eligibility and payout" schedules payable amounts per monthly statement and does not require a correction to absorb credit of
  other lines; R2 does not decide it otherwise, and this is the reading that never takes a line outside the one call. K04c.
- OFF-C13 (r9; r10 updated to 6c ae9c546, code claims; grep of origin/main and every pw-* worktree, 2026-10-10): the highest KC on main
  is KC020 (sqlstate.ts:70, :153); KC027 appears nowhere outside this design and 6c's plan. Lane B10 6c owns KC021 (CLAIM_EXPIRED,
  pw-b10-6c sqlstate.ts:72, :157, 0048:109) and KC024-KC026, and reserves KC023 for itself (never raised) (6c-r2-plan.md:97-101); OFFSET
  owns KC022 (COMMISSION_LINE_NOT_FOUND) and KC027 (COMMISSION_LOCK_ORDER), RESERVED in 6c's KC-CODES.md until OFFSET's build raises
  them (§8 Deferred). The single code check is 6c's `tools/test/kc-codes.test.mjs`; r9's CK01 is withdrawn. One wording to align in 6c's
  table: 6c-r2-plan.md:100-101 writes "KC027 LOCK_ORDER_CONTENTION", which is the MAP reason; the message token is COMMISSION_LOCK_ORDER.
- X-ACC-1 (r9; r10 cites and cells; tier 2; covered here, nothing routed): the ACCRUAL item (sweeps.ts:120-129) takes its agency's
  subject (:123) and accrues at :126 without the open-period share the consumer takes (consumer.ts:71, whose comment says a delivery never
  lands between a close's guard and its COMMIT); its line, created_at = now() of a transaction begun before the close's, can commit during
  the close. (i) Between :147 and :149: the close refuses LEDGER_CHANGED with no lock on it (K09n). (ii) After :149: the close commits
  without it and the next period's close composes it once (`periodInputs` has no period filter, :501), born ACCRUED_PENDING (0030:135),
  so no payable amount moves (K09m, red under a calendar window or a window after the previous cutoff; r11 pins the line inside M). No interleaving puts an unlocked line into a
  statement of the closing period (§5 G-ORD-1 (v)). The missing period share itself is B10 core's; OFFSET neither needs nor adds it.
- No registry amendment is needed: noncash settlement adds no state or edge. An optional later amendment (PAYABLE to PAID on noncash
  evidence) would only rename the frozen state; not requested.
