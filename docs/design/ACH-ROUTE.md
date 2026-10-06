# ACH bank-transfer route — owner amendment A8

Design only, revision **r3**. Codex r1 of `9d5aa04`: F1 → D-ACH-18, F2 → D-ACH-19, F3 → D-ACH-17 and rows V1–V3/D1–D4, F4 →
the operational channel of D-ACH-15. Codex r2 of `35671da`: bounce allocation, funding cash fact, repayment reclassification →
D-ACH-18 (account-flow table, oracle) and rows P3–P6; BOUNCE_RESEND model → D-ACH-19. Owner decision supplied **2026-10-05**.
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
observation/reconciliation records, FINANCE/FISCAL/COMMISSIONS consumers and append-only commerce ledger. Outbound effects use
PaymentAttempt with new transfer operations (agency scope) or its route-scope sibling (D-ACH-19). Do not invent a Wise “order
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

## 5. Owner-approved outbound returns

**D-ACH-13 — Refund source and authority.** Reuse Refund's REQUESTED→APPROVED→SUBMITTING→UNCERTAIN/COMPLETED/FAILED and
REJECTED states and its service/tax/excess components. The **source** is a closed union: **CAPTURE** (a matched credit's
capture, agency scope, the existing `refunds` row) or **BANK_CREDIT** (a booked unassigned USD ACH credit, route scope,
**excess-only** components, D-ACH-19). A resend of a bounced return is not a third source but the origin **BOUNCE_RESEND** on
the same source and scope (D-ACH-19). No fake CaptureFact, order or agency. A component approval reserves the remaining
dischargeable cents against *all* pending/completed refunds and reversals of its source; a resend approval reserves principal
against the source's open REFUND_PAYABLE (D-ACH-18). Attribution, return claims, resend approvals, recovery assignments and
provider reversals of one source share its **source booking lock**; B09 capture refunds keep their per-capture completion lock.

Every ACH outbound return, including excess/expiry/unassigned remedies, requires an **active KAURO_OWNER**, verified active
identity, fresh step-up at approval after locks, immutable approval/effects hashes and reason; no standing-policy auto-approval
in the first release. Preserve customer requester/approver segregation (KP008). An agency BILLING member may request a refund
but cannot approve or dispatch. Bind source, exact USD principal/components, the current VERIFIED RefundDestination version and
digest (D-ACH-17), verified payer evidence, quote terms if applicable, delivery phase, owner approval proof, fee-policy version
and maximum outbound fee into the prepared intent/hash. Knowledge of a reference never proves a destination; no arbitrary
third-party destination or silent conversion. Changing amount/destination/fee ceiling voids the undispatched intent and needs a
new approval. Returning allocated service affects tax/commissions/authorization under existing B09 rules (D-LEDGER-B7, R2-081).

**D-ACH-17 — Payer and destination verification facts.** Two new versioned aggregates. Consumers bind an exact version and
re-read it under lock at their effect (M2, P1, F2, F3, F6); validity expiry is checked there, with no sweep.

| Machine: edge | Actor and guard | One-COMMIT footprint (row) |
|---|---|---|
| PayerAuthorization: absent→VERIFIED `payer_authorization_verified` | KAURO_OWNER, verified identity, fresh step-up; agency BILLING request evidence plus payer identity evidence; kind PAYER_ALIAS or THIRD_PARTY_PAYER; validity bound | Version, evidence refs/digests, assurance, agency journal, audit/events/outbox (V2) |
| PayerAuthorization: VERIFIED→SUPERSEDED `payer_authorization_replaced` | As verify, atomically with the successor's VERIFIED | Both versions in V2 |
| PayerAuthorization: VERIFIED→REVOKED `payer_authorization_revoked` | KAURO_OWNER, or agency OWNER/BILLING (revocation only narrows authority) | State, review case naming MATCHED-unapplied credits bound to it, journal, events (V3) |
| RefundDestination: absent→PENDING_VERIFICATION `destination_recorded` | KAURO_OWNER from restricted evidence; customer-typed bank fields are evidence, never the fact; scope AGENCY (capture source) or RECEIVING_ROUTE (bank-credit source) | Version, encrypted artifact ref/digest, provenance, scope, journal, events (D2) |
| RefundDestination: PENDING_VERIFICATION→VERIFIED `destination_verified` | KAURO_OWNER step-up; ownership evidence ties the account to the verified payer (e.g. the originating account in the credit's bank evidence) plus the Wise recipient ref | State, prior VERIFIED→SUPERSEDED, assurance, journal, events (D3) |
| RefundDestination: PENDING_VERIFICATION/VERIFIED→REVOKED `destination_revoked` | KAURO_OWNER; payment service on authenticated recipient-deactivation evidence; agency BILLING for agency-scope destinations | State, case naming APPROVED unclaimed returns bound to it, journal, events (D4) |

Revocation never rewrites an applied capture or a claimed phase: P1 returns a MATCHED credit whose authorization is no longer
current to MATCH_REVIEW; F3/F6 deny unclaimed phases; claimed phases reconcile (D-ACH-14). The first release records the Wise
recipient manually; API recipient or quote creation are provider effects that S-B must add as attempt operations with their own
matrix rows before automation.

**D-ACH-14 — Dispatch and observe.** Keep B09's durable intent→claim→call outside transaction→SERVICE settle→journal completion
protocol and uncertainty vocabulary. A return is a new **outbound transfer**, not a PayPal capture-refund call. CREATE and FUND
are separate attempts (D-ACH-19), each with its own prepared request hash, idempotency identity, bounded claim/fence, external ID
and durable settle; FUND can be prepared only after the created transfer ID is durable. Every provider call and local COMMIT is a
§7 row; the adapter never hides create+fund behind an apparently atomic retry. Funding retries are allowed only with documented
same-transfer idempotency for the exact endpoint/profile; otherwise observe/escalate, never blind-fund again. Provider “sent” or
accepted/pending is not recipient completion. COMPLETED requires the qualified completion mapping, USD principal, exact
transfer/source/destination identities and the local refund reference. Unknown status is UNRECOGNIZED_PROVIDER_STATE;
timeout/reset/5xx/lost response is UNCERTAIN, not FAILED; lookup absence never proves no transfer.

After a claim, role, destination or payer revocation, credential loss, lease expiry or source reversal cannot erase a possible
external effect. Stop every unclaimed phase whose prerequisites lapse — in particular, a source reversed before the FUND claim
denies funding — and reconcile claimed phases by identity. Never describe a funded return as “cancelled with no effect”; its money
is accounted by D-ACH-18. Refund state: SUBMITTING from the CREATE claim until a result; UNCERTAIN while either phase is
uncertain; an unfunded created transfer whose FUND proved no effect returns to APPROVED for a bounded new FUND attempt or FAILED.
An authenticated funding fact (FUND response, statement debit naming the transfer, or a status S-B qualified as funded) settles
the FUND attempt CONFIRMED and books `transfer.funded` while the refund stays SUBMITTING until recipient completion; funding
returned before completion books `transfer.funding_returned` and sets the refund to APPROVED (bounded new attempt) or FAILED.
Failed/proved-no-effect permits only a deliberate bounded new attempt after ceilings and authority are rechecked. Approval
duration and claim windows are versioned; a stored expired approval is not dispatch permission.

In manual mode, approval and a durable execution claim of the phase attempt precede the owner's action in Wise's UI; the owner
confirms with restricted provider evidence through the same normalized observation/settle path. A crash after a manual claim is
a possible external effect: observe before doing anything again. UI/API modes are mutually exclusive per attempt and share
transfer IDs, ceilings and register. Manual readiness, destination checking and recovery suffice for the controlled credit
gate; automated outbound transfers may stay disabled until S-B qualifies them.

**D-ACH-18 — Cash accounting of outbound transfers, reversals, bounces and recoveries (answers r1 F1; r2 F1, F5, F7).**
B09 netting (`refundReturnOf`, `capture.reversed.v1` reversed*Cents) answers only which obligation components a return
**discharges**: each component once, whichever of refund completion and reversal is observed first. It keeps that role, and with
it credit notes (D-FISC-B2: one per refund, from its approved components), commission basis and authorization consequences
(D-LEDGER-B7). It is not the cash fact: a PayPal refund cannot follow its chargeback, but a Wise outbound transfer is independent
of the incoming credit's ACH return, so both can leave the account. Every bank-transfer source (capture or bank credit; amount
`Q` = its gross) keeps a **return position** computed only from its own posting sets under the source booking lock (no second
register): `R` = net principal the payer holds from returns (completed transfers + incoming reversal − bounces − assigned
repayments), open REFUND_PAYABLE `O` (owed but undelivered) and excess position `X` = open RETURN_RECOVERY_RECEIVABLE + written off.
**Invariant after every event, in every observation order and both scopes: `X = max(0, R − Q)`, and no residual
OUTBOUND_IN_TRANSIT or CUSTOMER_OVERPAYMENT for a settled transfer or an assigned repayment.**

Allocation rules. A **delivery** of principal `P` (transfer completion, incoming reversal, resend completion) splits into
`d` = B09 discharge, then `o = min(P − d, O)`, then `e = P − d − o` to the receivable. An **undelivery** of a completed transfer
(bounce of principal `P`, cash back `B ≤ P`) reduces `X` by `ΔX = X − max(0, R − P − Q)`, taken from the open receivable first,
then from the written-off amount (credit RETURN_LOSS), and the remainder `P − ΔX` becomes REFUND_PAYABLE: a legitimate return
is owed again (also when an earlier repayment made the payer whole); nothing is owed when the payer already holds the incoming
reversal. Credit notes, commission basis and authority never change at an undelivery. A repayment `G` reduces `X` (receivable
first, then written off) and `R`; it is refused when `G > X`. A write-off moves `w` from receivable to written off.

Account flows (provider balances = the source's PSP account up to its movable balance, the rest PSP_AVAILABLE, D-LEDGER-B6;
movable balance = amount − fee − principal already funded or reversed, not `returnedCentsOf`'s cap):

| Event (posting source key; row) | DEBIT | CREDIT |
|---|---|---|
| `transfer.funded` (transfer ID; balanceTransactionId is evidence, a different one is PROVIDER_INCONSISTENCY) (P3) | OUTBOUND_IN_TRANSIT `P` | provider balances `P` |
| `transfer.funding_returned` before completion (transfer ID) (P3) | PSP_AVAILABLE `B`; PROCESSOR_EXPENSE `P − B` | OUTBOUND_IN_TRANSIT `P` |
| `transfer.completed` / resend completed — delivery (P5) | CONTRACT_LIABILITY/TAX_PAYABLE/CUSTOMER_OVERPAYMENT `d`; REFUND_PAYABLE `o`; RETURN_RECOVERY_RECEIVABLE `e` | OUTBOUND_IN_TRANSIT `P` |
| `capture.reversed` / `bank_credit.reversed` — delivery (P5) | same `d`/`o`/`e` lines | provider balances `P` |
| `transfer.bounced` after completion — undelivery (P5) | PSP_AVAILABLE `B`; PROCESSOR_EXPENSE `P − B` | RETURN_RECOVERY_RECEIVABLE and RETURN_LOSS by `ΔX`'s parts; REFUND_PAYABLE remainder |
| `bank_credit.assigned` to RETURN_RECOVERY — one group with the credit's receipt (P2 after P4) | reversal of the treasury receipt set: CUSTOMER_OVERPAYMENT `G`; recovery set: provider balances `G` | treasury receipt reversal: provider balances `G`; recovery set: RETURN_RECOVERY_RECEIVABLE / RETURN_LOSS by parts of `G` |
| `return_recovery.written_off` (P6) | RETURN_LOSS `w` | RETURN_RECOVERY_RECEIVABLE `w` |
| `transfer.fee_observed` (transfer ID) (P5) | PROCESSOR_EXPENSE fee | provider balances fee |

A completion observed before its funding posts the funding set first in the same group; the later funding observation is a
duplicate of the transfer-ID key. A funded transfer still PENDING keeps the Refund SUBMITTING with OUTBOUND_IN_TRANSIT `P`; a
reversal arriving meanwhile denies nothing already funded but is allocated as a delivery. A repayment credit is booked once as an
ordinary treasury receipt (D-ACH-11) and **reclassified**, never booked twice: its assignment to a RETURN_RECOVERY case (P4) is
an exclusive attribution target beside CAPTURE and TREASURY_RETURN, taken under the credit lock and the source booking lock,
refused when `G > X` (the owner returns it as a BANK_CREDIT refund instead), and booked by the same credit booking group as capture attribution (cutoff, `bank_credit.assigned` reversal, pending
credit-version drain, delivery markers): if the receipt is already posted, the group reverses it and posts the recovery set; if
not, it posts receipt, reversal and recovery in one transaction and later receipt delivery is a no-op. A fee on the repayment
stays the credit's processor expense in route scope.

Oracle (USD 1,000 credit, `Q` = 1,000, zero fees; identical for a matched capture and an unassigned credit; balances after the
last event, provider net includes the +1,000 receipt):

| Scenario and both observation orders | Provider net | In transit | Receivable | Written off | REFUND_PAYABLE | Obligation |
|---|---|---|---|---|---|---|
| S1 r1: reversal → fund → complete, or fund → complete → reversal | −1,000 | 0 | 1,000 | 0 | 0 | 0 |
| S2 r2 F1: S1 then bounce of the transfer (`B` = 1,000), either S1 order | 0 | 0 | 0 | 0 | 0 | 0 |
| S2′: S1, write-off, then bounce | 0 | 0 | 0 | 0 (RETURN_LOSS reversed) | 0 | 0 |
| S2″: S1, repayment assigned, then bounce | +1,000 | 0 | 0 | 0 | 1,000 (customer owed again) | 0 |
| S3 r2 F5: fund, FUND answer lost, transfer PENDING | 0 | 1,000 | 0 | 0 | 0 | 0 (refund SUBMITTING) |
| S3a: S3, reversal, funding returned (either order) | 0 | 0 | 0 | 0 | 0 | 0 |
| S3b: S3, reversal, completion, duplicate funding/completion events | −1,000 | 0 | 1,000 | 0 | 0 | 0 |
| S4: fund → complete → bounce (legitimate return) | +1,000 | 0 | 0 | 0 | 1,000 | 0 |
| S4a: S4, resend funded and completed | 0 | 0 | 0 | 0 | 0 | 0 |
| S4b: S4, reversal (resend FUND claim then denied: `O` = 0) | 0 | 0 | 0 | 0 | 0 | 0 |
| S4c: S4, resend completed, then reversal | −1,000 | 0 | 1,000 | 0 | 0 | 0 |
| S5 r2 F7: S1, repayment `G` = 1,000 receipt posted then assigned, or assigned then posted, events replayed | 0 | 0 | 0 | 0 | 0 | 0 |
| S5′: S1, write-off, then repayment assigned | 0 | 0 | 0 | 0 (RETURN_LOSS credited back) | 0 | 0 |

Every scenario ends with CUSTOMER_OVERPAYMENT 0 for the repayment credit and exactly one credit note/commission effect.
Obligations: additive account catalogue OPS-2 (OUTBOUND_IN_TRANSIT and RETURN_RECOVERY_RECEIVABLE assets, RETURN_LOSS expense);
registered event types/members above for bank-transfer sources only; PayPal events, accounts and arithmetic unchanged.

**D-ACH-19 — Executing a return through attempts and recovery (answers F2).** Closed scope union, no nullable tenant:

- **AGENCY** (CAPTURE source): existing `refunds` and agency/order-bound `payment_attempts` with the 0016 refund FK unchanged.
- **RECEIVING_ROUTE** (BANK_CREDIT source): sibling tables `treasury_refunds` and `treasury_attempts`, registered as aggregate
  kinds of the existing **Refund** and **PaymentAttempt** machines (same states, edges and transition triggers), keyed by
  `(route_id, environment, account_ref)` with a `bank_credit_id` FK to the credit register and a composite attempt→refund FK
  mirroring `payment_attempts_refund_fk`. No tenant RLS policy: only `kauro_payment` and active KAURO_OWNER finance access. A
  treasury refund never migrates to agency scope.
- **Operations:** `TRANSFER_CREATE` and `TRANSFER_FUND` (new values; `REFUND` stays PayPal's capture refund). Each phase is its
  own attempt with `provider_request_id = 'kauro-' || attempt_id`, ordinal ≤ 3, dispatch deadline and outcome code; Wise's UUID
  idempotency key is the attempt's own UUIDv7. Per-refund live/confirmed/ordinal indexes are keyed by `(refund_id, operation)`
  for these operations; the existing REFUND indexes are restricted to `operation = 'REFUND'`. The CREATE settle records an
  `outbound_transfers` row (scope, refund, account, transfer ID, destination version, principal; transfer ID unique per
  account/environment across both scopes) and prepares the FUND attempt in the same COMMIT.
- **BOUNCE_RESEND origin (answers r2 F6):** a resend is a row of its parent's table and scope (`refunds` or `treasury_refunds`)
  with `origin = 'BOUNCE_RESEND'`, the parent's source FK, `resend_of_refund_id` FK to a COMPLETED parent of the same source
  whose bounce is booked (`bounce_event_id`), zero components and immutable `principal_cents > 0`; every other origin has NULL
  principal (principal = component sum). Migration obligations: an origin-closed CHECK tying these fields; `refunds_intent_positive`
  and `refunds_intent_components` (0016) and `checkRefundAmounts` gain an explicit resend branch allowed only on BANK_TRANSFER
  routes (PayPal refunds can never take it); `credit_note_required = false`. Approval (F2), under the source booking lock,
  reserves `principal ≤ O − Σ principal of resends APPROVED/SUBMITTING/UNCERTAIN`; its hash binds parent, bounce event, principal
  and a current VERIFIED destination (normally a new version). CREATE and FUND claims recheck the reservation against the current
  `O` (a reversal that made the payer whole denies an unclaimed phase). Attempts, `outbound_transfers`, observations,
  ReconcileOutboundTransfer and the watchdog are the parent scope's, with `refund.resendOf` set; completion is a delivery whose
  `o` part settles REFUND_PAYABLE (D-ACH-18).
- **Code:** `TransferAttemptSubject = {scope: AGENCY, order, refund, capture} | {scope: RECEIVING_ROUTE, credit, refund}` with
  `transferAttemptRequest()` over `WiseBankTransferPort.prepareOutboundTransfer`; PayPal's `AttemptSubject`/`attemptRequest`
  stay unchanged. The B09 prepare→claim→dispatch→settle helpers are parameterized by a per-scope attempt store; no path builds an
  order for a credit.
- **Journal, scope index, observations:** route-scope owner commands and service settles journal in a closed
  `journal_scope = RECEIVING_ROUTE` (route ref, NULL agency) — a check-constrained extension of `command_journal`, whose only
  NULL-agency case today is CreateAgency — and attempts' `intent_entry_id` FKs follow their scope. `commerce_scopes` stays
  agency-only; a sibling `treasury_scopes` (TREASURY_REFUND, BANK_CREDIT, PROVIDER_TRANSFER, PROVIDER_CREDIT) holds route-scope
  identities, and one shared provider-identity uniqueness index across both prevents an ID resolving to two scopes. Outbound
  observations carry subject TRANSFER in their attempt's scope.
- **Recovery:** a new watchdog `watchTransferAttempt(scopeRef, attemptId)` adopts `REFUND` or `TREASURY_REFUND` scope — never
  PAYMENT_ORDER — waits for the dispatch deadline, observes by transfer ID (or by idempotency key for a CREATE whose answer was
  lost), stores PROVIDER_QUERY evidence and applies it through a new service command **ReconcileOutboundTransfer** (registry id
  assigned at implementation; CMD034's analogue) with journal key `watchdog-<observationRef>`. Unclaimed PREPARED attempts may be
  cancelled before dispatch; a claimed attempt without conclusive evidence stays UNCERTAIN.
- **Idempotency:** approve binds the owner key to the effects hash; execute binds refund, phase and request hash; reconcile
  binds the observation ref. Same key/different body conflicts; replay returns the durable attempt/refund state.

## 6. Wise bank-transfer port and security

**D-ACH-15 — Proposed TypeScript sketch.** A new bank-transfer port alongside PaymentProviderAdapter, following `provider.ts`'s
normalized shapes and `ports.ts`'s prepare/dispatch/observe discipline. Vendor payloads stay inside S-B. Names are proposals,
not exports in this commit.

```ts
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProviderOutcomeKind, AmbiguityReason, ProviderRequest } from "./provider.js";
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
  // The provider refused this request. Read: not served. Dispatch: `proof` present only when S-B qualified that this code
  // rejects before any effect (settles FAILED_NO_EFFECT); otherwise the attempt settles UNCERTAIN and is observed.
  | { readonly kind: "REFUSED"; readonly operational: Operational;
      readonly proof: (Evidence & { readonly absenceIsProof: true }) | null };

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
type OutboundSource =
  | { readonly kind: "CAPTURE"; readonly agencyId: string; readonly captureId: string }
  | { readonly kind: "BANK_CREDIT"; readonly routeId: string; readonly bankCreditId: string };
interface OutboundIntent {
  readonly refundId: string;
  readonly attemptId: string; // the phase's own attempt (D-ACH-19); Wise UUID idempotency key = this UUIDv7
  readonly accountRef: WiseAccountRef; readonly source: OutboundSource;
  readonly resendOfRefundId: string | null; // BOUNCE_RESEND origin (D-ACH-19); zero components, principal = amountCents
  readonly destination: { readonly ref: string; readonly version: string; readonly digest: Sha256Hex;
    readonly providerRecipientRef: string };
  readonly amountCents: bigint; readonly currency: "USD"; readonly maxFeeCents: bigint;
  readonly feePolicyVersion: string; readonly approvalHash: Sha256Hex;
}
type OutboundPhase = { readonly phase: "CREATE" } | { readonly phase: "FUND"; readonly transferId: string };
interface OutboundObservation extends Evidence {
  readonly transferId: string; readonly platformRefundRef: string | null; readonly accountRef: WiseAccountRef;
  readonly destinationDigest: Sha256Hex; readonly amountCents: bigint; readonly currency: string;
  readonly feeCents: bigint | null;
  readonly status: "CREATED" | "FUNDED" | "COMPLETED" | "FUNDING_RETURNED" | "BOUNCED" | "FAILED" | "UNRECOGNIZED";
  readonly fundingBalanceTransactionId: string | null; // funding evidence (D-ACH-18 transfer.funded)
  readonly returnedCents: bigint | null;              // cash back of FUNDING_RETURNED / BOUNCED
  readonly observedAt: UtcInstant;
}
interface WiseBankTransferPort {
  readonly provider: "wise"; readonly environment: PaymentEnvironment; readonly integrationClass: IntegrationClass;
  getAccountDetails(account: WiseAccountRef, deadline: UtcInstant): Promise<Outcome<UsdAchAccountDetails>>;
  listIncomingCredits(input: { readonly accountRef: WiseAccountRef; readonly since: Cursor | null;
    readonly limit: number; readonly deadline: UtcInstant }): Promise<Outcome<CreditPage>>;
  getCreditById(input: { readonly accountRef: WiseAccountRef; readonly creditId: CreditId;
    readonly deadline: UtcInstant }): Promise<Outcome<IncomingCredit>>;
  // Pure. Exact method/profile/body/semantic headers, credentialRef only; hash before claim.
  prepareOutboundTransfer(intent: OutboundIntent, phase: OutboundPhase): ProviderRequest;
  // One separately journalled phase attempt per call; never concealed create+fund calls.
  initiateOutboundTransfer(input: { readonly request: ProviderRequest; readonly phase: OutboundPhase;
    readonly attemptId: string; readonly deadline: UtcInstant }): Promise<Outcome<OutboundObservation>>;
  observeOutboundTransfer(input: { readonly accountRef: WiseAccountRef; readonly transferId?: string;
    readonly attemptId: string; readonly deadline: UtcInstant }): Promise<Outcome<OutboundObservation>>;
  // Pure classification of authenticated stored evidence, including manual bank artifacts.
  classifyCredit(evidence: Evidence): IncomingCredit;
  classifyOutbound(evidence: Evidence): OutboundObservation;
}
```

An Outcome COMPLETED means the **port operation** returned conclusive evidence; inspect the inner credit/transfer status before
asserting money completion. `PENDING` is a recognized nonterminal response. AmbiguityReason keeps exactly TIMEOUT,
CONNECTION_RESET, PROVIDER_5XX, UNREADABLE_RESPONSE and OBSERVATION_LOST. Authentication, permission, SCA, rate-limit,
unavailable-capability and validation refusals travel only as `REFUSED` with an `Operational` code bound to the refused
request's hash: the settle stores the code as that attempt's `outcome_code` (an existing token column) or, for reads, as a
coverage-gap/route-operational event; it is surfaced to the owner as a safe code, never provider prose. A refusal resolves
nothing but its own request: it cannot settle an earlier ambiguous dispatch, and without qualified `proof` a refused dispatch is
UNCERTAIN and observed. An SCA/permission refusal of a statement read keeps the cursor, records the coverage gap and leaves the
owner-manual route available. Read-list absence is never PROVED_NO_EFFECT; a missing credit/status lookup is PENDING or
AMBIGUOUS/OBSERVATION_LOST unless authoritative absence has been qualified. UNRECOGNIZED never becomes success/failure.

`listIncomingCredits` is observational, idempotent and at least once; repeated/overlapping pages and changed statuses for the
same credit are expected. `getCreditById` is a logical port capability, not a claim that Wise offers a direct endpoint with
that shape. S-B may find it in authenticated statements using a bounded covered range. It must prove stable credit IDs, cursor
coverage, reference/payer fidelity, gross/fee semantics, completion/return mapping and region-specific access. If API capability
is absent, report unavailable and retain the owner-manual route; do not manufacture evidence or require APIs for launch.

Design research accessed **2026-10-05**: [Wise statements](https://docs.wise.com/api-reference/balance-statement) expose account
activity; [developer guidance](https://docs.wise.com/guides/developer) describes transfer idempotency;
[transfer reference](https://docs.wise.com/api-reference/transfer) is the source to qualify exact create/funding/status behavior.
These inform the proposed adapter mapping, not proof of Kauro's entitlement to these endpoints. S-B freezes an API profile and
evidence for the actual account, independently qualifies each phase and records which observations can prove no effect.

**D-ACH-16 — Authority and audit.** Manual entry **and confirmation** require an active corporate `KAURO_OWNER`, active verified
identity, live session and fresh step-up proof at their respective effects. Agency OWNER/BILLING is not corporate KAURO_OWNER.
Agency-scope facts use the agency's command journal and adopted finance scope; route-scope facts (unattributed credits, treasury
refunds, route-scope destinations) use the RECEIVING_ROUTE journal scope of D-ACH-19, never a customer-provided agency. Service
ingestion/apply requires authenticated PAYMENT_SERVICE bound to the same environment. Preserve the `kauro_app` versus
`kauro_payment` boundary: the owner writes draft/confirmation/verification decisions; only a service-authorized consumption of
those decisions writes captures, observations, attempts and CommercialAuthorization.

Entry and confirmation are separate idempotent commands with immutable evidence and audit. The same corporate owner may do
both (single-owner operation is allowed), but confirmation performs a new evidence comparison and fresh effect-time assurance;
it cannot merely copy the draft or bless a customer's claim. If role/identity/proof is revoked before confirmation, deny it.
Once confirmed, the receipt remains recoverable and later owner revocation never deletes money. Attribution overrides and
route enablement/destination verification also require fresh step-up. Effect guards protect grant, identity verification,
session/proof, account/details/fee verification, payer alias, destination and service/lease fence as applicable, in both
interleaving orders. Separate locks from evidence reads; revalidate before writing after any await.

Audit events proposed: route configured/verified/enabled/disabled/verification withdrawn; instructions issued/read denied;
credit entered/confirmed/rejected/observed/duplicate/conflict; payer authorization verified/replaced/revoked; destination
recorded/verified/revoked; match accepted/reviewed/overridden/returned to review; credit applied and authority granted/blocked;
order expired/retired; refund requested/approved/claimed/ambiguous/refused/observed/completed/failed/bounced; excess return
booked/recovered/written off; cursor advanced/coverage gap and treasury posting/correction. Each has actor/service, environment,
scope, entity/version IDs, reason token, correlation/journal key digest, proof/evidence refs and decision/effects hashes. Commit
ALLOW facts with the authorized effect; durably record DENY facts through the existing separate security-fact path after
rollback. Events per aggregate version and registered subscribers remain mandatory. No routing/account numbers, tokens, raw
memos, payer names, destination bank fields, raw statements or credential values appear in logs, outbox payloads, analytics,
error bodies or evidence bundles. Keep originals encrypted in the restricted evidence store, accessed through audited finance
reads; use refs/digests and masked displays.

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
delivery markers and other actors' commits. Rows D1–D4, F1–O3, W1 and P3–P6 run each cell in **both source scopes** (AGENCY capture
source, RECEIVING_ROUTE bank-credit source), and F1–O3 and W1 also for the BOUNCE_RESEND origin, inside the one titled test,
asserting the scope- and origin-specific footprint.

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
| **P2** `Kbook`: receipt/fee/funds posting or atomic attribution group (treasury reversal + capture set or RETURN_RECOVERY set), delivery markers | **GAP ACH-M-P2-RACE**: One posting group orders sources. Invariant: no duplicate receipt/fee/return across scopes. Inject: hold booking/source locks; FINANCE redelivery/capture attribution/Krecoveryassign/fee/return/reversal both orders. | **GAP ACH-M-P2-TIMEOUT**: Recover group by source IDs. Invariant: unknown COMMIT never reposts. Inject: inject ledger lock/statement/COMMIT acknowledgement timeout. | **GAP ACH-M-P2-EXPIRY**: Book historical evidence despite order expiry. Invariant: lease expiry cannot authorize stale delivery. Inject: cross worker fence deadline; retry under current fence with original event dates. | **GAP ACH-M-P2-CRASH-BEFORE**: No posting group fragment survives. Invariant: balanced source sets and markers atomic. Inject: crash after last write before Kbook COMMIT. | **GAP ACH-M-P2-CRASH-AFTER**: Replay group as already posted. Invariant: receipt and reclassification counted once. Inject: lose consumer settle after Kbook COMMIT. | **GAP ACH-M-P2-RETRY**: Identical events no-op; conflicting source rejected. Invariant: event/line and group uniqueness. Inject: redeliver each source concurrently and corrupt linked receipt/capture body. | **GAP ACH-M-P2-REVOCATION**: Fence stale worker; preserve postings. Invariant: service scope/fence required; owner loss never erases money. Inject: revoke service/fence/account scope independently during booking. | **GAP ACH-M-P2-PARTIAL**: Rollback every group set/marker. Invariant: no residual treasury or double balance. Inject: fail second/later receipt/reversal/capture/fee/funds/marker writes; assert exact account cents. |
### 7.12 Expiry sweep / retire-checkout transition (D-ACH-05/10)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **E1** `Kexpiry`: locked order expiry/retirement, cases/refund requests, events (retirement also journals) | **GAP ACH-M-E1-RACE**: Payment first preserves CAPTURED; expiry first is return-only. Invariant: no reopened order or duplicate entitlement. Inject: hold order/project locks; apply/partial credit/PayPal switch/refund both orders. | **GAP ACH-M-E1-TIMEOUT**: Recover state; rerun sweep safely. Invariant: timeout cannot release uncertain money. Inject: inject lock/statement/lost COMMIT response timeout. | **GAP ACH-M-E1-EXPIRY**: Only expire at effectNow >= deadline. Invariant: price/source clocks never extended. Inject: test before/exact/after deadline after held lock; route retirement separately. | **GAP ACH-M-E1-CRASH-BEFORE**: Rollback closure and return requests. Invariant: no orphan expiry consequence. Inject: crash after final write before Kexpiry COMMIT. | **GAP ACH-M-E1-CRASH-AFTER**: Replay committed closure. Invariant: old reference remains bound. Inject: lose sweep settle/retirement response after Kexpiry COMMIT. | **GAP ACH-M-E1-RETRY**: Repeated sweep/events do not duplicate requests. Invariant: expiry monotonic; quote release guarded. Inject: redeliver sweep and retirement key; change target/body. | **GAP ACH-M-E1-REVOCATION**: Stale service cannot sweep; money remains. Invariant: service/fence/retirement-member authority checked. Inject: withdraw service/fence or billing identity/membership independently. | **GAP ACH-M-E1-PARTIAL**: Rollback state/case/refund/events/journal. Invariant: partial received cents preserved. Inject: fail later consequence/event writes; assert existing captures and quote reservations unchanged. |
### 7.13 Record refund destination command (D-ACH-17)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **D2** `Kdestrecord`: destination version PENDING_VERIFICATION, encrypted artifact ref/digest, provenance, scope, journal, events | **GAP ACH-M-D2-RACE**: Versions append; none is usable before D3. Invariant: one version per (scope, digest) chain; no approval binds PENDING. Inject: hold destination lock; second record/verify/revoke/Krefundintent both orders. | **GAP ACH-M-D2-TIMEOUT**: Recover by journal. Invariant: no duplicate version. Inject: COMMIT response timeout. | **GAP ACH-M-D2-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity after lock wait. | **GAP ACH-M-D2-CRASH-BEFORE**: Nothing persists, artifact unreferenced. Invariant: record atomic. Inject: crash after last write before Kdestrecord COMMIT. | **GAP ACH-M-D2-CRASH-AFTER**: Replay same version. Invariant: one recorded event. Inject: lose answer after Kdestrecord COMMIT. | **GAP ACH-M-D2-RETRY**: Replay or conflict. Invariant: digest/provenance/scope immutable. Inject: same key, changed account digest or scope. | **GAP ACH-M-D2-REVOCATION**: Refuse. Invariant: owner identity/grant/proof, source scope and artifact access each required. Inject: withdraw each at effect. | **GAP ACH-M-D2-PARTIAL**: Rollback. Invariant: no version without provenance/journal. Inject: fail provenance/journal/event write. |
### 7.14 Verify refund destination command (D-ACH-17)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **D1** Ownership evidence read (originating-account evidence, Wise recipient ref) and pure classification await; no write | **GAP ACH-M-D1-RACE**: Revalidate before Kdestverify. Invariant: verification binds the evidence read. Inject: hold read; new destination version/revocation/source reversal both orders. | **GAP ACH-M-D1-TIMEOUT**: Stay PENDING_VERIFICATION. Invariant: unknown ownership is not permission. Inject: delay artifact/decrypt past bound. | **GAP ACH-M-D1-EXPIRY**: Require fresh evidence/proof. Invariant: validity at effect. Inject: advance evidence/proof validity during read. | **GAP ACH-M-D1-CRASH-BEFORE**: No fact. Invariant: read writes nothing. Inject: crash before await. | **GAP ACH-M-D1-CRASH-AFTER**: Reread on resume. Invariant: an old read verifies nothing. Inject: crash after read before Kdestverify. | **GAP ACH-M-D1-RETRY**: Stable digest; substituted evidence conflicts. Invariant: ownership evidence bound to account digest and payer. Inject: repeat, then foreign-account evidence. | **GAP ACH-M-D1-REVOCATION**: Refuse. Invariant: owner/proof/payer evidence/artifact access each required. Inject: withdraw each at held read. | **GAP ACH-M-D1-PARTIAL**: Reject. Invariant: account digest and payer link both required. Inject: fail second evidence field after first. |
| **D3** `Kdestverify`: VERIFIED, prior VERIFIED→SUPERSEDED, ownership evidence, recipient ref, assurance, journal, events | **GAP ACH-M-D3-RACE**: One current VERIFIED version per scope/payer. Invariant: an approval binds exactly one current version. Inject: hold destination lock; second verify/revoke/Krefundintent/Kcreateclaim both orders. | **GAP ACH-M-D3-TIMEOUT**: Recover by journal. Invariant: no double verification. Inject: COMMIT response timeout. | **GAP ACH-M-D3-EXPIRY**: Refuse stale proof/evidence. Invariant: effect-time assurance. Inject: cross each validity after lock wait. | **GAP ACH-M-D3-CRASH-BEFORE**: Stays PENDING; prior VERIFIED unchanged. Invariant: verification and supersession atomic. Inject: crash after last write before Kdestverify COMMIT. | **GAP ACH-M-D3-CRASH-AFTER**: Replay. Invariant: one verified event. Inject: lose answer after Kdestverify COMMIT. | **GAP ACH-M-D3-RETRY**: Replay or conflict. Invariant: evidence digest immutable. Inject: same key with changed evidence/recipient ref. | **GAP ACH-M-D3-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up, payer authorization and evidence each required. Inject: withdraw each under lock. | **GAP ACH-M-D3-PARTIAL**: Rollback. Invariant: no supersession without successor. Inject: fail supersede/assurance/journal/event write. |
### 7.15 Revoke refund destination command (D-ACH-17)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **D4** `Kdestrevoke`: REVOKED, case naming APPROVED unclaimed returns, journal, events | **GAP ACH-M-D4-RACE**: Revoke first denies the unclaimed phase; claim first reconciles the possible effect. Invariant: no new phase on a revoked destination; no erased claimed effect. Inject: hold destination lock; Kcreateclaim/Kfundclaim/Kdestverify both orders. | **GAP ACH-M-D4-TIMEOUT**: Recover; claimants re-read. Invariant: uncertain revocation never treated as valid. Inject: COMMIT response timeout, then concurrent Kfundclaim. | **GAP ACH-M-D4-EXPIRY**: Records revocation of an expired version. Invariant: expired unusable either way. Inject: boundary exactly at revoke. | **GAP ACH-M-D4-CRASH-BEFORE**: Stays VERIFIED; no case. Invariant: state and case atomic. Inject: crash after last write before Kdestrevoke COMMIT. | **GAP ACH-M-D4-CRASH-AFTER**: Replay. Invariant: one revoked event. Inject: lose answer after Kdestrevoke COMMIT. | **GAP ACH-M-D4-RETRY**: Duplicate no-op. Invariant: monotonic. Inject: repeat key/event; same key, other version. | **GAP ACH-M-D4-REVOCATION**: Revoker loses authority: deny. Invariant: actor authority checked at effect (owner, service fence, agency billing). Inject: withdraw each. | **GAP ACH-M-D4-PARTIAL**: Rollback. Invariant: revocation and case together. Inject: fail case/journal/event write. |
### 7.16 Approve outbound return command (D-ACH-13)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **F1** Destination-version/source/evidence read and pure prepare/classify await | **GAP ACH-M-F1-RACE**: Revalidate frozen destination/remaining source. Invariant: request hash binds exact approved effect. Inject: hold reader; destination replacement/source reversal/approval withdrawal both orders. | **GAP ACH-M-F1-TIMEOUT**: No intent/call from incomplete read. Invariant: unknown destination is not permission. Inject: delay evidence/fee quote/prepare reader beyond bound. | **GAP ACH-M-F1-EXPIRY**: Require renewed proof/fee quote. Invariant: intent expiry checked at effect. Inject: advance proof/destination/quote validity during preparation. | **GAP ACH-M-F1-CRASH-BEFORE**: No prepared durable intent. Invariant: pure preparation sends no transfer. Inject: crash before prepare/evidence await. | **GAP ACH-M-F1-CRASH-AFTER**: Repeat preparation with same frozen inputs. Invariant: no external effect from hash computation. Inject: crash after prepare before Krefundintent. | **GAP ACH-M-F1-RETRY**: Same normalized bytes or conflict. Invariant: request identity excludes secrets. Inject: repeat prepare; change amount/destination/fee ceiling and compare hashes. | **GAP ACH-M-F1-REVOCATION**: Deny preparation for revoked prerequisite. Invariant: owner/proof/destination/source/account all required. Inject: revoke each at held reader. | **GAP ACH-M-F1-PARTIAL**: Reject partial request. Invariant: no omitted destination/fee/source binding. Inject: fail second evidence/hash input normalization; assert no call. |
| **F2** `Krefundintent`: refund, treasury refund or resend APPROVED, component or REFUND_PAYABLE principal reservation, owner approval, destination/payer versions, TRANSFER_CREATE attempt PREPARED, journal/events | **GAP ACH-M-F2-RACE**: One reserved refundable total. Invariant: sum pending/completed returns capped. Inject: hold source/refund locks; second approval/attribution/reversal/customer request/destination or payer revocation both orders; two resend approvals of one bounce while the first is UNCERTAIN. | **GAP ACH-M-F2-TIMEOUT**: Recover approved intent by key. Invariant: no second reservation. Inject: inject approval lock/statement/COMMIT response timeout. | **GAP ACH-M-F2-EXPIRY**: Deny expired proof/destination/fee quote. Invariant: effect-time owner assurance. Inject: cross each validity boundary after waiting. | **GAP ACH-M-F2-CRASH-BEFORE**: Rollback approval and prepared saga. Invariant: reservation/authority/journal atomic. Inject: crash after last write before Krefundintent COMMIT. | **GAP ACH-M-F2-CRASH-AFTER**: Return same approved intent. Invariant: approval alone is not sent refund. Inject: lose answer after Krefundintent COMMIT. | **GAP ACH-M-F2-RETRY**: Replay or changed-body conflict. Invariant: effects hash immutable. Inject: concurrent same key then changed source/destination/amount/fee ceiling. | **GAP ACH-M-F2-REVOCATION**: Refuse approval; preserve existing other returns. Invariant: grant/identity/proof/source/destination/account verification required. Inject: withdraw each; test KP008 requester/approver segregation. | **GAP ACH-M-F2-PARTIAL**: Rollback full approval footprint. Invariant: no funds reservation without authority. Inject: fail later attempt/saga/scope/ALLOW/event/journal writes. |
### 7.17 Initiate outbound transfer CREATE phase (D-ACH-14/19)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **F3** `Kcreateclaim`: CREATE attempt DISPATCHING with fence/deadline, refund SUBMITTING, events | **GAP ACH-M-F3-RACE**: Only one creator/manual executor wins. Invariant: UI/API cannot dispatch same attempt. Inject: hold claim/source locks; second claimant/reversal/revocation both orders. | **GAP ACH-M-F3-TIMEOUT**: Do not dispatch until claim recovered. Invariant: ambiguous claim is not duplicate permission. Inject: inject claim statement/COMMIT acknowledgement timeout. | **GAP ACH-M-F3-EXPIRY**: Cancel undispatched expired intent. Invariant: bounded fresh claim deadline. Inject: cross approval/claim window after locks; assert no port call. | **GAP ACH-M-F3-CRASH-BEFORE**: No claim survives; no call permitted. Invariant: claim precedes external effect. Inject: crash after last write before Kcreateclaim COMMIT. | **GAP ACH-M-F3-CRASH-AFTER**: Observe possible effect before recovery dispatch. Invariant: committed claim may already have called. Inject: lose answer after Kcreateclaim COMMIT and before dispatch. | **GAP ACH-M-F3-RETRY**: CAS loser observes only. Invariant: one logical creation key. Inject: concurrent replay/changed request hash and manual/API competing modes. | **GAP ACH-M-F3-REVOCATION**: Before claim deny; after claim reconcile. Invariant: identity/source/destination/account/fence lapse cannot erase effect. Inject: revoke each on both sides of claim guard. | **GAP ACH-M-F3-PARTIAL**: Rollback attempt/saga/refund/events. Invariant: no SUBMITTING without claim. Inject: fail second/later claim footprint writes. |
| **F4** initiateOutboundTransfer CREATE await, or claimed manual create; provider create durable boundary | **GAP ACH-M-F4-RACE**: Same provider identity; recover possible created transfer. Invariant: no second logical transfer. Inject: hold create await; observer/watchdog/manual/API recovery both orders. | **GAP ACH-M-F4-TIMEOUT**: UNCERTAIN; observe by stable key. Invariant: timeout never proves no transfer. Inject: accept provider create then lose/delay response. | **GAP ACH-M-F4-EXPIRY**: Expired claim forbids new phase; reconcile possible create. Invariant: no blind redispatch after deadline. Inject: advance dispatch deadline during create. | **GAP ACH-M-F4-CRASH-BEFORE**: Recover by identity, not presumed absence. Invariant: local claim already durable. Inject: crash just before provider create durable boundary; lookup required. | **GAP ACH-M-F4-CRASH-AFTER**: Find same created transfer. Invariant: one provider create effect. Inject: crash after provider CREATE persistence before return/Kcreatesettle. | **GAP ACH-M-F4-RETRY**: Reuse qualified create key or observe. Invariant: provider idempotency bound to exact body. Inject: replay identical create and changed-body key; simulate lost idempotency support. | **GAP ACH-M-F4-REVOCATION**: Stop unclaimed follow-up funding; observe create. Invariant: revocation after claim preserves possible effect. Inject: revoke owner/destination/account/source/service/fence while call held; credential/permission REFUSED without qualified proof settles UNCERTAIN. | **GAP ACH-M-F4-PARTIAL**: No funding hidden inside creation. Invariant: create phase only creates. Inject: provider persists transfer then response parsing fails; assert no FUND call. |
| **F5** `Kcreatesettle`: CREATE attempt result/uncertainty, `outbound_transfers` row with transfer ID/evidence, TRANSFER_FUND attempt PREPARED, observation/events | **GAP ACH-M-F5-RACE**: Merge conclusive create once; reversal blocks funding. Invariant: one learned transfer ID. Inject: hold saga/source locks; observer/reversal/fund claimant both orders. | **GAP ACH-M-F5-TIMEOUT**: Retain uncertainty or recover created ID. Invariant: unknown settle cannot create again. Inject: inject settle lock/COMMIT response timeout. | **GAP ACH-M-F5-EXPIRY**: Store evidence; do not fund expired approval. Invariant: durability independent of dispatch eligibility. Inject: cross claim/approval/destination validity while settling. | **GAP ACH-M-F5-CRASH-BEFORE**: Claim remains uncertain; provider transfer still exists. Invariant: local rollback does not undo provider create. Inject: crash after last write before Kcreatesettle COMMIT. | **GAP ACH-M-F5-CRASH-AFTER**: Resume from durable CREATED/FUND_PREPARED. Invariant: never re-create transfer. Inject: lose settle answer after Kcreatesettle COMMIT. | **GAP ACH-M-F5-RETRY**: Repeated create evidence no-op; conflict quarantined. Invariant: transfer ID learned once. Inject: redeliver response/event then another transfer ID/body. | **GAP ACH-M-F5-REVOCATION**: Record creation; block unclaimed funding. Invariant: revocation never removes provider identity. Inject: withdraw source/destination/owner/account/service fence individually. | **GAP ACH-M-F5-PARTIAL**: Rollback settle; observe same provider ID. Invariant: identity/saga/observation/events atomic. Inject: fail later FUND_PREPARED/evidence/event write; assert claim remains. |
### 7.18 Initiate outbound transfer FUND phase (D-ACH-14/19)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **F6** `Kfundclaim`: FUND attempt DISPATCHING with fence/deadline, events; transfer ID already durable | **GAP ACH-M-F6-RACE**: One funding claimant; a source reversed before the claim, or a resend whose `O` no longer covers it, denies funding (D-ACH-18/19). Invariant: created ID required; no double funding. Inject: hold source/saga lock; other worker/manual executor/reversal/destination revoke both orders. | **GAP ACH-M-F6-TIMEOUT**: Recover claim before funding. Invariant: ambiguous claim cannot trigger extra debit. Inject: inject fund-claim statement/COMMIT acknowledgement timeout. | **GAP ACH-M-F6-EXPIRY**: Do not fund expired authority. Invariant: own phase deadline and approval validity. Inject: cross approval/fee quote/claim boundary at effect. | **GAP ACH-M-F6-CRASH-BEFORE**: Keep CREATED; no funding permitted. Invariant: fund claim atomic. Inject: crash after last write before Kfundclaim COMMIT. | **GAP ACH-M-F6-CRASH-AFTER**: Observe transfer before recovery. Invariant: committed FUND_CLAIMED is possible debit. Inject: lose answer after Kfundclaim COMMIT. | **GAP ACH-M-F6-RETRY**: Claim loser only observes. Invariant: same immutable transfer/key. Inject: concurrent same claim then changed transfer/destination/body. | **GAP ACH-M-F6-REVOCATION**: Deny unclaimed funding; reconcile claimed funding. Invariant: all source/owner/destination/account/service/fence facts bind. Inject: withdraw each before/after fund guard. | **GAP ACH-M-F6-PARTIAL**: Rollback fence/deadline/saga/events. Invariant: no partly authorized fund phase. Inject: fail later fund claim writes; assert created provider identity remains. |
| **F7** initiateOutboundTransfer FUND await, or claimed manual funding; provider funding durable boundary | **GAP ACH-M-F7-RACE**: Observe competing funding/reversal. Invariant: one logical debit and return cap. Inject: hold funding await; watchdog/manual/API observer/source return both orders. | **GAP ACH-M-F7-TIMEOUT**: UNCERTAIN; observe same transfer. Invariant: no blind funding retry. Inject: provider debits then loses/delays response. | **GAP ACH-M-F7-EXPIRY**: Stop new calls; observe claimed effect. Invariant: claim expiry never means no debit. Inject: advance fund deadline while response pending. | **GAP ACH-M-F7-CRASH-BEFORE**: Observe even if funding may not have happened. Invariant: local claim cannot prove provider absence. Inject: crash immediately before provider funding durable boundary. | **GAP ACH-M-F7-CRASH-AFTER**: Recover funded transfer status. Invariant: one debit survives local crash. Inject: crash after provider FUND debit before response/Kfundsettle. | **GAP ACH-M-F7-RETRY**: Only qualified same-transfer retry; otherwise observe. Invariant: no new funding identity. Inject: replay with/without documented idempotency; conflict key/body. | **GAP ACH-M-F7-REVOCATION**: Reconcile effect; block other phases. Invariant: post-claim revocation cannot undo debit. Inject: withdraw source/owner/destination/account/service/fence during call; credential/permission REFUSED without qualified proof settles UNCERTAIN. | **GAP ACH-M-F7-PARTIAL**: Persisted debit remains uncertain. Invariant: do not call FAILED after parsing failure. Inject: debit succeeds then fee/status parse fails; assert no new debit. |
| **F8** `Kfundsettle`: FUND attempt result, funding fact keyed by transfer ID (D-ACH-18), refund SUBMITTING/result or UNCERTAIN, consequences/events | **GAP ACH-M-F8-RACE**: Serialize completed refund with all returns. Invariant: discharge nets once; every principal debit is booked (D-ACH-18). Inject: hold capture-refund/credit locks; observer/reversal/second completion both orders. | **GAP ACH-M-F8-TIMEOUT**: Recover status; remain UNCERTAIN if unknown. Invariant: no refund completion guessed. Inject: inject settle lock/statement/COMMIT response timeout. | **GAP ACH-M-F8-EXPIRY**: Store claimed-effect outcome despite old approval. Invariant: expired approval never permits new phase. Inject: cross approval/fence deadline before completion evidence settles. | **GAP ACH-M-F8-CRASH-BEFORE**: No local completion; external debit retained. Invariant: provider effect recovered by identity. Inject: crash after last write before Kfundsettle COMMIT. | **GAP ACH-M-F8-CRASH-AFTER**: Recover same terminal/uncertain result. Invariant: no second return/event. Inject: lose settle answer/outbox response after Kfundsettle COMMIT. | **GAP ACH-M-F8-RETRY**: Same status/event no-op; terminal contradiction reviewed. Invariant: completion monotonic. Inject: redeliver identical event and conflicting amount/destination/status. | **GAP ACH-M-F8-REVOCATION**: Keep actual return; revoke authority by phase. Invariant: revocation never erases money/history. Inject: withdraw owner/source/destination/account/service/fence independently; recover with valid service. | **GAP ACH-M-F8-PARTIAL**: Rollback whole result footprint. Invariant: refund/source/authorization/events atomic. Inject: fail later ceiling/revocation/fee/observation/event writes; assert exact returned cents. |
### 7.19 Observe outbound return command (D-ACH-14/18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **O1** observeOutboundTransfer/classifyOutbound await (manual evidence through F1); no dispatch | **GAP ACH-M-O1-RACE**: Merge strongest consistent evidence. Invariant: old pending cannot reverse completion. Inject: hold query; create/fund settle/reversal/manual confirmation both orders. | **GAP ACH-M-O1-TIMEOUT**: Keep UNCERTAIN/PENDING; never repeat send. Invariant: lookup absence not proof. Inject: delay/reset/5xx/unreadable/missing transfer lookup. | **GAP ACH-M-O1-EXPIRY**: Continue identity-only observation. Invariant: old approval need not authorize historical read. Inject: advance approval/dispatch deadline during query; reject expired service fence. | **GAP ACH-M-O1-CRASH-BEFORE**: No local fact change. Invariant: existing claim/result retained. Inject: crash before observeOutboundTransfer await. | **GAP ACH-M-O1-CRASH-AFTER**: Re-observe same identity. Invariant: no new transfer from lost read. Inject: crash after response before Kreturnobserve. | **GAP ACH-M-O1-RETRY**: Idempotent observation; conflicting evidence reviewed. Invariant: binding uses transfer ID/refund ref not amount. Inject: repeat lookup/status event then foreign transfer/body. | **GAP ACH-M-O1-REVOCATION**: Pause untrusted query; preserve durable effects. Invariant: service/credential/account/fence required. Inject: revoke each at held observation boundary. | **GAP ACH-M-O1-PARTIAL**: Keep uncertainty. Invariant: incomplete status/amount/destination cannot complete. Inject: fail second normalization field after transfer ID read. |
| **O2** `Kreturnobserve`: status/funding/fee/funding-return/bounce normalization, source ceilings, refund completion, delivery facts, authority consequences/events | **GAP ACH-M-O2-RACE**: Serialize all source returns and assignments. Invariant: no over-discharge, no dropped excess return, no attribution after return claim. Inject: hold source/refund locks; refund/reversal/fee/assignment/second observer both orders. | **GAP ACH-M-O2-TIMEOUT**: Recover durable result by transfer ID. Invariant: timeout never sends again. Inject: inject observe-settle lock/COMMIT response timeout. | **GAP ACH-M-O2-EXPIRY**: Record real completion with original approval. Invariant: expired right cannot reopen service. Inject: cross source/order/approval/fence deadlines independently. | **GAP ACH-M-O2-CRASH-BEFORE**: All observation consequences roll back. Invariant: no partial completed refund. Inject: crash after last write before Kreturnobserve COMMIT. | **GAP ACH-M-O2-CRASH-AFTER**: Replay one completion/fee fact. Invariant: event sourced money once. Inject: lose settle after Kreturnobserve COMMIT. | **GAP ACH-M-O2-RETRY**: Duplicate no-op; conflicting terminal facts incident. Invariant: monotonic net-return history. Inject: redeliver completion/fee/reversal in every order; change immutable identity/body. | **GAP ACH-M-O2-REVOCATION**: Record authenticated historical money under valid service. Invariant: owner/destination loss cannot delete return. Inject: withdraw owner/destination/source/account/service/fence separately; recover service. | **GAP ACH-M-O2-PARTIAL**: Rollback result/authority/case/events. Invariant: exact remaining principal and tax conserved. Inject: fail second/later observation/refund/revocation/case/outbox writes. |
### 7.20 Transfer-attempt watchdog sweep (D-ACH-19; then O1–O2 under the service journal key)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **W1** Due-attempt scan, scope adoption (REFUND or TREASURY_REFUND, never PAYMENT_ORDER) and live-attempt read; no write | **GAP ACH-M-W1-RACE**: Act only on the attempt still live after the read. Invariant: a settled attempt is not re-observed into a second result. Inject: hold scan; settle/second watchdog/manual confirmation both orders. | **GAP ACH-M-W1-TIMEOUT**: Retry later. Invariant: unread attempt is neither dispatched nor failed. Inject: delay scan past bound. | **GAP ACH-M-W1-EXPIRY**: Not due before deadline+1 ms; due after. Invariant: database dispatch deadline governs. Inject: effect clock before/at/after deadline. | **GAP ACH-M-W1-CRASH-BEFORE**: Nothing changes. Invariant: attempt keeps its state. Inject: crash before scan await. | **GAP ACH-M-W1-CRASH-AFTER**: Next run repeats. Invariant: read grants nothing. Inject: crash after read before O1. | **GAP ACH-M-W1-RETRY**: Two watchdogs converge on one journal key. Invariant: `watchdog-<observationRef>` applies once. Inject: concurrent runs, same attempt. | **GAP ACH-M-W1-REVOCATION**: Stop without service identity/fence. Invariant: service authority, never an owner session. Inject: revoke service/fence/scope binding each. | **GAP ACH-M-W1-PARTIAL**: Unresolved scope: skip and alert. Invariant: no attempt observed under a wrong scope. Inject: attempt found but scope row missing. |
### 7.21 FINANCE funding consumer (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P3** `Kfundbook`: `transfer.funded` / `transfer.funding_returned` sets keyed by transfer ID (OUTBOUND_IN_TRANSIT, provider balances, shortfall expense), delivery markers | **GAP ACH-M-P3-RACE**: One funding set per transfer whichever of FUND response, watchdog observation or completion group arrives first. Invariant: provider debit booked once; in transit = funded − completed − funding returned. Inject: hold booking lock; Kfundsettle/Kreturnobserve/completion group/reversal delivery both orders. | **GAP ACH-M-P3-TIMEOUT**: Recover by transfer-ID source. Invariant: unknown COMMIT never reposts. Inject: ledger lock/COMMIT response timeout. | **GAP ACH-M-P3-EXPIRY**: Book funding evidence after approval/claim expiry. Invariant: stale fence cannot book; the current fence books evidence dates. Inject: cross worker fence and approval deadlines. | **GAP ACH-M-P3-CRASH-BEFORE**: No set fragment. Invariant: set and marker atomic. Inject: crash after last write before Kfundbook COMMIT. | **GAP ACH-M-P3-CRASH-AFTER**: Replay as posted. Invariant: one funding debit (oracle S3 with the FUND answer also lost). Inject: lose settle after Kfundbook COMMIT. | **GAP ACH-M-P3-RETRY**: Identical funding events/statement lines no-op; another balanceTransactionId or amount for the transfer opens PROVIDER_INCONSISTENCY, posts nothing. Inject: redeliver concurrently; alter balanceTransactionId/amount. | **GAP ACH-M-P3-REVOCATION**: Fence stale worker; owner/destination revocation never removes a funding set. Invariant: service scope/fence required. Inject: revoke service/fence/scope; revoke destination after funding. | **GAP ACH-M-P3-PARTIAL**: Rollback all lines. Invariant: no in-transit line without its provider line. Inject: fail second line/marker write; assert exact cents per account. |
### 7.22 Assign repayment credit to a RETURN_RECOVERY case command (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P4** `Krecoveryassign`: exclusive target binding of a confirmed unassigned credit to the case under credit and source booking locks (`G ≤ X`), assurance, journal, events; booking by the P2 group | **GAP ACH-M-P4-RACE**: One target per credit; `G ≤ X` at effect. Invariant: CAPTURE, TREASURY_RETURN and RECOVERY targets exclusive; one receipt, zero residual CUSTOMER_OVERPAYMENT (oracle S5). Inject: hold credit/source locks; Kmatch, return-claim Krefundintent, Kbook receipt, Kreturnbook bounce, Kwriteoff both orders. | **GAP ACH-M-P4-TIMEOUT**: Recover by journal. Invariant: no second assignment. Inject: COMMIT response timeout. | **GAP ACH-M-P4-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity after lock wait. | **GAP ACH-M-P4-CRASH-BEFORE**: Credit stays unassigned; no group. Invariant: binding atomic. Inject: crash after last write before Krecoveryassign COMMIT. | **GAP ACH-M-P4-CRASH-AFTER**: Replay; Kbook builds the group once in either delivery order. Invariant: one reclassification. Inject: lose answer after COMMIT, then deliver receipt before/after the group. | **GAP ACH-M-P4-RETRY**: Replay or conflict; a second target for the credit is refused. Invariant: binding immutable. Inject: same key with other case/credit; other key, same credit. | **GAP ACH-M-P4-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up; credit still confirmed and unassigned; case open. Inject: withdraw each; attribute or return-claim the credit first. | **GAP ACH-M-P4-PARTIAL**: Rollback. Invariant: no binding without journal/case link. Inject: fail case/journal/event write. |
### 7.23 FINANCE return-allocation consumer (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P5** `Kreturnbook`: delivery/undelivery sets (transfer or resend completion, incoming reversal, bounce) allocated by the return position under the source booking lock, fee sets, delivery markers | **GAP ACH-M-P5-RACE**: Each set allocated against the position left by the previous one. Invariant: `X = max(0, R − Q)`; oracle S1–S5 in both orders. Inject: hold source booking lock; reversal/completion/bounce/resend completion/recovery group/Kwriteoff both orders. | **GAP ACH-M-P5-TIMEOUT**: Recover by source IDs. Invariant: no repost on unknown COMMIT. Inject: ledger lock/COMMIT timeout. | **GAP ACH-M-P5-EXPIRY**: Book historical facts despite expired approval/order. Invariant: stale fence cannot book. Inject: cross worker fence deadline. | **GAP ACH-M-P5-CRASH-BEFORE**: No set fragment. Invariant: balanced sets and markers atomic. Inject: crash after last write before Kreturnbook COMMIT. | **GAP ACH-M-P5-CRASH-AFTER**: Replay as posted. Invariant: each delivery/undelivery counted once. Inject: lose settle after COMMIT. | **GAP ACH-M-P5-RETRY**: Identical events no-op; conflicting principal opens a case. Invariant: source uniqueness. Inject: redeliver each event concurrently; alter principal/cash-back. | **GAP ACH-M-P5-REVOCATION**: Fence stale worker; postings stay. Invariant: service scope/fence required. Inject: revoke service/fence/scope independently. | **GAP ACH-M-P5-PARTIAL**: Rollback all lines. Invariant: no discharge without its in-transit/provider line; no bounce without its receivable/payable line. Inject: fail each later line/marker; assert exact cents per account. |
### 7.24 Write off excess return command (D-ACH-18)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **P6** `Kwriteoff`: RETURN_RECOVERY case write-off correction (RETURN_LOSS `w` ≤ open receivable), assurance, journal, events | **GAP ACH-M-P6-RACE**: `w` ≤ open receivable at effect. Invariant: written-off + receivable = `X`; later bounce or repayment credits RETURN_LOSS back (S2′, S5′). Inject: hold case/source locks; repayment group/bounce/second write-off both orders. | **GAP ACH-M-P6-TIMEOUT**: Recover by journal. Invariant: no double write-off. Inject: COMMIT response timeout. | **GAP ACH-M-P6-EXPIRY**: Refuse stale proof. Invariant: effect-time step-up. Inject: cross proof validity after lock wait. | **GAP ACH-M-P6-CRASH-BEFORE**: Case open; no posting. Invariant: atomic. Inject: crash after last write before Kwriteoff COMMIT. | **GAP ACH-M-P6-CRASH-AFTER**: Replay. Invariant: one correction. Inject: lose answer after COMMIT. | **GAP ACH-M-P6-RETRY**: Replay or conflict. Invariant: amount immutable. Inject: same key, changed amount. | **GAP ACH-M-P6-REVOCATION**: Refuse. Invariant: KAURO_OWNER grant, identity, step-up. Inject: withdraw each. | **GAP ACH-M-P6-PARTIAL**: Rollback. Invariant: no revenue/tax/commission/authority line. Inject: fail correction/journal/event write; assert exact cents. |
### 7.25 Complete recovered command journal (D-ACH-14)
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| **O3** `Kanswer`: operator/service journal finalization from the durable attempt/refund result only | **GAP ACH-M-O3-RACE**: One result wins from durable saga. Invariant: journal cannot invent provider outcome. Inject: hold journal; second recovery and concurrent status settle both orders. | **GAP ACH-M-O3-TIMEOUT**: Recover journal or return operation reference. Invariant: no external redispatch. Inject: inject journal lock/COMMIT acknowledgement timeout. | **GAP ACH-M-O3-EXPIRY**: Reauthorize requester; historical outcome remains. Invariant: expired session never grants new action. Inject: cross session/step-up/claim window before answer effect. | **GAP ACH-M-O3-CRASH-BEFORE**: Saga/refund survives; journal unfinished. Invariant: Kanswer distinct from provider settle. Inject: crash after final journal write before Kanswer COMMIT. | **GAP ACH-M-O3-CRASH-AFTER**: Replay committed answer after access check. Invariant: one command result; no send. Inject: lose answer after Kanswer COMMIT. | **GAP ACH-M-O3-RETRY**: Replay same digest or conflict. Invariant: key binds immutable approved effect. Inject: concurrent same-key recovery then changed destination/amount body. | **GAP ACH-M-O3-REVOCATION**: Deny caller; service can finish reconciliation. Invariant: identity/grant/session/service authority checked. Inject: withdraw each at journal boundary; verify no financial deletion. | **GAP ACH-M-O3-PARTIAL**: Rollback answer only. Invariant: earlier provider/result commits retained. Inject: fail later journal/audit write; assert durable refund and exact cents unchanged. |

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
| ACH-08 | Partial 400+600 against 1,000 and overpayment 1,010 against 1,000: exact allocations, REVIEW/no authority, owner return, no fabricated aggregate capture | P1–P2, F1–O3 |
| ACH-09 | Two distinct exact full receipts plus repeated delivery: one authorization, all money, excess liability/owner return, service basis capped | P1–P2, F2, O2 |
| ACH-10 | Before/exact/after expiry, delayed bank observation, source/approval/route revocation and late credit: recorded money, no resurrection, reviewed remedy | I1–I3, P1, E1 |
| ACH-11 | Explicit ACH retirement→PayPal: one open checkout/purchase; old reference stays bound; late ACH is return-only; no automatic second charge | I2, M2, P1, E1 |
| ACH-12 | Unassigned booked receipt in shared treasury ledger; attribution reverses treasury and posts agency capture atomically; return claim and recovery assignment exclude attribution; treasury refund executes through route-scope attempts and watchdog | M1–M2, P2, P4, D2–D4, F1–O3, W1 |
| ACH-13 | Versioned source/access-date fees, null versus observed zero, gross/net equality, later fees/conflicts and outbound fee ceiling | R2, C3, P1–P2, F1–O2 |
| ACH-14 | Owner-approved source/destination/components, requester segregation, destination/proof expiry/revocation and every pending-return and resend-principal ceiling | D1–D4, F1–F3, F6 |
| ACH-15 | CREATE and FUND as separate attempts: stable identities, durable created ID before funding, no blind retries, unknown status uncertain, refusals carry safe operational codes and resolve nothing else | F3–F8, O1–O3, W1, C2 |
| ACH-16 | Manual outbound claim/evidence and UI/API exclusion; funding, completion, funding return, reversal and bounce in every order, kept fees, remaining cents/tax and phased authority | F3–O3, P2–P5 |
| ACH-17 | Every matrix cell injected at its own boundary; security/log/evidence minimization and service fencing verified | All 328 GAP cells |
| ACH-18 | Payer authorization and destination lifecycle: verify/replace/revoke with evidence, step-up and both-order races against matching and dispatch | V1–V3, D1–D4, M2, P1, F2–F6 |
| ACH-19 | D-ACH-18 oracle S1–S5 (Codex r1 double debit; r2 bounce of an excess return, funded-pending transfer, repayment reclassification) in both observation orders and both scopes, plus resend: invariant `X = max(0, R − Q)` and exact account cents after every event | F2, F6, F8, O2, P2–P6 |
| ACH-LIVE-01 | One legitimate real USD ACH credit to the verified Wise Business details, reconciled end to end with duplicate replay adding nothing | I2, C4–C6 or C1–C8, M1–M2, P1–P2 |

Implementation gate: all money/authority matrix GAPs closed with fault-harness evidence on real PostgreSQL; remaining applicable
transport GAPs closed before their path is enabled. Review schema/type/state/event equivalence and backstop guards, not only
handler examples. Required additive work includes route qualification/config versions; ACH order states/index/identity guard;
bank-credit evidence/matching/cursor/fences and manual command contracts; owner/service privileges and assurance; ledger treasury
scope, source guards and atomic posting groups; treasury refund/attempt tables, journal and scope extensions (D-ACH-19); per-phase transfer operations and
watchdog; payer-authorization and destination aggregates (D-ACH-17); OPS-2 accounts and return-accounting events (D-ACH-18);
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
live gate does not claim live outbound automation: before enabling automated refunds, S-B separately qualifies the actual
create/funding/status/destination/fee behavior and recovery, including an owner-approved real outbound return. The initial
manual return procedure must already be reviewable and recoverable when controlled ACH receiving is enabled.
