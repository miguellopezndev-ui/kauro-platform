# ACH bank-transfer route — owner amendment A8

Design only, revision **r5** (r4 plus Codex design r4 fixes and the phase-1 Wise port, §6.1): Phase 1 ships ACH receiving with owner-executed, platform-recorded outbound returns
(D-ACH-20, coordinator decision after Codex design rounds r1–r3); automated Wise outbound is Appendix A (Phase 2, not designed
here). Inbound decisions and payer verification are as accepted in r1–r3. Owner decision supplied **2026-10-05**.
Subject `ach/domain-design`, base `main` `61ab903b0e0f24526ac5a3ca1cf6a2f9f1de97ca`. No adapter, command, migration, registry
change or live qualification is delivered here; `ACH-` cases and matrix tests are proposed, not executed evidence. S-B implements
the Wise adapter later; domain/application/persistence changes need their own implementation and review gates. Read alongside
[B09 payments](B09-payments-fiscal.md), [B09 cases](B09-case-map.md), `packages/domain/src/commerce/{provider,capture,records,
ledger}.ts`, `packages/application/src/commerce/{protocol,ports}.ts`, `core/{provider-effects,observation,postings}.ts` and
migrations 0013 and 0015–0017.

## 1. Scope and decisions

**D-ACH-01 — A8 boundary.** Receive customer-initiated **USD ACH credits into the owner's Wise Business USD account details**.
This is a push transfer; Kauro does not debit a customer's bank, hold a direct-debit mandate or implement recurring billing.
PayPal Business remains implemented and becomes the secondary immediate checkout route. Launch may remain PayPal-only while
Wise KYC, details or access are unavailable. Wise is never inferred usable from incorporation, an API token, a successful
sandbox test or a configured route name.

When ACH is ENABLED, US customer copy is exactly **“Recommended: US bank transfer / ACH”** and
**“Alternative: PayPal / card”**. Otherwise display the PayPal checkout only. No ACH details appear when ACH is not ENABLED.
Each purchase is a project under [A3](../COMMERCIAL_AMENDMENT_A3.md); periodic projects are separate purchases, not subscriptions.
BILL and Melio may be how customers send money to these details; there is no integration, webhook or status dependency on
either. Foreign customers see USD, never COP. Bancolombia is Colombian treasury only. Colombian customer COP collection,
conversion, domestic taxes and local payment UX are separate and outside this design. Incoming wire/Swift, conversion credits,
owner top-ups and unrelated Wise activity must not be classified as customer ACH payments.

**D-ACH-02 — Configuration and qualification.** Add a route-specific qualification record to the existing payment route,
not a second route registry. Its machine is:

| From | Action | To | Guard |
|---|---|---|---|
| absent | configure | PENDING_VERIFICATION | `provider=wise`, USD, exact environment/account identity; default disabled |
| PENDING_VERIFICATION | verify | VERIFIED | Real Wise Business KYC acceptance and ownership, usable domestic USD ACH details, evidence and review recorded |
| VERIFIED | enable | ENABLED | Owner step-up; current details, fee configuration, manual operational readiness and rollout configuration |
| ENABLED | disable | VERIFIED | Owner step-up or service safety stop; no new details served, existing receipts still observed |
| VERIFIED or ENABLED | verification withdrawn/details changed | PENDING_VERIFICATION | Preserve old snapshots; invalidate new issuance; require new verification |

An initially unqualified B09 route stays `PaymentRoute.state=CONFIGURED` while PENDING_VERIFICATION or VERIFIED and becomes
`QUALIFIED` only when ENABLED and all B09 legal, fiscal and integration guards pass. A previously enabled route stays SUSPENDED
while disabled or awaiting renewed verification; re-enablement proposes an explicit versioned SUSPENDED→QUALIFIED edge (not
currently supported). Both the route-specific and the B09 qualification guards are required; never alias VERIFIED to QUALIFIED.
These transitions share the provider/environment route lock; qualification events, aggregate registration, bindings and
constraints are added together in a later migration. Versioned configuration freezes route/version, environment, integration
class, legal owner evidence, merchant/account/profile/USD balance refs, payee digest, encrypted account-details
artifact/version/hash, ACH rail capability evidence, verifier and date, credential reference if any, fee-policy version,
instruction lifetime, observation overlap policy, manual/API mode, enabled flag and outbound capabilities. `CONTRACT_FAKE` never
qualifies LIVE. Account or payee replacement is a new route version, never reassignment of old orders; old account versions are
polled until every receipt/refund is resolved. API credentials are optional for the first manual route and never ownership proof.
Production enablement has two stages: owner verification plus operational guards enables a controlled real-credit exercise;
broader exposure requires that exercise to pass (§8). A failed exercise disables ACH. This does not gate PayPal launch.

**D-ACH-03 — Reuse boundary.** Use the existing quote, project PaymentOrder, CaptureFact, CommercialAuthorization, Refund,
observation/reconciliation records, FINANCE/FISCAL/COMMISSIONS consumers and append-only commerce ledger. Phase 1 has no outbound
provider effect: returns are owner-executed in Wise and recorded (D-ACH-20/21). Do not invent a Wise “order
created” response, approval URL or synthetic charge attempt to issue instructions. The inbound credit itself is the provider
capture identity; `CaptureFact` already permits an absent attempt. The bank-credit register tracks observation identity,
matching and evidence, not another payable order or monetary ledger.

## 2. Instructions and order states

**D-ACH-04 — Issue instructions.** The billing member uses the existing checkout authority (`AGENCY_BILLING`, live verified
identity/membership) and exact accepted quote/terms. Route selection is part of the existing payment intent hash. An ACH branch
of CreatePaymentOrder atomically reserves its journal, locks checkout facts in B09 order, accepts terms, creates INTENT_CREATED,
records the reference/instruction snapshot and transitions to AWAITING_TRANSFER, with scope rows, version events, outbox and
journal result. No provider call occurs. Replay returns that order; the same key with another route/amount/quote conflicts.
The existing unique open-order-per-project guard must include both new open states and apply across PayPal and ACH.

Reference format proposal: `K` + 20 random Crockford-base32 symbols + two checksum symbols, presented in groups for typing.
Generate 100 random bits with the server CSPRNG, enforce account/environment-wide uniqueness, retry collisions before commit,
and never derive from project/customer IDs. The checksum detects mistakes; it adds no entropy. Normalize only ASCII case,
documented spaces and hyphens; reject all other substitutions, truncation and fuzzy matching. A real-credit test must prove
the entire 23-character canonical token survives the sending and receiving rail. If it does not, keep general exposure off
and revise the versioned format; never silently reduce entropy. Bind it permanently to one order, account/version and
environment; never recycle it after expiry. It is a matching hint, not bearer authorization, and there is no public lookup by
reference. Rate-limit authenticated lookup and redact references from telemetry.

Instructions contain beneficiary/legal name, bank name, domestic ACH routing number, account number/type and required ACH
fields **from verified details**, exact USD amount (integer cents rendered with two decimals), reference/copy controls,
deadline in UTC and customer-local display, and a warning that initiating a transfer is not confirmation of payment. They
show a read-only snapshot/version and advise the customer to pay exactly the displayed amount with that reference. No inferred
wire routing number, conversion option, blanket fee promise or guaranteed delivery time. The customer pays from their bank.

The sensitive projection reads current route status under its guard and retrieves the frozen details only for an authorized
member with a current session while ENABLED and before the instruction deadline. Responses are `Cache-Control: no-store`; no service-worker/CDN cache, analytics body,
email attachment or application log gets full account details. If disabled, the order still exists but details are hidden;
the view directs the customer to contact billing. Already copied details cannot be revoked remotely.

Freeze `transferExpiresAt = min(issue time + configured lifetime, quote price expiry, source availability deadline,
any shorter legal/capability/capacity validity deadline)`. Require a future deadline. No implicit grace period or extension of
source retention. Read freshness at the effect after waits using the server/effect clock, rather than only transaction-start
time (the concern addressed by migration 0038). Expiry means **no new service entitlement**, not proof that a credit is impossible.

**D-ACH-05 — State vocabulary.** Extend the existing PaymentOrder machine only for `routeKind=BANK_TRANSFER`; keep all PayPal
edges and meanings. PAID, OVERPAID and REFUND_PENDING below are customer projection labels, not competing financial facts.

| Stored order state / proposed edge | Customer presentation | Financial/authority meaning |
|---|---|---|
| INTENT_CREATED→AWAITING_TRANSFER (`instructions_issued`) | AWAITING_TRANSFER | Snapshot committed; zero confirmed matched money; no authorization |
| AWAITING_TRANSFER→PARTIALLY_RECEIVED (`partial_credit_applied`) | PARTIALLY_RECEIVED, received/remaining cents | One or more real credits allocated below the obligation; no execution authority |
| AWAITING_TRANSFER→CAPTURED (`exact_credit_applied`) | PAID if authorization valid, otherwise PAYMENT_RECEIVED_REVIEW | One exact credit alone pays the obligation; normal capture and subject guards decide authority |
| AWAITING_TRANSFER or PARTIALLY_RECEIVED→RECEIVED_REVIEW (`non_exact_receipt_closed`) | OVERPAID or PAYMENT_RECEIVED_REVIEW | Non-exact credits reach/exceed obligation; money recorded; no new authority |
| PARTIALLY_RECEIVED→PARTIALLY_RECEIVED (`additional_partial_applied`) | Updated PARTIALLY_RECEIVED | New credit/version/event; allocation capped; reference unchanged |
| AWAITING_TRANSFER or PARTIALLY_RECEIVED→EXPIRED (`transfer_deadline_reached`) | EXPIRED, money received if any | Stop instructions/payment claims; partial funds remain refundable; no deletion |
| Any receipt-bearing state | REFUND_PENDING overlay while a Refund is APPROVED/SUBMITTING/UNCERTAIN | Does not change order or capture history; request alone is labelled REFUND_REQUESTED |
| CAPTURED, RECEIVED_REVIEW, EXPIRED | Return/reversal overlays | Terminal receipt history; late/extra credits and returns may be appended without resurrection |

RECEIVED_REVIEW is closed to further instructions/new service purchases; it is not a live payment attempt. CAPTURED remains
B09's historical receipt state even after refund or reversal. An exact credit received after deadline may leave EXPIRED with a
completed capture, but never changes it to PAID. A verified return changes Refund/CaptureFact/authorization facts, not history.

**D-ACH-06 — Exact-payment policy for the first release.** Preserve `authorizesObligation` and SQL guard KP004: **one COMPLETED
capture must equal the quote amount and allocate its full service/tax with zero excess**, plus all purchased-subject guards.
Do not synthesize one capture from several bank transactions. A USD 400 + USD 600 receipt against USD 1,000 records USD 1,000
allocated, moves to RECEIVED_REVIEW, and grants no authority. A USD 1,010 single credit records USD 1,000 obligation and USD 10
excess but also grants no authority. The owner returns the receipts using the existing refund components, closes the purchase
under B09 quote-release rules, and issues a new accepted quote/order for an exact payment. The initial partial-payment view
says billing review is needed and does not prompt a top-up as if it would unlock execution. Supporting aggregate-credit
entitlements would require a separate change to the authorization contract and refund/reversal guards; it is not included.

Conversely, two USD 1,000 credits with distinct identities give one authorization from the first eligible credit and USD 1,000
excess from the second (R2-140). The order remains CAPTURED with an OVERPAID/refund overlay. Never take another charge or increase
commission basis. Allocation is monotonic and capped; refunds do not decrease `allocatedCents` or turn the old order payable.

Switching to PayPal requires explicit retirement of the open ACH order under the project lock, before creating a PayPal order.
Propose `transfer_checkout_retired`→EXPIRED with reason ROUTE_SWITCH, distinct from deadline expiry. Any later ACH credit on
that reference is return-only even if its bank timestamp predates retirement. Partial money must be returned/closed before
another checkout; a zero-receipt retirement may expose PayPal immediately with a duplicate-payment warning. The persistent
project purchase guard still prevents a second entitlement across routes/quotes; the open-order index alone is insufficient.

## 3. Observe, match and apply credits

**D-ACH-07 — Durable credit identity and ingress.** A bank-credit observation has `(wise, environment, accountRef, creditId)`
as globally unique identity across all tenants. Encode account identity into provider external IDs used by the existing scope
index (whose current helper omits account), using an immutable versioned encoding that satisfies its length/character limits.
Never deduplicate by amount/date/reference/name. Store provider booking ID, gross/net/fee as separately observed integer minor
units, currency, rail, payee digest, payer evidence digest/ref, reference, provider timestamps, availability/status,
evidence hash/ref, source (`OWNER_MANUAL` proposed in addition to PROVIDER_QUERY), observed time and version. The immutable money
fields must agree across manual and API ingestion. Additional status/fee observations are append-only versions; a changed
immutable amount/payee/reference produces BODY_CONFLICT/PROVIDER_INCONSISTENCY, not an overwritten credit.

Proposed operational states: `DRAFT_MANUAL→OBSERVED` upon owner confirmation; API observations enter OBSERVED directly after
authentication/classification. `OBSERVED→MATCH_REVIEW` for unknown/incomplete/mismatching identity; `OBSERVED` or MATCH_REVIEW
→`MATCHED` after approved attribution; `MATCHED→APPLIED` with one linked CaptureFact. MATCH_REVIEW may become RETURN_REVIEW for
a verified unassigned return; its Refund workflow is then the source of return status. APPLIED stays historical under later
fee/funds/return observations. PENDING or UNRECOGNIZED bank status never counts as completed money. A terminal return remains
linked to the original receipt; it is not a negative new incoming credit. Pending and denied observations have no receipt
posting until provider evidence proves an actual booked credit.
`MATCHED→MATCH_REVIEW` (proposed) returns a matched, unapplied credit to review when its bound payer authorization is no longer
current at apply (D-ACH-17); no capture is written.

The first operational mode is manual: an owner enters the **bank's stable transaction identifier**, not a locally invented
one, plus a restricted bank statement/export artifact and structured facts. Separate confirmation reads that artifact and
compares account, rail, amount/currency/reference/payer and booking state; draft input alone cannot create a capture. If Wise
does not expose a stable ID or trustworthy gross/net evidence, keep MATCH_REVIEW and obtain provider evidence. A screenshot or
customer “sent” notification is insufficient. API ingestion later uses the same identity, matching and application algorithm.

Polling is at least once: a fenced account/environment lease claims a bounded scan, calls outside the transaction, then inserts
each authenticated observation into a durable inbox/credit register before advancing a CAS cursor. Re-read overlapping closed
time windows to cover delayed bookings, reordered pages and statement corrections; periodically re-observe known pending and
recent completed credits for returns, even when their original booking is behind the cursor. The cursor is an adapter token
bound to account/environment/schema version, not `max(bookedAt)`. Cursor advance requires a complete persisted page, never
successful matching of all its credits. Duplicate pages are safe; incomplete pages retain the previous cursor. Provider rate
limits/SCA/credential loss stop progress visibly and retain coverage gaps. A stale worker may add identical evidence, but cannot
advance the cursor or settle work under an expired fence.

**D-ACH-08 — Matching.** Resolve the stored reference/account binding before adopting an agency scope; never trust an agency ID
from a manual/API payload. Under the account-credit uniqueness lock then B09 purchased-subject locks/order row lock:

1. Require exact canonical reference, same account version/payee, provider/environment and ACH rail. No “nearest amount”, payer
   name alone, project label, truncated reference or cross-order auto-allocation. Missing/unknown/ambiguous reference is a
   MATCH_REVIEW case; no agency is guessed. An owner may attribute it only with independently verified customer billing evidence
   plus provider transaction evidence, fresh step-up and an immutable reason/decision naming the target order.
2. Require **USD** with separately evidenced gross/net/fee. Currency mismatch is WRONG_CURRENCY; do not convert it or accept a
   tolerance. Amount match is exact to one cent; compare gross receipt with the order obligation. If only net is known and an
   unproven fee is needed to explain the difference, hold review. Known merchant fees reduce net, not the customer's paid gross.
3. Require the payer to agree with the order's accepted legal billing identity or a current VERIFIED PayerAuthorization version
   (payer alias or third-party payer such as the agency's client; D-ACH-17). Compare normalized verified identity and evidence,
   not a name-similarity score. Missing payer data and a changed/unapproved payer both require MATCH_REVIEW; reference knowledge
   is not permission. The match records the authorization version used and why. Route/payee/environment/currency mismatches
   cannot be overridden. Reattribution after APPLIED requires reversal/correction, never a new capture for the same credit.
4. A matched amount mismatch still is real money: apply a capture and normal capped allocation, open AMOUNT_MISMATCH and/or
   EXCESS_CAPTURE and the appropriate owner-review return requests. Matching approval does not waive D-ACH-06 or deadlines.

**D-ACH-09 — Apply atomically.** The payment service, not the app/owner request connection, consumes a confirmed match.
Use B09's subject lock order (agency→capability→approval→revision→target→route→quote→order→capture; retain refund completion
serialization), with the new account-credit coordination lock acquired before that chain. Proposed credit uniqueness lock is
also used by manual/API ingest, attribution and unassigned returns; no operation takes it after acquiring the order.
Every mutable prerequisite is re-read after its lock at the actual effect clock. No transaction spans a provider call.

One application COMMIT contains observation effect, one capture per credit, exact identity binding, monotonic status/allocation
trigger, order edge, authorization **or** visible blockers/cases and remedy/excess refund requests, credit APPLIED link, version
events and outbox. A failure of any write rolls all of these back. On a lost answer, recover by credit ID/order operation;
never insert another capture. A bank credit is mapped to `ObservedCapture` with namespaced credit ID and no invented provider
order identity (`providerOrderId=null`). Later migrations must allow bank-transfer orders without a provider order ID in the
states currently covered by `payment_orders_provider_identity_known`, while retaining PayPal's guard. Extend scope/observation
source contracts explicitly. Existing currency/payee/tenant composite FKs still apply.

Receipt evidence is durable regardless of revoked sales authority. At application, if the deadline is reached, route is revoked,
source expired, approval withdrawn, capability restricted, agency disabled, legal/fiscal configuration invalid or the project
was retired/switched, record the actual capture, deny a new CommercialAuthorization and open the case/remedy return. The
receipt path must therefore separate “may record actual money” from “may issue authority”; do not let an expired actor mint
authority, and do not discard the provider's money because a checkout guard fails. A rejected owner's *confirmation* leaves the
draft untrusted; already confirmed/provider-authenticated observations remain recoverable by the service after that owner
loses their role.

**D-ACH-10 — Expiry and delayed observations.** A sweep uses the same order lock/fence and checks `effectNow >= transferExpiresAt`.
An exact credit applied before deadline wins against expiry; the sweep then preserves CAPTURED. If expiry wins, the old order
stays EXPIRED, even if delayed evidence says Wise booked the credit earlier. This first release intentionally does not apply
B09's provider-dispatched price-expiry exception to passive bank transfers. A sent timestamp is not bank receipt or a local
claim. Confirm/apply immediately while valid; a late receipt is recorded with CAPTURE_WITHOUT_VALID_SUBJECT/late reason and an
owner-review return. Sweep partial receipts into EXPIRED with exact unreturned cents and refund requests, without erasing
captures or prematurely releasing quote/founding reservations. Observe old references indefinitely within the reviewed
financial-record retention policy. End of source-data retention does not delete payment identities/evidence.

## 4. One commerce ledger, actual fees and treasury exceptions

**D-ACH-11 — Reuse financial facts.** Matched incoming credits use the existing CaptureFact allocation and posting arithmetic:
gross receipt debits PSP_RECEIVABLE and credits CONTRACT_LIABILITY service, TAX_PAYABLE tax and CUSTOMER_OVERPAYMENT excess.
These PSP accounts represent the Wise-held balance, not Kauro's Bancolombia cash. Observe fees into `providerFeeCents` and
publish the existing fee event once. Observe availability separately and move only the movable balance into PSP_HELD or
PSP_AVAILABLE, using B09 D-LEDGER-B5/B6. COMPLETED is a booked receipt with reversal risk, not irrevocable bank settlement.
No incoming credit makes BANK_CASH; later withdrawals/settlements require their own bank evidence (R2-085, B15). Revenue
recognition, tax documents, refund tax and commissions retain their existing policies; only allocated service is commission
basis. Never subtract a receiving fee from the quote, invent tax from USD or count an excess return as service revenue.

Unknown-reference/payer credits cannot satisfy CaptureFact's non-null order FK. **No dummy orders and no second balance
register.** Propose an additive treasury receipt source `bank_credit` in the **same ledger tables, account catalogue, balancing
rules and FINANCE consumer**, sourced only by confirmed/authenticated booked credits: DEBIT PSP_RECEIVABLE / CREDIT
CUSTOMER_OVERPAYMENT (unattributed liability); observed fee/availability are booked from credit-version events with the same
arithmetic. Its scope is the closed union member `{kind: RECEIVING_ROUTE, routeId, environment, accountRef}` beside
`{kind: AGENCY, agencyId}`, with source-ownership FKs and service-only cross-scope booking — a versioned extension of the
agency-only ledger scope/source guards, not a fabricated agency, a nullable-tenant RLS bypass or a separate Wise ledger. Tenant
RLS cannot read it; only the fenced payment/finance service and active owner finance authority can.

At application, freeze a credit-version cutoff and its fee/funds/status snapshot under the credit lock with the APPLIED capture
link. Versions through the cutoff belong to the treasury receipt group; later observations become capture versions and cannot
also source treasury postings. At attribution FINANCE, under the credit's booking lock, reverses the treasury receipt's cutoff
postings (fee/funds/return versions included) in route scope — each reversing set its own immutable `bank_credit.assigned`
source/version linked to the original — and posts the standard capture/fee/funds sets, with their existing sources, in agency
scope. A unique credit booking group binds reversal and capture sources so ordinary capture delivery cannot book an
already-accounted credit; it drains pending credit-version events through the cutoff in version order, checks the destination
capture snapshot agrees (including completion+reversal if already returned) and commits all sets plus delivery markers together.
Later capture versions wait for the group. Direct matched receipts use the same group (receipt+reversal+capture may post in one
transaction). Balances after the group equal ordinary B09 capture postings with zero residual treasury receipt; duplicate or
reordered events cannot double cash, fees or liabilities. Corrections are reversal plus new reviewed entries, never edits. The
credit register stores evidence/workflow; **only the ledger stores balances**.

This treasury extension is an implementation gate, not existing functionality. Wrong-currency or non-ACH activity remains an
exception with bank evidence that an owner routes to a separately reviewed treasury workflow in the same ledger; it cannot
source USD ACH captures or refunds. Reconciliation exposes unresolved activity and never marks a statement balanced while a real
receipt is unbooked. Attribution and a return claim serialize on the credit lock: after a return claim the credit cannot migrate
to a project (its return stays route-scoped, D-ACH-19); a provider reversal may still be attributed as historical
completion+reversal with no authority.

**D-ACH-12 — Fees (A8 rule 7).** Store append-only fee-policy versions, with provider, legal account registration country,
environment, receiving/sending rail, currency, fixed cents/rate/rounding where actually applicable, source URL/document,
provider revision/effective interval, **access date**, restricted source artifact/hash, verifier and verification status.
Order/instructions and refund intent bind the version current at acceptance/approval. A stale or unverified policy blocks
new ACH issuance; observing actual receipts continues. Fee changes require a new version, never rewriting old quotes or credits.

Design research source register (accessed **2026-10-05**; these are candidates, not verified pricing for Kauro's account):

| Source | Use and qualification needed |
|---|---|
| [Wise USD receiving help](https://wise.com/help/articles/2827506/how-do-i-receive-money-with-my-usd-account-details) | Distinguishes domestic ACH details from other receiving rails; verify real account eligibility/details |
| [Wise Business receiving pricing](https://wise.com/us/pricing/business/receive) | US pricing source; account registration/rail applicability must be verified before configuration |
| [Wise same-currency business fees](https://wise.com/help/articles/79jNnUdgbD4IbJiUbExpqt/cross-border-fees-on-same-currency-transfers-for-your-business) | Check jurisdiction-specific exceptions; do not advertise universal zero fees |

No numerical external fee is asserted or hard-coded here. Initial executable configuration stays UNVERIFIED until an owner
checks the provider for the real account. Per credit store observed gross, fee, net and evidence; when known, require
`grossCents - feeCents = netCents`. Unknown fee is null/unobserved, **not zero**; explicit observed zero is valid. Do not derive
gross from net plus an illustrative rate. Capture amount is evidenced gross and `providerFeeCents` is the evidenced merchant
fee. A later fee gets `capture.fee_observed.v1`, not another completion. Conflicting observations open PROVIDER_INCONSISTENCY;
observed-versus-policy discrepancies open fee review without mutating the credit or customer obligation. Customer sender-bank
fees are not merchant provider fees. Outbound fees and principal are accounted by D-ACH-18, never inside Refund components.

## 5. Phase 1 outbound returns: owner-executed in Wise, recorded by the platform

**D-ACH-20 — Phase 1 boundary (coordinator design decision within A8, 2026-10-06, after Codex design rounds r1–r3 on the
automated outbound lifecycle).** When ACH is ENABLED, Kauro makes **no automated outbound transfer**. Every return of ACH money —
refund of an ACH-paid order, excess/over-payment, expiry/remedy, or an unassigned credit — is executed by the corporate owner in
the Wise app and recorded by owner-only commands under fresh step-up (D-ACH-21). Phase 1 has no provider outbound call, no
PaymentAttempt for outbound effects, no CREATE/FUND phases, no in-transit state, no transfer watchdog, no RefundDestination
aggregate, no automated resend and no automated recovery of over-returns. Automated Wise outbound is **Phase 2 (post-launch),
not designed here** (Appendix A, whose requirements bind any later design). This is A8-consistent: A8 requires receiving ACH and
owner-approved returns, not automated payouts. Inbound credits, matching, reconciliation and payer verification are unchanged.

**D-ACH-13 — Refund source and approval.** Reuse Refund's REQUESTED→APPROVED→COMPLETED/REJECTED path and service/tax/excess
components. The source is a closed union: **CAPTURE** (a matched credit's capture; agency scope; existing `refunds` row) or
**BANK_CREDIT** (a booked unassigned USD ACH credit; route scope; `treasury_refunds` row; **excess-only** components; D-ACH-19).
No fake CaptureFact, order or agency. An agency BILLING member may request; only an **active KAURO_OWNER** with verified identity
and fresh step-up after locks approves (no standing-policy auto-approval), preserving requester/approver segregation (KP008).
Approval binds exact USD components, the **destination reference digest** with its evidence — it must equal the payer's
originating account in the source credit's bank evidence or a current VERIFIED PayerAuthorization's account (D-ACH-17);
otherwise a restricted ownership-evidence artifact and an override reason — quote terms if applicable, delivery phase, reason
and approval/effects hashes. Approval reserves the **refundable balance**: the source's components not yet returned by
completed refunds or its reversal, less other APPROVED refunds. Returning allocated service affects tax/commissions/authorization
under existing B09 rules (D-LEDGER-B7, R2-081). Attribution, return claims and reversals of one source serialize on its
**source booking lock**; B09 capture refunds keep their per-capture completion lock.

**D-ACH-21 — Owner records executed returns.** After sending money in Wise, the owner records it. All commands are owner-only
(corporate KAURO_OWNER, verified identity, live session, fresh step-up at the effect), take the source booking lock, require a
restricted Wise transfer evidence artifact (classified by the pure `classifyOutbound`), and are idempotent by
`(account, environment, Wise transfer ID)` — unique across both scopes; the same ID with another body is BODY_CONFLICT.

| Command (row) | Guard at the effect | One-COMMIT footprint |
|---|---|---|
| RecordExecutedReturn (G2) | Refund APPROVED; amount, currency USD and destination digest equal the approval; amount ≤ current refundable balance; evidence shows a completed/sent outbound debit from the route's account | `manual_outbound_records` row, Refund APPROVED→COMPLETED (proposed edge `manual_return_recorded`, BANK_TRANSFER only), `refund.completed` with frozen discharge and observed fee, journal, audit/events/outbox |
| RecordOverReturn (G5) | Original return path only: money already left Wise as the source's return but RecordExecutedReturn is refused (e.g. a reversal observed after approval); **refused while the source has an open REFUND_PAYABLE (`O > 0`)**; reason and evidence required | Record row (kind OVER_RETURN), OVER_RETURN case, `outbound.over_returned` with frozen `e`; when a refund was APPROVED, its APPROVED→COMPLETED with `refund.completed` (B09 members, returned components `d`), journal, events |
| RecordReturnBounce (G3) | A recorded transfer, Wise evidence that it came back, returned cash `B ≤ P` | Bounce row on the record (once per transfer), `outbound.bounced` with frozen allocation, RETURN_BOUNCED case, journal, events; the Refund stays COMPLETED |
| RecordResend (G4) | A bounced record of the same source; amount ≤ open REFUND_PAYABLE of that record less other resends, **otherwise REFUSED** (`RESEND_EXCEEDS_PAYABLE`, nothing written); new Wise transfer ID; destination digest rule of D-ACH-13 | Record row (kind RESEND, parent bounce FK), `outbound.resent` settling REFUND_PAYABLE, journal, events |

RecordExecutedReturn refuses any amount above the refundable balance, so the platform never classifies an over-return as a
refund. If the owner had already sent the money, the refusal does not hide it: statement reconciliation lists outgoing debits
whose transfer ID has no record and cannot mark the statement balanced, and the owner books it with RecordOverReturn **only when
it is a return on the original return path** (the source has no open REFUND_PAYABLE). **A manual resend is REFUSED when its
principal exceeds the open REFUND_PAYABLE of its bounce; there is no RecordOverReturn fallback for resends.** G5 allocates only
refundable components `d` and receivable `e = P − d`; it cannot settle a bounce payable, so it is also refused while `O > 0`,
which keeps `X = max(0, R − Q)`. A transfer refused by both commands (an oversized resend already sent) stays an unrecorded
statement debit: reconciliation stays open and surfaces it, no posting is made, and Phase 1 has no ledger repair for it (a repayment credit is an ordinary unassigned receipt,
D-ACH-18); the resend instruction shows the open payable `O` so the owner sends no more than it. An
incoming reversal observed while a refund of its source is APPROVED opens a DOUBLE_RETURN_RISK case so the owner does not send.
In-flight transfers are not modelled: the owner records only a transfer Wise shows as sent from the balance; a later bounce or
return-before-delivery is recorded with RecordReturnBounce (cash back, liability reopened). Manual readiness, evidence capture
and these commands suffice for the controlled credit gate.

**D-ACH-17 — Payer authorizations.** One new versioned aggregate (the RefundDestination lifecycle moves to Phase 2). Consumers
bind an exact version and re-read it under lock at their effect (M2, P1, F2); validity expiry is checked there, with no sweep.

| Machine: edge | Actor and guard | One-COMMIT footprint (row) |
|---|---|---|
| absent→VERIFIED `payer_authorization_verified` | KAURO_OWNER, verified identity, fresh step-up; agency BILLING request evidence plus payer identity and account evidence; kind PAYER_ALIAS or THIRD_PARTY_PAYER; validity bound | Version, evidence refs/digests, assurance, agency journal, audit/events/outbox (V2) |
| VERIFIED→SUPERSEDED `payer_authorization_replaced` | As verify, atomically with the successor's VERIFIED | Both versions in V2 |
| VERIFIED→REVOKED `payer_authorization_revoked` | KAURO_OWNER, or agency OWNER/BILLING (revocation only narrows authority) | State, review case naming MATCHED-unapplied credits and APPROVED refunds bound to it, journal, events (V3) |

Revocation never rewrites an applied capture or a recorded return: P1 returns a MATCHED credit whose authorization is no longer
current to MATCH_REVIEW; an APPROVED refund bound to it cannot be recorded until re-approved.

**D-ACH-18 — Phase 1 accounting.** B09 netting (`refundReturnOf`, `capture.reversed.v1` reversed*Cents) decides only which
obligation components a return **discharges**, once per component; it keeps deciding credit notes (D-FISC-B2), commission basis
and authority (D-LEDGER-B7). It is not the cash fact: a Wise transfer and an ACH return of the incoming credit are independent,
so every Wise debit is posted at its full principal. Each source (`Q` = its gross) has a **return position** derived from its
committed records under the source booking lock: `R` = net principal the payer holds from returns (recorded transfers and resends
+ incoming reversal − bounces), open REFUND_PAYABLE `O`, and `X` = open RETURN_RECOVERY_RECEIVABLE + written off. Every producing
COMMIT computes its amounts from that position and **freezes them in its event payload** (as B09 does with returned*Cents);
FINANCE posts payload amounts only, so delivery order cannot change them. **Invariant after every COMMIT, in every order and
both scopes: `X = max(0, R − Q)`.**

| Event (posting source key; producing row → posting row) | DEBIT | CREDIT |
|---|---|---|
| `refund.completed` via RecordExecutedReturn (transfer ID; G2→P3) | CONTRACT_LIABILITY/TAX_PAYABLE/CUSTOMER_OVERPAYMENT approved components `a`; PROCESSOR_EXPENSE observed fee `f` | provider balances `a + f` |
| `outbound.over_returned` (transfer ID; G5→P3; only with `O = 0`); its refundable part `d` posts through the same COMMIT's `refund.completed` | RETURN_RECOVERY_RECEIVABLE `e = P − d`; PROCESSOR_EXPENSE `f` | provider balances `e + f` |
| `capture.reversed` / `bank_credit.reversed` (credit ID; G6→P3) | discharge `d` (B09 unreturned components); REFUND_PAYABLE `o = min(P − d, O)`; RETURN_RECOVERY_RECEIVABLE `e = P − d − o` | provider balances `P` |
| `outbound.bounced` (transfer ID; G3→P3) | PSP_AVAILABLE `B`; PROCESSOR_EXPENSE `P − B` | RETURN_RECOVERY_RECEIVABLE then RETURN_LOSS by `ΔX = X − max(0, R − P − Q)`; REFUND_PAYABLE `P − ΔX` |
| `outbound.resent` (new transfer ID; G4→P3; `s ≤ O` else refused) | REFUND_PAYABLE `s`; PROCESSOR_EXPENSE `f` | provider balances `s + f` |
| `reconciliation_case.resolved.v1` write-off (case ID; P4) | RETURN_LOSS `w ≤` open receivable | RETURN_RECOVERY_RECEIVABLE `w` |

Provider balances are the source's PSP account up to its movable balance (amount − fee − principal already debited), the rest
PSP_AVAILABLE (D-LEDGER-B6). Credit notes and commission changes arise only from `refund.completed` of a CAPTURE source with
service/tax components, on its approved components as in B09 (also when a reversal had already returned them, D-LEDGER-B7);
BANK_CREDIT (excess-only) returns, over-return excess, reversal allocations, bounces and resends create none.
Recovery of an over-return from the payer is Phase 2: in Phase 1 an open receivable is resolved only by a reviewed write-off, and
a repayment credit stays an ordinary unassigned treasury receipt (CUSTOMER_OVERPAYMENT) shown beside the open case — booked once,
never reclassified automatically. Obligations: additive catalogue OPS-2 (RETURN_RECOVERY_RECEIVABLE asset, RETURN_LOSS expense),
the event types above for bank-transfer sources only; PayPal events, accounts and arithmetic unchanged.

Oracle (USD 1,000 credit, `Q` = 1,000, zero fees, identical for a matched capture and an unassigned credit; provider net includes
the +1,000 receipt; obligation = remaining service/tax/excess liability of the source):

| Scenario (both listed orders) | Provider net | Receivable | Written off | REFUND_PAYABLE | Obligation |
|---|---|---|---|---|---|
| M1: refund recorded | 0 | 0 | 0 | 0 | 0 |
| M2 (Codex r1): refund recorded → reversal; or reversal → RecordExecutedReturn refused → RecordOverReturn | −1,000 | 1,000 | 0 | 0 | 0 |
| M3: M2 (either order) → bounce `B` = 1,000 (Codex r2 F1) | 0 | 0 | 0 | 0 | 0 |
| M3′: M2 → write-off → bounce | 0 | 0 | 0 (RETURN_LOSS credited back) | 0 | 0 |
| M4: refund recorded → bounce | +1,000 | 0 | 0 | 1,000 | 0 |
| M4a: M4 → resend 1,000 | 0 | 0 | 0 | 0 | 0 |
| M4b: M4 → reversal (resend then refused: `O` = 0) | 0 | 0 | 0 | 0 | 0 |
| M4d: M4 → resend 400 → resend 700 REFUSED (`O` = 600; no record, no posting) | +600 | 0 | 0 | 600 | 0 |
| M4e: M4d → resend 600 | 0 | 0 | 0 | 0 | 0 |
| M4c: M4 → resend → reversal | −1,000 | 1,000 | 0 | 0 | 0 |
| M5: refund recorded → bounce `B` = 990 | +990 (PROCESSOR_EXPENSE 10) | 0 | 0 | 1,000 | 0 |
| M6: approved, not recorded | +1,000 | 0 | 0 | 0 | 1,000 |

**D-ACH-19 — Phase 1 persistence.** Closed scope union, no nullable tenant. AGENCY: existing `refunds` (CAPTURE source). Route
scope: `treasury_refunds`, registered as an aggregate kind of the existing **Refund** machine, keyed by `(route_id, environment,
account_ref)` with a `bank_credit_id` FK; no tenant RLS policy, only `kauro_payment` and active KAURO_OWNER finance access; never
migrates to agency scope (attribution is refused after a return claim, D-ACH-11). `manual_outbound_records` (kind RETURN,
OVER_RETURN or RESEND; scope union FK to its refund/source; unique `(account_ref, environment, wise_transfer_id)`; evidence
digest; frozen amounts; optional bounce row and parent-bounce FK for RESEND). Refund gains the BANK_TRANSFER-only edge
APPROVED→COMPLETED with a record FK; the B09 SUBMITTING/attempt path stays PayPal's. Route-scope owner commands journal in a
closed `journal_scope = RECEIVING_ROUTE` (route ref, NULL agency) — a check-constrained extension of `command_journal`, whose only
NULL-agency case today is CreateAgency. `commerce_scopes` stays agency-only; a sibling `treasury_scopes` (TREASURY_REFUND,
BANK_CREDIT, PROVIDER_CREDIT, WISE_TRANSFER) holds route-scope identities, and one shared provider-identity uniqueness index across
both tables prevents an ID resolving to two scopes. No `payment_attempts` change in Phase 1.

## 6. Wise bank-transfer port and security

**D-ACH-15 — Proposed TypeScript sketch.** A new bank-transfer port alongside PaymentProviderAdapter, following `provider.ts`'s
normalized shapes and `ports.ts`'s observe discipline. Phase 1 is read/classify only; outbound dispatch methods are Phase 2
(Appendix A). Vendor payloads stay inside S-B. Names are proposals, not exports in this commit.

```ts
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProviderOutcomeKind, AmbiguityReason } from "./provider.js";
import type { PaymentEnvironment, IntegrationClass, FundsState } from "./records.js";

type WiseAccountRef = string; // immutable account/profile/balance mapping; no credentials
type CreditId = string;       // account-scoped provider identity, never the memo/reference
type Cursor = string;         // opaque, account/environment/normalizer-version-bound
type Evidence = { readonly evidenceHash: Sha256Hex; readonly artifactRef: string };
// Safe operational condition of exactly one request (F4). Not evidence of any money effect; not an AmbiguityReason.
type OperationalCode = "AUTH_FAILED" | "PERMISSION_DENIED" | "SCA_REQUIRED" | "RATE_LIMITED"
  | "CAPABILITY_UNAVAILABLE" | "VALIDATION_REJECTED";
type Operational = { readonly code: OperationalCode; readonly requestHash: Sha256Hex; readonly retryAfterSeconds?: number };

type Outcome<T> =
  | ({ readonly kind: Extract<ProviderOutcomeKind, "COMPLETED">; readonly value: T } & Evidence)
  | ({ readonly kind: "PENDING"; readonly retryAfterSeconds?: number } & Evidence)
  | ({ readonly kind: "PROVED_NO_EFFECT"; readonly outcomeCode: string; readonly absenceIsProof: true } & Evidence)
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  | ({ readonly kind: "UNRECOGNIZED"; readonly safeStatusCode: string } & Evidence)
  // The provider refused this read (not served). Dispatch refusals and their no-effect proof are Phase 2.
  | { readonly kind: "REFUSED"; readonly operational: Operational };

interface UsdAchAccountDetails {
  readonly accountRef: WiseAccountRef; readonly detailsVersion: string; readonly currency: "USD"; readonly rail: "ACH";
  readonly payeeDigest: Sha256Hex;
  readonly beneficiaryName: string; readonly bankName: string; // restricted instruction data, never telemetry
  readonly routingNumber: string; readonly accountNumber: string; readonly accountType: "CHECKING" | "SAVINGS";
  readonly additionalAchFields: Readonly<Record<string, string>>; readonly verifiedAt: UtcInstant;
}
interface IncomingCredit extends Evidence {
  readonly accountRef: WiseAccountRef; readonly creditId: CreditId; readonly environment: PaymentEnvironment;
  readonly rail: "ACH" | "OTHER" | "UNKNOWN";
  readonly currency: string;          // observed, not silently constrained to USD
  readonly grossCents: bigint | null; // null blocks exact-payment application
  readonly netCents: bigint | null; readonly feeCents: bigint | null;
  readonly payeeDigest: Sha256Hex; readonly reference: string | null;
  readonly payerDigest: Sha256Hex | null; readonly payerEvidenceRef: string | null;
  readonly status: "PENDING" | "COMPLETED" | "DENIED" | "REVERSED" | "UNRECOGNIZED";
  readonly reversedCents: bigint | null; // D-ACH-18 principal of a return of this credit
  readonly fundsState: FundsState; readonly bookedAt: UtcInstant | null; readonly observedAt: UtcInstant;
}
interface CreditPage {
  readonly credits: ReadonlyArray<IncomingCredit>; readonly nextCursor: Cursor; readonly complete: boolean;
  readonly coverageStart: UtcInstant; readonly coverageEnd: UtcInstant;
}
interface OutboundEvidence extends Evidence { // classified manual Wise transfer artifact (D-ACH-21)
  readonly transferId: string; readonly accountRef: WiseAccountRef; readonly destinationDigest: Sha256Hex;
  readonly amountCents: bigint; readonly currency: string; readonly feeCents: bigint | null;
  readonly status: "SENT" | "COMPLETED" | "BOUNCED" | "CANCELLED" | "UNRECOGNIZED";
  readonly returnedCents: bigint | null; readonly observedAt: UtcInstant;
}
interface WiseBankTransferPort {
  readonly provider: "wise"; readonly environment: PaymentEnvironment; readonly integrationClass: IntegrationClass;
  getAccountDetails(account: WiseAccountRef, deadline: UtcInstant): Promise<Outcome<UsdAchAccountDetails>>;
  listIncomingCredits(input: { readonly accountRef: WiseAccountRef; readonly since: Cursor | null;
    readonly limit: number; readonly deadline: UtcInstant }): Promise<Outcome<CreditPage>>;
  getCreditById(input: { readonly accountRef: WiseAccountRef; readonly creditId: CreditId;
    readonly deadline: UtcInstant }): Promise<Outcome<IncomingCredit>>;
  // Pure classification of authenticated stored evidence, including manual bank artifacts.
  classifyCredit(evidence: Evidence): IncomingCredit;
  classifyOutbound(evidence: Evidence): OutboundEvidence;
}
```

An Outcome COMPLETED means the **port operation** returned conclusive evidence; inspect the inner credit/transfer status before
asserting money completion. `PENDING` is a recognized nonterminal response. AmbiguityReason keeps exactly TIMEOUT,
CONNECTION_RESET, PROVIDER_5XX, UNREADABLE_RESPONSE and OBSERVATION_LOST. Authentication, permission, SCA, rate-limit,
unavailable-capability and validation refusals travel only as `REFUSED` with an `Operational` code bound to the refused
request's hash, recorded as a coverage-gap/route-operational event and surfaced to the owner as a safe code, never provider
prose; it resolves nothing but its own request. An SCA/permission refusal of a statement read keeps the cursor, records the
coverage gap and leaves the owner-manual route available. Read-list absence is never PROVED_NO_EFFECT; a missing credit/status lookup is PENDING or
AMBIGUOUS/OBSERVATION_LOST unless authoritative absence has been qualified. UNRECOGNIZED never becomes success/failure.

`listIncomingCredits` is observational, idempotent and at least once; repeated/overlapping pages and changed statuses for the
same credit are expected. `getCreditById` is a logical port capability, not a claim that Wise offers a direct endpoint with
that shape. S-B may find it in authenticated statements using a bounded covered range. It must prove stable credit IDs, cursor
coverage, reference/payer fidelity, gross/fee semantics, completion/return mapping and region-specific access. If API capability
is absent, report unavailable and retain the owner-manual route; do not manufacture evidence or require APIs for launch.

Design research accessed **2026-10-05**: [Wise statements](https://docs.wise.com/api-reference/balance-statement) expose account
activity; [developer guidance](https://docs.wise.com/guides/developer) describes transfer idempotency;
[transfer reference](https://docs.wise.com/api-reference/transfer) is the Phase 2 source for create/funding/status behavior.
These inform the proposed adapter mapping, not proof of Kauro's entitlement to these endpoints. S-B freezes an API profile and
evidence for the actual account and records which observations can prove absence.

**D-ACH-16 — Authority and audit.** Manual entry **and confirmation** require an active corporate `KAURO_OWNER`, active verified
identity, live session and fresh step-up proof at their respective effects. Agency OWNER/BILLING is not corporate KAURO_OWNER.
Agency-scope facts use the agency's command journal and adopted finance scope; route-scope facts (unattributed credits, treasury
refunds, outbound records) use the RECEIVING_ROUTE journal scope of D-ACH-19, never a customer-provided agency. Service
ingestion/apply requires authenticated PAYMENT_SERVICE bound to the same environment. Preserve the `kauro_app` versus
`kauro_payment` boundary: the owner writes draft/confirmation/verification decisions; only a service-authorized consumption of
those decisions writes captures, observations and CommercialAuthorization. Outbound records (D-ACH-21) are owner commands whose
ledger effects are posted by the FINANCE service from their frozen payloads.

Entry and confirmation are separate idempotent commands with immutable evidence and audit. The same corporate owner may do
both (single-owner operation is allowed), but confirmation performs a new evidence comparison and fresh effect-time assurance;
it cannot merely copy the draft or bless a customer's claim. If role/identity/proof is revoked before confirmation, deny it.
Once confirmed, the receipt remains recoverable and later owner revocation never deletes money. Attribution overrides and
route enablement, refund approval and outbound records also require fresh step-up. Effect guards protect grant, identity verification,
session/proof, account/details/fee verification, payer authorization, destination evidence and service/lease fence as applicable, in both
interleaving orders. Separate locks from evidence reads; revalidate before writing after any await.

Audit events proposed: route configured/verified/enabled/disabled/verification withdrawn; instructions issued/read denied;
credit entered/confirmed/rejected/observed/duplicate/conflict/reversed; payer authorization verified/replaced/revoked; match
accepted/reviewed/overridden/returned to review; credit applied and authority granted/blocked; order expired/retired; refund
requested/approved/rejected; outbound return recorded/refused/over-returned/bounced/resent; over-return written off; cursor advanced/coverage gap and treasury posting/correction. Each has actor/service, environment,
scope, entity/version IDs, reason token, correlation/journal key digest, proof/evidence refs and decision/effects hashes. Commit
ALLOW facts with the authorized effect; durably record DENY facts through the existing separate security-fact path after
rollback. Events per aggregate version and registered subscribers remain mandatory. No routing/account numbers, tokens, raw
memos, payer names, destination bank fields, raw statements or credential values appear in logs, outbox payloads, analytics,
error bodies or evidence bundles. Keep originals encrypted in the restricted evidence store, accessed through audited finance
reads; use refs/digests and masked displays.

### 6.1 Wise adapter port (for S-B, phase 1)

S-B implements, in phase 1, only the **read/classify** subset of `WiseBankTransferPort` (D-ACH-15) plus one statement-debit read. The
port type has no create/fund/cancel/resend methods; their absence is part of the contract (D-ACH-20). Types below reuse D-ACH-15's
`Evidence`, `Outcome<T>`, `Cursor`, `WiseAccountRef`, `IncomingCredit`, `UsdAchAccountDetails` and `OutboundEvidence`.

```ts
interface StatementDebit extends Evidence {          // outgoing line on the route's Wise USD balance
  readonly accountRef: WiseAccountRef; readonly debitId: string;     // statement-line identity, stable
  readonly transferId: string | null;                // Wise transfer ID when the line carries one
  readonly amountCents: bigint; readonly currency: string; readonly feeCents: bigint | null;
  readonly destinationDigest: Sha256Hex | null;
  readonly status: "SENT" | "COMPLETED" | "RETURNED" | "UNRECOGNIZED"; readonly returnedCents: bigint | null;
  readonly bookedAt: UtcInstant | null; readonly observedAt: UtcInstant;
}
interface DebitPage { readonly debits: ReadonlyArray<StatementDebit>; readonly nextCursor: Cursor; readonly complete: boolean;
  readonly coverageStart: UtcInstant; readonly coverageEnd: UtcInstant; }
interface WiseReadPortPhase1 extends Pick<WiseBankTransferPort, "provider" | "environment" | "integrationClass"
  | "getAccountDetails" | "listIncomingCredits" | "getCreditById" | "classifyCredit" | "classifyOutbound"> {
  listStatementDebits(input: { readonly accountRef: WiseAccountRef; readonly since: Cursor | null;
    readonly limit: number; readonly deadline: UtcInstant }): Promise<Outcome<DebitPage>>;
}
```

**Outcomes and refusals** are exactly those of D-ACH-15: COMPLETED (conclusive port evidence; inspect inner status), PENDING,
AMBIGUOUS with only TIMEOUT/CONNECTION_RESET/PROVIDER_5XX/UNREADABLE_RESPONSE/OBSERVATION_LOST, UNRECOGNIZED (never success or
failure), and `REFUSED` carrying `Operational` (AUTH_FAILED, PERMISSION_DENIED, SCA_REQUIRED, RATE_LIMITED, CAPABILITY_UNAVAILABLE,
VALIDATION_REJECTED) bound to the refused request's hash. Read-list absence is never PROVED_NO_EFFECT; a missing credit is PENDING or
AMBIGUOUS/OBSERVATION_LOST. No vendor prose or secret leaves the adapter.

**Idempotency and cursor semantics.** All methods are pure reads: repeating one with the same input has no effect and returns the
same identities. A credit is identified only by `(accountRef, creditId)`, a debit by `(accountRef, debitId)`; amount/date/reference
never identify. Pages are at least once and may overlap or reorder; a repeat of an item with the same immutable fields is
identical evidence, and a changed immutable field (amount, currency, payee, reference, transfer ID) is surfaced unchanged for the
caller to raise BODY_CONFLICT; status/fee/returned fields may legitimately change between reads. `Cursor` is opaque and bound to
account, environment and normalizer version; a foreign or stale cursor yields `REFUSED` VALIDATION_REJECTED, never a silent
restart. `nextCursor` is returned for every page but the caller advances its stored cursor only after persisting the complete page
(`complete=true`); `complete=false` or any refusal means the previous cursor stays and a coverage gap is recorded. Coverage
bounds are reported so the observer re-reads overlap windows (D-ACH-07). `since=null` starts from the earliest covered range.
Reconciliation (D-ACH-21) lists debits whose `transferId` has no `manual_outbound_records` row; a null `transferId` is an
unrecorded debit by definition. The adapter never decides matching, authority or money allocation.

**Contract fake S-B must ship** (`integrationClass = CONTRACT_FAKE`, which never qualifies LIVE; deterministic, fixed clock, seeded
fixtures; the same shared contract suite runs against it and, when available, the real adapter, in
`packages/application/test/ach-wise-port.test.ts`). It must script: duplicate, overlapping and reordered pages; an incomplete
page (`complete=false`) and a page with the next cursor lost; PENDING→COMPLETED→REVERSED credit with `reversedCents`; fee null
versus observed zero and a gross−fee≠net conflict; wrong currency and rail OTHER/UNKNOWN; missing reference and null payer;
changed immutable field on re-read; an unknown credit and unknown status (PENDING/AMBIGUOUS/UNRECOGNIZED, never PROVED_NO_EFFECT);
each AmbiguityReason; each Operational code with request-bound hash (SCA_REQUIRED on a statement read keeps the cursor);
foreign-account/environment/version cursor; a statement debit with and without a matching record, a SENT then RETURNED debit
with `returnedCents`, a debit with a null transfer ID, and an oversized-resend debit; a CONTRACT_FAKE account details artifact;
and the assertion that the port exposes no outbound method and that evidence/fixtures contain no raw routing/account numbers
outside the restricted details type. Fake results prove orchestration only; S-B separately freezes the real API profile and which
observations can prove absence (D-ACH-15).

## 7. Failure-mode matrices

The matrices follow [FAILURE-MATRIX-TEMPLATE](FAILURE-MATRIX-TEMPLATE.md) and [FAULT-HARNESS](FAULT-HARNESS.md), including all ten
family rules. All cells are **GAP** (pre-code). `ACH-M-<row>-<column>` codes identify unwritten tests; every cell states expected
result, invariant and injection. Money/authority GAPs are tier 1; transport GAPs with no wrong money/authority outcome are tier 3;
all are required before implementing/enabling the affected path. Rows are one call/read or one independently durable
transaction; the Step cell names its `K…` COMMIT and footprint. PARTIAL injects at **each** second/later write, including
deferred guards and journal/event/outbox writes. BEFORE is after the row's last write before its COMMIT; AFTER is after that
COMMIT before response/outbox settlement; read/call rows use their own before/after await boundary. No call-out runs inside a
transaction; external effects name the provider's own durable boundary.

Tests: `packages/persistence/test/ach-failure-matrix.test.ts` (DB/command rows) and `packages/application/test/ach-wise-port.test.ts`
(call/read rows), titled `RACE ACH-M-<row>-<column> (<family>): <row label>` (`DENY` for expiry/revocation refusals, `OK` for pure
read invariants), registered with `faultMatrix`/`faultCell` in the implementation case map. Adapter fixtures are CONTRACT_FAKE.
Tests prove operation-owned fault evidence. RACE holds the named lock/await and runs **every named actor in both orders**. RETRY
covers same key/same body, same key/different body, identical event redelivery and concurrent recovery where applicable. AFTER
tests inject lost answers. Deadline tests consume the effect clock before, at and after the boundary. REVOCATION withdraws each
listed prerequisite independently. PARTIAL asserts the entire footprint and exact cents, including journals, events, scopes,
delivery markers and other actors' commits. Rows F1–F2, G1–G6 and P3–P4 run each cell in **both source scopes** (AGENCY
capture source, RECEIVING_ROUTE bank-credit source) inside the one titled test, asserting the scope-specific footprint.

### 7.1 Route configuration and qualification command (D-ACH-02)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **R1** Account-details fetch/classification await; no route write | **GAP ACH-M-R1-RACE**: Discard stale details. Invariant: enable binds current account version. Inject: pause fetch; replace account/disable in both orders. | **GAP ACH-M-R1-TIMEOUT**: Leave verification pending. Invariant: timeout never qualifies route. Inject: delay details response past port deadline. | **GAP ACH-M-R1-EXPIRY**: Reject expired evidence. Invariant: details validity required at enable. Inject: advance details validity during fetch. | **GAP ACH-M-R1-CRASH-BEFORE**: Fetch retry is read-only. Invariant: no route fact exists. Inject: crash immediately before details await. | **GAP ACH-M-R1-CRASH-AFTER**: Refetch after lost answer. Invariant: no automatic qualification. Inject: crash after fetch before Kroute. | **GAP ACH-M-R1-RETRY**: Same read is harmless. Invariant: only current evidence may qualify. Inject: repeat fetch and conflicting account binding. | **GAP ACH-M-R1-REVOCATION**: Discard withdrawn evidence. Invariant: KYC/account/credential authority all required. Inject: withdraw each at held fetch. | **GAP ACH-M-R1-PARTIAL**: Reject incomplete details. Invariant: no partial instruction snapshot. Inject: fail field parsing after account number read. |
| **R2** `Kroute`: route/config version, assurance fact, journal, events/outbox | **GAP ACH-M-R2-RACE**: One version wins; loser rechecks. Invariant: only current verified config enables. Inject: hold route lock; enable/disable/details replacement both orders. | **GAP ACH-M-R2-TIMEOUT**: Recover config by journal. Invariant: no assumed enabling. Inject: lock/COMMIT timeout then read version with same key. | **GAP ACH-M-R2-EXPIRY**: Refuse stale verification/step-up. Invariant: fresh facts at effect. Inject: move evidence/proof/fee validity over boundary after locks. | **GAP ACH-M-R2-CRASH-BEFORE**: Rollback all config writes. Invariant: no enable without evidence/audit. Inject: crash after final write before Kroute COMMIT. | **GAP ACH-M-R2-CRASH-AFTER**: Replay committed route version. Invariant: one enabling event. Inject: lose answer after Kroute COMMIT. | **GAP ACH-M-R2-RETRY**: Replay or body conflict. Invariant: same key binds exact config. Inject: concurrent same key then changed account/version body. | **GAP ACH-M-R2-REVOCATION**: Block enable; retain any disable. Invariant: all qualification prerequisites required. Inject: revoke identity/grant/proof/KYC/details/fee evidence separately under route lock. | **GAP ACH-M-R2-PARTIAL**: Rollback full footprint. Invariant: no enabled half-config. Inject: fail second/later config/journal/assurance/event/outbox writes. |
### 7.2 Issue transfer instructions command (D-ACH-04)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **I1** Purchased-subject/capacity/route locked readiness read | **GAP ACH-M-I1-RACE**: Read consistent locked subject. Invariant: one purchase and valid prerequisites. Inject: hold subject locks; PayPal checkout/sweep/approval withdrawal/source deletion both orders. | **GAP ACH-M-I1-TIMEOUT**: Refuse instructions retryably. Invariant: unknown capacity is not permission. Inject: delay capacity/read statement past bound. | **GAP ACH-M-I1-EXPIRY**: Refuse stale checkout. Invariant: source/price/capacity deadlines independent. Inject: advance each deadline during read; consume effect clock. | **GAP ACH-M-I1-CRASH-BEFORE**: Release read locks; no issue. Invariant: no instruction state exists. Inject: crash before readiness await returns. | **GAP ACH-M-I1-CRASH-AFTER**: Repeat checks on recovery. Invariant: a prior read grants no authority. Inject: crash after read before Kinstructions. | **GAP ACH-M-I1-RETRY**: Read again under current guards. Invariant: no stale readiness replay. Inject: repeat read after prerequisites change. | **GAP ACH-M-I1-REVOCATION**: Refuse issuance. Invariant: identity/membership/approval/source/target/capability/routes all bind. Inject: withdraw each at held readiness boundary. | **GAP ACH-M-I1-PARTIAL**: No writable footprint. Invariant: all readiness facts required. Inject: fail second reader after first succeeded. |
| **I2** `Kinstructions`: journal, accepted quote, order, reference/snapshot, scopes, events/outbox | **GAP ACH-M-I2-RACE**: One checkout/ref wins. Invariant: no cross-route open duplicate. Inject: hold project/route lock; issue/PayPal/retire/sweep both orders. | **GAP ACH-M-I2-TIMEOUT**: Recover by intent journal. Invariant: no second reference/order. Inject: inject statement or lost COMMIT response timeout. | **GAP ACH-M-I2-EXPIRY**: Refuse at expired effect. Invariant: no extension of price/source lifetime. Inject: advance transfer/quote/source/proof validity after lock wait. | **GAP ACH-M-I2-CRASH-BEFORE**: All instructions disappear. Invariant: quote/order/reference/journal atomic. Inject: crash after last write before Kinstructions COMMIT. | **GAP ACH-M-I2-CRASH-AFTER**: Return same frozen instructions if still enabled. Invariant: no regenerated reference. Inject: lose response after Kinstructions COMMIT. | **GAP ACH-M-I2-RETRY**: Replay exact order or conflict. Invariant: intent binds route/terms/amount. Inject: concurrent identical key and changed route/body; force reference collision. | **GAP ACH-M-I2-REVOCATION**: Refuse new issuance. Invariant: billing and qualified route facts required. Inject: revoke identity/membership/approval/source/target/capability/route/fee facts separately. | **GAP ACH-M-I2-PARTIAL**: Rollback complete footprint. Invariant: no orphan reference or accepted quote. Inject: fail each later snapshot/scope/event/outbox/journal write. |
### 7.3 Read sensitive instructions (D-ACH-04/16)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **I3** Authorized sensitive-instructions projection read | **GAP ACH-M-I3-RACE**: Hide details if disable wins. Invariant: only ENABLED serves sensitive data. Inject: hold projection guard; disable/account replacement/expiry both orders. | **GAP ACH-M-I3-TIMEOUT**: Return no sensitive partial response. Invariant: unknown guard never exposes details. Inject: delay authorization/artifact read past bound. | **GAP ACH-M-I3-EXPIRY**: Hide expired instruction details. Invariant: live deadline and session required. Inject: move order/session expiry during guarded read. | **GAP ACH-M-I3-CRASH-BEFORE**: No response or state change. Invariant: no logged account data. Inject: crash before projection await; inspect logs. | **GAP ACH-M-I3-CRASH-AFTER**: Client may refetch under guards. Invariant: responses never cache details. Inject: lose read response; inspect cache headers and refetch. | **GAP ACH-M-I3-RETRY**: Reauthorize every read. Invariant: idempotency cannot bypass visibility. Inject: repeat reads after disable and from foreign agency. | **GAP ACH-M-I3-REVOCATION**: Suppress sensitive response. Invariant: membership/session/route/details remain valid. Inject: withdraw each while projection is held. | **GAP ACH-M-I3-PARTIAL**: Fail closed without body fragments. Invariant: all authorized fields come from one snapshot. Inject: fail artifact decrypt after authorization; inspect response/logs. |
### 7.4 Incoming-credit observer and cursor sweep (D-ACH-07)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **C1** `Kscanclaim`: account scan lease/fence and bounded deadline | **GAP ACH-M-C1-RACE**: One fenced scanner wins. Invariant: stale lease cannot advance cursor. Inject: hold account lease; concurrent scan/takeover both orders. | **GAP ACH-M-C1-TIMEOUT**: Read durable lease before work. Invariant: uncertain claim is not call permission. Inject: inject claim lock/COMMIT response timeout. | **GAP ACH-M-C1-EXPIRY**: Reject expired claim. Invariant: bounded server lease only. Inject: advance lease/claim deadline at effect. | **GAP ACH-M-C1-CRASH-BEFORE**: No lease survives. Invariant: no orphan scanner claim. Inject: crash after final write before Kscanclaim COMMIT. | **GAP ACH-M-C1-CRASH-AFTER**: Recover same fence or wait. Invariant: no duplicate ownership assumption. Inject: lose claim answer after Kscanclaim COMMIT. | **GAP ACH-M-C1-RETRY**: Same holder resumes; stale holder loses. Invariant: fence monotonically increases. Inject: concurrent same key and conflicting holder body. | **GAP ACH-M-C1-REVOCATION**: Stop new scan claims. Invariant: service/account/environment authority required. Inject: revoke service identity/account binding/lease fence individually. | **GAP ACH-M-C1-PARTIAL**: Rollback claim and events. Invariant: lease metadata atomic. Inject: fail later deadline/fence/event writes. |
| **C2** listIncomingCredits await; no cursor mutation; REFUSED records a coverage gap | **GAP ACH-M-C2-RACE**: Persist duplicates safely; reject stale cursor claim. Invariant: at-least-once never double-books. Inject: pause list; second poll/manual confirmation/account replacement both orders. | **GAP ACH-M-C2-TIMEOUT**: Keep old cursor; retry observation. Invariant: no absence inferred from timeout. Inject: delay or lose list response past bound. | **GAP ACH-M-C2-EXPIRY**: Stale lease cannot checkpoint. Invariant: coverage advances only under live fence. Inject: advance lease deadline while listing. | **GAP ACH-M-C2-CRASH-BEFORE**: No local observation yet. Invariant: cursor unchanged. Inject: crash before list await dispatch. | **GAP ACH-M-C2-CRASH-AFTER**: Repeat overlapping scan. Invariant: lost page cannot skip money. Inject: crash after list response before Kpage. | **GAP ACH-M-C2-RETRY**: Identical/reordered pages dedupe. Invariant: identity not amount defines receipt. Inject: repeat page and event; mutate immutable credit body. | **GAP ACH-M-C2-REVOCATION**: Stop calls; retain old coverage. Invariant: service/credential/account/fence validated. Inject: revoke each at list await; permit identical evidence only. | **GAP ACH-M-C2-PARTIAL**: Retain previous cursor. Invariant: partial page is never complete coverage. Inject: truncate page or fail second-page classification. |
| **C3** getCreditById await, including known-credit return/status rescans | **GAP ACH-M-C3-RACE**: Merge monotonically or open conflict. Invariant: returns cannot be rolled back by pending. Inject: hold observation; manual/API completion/return/attribution both orders. | **GAP ACH-M-C3-TIMEOUT**: Keep pending/uncertain. Invariant: missing response proves no absence. Inject: timeout/reset/5xx during lookup. | **GAP ACH-M-C3-EXPIRY**: Store evidence; no expired service right. Invariant: late receipt remains real. Inject: cross order/lease deadline during lookup. | **GAP ACH-M-C3-CRASH-BEFORE**: No new local fact. Invariant: stored credit survives. Inject: crash before getCreditById await. | **GAP ACH-M-C3-CRASH-AFTER**: Repeat exact identity lookup. Invariant: no recreated incoming transaction. Inject: crash after response before Kpage/Kapply. | **GAP ACH-M-C3-RETRY**: Duplicate status has no second effect. Invariant: terminal progression monotonic. Inject: redeliver status then conflicting immutable fields. | **GAP ACH-M-C3-REVOCATION**: No newly trusted response without auth. Invariant: account/environment/credential/fence bind query. Inject: revoke each at lookup; preserve previously verified facts. | **GAP ACH-M-C3-PARTIAL**: Quarantine incomplete evidence. Invariant: no guessed gross/reference/payer. Inject: fail normalization after reading status. |
| **C7** `Kpage`: complete page inbox/credit versions, exceptions, audit events; no cursor yet | **GAP ACH-M-C7-RACE**: Deduplicate or record conflict. Invariant: one receipt identity across sources. Inject: hold credit lock; manual entry/API rescan/return both orders. | **GAP ACH-M-C7-TIMEOUT**: Do not advance cursor yet. Invariant: lost page commit recoverable. Inject: inject statement or COMMIT response timeout. | **GAP ACH-M-C7-EXPIRY**: Persist authenticated receipts; block stale settlement. Invariant: expiry cannot erase real credits. Inject: cross lease/order deadline after fetch before write. | **GAP ACH-M-C7-CRASH-BEFORE**: No page fragment persists. Invariant: page durability precedes cursor. Inject: crash after last write before Kpage COMMIT. | **GAP ACH-M-C7-CRASH-AFTER**: Repeat page before checkpoint. Invariant: duplicate evidence changes no balance. Inject: lose page answer after Kpage COMMIT. | **GAP ACH-M-C7-RETRY**: Replay page/events or conflict. Invariant: dedupe by account-scoped bank ID. Inject: repeat identical/reordered page then changed immutable body. | **GAP ACH-M-C7-REVOCATION**: Reject unauthenticated ingress; keep prior facts. Invariant: service/account/evidence auth cannot be invented. Inject: withdraw each ingress prerequisite; stale fence never advances coverage. | **GAP ACH-M-C7-PARTIAL**: Rollback entire bounded page. Invariant: no cursor claims missing observations. Inject: fail second credit/exception/version/event write. |
| **C8** `Kcursor`: coverage/cursor CAS plus lease renewal/settle and events after Kpage | **GAP ACH-M-C8-RACE**: CAS winner advances; loser rescans. Invariant: cursor bound to durable page/fence. Inject: hold cursor lock; second scanner/takeover both orders. | **GAP ACH-M-C8-TIMEOUT**: Read checkpoint and recover. Invariant: uncertain checkpoint never skips gap. Inject: inject cursor lock/COMMIT response timeout. | **GAP ACH-M-C8-EXPIRY**: Reject expired fence. Invariant: no stale checkpoint owner. Inject: advance lease deadline just before cursor effect. | **GAP ACH-M-C8-CRASH-BEFORE**: Keep previous cursor; page remains durable. Invariant: Kpage independent of checkpoint. Inject: crash after last write before Kcursor COMMIT. | **GAP ACH-M-C8-CRASH-AFTER**: Resume committed coverage. Invariant: no page skipped on lost answer. Inject: lose checkpoint response after Kcursor COMMIT. | **GAP ACH-M-C8-RETRY**: Repeat checkpoint no-op or conflict. Invariant: cursor hash/page binding fixed. Inject: same key/page duplicates then changed coverage body. | **GAP ACH-M-C8-REVOCATION**: Refuse cursor advance. Invariant: service/environment/account/live fence required. Inject: revoke each while CAS is held. | **GAP ACH-M-C8-PARTIAL**: Rollback cursor/coverage/lease settlement. Invariant: checkpoint footprint atomic. Inject: fail later coverage/event/lease write; assert durable Kpage retained. |
### 7.5 Enter manual credit command (D-ACH-07/16)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **C5** `Kdraft`: owner manual draft/evidence refs, journal, audit events | **GAP ACH-M-C5-RACE**: One draft/version wins. Invariant: manual/API share bank identity. Inject: hold credit lock; two owners/API entry both orders. | **GAP ACH-M-C5-TIMEOUT**: Recover draft only. Invariant: entry is not confirmation. Inject: inject write/COMMIT acknowledgement timeout. | **GAP ACH-M-C5-EXPIRY**: Reject stale proof/session. Invariant: owner assurance fresh at write. Inject: advance proof/session boundary after wait. | **GAP ACH-M-C5-CRASH-BEFORE**: No draft or journal persists. Invariant: entry atomic. Inject: crash after final write before Kdraft COMMIT. | **GAP ACH-M-C5-CRASH-AFTER**: Replay draft without capture. Invariant: one immutable entry. Inject: lose answer after Kdraft COMMIT. | **GAP ACH-M-C5-RETRY**: Replay same body or conflict. Invariant: bank ID/hash fixed. Inject: same key duplicates and changed bank ID/amount/artifact. | **GAP ACH-M-C5-REVOCATION**: Refuse entry. Invariant: corporate owner not agency billing. Inject: revoke identity verification/grant/session/proof/account access separately. | **GAP ACH-M-C5-PARTIAL**: Rollback draft/audit/journal. Invariant: no unaudited entry. Inject: fail later evidence-ref/event/journal writes. |
### 7.6 Confirm manual credit command (D-ACH-07/16)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **C4** Restricted evidence read and pure classifyCredit/manual comparison await | **GAP ACH-M-C4-RACE**: Reject changed artifact or draft. Invariant: confirmation hashes immutable evidence. Inject: hold evidence read; draft correction/artifact revocation/API observation both orders. | **GAP ACH-M-C4-TIMEOUT**: Leave draft unconfirmed. Invariant: unread evidence cannot mint money. Inject: delay artifact/decrypt/compare beyond bound. | **GAP ACH-M-C4-EXPIRY**: Require new assurance/check. Invariant: proof and evidence current at effect. Inject: advance evidence/proof validity while reading. | **GAP ACH-M-C4-CRASH-BEFORE**: No confirmed fact. Invariant: draft alone grants nothing. Inject: crash before evidence comparison await. | **GAP ACH-M-C4-CRASH-AFTER**: Reread/compare on resume. Invariant: old read is not confirmation. Inject: crash after classification before Kconfirm. | **GAP ACH-M-C4-RETRY**: Same evidence stable; changed body conflicts. Invariant: hash binds bytes and source identity. Inject: repeat classification then substitute artifact/hash. | **GAP ACH-M-C4-REVOCATION**: Refuse confirmation. Invariant: owner/proof/account/artifact authority required. Inject: revoke each at held evidence read. | **GAP ACH-M-C4-PARTIAL**: No partial normalized credit accepted. Invariant: all identity and amount fields required. Inject: fail second field check/decrypt step after first success. |
| **C6** `Kconfirm`: confirmation decision, normalized observation/inbox, journal, assurance/events | **GAP ACH-M-C6-RACE**: One normalized receipt wins. Invariant: manual/API duplicates share identity. Inject: hold credit/owner guard; API confirmation/draft rejection both orders. | **GAP ACH-M-C6-TIMEOUT**: Recover confirmed decision by key. Invariant: timeout never confirms twice. Inject: inject statement/lost COMMIT response timeout. | **GAP ACH-M-C6-EXPIRY**: Refuse stale proof; late money still reviewable. Invariant: fresh confirmation does not waive order expiry. Inject: cross proof and transfer deadlines independently. | **GAP ACH-M-C6-CRASH-BEFORE**: All confirmation writes roll back. Invariant: no trusted orphan observation. Inject: crash after last write before Kconfirm COMMIT. | **GAP ACH-M-C6-CRASH-AFTER**: Replay committed observation. Invariant: no new money/authorization. Inject: lose answer after Kconfirm COMMIT. | **GAP ACH-M-C6-RETRY**: Same key/evidence replays; conflict quarantines. Invariant: confirmed body immutable. Inject: concurrent replay and event redelivery; change amount/payer body. | **GAP ACH-M-C6-REVOCATION**: Refuse new confirmation; retain prior confirmed money. Invariant: owner/identity/proof/account/evidence all guarded. Inject: revoke each before/after confirmation guard. | **GAP ACH-M-C6-PARTIAL**: Rollback complete decision footprint. Invariant: confirmation/inbox/assurance atomic. Inject: fail each later observation/event/ALLOW/journal write. |
### 7.7 Verify or replace payer authorization command (D-ACH-17)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **V1** Payer identity/authorization evidence read and classification await; no write | **GAP ACH-M-V1-RACE**: Revalidate before Kpayerauth. Invariant: the version binds the evidence actually read. Inject: hold read; agency billing-identity change/second verification/revocation both orders. | **GAP ACH-M-V1-TIMEOUT**: No authorization from unread evidence. Invariant: unknown payer is not permission. Inject: delay artifact/decrypt past bound. | **GAP ACH-M-V1-EXPIRY**: Require fresh evidence/proof. Invariant: evidence and step-up validity checked at effect. Inject: advance each validity during read. | **GAP ACH-M-V1-CRASH-BEFORE**: No fact. Invariant: read writes nothing. Inject: crash before evidence await. | **GAP ACH-M-V1-CRASH-AFTER**: Reread on resume. Invariant: an old read verifies nothing. Inject: crash after read before Kpayerauth. | **GAP ACH-M-V1-RETRY**: Same bytes, same digest; substituted artifact conflicts. Invariant: digest binds bytes and source. Inject: repeat read then swap artifact. | **GAP ACH-M-V1-REVOCATION**: Refuse. Invariant: owner identity/grant/proof, agency billing identity and artifact access each required. Inject: withdraw each at held read. | **GAP ACH-M-V1-PARTIAL**: Reject partial evidence. Invariant: payer identity and agency request both required. Inject: fail second evidence decode after first. |
| **V2** `Kpayerauth`: new VERIFIED version, prior VERIFIED→SUPERSEDED, evidence refs, assurance, agency journal, audit/events/outbox | **GAP ACH-M-V2-RACE**: One current version per agency/payer. Invariant: no two current authorizations; a match binds exactly one. Inject: hold authorization lock; second verification/replacement/revocation/Kmatch both orders. | **GAP ACH-M-V2-TIMEOUT**: Recover by journal key. Invariant: no duplicate version. Inject: lock/COMMIT response timeout. | **GAP ACH-M-V2-EXPIRY**: Refuse stale proof/evidence; validity bound frozen. Invariant: effect-time assurance. Inject: cross proof/evidence validity after lock wait. | **GAP ACH-M-V2-CRASH-BEFORE**: Rollback new and superseded versions. Invariant: replacement atomic. Inject: crash after last write before Kpayerauth COMMIT. | **GAP ACH-M-V2-CRASH-AFTER**: Replay committed version. Invariant: one VERIFIED event. Inject: lose answer after Kpayerauth COMMIT. | **GAP ACH-M-V2-RETRY**: Same key/body replays; changed evidence/payer/kind conflicts. Invariant: version immutable. Inject: concurrent same key, then changed evidence digest, payer and kind. | **GAP ACH-M-V2-REVOCATION**: Refuse; prior version unchanged. Invariant: KAURO_OWNER grant, identity, step-up, agency active, billing identity all required. Inject: withdraw each under lock. | **GAP ACH-M-V2-PARTIAL**: Rollback whole footprint. Invariant: no supersession without successor. Inject: fail supersede/assurance/journal/event/outbox write after the new version insert. |
### 7.8 Revoke payer authorization command (D-ACH-17)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **V3** `Kpayerrevoke`: version REVOKED, review case naming MATCHED-unapplied credits, journal, audit/events | **GAP ACH-M-V3-RACE**: Apply first keeps its capture (money real, authority per P1); revoke first sends the credit to MATCH_REVIEW at P1. Invariant: no capture newly applied under a revoked version. Inject: hold authorization lock; Kapply/Kmatch/replacement both orders. | **GAP ACH-M-V3-TIMEOUT**: Recover state; consumers re-read. Invariant: uncertain revocation never treated as still valid by a consumer. Inject: COMMIT response timeout, then concurrent Kapply. | **GAP ACH-M-V3-EXPIRY**: Revoking an expired version records the revocation. Invariant: expired version unusable either way. Inject: validity boundary exactly at revoke effect. | **GAP ACH-M-V3-CRASH-BEFORE**: Version stays VERIFIED; no case. Invariant: state and case atomic. Inject: crash after last write before Kpayerrevoke COMMIT. | **GAP ACH-M-V3-CRASH-AFTER**: Replay. Invariant: one REVOKED event. Inject: lose answer after Kpayerrevoke COMMIT. | **GAP ACH-M-V3-RETRY**: Duplicate is a no-op; revoking a superseded version returns current state. Invariant: monotonic. Inject: repeat key and event; same key with another version ID. | **GAP ACH-M-V3-REVOCATION**: Revoker loses authority: deny, version stays VERIFIED. Invariant: identity/membership or grant/step-up checked at effect. Inject: withdraw each. | **GAP ACH-M-V3-PARTIAL**: Rollback. Invariant: revocation and its case together. Inject: fail case/journal/event write. |
### 7.9 Match or review credit command (D-ACH-08)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **M1** Reference/account/payer-authorization lookup read; no scope adoption from payload | **GAP ACH-M-M1-RACE**: Recheck target binding before decision. Invariant: reference/account never reassigned. Inject: hold lookup; attribution/retirement/payer-alias withdrawal both orders. | **GAP ACH-M-M1-TIMEOUT**: Keep MATCH_REVIEW. Invariant: no guessed agency from timeout. Inject: delay reference/alias/evidence lookup beyond bound. | **GAP ACH-M-M1-EXPIRY**: Resolve identity but flag late. Invariant: lookup never extends deadline. Inject: cross transfer/alias validity during read. | **GAP ACH-M-M1-CRASH-BEFORE**: No attribution written. Invariant: observation remains recoverable. Inject: crash before lookup await. | **GAP ACH-M-M1-CRASH-AFTER**: Repeat guarded lookup. Invariant: read alone binds no order. Inject: crash after lookup before Kmatch. | **GAP ACH-M-M1-RETRY**: Stable lookup; altered input conflicts later. Invariant: canonical reference only. Inject: repeat exact lookup then truncated/foreign-account/payer variant. | **GAP ACH-M-M1-REVOCATION**: Refuse override/expired alias. Invariant: payer/account/owner authority independent. Inject: withdraw each prerequisite while lookup held. | **GAP ACH-M-M1-PARTIAL**: Keep review with no partial binding. Invariant: all identity dimensions required. Inject: fail second reference/payee/payer lookup after first result. |
| **M2** `Kmatch`: attribution/review decision, target binding, payer-authorization version, case, journal/events | **GAP ACH-M-M2-RACE**: One attribution or return claim wins. Invariant: credit cannot pay two orders. Inject: hold credit/order locks; other owner/return claim/expiry/route switch both orders. | **GAP ACH-M-M2-TIMEOUT**: Recover decision; never auto-apply twice. Invariant: ambiguous COMMIT not new match. Inject: inject decision lock/COMMIT response timeout. | **GAP ACH-M-M2-EXPIRY**: Commit late review; no entitlement promise. Invariant: transfer/alias/proof deadlines checked independently. Inject: move each boundary at decision effect. | **GAP ACH-M-M2-CRASH-BEFORE**: No binding/case/journal survives. Invariant: attribution decision atomic. Inject: crash after last write before Kmatch COMMIT. | **GAP ACH-M-M2-CRASH-AFTER**: Recover same decision and apply later. Invariant: MATCHED is not PAID. Inject: lose answer after Kmatch COMMIT. | **GAP ACH-M-M2-RETRY**: Replay or immutable-body conflict. Invariant: one target/evidence decision. Inject: repeat key/event then changed target/amount/alias. | **GAP ACH-M-M2-REVOCATION**: Deny override; retain trusted receipt. Invariant: identity/grant/proof/account/payer authorization required. Inject: revoke each under match guard; service still sees prior credit. | **GAP ACH-M-M2-PARTIAL**: Rollback target/case/assurance/events/journal. Invariant: no unreviewed scope adoption. Inject: fail each second/later write and assert prior observation intact. |
### 7.10 Apply matched credit / order-paid transition (D-ACH-06/09)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P1** `Kapply`: capture/allocation, credit APPLIED, order/authorization or cases/refund requests, observation/events/outbox | **GAP ACH-M-P1-RACE**: Serialize receipts, returns and checkout closure. Invariant: one capture/entitlement; allocation capped. Inject: hold credit/subject/order locks; duplicate/distinct credit/expiry/refund/reversal/PayPal/retire both orders. | **GAP ACH-M-P1-TIMEOUT**: Recover APPLIED link by credit ID. Invariant: timeout cannot grant twice. Inject: inject lock/statement/lost COMMIT response timeout. | **GAP ACH-M-P1-EXPIRY**: Record money; block authority; request return. Invariant: expired order never resurrects. Inject: move price/source/transfer deadline exactly across apply effect. | **GAP ACH-M-P1-CRASH-BEFORE**: Rollback full money/authority footprint. Invariant: no capture without consequences. Inject: crash after final write before Kapply COMMIT. | **GAP ACH-M-P1-CRASH-AFTER**: Recover committed capture/order outcome. Invariant: no duplicate authorization or completion event. Inject: lose answer/outbox settlement after Kapply COMMIT. | **GAP ACH-M-P1-RETRY**: Replay credit/event; conflict opens incident. Invariant: one identity one capture. Inject: concurrent recovery/redelivery then immutable body conflict; distinct full credit proves excess. | **GAP ACH-M-P1-REVOCATION**: Record verified money; deny authority/remedy. Invariant: revocation cannot discard receipt. Inject: withdraw agency/approval/revision/target/capability/route/fiscal/legal facts individually; revoke owner after confirmation; revoke/supersede the bound payer authorization after Kmatch (credit returns to MATCH_REVIEW, no capture). | **GAP ACH-M-P1-PARTIAL**: All apply writes roll back. Invariant: exact cents and authority atomic. Inject: fail second/later allocation/order/authorization/case/refund/observation/event/outbox writes. |
### 7.11 FINANCE receipt and attribution consumer (D-ACH-11)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P2** `Kbook`: receipt/fee/funds posting or atomic attribution group (treasury reversal + capture set), delivery markers | **GAP ACH-M-P2-RACE**: One posting group orders sources. Invariant: no duplicate receipt/fee/return across scopes. Inject: hold booking/source locks; FINANCE redelivery/attribution/fee/return/reversal both orders. | **GAP ACH-M-P2-TIMEOUT**: Recover group by source IDs. Invariant: unknown COMMIT never reposts. Inject: inject ledger lock/statement/COMMIT acknowledgement timeout. | **GAP ACH-M-P2-EXPIRY**: Book historical evidence despite order expiry. Invariant: lease expiry cannot authorize stale delivery. Inject: cross worker fence deadline; retry under current fence with original event dates. | **GAP ACH-M-P2-CRASH-BEFORE**: No posting group fragment survives. Invariant: balanced source sets and markers atomic. Inject: crash after last write before Kbook COMMIT. | **GAP ACH-M-P2-CRASH-AFTER**: Replay group as already posted. Invariant: receipt and reclassification counted once. Inject: lose consumer settle after Kbook COMMIT. | **GAP ACH-M-P2-RETRY**: Identical events no-op; conflicting source rejected. Invariant: event/line and group uniqueness. Inject: redeliver each source concurrently and corrupt linked receipt/capture body. | **GAP ACH-M-P2-REVOCATION**: Fence stale worker; preserve postings. Invariant: service scope/fence required; owner loss never erases money. Inject: revoke service/fence/account scope independently during booking. | **GAP ACH-M-P2-PARTIAL**: Rollback every group set/marker. Invariant: no residual treasury or double balance. Inject: fail second/later receipt/reversal/capture/fee/funds/marker writes; assert exact account cents. |
### 7.12 Expiry sweep / retire-checkout transition (D-ACH-05/10)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **E1** `Kexpiry`: locked order expiry/retirement, cases/refund requests, events (retirement also journals) | **GAP ACH-M-E1-RACE**: Payment first preserves CAPTURED; expiry first is return-only. Invariant: no reopened order or duplicate entitlement. Inject: hold order/project locks; apply/partial credit/PayPal switch/refund both orders. | **GAP ACH-M-E1-TIMEOUT**: Recover state; rerun sweep safely. Invariant: timeout cannot release uncertain money. Inject: inject lock/statement/lost COMMIT response timeout. | **GAP ACH-M-E1-EXPIRY**: Only expire at effectNow >= deadline. Invariant: price/source clocks never extended. Inject: test before/exact/after deadline after held lock; route retirement separately. | **GAP ACH-M-E1-CRASH-BEFORE**: Rollback closure and return requests. Invariant: no orphan expiry consequence. Inject: crash after final write before Kexpiry COMMIT. | **GAP ACH-M-E1-CRASH-AFTER**: Replay committed closure. Invariant: old reference remains bound. Inject: lose sweep settle/retirement response after Kexpiry COMMIT. | **GAP ACH-M-E1-RETRY**: Repeated sweep/events do not duplicate requests. Invariant: expiry monotonic; quote release guarded. Inject: redeliver sweep and retirement key; change target/body. | **GAP ACH-M-E1-REVOCATION**: Stale service cannot sweep; money remains. Invariant: service/fence/retirement-member authority checked. Inject: withdraw service/fence or billing identity/membership independently. | **GAP ACH-M-E1-PARTIAL**: Rollback state/case/refund/events/journal. Invariant: partial received cents preserved. Inject: fail later consequence/event writes; assert existing captures and quote reservations unchanged. |
### 7.13 Approve outbound return command (D-ACH-13)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **F1** Source/refundable-balance, payer evidence and destination-evidence read; no write | **GAP ACH-M-F1-RACE**: Revalidate under locks before Kapprove. Invariant: approval binds the refundable balance and payer evidence actually read. Inject: hold read; reversal/second approval/recorded return/payer-authorization revocation both orders. | **GAP ACH-M-F1-TIMEOUT**: No approval from an unread balance or evidence. Invariant: unknown destination is not permission. Inject: delay evidence/decrypt/balance read past bound. | **GAP ACH-M-F1-EXPIRY**: Require fresh proof/evidence. Invariant: validity checked at effect. Inject: advance proof/evidence/authorization validity during read. | **GAP ACH-M-F1-CRASH-BEFORE**: No fact. Invariant: read writes nothing. Inject: crash before await. | **GAP ACH-M-F1-CRASH-AFTER**: Reread on resume. Invariant: an old read approves nothing. Inject: crash after read before Kapprove. | **GAP ACH-M-F1-RETRY**: Stable digest; substituted evidence conflicts. Invariant: destination digest bound to evidence bytes. Inject: repeat, then foreign-account evidence. | **GAP ACH-M-F1-REVOCATION**: Refuse. Invariant: owner identity/grant/proof, payer authorization and artifact access each required. Inject: withdraw each at held read. | **GAP ACH-M-F1-PARTIAL**: Reject. Invariant: amount, destination digest and payer link all required. Inject: fail second evidence field after first. |
| **F2** `Kapprove`: refund or treasury refund APPROVED, refundable-balance reservation, destination digest and evidence, owner proof, approval/effects hashes, journal, events | **GAP ACH-M-F2-RACE**: One reserved refundable total. Invariant: Σ APPROVED + completed + reversal-returned ≤ components. Inject: hold source booking/refund locks; second approval/attribution/Kreversal/customer request/payer revocation both orders. | **GAP ACH-M-F2-TIMEOUT**: Recover by journal key. Invariant: no second reservation. Inject: lock/COMMIT response timeout. | **GAP ACH-M-F2-EXPIRY**: Refuse stale proof/evidence. Invariant: effect-time assurance. Inject: cross each validity after lock wait. | **GAP ACH-M-F2-CRASH-BEFORE**: Refund stays REQUESTED. Invariant: reservation, approval and journal atomic. Inject: crash after last write before Kapprove COMMIT. | **GAP ACH-M-F2-CRASH-AFTER**: Replay the approval. Invariant: approval is not a sent return. Inject: lose answer after Kapprove COMMIT. | **GAP ACH-M-F2-RETRY**: Replay or conflict. Invariant: effects hash immutable. Inject: same key, changed amount/destination/source. | **GAP ACH-M-F2-REVOCATION**: Refuse; other refunds unchanged. Invariant: KAURO_OWNER grant, identity, step-up, payer authorization, evidence; KP008 segregation. Inject: withdraw each. | **GAP ACH-M-F2-PARTIAL**: Rollback. Invariant: no reservation without approval. Inject: fail scope/ALLOW/event/journal write. |
### 7.14 Record executed return command (D-ACH-21)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **G1** Wise transfer evidence read and pure `classifyOutbound` await (shared by G2–G5); no write | **GAP ACH-M-G1-RACE**: Revalidate before the record COMMIT. Invariant: the record binds the evidence actually read. Inject: hold read; artifact replacement/second record of the transfer both orders. | **GAP ACH-M-G1-TIMEOUT**: Record nothing. Invariant: unread evidence cannot book cash. Inject: delay decrypt/classify past bound. | **GAP ACH-M-G1-EXPIRY**: Require fresh proof. Invariant: step-up valid at effect. Inject: advance proof validity during read. | **GAP ACH-M-G1-CRASH-BEFORE**: No fact. Invariant: read writes nothing. Inject: crash before await. | **GAP ACH-M-G1-CRASH-AFTER**: Reread on resume. Invariant: an old read records nothing. Inject: crash after read before the record COMMIT. | **GAP ACH-M-G1-RETRY**: Same bytes, same digest; substituted artifact conflicts. Invariant: digest binds bytes. Inject: repeat, then swap artifact. | **GAP ACH-M-G1-REVOCATION**: Refuse. Invariant: owner/proof/artifact access required. Inject: withdraw each at held read. | **GAP ACH-M-G1-PARTIAL**: Reject. Invariant: transfer ID, account, amount, currency, destination digest and status all required. Inject: fail second field after first. |
| **G2** `Krecordreturn`: record row, Refund APPROVED→COMPLETED, `refund.completed` with frozen amounts and fee, journal, audit/events/outbox | **GAP ACH-M-G2-RACE**: Record first: a later reversal allocates as excess (M2); reversal first: refused, RecordOverReturn path. Invariant: amount ≤ refundable at effect; one record per transfer ID. Inject: hold source booking lock; Kreversal/second record/Kapprove/Krecordoverreturn both orders. | **GAP ACH-M-G2-TIMEOUT**: Recover by transfer ID. Invariant: no second completion. Inject: COMMIT response timeout. | **GAP ACH-M-G2-EXPIRY**: Refuse stale proof; an expired order still allows its approved return. Invariant: effect-time step-up. Inject: cross proof validity after lock wait. | **GAP ACH-M-G2-CRASH-BEFORE**: Refund stays APPROVED; statement debit unrecorded. Invariant: record, completion and event atomic. Inject: crash after last write before Krecordreturn COMMIT. | **GAP ACH-M-G2-CRASH-AFTER**: Replay the record. Invariant: one completion and one cash-out. Inject: lose answer after COMMIT. | **GAP ACH-M-G2-RETRY**: Same transfer ID/body replays; other body conflicts; other amount/destination than approval refused. Invariant: transfer ID unique across scopes. Inject: concurrent same ID; changed amount/destination/scope. | **GAP ACH-M-G2-REVOCATION**: Refuse; money stays visible as an unrecorded statement debit. Invariant: KAURO_OWNER grant, identity, session, step-up; approval still current; payer authorization current. Inject: withdraw each. | **GAP ACH-M-G2-PARTIAL**: Rollback. Invariant: no COMPLETED refund without its record and event. Inject: fail state/event/outbox/journal write; assert exact cents. |
### 7.15 Record over-return command (D-ACH-21)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **G5** `Krecordoverreturn`: record row (OVER_RETURN), OVER_RETURN case, frozen `d`/`e`, refund completion when APPROVED, journal, events | **GAP ACH-M-G5-RACE**: `d`/`e` from the position at effect. Invariant: `X = max(0, R − Q)`; M2 equal in both orders. Inject: hold source booking lock; Kreversal/Krecordreturn/Krecordbounce both orders. | **GAP ACH-M-G5-TIMEOUT**: Recover by transfer ID. Invariant: one record. Inject: COMMIT response timeout. | **GAP ACH-M-G5-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity. | **GAP ACH-M-G5-CRASH-BEFORE**: Nothing recorded; statement debit stays unresolved. Invariant: record, case and events atomic. Inject: crash after last write before Krecordoverreturn COMMIT. | **GAP ACH-M-G5-CRASH-AFTER**: Replay. Invariant: one receivable. Inject: lose answer after COMMIT. | **GAP ACH-M-G5-RETRY**: Replay or conflict; refused when the normal record would succeed, and refused while `O > 0` (an oversized resend never becomes an over-return; nothing written). Invariant: transfer ID unique; `X = max(0, R − Q)`. Inject: same ID, changed amount; amount within refundable; amount above open REFUND_PAYABLE after a bounce (M4d). | **GAP ACH-M-G5-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up, reason, evidence. Inject: withdraw each. | **GAP ACH-M-G5-PARTIAL**: Rollback. Invariant: no receivable without case and record. Inject: fail case/event/journal write; assert exact cents. |
### 7.16 Record return bounce command (D-ACH-21)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **G3** `Krecordbounce`: bounce row on the record, frozen `ΔX`/REFUND_PAYABLE allocation, RETURN_BOUNCED case, journal, events | **GAP ACH-M-G3-RACE**: Allocation from the position at effect. Invariant: M3/M3′/M4 balances in every order. Inject: hold source booking lock; Kreversal/Kwriteoff/Krecordresend both orders. | **GAP ACH-M-G3-TIMEOUT**: Recover by transfer ID. Invariant: one bounce per transfer. Inject: COMMIT response timeout. | **GAP ACH-M-G3-EXPIRY**: Refuse stale proof; bounce of an old transfer still recordable. Invariant: effect-time step-up. Inject: cross proof validity. | **GAP ACH-M-G3-CRASH-BEFORE**: No bounce; refund COMPLETED unchanged. Invariant: atomic. Inject: crash after last write before Krecordbounce COMMIT. | **GAP ACH-M-G3-CRASH-AFTER**: Replay. Invariant: one cash-back. Inject: lose answer after COMMIT. | **GAP ACH-M-G3-RETRY**: Replay or conflict. Invariant: `B ≤ P`, one bounce per transfer. Inject: same key/changed `B`; second bounce of the same transfer. | **GAP ACH-M-G3-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up, evidence. Inject: withdraw each. | **GAP ACH-M-G3-PARTIAL**: Rollback. Invariant: no cash-back without allocation lines. Inject: fail case/event/journal write; assert exact cents. |
### 7.17 Record resend command (D-ACH-21)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **G4** `Krecordresend`: record row (RESEND, parent bounce), REFUND_PAYABLE settlement, journal, events | **GAP ACH-M-G4-RACE**: Amount ≤ open REFUND_PAYABLE at effect, else refused (two resends racing for one payable: one commits, the other is refused). Invariant: M4a–M4e. Inject: hold source booking lock; Kreversal/second resend/Krecordbounce both orders. | **GAP ACH-M-G4-TIMEOUT**: Recover by transfer ID. Invariant: one settlement. Inject: COMMIT response timeout. | **GAP ACH-M-G4-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity. | **GAP ACH-M-G4-CRASH-BEFORE**: Payable stays open. Invariant: atomic. Inject: crash after last write before Krecordresend COMMIT. | **GAP ACH-M-G4-CRASH-AFTER**: Replay. Invariant: one debit of REFUND_PAYABLE. Inject: lose answer after COMMIT. | **GAP ACH-M-G4-RETRY**: Replay or conflict; amount above open `O` REFUSED (`RESEND_EXCEEDS_PAYABLE`; no RecordOverReturn fallback; same refusal on replay). Invariant: transfer ID unique; refusal writes nothing. Inject: same ID changed amount; resend after reversal; 700 after a 400 resend of a 1,000 bounce (M4d). | **GAP ACH-M-G4-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up, destination evidence rule. Inject: withdraw each. | **GAP ACH-M-G4-PARTIAL**: Rollback; a refusal leaves record, case, journal and ledger untouched. Invariant: no settlement without record; partial resend (400) settles exactly 400 and leaves 600 open. Inject: fail event/journal write; assert exact cents. |
### 7.18 Apply incoming-credit reversal (D-ACH-09/18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **G6** `Kreversal`: authenticated reversal version applied to the capture (REVERSED) or unassigned credit, frozen `d`/`o`/`e`, authority consequences, DOUBLE_RETURN_RISK case when a refund is APPROVED, events/outbox | **GAP ACH-M-G6-RACE**: Allocation from the position at effect. Invariant: M2/M4b/M4c in both orders; authority revoked per B09. Inject: hold credit and source booking locks; Krecordreturn/Kapprove/Krecordbounce/Krecordresend/attribution both orders. | **GAP ACH-M-G6-TIMEOUT**: Recover by credit version. Invariant: one reversal. Inject: COMMIT response timeout. | **GAP ACH-M-G6-EXPIRY**: Apply despite expired order/approval. Invariant: real money recorded; no authority revived. Inject: cross order/approval deadlines. | **GAP ACH-M-G6-CRASH-BEFORE**: Capture stays COMPLETED; observation retained. Invariant: atomic. Inject: crash after last write before Kreversal COMMIT. | **GAP ACH-M-G6-CRASH-AFTER**: Replay. Invariant: one reversal posting. Inject: lose answer after COMMIT. | **GAP ACH-M-G6-RETRY**: Duplicate version no-op; amount ≠ gross opens PROVIDER_INCONSISTENCY. Invariant: identity is the credit version. Inject: redeliver; alter amount. | **GAP ACH-M-G6-REVOCATION**: Service applies regardless of owner loss. Invariant: service identity/fence required. Inject: revoke service/fence/scope. | **GAP ACH-M-G6-PARTIAL**: Rollback. Invariant: no REVERSED capture without allocation and authority consequences. Inject: fail case/authorization/event write; assert exact cents. |
### 7.19 FINANCE return-booking consumer (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P3** `Kreturnbook`: posting sets of `refund.completed`, `outbound.*` and reversal events from their frozen payloads, delivery markers | **GAP ACH-M-P3-RACE**: Any delivery order gives the same balances. Invariant: payload amounts only; oracle M1–M6 incl. M4d/M4e. Inject: hold ledger lock; deliver G2–G6 and P4 events in every order. | **GAP ACH-M-P3-TIMEOUT**: Recover by source key. Invariant: no repost on unknown COMMIT. Inject: ledger lock/COMMIT timeout. | **GAP ACH-M-P3-EXPIRY**: Stale fence cannot book; current fence books original dates. Invariant: fenced consumer. Inject: cross worker fence deadline. | **GAP ACH-M-P3-CRASH-BEFORE**: No set fragment. Invariant: set and marker atomic. Inject: crash after last write before Kreturnbook COMMIT. | **GAP ACH-M-P3-CRASH-AFTER**: Replay as posted. Invariant: one set per source key. Inject: lose settle after COMMIT. | **GAP ACH-M-P3-RETRY**: Identical events no-op; conflicting payload rejected to a case, including `outbound.resent` with `s` above open REFUND_PAYABLE and `outbound.over_returned` with open REFUND_PAYABLE. Invariant: source uniqueness; payable never driven negative. Inject: redeliver concurrently; alter payload. | **GAP ACH-M-P3-REVOCATION**: Fence stale worker; postings stay. Invariant: service scope/fence required. Inject: revoke service/fence/scope. | **GAP ACH-M-P3-PARTIAL**: Rollback all lines. Invariant: balanced set. Inject: fail each later line/marker; assert exact cents per account. |
### 7.20 Write off over-return command (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P4** `Kwriteoff`: reviewed `reconciliation_case.resolved.v1` correction RETURN_LOSS `w` ≤ open receivable, assurance, journal, events | **GAP ACH-M-P4-RACE**: `w` ≤ open receivable at effect. Invariant: receivable + written off = `X`; a later bounce credits RETURN_LOSS back (M3′). Inject: hold case and source booking locks; Krecordbounce/second write-off both orders. | **GAP ACH-M-P4-TIMEOUT**: Recover by journal. Invariant: no double write-off. Inject: COMMIT response timeout. | **GAP ACH-M-P4-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity. | **GAP ACH-M-P4-CRASH-BEFORE**: Case open; no posting. Invariant: atomic. Inject: crash after last write before Kwriteoff COMMIT. | **GAP ACH-M-P4-CRASH-AFTER**: Replay. Invariant: one correction. Inject: lose answer after COMMIT. | **GAP ACH-M-P4-RETRY**: Replay or conflict. Invariant: amount immutable. Inject: same key, changed amount. | **GAP ACH-M-P4-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up. Inject: withdraw each. | **GAP ACH-M-P4-PARTIAL**: Rollback. Invariant: no revenue/tax/commission/authority line. Inject: fail correction/journal/event write; assert exact cents. |
## 8. Cases and gates

Existing case IDs, PayPal implementations, evidence and unresolved live obligations stay as recorded in
[B09's case map](B09-case-map.md). This design does not regrade them or claim to close a provider integration gate.

| Existing R2 case / clause | Applies unchanged |
|---|---|
| S057, CMD029-DENY | Browser redirects, customer “sent” claims and manual drafts cannot mint payment or execution authority; PayPal capture remains server-side |
| S058, CMD030-DENY, CMD034 | Exact account/payee/environment/order/currency/status evidence; mismatches never grant authority; actual amount mismatch is recorded with capped allocation |
| S059 | Actual reversals, including reversal first observed, are reconciled monotonically; phase-specific revocation and no new charge; refund/reversal net once |
| S060 | Price validity does not extend source retention; expired/deleted sources block authority; reupload requires a new approved subject |
| R2-077, R2-078 | Integer pricing, no cent drift; illustrative fees are not provider facts; only observed merchant fees are posted |
| R2-081 | Refund components/tax/commission basis follow cumulative exact cents; existing refund ceilings and completion serialization remain |
| R2-128 | Legal/fiscal treatment is reviewed explicitly; USD, payer name or account location cannot determine tax |
| R2-140 | Distinct real receipts all accounted; repeated receipt events deduped; one service entitlement; excess liability/return and capped commission basis |
| R2-085 (B15) | Captured, held, provider-available and bank-available cash remain separate; no imaginary liquidity |
| CMD028–CMD034 OK/DENY/RACE, manuals 07/10/15 | Existing PayPal flows and clauses remain, including durable intent before outbound effects, authenticated observations, no transaction across a call, uncertainty, scoped journals and owner-approved refunds |

The inbound ACH path is a new contract branch, not evidence that PayPal webhook/capture cases cover manual credits.
D-ACH-06 deliberately retains the existing single-exact-capture authority rule. D-ACH-10 defines a new passive-transfer
expiry policy; the PayPal dispatch/price-expiry exception stays unchanged. New states, manual evidence trust and treasury
sources require accepted versioned contracts under the unlisted-transition policy; do not silently alter the vendored R2
registry. The matrix and acceptance cases below are proposals for that implementation mandate.

| Proposed case | Required scenario / oracle | Matrix rows |
|---|---|---|
| ACH-01 | PENDING_VERIFICATION→VERIFIED→ENABLED only with real evidence/config; withdrawn KYC/details disables; PayPal-only launch works | R1–R2, I1, I3 |
| ACH-02 | US labels/visibility, USD-only foreign checkout, no COP/BILL/Melio/subscription dependency; disabled/expired/foreign reads expose no details | I1–I3 |
| ACH-03 | Reference entropy/format/collision, rail preservation, exact amount/terms, one immutable intent/reference and conflicting-key refusal | I2, M1 |
| ACH-04 | Manual draft versus confirmed bank evidence; corporate owner/step-up guards; agency billing denied; identity/service/RLS and safe audit boundaries | C4–C6, M2, P1 |
| ACH-05 | Manual/API duplicates and immutable conflicts; overlapping/reordered pages, incomplete coverage and takeover; no skipped or twice-booked receipt | C1–C8, P2 |
| ACH-06 | Exact reference/account/rail/currency/payee/payer; missing/foreign/truncated reference, approved third-party payer and controlled attribution | M1–M2, P1 |
| ACH-07 | One real exact USD receipt applied while valid: one capture, CAPTURED/PAID, one authorization, exact ledger/fee/funds, normal consumer delivery | P1–P2 |
| ACH-08 | Partial 400+600 against 1,000 and overpayment 1,010 against 1,000: exact allocations, REVIEW/no authority, owner return, no fabricated aggregate capture | P1–P2, F1–F2, G1–G2, P3 |
| ACH-09 | Two distinct exact full receipts plus repeated delivery: one authorization, all money, excess liability/owner return, service basis capped | P1–P2, F1–F2, G1–G2, P3 |
| ACH-10 | Before/exact/after expiry, delayed bank observation, source/approval/route revocation and late credit: recorded money, no resurrection, reviewed remedy | I1–I3, P1, E1 |
| ACH-11 | Explicit ACH retirement→PayPal: one open checkout/purchase; old reference stays bound; late ACH is return-only; no automatic second charge | I2, M2, P1, E1 |
| ACH-12 | Unassigned booked receipt in shared treasury ledger; attribution reverses treasury and posts agency capture atomically; a return claim excludes attribution; treasury refund approved and recorded in route scope | M1–M2, P2, F1–F2, G2, G6 |
| ACH-13 | Versioned source/access-date fees, null versus observed zero, gross/net equality, later fees/conflicts and recorded outbound fees | R2, C3, P1–P2, G2–G5, P3 |
| ACH-14 | Owner approval: source/components, refundable-balance reservation, destination digest equal to payer evidence or ownership evidence, requester segregation, proof expiry/revocation | F1–F2, V3 |
| ACH-15 | Phase 1 manual outbound: no provider outbound call or attempt exists; records idempotent by Wise transfer ID across scopes; amount above refundable refused; resend above the bounce's open REFUND_PAYABLE refused with no over-return fallback (M4d); unrecorded statement debits keep reconciliation open; refusals of reads carry safe operational codes | G1–G2, G4–G5, C2 |
| ACH-16 | Record, reversal, bounce, resend and write-off in every order with exact cents: oracle M1–M6 plus M4d/M4e (partial then oversized resend refused) in both scopes; credit notes/commissions only from capture refund completion | G2–G6, P3–P4 |
| ACH-17 | Every matrix cell injected at its own boundary; security/log/evidence minimization and service fencing verified | All 248 GAP cells |
| ACH-18 | Payer authorization lifecycle: verify/replace/revoke with evidence, step-up and both-order races against matching, apply and refund approval | V1–V3, M2, P1, F2 |
| ACH-19 | D-ACH-20 boundary: with ACH ENABLED no automated outbound path is reachable; Appendix A requirements are listed and unchanged | G2, review of code paths |
| ACH-LIVE-01 | One legitimate real USD ACH credit to the verified Wise Business details, reconciled end to end with duplicate replay adding nothing | I2, C4–C6 or C1–C8, M1–M2, P1–P2 |

Implementation gate: all money/authority matrix GAPs closed with fault-harness evidence on real PostgreSQL; remaining applicable
transport GAPs closed before their path is enabled. Review schema/type/state/event equivalence and backstop guards, not only
handler examples. Required additive work includes route qualification/config versions; ACH order states/index/identity guard;
bank-credit evidence/matching/cursor/fences and manual command contracts; owner/service privileges and assurance; ledger treasury
scope, source guards and atomic posting groups; treasury refunds, outbound records, journal and scope extensions (D-ACH-19); owner record commands (D-ACH-21);
payer-authorization aggregate (D-ACH-17); OPS-2 accounts and return-accounting events (D-ACH-18);
DTO redaction/projections and consumer subscriptions. Add migrations **after the highest existing migration at implementation
time** (the inspected baseline already includes 0038); do not edit/re-number 0015–0017 or weaken PayPal constraints. The existing
PayPal suite and provider-neutral ledger/authority/refund cases must still pass. Fake adapter results prove local orchestration
only; API automation remains off until S-B verifies real endpoint capabilities and replay/absence semantics.

**ACH activation gate / ACH-LIVE-01:** after actual owner KYC and verified account details, ENABLE the configured route for a
controlled participant, issue a legitimate project quote/order at its accepted USD price under the qualified pricing policy
(no test-only price override), and send **one real ACH credit** using its unique reference. Reconcile via the initial owner-entry/confirmation path (or a qualified Wise adapter),
then verify bank evidence, stable credit ID, reference/payer fidelity, gross/observed fee/net, one capture/order/authorization,
ledger source sets with exact balances and normal downstream delivery. Replay the observation and demonstrate zero added money
or entitlement. Record exact code/config/environment subject, source/access-date fee version, provider IDs, proof/evidence refs,
input/expected/actual results and artifact digests in restricted evidence; redact bank secrets from the review bundle. Owner
reviewer acceptance opens general ACH exposure; failure returns to VERIFIED/disabled or PENDING_VERIFICATION as appropriate.
No CONTRACT_FAKE or screenshot can satisfy this gate.

PayPal's existing G-PAYMENT and launch obligations remain. Wise unavailability leaves PayPal-only launch viable. This inbound
live gate does not claim outbound automation, which is Phase 2 (Appendix A) with its own design review and live outbound gate.
The Phase 1 manual return procedure (approve in Kauro, send in Wise, record with evidence) must be reviewable and recoverable when
controlled ACH receiving is enabled.

## Appendix A. Phase 2 (post-launch): automated Wise outbound — not designed here

Phase 2 may enable API-driven outbound transfers only through a new design, Codex design review and its own live outbound gate.
The r2/r3 attempt at that design (per-phase TRANSFER_CREATE/TRANSFER_FUND attempts, `treasury_attempts`, transfer watchdog and
ReconcileOutboundTransfer, OUTBOUND_IN_TRANSIT, automated BOUNCE_RESEND, RefundDestination aggregate with rows D1–D4, repayment
assignment) is preserved as prior art in commits `35671da` and `bd76137` of `ach/domain-design`; it is not accepted design. Each
Codex outbound finding below is a requirement any Phase 2 design must answer, quoted verbatim by title (full text in
`tools/review/out/ach-design-9d5aa04c940a/`, `ach-design-r2-35671da*/` and `ach-design-r3-bd76137e5869/review.json`).
"Phase 1" names the part Phase 1 already satisfies.

| Round / id | Codex title (verbatim) | Phase 1 |
|---|---|---|
| r1 ACH-F1 | “Independent outbound transfers cannot reuse source-netting as their complete cash accounting” | Satisfied for recorded transfers and reversals (D-ACH-18) |
| r1 ACH-F2 | “The orderless refund source is not mapped through PaymentAttempt and service recovery” | No attempts; route-scope records (D-ACH-19) |
| r1 ACH-F3 | “The matrix omits mutations of new payer and destination verification facts” | Payer: V1–V3; destination lifecycle is Phase 2 |
| r1 ACH-F4 | “The port lacks a defined channel for safe operational error codes” | Reads: `REFUSED`; dispatch semantics Phase 2 |
| r2 ACH-F1 | “Double-debit accounting is repaired, but bouncing an excess return creates a false refund liability” | Satisfied (D-ACH-18 bounce allocation, M3) |
| r2 ACH-F5 | “The ledger has no cash fact for funding a transfer before recipient completion” | Not applicable: only sent transfers are recorded |
| r2 ACH-F6 | “BOUNCED_REFUND resends are absent from the closed persistence and attempt model” | Manual RecordResend (G4) only |
| r2 ACH-F7 | “Recovery-credit attribution can book an incoming repayment twice” | No repayment reclassification in Phase 1 |
| r3 ACH-F5 | “Funding cash is represented, but retry after returned funding conflicts with its identities” | Phase 2 |
| r3 ACH-F7 | “Repayment double-booking is fixed, but assignment does not reserve its deferred allocation” | Phase 2 |
| r3 ACH-F8 | “Confirmed funding removes the transfer from its only defined recovery sweep” | Phase 2 |
| r3 ACH-F9 | “An assigned repayment credit has no reversal allocation” | Phase 2 |
| r3 ACH-F10 | “Source locking does not establish posting dependencies for reordered events” | Satisfied by frozen payload amounts (D-ACH-18) |
| r3 ACH-F11 | “S3 clears an obligation that funding has not discharged” | Not applicable (no funding state; M6 keeps obligation) |
