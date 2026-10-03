# B10 failure-mode matrix

Status: test inventory at `b10/failure-matrix` (from `b10/stage-3` d0ee96a, all stage 1 to 3 lanes merged). Documentation only; no product code.
Template and column definitions: `docs/design/FAILURE-MATRIX-TEMPLATE.md`. Fault harness: `docs/design/FAULT-HARNESS.md` (built separately).
Design source: `docs/design/B10-commercial-domain.md` (decisions D10-*).

How to read a cell. Every cell starts with its status.
- **C** covered: the expected behaviour, then `[key]` naming the proving test; the test index at the end maps each key to `file :: exact title`.
- **GAP** `<code>`: not proven by any existing test; the text is the behaviour the design implies; the code names the entry in the GAP list at the end, which holds the proposed test title.
- **N/A**: the reason the failure mode cannot occur in that step.

Counting rule. A cell is **C** only if an existing test title asserts that behaviour. A retry test proves the replay of a committed answer, so the "crash after COMMIT" column of a single-transaction command is a GAP (code CMD_CRA / PAY_CRA / CLOSE_CRA / CONS_CRA) until the harness injects the loss. "Crash before COMMIT" is covered where the command's RACE title says so. Database-level tests (`... at the database`) are cited for PARTIAL and RACE where they show the invariant the half-state would violate.


## CMD002 ActivateAgency

One tenant transaction: shared locks on the published versions, then the append-only acceptance and the agency DRAFT to ACTIVE (CAS).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: acceptance insert + agency ACTIVE + agency.activated.v1 (one COMMIT) | **C** two keys on one expectedVersion: one activation, one 409 STALE_VERSION, wait observed `[a02race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | **GAP** `AGREEMENT_EXP`: version unpublished/superseded while waiting: the version read after its shared lock decides (locks tested, interleaving not) | **C** crash before COMMIT leaves the agency DRAFT with no acceptance `[a02race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 200 without a second acceptance; same key with another billingProfileRef is 409 IDEMPOTENCY_CONFLICT `[a02race]` | **GAP** `TEN_REV`: OWNER membership removed mid-way: refused by agencies_authority at the write (static admit-only-current-OWNER is tested) | **C** acceptance names published versions and the accepting OWNER; append-only (a half cannot commit) `[d02db]` |
| R: published versions and billing profile read after their shared locks | **C** versions read after shared locks, so a concurrent publish cannot interleave a stale read `[d02ad]` | **GAP** `CMD_TMO`: shared-lock wait past the timeout: retriable failure, nothing written | N/A: a version expiring while the step runs is the AGREEMENT_EXP gap of W | N/A: read-only step | N/A: read-only step | N/A: read-only step | **C** only the agency's current OWNER is admitted `[d02ad]` | N/A: read-only step |

## CMD043 CloseAgency

One tenant transaction on the agency's row and exclusive half: obligations inventory, open quotes WITHDRAWN with reservations RELEASED, closure record, agency to CLOSING.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W1: withdraw open quotes + release reservations (B09 release guard) | **GAP** `QUOTE_CLOSE`: CreateQuote racing the closure: quote withdrawn by it or refused AGENCY_NOT_ACTIVE | **GAP** `CMD_TMO`: lock wait timeout: retriable, nothing written | N/A: no deadline inside the step | **C** crash before COMMIT leaves the agency ACTIVE `[a43race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the closure | **C** identical retry replays the 200; same key with another assuranceProofRef is 409 IDEMPOTENCY_CONFLICT `[a43race]` | **GAP** `TEN_REV`: OWNER removed or step-up expired mid-way: refused, nothing withdrawn | **C** a quote WITHDRAWN with its reservation RELEASED after closure; a release refused by B09 (payment in flight) refuses the closure CLOSURE_OBLIGATIONS_UNRECONCILED `[a43new]`, `[a43deny]` |
| W2: closure record with obligations inventory + agency CLOSING + agency.closing.v1 | **C** CloseAgency racing CreatePaymentOrder serializes on the agency in both orders (409 CLOSURE_OBLIGATIONS_UNRECONCILED or AGENCY_NOT_ACTIVE) `[a43race]` | **GAP** `CMD_TMO`: lock wait timeout: retriable, nothing written | N/A: no deadline inside the step; step-up freshness is in the REVOCATION column | **C** crash before COMMIT leaves the agency ACTIVE `[a43race]` | **GAP** `CMD_CRA`: response lost after COMMIT | **C** identical retry replays the 200 `[a43race]` | **GAP** `TEN_REV`: see W1 | **C** CLOSING to CLOSED refused while any order, refund, authorization or tax document is non-terminal or any reconciliation case OPEN (KC006) `[d43db]` |
| W3: obligation inventory read (captures, refunds, authorizations arriving mid-way) | **GAP** `CLOSE_INFLIGHT`: a capture or refund request landing between the inventory and COMMIT is listed or refuses the closure | **GAP** `CMD_TMO`: timeout: retriable | N/A: read step | N/A: read step | N/A: read step | N/A: read step | N/A: read step | N/A: read step |

## CMD027 CreateQuote (issuance)

One tenant transaction under the recurrence lock's shared half: source/plan/profile reads, snapshot INSERT ... SELECT, founding slot update, supersession of the previous unpaid quote, quote, quote_issuances.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R: source availability, plan, billing profile, BuyerTypeReader | N/A: reads inside the issuance transaction; races are in the write rows | **GAP** `BUYER_TMO`: BuyerTypeReader timing out: retriable failure, nothing written | **C** a source past its retention deadline on the database clock is SOURCE_EXPIRED before the sweeper ran `[a27s060]` | N/A: read step | N/A: read step | N/A: read step | N/A: authority of the AGENCY_BILLING member is in the W row | N/A: read step |
| W1: snapshot INSERT ... SELECT of qualifying_projects_at + count and tier | **C** a designation of the same agency serializes with the issuance in both orders: the set includes the new purchase with its tier or excludes it wholly `[a27des]` | **GAP** `CMD_TMO`: wait on the exclusive half past the timeout: retriable | **GAP** `TOCTOU_SOURCE`: source deadline passing while the locks are held | **C** crash before COMMIT leaves no quote, snapshot or reservation `[a27race]` | **GAP** `CMD_CRA`: response lost after COMMIT | **C** identical retry replays the 201; same key with another planId is 409 IDEMPOTENCY_CONFLICT `[a27race]` | **GAP** `TEN_REV`: AGENCY_BILLING removed mid-way | **C** the snapshot is inserted in the same statement as its count and tier; a rounded discount the database refuses `[d27core]` |
| W2: founding slot take (UPDATE founding_slots ... held) + reservation | **C** two agencies racing the last slot serialize on the slot row: one RESERVED, one standard; slots taken in ascending order `[a27slot]`, `[d27slot]` | **GAP** `CMD_TMO`: slot-row wait past the timeout: retriable | **C** a reservation ends at the quote's 336-hour expiry; a superseding or replacement quote never inherits it `[d27res]`, `[a27res]` | **C** crash before COMMIT leaves no reservation `[a27race]` | **GAP** `CMD_CRA`: response lost after COMMIT | **C** same retry replays the same reservation `[a27race]` | N/A: no authority step | **C** a slot holds one live reservation; one founding reservation per agency per cohort ever; reservation names an ISSUED quote of its agency `[d27slotdb]`, `[d27db]` |
| W3: supersede previous unpaid quote + release its reservation | **C** two keys for one project serialize on its live quote with the wait observed and supersede exactly once `[a27race]` | **GAP** `CMD_TMO`: wait on the live quote past the timeout: retriable | N/A: no deadline inside the step | **C** crash before COMMIT leaves the previous quote ISSUED `[a27race]` | **GAP** `CMD_CRA`: response lost after COMMIT | **C** retry replays; no second supersession `[a27race]` | **GAP** `SLOT_RELEASE_RACE`: the QUOTE_EXPIRY sweep or CMD043 releasing the same reservation | **GAP** `CMD_PAR`: failure after the previous quote is superseded and before the new one is inserted rolls both back |

## CMD027 included-replacement protocol

Paid project, entitlement ACTIVE, allowance unspent: intent (tenant: replacement ISSUED, quote_issuances) then settle (payment service: PurchaseRebinder) then complete (tenant: journal). A refusal withdraws the replacement.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| S1: intent (tenant COMMIT: replacement ISSUED + journal entry) | **C** two replacements: a second same-band replacement after the allowance is spent is REPLACEMENT_ALLOWANCE_SPENT with nothing written `[a27ref]` | **GAP** `CMD_TMO`: lock wait timeout: retriable, nothing written | **C** a changed band, mode or target is REPLACEMENT_SCOPE_CHANGED with the price comparison, writing nothing `[a27scope]` | **C** crash before the replacement's intent commits leaves nothing `[a27crash]` | **C** crash between the intent commit and the re-binding resumes from the journal entry `[a27crash]` | **C** identical retry resumes the one replacement `[a27crash]` | **GAP** `REPL_REVOKE`: paid entitlement consumed or order refunded before S2 | **GAP** `CMD_PAR`: intent committed, quote_issuances missing: not committable (confirm at the database) |
| S2: settle (SERVICE unit of work: PurchaseRebinder re-binds the paid purchase; call-out) | **C** never re-bound twice across a crash and a retry `[a27crash]` | **GAP** `REPL_TMO`: re-binding timing out after the call: observed by identity, never repeated, retriable answer | N/A: no deadline inside the step | **C** crash before the re-binding `[a27crash]` | **C** crash after the re-binding completes the same answer `[a27crash]` | **C** a retry after the re-binding completes the same answer, the purchase is never re-bound twice `[a27crash]` | **GAP** `REPL_REVOKE`: execution starting or refund between S1 and S2 | **C** a refused re-binding withdraws the replacement with its reason `[a27ref]` |
| S3: complete (tenant COMMIT: old entitlement REVOKED SOURCE_REPLACED, allowance spent, journal COMMITTED) | **GAP** `QUOTE_CLOSE`: CloseAgency racing the completion: refused or withdrawn consistently | **GAP** `CMD_TMO`: lock wait timeout: retriable, the journal entry stays open | N/A: no deadline inside the step | **C** crash between the re-binding and the completion resumes from the journal entry to the same answer `[a27crash]` | **GAP** `CMD_CRA`: response lost after the completion commit | **C** a retry replays the completed answer `[a27rep]` | **GAP** `REPL_REVOKE`: see S1 | **C** replacement carries paid terms; old entitlement revoked, allowance spent, no order and no fee `[a27rep]`, `[d27db]` |

## CMD045 RegisterProspect

One corporate transaction: source-evidence check, prospect with organization key.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: prospect + source-evidence binding (one COMMIT) | **C** two sellers registering one organization yield one prospect and one 409 PROSPECT_EXISTS, wait observed `[a45race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | N/A: no deadline inside the step | **C** crash before COMMIT leaves no prospect `[a45race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 201; same key with another organizationLabel is 409 IDEMPOTENCY_CONFLICT `[a45race]` | **GAP** `SELLER_ACT_RACE`: seller terminated mid-way (CMD050): written before and handled by it, or SELLER_NOT_ACTIVE; also CORP_REV for the owner path | **C** one live prospect per normalized organization key; evidence admits the AGENCY segment only (a half cannot commit) `[d45db]` |

## CMD046 ClaimProspect

One corporate transaction on the prospect's claims lock: claim SUBMITTED (or DISPUTED in the same transaction), review deadline now + 2160 h.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: claim + deadline + conflict review (one COMMIT) | **C** two sellers' claims of one prospect serialize on its claims lock, wait observed; the second is DISPUTED and owns nothing `[a46race]`, `[a46conf]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | **GAP** `AGREEMENT_EXP`: agreement version superseded mid-way: AGREEMENT_VERSION_MISMATCH (the stale version is tested sequentially in a46deny) | **C** crash before COMMIT leaves no claim `[a46race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 201; same key with another evidenceHash is 409 IDEMPOTENCY_CONFLICT `[a46race]` | **GAP** `SELLER_ACT_RACE`: seller terminated by CMD050 mid-way: SELLER_NOT_ACTIVE or handled by the termination | **C** one live claim per seller and prospect; seller ACTIVE with that agreement version; evidence and deadline fixed (a half cannot commit) `[d46db]` |

## CMD047 AcceptAttribution

One corporate transaction, owner: BuyerTypeReader call-out, frozen allocation (shares sum to 10000 bps at COMMIT, KC003), claims ACCEPTED (expiry + 2160 h), competing claims REJECTED.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R: BuyerTypeReader (call-out) | N/A: read of a port; no write | **GAP** `BUYER_TMO`: BuyerTypeReader timing out: retriable, nothing written | N/A: no deadline | N/A: no write | N/A: no write | N/A: no write | N/A: no authority in the port | **C** unset or IN_HOUSE refuses and writes nothing `[a47buy]` |
| W: allocation + shares + claims state + pools terms (one COMMIT) | **C** two acceptances for one agency yield one allocation and one ATTRIBUTION_EXISTS, wait observed `[a47race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | **GAP** `CLAIM_DEADLINE`: claim past its review deadline on the database clock before the sweep ran | **C** crash before COMMIT leaves the claim SUBMITTED `[a47race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 200; same key with another shareAllocationRef is 409 IDEMPOTENCY_CONFLICT `[a47race]` | **GAP** `TERM_ACCEPT`: a share's seller terminated mid-way (CMD050): consistent in both orders; also CORP_REV | **C** one frozen allocation per agency; shares sum to 10000 bps at COMMIT; pool terms equal the signed agreement; SHARES_NOT_WHOLE refused `[d47db]`, `[a47deny]` |
| W2: claim lapse against the CLAIM_WINDOWS sweep | **GAP** `CLAIM_LAPSE_ACCEPT`: acceptance racing the lapse of the same claim | **GAP** `CMD_TMO`: timeout | **GAP** `CLAIM_DEADLINE`: deadline instant exactly | N/A: single writer per row | N/A: single writer per row | N/A: single writer per row | N/A: no authority | N/A: single writer per row |

## CMD048 AssignAccount

One corporate transaction: current assignment ended, new current assignment appended; allocations, entitlements, windows and the designation have no path from it (R2-095).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: end previous assignment + append new current + service assignment link (one COMMIT) | **C** two assignments on one version yield one and one 409 STALE_VERSION, wait observed `[a48race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | N/A: no deadline inside the step | **C** crash before COMMIT leaves the previous assignment current `[a48race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 200; same key with another sellerId is 409 IDEMPOTENCY_CONFLICT `[a48race]` | **GAP** `SELLER_ACT_RACE`: target seller terminated mid-way: SELLER_NOT_ACTIVE (static refusal tested in a48deny); also CORP_REV | **C** assignments append-only, one current per agency; no runtime role can alter an entitlement's first capture or window (half-state cannot commit) `[d48db]`, `[d48ad]` |

## CMD049 ActivateSeller

One corporate transaction, owner with a fresh step-up: seller CANDIDATE to ACTIVE with agreement, legal review, assessment, confidentiality, VERIFIED destination, tax documentation (KC005).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: seller ACTIVE (one COMMIT; KC005 checked at the database) | **C** two activations racing yield one ACTIVE seller, wait observed `[a49race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | **GAP** `CMD_EXP_ASSURE`: step-up expiring mid-way | **C** crash before COMMIT leaves the seller CANDIDATE `[a49race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 200; same key with another agreementId is 409 IDEMPOTENCY_CONFLICT `[a49race]` | **GAP** `CORP_REV`: grant revoked, destination superseded or agreement withdrawn mid-way: refused (static presence tested in d49db) | **C** a seller becomes ACTIVE only with every prerequisite present (a half cannot commit) `[d49db]` |

## CMD050 TerminateSeller

One corporate transaction, owner: seller TERMINATED, assignments ended, prospects unassigned, entitlements TERMINATED_WITH_RESIDUAL, unlisted claims EXPIRED, tail entries ending 2160 h after the effective instant.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: seller + assignments + prospects + entitlements + claims + tail entries (one COMMIT) | **C** two terminations on one expectedVersion yield one TERMINATED seller and one 409 STALE_VERSION, wait observed `[a50race]` | **GAP** `CMD_TMO`: lock wait past the timeout: retriable failure, nothing written | **C** tail entries end 2160 h after the effective instant `[a50r100]` | **C** crash before COMMIT leaves the seller ACTIVE with its claims and entitlements unchanged `[a50race]` | **GAP** `CMD_CRA`: response lost after COMMIT: the same key returns the committed answer | **C** identical retry replays the 200; same key with another manifest is 409 IDEMPOTENCY_CONFLICT `[a50race]` | **GAP** `TERM_ACCEPT`: an AcceptAttribution or an accrual landing mid-way (end to end planned in B10-INTEGRATION); also CORP_REV | **C** a tail entry exists only for an ACCEPTED unexpired claim of the terminated seller whose agency has no purchase (KC011); no runtime role can DELETE a ledger row `[d50tail]`, `[d50db]` |
| X: manifest entry whose claim lapses or whose agency purchases mid-way | **GAP** `TAIL_PURCHASE_RACE`: agency's first purchase designated while the manifest is checked (KC011 at the database) | **GAP** `CMD_TMO`: timeout | **GAP** `CLAIM_LAPSE_ACCEPT`: claim expiring at the effective instant | N/A: see W | N/A: see W | N/A: see W | N/A: see W | **C** a manifest of an agency that already purchased, or of another seller's claim, is TAIL_NOT_ENUMERATED `[a50deny]` |

## CMD051 CloseCommissionPeriod

Commission service, STORED_OPERATION journal: period OPEN and due, no undelivered COMMISSIONS record before the cutoff, recomputed KAURO_COMMISSION_CUTOFF_V1 equals the request, banking-calendar read, then one COMMIT: statements ISSUED, ELIGIBLE lines PAYABLE, hold items, guard review, period CLOSED.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R: BankingCalendarSource (call-out) + cutoff recomputation | **GAP** `CLOSE_CAL`: a newer calendar version recorded mid-way | **GAP** `CLOSE_TMO`: calendar or recomputation timing out: retriable, period stays OPEN | **C** a period not yet due is PERIOD_NOT_DUE; period stores the calendar version it came from; no VERIFIED_FEED is CALENDAR_UNAVAILABLE `[a51deny]`, `[d51cal]`, `[d51cal2]` | N/A: read step | N/A: read step | N/A: read step | N/A: service identity checked at the pipeline; no per-request authority | N/A: read step |
| W: statements + items + PAYABLE transitions + holds + guard review + period CLOSED (one COMMIT) | **C** a close racing a refund adjustment serializes on the period in both orders: in this statement or the next, never both or neither `[a51race]` | **GAP** `CLOSE_TMO`: lock wait past the timeout: retriable, nothing written | **C** a due period closes on the test calendar; a line awaiting FINAL completion or AVAILABLE funds is a reasoned hold item, never payable `[a51ok]`, `[a51deny]` | **C** crash before COMMIT leaves the period OPEN `[a51race]` | **GAP** `CLOSE_CRA`: crash or lost response after COMMIT; the journal replays the same statements | **C** identical retry replays the 200 with the same statements; same key with another ledgerCutoffHash is 409 IDEMPOTENCY_CONFLICT `[a51race]` | **GAP** `CLOSE_VS_DELIVERY`: a late COMMISSIONS delivery before the cutoff (also the INPUTS_UNRECONCILED check); a hold opened mid-way is the ELIG_REV case | **C** a line becomes PAYABLE only through an ISSUED statement item naming it; the cutoff hash is recomputed identically from the rows; disputed 1000 cents held, undisputed 50000 payable `[d51db]`, `[d51ad]`, `[a51r102]` |

## CMD052 ApproveCommissionPayout

Owner, fresh step-up, CAS on an ISSUED statement: payee check, bank-available cash read, one AUTHORIZED payout_intents row, statement APPROVED; no transfer.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R: bank-available cash (latest settlement with bank evidence) and live intents | **GAP** `PAY_CASH_RACE`: two approvals of two statements racing on the same cash | **GAP** `CMD_TMO`: timeout reading settlements: retriable, nothing written | N/A: cash is the latest recorded settlement, no deadline | N/A: read step | N/A: read step | N/A: read step | N/A: read step | N/A: read step |
| W: intent AUTHORIZED (amount = payable, destination version and digest, stable reference) + statement APPROVED (one COMMIT) | **C** two approvals of one statement yield one intent and one 409 STALE_VERSION, wait observed `[a52race]` | **GAP** `CMD_TMO`: lock wait on the statement row past the timeout: retriable, nothing written | **GAP** `PAY_REV`: step-up window passing mid-way | **C** crash before COMMIT leaves the statement ISSUED with no intent `[a52race]` | **GAP** `PAY_CRA`: response lost after COMMIT | **C** identical retry replays the 200; same key with another payeeRef is 409 IDEMPOTENCY_CONFLICT `[a52race]` | **GAP** `PAY_DEST_RACE`: destination change mid-way (a bank change just before payout is refused sequentially); KAURO_OWNER grant revocation is in PAY_REV | **C** an intent's amount equals the statement's payable, its payee a VERIFIED destination version of the seller (KC009), one live intent per statement; an intent keeps its destination `[d52db]`, `[a52r103]`, `[d52sales]` |
| X: statement state ISSUED/APPROVED against CMD053's FAILED or RETURNED reconciliation | **GAP** `PAY_APPROVE_VS_FAIL`: approval racing the reconciliation that returns the statement to ISSUED | N/A: same lock wait as W | N/A: no deadline | N/A: single statement of W | N/A: single statement of W | N/A: covered by the stale-version retry of W | N/A: covered in W | N/A: covered in W |

## CMD053 ReconcileCommissionPayout

Finance service, STORED_OPERATION journal: PayoutEvidenceVerifier call-out, evidence must match reference, destination digest, amount and currency; SETTLED, FAILED or RETURNED branch in one COMMIT.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| R: PayoutEvidenceVerifier (call-out) | **GAP** `PAY_SETTLE_FLIP`: SETTLED and RETURNED evidence for the same intent arriving in different orders | **GAP** `PAY_VERIFIER_TMO`: verifier timing out: retriable, nothing changes | N/A: evidence has no expiry in the design | N/A: read step | N/A: read step | N/A: read step | N/A: read step | N/A: read step |
| W: intent SETTLED/FAILED/RETURNED + statement PAID/ISSUED + lines PAID/HELD (one COMMIT) | **C** two reconciliations of one intent yield one settlement, wait observed; settling takes the statement's row lock `[a53race]`, `[d53ad]` | **GAP** `CMD_TMO`: lock wait on the statement row past the timeout: retriable | N/A: no deadline inside the step | **C** crash before COMMIT leaves the intent AUTHORIZED and the lines PAYABLE `[a53race]` | **GAP** `PAY_CRA`: response lost after COMMIT | **C** identical retry replays the 200; same key with other evidence is 409 IDEMPOTENCY_CONFLICT; the same evidence applied again returns its recorded state `[a53race]` | **C** evidence of another reference, destination or amount is PAYOUT_EVIDENCE_MISMATCH and changes nothing; SUBMITTED-only is PAYOUT_NOT_SETTLED `[a53deny]`, `[a53r103]` | **C** a line becomes PAID only when its statement's intent is SETTLED with an evidence hash (KC010); FAILED or RETURNED keeps the intent, statement ISSUED and lines HELD PAYOUT_FAILED `[d53db]`, `[a53ok]` |

## COMMISSIONS consumer: capture.completed.v1

Each effect in its own SERVICE unit of work: pool per purchase and source, line per beneficiary, first-designation mirror (agency row, version bump, agency.first_purchase_designated.v1).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: pools + lines + holds + designation mirror (one COMMIT per delivery) | **C** two first captures of one agency serialize on its recurrence lock in both orders: sequence 1 and 2; a transaction beginning earlier but designating later is refused DESIGNATION_REWRITE `[r137]`, `[r137db]`, `[d27uow]` | **GAP** `CONS_TMO`: PreparationCompletionSource timing out inside the effect | **C** a subsequent capture one second before / exactly at the local twelve-month endpoint accrues / does not accrue by the provider-completion instant `[r094]`, `[r138]` | **GAP** `CONS_CRB`: crash before the effect COMMIT | **GAP** `CONS_CRA`: crash after the effect COMMIT and before delivery settled | **C** a duplicated delivery and a second full capture add nothing; one pool per purchase and source; a replay adds nothing `[r140]`, `[cap]` | **GAP** `CONS_REV`: entitlement or seller terminated mid-way (also TERM_ACCRUAL) | **C** a pool's cents equal round(basis x rate) and its lines sum to it at COMMIT (KC002); one pool per purchase and source `[l097]`, `[lkc]` |

## COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1

One adjustment per changed line and event; a basis only falls; a refund before its completion accrues the purchase first.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: adjustment append + line state (VOID/HELD/PAYABLE adjusted) | **GAP** `CONS_DUP_LINE`: the existing order test is sequential; concurrent dispatchers untested | **GAP** `CONS_TMO`: timeout inside the effect | N/A: no deadline | **GAP** `CONS_CRB`: crash before the effect COMMIT | **GAP** `CONS_CRA`: crash after COMMIT before delivery settled | **C** every order of completion, refund and reversal ends at the same cumulative entitlements with one adjustment per changed line and event; a replay adds nothing `[ord]`, `[cap]` | **GAP** `CONS_REV`: entitlement expired or seller terminated mid-way | **C** a basis only falls (a refund after the reversal, or one naming a higher basis, appends nothing); cumulative adjustments (KC015); a PAID line moves to ADJUSTED with an appended adjustment `[ladj]`, `[r104]` |

## COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1

Funds facts and holds (HELD / AVAILABLE) and FINAL/STAGE completions from PreparationCompletionSource.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W1: funds fact + FUNDS_HELD hold (review date 168 h) | **GAP** `ELIG_REV`: funds fact racing the ELIGIBILITY pass | **GAP** `CONS_TMO`: timeout | N/A: no deadline | **GAP** `CONS_CRB`: crash before COMMIT | **GAP** `CONS_CRA`: crash after COMMIT | **C** HELD moves an otherwise due line to HELD FUNDS_HELD with a review date and blocks no unrelated line `[funds]` | N/A: no authority | N/A: single row write |
| W2: completion record via PreparationCompletionSource (call-out) | **GAP** `CONS_DUP_LINE`: STAGE and FINAL completion for one purchase delivered concurrently | **GAP** `CONS_TMO`: source timing out: the line stays ACCRUED_PENDING, next pass retries | N/A: 720 h are counted from the completion's own instant, not from processing | **GAP** `CONS_CRB`: crash before COMMIT | **GAP** `CONS_CRA`: crash after COMMIT | **C** a completion per purchase and kind; STAGE leaves ACCRUED_PENDING, FINAL 720 h later with funds available makes ELIGIBLE `[r101]` | N/A: no authority | **C** ELIGIBLE only with a FINAL completion at least 720 h old and AVAILABLE funds (KC007) `[l101]` |

## COMMISSIONS dispatcher lease (OUTBOX_DISPATCH)

One lease resource for the consumer; fence read from each claim and heartbeat, never cached; expired lease is a takeover under the next fence; a refused heartbeat settles nothing more (D10-CONS-2).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| L1: claim / takeover | **C** held against a second dispatcher; the former owner resumes under the next fence once it expired `[lease]` | N/A: claim is one statement; the heartbeat timeout is L2 | **C** expired lease is a takeover under the next fence `[lease]` | **GAP** `LEASE_CRASH`: dispatcher stopped right after the claim | N/A: claim is the commit; the next heartbeat or takeover is observed in L2 | **C** its own re-claim after expiry advances the fence `[lease]` | **C** a dispatcher whose heartbeat is refused settles nothing more `[lease]` | N/A: one row |
| L2: heartbeat and settle of deliveries | **GAP** `CONS_LEASE_EXP`: lease expiring mid-effect: late COMMIT fenced | **GAP** `LEASE_CRASH`: a heartbeat that does not arrive in time | **C** a refused heartbeat settles nothing more `[lease]` | **GAP** `CONS_CRB`: see consumer tables | **GAP** `CONS_CRA`: see consumer tables | **C** redelivery adds nothing `[cap]` | **C** refused heartbeat ends the dispatcher's settling `[lease]` | N/A: each delivery is its own unit of work |

## Sweep QUOTE_EXPIRY

kauro_commission reads live founding reservations past their end (migration 0033); expires the quote, releases the slot, or puts the reservation in RECONCILIATION_HOLD when a payment is in flight.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: quote EXPIRED + reservation RELEASED, or RECONCILIATION_HOLD (own SERVICE unit of work) | **GAP** `QE_CAPTURE_RACE`: capture settling while the sweep decides; also SLOT_RELEASE_RACE with CMD027 and SWEEP_RACE with a second pass | **GAP** `SWEEP_TMO`: release guard or payment service timing out: hold, never release | **C** a founding quote expires only when nothing is in flight; an uncertain capture holds in RECONCILIATION_HOLD until the capture consumes the slot or a proved no-capture releases it; a reservation ends at the 336-hour expiry `[qe]`, `[d27res]` | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **GAP** `SWEEP_RACE`: second pass over the same reservation | N/A: a reservation's release authority is the sweep's own service identity | **GAP** `SWEEP_CRASH`: failure between expiring the quote and releasing its slot rolls both back (not injected) |

## Sweep CLAIM_WINDOWS

Claims lapse at their review or acceptance deadline with no first purchase.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: claim EXPIRED | **GAP** `CLAIM_LAPSE_ACCEPT`: lapse racing AcceptAttribution | **GAP** `SWEEP_TMO`: timeout: retry next pass | **C** claims lapse at their deadline with no first purchase `[sweeps]` | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **GAP** `SWEEP_RACE`: second pass over the same claim adds nothing | N/A: service identity only | N/A: one row per effect |

## Sweep ENTITLEMENT_WINDOWS

Entitlements expire at window_ends_at (America/Bogota wall time, day clamped); earned lines unaffected.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: entitlement EXPIRED | **GAP** `CONS_REV`: expiry racing an accrual at the boundary instant (accrual is by the provider-completion instant) | **GAP** `SWEEP_TMO`: timeout: retry next pass | **C** entitlements expire at window end with earned lines unaffected; window end equals twelve calendar months at Bogota wall time; the endpoint cases of R2-094 and R2-138 `[sweeps]`, `[r094db]`, `[r094]`, `[r138]` | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **GAP** `SWEEP_RACE`: second pass adds nothing | **GAP** `TERM_ACCRUAL`: TERMINATED_WITH_RESIDUAL entitlement reaching its window end | N/A: one row per effect |

## Sweep ACCRUAL_RECONCILIATION

Accrues a purchase lacking the lines of an applicable entitlement (e.g. an acceptance after the first purchase) at the capture's current basis; a zero basis is born and voided at once.

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: pool + lines for a late purchase | **GAP** `ACCRUAL_REC_RACE`: racing the COMMISSIONS accrual of the same purchase | **GAP** `SWEEP_TMO`: timeout | N/A: no deadline of its own | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **C** an acceptance after the first purchase gains its missing lines once `[sweeps]` | N/A: service identity only | **C** a pool's cents equal round(basis x rate) and its lines sum to it at COMMIT (KC002) `[l097]` |

## Sweep ELIGIBILITY

ACCRUED_PENDING to ELIGIBLE (FINAL completion + 720 h, funds AVAILABLE, no covering hold); releases FUNDS_HELD holds; asks PreparationCompletionSource for staged purchases (D10-SVC-4).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W: line ELIGIBLE / hold RELEASED | **GAP** `ELIG_REV`: a hold or adjustment landing mid-way | **GAP** `CONS_TMO`: PreparationCompletionSource timing out: the line stays ACCRUED_PENDING | **C** FINAL completion 720 h later with funds available makes the line ELIGIBLE; AVAILABLE releases a funds hold `[r101]`, `[funds]` | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **GAP** `SWEEP_RACE`: second pass adds nothing | N/A: service identity only | **C** a line becomes ELIGIBLE only with a FINAL completion at least 720 h old and AVAILABLE funds (KC007) `[l101]`, `[lkc]` |

## Sweep PERIODS

Opens the month's period undated; closes a due period through CMD051 under journal key period-close-<periodId> (built beside CMD051).

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| W1: open the month's period | **GAP** `PERIODS_RACE`: two sweepers opening the same month | **GAP** `SWEEP_TMO`: timeout | N/A: opens at the real clock; the dating happens at close | **GAP** `SWEEP_CRASH`: crash before COMMIT | **GAP** `SWEEP_CRASH`: crash after COMMIT | **C** the sweep at the real clock opens the month it stands in (asserted inside the DENY test of CMD051) `[a51deny]` | N/A: service identity only | N/A: one row |
| W2: close a due period through CMD051 | **GAP** `PERIODS_RACE`: two sweepers closing the same period (see CMD051 RETRY: same-key replay) | **GAP** `CLOSE_TMO`: see CMD051 | **C** a close dates the period from the calendar fake; a later close through period-close-<periodId> keeps the journal COMMITTED `[a51ok]`, `[a51deny]` | **GAP** `SWEEP_CRASH`: crash before CMD051 commits | **GAP** `CLOSE_CRA`: crash after CMD051 commits | **C** same key period-close-<periodId> replays the same statements `[a51race]` | N/A: service identity only | N/A: CMD051's own COMMIT |

## Summary

Tables: 23. Cells: 328. Covered (C): 107. GAP: 134. N/A: 87.

## GAP list, by risk

Tier 1 = money or authority (a wrong outcome pays, withholds or attributes money, or admits a revoked actor). Tier 2 = ledger and data integrity (a wrong outcome corrupts the cumulative ledger, a slot or a window). Tier 3 = availability and operability (the wrong outcome is a retriable error or a lost response). Within tier 1 the order is by money impact (payout, then statements, then replacement, then attribution); within the other tiers by number of cells. Each proposed title follows the existing convention (`RACE ...`, `DENY ...`) and is the test-first input of B10-INTEGRATION and of the Codex review.

### Tier 1

1. `PAY_CASH_RACE` (1 cell): CMD052: two approvals of two different statements, each payable within the bank cash but not both, race on the cash read.  
   Proposed test: `RACE: two ApproveCommissionPayout calls on two statements whose payables each fit the bank-available cash but not together admit one intent and refuse the other FUNDS_UNAVAILABLE, in both orders`  
   Cells: CMD052 ApproveCommissionPayout / RACE

2. `PAY_REV` (1 cell): CMD052: KAURO_OWNER grant revoked or step-up expiring between guard and COMMIT.  
   Proposed test: `RACE: a KAURO_OWNER grant revoked while ApproveCommissionPayout waits on the statement row refuses with NOT_AUTHORIZED and writes no intent; a step-up older than its window at the database instant is ASSURANCE_REQUIRED`  
   Cells: CMD052 ApproveCommissionPayout / EXPIRY

3. `PAY_DEST_RACE` (1 cell): CMD052: a payout-destination change committed between the payee check and the intent insert (R2-103 is only sequential).  
   Proposed test: `RACE: a payout-destination change racing ApproveCommissionPayout serializes in both orders: the intent binds the destination VERIFIED at its commit, or the approval is 409 PAYEE_UNVERIFIED, never a half-verified one`  
   Cells: CMD052 ApproveCommissionPayout / REVOCATION

4. `PAY_SETTLE_FLIP` (1 cell): CMD053: SETTLED evidence applied, then FAILED or RETURNED evidence (or the reverse) for the same intent; the design has no SETTLED to RETURNED edge.  
   Proposed test: `RACE: SETTLED and RETURNED evidence for one intent delivered in both orders: the first terminal state stands, the second is refused PAYOUT_EVIDENCE_MISMATCH or INTENT_TERMINAL, no line leaves PAID and the contradiction is a visible case`  
   Cells: CMD053 ReconcileCommissionPayout / RACE

5. `CLOSE_VS_DELIVERY` (1 cell): CMD051: a COMMISSIONS record with occurred_at before the cutoff delivered between the INPUTS_UNRECONCILED check and COMMIT (the existing race is a refund adjustment on the ledger, not a late delivery).  
   Proposed test: `RACE: a capture.completed.v1 delivery with occurred_at before the cutoff racing CloseCommissionPeriod: the close is INPUTS_UNRECONCILED or includes the line, never a statement that omits it, in both orders`  
   Cells: CMD051 CloseCommissionPeriod / REVOCATION

6. `REPL_REVOKE` (3 cells): CMD027 replacement: the paid entitlement consumed (execution started) or its order refunded between the intent commit and the re-binding.  
   Proposed test: `RACE (replacement): execution starting between the replacement's intent and its re-binding withdraws the replacement with EXECUTION_STARTED, the old entitlement stays, the allowance is not spent`  
   Cells: CMD027 included-replacement protocol / REVOCATION; CMD027 included-replacement protocol / REVOCATION; CMD027 included-replacement protocol / REVOCATION

7. `TERM_ACCRUAL` (1 cell): COMMISSIONS accrual racing CMD050: the line of a capture.completed.v1 accrued while the seller terminates.  
   Proposed test: `RACE: capture.completed.v1 accrual racing TerminateSeller in both orders: one line, same share, entitlement TERMINATED_WITH_RESIDUAL, inside the window nothing lost`  
   Cells: Sweep ENTITLEMENT_WINDOWS / REVOCATION

8. `TERM_ACCEPT` (2 cells): CMD050 against CMD047: termination racing an acceptance that names the seller's claim (planned for B10-INTEGRATION).  
   Proposed test: `RACE: TerminateSeller racing AcceptAttribution of the seller's claim in both orders: the allocation is frozen with the seller before the termination (claim in the manifest or tail) or the acceptance is refused SELLER_NOT_ACTIVE, never a share for a TERMINATED seller without tail`  
   Cells: CMD047 AcceptAttribution / REVOCATION; CMD050 TerminateSeller / REVOCATION

9. `PAY_APPROVE_VS_FAIL` (1 cell): CMD052 racing CMD053 FAILED or RETURNED of an earlier intent of the same statement (statement APPROVED to ISSUED while a second approval waits).  
   Proposed test: `RACE: ApproveCommissionPayout racing the FAILED reconciliation of the statement's earlier intent yields at most one live intent in both orders`  
   Cells: CMD052 ApproveCommissionPayout / RACE

10. `REPL_TMO` (1 cell): CMD027 replacement: PurchaseRebinder times out after the intent committed (re-binding of a paid purchase).  
   Proposed test: `RACE (replacement): a re-binding that times out leaves the replacement ISSUED with its journal entry open, the same key observes the re-binding by its identity and never re-binds twice, and the answer is the retriable 202`  
   Cells: CMD027 included-replacement protocol / TIMEOUT

11. `QE_CAPTURE_RACE` (1 cell): QUOTE_EXPIRY sweep racing a capture that settles (hold versus consume), interleaved in both orders.  
   Proposed test: `RACE: a capture settling while the QUOTE_EXPIRY sweep decides on its reservation: the slot is consumed once or released once, never both, in both orders`  
   Cells: Sweep QUOTE_EXPIRY / RACE

12. `SLOT_RELEASE_RACE` (1 cell): CMD027 supersession, CMD043 withdrawal and the QUOTE_EXPIRY sweep racing on one quote and its reservation.  
   Proposed test: `RACE: the QUOTE_EXPIRY sweep racing a superseding CreateQuote of the same quote releases its slot exactly once in both orders, and the slot is free for exactly one next reservation`  
   Cells: CMD027 CreateQuote (issuance) / REVOCATION

13. `CLAIM_LAPSE_ACCEPT` (3 cells): CMD047 against the CLAIM_WINDOWS sweep: a claim lapsing at its review deadline while accepted.  
   Proposed test: `RACE: AcceptAttribution racing the CLAIM_WINDOWS lapse of the same claim at its deadline: one wins in both orders; accepting a lapsed claim is 409 CLAIM_EXPIRED and writes no allocation`  
   Cells: CMD047 AcceptAttribution / RACE; CMD050 TerminateSeller / EXPIRY; Sweep CLAIM_WINDOWS / RACE

14. `CLAIM_DEADLINE` (2 cells): CMD047 on a claim past its 2160 h review deadline whose sweep has not yet run (the database clock decides, as S060 does for sources).  
   Proposed test: `DENY: AcceptAttribution of a SUBMITTED claim past its review deadline on the database clock, before the sweep ran, is 409 CLAIM_EXPIRED and writes nothing`  
   Cells: CMD047 AcceptAttribution / EXPIRY; CMD047 AcceptAttribution / EXPIRY

15. `CORP_REV` (1 cell): CMD045, CMD047, CMD048, CMD049, CMD050: KAURO_OWNER grant revoked (or step-up expired for CMD049) between the guard and COMMIT.  
   Proposed test: `RACE: a KAURO_OWNER grant revoked while the command waits on its row refuses with NOT_AUTHORIZED and writes nothing (one per command)`  
   Cells: CMD049 ActivateSeller / REVOCATION

16. `TEN_REV` (4 cells): CMD002, CMD043 and CMD027: the agency OWNER or AGENCY_BILLING membership removed, or the step-up of CMD043 expiring, between the guard and COMMIT.  
   Proposed test: `RACE: removing the acting OWNER membership while the command waits refuses with NOT_AUTHORIZED and writes nothing; CMD043: a step-up older than its window at the database instant is ASSURANCE_REQUIRED`  
   Cells: CMD002 ActivateAgency / REVOCATION; CMD043 CloseAgency / REVOCATION; CMD043 CloseAgency / REVOCATION; CMD027 CreateQuote (issuance) / REVOCATION

17. `QUOTE_CLOSE` (2 cells): CMD027 racing CMD043 (new quote against a closure), both orders.  
   Proposed test: `RACE: CreateQuote racing CloseAgency of the same agency in both orders: the quote commits first and is WITHDRAWN by the closure with its reservation released, or the closure commits first and the quote is AGENCY_NOT_ACTIVE`  
   Cells: CMD043 CloseAgency / RACE; CMD027 included-replacement protocol / RACE

18. `CLOSE_INFLIGHT` (1 cell): CMD043 against a capture, webhook or refund request arriving between the inventory and COMMIT.  
   Proposed test: `RACE: a capture settling or a refund request filed while CloseAgency runs: the closure lists it in its inventory or is CLOSURE_OBLIGATIONS_UNRECONCILED, never a closure that omits a live obligation, in both orders`  
   Cells: CMD043 CloseAgency / RACE

19. `TAIL_PURCHASE_RACE` (1 cell): CMD050: an agency's first purchase designated between the manifest check and COMMIT.  
   Proposed test: `RACE: an agency's first-purchase designation racing TerminateSeller whose manifest names that agency's claim: the entry is TAIL_NOT_ENUMERATED or the tail precedes the purchase, in both orders`  
   Cells: CMD050 TerminateSeller / RACE

20. `SELLER_ACT_RACE` (3 cells): CMD045 and CMD046 against CMD050: a seller terminated between the ACTIVE check and the write.  
   Proposed test: `RACE: TerminateSeller racing RegisterProspect or ClaimProspect of the seller in both orders: the write commits before the termination and is handled by it, or is refused SELLER_NOT_ACTIVE`  
   Cells: CMD045 RegisterProspect / REVOCATION; CMD046 ClaimProspect / REVOCATION; CMD048 AssignAccount / REVOCATION

21. `CLOSE_CAL` (1 cell): CMD051: a newer VERIFIED_FEED banking-calendar version recorded between the calendar read and COMMIT.  
   Proposed test: `RACE: a banking-calendar version recorded while CloseCommissionPeriod runs: the statement stores the version it read and its pay date follows that version, in both orders`  
   Cells: CMD051 CloseCommissionPeriod / RACE

22. `PAY_VERIFIER_TMO` (1 cell): CMD053: PayoutEvidenceVerifier times out or answers ambiguously (PayoutEvidenceVerifier is a port to B15).  
   Proposed test: `DENY: a PayoutEvidenceVerifier that times out answers the retriable 503 PAYOUT_EVIDENCE_UNAVAILABLE, nothing changes, and the same key then settles once`  
   Cells: CMD053 ReconcileCommissionPayout / TIMEOUT

23. `PAY_CRA` (2 cells): CMD052 and CMD053: response lost after COMMIT (retry replays; the injected loss is not tested).  
   Proposed test: `RACE (crash after COMMIT): the response lost after the intent (or settlement) commits is recovered by the same key as the same answer, one intent, one settlement`  
   Cells: CMD052 ApproveCommissionPayout / CRASH-AFTER; CMD053 ReconcileCommissionPayout / CRASH-AFTER

24. `CLOSE_CRA` (2 cells): CMD051 and the PERIODS sweep: crash after the close COMMITs and before the sweep records the result.  
   Proposed test: `RACE (crash after COMMIT): the PERIODS sweep stopped after CloseCommissionPeriod committed re-runs under period-close-<periodId> and replays the same statements, no second set`  
   Cells: CMD051 CloseCommissionPeriod / CRASH-AFTER; Sweep PERIODS / CRASH-AFTER

25. `CLOSE_TMO` (3 cells): CMD051: BankingCalendarSource or the cutoff recomputation exceeding a timeout.  
   Proposed test: `DENY: a BankingCalendarSource that times out answers the retriable failure, the period stays OPEN, and the same journal key period-close-<periodId> then closes once`  
   Cells: CMD051 CloseCommissionPeriod / TIMEOUT; CMD051 CloseCommissionPeriod / TIMEOUT; Sweep PERIODS / TIMEOUT

### Tier 2

26. `SWEEP_CRASH` (14 cells): A sweep effect stopped before or after its COMMIT (each effect is its own SERVICE unit of work).  
   Proposed test: `RACE (crash): a sweep stopped before an effect's COMMIT leaves nothing and the next pass applies it once; stopped after, the next pass finds it done and adds nothing`  
   Cells: Sweep QUOTE_EXPIRY / CRASH-BEFORE; Sweep QUOTE_EXPIRY / CRASH-AFTER; Sweep QUOTE_EXPIRY / PARTIAL; Sweep CLAIM_WINDOWS / CRASH-BEFORE; Sweep CLAIM_WINDOWS / CRASH-AFTER; Sweep ENTITLEMENT_WINDOWS / CRASH-BEFORE; Sweep ENTITLEMENT_WINDOWS / CRASH-AFTER; Sweep ACCRUAL_RECONCILIATION / CRASH-BEFORE; Sweep ACCRUAL_RECONCILIATION / CRASH-AFTER; Sweep ELIGIBILITY / CRASH-BEFORE; Sweep ELIGIBILITY / CRASH-AFTER; Sweep PERIODS / CRASH-BEFORE; Sweep PERIODS / CRASH-AFTER; Sweep PERIODS / CRASH-BEFORE

27. `CONS_CRA` (5 cells): COMMISSIONS: crash after an effect commits and before the outbox delivery is marked (a redelivery must add nothing).  
   Proposed test: `RACE (crash after COMMIT): a dispatcher stopped after the accrual committed and before the delivery was settled redelivers and the accrual adds no pool, line or adjustment`  
   Cells: COMMISSIONS consumer: capture.completed.v1 / CRASH-AFTER; COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1 / CRASH-AFTER; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / CRASH-AFTER; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / CRASH-AFTER; COMMISSIONS dispatcher lease (OUTBOX_DISPATCH) / CRASH-AFTER

28. `CONS_CRB` (5 cells): COMMISSIONS: crash injected before an effect's COMMIT leaves nothing and the delivery stays unsettled.  
   Proposed test: `RACE (crash before COMMIT): a dispatcher stopped before the effect commits leaves no pool, line or adjustment, and the redelivery produces them once`  
   Cells: COMMISSIONS consumer: capture.completed.v1 / CRASH-BEFORE; COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1 / CRASH-BEFORE; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / CRASH-BEFORE; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / CRASH-BEFORE; COMMISSIONS dispatcher lease (OUTBOX_DISPATCH) / CRASH-BEFORE

29. `CONS_TMO` (5 cells): COMMISSIONS: PreparationCompletionSource (D10-SVC-4) timing out inside an effect.  
   Proposed test: `DENY: a PreparationCompletionSource that times out leaves the line ACCRUED_PENDING with the delivery unsettled and the next pass completes it once`  
   Cells: COMMISSIONS consumer: capture.completed.v1 / TIMEOUT; COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1 / TIMEOUT; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / TIMEOUT; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / TIMEOUT; Sweep ELIGIBILITY / TIMEOUT

30. `SWEEP_TMO` (5 cells): A sweep's call-out (QUOTE_EXPIRY to the payment service's release guard; ELIGIBILITY to PreparationCompletionSource) times out.  
   Proposed test: `DENY: a timed-out release guard keeps the reservation RECONCILIATION_HOLD or RESERVED (never RELEASED), and the next pass decides it once`  
   Cells: Sweep QUOTE_EXPIRY / TIMEOUT; Sweep CLAIM_WINDOWS / TIMEOUT; Sweep ENTITLEMENT_WINDOWS / TIMEOUT; Sweep ACCRUAL_RECONCILIATION / TIMEOUT; Sweep PERIODS / TIMEOUT

31. `SWEEP_RACE` (4 cells): A sweep racing a second sweep instance or the command that touches the same row.  
   Proposed test: `RACE: two sweep passes over the same work item produce one effect (one release, one lapse, one expiry, one hold release, one line set), in both orders`  
   Cells: Sweep QUOTE_EXPIRY / RETRY; Sweep CLAIM_WINDOWS / RETRY; Sweep ENTITLEMENT_WINDOWS / RETRY; Sweep ELIGIBILITY / RETRY

32. `CONS_REV` (3 cells): COMMISSIONS: an entitlement terminated or expired, or a seller terminated, between the delivery and the accrual.  
   Proposed test: `RACE: ENTITLEMENT_WINDOWS expiring an entitlement at the instant of a capture.completed.v1 for a purchase completed one second before: the line is accrued by the provider-completion instant, never by the processing instant`  
   Cells: COMMISSIONS consumer: capture.completed.v1 / REVOCATION; COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1 / REVOCATION; Sweep ENTITLEMENT_WINDOWS / RACE

33. `CONS_DUP_LINE` (2 cells): COMMISSIONS: refund.completed.v1 and capture.reversed.v1 racing each other and the completion in concurrent dispatchers (the existing order test is sequential).  
   Proposed test: `RACE: two dispatchers (lease handover) applying the refund and the reversal of one capture concurrently end at the same cumulative entitlements`  
   Cells: COMMISSIONS consumer: refund.completed.v1 and capture.reversed.v1 / RACE; COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / RACE

34. `ELIG_REV` (2 cells): ELIGIBILITY racing a hold opened by B12 or a refund adjustment between the eligibility read and the PAYABLE transition (KC007 is checked at the database; the interleaving is untested).  
   Proposed test: `RACE: a hold opened (or a refund adjustment applied) while the ELIGIBILITY sweep makes the line ELIGIBLE: the line is HELD or ELIGIBLE with the adjusted cumulative, never ELIGIBLE under a covering hold, in both orders`  
   Cells: COMMISSIONS consumer: capture.funds_observed.v1 and commercial_authorization.delivered.v1 / RACE; Sweep ELIGIBILITY / RACE

35. `PERIODS_RACE` (2 cells): PERIODS: two sweepers opening the same month or closing the same period.  
   Proposed test: `RACE: two PERIODS passes opening the same month or closing the same due period produce one period and one statement set (journal key period-close-<periodId>)`  
   Cells: Sweep PERIODS / RACE; Sweep PERIODS / RACE

36. `BUYER_TMO` (2 cells): CMD027 and CMD047: BuyerTypeReader timing out or answering unset after a change mid-way.  
   Proposed test: `DENY: a BuyerTypeReader that times out answers the retriable failure and writes nothing; the same key then succeeds once`  
   Cells: CMD027 CreateQuote (issuance) / TIMEOUT; CMD047 AcceptAttribution / TIMEOUT

37. `CONS_LEASE_EXP` (1 cell): COMMISSIONS: lease expiring while an effect is in flight, a second dispatcher taking over, the first's late COMMIT fenced.  
   Proposed test: `RACE: a lease expiring between an effect's reads and its COMMIT lets the takeover run it, and the former owner's late COMMIT is refused by its stale fence`  
   Cells: COMMISSIONS dispatcher lease (OUTBOX_DISPATCH) / RACE

38. `ACCRUAL_REC_RACE` (1 cell): ACCRUAL_RECONCILIATION racing the COMMISSIONS accrual of the same purchase (both write the pool).  
   Proposed test: `RACE: ACCRUAL_RECONCILIATION racing capture.completed.v1 for the same purchase yields one pool and line set in both orders`  
   Cells: Sweep ACCRUAL_RECONCILIATION / RACE

39. `TOCTOU_SOURCE` (1 cell): CMD027: the source's retention deadline passing between the availability read and COMMIT (S060 covers a deadline already passed).  
   Proposed test: `RACE: the source deadline passing while CreateQuote holds its locks: the quote's availability is never later than the deadline, or the quote is SOURCE_EXPIRED, never an ISSUED quote past it`  
   Cells: CMD027 CreateQuote (issuance) / EXPIRY

### Tier 3

40. `CMD_TMO` (21 cells): A lock wait or statement running past its timeout, on any command: nothing written and the same key can retry.  
   Proposed test: `RACE (timeout): the wait on a locked row held past the lock timeout answers the retriable failure with nothing written, and the same key then completes once (one per command)`  
   Cells: CMD002 ActivateAgency / TIMEOUT; CMD002 ActivateAgency / TIMEOUT; CMD043 CloseAgency / TIMEOUT; CMD043 CloseAgency / TIMEOUT; CMD043 CloseAgency / TIMEOUT; CMD027 CreateQuote (issuance) / TIMEOUT; CMD027 CreateQuote (issuance) / TIMEOUT; CMD027 CreateQuote (issuance) / TIMEOUT; CMD027 included-replacement protocol / TIMEOUT; CMD027 included-replacement protocol / TIMEOUT; CMD045 RegisterProspect / TIMEOUT; CMD046 ClaimProspect / TIMEOUT; CMD047 AcceptAttribution / TIMEOUT; CMD047 AcceptAttribution / TIMEOUT; CMD048 AssignAccount / TIMEOUT; CMD049 ActivateSeller / TIMEOUT; CMD050 TerminateSeller / TIMEOUT; CMD050 TerminateSeller / TIMEOUT; CMD052 ApproveCommissionPayout / TIMEOUT; CMD052 ApproveCommissionPayout / TIMEOUT; CMD053 ReconcileCommissionPayout / TIMEOUT

41. `CMD_CRA` (13 cells): Crash or lost response after COMMIT: the retry replay is tested, the injected loss is not.  
   Proposed test: `RACE (crash after COMMIT): the response lost after COMMIT is recovered by the same key as the same answer (one per command)`  
   Cells: CMD002 ActivateAgency / CRASH-AFTER; CMD043 CloseAgency / CRASH-AFTER; CMD043 CloseAgency / CRASH-AFTER; CMD027 CreateQuote (issuance) / CRASH-AFTER; CMD027 CreateQuote (issuance) / CRASH-AFTER; CMD027 CreateQuote (issuance) / CRASH-AFTER; CMD027 included-replacement protocol / CRASH-AFTER; CMD045 RegisterProspect / CRASH-AFTER; CMD046 ClaimProspect / CRASH-AFTER; CMD047 AcceptAttribution / CRASH-AFTER; CMD048 AssignAccount / CRASH-AFTER; CMD049 ActivateSeller / CRASH-AFTER; CMD050 TerminateSeller / CRASH-AFTER

42. `CMD_PAR` (2 cells): A failure between the statements of one command (injected at an inner statement) rolls the whole back.  
   Proposed test: `RACE (partial): a failure injected at the second write of the command commits nothing and the same key completes once (one per command)`  
   Cells: CMD027 CreateQuote (issuance) / PARTIAL; CMD027 included-replacement protocol / PARTIAL

43. `AGREEMENT_EXP` (2 cells): CMD002 and CMD046: the published agreement version being superseded while the step runs.  
   Proposed test: `RACE: a new agreement version published while the command waits: the command binds the version published at its locks, or is AGREEMENT_VERSION_MISMATCH`  
   Cells: CMD002 ActivateAgency / EXPIRY; CMD046 ClaimProspect / EXPIRY

44. `LEASE_CRASH` (2 cells): Dispatcher lease: a dispatcher process crash after claim and before its first heartbeat; a clock jump of the holder.  
   Proposed test: `RACE: a dispatcher stopped right after its claim is taken over after the lease expiry under the next fence on the controlled clock, and its claimed deliveries are redelivered once`  
   Cells: COMMISSIONS dispatcher lease (OUTBOX_DISPATCH) / CRASH-BEFORE; COMMISSIONS dispatcher lease (OUTBOX_DISPATCH) / TIMEOUT

45. `CMD_EXP_ASSURE` (1 cell): A fresh step-up expiring in the step (CMD049; CMD043 in TEN_REV, CMD052 in PAY_REV).  
   Proposed test: `DENY: a step-up that passes its window between the guard and COMMIT is ASSURANCE_REQUIRED and the seller stays CANDIDATE`  
   Cells: CMD049 ActivateSeller / EXPIRY

## Test index

Every `[key]` above is one test, cited as `file :: "exact title"`.

- `[a02race]` `apps/api/test/cmd002-activate-agency.test.ts` :: "RACE: an identical retry replays the 200 without a second acceptance, the same key with another billingProfileRef is 409 IDEMPOTENCY_CONFLICT, two keys racing on one expectedVersion yield one activation and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the agency DRAFT with no acceptance"
- `[d02db]` `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD002 at the database: an acceptance names published agreement versions and the accepting OWNER membership of its agency, and acceptances cannot be updated or deleted"
- `[d02ad]` `packages/persistence/test/b10-agency-adapters.test.ts` :: "CMD002 through the adapters: the published agreement versions are read after their shared locks, the acceptance is appended once, and B06's agencies_authority admits the activation only for the agency's current OWNER"
- `[a43race]` `apps/api/test/cmd043-close-agency.test.ts` :: "RACE: an identical retry replays the 200, the same key with another assuranceProofRef is 409 IDEMPOTENCY_CONFLICT, CloseAgency racing CreatePaymentOrder of the agency's issued quote serializes on the agency in both orders — the order commits first and the closure is 409 CLOSURE_OBLIGATIONS_UNRECONCILED, or the closure commits first and the order is refused AGENCY_NOT_ACTIVE — and a crash before COMMIT leaves the agency ACTIVE"
- `[a43new]` `apps/api/test/cmd043-close-agency.test.ts` :: "OK (new work stops): after CloseAgency the agency's ISSUED quote is WITHDRAWN with its founding reservation RELEASED, CreatePaymentOrder and CreateProject of the agency are refused AGENCY_NOT_ACTIVE, and its sellers' commission lines are unchanged with their edges to payment intact"
- `[a43deny]` `apps/api/test/cmd043-close-agency.test.ts` :: "DENY: another agency's closure is a foreign tenant (404) and a BILLING member a wrong role (403); then one missing prerequisite at a time — no fresh step-up ASSURANCE_REQUIRED, a stale version STALE_VERSION, a payment order in flight or an uncertain refund CLOSURE_OBLIGATIONS_UNRECONCILED — each leaves the agency and its obligations unchanged"
- `[d43db]` `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD043 at the database: CLOSING to CLOSED is refused while any payment order, refund, live authorization or tax document of the agency is non-terminal or any reconciliation case of the agency is OPEN, an UNKNOWN_REFUND keyed by its provider_ref included (KC006), and no runtime role can delete a commission, fiscal or ledger row of a closing agency"
- `[a27s060]` `apps/api/test/cmd027-create-quote.test.ts` :: "S060 (example 16): a quote's source availability is never later than B07's effective deadline, and CreateQuote on a SEALED revision whose retention deadline has passed on the database clock, the sweeper not yet run, is SOURCE_EXPIRED through SourceAvailabilityReader"
- `[a27des]` `apps/api/test/cmd027-create-quote.test.ts` :: "RACE (snapshot against designation): a CreateQuote held after its shared recurrence lock and a first-purchase designation of the same agency serialize in both orders — the quote's set includes the new purchase with its tier or excludes it wholly, never half"
- `[a27race]` `apps/api/test/cmd027-create-quote.test.ts` :: "RACE: an identical retry replays the 201 with the same quote, the same key with another planId is 409 IDEMPOTENCY_CONFLICT, two keys for one project serialize on its live quote with the wait observed and supersede exactly once, and a crash before COMMIT leaves no quote, snapshot or reservation"
- `[d27core]` `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "CMD027 issuance core: the snapshot's set is inserted from kauro.qualifying_projects_at under the recurrence lock's shared half in the same statement as its count and tier, the founding slot is taken in ascending slot order, and quote_issuances names the journal entry, the quote and the reservation"
- `[a27slot]` `apps/api/test/cmd027-create-quote.test.ts` :: "R2-090 (example 17): two eligible agencies' CreateQuote calls racing for the last founding slot, held at the slot update, yield one quote at 2500 bps with its RESERVED reservation and one at the other agency's own tier with foundingOffer NONE_AVAILABLE, whose answer states that actual price"
- `[d27slot]` `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-090: two agencies' reservations of the last free slot serialize on its row — the second waits, observed in pg_stat_activity, re-checks and takes no slot — in both orders, and three slots never hold four live reservations"
- `[d27res]` `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "R2-127: a reservation ends at its quote's 336-hour expiry, a superseding or replacement quote never inherits or extends it, FoundingOfferReader's preview reserves nothing, and a quote past its price expiry with a payment in flight moves its reservation to RECONCILIATION_HOLD"
- `[a27res]` `apps/api/test/cmd027-create-quote.test.ts` :: "R2-127 (examples 16 and 17): a founding quote reserves one slot until its original 336-hour expiry; a superseding CreateQuote of the same project releases it and issues at the agency's own tier, and no later quote of that agency revives a founding reservation"
- `[d27slotdb]` `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-090 at the database: a slot holds at most one live reservation, an agency holds at most one founding reservation per cohort, a reservation must be named by its quote's snapshot at COMMIT, and a consumed slot is never freed, not by a full refund (KC014)"
- `[d27db]` `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "CMD027 at the database: kauro_app cannot write qualifying_purchases, agency_recurrence or a slot's consumption, a reservation's quote must be an ISSUED quote of its agency, and a replacement quote needs its paid terms"
- `[a27ref]` `apps/api/test/cmd027-create-quote.test.ts` :: "R2-092: a replacement whose re-binding the payment service refuses is withdrawn with its reason, and a second same-band replacement after the allowance is spent is REPLACEMENT_ALLOWANCE_SPENT with nothing written"
- `[a27scope]` `apps/api/test/cmd027-create-quote.test.ts` :: "R2-093 (example 18): a replacement revision of 50001 billable units on a project paid at the 50000-unit band is 409 PRECONDITION_FAILED REPLACEMENT_SCOPE_CHANGED with the band comparison 129500 to 199500 cents, writing no quote, re-binding, order or capture"
- `[a27crash]` `apps/api/test/cmd027-create-quote.test.ts` :: "RACE (replacement): a crash before the replacement's intent commits leaves nothing, a crash between the intent commit and the payment service's re-binding resumes from the journal entry to one re-binding, and a crash after the re-binding completes the same answer — the purchase is never re-bound twice"
- `[a27rep]` `apps/api/test/cmd027-create-quote.test.ts` :: "R2-092 (example 18): on a paid project whose entitlement is ACTIVE, CreateQuote for a new approved plan of a corrected revision in the same band issues a replacement quote carrying the paid terms, re-binds the purchase through PurchaseRebinder, revokes the old entitlement SOURCE_REPLACED and spends the one included allowance — no order, no fee, the new approval required"
- `[a45race]` `apps/api/test/cmd045-register-prospect.test.ts` :: "RACE: an identical retry replays the 201, the same key with another organizationLabel is 409 IDEMPOTENCY_CONFLICT, two sellers registering one organization at once yield one prospect and one 409 PROSPECT_EXISTS with the wait observed, and a crash before COMMIT leaves no prospect"
- `[d45db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD045 at the database: source evidence admits only the AGENCY segment, one live prospect exists per normalized organization key, and a prospect whose organization or contact key is suppressed is refused KC016"
- `[a46race]` `apps/api/test/cmd046-claim-prospect.test.ts` :: "RACE: an identical retry replays the 201, the same key with another evidenceHash is 409 IDEMPOTENCY_CONFLICT, two sellers' claims of one prospect serialize on its claims lock with the wait observed — the second is DISPUTED — and a crash before COMMIT leaves no claim"
- `[a46conf]` `apps/api/test/cmd046-claim-prospect.test.ts` :: "DENY (conflict review): a claim on a prospect with another seller's accepted or live claim is written DISPUTED in the same transaction and owns nothing"
- `[d46db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD046 at the database: a claim needs its seller ACTIVE with that agreement version, one live claim exists per seller and prospect, and a claim's evidence and deadlines cannot change"
- `[a47buy]` `apps/api/test/cmd047-accept-attribution.test.ts` :: "DENY (buyer type, D58): with the buyer-type fake answering unset or IN_HOUSE, AcceptAttribution is 409 PRECONDITION_FAILED BUYER_TYPE_UNSET or IN_HOUSE_NOT_ATTRIBUTABLE and writes nothing; answering AGENCY, the same request freezes the allocation"
- `[a47race]` `apps/api/test/cmd047-accept-attribution.test.ts` :: "RACE: an identical retry replays the 200, the same key with another shareAllocationRef is 409 IDEMPOTENCY_CONFLICT, two acceptances for one agency racing yield one allocation and one ATTRIBUTION_EXISTS with the wait observed, and a crash before COMMIT leaves the claim SUBMITTED"
- `[d47db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD047 at the database: one frozen allocation exists per agency, its shares sum to 10000 bps at COMMIT (KC003) with each beneficiary's pool terms equal to its signed agreement, and no assignment row can reference or alter it"
- `[a47deny]` `apps/api/test/cmd047-accept-attribution.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — shares summing to 9999 SHARES_NOT_WHOLE, a claim submitted after the agency's first payment order CLAIM_AFTER_FIRST_ORDER, a second full-rate seller's allocation for the agency ATTRIBUTION_EXISTS, a stale version — nothing is written and no pool can double"
- `[a48race]` `apps/api/test/cmd048-assign-account.test.ts` :: "RACE: an identical retry replays the 200, the same key with another sellerId is 409 IDEMPOTENCY_CONFLICT, two assignments on one version yield one and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the previous assignment current"
- `[d48db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD048 at the database: account assignments are append-only with one current per agency, and no runtime role can update an entitlement's first capture, window or share or the agency's first designation"
- `[d48ad]` `packages/persistence/test/b10-sales-adapters.test.ts` :: "R2-095 (example 12): reassigning seller A's acquired agency to seller B appends B's current assignment and service assignment while A's entitlement, allocation, window and accrued lines are unchanged row for row"
- `[a49race]` `apps/api/test/cmd049-activate-seller.test.ts` :: "RACE: an identical retry replays the 200, the same key with another agreementId is 409 IDEMPOTENCY_CONFLICT, two activations racing yield one ACTIVE seller with the wait observed, and a crash before COMMIT leaves it CANDIDATE"
- `[d49db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "CMD049 at the database: a seller becomes ACTIVE only with a signed agreement, a confirming legal review, assessment and confidentiality records, a VERIFIED destination and tax documentation (KC005), and a seller's session reads only its own sales rows"
- `[a50race]` `apps/api/test/cmd050-terminate-seller.test.ts` :: "RACE: an identical retry replays the 200, the same key with another manifest is 409 IDEMPOTENCY_CONFLICT, two terminations on one expectedVersion yield one TERMINATED seller and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the seller ACTIVE with its claims and entitlements unchanged"
- `[a50r100]` `apps/api/test/cmd050-terminate-seller.test.ts` :: "R2-100 (example 13): TerminateSeller with a manifest of two enumerated active opportunities records exactly two tail entries ending 2160 h after the effective instant, and the thousand prospects the seller registered from a scraped list gain no tail, claim or entitlement"
- `[d50tail]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-100 at the database: a tail entry exists only for an ACCEPTED unexpired claim of the terminated seller whose agency has no qualifying purchase (KC011), and ends 2160 hours after the termination's effective instant"
- `[d50db]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD050 at the database: no runtime role holds DELETE on any B10 table, and a terminated seller's lines, adjustments, statements and payout rows are unchanged by the termination"
- `[a50deny]` `apps/api/test/cmd050-terminate-seller.test.ts` :: "DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — a manifest entry of an agency that already purchased or of another seller's claim TAIL_NOT_ENUMERATED, a manifest of unclaimed scraped prospects TAIL_NOT_ENUMERATED, no termination terms TERMINATION_TERMS_UNPREPARED, a stale version — nothing is written"
- `[a51deny]` `apps/api/test/cmd051-close-commission-period.test.ts` :: "DENY: a user token or the finance service is a wrong service identity (403) and another period a foreign scope (404); then one missing prerequisite at a time — an undelivered COMMISSIONS record before the cutoff INPUTS_UNRECONCILED, a changed ledger LEDGER_CHANGED, a period not yet due PERIOD_NOT_DUE — and a line awaiting final completion or AVAILABLE funds stays a reasoned hold item, never payable"
- `[d51cal]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-139 at the database: a period's close and pay dates are stored with the calendar version they came from, and a statement closed on a TEST_FIXTURE calendar is labelled SIMULATED"
- `[d51cal2]` `packages/persistence/test/b10-ledger-adapters.test.ts` :: "ledgerOf and statementsOf answer one adapter per unit of work on its own connection, and RecordedBankingCalendarSource answers the latest VERIFIED_FEED version"
- `[a51race]` `apps/api/test/cmd051-close-commission-period.test.ts` :: "RACE: an identical retry replays the 200 with the same statements, the same key with another ledgerCutoffHash is 409 IDEMPOTENCY_CONFLICT, a close racing a refund adjustment serializes on the period in both orders — the adjustment is in this statement or the next, never both or neither — and a crash before COMMIT leaves the period OPEN"
- `[a51ok]` `apps/api/test/cmd051-close-commission-period.test.ts` :: "OK: the commission service closes a due September 2026 period on the test calendar — 200 with one immutable ISSUED statement per seller itemizing each line, dated 2026-10-07 with pay date 2026-10-15 and labelled SIMULATED, its ELIGIBLE lines PAYABLE and the period CLOSED"
- `[d51db]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD051 at the database: a line becomes PAYABLE only through an ISSUED statement item naming it, and a line without a FINAL completion 720 hours old or AVAILABLE funds cannot be ELIGIBLE (KC007)"
- `[d51ad]` `packages/persistence/test/b10-ledger-adapters.test.ts` :: "CMD051 through the adapters: the cutoff hash KAURO_COMMISSION_CUTOFF_V1 over the included lines, adjustments and holds is recomputed identically from the rows and changes with any of them, and statements and their items cannot be updated or deleted"
- `[a51r102]` `apps/api/test/cmd051-close-commission-period.test.ts` :: "R2-102 (examples 21 and 25): CloseCommissionPeriod issues a statement in which the disputed 1000 cents are a held item with its reason and review date, the undisputed 50000 cents are payable, and accrued pending, eligible, held, paid and negative totals are separate"
- `[a52race]` `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "RACE: an identical retry replays the 200, the same key with another payeeRef is 409 IDEMPOTENCY_CONFLICT, two approvals of one statement yield one intent and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the statement ISSUED with no intent"
- `[d52db]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD052 at the database: an intent's amount equals its statement's payable, its payee is a VERIFIED destination version of the statement's seller (KC009), and one live intent exists per statement"
- `[a52r103]` `apps/api/test/cmd052-approve-commission-payout.test.ts` :: "R2-103 (example 22): a seller's bank change just before payout leaves ApproveCommissionPayout 409 PAYEE_UNVERIFIED for the new destination, and an intent authorized earlier keeps its original destination version and digest while the change is pending"
- `[d52sales]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-103 at the database: a payout destination becomes VERIFIED only with the seller's own step-up proof at the change and an owner verification at least 172800 seconds later; a change without that proof stays PENDING_VERIFICATION"
- `[a53race]` `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "RACE: an identical retry replays the 200, the same key with other evidence is 409 IDEMPOTENCY_CONFLICT, two reconciliations of one intent yield one settlement with the wait observed, and a crash before COMMIT leaves the intent AUTHORIZED and the lines PAYABLE"
- `[d53ad]` `packages/persistence/test/b10-ledger-adapters.test.ts` :: "CMD053 through the adapters: settling an intent takes its statement's row lock, so two settlements serialize and the second finds it SETTLED and changes nothing"
- `[a53deny]` `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "DENY: a user token or the commission service is a wrong service identity (403) and an intent of another statement a foreign scope (404); then one missing prerequisite at a time — evidence of another reference, destination or amount PAYOUT_EVIDENCE_MISMATCH, SUBMITTED-only evidence PAYOUT_NOT_SETTLED — nothing changes and the lines stay PAYABLE"
- `[a53r103]` `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "R2-103 (example 22): evidence from the payout-evidence fake naming the new destination for an intent bound to the old one is PAYOUT_EVIDENCE_MISMATCH and changes nothing; only evidence for the bound destination settles it"
- `[d53db]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "CMD053 at the database: a line becomes PAID only when its statement's intent is SETTLED with an evidence hash (KC010), and a FAILED or RETURNED intent is kept with its evidence"
- `[a53ok]` `apps/api/test/cmd053-reconcile-commission-payout.test.ts` :: "OK: the finance service reconciles an intent with SETTLED evidence from the payout-evidence fake matching reference, destination digest, amount and currency — 200 with the intent SETTLED, the statement PAID with the evidence hash and its lines PAID; FAILED or RETURNED evidence keeps the intent FAILED or RETURNED, the statement ISSUED and the lines HELD PAYOUT_FAILED with a review date"
- `[r137]` `apps/api/test/b10-commission-service.test.ts` :: "R2-137 (examples 9 and 10): P confirmed first keeps sequence 1 and its 1000-bps pool; Q, whose authenticated provider completion is earlier but observed later, is sequence 2 at 400 bps inside the window — never a second 1000-bps pool — and a provider completion after its own confirmation is held PROVIDER_TIME_UNVERIFIED"
- `[r137db]` `packages/persistence/test/b10-recurrence-migrations.test.ts` :: "R2-137 at the database: two first captures of one agency confirmed at once serialize on its recurrence lock in both orders — one sequence 1, the other sequence 2 with its own provider completion instant — and neither sequence nor designation can be rewritten (KC001)"
- `[d27uow]` `packages/persistence/test/b10-recurrence-adapters.test.ts` :: "B10 commercial unit of work: the commission and finance services run on kauro_commission and adopt one agency of a durable work item, once and never beside adoptScope; the first designation is mirrored once; kauro.eligibility_findings names B09's fixture quotes and never a quote of the issuance core; KC001 answers INTEGRITY_FAILURE DESIGNATION_REWRITE"
- `[r094]` `apps/api/test/b10-commission-service.test.ts` :: "R2-094: after a first confirmation at 2028-02-29T15:00:00Z, a subsequent capture completed at the provider at 2029-02-28T14:59:59Z accrues a 400-bps line and one completed at 2029-02-28T15:00:00Z accrues no acquisition line"
- `[r138]` `apps/api/test/b10-commission-service.test.ts` :: "R2-138: two subsequent captures completed at the provider one second before and exactly at the local twelve-month endpoint, both notified a day later, accrue 400 bps for the first and no acquisition line for the second"
- `[r140]` `apps/api/test/b10-commission-service.test.ts` :: "R2-140 (example 20): a second full capture of one obligation and a duplicated capture.completed.v1 delivery accrue nothing more — one pool per purchase and source, its basis the allocated service capped by the obligation"
- `[cap]` `apps/api/test/b10-commission-service.test.ts` :: "COMMISSIONS on capture.completed.v1, refund.completed.v1 and capture.reversed.v1: one pool and line per beneficiary per purchase, one adjustment per changed line and event, the first designation mirrored once into agencies.first_qualifying_capture_id with agency.first_purchase_designated.v1, and a replay adds nothing"
- `[l097]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-097 at the database: a pool's cents equal round(basis x rate) and its lines' allocations sum to it at COMMIT (KC002), one pool exists per purchase and source, and an allocation's shares sum to 10000 bps (KC003)"
- `[lkc]` `packages/persistence/test/b10-ledger-adapters.test.ts` :: "KC002, KC007, KC009, KC010, KC015 and KC017 reach their callers as the failures design 12 names"
- `[ord]` `apps/api/test/b10-commission-service.test.ts` :: "B09-R2: a capture's completion, refund completion and reversal delivered to COMMISSIONS in every order end with the same cumulative entitlements, one adjustment per changed line and event, and every line at zero basis after the reversal"
- `[ladj]` `packages/persistence/test/b10-ledger-adapters.test.ts` :: "B09-R2 at the ledger: a commission basis only falls — a refund.completed.v1 after the capture's reversal, and one naming a basis above the line's current basis, append no adjustment, and a replay of any event adds nothing"
- `[r104]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-104 at the database: an offset against a later line is refused without SIGNED_FUTURE_OFFSET terms (KC017), a PAID line moves to ADJUSTED with an appended adjustment, and its paid cents and payout rows never change"
- `[funds]` `apps/api/test/b10-commission-service.test.ts` :: "example 14: capture.funds_observed.v1 HELD moves an otherwise due line HELD FUNDS_HELD with a review date and blocks no unrelated line, and AVAILABLE releases it in the ELIGIBILITY sweep"
- `[r101]` `apps/api/test/b10-commission-service.test.ts` :: "R2-101 (example 15): a parent-stage STAGE completion reported by the preparation-completion fake leaves the line ACCRUED_PENDING, and the FINAL completion 720 hours later with funds available makes it ELIGIBLE in the ELIGIBILITY sweep"
- `[l101]` `packages/persistence/test/b10-ledger-migrations.test.ts` :: "R2-101 at the database: a line becomes ELIGIBLE only with a FINAL completion of its purchase at least 720 hours old and its capture's funds AVAILABLE (KC007)"
- `[lease]` `apps/api/test/b10-commission-service.test.ts` :: "D-LEASE-3: the COMMISSIONS dispatcher's OUTBOX_DISPATCH lease is held against a second dispatcher, is resumed under the next fence by its former owner once it expired, and a dispatcher whose heartbeat is refused settles nothing more"
- `[qe]` `apps/api/test/b10-commission-service.test.ts` :: "R2-127: the QUOTE_EXPIRY sweep expires a founding quote with nothing in flight and releases its slot; with an uncertain capture it holds the reservation in RECONCILIATION_HOLD until the capture consumes the slot or a proved no-capture releases it"
- `[sweeps]` `apps/api/test/b10-commission-service.test.ts` :: "the CLAIM_WINDOWS, ENTITLEMENT_WINDOWS and ACCRUAL_RECONCILIATION sweeps: claims lapse at their deadline with no first purchase, entitlements expire at window end with earned lines unaffected, and an acceptance after the first purchase gains its missing lines once"
- `[r094db]` `packages/persistence/test/b10-sales-migrations.test.ts` :: "R2-094 at the database: an entitlement's window_ends_at must equal twelve calendar months after window_starts_at at the America/Bogota wall time with the day clamped, and its first capture, window, share and agreement cannot change"
