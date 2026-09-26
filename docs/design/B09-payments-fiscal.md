# B09 — Payments and fiscal workflow: design

Branch `b09/design`, based on `main` at `02c0bd2` (B05 monorepo and contracts, B06 domain, database and authorization).
Package B09 of the build program (registry `program.json`: "Implement quotes, provider intents, capture reconciliation,
CommercialAuthorization, refunds, settlement and fiscal-document adapter/bridge. Use exact minor-unit arithmetic, provider
uncertainty states and immutable documents. Do not mark screenshots or redirects as payment. Preserve tax-profile unknowns as
blockers."). Gates G-PAYMENT and G-FISCAL_LOCAL; owning manuals 07, 10, 15, 16, 19; contracts, commands and cases from the
vendored R2 registry under `packages/contracts/registry` (provenance-checked). Thirty cases: S057–S060, R2-077, R2-078, R2-081,
R2-128, R2-140 and the triads of CMD028–CMD034 (`node tools/package-brief.mjs B09`); the case map is
`docs/design/B09-case-map.md`.

Everything here is quoted from the authority (manual and section named, e.g. 15 "Capture and authority"; `reference/` files by
name; B06 decisions as "B06 D-…") or is a recorded decision of this package (`D-…-B…`, register §12) with its rationale. Where
the authority is silent or contradicts itself, the decision says so and §13 lists the question to return to the authority.
English only; the brand is Kauro (amendment A2) — the vendored registry stays byte-identical, and the owner role it names under the
pre-A2 brand is written KAURO_OWNER everywhere this package names it.

| delivered on this branch | left to the implementation mandates (§14) |
|---|---|
| `packages/persistence/migrations/0008..0012`: roles, tables, composite keys, state machines, triggers, RLS and grants of the whole workflow, applied from empty by the B06 runner and tested on PostgreSQL 17 (`test/b09-migrations.test.ts`, 16 tests; the B06 suites updated and green) | the `pg` adapters of the commerce ports, the commerce unit of work, the journal's UNCERTAIN path (M1) |
| `@kauro/domain` commerce model: records, money and pricing arithmetic, fiscal treatment, capture allocation, refund arithmetic and authority, ledger postings, provider vocabulary, principals, the ten platform machines, the event vocabulary, failure reasons, repository ports | the commerce authorizer, the reconciler, the consumers FINANCE / FISCAL / PAYMENT_SERVICE (M2) |
| `@kauro/application` commerce contracts: the seven command specs, closed request schemas, closed response schemas and DTO views, outcome catalogues, provider / fiscal / evidence / service ports, the provider-effect protocol types | the seven handlers, the provider-command runtime, the routes and the webhook ingress, the labelled contract fakes (M3) |
| the generated OpenAPI document documents the eleven B09 operations as `x-kauro-planned`; the generated matrix owns every edge of the twelve B09 machines | serving the routes moves them into `paths` and into the matrix's served sections (M3) |

## 1. Scope and boundaries

In scope (the registry's B09 cases and the manuals' B09 obligations): the stored quote and its eligibility snapshot (the
issuance command CMD027 CreateQuote is the recurrence package's, B10, whose cases CMD027-* it owns; B09 stores and re-checks
what it issues, D-QUOTE-B1); checkout (CMD028); capture (CMD029); the provider ingress and its application (CMD030); refund
request, review and execution (CMD031–CMD033); reconciliation (CMD034); CommercialAuthorization issuance and revocation; the
fiscal profile, the fiscal document draft and validation and the fiscal adapter/bridge port; the operational ledger;
settlement observations; the reconciliation cases and provider event exceptions.

Out of scope, with the owner the registry names: issuing a quote, first/repeat designation, founding slots and commission
(B10: CMD027, R2-080, R2-137); consuming an authorization and publishing a package (B08: CMD036, delivery); fiscal issuance
(CMD035, the real integration package B15, with R2-082..R2-085); real provider, OIDC, storage and fiscal integrations (B15); the
agency, seller and owner applications (B11, B12). Every provider and fiscal effect of B09 is reached through a port (§5); until
B15 binds the real adapters, tests bind contract-faithful fakes labelled `CONTRACT_FAKE` in code and evidence (D-FAKE-B1),
never counted as integration (21 "Evidence classes").

## 2. The B06 foundation, extended — never forked

B09 runs on B06's mechanisms unchanged and extends them only where a new principal or aggregate needs it.

| B06 mechanism | how B09 uses it | extension (additive, named) |
|---|---|---|
| unit of work (`SET LOCAL` context, verified pools, one runtime group per login; B06 D-CTX-1) | every commerce write runs in a `PgUnitOfWork`; the commerce unit of work is the same transaction with the commerce repositories (`CommerceUnitOfWork extends UnitOfWork`) | contexts SERVICE (runs under the new group `kauro_payment`) and OPERATOR (runs under `kauro_app`, binds its user and a finance scope); `bindContext` clears `kauro.finance_agency_id` on every transaction (D-CTX-B1, D-CTX-B2) |
| runtime roles `kauro_app`, `kauro_control`, `kauro_assurance`, `kauro_validator`, `kauro_ingress` | agency commands under `kauro_app`; the ingress half of the webhook under `kauro_ingress` (B06 D-ING-1, PgInboxIngress); platform configuration under `kauro_control` | one new group `kauro_payment` (the payment service), created by 0008 with the same NOSUPERUSER/NOBYPASSRLS checks; `RUNTIME_ROLES` lists it (pool verification refuses a login in two groups) |
| pipeline authenticate → access decision → journal reserve/replay → assurance → execute (B06 D-PIPE-1) | unchanged order for every command, including the provider-effect protocol's T1 (§6.1) | the commerce authorizer for the principals B06 denies by default (operator, service, provider) (§3.4) |
| command journal (B06 D-IDEM-1..3) | idempotency of CMD028, CMD029, CMD031–CMD034; the orders, attempts and refunds name their journal entry (`intent_entry_id`) for resume | a provider effect of unknown outcome leaves the entry UNCERTAIN (the B06 guard already admits RESERVED → UNCERTAIN → COMMITTED; the adapter gains the path, D-JOURNAL-B1); an operator's entry is identity-owned (`agency_id` NULL, D-IDEM-B2) |
| outbox, inbox, D-ING locks (B06 D-OUTBOX-1, D-ING-1/2) | every commerce event has its outbox rows; the provider inbox dedupes webhook deliveries by provider, environment and event id | the payment service is the consumer of payment providers' inbox records (it settles them under B06's guards: KA012, KA007, READ COMMITTED); unattributable events become provider event exceptions (D-ING-B1, D-ING-B2) |
| security facts (agency / identity / anonymous streams, B06 D-FACT-1) | operator facts go to the operator's identity stream with `requested_agency_id`; agency commands to the agency stream | the payment service's and the ingress's own facts: `agency_id` NULL, actor SERVICE, or ANONYMOUS for an unverified delivery (D-FACT-B1) |
| registry guards: `state_machines`, `state_transitions`, `enforce_initial_state`, `enforce_listed_transition` (B06 D-INIT-1) | every B09 table with a state seeds its machine and guards birth and edges | `_of` variants for a state column not named `state`; `enforce_observed_birth` for a provider fact (D-INIT-B1) |
| event-per-version, `domain_events_bind_aggregate` (B06 D-EVT-1, review R3) | every versioned commerce aggregate | the aggregate kinds become rows of `kauro.aggregate_kinds` (the CHECK becomes a foreign key) and the binding reads the registered table — same rule, same SQLSTATEs (D-EVT-B1) |
| composite foreign keys, scoped uniqueness (08 "Database isolation") | every commerce row carries `agency_id` and names its parents with `agency_id` in the key | binding UNIQUE targets added to B06 tables (plans, projects, approvals, command_journal, inbox_records, domain_events) so copies of a subject are the original's (D-BIND-B1) |
| transition locks (B06 D-TX-2) | commerce commands read agency, capability, source, target under B06's transition locks | new transition subjects: quotes, capture facts, commercial authorizations, fiscal profiles, fiscal issuers, payment routes, corporate grants, and the withdrawal of an approval (D-TX-B1) |
| closed response schemas validated at runtime, registry-derived views (B06 D-RESP-1), outcome catalogues (B06 D-OUT-1), error contract (B06 D-API-1, D-LABEL-1) | B09 views are `ViewDefinition`s compiled by `viewSchemaOf`, refusing forbidden members and open objects; catalogues compose `ROUTE_OUTCOME_FRAGMENTS` | the KP SQLSTATE class and 46 commerce failure reasons (§7) |
| generated OpenAPI and matrix (`tools/openapi.mjs`, `tools/matrix.mjs`, both in `pnpm run verify`) | the B09 machines' edges are owned; the B09 routes are generated | `x-kauro-planned` operations until served; the checks refuse a planned route that is registered or also served (D-API-B1) |
| test helpers `@kauro/persistence/testing` | the harness and its fixtures | a `kauro_payment_test` login, the payment pool and factory, `service()` and `operator()` contexts; commerce fixtures in `test/commerce-support.ts` |

B06 objects B09 alters (all additive; the B06 suites run unchanged except where they counted migrations, roles or machines,
matched the guard triggers' names — now also their `_of` and observed-birth forms — or, in CMD010's DENY test, asserted that no
refund table exists — it now asserts that the refund tables hold no row): `domain_events`
(kind CHECK → foreign key; new UNIQUE `(event_id, agency_id)`), `event_types` (47 rows, seeded under a transaction-local lifting
of FORCE RLS), `plans`, `projects`, `approvals`, `command_journal`, `inbox_records` (UNIQUE binding targets), `approvals`
(transition-lock trigger on `withdrawn_at`), `kauro.domain_events_bind_aggregate()` (reads the registry), and policies/grants for
`kauro_payment`, the finance scope and the ingress on `agencies`, `projects`, `plans`, `approvals`, `dataset_revisions`,
`target_contracts`, `capabilities`, `domain_events`, `outbox_records`, `command_journal`, `security_events`, `inbox_records`,
`inbox_body_conflicts`. The reviewed runtime-boundary matrix (`packages/persistence/test/fixtures/runtime-boundary.json`) was
regenerated from the catalog and every B06 entry of it is unchanged.

## 3. Principals, runtime roles and scope

### 3.1 The four principals

| principal | who | context (`@kauro/domain` ExecutionContext) | runtime group | settings bound | commands |
|---|---|---|---|---|---|
| agency member | a verified person with a live membership (AGENCY_BILLING for commands, any role for reads; B06 §6) | TENANT | `kauro_app` | `kauro.agency_id`, `kauro.user_id` | CMD028, CMD029, CMD031; GetQuote, GetPaymentOrder, GetRefund |
| corporate operator | an individually managed corporate identity with an ACTIVE `KAURO_OWNER` grant (08 "Corporate operators and sellers use individually managed corporate identities") | OPERATOR (D-CTX-B2) | `kauro_app` | `kauro.user_id`, and after adoption `kauro.finance_agency_id` | CMD032; GetRefundReview |
| payment service | a verified service identity `payment-service` (10 "Internal command authentication") | SERVICE (D-CTX-B1) | `kauro_payment` | after adoption `kauro.agency_id` | CMD033, CMD034; the application of CMD030; the consumers FINANCE, FISCAL, PAYMENT_SERVICE |
| authenticated provider | a provider event whose signature, freshness and environment verify (CMD030 precondition) | none: the ingress records it | `kauro_ingress` (B06) | none | CMD030 (ingress half) |

08 "Identity is not permission" and "Role and capability model": a service account has only its technical role and cannot act
as a human owner; the Private Owner has no automatic customer-record bypass; finance capability and customer-data support access
are separate. Hence two separate principals: the payment service sees one agency's commerce rows and column-scoped commercial
prerequisites; the operator sees one agency's commerce rows while its grant is ACTIVE, and none of the agency's customer rows.

### 3.2 The payment service's scope (D-CTX-B1, D-SCOPE-B1)

COMMAND_CATALOGUE "Shared execution contract": service commands require a verified service identity and audience, "with scope
derived from the stored operation". A SERVICE unit of work starts with no agency bound (every tenant policy matches nothing) and
adopts exactly one agency, once, through the scope index `kauro.commerce_scopes`: `(scope_kind, scope_key) → agency_id`, kinds
PAYMENT_ORDER and REFUND (keyed by the platform id) and PROVIDER_ORDER, PROVIDER_CAPTURE, PROVIDER_REFUND (keyed
`<provider>|<ENVIRONMENT>|<external id>`). Rows are written by the transaction that creates the object or learns the provider
identity, in that object's agency; nobody updates or deletes them; a provider identity maps to one agency (PaymentOrder: "order
identity cannot migrate between tenants"). `CommerceUnitOfWork.adoptScope(kind, key)` resolves and binds (`kauro.agency_id` for
SERVICE); an unknown key answers NOT_FOUND and nothing is adopted. Platform-level work (settlement observations, provider event
exceptions, the inbox records of payment providers) runs with no agency adopted.

What `kauro_payment` may read of B06 tables is column-scoped (0008): agencies (id, version, state), projects (ids, mode,
capability, state — never `purpose`), plans (ids, state, hashes, approval — never `body`), approvals (ids, hashes, created,
withdrawn), dataset revisions (ids, state, manifest hash, sealed), target contracts (ids, mode, body hash, confirmed,
superseded), capabilities. It holds no privilege on identities, memberships, invitations, end clients, processing authorities,
receipts or corporate grants (proven in `b09-migrations.test.ts` "D-CTX-B1 …").

### 3.3 The operator's finance scope (D-CTX-B2, D-CORP-B1)

`kauro.corporate_roles` holds a person's grants of corporate roles (`KAURO_OWNER` only in B09; 0008), provisioned by the control
plane, read by a person only for itself, revoked under the grant's transition lock. `kauro.holds_corporate_role(role)` is
SECURITY INVOKER over the self policy, so it finds only the session's own grants; `kauro.in_finance_scope(agency)` is true when
the agency is the adopted `kauro.finance_agency_id` and the session holds an ACTIVE `KAURO_OWNER` grant. Every agency-scoped
commerce table has a finance policy on `kauro_app` keyed on it (read; and review writes where the operator acts: refunds under
review, fiscal profile versions, case resolution); of the B06 tables only `domain_events` and `outbox_records` do, and only for
the eight commerce aggregate kinds — none of the agency's customer rows. An OPERATOR adopts the finance scope through the scope index (`adoptScope("REFUND",
refundId)`, which reads REFUND rows only while the grant is ACTIVE) or, for a review not keyed by a stored operation,
`adoptFinanceScope(agencyId)` (no catalogue command of B09 uses it; Q-B09-3). The operator's journal rows, events and facts: an
identity-owned journal entry (agency NULL, B06 policy), events and outbox rows in the finance scope (0008 policies), security
facts in its identity stream naming the agency as `requested_agency_id` (B06 policy).

### 3.4 Authorization per command (D-AUTHZ-B1..B3)

| command | principal and role | access decision (before the journal) | assurance (after the reservation, new executions only) |
|---|---|---|---|
| CMD028 CreatePaymentOrder | agency member, AGENCY_BILLING (registry role) | B06 authorizer: identity ACTIVE + verified, live ACTIVE membership after its transition lock, role holds AGENCY_BILLING (OWNER or BILLING; `@kauro/domain` model/roles) | none (the payment itself is authenticated at the provider) |
| CMD029 CapturePayment | same | same | none |
| CMD031 RequestRefund | same | same | none (a request authorizes nothing, CMD031 failure) |
| CMD032 ApproveRefund | corporate operator, KAURO_OWNER | commerce authorizer `authorizeOperator`: identity ACTIVE + verified; ACTIVE grant after its transition lock; the refund resolvable in the scope index (NOT_FOUND alike for foreign and unknown) | `assureOperator`: `authorizationRef` is a standing policy that covers the locked refund (D-REF-B4), else a fresh step-up proof of the operator (08 "High-impact actions require recent step-up … significant refund"; freshness window as B06 CMD025) |
| CMD033 ExecuteRefund, CMD034 ReconcilePayment | payment service, PAYMENT_SERVICE | `authorizeService`: a verified service identity (issuer, audience, identity, environment) whose code-owned role is PAYMENT_SERVICE (`SERVICE_ROLE_TABLE`, D-AUTHZ-B3) in this deployment's environment; then scope adoption from the stored operation | none |
| CMD030 ReceivePaymentWebhook | authenticated provider | the provider's `WebhookVerifier` over the exact raw bytes (signature, freshness, environment, bounded body) before anything is stored | none |

The database repeats the decisions it can see (07 "Application checks improve messages but cannot be the sole protection"):
tenant and finance policies, the grant check of every finance-scoped row and of a refund review (KP007), segregation (KP008),
the standing-policy applicability (KP010), and the payment service's policies that never admit an order insert or a refund
review. Every denial is a durable security fact (B06 D-FACT-1, D-FACT-B1).

## 4. Aggregates and tables

Conventions of every table (07 "Database representation"): UUIDv7 server-generated ids (`kauro.is_uuid_v7`); money in BIGINT
minor units within `kauro.is_money` (0..2^53−1, the exactly representable JSON integer range, D-MONEY-B1); instants
`timestamptz`; versions `bigint` bumped by exactly one with an event per version (`kauro.enforce_version_bump`,
`kauro.require_event_for_version`); every tenant row carries `agency_id`, parents are named with `agency_id` in the key; uniqueness
includes the scope; FORCE ROW LEVEL SECURITY on every table; `updated_at` by trigger; immutable columns by
`kauro.forbid_column_change`; columns learned once (a provider id, a decision) by `kauro.forbid_reassignment` (0008).

### 4.1 Platform configuration (0008)

| table | holds | key rules | writers / readers |
|---|---|---|---|
| `payment_routes` | the merchant route of a provider and environment (15 "Merchant identity and environment are fixed by server configuration"): merchant ref, payee digest (SHA-256 of the payee id), currency, integration class | machine PaymentRoute (CONFIGURED → QUALIFIED → SUSPENDED); QUALIFIED cites evidence and `valid_from`; one QUALIFIED per provider+environment; a `CONTRACT_FAKE` route is never LIVE; transition lock keyed provider+environment | control writes; app and payment read |
| `fiscal_issuers` | the contracting and invoicing entity and its issuance route (15 "Accounting integration decision"; 19 "BusinessProfile and legal facts" statuses) | machine FiscalIssuerRoute over `route_state`; QUALIFIED only with OBSERVED or PROFESSIONALLY_CONFIRMED facts, a numbering authorization, verified entitlement (R2-083) and evidence; one QUALIFIED per jurisdiction | control writes; app and payment read |
| `corporate_roles` | ACTIVE/REVOKED grants of `KAURO_OWNER` | machine CorporateGrant; one ACTIVE per person and role; transition lock keyed user | control writes; a person reads its own |
| `refund_policies` | standing refund policies (CMD032 "a standing authorized policy must be referenced rather than invented") | kind, version, scope FULL_REMAINING / EXCESS_ONLY / BOUNDED (+ceiling), phase, origin, conditions hash, the authorizing owner's own step-up proof (composite key to `assurance_proofs`), validity; machine RefundPolicy | control writes; app and payment read |
| `commerce_scopes` | the scope index (§3.2) | append-only; key shape per kind; PAYMENT_ORDER rows name their order | tenant inserts its own; payment inserts in its adopted agency and reads all; an owner reads REFUND rows |
| `aggregate_kinds` | kind → table, id column (D-EVT-B1) | 15 rows (7 B06, 8 B09); read-only to runtime roles | migrations only |

### 4.2 Fiscal profile, quote, eligibility snapshot (0009)

**fiscal_profiles** (registry FiscalProfile; 15 "FiscalProfile"; D-FISC-B1): one reviewed version per row — operator legal ref
(an issuer), customer legal ref, classification, territory, `tax_treatment` (REVIEW_REQUIRED, DOMESTIC_TAXABLE, EXEMPT_EXPORT,
OTHER_REVIEWED), `tax_rule` (UNRESOLVED, RATE_HALF_UP, ZERO_REVIEWED) and `tax_rate_bps`, evidence, reviewer, validity,
supersession. Rules: REVIEW_REQUIRED ⇔ UNRESOLVED with rate 0 (the explicit unknown carries no rule); DOMESTIC_TAXABLE is a
positive rate; EXEMPT_EXPORT is a reviewed zero that requires `export_evidence_hash` (R2-128: "The adapter cannot infer export
exemption from currency or foreign email"; 15: "A foreign customer's address alone does not establish …"); a reviewed treatment
names its reviewer; one current (unsuperseded) profile per agency; supersession once, under the agency's transition lock.
Written by the finance scope, the reviewer being the session's person; read by the agency, the finance scope and the payment
service.

**quotes** (registry Quote; platform machine Quote, D-MACH-B1; 16 "Quote calculation"; D-QUOTE-B1..B4): the immutable terms of
one purchase. Composite keys make every subject column the original's: the project and its mode; the plan of that project with
exactly its body, source and target hashes; the approval of that plan; the fiscal profile with exactly its issuer and reviewed
rule; the eligibility snapshot's applied rate and policy (checked at COMMIT). Arithmetic CHECKs, in numeric so nothing overflows:
discount = `kauro.round_half_up_bps(base, bps)` = floor((B×r+5000)/10000) (reference/HASHING_AND_ACCOUNTING_RULES "Exact
money"); service = base − discount; tax by the reviewed rule (RATE_HALF_UP rounded once, ZERO_REVIEWED zero); total = service +
tax; under price policy R2-INITIAL the base is the registry band of the mode and units (`kauro.r2_initial_base_cents`, proven
band by band equal to the vendored policy), the discount one the policy can produce, and `expires_at` exactly fourteen days
after issuance (policy `quoteDays`). An unreviewed treatment can never be quoted (R2-082). One live quote per project; states
DRAFT → ISSUED (issue_quote, CMD027 in the same transaction) → ACCEPTED_FOR_CHECKOUT (CMD028) → EXPIRED / SUPERSEDED / WITHDRAWN;
leaving ACCEPTED_FOR_CHECKOUT is refused while any capture of it is completed, in flight or uncertain (`quotes_release_guard`,
0010, D-QUOTE-B4). Its state is a transition subject: CMD028, CMD029 and authorization issuance read it after the shared lock.
Tenant writes (CMD027 of B10 inserts and issues; CMD028 accepts); finance and payment read.

**price_eligibility_snapshots** (registry PriceEligibilitySnapshot; 16 "Recurrence decision", "Founding incentive"; D-QUOTE-B2):
the facts the quote was priced with, append-only: a distinct set of other projects of the same agency (trigger), its count, the
tier of that count (R2-INITIAL: 0 / 500 / 1000 / 1500 bps), the founding rate (0 or 2500) with its slot, the applied rate =
greatest of the two (MAX_NOT_STACKED), the exact 365-day lookback. Which projects qualify, and whether a founding slot exists, is
B10's decision; B09 stores the shape.

### 4.3 Orders, attempts, observations, captures, authorizations (0010)

**payment_orders** (registry PaymentOrder; platform machine PaymentOrder, D-MACH-B2; 15 "PaymentOrder and intent"): the quote's
exact accepted amounts (composite key to the quote's terms hash, total, service, tax, currency, project and approval), through
the qualified route's merchant (composite key to the route's provider, environment, merchant, payee, currency), created by one
CMD028 journal entry (`intent_entry_id`, composite with the agency; unique). The provider order id and approval URL are learned
once; one open order per project (INTENT_CREATED … CAPTURE_UNCERTAIN); a provider order id is unique across the platform.
`allocated_cents` is the obligation paid by completed captures, written only by the capture allocation (trigger depth, KP002),
never above the obligation, never down (KP005), exempt from the version bump. Tenant writes (CMD028, CMD029); payment updates
(application of provider results) and never inserts.

**payment_attempts** (registry PaymentAttempt, machine as vendored): one physical provider effect: operation CREATE_ORDER,
CAPTURE or REFUND (WITHDRAW is kept in the vocabulary and refused, Q-B09-5), ordinal 1..3 per logical operation, the exact
request hash, the provider request identity `kauro-<attemptId>` (CHECK: an attempt can only ever repeat its own request),
the dispatch deadline set once with DISPATCHING, evidence for PROVIDER_PENDING / CONFIRMED / FAILED_NO_EFFECT, an outcome token
for FAILED_NO_EFFECT / UNCERTAIN / CANCELLED_BEFORE_DISPATCH. One live and one CONFIRMED attempt per logical operation; ordinal
n > 1 only after attempt n−1 proved no effect (KA008, D-PROTO-B3). A REFUND attempt names its refund of the same order.

**provider_observations** (D-PAY-B3): every authenticated observation applied to an order (DISPATCH_RESPONSE, WEBHOOK with its
inbox record, PROVIDER_QUERY with its stored artifact) and its effect (ADVANCED, NO_CHANGE, STALE_IGNORED, DUPLICATE, MISMATCH,
UNRECOGNIZED); append-only; a webhook event and a query artifact apply once per subject; an UNRECOGNIZED status is recorded as
such (15 "Unknown provider statuses become UNRECOGNIZED_PROVIDER_STATE").

**capture_facts** (registry CaptureFact; platform machine CaptureFact, D-MACH-B3; 15 "Capture and authority"; S058, R2-140):
one real provider capture. Its economic identity (provider, environment, provider capture id) is unique across the platform
("deduplicate repeated events"). The composite key to the order admits only the order's provider, environment, merchant, payee
and currency: a wrong payee, currency or environment is never a capture fact of the order (it becomes a provider event exception,
S058). Born in the status its first authenticated observation shows (D-INIT-B1: the initial PENDING, or one listed edge away);
moves PENDING → COMPLETED / DENIED / REVERSED, COMPLETED → REVERSED. When it completes (or is first seen reversed, D-PAY-B5) its
amount is allocated once: `allocated_service + allocated_tax + excess = amount`, PENDING and DENIED allocate nothing; the
allocation never changes afterwards, the observation time never goes back, known funds availability never becomes unknown
(KP005). `kauro.capture_facts_allocate` (AFTER trigger, under the order's row lock): the part applied to the obligation is
exactly min(amount, still owed), and the service and tax paid by all completed captures never exceed the order's (KP002) — the
domain's `allocateCapture` splits cumulatively by largest remainder so partial captures sum exactly to the quoted service and tax
(15 "Summed allocations must equal the total"). `funds_state` UNKNOWN / HELD / AVAILABLE is provider-reported only. The status
is a transition subject; a reversal cannot commit while an authorization of the capture is live (KP006, deferred).

**commercial_authorizations** (registry CommercialAuthorization; platform machine, D-MACH-B4; 07 "CommercialAuthorization"):
the one logical processing entitlement. Composite keys make it the quoted subject exactly (quote's project, plan, approval,
hashes, mode, units; the approval's hash; the project's capability and version; the order of the quote; the capture of the
order). One per quote, one per capture, one non-revoked per project. `commercial_authorizations_require_capture` (KP004), under
the shared transition locks of agency, capability, approval, source revision, target contract, quote and capture, in that
order: the capture is COMPLETED, its amount is exactly the order's, its allocation is exactly the order's service and tax with no
excess; the quote is ACCEPTED_FOR_CHECKOUT; the approval is live; the agency ACTIVE; the quoted source revision SEALED; the target
contract confirmed and current; the capability offered (S057, S058, S060). A revocation records the phase of the state it leaves
(ACTIVE → PRE_EXECUTION, CONSUMED → DURING_EXECUTION, DELIVERED → POST_DELIVERY; KA008 otherwise). Its state is a transition
subject (B08's CMD036 reads it after the shared lock). `honored_after_price_expiry` records a capture completed after the price
expiry (D-AUTH-B3).

### 4.4 Refunds, cases, exceptions (0011)

**refunds** (registry Refund; platform machine Refund, D-MACH-B5; 15 "Refund policy and calculation"): origin CUSTOMER_REQUEST
(CMD031: the requester's membership and identity, composite key), EXCESS_CAPTURE or KAURO_REMEDY (server-originated, no
requester). The request keeps what was asked: the reason (a registry `label`, constraint `refunds_reason_code_label` mapped to
the field `reasonCode`; never in an event, B06 D-API-1), the evidence reference, the terms hash (composite key to the order), the
delivery phase at request, the proposed components. The approval records the immutable intent: approved service, tax and excess
(an excess return carries only excess, D-REF-B2), the authority (the approver's own step-up proof — composite key to
`assurance_proofs` — or a standing policy), the authorization and effects hashes, whether a credit note is required (exactly
when service or tax is refunded, D-FISC-B2), the approver and instant — all set once. One REQUESTED refund per capture
(REFUND_REQUEST_OPEN). The review (REQUESTED → APPROVED / REJECTED) passes `refunds_review_authority`: the reviewer is the
session's person with an ACTIVE KAURO_OWNER grant after its transition lock (KP007), never the requester (KP008), and a cited
standing policy is ACTIVE and valid at the approval instant, for this origin and the capture's current delivery phase (read after
the authorization's transition lock), within a BOUNDED ceiling (KP010). The commitment ceiling `refunds_commitment_ceiling`
(D-REF-B3): READ COMMITTED only (KP009); the shared capture lock (orders the approval with a reversal); the exclusive per-capture
commitment lock (approvals of one capture take turns); then, with a new snapshot, the capture is COMPLETED and the committing
refunds (APPROVED, SUBMITTING, UNCERTAIN, COMPLETED) plus this one stay within the allocation per component (KP003). A completed
refund that leaves the capture no service basis cannot commit while the authorization is live (KP006, D-REF-B5). Tenant reads
and requests; the finance scope reads and reviews a REQUESTED refund only; the payment service files server-originated requests
and executes approved refunds, never reviews one.

**reconciliation_cases** (platform machine ReconciliationCase, D-MACH-B6; 15 "Operational ledger": "Unexplained differences
create a case with amount and age"; 15 "Webhooks and reconciliation": "Exhausting retries leaves a visible case"): kinds AMOUNT_MISMATCH, EXCESS_CAPTURE, CAPTURE_WITHOUT_VALID_SUBJECT, UNCERTAIN_EFFECT,
UNRECOGNIZED_PROVIDER_STATE, PROVIDER_INCONSISTENCY, REVERSAL, FEE_MISMATCH; a detail token, amount and currency, evidence; one
OPEN case per kind and subject (a repeated observation adds history, never a second case); resolution recorded once by the
finance scope.

**provider_event_exceptions** (D-ING-B2): a verified event no order can take — UNKNOWN_PROVIDER_REFERENCE, WRONG_PAYEE,
WRONG_CURRENCY, WRONG_ENVIRONMENT, UNRECOGNIZED_PROVIDER_STATE, BODY_CONFLICT — kept for the owner's review, platform-level (no
agency), one per inbox record and kind, composite key to the inbox record's provider and environment. No money, no commission, no
authority follows from it.

### 4.5 Fiscal documents, ledger, settlements (0012)

**tax_documents** (registry TaxDocument, machine as vendored; 15 "TaxDocument state machine"; D-FISC-B1..B3): INVOICE of a
capture, CREDIT_NOTE of a refund (correcting the invoice), DEBIT_NOTE (schema only). The fiscal snapshot (profile, issuer,
treatment, rule, rate) is exactly the profile's (composite key). An unreviewed treatment is a blocked DRAFT with its concrete
blocker (FISCAL_TREATMENT_UNREVIEWED, FISCAL_PROFILE_NOT_EFFECTIVE, FISCAL_TREATMENT_CHANGED, FISCAL_ISSUER_MISMATCH,
ISSUER_FACTS_UNCONFIRMED) and can move nowhere; a draft is re-pointed at a re-reviewed profile only while DRAFT
(`tax_documents_draft_only`). DRAFT → VALIDATED is re-checked (`tax_documents_validation_guard`, KP011, after the profile's and
the issuer's transition locks): the profile is current and effective at the tax point (capture completion or refund completion),
its treatment reviewed, the issuer's facts observed or professionally confirmed with a numbering authorization; the amounts are
the collected ones (invoice: the capture's allocation; credit note: the completed refund's approved components); an invoice keeps
the rule the sale was priced with. A legal number exists only with authenticated issuance evidence (15: "A provider PDF existing
does not prove DIAN acceptance"). One live invoice per capture, one live credit note per refund, legal numbers and provider ids
unique per issuer. → CORRECTED requires an actual successor (from REJECTED) or an issued correction document (from ISSUED); the
original record is never overwritten (15 "Original issued facts are not overwritten"). The drafter (payment service) writes;
issuance is CMD035 (B15; Q-B09-6); the agency and the finance scope read.

**ledger_entries** (registry LedgerEntry; 15 "Operational ledger"; D-LEDGER-B1..B3): balanced postings of reconciled money
movements only. A posting set has exactly one source — the domain event that records the movement (capture completed, refund
completed, chargeback) or a settlement observation — exposed as the registry's `eventId` (generated `event_id`), and that
source is the set's idempotency identity: UNIQUE `(event_id, line_no)`, so a replayed delivery posts nothing (reference/HASHING
"a refund webhook replay does not post another refund"). Each set balances within its currency and names one source kind,
reference and agency at COMMIT (KP001); a correction is a mirroring reversal entry, once, plus a new entry; append-only. Accounts
(OPS-1): PSP_RECEIVABLE, PSP_HELD, PSP_AVAILABLE, BANK_IN_TRANSIT, BANK_CASH, CONTRACT_LIABILITY, SERVICE_REVENUE, TAX_PAYABLE,
CUSTOMER_OVERPAYMENT, REFUND_PAYABLE, PROCESSOR_EXPENSE, COMMISSION_PAYABLE, COMMISSION_EXPENSE, OWNER_CONTRIBUTION,
OWNER_DISTRIBUTION. A capture before delivery is a contract liability, not revenue (15 "Revenue recognition follows the actual
accounting policy"). Event-sourced postings belong to the event's agency (composite key to `domain_events`); settlement postings
to none. The FINANCE consumer (payment service) posts; the finance scope reads.

**settlements** (registry Settlement; 15 "Settlement and withdrawal"; D-SETTLE-B1): observed balances of a route for a period —
gross, fees, held, withdrawn, bank-available (with the bank statement's evidence; never derived from a provider balance: CMD034
failure "A provider pending/held state is never coerced to settled available cash"), optional exact FX rate. Platform-level,
append-only. Posting settlements and reconciling withdrawals is B15's (R2-085).

### 4.6 State machines

Registry machines used as vendored: **PaymentAttempt** (PREPARED initial; 11 edges) and **TaxDocument** (DRAFT initial; 9
edges). Platform machines declared by this package in the registry's own shape and under the registry's unlisted-transition
policy (REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED) — exactly as B06 declared EndClient and Project — in
`@kauro/domain` `COMMERCE_PLATFORM_MACHINES`, seeded identically (proven by `b09-migrations.test.ts` "B09 seeds …"):

| machine (decision) | initial | edges (event: from → to) |
|---|---|---|
| Quote (D-MACH-B1; 07 "Quote and checkout states" names the states) | DRAFT | issue_quote DRAFT→ISSUED; withdraw_quote DRAFT/ISSUED/ACCEPTED_FOR_CHECKOUT→WITHDRAWN; accept_terms_for_checkout ISSUED→ACCEPTED_FOR_CHECKOUT; price_expiry_reached ISSUED/ACCEPTED→EXPIRED; superseding_quote_issued ISSUED/ACCEPTED→SUPERSEDED |
| PaymentOrder (D-MACH-B2; the contract's states) | INTENT_CREATED | dispatch_intent_committed →CREATING; cancel_before_dispatch INTENT_CREATED→CANCELLED; provider_order_created CREATING→CREATED; creation_proved_no_effect CREATING→FAILED; buyer_approval_observed CREATED→APPROVED; capture_dispatch_committed CREATED/APPROVED→CAPTURING; capture_observed CREATED/APPROVED/CAPTURING/CAPTURE_UNCERTAIN→CAPTURED; capture_ambiguous CAPTURING→CAPTURE_UNCERTAIN; capture_proved_no_effect CAPTURING→APPROVED; capture_proved_no_effect_unapproved CAPTURING→CREATED; reconciliation_proves_no_capture CAPTURE_UNCERTAIN→APPROVED; reconciliation_proves_no_capture_unapproved CAPTURE_UNCERTAIN→CREATED; order_voided CREATED/APPROVED→CANCELLED; order_expired CREATED/APPROVED→EXPIRED |
| CaptureFact (D-MACH-B3) | PENDING (observed birth, D-INIT-B1) | provider_completed PENDING→COMPLETED; provider_denied PENDING→DENIED; provider_reversed PENDING/COMPLETED→REVERSED |
| CommercialAuthorization (D-MACH-B4) | ACTIVE | execution_admitted ACTIVE→CONSUMED (CMD036, B08); package_published CONSUMED→DELIVERED (B08); authority_revoked ACTIVE/CONSUMED/DELIVERED→REVOKED |
| Refund (D-MACH-B5; the contract's states) | REQUESTED | approve_refund →APPROVED; reject_refund →REJECTED; dispatch_intent_committed APPROVED→SUBMITTING; authorization_lapsed APPROVED→FAILED; authenticated_completed SUBMITTING→COMPLETED; ambiguous_transport_result SUBMITTING→UNCERTAIN; proved_no_effect SUBMITTING→APPROVED; provider_refused SUBMITTING→FAILED; reconciliation_completed UNCERTAIN→COMPLETED; reconciliation_proves_no_effect UNCERTAIN→APPROVED; reconciliation_proves_refusal UNCERTAIN→FAILED |
| ReconciliationCase (D-MACH-B6) | OPEN | case_resolved OPEN→RESOLVED |
| PaymentRoute (D-MACH-B7), FiscalIssuerRoute (D-MACH-B8) | CONFIGURED | route_qualified CONFIGURED→QUALIFIED; route_suspended CONFIGURED/QUALIFIED→SUSPENDED |
| CorporateGrant (D-MACH-B9) | ACTIVE | grant_revoked ACTIVE→REVOKED |
| RefundPolicy (D-MACH-B10) | ACTIVE | policy_retired ACTIVE→RETIRED |

Every edge's performer (command or owning package) is in the generated matrix (`docs/design/B06-state-command-event-matrix.md`,
owner table in `tools/matrix.mjs`).

## 5. Ports

Domain repositories (`@kauro/domain` `ports/commerce.ts`, implemented over `pg` by M1): `PaymentRouteRepository`,
`FiscalRepository` (current profile after its transition lock, issuer after its lock, `recordProfile` superseding once),
`CorporateGrantRepository.activeGrant` (after the grant's lock), `RefundPolicyRepository`, `ScopeIndex` (record / resolve),
`QuoteRepository` (issue with snapshot; CAS transitions), `PaymentOrderRepository` (insert, `findByIntentEntry`,
`findOpenForProject`, CAS transitions with provider ids learned once), `PaymentAttemptRepository` (prepare, `findLive`,
`countFor`, `findByIntentEntry`, CAS transitions), `CaptureFactRepository` (insert at first observed status, `advance`,
`observeFunds`, `committedRefunds`, `findByProviderCapture`), `ProviderObservationRepository`,
`CommercialAuthorizationRepository`, `RefundRepository` (request, approve with the immutable intent, transition,
`findOpenForCapture`), `TaxDocumentRepository` (draft, redraft, transition, live invoice / credit note, blocked drafts),
`LedgerRepository.post` (idempotent by source), `SettlementRepository`, `ReconciliationCaseRepository.open` (idempotent per kind
and subject), `PaymentInboxRepository` (lock for apply, settle, record exception). `CommerceUnitOfWork extends UnitOfWork` adds
`commerce`, `scopes`, `adoptScope`, `adoptFinanceScope`, `commerceScope`; `CommerceUnitOfWorkFactory` runs it. Every versioned
write is compare-and-swap and answers STALE with the current safe version and state (B06 D-VER-1); every read of a fact relied on
without change happens after that fact's transition lock (B06 D-TX-2).

Application ports (`@kauro/application` `commerce/ports.ts`; no port call inside a database transaction, 07):
`PaymentProviderAdapter` (pure `prepareCreateOrder` / `prepareCapture` / `prepareRefund` producing the exact `ProviderRequest`
whose digest is the attempt's request hash; network `dispatch` bounded by a deadline; read-only `observeOrder` by provider id or
by request identity, `observeRefund`; pure `classifyOrderObservation` of stored evidence; `approvalHosts` allowlist),
`ProviderDispatchResult` (ORDER_CREATED, CAPTURE_OBSERVED, REFUND_OBSERVED, PROVED_NO_EFFECT with an outcome token, AMBIGUOUS with
its reason, UNRECOGNIZED — 10: timeout, reset, rejection, pending, unknown and confirmed are distinct), `WebhookVerifier` (exact
raw bytes; signature, freshness, environment; bounded body), `ProviderEvidenceStore` (restricted reconciliation store; immutable,
content-addressed; 10 "Raw sensitive provider responses stay in a restricted reconciliation store"), `FiscalDocumentBridge`
(pure `prepare` of the issuance packet from the reviewed treatment — nothing it could infer an exemption from, R2-128; `submit`
and `observe` are CMD035's, B15), `ServiceAuthenticator` (issuer, audience, identity, environment), `CommerceAuthorizer` (§3.4),
`CommerceReconciler` (the §6.3 algorithm behind CMD029's settle step, the webhook's application and CMD034 — implemented by M2,
called by M3) and `CommerceEventConsumer` (FINANCE, FISCAL, PAYMENT_SERVICE; §8.1). The provider-effect protocol's phase
interface is `ProviderCommandPhases` (`commerce/protocol.ts`, §6.1).

Contract fakes (D-FAKE-B1): until B15, the tests bind fakes of `PaymentProviderAdapter`, `WebhookVerifier`,
`ProviderEvidenceStore`, `FiscalDocumentBridge` and `ServiceAuthenticator` that implement the documented provider contract
(PayPal Orders v2 shapes of 15 "Capture and authority"), declare `integrationClass: "CONTRACT_FAKE"`, live under `test/` or a
`testing` subpath, and are named SIMULATED in the case map. The database refuses a fake route on LIVE; nothing in the product
wiring binds a fake.

## 6. Transaction discipline

### 6.1 The provider-effect protocol (D-PROTO-B1..B4)

07 "Transaction discipline": no database transaction stays open across a payment API call; the first accepted request records
its intent before external dispatch (10 "Idempotency contract"). CMD028 (create order), CMD029 (capture) and CMD033 (refund) run
as four steps (`commerce/protocol.ts`):

1. **T1 intent** — one unit of work in B06's pipeline order: access decision → journal reserve (RESERVED) → assurance → locked
   preconditions → durable intent (the order or refund row; the attempt PREPARED with its request hash and provider request
   identity; the scope rows) → events and outbox → COMMIT. The journal entry stays RESERVED.
2. **T2 claim** — CAS the attempt PREPARED → DISPATCHING with `dispatch_deadline_at` = now + DISPATCH_TIMEOUT_SECONDS (30) +
   DISPATCH_WATCHDOG_MARGIN_SECONDS (30), and the aggregate's own dispatch edge (order CREATING / CAPTURING, refund SUBMITTING).
   The single serialization point of "dispatch at most once": a loser of the CAS never calls the provider.
3. **call** — outside any transaction: exactly the prepared request under `kauro-<attemptId>`, bounded by the deadline.
4. **T3 settle** — lock the aggregate, then the attempt; apply the authenticated result through the same reconciler the webhook
   and CMD034 use (§6.3); complete the journal: COMMITTED with the 2xx answer when conclusive, UNCERTAIN with a 202 operation
   reference when the effect is unknown (D-PROTO-B2; D-JOURNAL-B1).

**Resume** (same key, same digest; the journal answers PENDING for RESERVED/UNCERTAIN): re-run the access decision (B06
D-PIPE-1), find the operation by its journal entry (`intent_entry_id`), continue from its durable state: PREPARED → claim and
call; DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe (a read, never a second create) and settle when conclusive, else 202;
a proved no-effect permits a new deliberate attempt (ordinal + 1, a new request identity; at most MAX_ATTEMPTS_PER_OPERATION = 3,
enforced by `payment_attempts_sequence` and the ordinal CHECK, D-PROTO-B3); terminal → settle the journal and answer. A crash at
any point leaves a state from which the same key converges to one effect (07 "The client recovers the same command result by its
idempotency identity. It must not repeat the external effect under a new key"). **Watchdog** (D-PROTO-B4): the payment
service's sweep (07 "The sweeper repairs … ambiguous provider operations"; scheduled by the PAYMENT_SERVICE consumer of
`payment_attempt.dispatching.v1` / `provider_pending.v1` / `uncertain.v1` and by a bounded periodic pass) observes every attempt
past its `dispatch_deadline_at` (index `payment_attempts_watchdog`) and settles it through CMD034 with a stored observation; an
attempt left UNCERTAIN stays visible with a case (15 "Exhausting retries leaves a visible case with the exact unresolved
effect"). **Cancel before dispatch**: an intent whose claim never committed and whose client never resumed it — PREPARED for
longer than the claim window, index `payment_attempts_unclaimed` — is cancelled by the same sweep (PREPARED →
CANCELLED_BEFORE_DISPATCH; an order still INTENT_CREATED → CANCELLED), since no provider call was possible: the claim (T2) is
the only path to a call, and a later resume of the same key finds the operation cancelled and answers it.

### 6.2 Isolation, lock order, transition subjects (D-TX-B1)

READ COMMITTED everywhere (07: constraints and row locks enforce the invariants; the refund ceiling and the inbox APPLIED
settlement refuse any other isolation because their re-check must read what committed while they waited). Every command takes
its locks in one global order, which also orders B09 after B06's (B06 D-TX-2: identity → membership → agency → client →
capability; plan → source revision → target contract):

**identity → membership → corporate grant → agency → capability → approval → source revision → target contract → payment route /
fiscal issuer / fiscal profile → quote → payment order → attempt → capture → commercial authorization → refund → tax document →
ledger.**

Facts relied on without change are read after the shared half of their transition lock (`kauro.await_transition`): the agency,
the capability of the mode, the approval (its withdrawal takes the exclusive half, 0010), the source revision, the target
contract, the payment route (provider+environment), the fiscal issuer, the fiscal profile (agency), the quote, the capture, the
commercial authorization, the corporate grant (user). Rows the command changes are locked `FOR UPDATE` in the order above. B06's
reader/writer rule holds for every subject: a command that changes a subject's state locks its row and takes no shared half (its
update takes the exclusive half through the subject's trigger); a command that relies on it without changing it takes the shared
half and no row lock (a row-level FOR SHARE would let later readers overtake a queued writer, B06 re-check N3). A handler reads
the ids it needs without a lock, takes the shared halves in the order above, then its row locks; the awaits inside the B09
triggers (authorization issuance, refund review and ceiling, fiscal validation) re-acquire locks the handler already holds and
are the database's backstop. The refund commitment adds the exclusive per-capture lock `kauro.capture_refunds` after the
capture's shared half. `b09-migrations` "CMD032-RACE" observes the approval waiting for a reversal in flight and then refused
(KP003) — no sleep; the wait is observed in `pg_stat_activity`.

### 6.3 The reconciler (one algorithm for every capture path)

CMD029's settle step, the application of a webhook (CMD030) and CMD034 apply an authenticated observation to an order the same
way, inside one unit of work under the order's row lock:

1. **Attribute**: provider + environment + provider order / capture / refund id → the scope index (the webhook adopts the agency
   here; an unknown identity is a provider event exception UNKNOWN_PROVIDER_REFERENCE, never a guess from a payload's agency id —
   10: "It does not trust the agency ID in a provider payload without matching the stored order").
2. **Order the locks** (§6.2): since a completion may issue the authorization, the shared halves of the agency, the capability,
   the approval, the source revision, the target contract, the route and the quote are taken before the order's row lock (the
   ids are read without a lock first); a capture's own transition lock comes with its status update.
3. **Match** (`matchCapture`): provider, environment, provider order id, payee digest, currency; a mismatch is an exception
   (WRONG_PAYEE / WRONG_CURRENCY / WRONG_ENVIRONMENT) and no fact of the order changes (S058).
4. **Order the observation**: record it in `provider_observations`; an observation behind the subject's latest applied one, a
   duplicate, or a regression is kept as history (STALE_IGNORED / DUPLICATE) and changes nothing (15 "An old pending event cannot
   roll back a confirmed terminal capture"); a contradiction of a terminal state opens PROVIDER_INCONSISTENCY; an unknown status
   is UNRECOGNIZED and opens UNRECOGNIZED_PROVIDER_STATE.
5. **Step** (`captureStatusStep`): insert the fact at its observed status, or advance it along the lattice; on completion,
   allocate (`allocateCapture`: min(amount, owed) to the obligation, split cumulatively, the rest excess).
6. **Consequences in the same transaction**: the order's edge (capture_observed, …); when the capture alone pays the whole
   obligation and every prerequisite still binds (`authorizationBlockers`; price expiry honored per D-AUTH-B3), issue the
   CommercialAuthorization; a partial amount opens AMOUNT_MISMATCH; an excess opens EXCESS_CAPTURE and files an EXCESS_CAPTURE
   refund request (R2-140); a capture whose subject no longer binds opens CAPTURE_WITHOUT_VALID_SUBJECT and files a KAURO_REMEDY
   request (15 "Price and source expiry races": refund and issue a new quote); a reversal revokes the live authorization with its
   phase and lapses APPROVED refunds of the capture (Refund authorization_lapsed), and opens REVERSAL.
7. **Events and outbox**, the inbox record's settlement (webhook: APPLIED with the result event, IGNORED, REJECTED or RETRYABLE),
   and the observation's effect.

## 7. Error contract

Failure codes are B06's (10 "Responses and safe errors"; PAYMENT_PENDING and PAYMENT_UNCERTAIN now used). Reasons: the 46
`COMMERCE_FAILURE_REASONS` appended to `FAILURE_REASONS` (`@kauro/domain` `commerce/failure-reasons.ts`) — principals
(CORPORATE_ROLE_MISSING, SELF_APPROVAL_FORBIDDEN, SERVICE_NOT_PERMITTED, SERVICE_ENVIRONMENT_MISMATCH, POLICY_NOT_APPLICABLE),
provider ingress (PROVIDER_UNKNOWN, PROVIDER_SIGNATURE_INVALID, PROVIDER_EVENT_STALE, PROVIDER_ENVIRONMENT_MISMATCH,
PROVIDER_BODY_TOO_LARGE, EVIDENCE_NOT_FOUND, PROVIDER_SERVICES_UNAVAILABLE), quotes and checkout (QUOTE_NOT_ACTIVE, QUOTE_EXPIRED,
APPROVAL_NOT_CURRENT, PAYMENT_ROUTE_UNQUALIFIED, FISCAL_ROUTE_UNQUALIFIED, FISCAL_TREATMENT_UNREVIEWED,
FISCAL_PROFILE_NOT_EFFECTIVE, FISCAL_TREATMENT_CHANGED, ALREADY_PAID), orders and captures (CREATION_IN_PROGRESS,
CAPTURE_IN_PROGRESS, CAPTURE_UNCERTAIN, ORDER_NOT_CAPTURABLE, PROVIDER_REFERENCE_MISMATCH, OBSERVATION_STALE,
OBSERVATION_SUBJECT_MISMATCH, UNRECOGNIZED_PROVIDER_STATE), refunds (NOTHING_TO_REFUND, REFUND_REQUEST_OPEN,
REFUND_EXCEEDS_REMAINING, REFUND_COMPONENT_INVALID, REFUND_NOT_REQUESTED, REFUND_NOT_APPROVED, REFUND_IN_PROGRESS,
REFUND_UNCERTAIN, CAPTURE_NOT_REFUNDABLE), integrity (LEDGER_UNBALANCED, OBLIGATION_OVER_ALLOCATED, FACT_REGRESSION,
AUTHORITY_WITHOUT_CAPTURE, AUTHORITY_OUTLIVES_REVERSAL, FINANCE_SCOPE_MISSING, COMMITMENT_ISOLATION, FISCAL_VALIDATION_REFUSED).

SQLSTATE class KP (0008 header; `packages/persistence/src/sqlstate.ts`): KP001 LEDGER_UNBALANCED, KP002
OBLIGATION_OVER_ALLOCATED, KP005 FACT_REGRESSION, KP004 AUTHORITY_WITHOUT_CAPTURE, KP006 AUTHORITY_OUTLIVES_REVERSAL, KP009
COMMITMENT_ISOLATION, KP011 FISCAL_VALIDATION_REFUSED → INTEGRITY_FAILURE (a handler that follows the domain rules never meets
them); KP003 REFUND_EXCEEDS_REMAINING → PRECONDITION_FAILED (a racing approval can); KP007 CORPORATE_ROLE_MISSING and KP008
SELF_APPROVAL_FORBIDDEN → NOT_AUTHORIZED; KP010 POLICY_NOT_APPLICABLE → ASSURANCE_REQUIRED; `refunds_reason_code_label` →
INVALID_REQUEST SCHEMA_VIOLATION on `reasonCode` (B06 D-LABEL-1). Unique indexes decided by the handler (B06 practice):
`payment_orders_one_open_per_project` → PAYMENT_PENDING, `refunds_one_requested_per_capture` → REFUND_REQUEST_OPEN,
`commercial_authorizations_one_per_*` → the replayed/current authorization, `capture_facts_provider_identity` → DUPLICATE.

Outcome catalogues (`commerce/outcomes.ts`, D-OUT-B1): each route's closed catalogue composes B06's `ROUTE_OUTCOME_FRAGMENTS`
(every route's transport, admission, authentication, idempotency and platform outcomes; path ids; tenant membership; the agency
selector; the read forms) with the B09 access fragments and the command-layer outcomes: tenant commands = EVERY_ROUTE + PATH_IDS +
TENANT + AGENCY_HEADER + command; operator = EVERY_ROUTE + PATH_IDS + OPERATOR_ACCESS + command; service = EVERY_ROUTE without a
person's identity outcomes + PATH_IDS + SERVICE_ACCESS + command; webhook = transport + PROVIDER_ACCESS + platform (the provider
is answered 200 with its inbox disposition once authenticated, D-ING-B2). A composed catalogue refuses a duplicate entry. What is
not a problem: an ambiguous provider effect answers 202 ACCEPTED with the durable operation (D-PROTO-B2).

## 8. The seven commands

Common to all: the B06 envelope (Idempotency-Key except CMD030, X-Kauro-Agency where the scope is AGENCY_HEADER,
X-Correlation-Id), the closed request schema (`COMMERCE_REQUEST_SCHEMAS`; registry field names exactly, money as
MoneyMinorUnits strings, CMD031 `reasonCode` a label), admission in manual-10 order, the response guard, the security fact of
every decision. "OK / DENY / RACE" restate the registry's expectation of the triad and name how the design meets it.

### CMD028 CreatePaymentOrder — POST /api/v1/quotes/{quoteId}/payment-orders — AGENCY_BILLING — scope AGENCY_HEADER — provider effect CREATE_ORDER

Body `{ termsHash }`. **T1**: access (B06) → journal reserve → lock order: `await` agency, capability, approval, source
revision, target contract, payment route (the QUALIFIED route of the adapter's provider and environment), fiscal issuer, fiscal
profile; then the quote — `FOR UPDATE` while it is ISSUED (this command accepts it, the writer's path), its shared half once it
is ACCEPTED_FOR_CHECKOUT (a later order of the same quote only relies on it; a concurrent first acceptance leaves the loser
holding the row lock of the accepted quote, and the one-open-order index decides between them). Preconditions, in order (first
failure answers; `checkoutBlockers`): quote visible
(NOT_FOUND); `termsHash` equals the quote's (STALE_VERSION HASH_MISMATCH, current.mismatch); agency ACTIVE; quote ISSUED or
ACCEPTED_FOR_CHECKOUT (QUOTE_NOT_ACTIVE); price not expired (QUOTE_EXPIRED); not already paid (an authorization of the quote or a
completed capture of one of its orders: ALREADY_PAID); the project's open order is not uncertain (PAYMENT_UNCERTAIN
CAPTURE_UNCERTAIN) or in progress (PAYMENT_PENDING CREATION_IN_PROGRESS / CAPTURE_IN_PROGRESS; retryable); source SEALED
(SOURCE_EXPIRED); approval current (APPROVAL_NOT_CURRENT); target current (TARGET_STALE); capability offered
(CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED); route qualified (PAYMENT_ROUTE_UNQUALIFIED); issuer route qualified
(FISCAL_ROUTE_UNQUALIFIED); the current profile's reviewed rule equals the quote's (FISCAL_TREATMENT_UNREVIEWED /
FISCAL_TREATMENT_CHANGED); an adapter bound (INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE, nothing written). Writes: the quote
ISSUED → ACCEPTED_FOR_CHECKOUT on the first order (quote.accepted_for_checkout.v1); the order INTENT_CREATED
(payment_order.intent_created.v1) with `idempotency_hash` = `paymentIntentHash` (KAURO_PAYMENT_INTENT_V1: quote, terms, amount,
currency, route, provider, environment); the CREATE_ORDER attempt PREPARED (payment_attempt.prepared.v1) with the prepared
request's hash; the PAYMENT_ORDER scope row. **T2** CREATING / DISPATCHING. **call** `dispatch(prepareCreateOrder)`. **T3**
ORDER_CREATED → attempt CONFIRMED, order CREATED with provider id and approval URL (host allowlisted), PROVIDER_ORDER scope row;
201 `CreatePaymentOrderView { order (with checkout), quote }`, journal COMMITTED. AMBIGUOUS → attempt UNCERTAIN, 202 (resume
observes by request identity, never creates again, 15 "The adapter does not create another order under a new local identity");
PROVED_NO_EFFECT → attempt FAILED_NO_EFFECT and, attempts spent, order FAILED; otherwise a new deliberate attempt.

- **OK**: one order, one attempt, one provider order; the intent is durable before the call (T1 commits first).
- **DENY**: any blocker above refuses with no committed state and no provider call (the refusal happens in T1 before the
  intent, S060: a price-valid quote whose source expired blocks checkout). "Source expiry racing order creation prevents new
  capture authority": a source transition after T1 is ordered after it (transition lock); authority is only ever issued at
  capture under the same checks (KP004), so the order may exist and still never carry authority.
- **RACE**: two keys: the second T1 fails `payment_orders_one_open_per_project` → PAYMENT_PENDING (retry later) or reads the
  first's order in progress; same key: the journal replays or resumes the one operation; an ambiguous creation is reconciled by
  request identity.

### CMD029 CapturePayment — POST /api/v1/payment-orders/{orderId}/capture — AGENCY_BILLING — scope AGENCY_HEADER — provider effect CAPTURE

Body `{ providerApprovalRef }`, a browser echo compared with the stored provider order id and never evidence (D-PAY-B4).
**T1**: access → journal → `await` agency, capability, approval, source, target, route, quote; `FOR UPDATE` the order.
Preconditions: order visible (NOT_FOUND); `providerApprovalRef` names it (INVALID_REQUEST PROVIDER_REFERENCE_MISMATCH,
UNKNOWN_REFERENCE; S057); order CREATED or APPROVED (ORDER_NOT_CAPTURABLE / ALREADY_PAID when CAPTURED); no live CAPTURE attempt
(PAYMENT_PENDING CAPTURE_IN_PROGRESS) or uncertain one (PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN); quote ACCEPTED_FOR_CHECKOUT
(QUOTE_NOT_ACTIVE) and price not expired before the capture starts (QUOTE_EXPIRED; 15 "If the quote expires before provider
capture starts, checkout is blocked"); every other blocker of checkout readiness (`checkoutBlockers` without the order's own
payment state): the subject blockers, the merchant and fiscal issuer routes still qualified, and the quoted reviewed tax rule
still the current one (15 "Price and source expiry races": the same terms stand only while "legal treatment … remain[s]
valid"; FISCAL_TREATMENT_UNREVIEWED / FISCAL_TREATMENT_CHANGED). Writes: CAPTURE attempt PREPARED. **T2**
order CAPTURING, attempt DISPATCHING. **call** `dispatch(prepareCapture)`. **T3** through the reconciler (§6.3): CAPTURE_OBSERVED
COMPLETED of the full obligation → capture fact, order CAPTURED, authorization issued in the same transaction, 200
`CapturePaymentView { order, capture, commercialAuthorization, authorizationBlockers: [] }`; PENDING → attempt PROVIDER_PENDING,
202; AMBIGUOUS → order CAPTURE_UNCERTAIN, 202; PROVED_NO_EFFECT → order back to APPROVED (or CREATED when approval lapsed) with
the attempt FAILED_NO_EFFECT; a capture whose subject no longer binds → 200 with the capture, no authorization, the blockers
named, a remedy request filed.

- **OK**: server-side capture, authenticated result reconciled, one authorization.
- **DENY**: "Browser success, forged event or unknown result cannot create CommercialAuthorization": a mismatched echo is refused
  before any effect; a forged webhook never passes ingress (§CMD030); an unknown result is UNCERTAIN (202), never authority; the
  database refuses any authorization without a completed capture that alone pays the obligation (KP004).
- **RACE**: capture vs webhook of the same capture: both serialize on the order row; the second sees the first's fact
  (DUPLICATE), one authorization (`one_per_quote`, `one_per_capture`). Two capture commands: one live CAPTURE attempt per order
  (unique) → PAYMENT_PENDING. Capture vs quote supersession: `quotes_release_guard` waits and refuses the release.

### CMD030 ReceivePaymentWebhook — POST /api/v1/payments/webhooks/{provider} — AUTHENTICATED_PROVIDER — ingress + application

**Ingress** (kauro_ingress; synchronous; no Idempotency-Key — the inbox identity is the provider's event id, D-IDEM-B1): provider
configured (NOT_FOUND PROVIDER_UNKNOWN); raw body within `maxBodyBytes` (PROVIDER_BODY_TOO_LARGE); `WebhookVerifier.verify` over
the exact bytes (AUTHENTICATION_REQUIRED PROVIDER_SIGNATURE_INVALID / PROVIDER_EVENT_STALE / PROVIDER_ENVIRONMENT_MISMATCH; an
ANONYMOUS DENY fact; nothing else stored); store the raw event in the evidence store (content-addressed; its artifact ref is the
normalized command's `providerEventArtifactRef`); `InboxIngress.record` (B06): a new record RECEIVED, a duplicate (same body)
DUPLICATE, a different body a recorded conflict (BODY_CONFLICT, never absorbed); a SERVICE ALLOW fact. Answer 200 `WebhookAck
{ received, inboxState, duplicate, conflict }` — the provider learns only that the event was recorded and its disposition.
**Application** (kauro_payment; immediately after, or by the PAYMENT_SERVICE inbox worker): `lockForApply` (B06 guards), classify
the normalized event, adopt the agency through the scope index (unknown → exception + IGNORED), reconcile (§6.3), settle the
record (APPLIED with the result event under READ COMMITTED and the record's exclusive lock; REJECTED for a mismatch; IGNORED for a
stale/duplicate; RETRYABLE when a dependency is unavailable). A record with a conflicting body is never APPLIED (KA012) and
becomes a BODY_CONFLICT exception.

- **OK**: one durable inbox entry, reconciled with the local order.
- **DENY**: "Wrong payee/currency/order or invalid signature rejects; duplicates do not add money or commissions": a bad
  signature stores nothing; a wrong payee/currency/order never becomes a fact of the order (composite key, S058) and is an
  exception; a duplicate is the same inbox record and the same capture identity (unique), so no second capture, posting or
  commission event exists.
- **RACE**: concurrent deliveries of one event: B06's inbox unique identity and conflict protocol; delivery vs CMD029's settle:
  the order row lock orders them, the loser observes DUPLICATE.

### CMD031 RequestRefund — POST /api/v1/projects/{projectId}/refund-requests — AGENCY_BILLING — scope AGENCY_HEADER

Body `{ reasonCode (label), evidenceRef }`. Access → journal → project visible (NOT_FOUND) → its paid order's capture with a
refundable service or tax balance (`refundableBalance` of the latest COMPLETED capture; NOTHING_TO_REFUND) → no REQUESTED refund
of that capture (REFUND_REQUEST_OPEN). Writes: refund REQUESTED (refund.requested.v1) with the proposal (`proposeRefund`: the
whole remaining service and tax), the delivery phase (`deliveryPhaseOf` the authorization), the terms hash, the requester, the
REFUND scope row. 201 `RequestRefundView`. No provider effect.

- **OK**: a reviewable request with delivery, terms and evidence references.
- **DENY**: "Customer cancellation is not direct permission to send arbitrary PSP refunds": the request is REQUESTED only; the
  agency holds no update on refunds, the approval needs a KAURO_OWNER (KP007) other than the requester (KP008).
- **RACE**: two requests for one capture: `refunds_one_requested_per_capture` → REFUND_REQUEST_OPEN for the second key; the same
  key replays.

### CMD032 ApproveRefund — POST /api/v1/refunds/{refundId}/approve — KAURO_OWNER — scope STORED_OPERATION

Body `{ expectedVersion, serviceCents, taxCents, authorizationRef }`. Access (`authorizeOperator`) → `adoptScope("REFUND", id)`
→ journal (identity-owned) → read the refund, `await` its capture and the capture's authorization, lock the refund → `assureOperator` (standing policy that covers, else a fresh
step-up of the operator: STEP_UP_MISSING / STEP_UP_STALE / STEP_UP_NOT_OWNED / POLICY_NOT_APPLICABLE) → preconditions:
version (STALE_VERSION); REQUESTED (REFUND_NOT_REQUESTED); capture COMPLETED (CAPTURE_NOT_REFUNDABLE); components valid for the
origin (`approvedComponents`, `checkRefundAmounts`: REFUND_COMPONENT_INVALID; REFUND_EXCEEDS_REMAINING); requester ≠ approver
(SELF_APPROVAL_FORBIDDEN). Writes: the immutable intent (`authorizationHash` = KAURO_REFUND_AUTHORIZATION_V1 over the amounts,
the approved reason — a label: a digest may cover it, a payload never carries it —, the authority, approver, instant and
`effectsHash` = KAURO_REFUND_EFFECTS_V1 over credit-note requirement, remaining service basis (cumulative, R2-081) and whether it
revokes); refund.approved.v1 → PAYMENT_SERVICE (execution). 200 `ApproveRefundView { refund, effects, authorizationKind }`.

- **OK**: the authorized amount and reason as an immutable intent.
- **DENY**: "The total cannot exceed reconciled remaining capture; a standing authorized policy must be referenced rather than
  invented": the ceiling (domain and KP003), the policy applicability (domain `policyCovers` and KP010), a step-up otherwise.
- **RACE**: two approvals of one version: the CAS admits one, the other STALE_VERSION; an approval vs a reversal of the capture:
  ordered by the capture's lock, the later approval refused (KP003; proven at DB level).

### CMD033 ExecuteRefund — POST /api/v1/refunds/{refundId}/execute — PAYMENT_SERVICE — scope STORED_OPERATION — provider effect REFUND

Body `{ expectedVersion }`. Access (`authorizeService`) → `adoptScope("REFUND", id)` → journal → read the refund, `await` its capture, lock the refund →
version; APPROVED (REFUND_NOT_APPROVED); capture still COMPLETED, else the refund lapses (APPROVED → FAILED
authorization_lapsed, CAPTURE_NOT_REFUNDABLE); no live REFUND attempt (PAYMENT_PENDING REFUND_IN_PROGRESS) and no UNCERTAIN one
("any prior ambiguous submission is reconciled": PAYMENT_UNCERTAIN REFUND_UNCERTAIN until CMD034 settles it). **T1** REFUND
attempt PREPARED; **T2** refund SUBMITTING, attempt DISPATCHING; **call** `dispatch(prepareRefund)` for the approved total under
the attempt's request identity; **T3**: REFUND_OBSERVED COMPLETED with the exact amount → attempt CONFIRMED, refund COMPLETED
(refund.completed.v1 → FINANCE, FISCAL, COMMISSIONS, NOTIFICATIONS: the credit note, the ledger return posting and the commission
adjustment follow the event, once each); a completion that leaves no service basis revokes the authorization in the same
transaction (KP006, D-REF-B5); AMBIGUOUS → refund UNCERTAIN, attempt UNCERTAIN, 202; PROVED_NO_EFFECT → refund back to APPROVED
(a new deliberate attempt later); definitive refusal → FAILED (the commitment is released).

- **OK**: "Submit once per reconciled provider identity and publish final refund/credit-note/commission events".
- **DENY**: "Timeout stays UNCERTAIN with no blind duplicate financial effect": a second execute while UNCERTAIN is refused
  until reconciled; the one-live-attempt index and the request identity make a duplicate dispatch impossible.
- **RACE**: two executes: T2's CAS admits one claimant; the other observes the live attempt (PAYMENT_PENDING) or resumes the
  same operation under the same key.

### CMD034 ReconcilePayment — POST /api/v1/payment-orders/{orderId}/reconcile — PAYMENT_SERVICE — scope STORED_OPERATION

Body `{ observationRef }`: a stored, authenticated provider query (the watchdog or the periodic reconciler performed it
outside any transaction and stored it). Access → `adoptScope("PAYMENT_ORDER", id)` → journal → the evidence exists
(EVIDENCE_NOT_FOUND) and is about this order, provider and environment (OBSERVATION_SUBJECT_MISMATCH) → lock order → reconcile
(§6.3) including uncertain attempts (UNCERTAIN → CONFIRMED / FAILED_NO_EFFECT), uncertain refunds (→ COMPLETED / APPROVED /
FAILED), order creation (CREATING → CREATED / FAILED), capture uncertainty, reversals, fees and funds availability (`funds_state`
as reported; never available cash). 200 `ReconcilePaymentView { order, captures, commercialAuthorization, effects, openCases }`.

- **OK**: "Advance local facts from actual provider state and record mismatch incidents".
- **DENY**: "A provider pending/held state is never coerced to settled available cash": funds are HELD/AVAILABLE as reported;
  bank cash exists only in a settlement with bank evidence (`settlements_bank_evidence`, proven).
- **RACE**: reconcile vs webhook vs capture settle: the order row lock; observations are monotonic and idempotent per artifact
  and inbox record.

### 8.1 Consumers (D-CONS-B1)

The payment service runs three consumers of the outbox (B06 dispatch, at least once; each deduplicates by its own durable
identity — 07 "Consumers deduplicate by their own durable inbox identity"):

- **FINANCE** (capture.completed, capture.reversed, refund.completed): adopts the event's agency through its order, posts the
  balanced set (`capturePostings`, `providerFeePostings` of the reported fee, `returnPostings`) with the event as source; a
  replay is a no-op (UNIQUE `(event_id, line_no)`). A fee the provider reports after the completion is learned once as a new
  version of the capture (its event `capture.completed.v1` with `previousStatus` COMPLETED), whose posting set carries only the
  fee lines; a fee that differs from a settlement statement opens FEE_MISMATCH.
- **FISCAL** (capture.completed, refund.completed; tax_document.validated / uncertain for B15): drafts the invoice / credit note
  (one live per capture / refund), resolves the treatment (`resolveFiscalTreatment`), validates or records the blocker; when a
  profile is re-reviewed, re-evaluates blocked drafts (`listBlockedDrafts`, `redraft`).
- **PAYMENT_SERVICE** (payment_attempt.dispatching / provider_pending / uncertain; refund.approved / uncertain): the watchdog
  and the refund executor (CMD033 with its own journal key derived from the refund and version).

### 8.2 Where the payment service runs

The service routes (CMD033, CMD034) and the application of provider events are routes of `apps/api` authenticated as service
identities (10 "Internal command authentication"), running their units of work on a second verified pool whose login is a
member of `kauro_payment` only (B06's pool verification refuses a login in two groups, so the process holds one login per
group); the webhook's ingress half uses the ingress pool (`kauro_ingress`, B06 PgInboxIngress), the agency and operator routes
the request-handler pool. The consumers run in the payment dispatcher: claims and settlements of outbox records through B06's
`PgOutboxDispatchStore` under `kauro_control` with a lease per consumer (B06 D-OUTBOX-1: "held by the dispatcher of the
consumer's package"), each effect in its own SERVICE unit of work under `kauro_payment` — delivery and effect are separate
transactions, so the consumers are idempotent (§8.1). The connection budget of an api instance with three pools is Q-B09-14.

### 8.3 Reads

GetQuote, GetPaymentOrder, GetRefund (agency, any role; AGENCY_HEADER) and GetRefundReview (operator; STORED_OPERATION): the
B06 read discipline (the access decision, the policies, a durable fact of a denial), projections by the closed views (§10).
`checkoutReady`/`checkoutBlockers`/`paymentStatus`/`nextActions` are derived at read time from durable facts and are never
authority (10 "A UI readiness flag is informative"); `paymentStatus` (D-PAY-B2): CHECKING while any effect is uncertain
(15 "We are checking this payment"; next actions REFRESH_STATUS / CONTACT_SUPPORT, never "pay again").

## 9. Events and outbox

47 event types (`COMMERCE_EVENT_TYPES`; seeded by 0008): one per reachable state of each versioned commerce aggregate
(`<kind>.<state>.v1`; a back edge publishes the type of its target state with `previousState`), 8 aggregate kinds (quote,
payment_order, payment_attempt, capture, commercial_authorization, refund, tax_document, reconciliation_case). Payloads follow
B06 D-EVT-2 — ids, hashes, tokens, non-negative integers, booleans; no provider identifiers, no label (the refund's reason stays
on its row), server reasons as tokens (`outcomeCode`, `failureCode`, `revocationCode`, `rejectionCode`, `detailCode`); the
allowlists are `COMMERCE_EVENT_PAYLOAD_ALLOWLIST`. Consumers: FINANCE, FISCAL, PAYMENT_SERVICE (this package), COMMISSIONS
(B10), EXECUTION_CONTROL (B08), NOTIFICATIONS; the subscriptions are `COMMERCE_EVENT_SUBSCRIPTIONS` (e.g. capture.completed →
FINANCE, FISCAL, COMMISSIONS; commercial_authorization.issued/revoked → EXECUTION_CONTROL, NOTIFICATIONS; refund.completed →
FINANCE, FISCAL, COMMISSIONS, NOTIFICATIONS; refund.approved/uncertain and the dispatched attempts → PAYMENT_SERVICE).
TRANSITIONS "Cross-aggregate finalization": one reconciled financial event, several separate idempotent effects.

## 10. API: routes, DTOs, schemas

Routes (10 "Quote and payment routes"; registry paths and names): the seven commands above and four reads —
`GET /api/v1/quotes/{quoteId}` (QuoteView), `GET /api/v1/payment-orders/{orderId}` (PaymentOrderDetailView),
`GET /api/v1/refunds/{refundId}` (RefundView), `GET /api/v1/operations/refunds/{refundId}` (RefundReviewView, KAURO_OWNER).

Response schemas (`commerce/response-schemas.ts`, D-RESP-B1) are B06 `ViewDefinition`s: a view that projects a registry
contract (Quote, PaymentOrder, CaptureFact, CommercialAuthorization, Refund, TaxDocument) takes each selected member from the
generated registry bundle and withholds every other with its reason — PaymentOrderView withholds `merchantRef` and
`idempotencyHash`; CaptureView `providerCaptureId`, `merchantRef`, `evidenceHash`; RefundView `providerRefundId`,
`authorizationHash`, `evidenceHash`; TaxDocumentView `fiscalProfileId`, `providerDocumentId`, `evidenceHash` —; platform members
use B06's field vocabulary; money is MoneyMinorUnits `^(0|[1-9][0-9]{0,15})$` (never a JSON number); every object is closed; no
forbidden member (`FORBIDDEN_RESPONSE_FIELDS`). COMPLETED envelopes (CMD028 201, CMD029 200, CMD030 200 `WebhookAck`, CMD031 201,
CMD032 200, CMD033 200, CMD034 200) and READ envelopes; CMD028, CMD029 and CMD033 also answer 202 with B06's
`AcceptedResponse` (operationId, state, statusPath, pollAfterSeconds = PENDING_POLL_AFTER_SECONDS). Request schemas are closed,
with the registry's field names exactly (proven against commands.json).

OpenAPI (D-API-B1): until served, the eleven operations are generated into `x-kauro-planned` of `apps/api/openapi.json` with
their request and response components, their outcome catalogues per status (`x-kauro-outcomes`), role, principal, runtime role,
scope, idempotency, step-up, external effect and cases; security `bearerAuth` (persons), `serviceAuth` (payment service), none
for the webhook (signature). `tools/openapi.mjs check` refuses a planned route that is registered or also documented as served, a
duplicate operationId and a forbidden member (`tools/test/openapi.test.mjs` "B09: …").

## 11. The scenario cases

- **S057** browser success without a server capture → no authority: CMD029 compares the echo only; authority comes only from an
  authenticated capture that alone pays the obligation (KP004); the order view says PENDING/CHECKING, never paid.
- **S058** wrong amount / currency / payee / environment / signature → no authorization; reconcile or raise the incident: bad
  signature stores nothing; wrong payee/currency/environment cannot be the order's capture (composite key) and is an exception;
  a wrong amount is a real capture recorded with its allocation, never authority, AMOUNT_MISMATCH case (+ refund request).
- **S059** reversal before local capture observation or after delivery → reconcile the real order, phase-specific restriction, no
  second charge: a fact born REVERSED allocates and posts (D-PAY-B5); a reversal revokes with PRE_EXECUTION / DURING_EXECUTION /
  POST_DELIVERY (KP006, phase trigger); the order stays CAPTURED (never charged again); delivered history stays.
- **S060** a price-valid quote after source deletion → checkout blocked; identical reupload needs a new revision and approval:
  SOURCE_EXPIRED in CMD028/CMD029; the authorization requires the quoted revision SEALED (KP004); a new revision changes the
  revision hash, so the quote (bound to the plan's source) cannot be reused — a new plan approval and quote (B07/B08/B10).
- **R2-077** 129500 at 2500 bps → discount 32375, service 97125: `discountCents`, `kauro.round_half_up_bps`, the quote CHECKs.
- **R2-078** fee 5275, net 91850 (illustration; actual fees replace it): `illustrativeProcessorFee` for the illustration; the
  ledger posts only the provider-reported fee (`providerFeePostings`).
- **R2-081** one-cent refund sequence → cumulative entitlement reaches exactly zero: `cumulativeEntitlement` /
  `entitlementAdjustment` from the remaining service basis (`serviceBasisAfterCents` in refund.completed.v1); the commission
  ledger itself is B10's.
- **R2-128** fiscal boundary: `resolveFiscalTreatment` receives no currency, country or email; an unreviewed profile blocks the
  draft (and quoting), the capture reconciles regardless.
- **R2-140** two actual captures for one obligation: both recorded (unique identities), the second allocated entirely as excess
  (KP002 refuses otherwise), one authorization, an EXCESS_CAPTURE refund request, the commission basis capped to the obligation
  (only allocated service counts).

## 12. Decisions register

| id | decision | authority / rationale |
|---|---|---|
| D-CTX-B1 | The payment service is a SERVICE context on a new runtime group `kauro_payment`, adopting one agency per unit of work; column-scoped reads of B06 prerequisites | 08 "a service account has only its technical role"; COMMAND_CATALOGUE service commands "with scope derived from the stored operation"; 14 "runtime service identities have only required database roles". Reusing `kauro_control` would give the service cross-tenant operational rights it must not have |
| D-CTX-B2 | The corporate operator is an OPERATOR context on `kauro_app` with its user bound and a finance scope (`kauro.finance_agency_id`) admitted only while its KAURO_OWNER grant is ACTIVE; no B06 table keys on it | 08 "Corporate operators … individually managed corporate identities", "Private Owner has no automatic customer-record bypass", "Finance capability and customer-data support access are separate" |
| D-SCOPE-B1 | The scope index `commerce_scopes` maps stored operations and provider identities to their agency; append-only; adoption once per unit of work | COMMAND_CATALOGUE "Shared execution contract"; 10 "does not trust the agency ID in a provider payload without matching the stored order"; PaymentOrder "order identity cannot migrate between tenants" |
| D-CORP-B1 | Corporate roles are grants in `corporate_roles`, read by the database for every finance-scoped row and every review; never a token claim | 08 "Identity is not permission"; B06 §6.2 left corporate roles denied by default for their packages |
| D-AUTHZ-B1 | Agency commands use the B06 authorizer (AGENCY_BILLING = OWNER or BILLING membership; reads any role) | B06 §6.2 role model; registry roles |
| D-AUTHZ-B2 | Segregation: the requester of a refund cannot review it (KP008) | 08 high-impact actions; 15 "It is not itself permission" — silence on segregation, decided for the owner's protection; Q-B09-12 |
| D-AUTHZ-B3 | Service roles are a code-owned table (payment-service → PAYMENT_SERVICE, provider-ingress → AUTHENTICATED_PROVIDER, fiscal-service → FISCAL_SERVICE) checked with the environment | 10 "Internal command authentication": issuer, audience, expected service identity and environment |
| D-IDEM-B1 | Idempotency: the B06 command journal for CMD028/029/031–034; the provider inbox identity (provider, environment, event id) for CMD030 | 10 "Idempotency contract"; 15 "deduplicates by provider, environment and event ID"; 07 inbox identity |
| D-IDEM-B2 | An operator's journal entry is identity-owned (agency NULL), keyed by the operator | 10 identity "authenticated subject … agency"; the finance scope never binds `kauro.agency_id` |
| D-JOURNAL-B1 | A provider command whose outcome is unknown leaves its journal entry UNCERTAIN and answers 202; the resume commits it (the B06 guard admits the path; the adapter gains `markUncertain` and commit-from-UNCERTAIN) | 10 "The API indicates whether the operation is pending, rejected or uncertain"; registry RequestJournal "ambiguity is an explicit state" |
| D-ING-B1 | The payment service is the consumer of payment providers' inbox records (settles them in the transaction that applies them); the ingress stays B06's `kauro_ingress` | 07 "Consumers deduplicate by their own durable inbox identity and verify state before an effect"; B06 D-ING-1/2 |
| D-ING-B2 | A verified event no order can take is a platform exception for the owner's review; the provider is answered 200 with its disposition | 15 "Wrong payee/currency/order … rejects" (CMD030) and "record mismatch incidents"; a provider must not retry forever a correctly received event |
| D-PROTO-B1 | Provider effects run as intent (T1) / claim (T2) / call / settle (T3) | 07 "No database transaction remains open across … payment API calls"; 10 "The first accepted request records its intent before external dispatch" |
| D-PROTO-B2 | An ambiguous effect answers 202 with the durable operation; the same key resumes and converges | 10 "Long work returns 202 …"; "An ambiguous external effect requires reconciliation, not blind retry" |
| D-PROTO-B3 | A logical operation has at most three attempts; a later attempt only after a proved no-effect, with a new provider request identity | registry PaymentAttempt proved_no_effect "Allow a new deliberate attempt under policy, not a blind exception retry"; 15 "Its requests are bounded"; the bound is a decision (3) |
| D-PROTO-B4 | Every dispatched attempt carries a deadline; a watchdog reconciles past it | 15 "The periodic reconciler checks uncertain orders, captures, refunds"; registry PaymentAttempt observation_lost |
| D-INIT-B1 | A provider capture is born in the status its first authenticated observation shows: the initial state or one listed edge from it (`enforce_observed_birth`) | 07 "Provider webhooks can arrive … out of order"; 15 "Events may arrive before the browser returns"; B06 D-INIT-1 refuses skipped edges — a first observation of COMPLETED is not a skipped decision but a late observation |
| D-MACH-B1..B10 | The ten platform machines of §4.6 | the registry contracts carry states without machines (Quote states named by 07; PaymentOrder, CaptureFact, Refund contracts); platform records need guarded lifecycles; declared like B06 D-AGG-1/2 |
| D-EVT-B1 | Aggregate kinds are a migration-owned registry; the event binding reads it dynamically with identifiers from that table only | every package adds aggregates; editing B06's CASE per package would fork it; 08 "Dynamic SQL based on customer input is prohibited" (the identifiers are not customer input) |
| D-FACT-B1 | Security facts of the payment service and the ingress: no agency, actor SERVICE or ANONYMOUS, action CMD030 for the ingress | 08 "Threat model and assets": "Every boundary has a schema, identity, authorization predicate, replay behavior and audit event" (provider webhook to inbox is one); B06 streams unchanged |
| D-MONEY-B1 | BIGINT minor units within 0..2^53−1; arithmetic CHECKs in numeric; one rounding primitive floor((B×r+5000)/10000) | 07 "Money uses BIGINT minor units"; reference/HASHING "Exact money"; 15 "Round once at the named monetary boundary" |
| D-QUOTE-B1 | B09 stores and re-checks quotes; issuance (CMD027) is B10's; the terms preimage names the issuer | registry cases CMD027-* are B10's; 16 "Quote calculation": "The quote records pricing version, quantity evidence, discount facts, tax profile, legal issuer, source/plan/target hashes, expiry and dataAvailableUntil. It is immutable once issued" |
| D-QUOTE-B2 | The eligibility snapshot's shape is enforced here; qualification is B10's | registry PriceEligibilitySnapshot; 16 "Recurrence decision" |
| D-QUOTE-B3 | One live quote per project; a new quote supersedes the previous before it is created | 07 "A changed price, quantity, discount or tax creates a new quote"; 16 "Quote calculation": "A material correction creates a superseding quote with a visible comparison" |
| D-QUOTE-B4 | A quote leaves ACCEPTED_FOR_CHECKOUT only with no capture completed, in flight or uncertain | Quote machine guards (D-MACH-B1); 16 "Founding incentive" |
| D-PAY-B1 | Capture allocation: min(amount, owed) to the obligation, split cumulatively; the database caps it (KP002) | 15 "Summed allocations must equal the total"; R2-140 "cap commission basis to the service obligation" |
| D-PAY-B2 | The agency's payment status is derived: NOT_STARTED, PENDING, CONFIRMED, FAILED, CHECKING | 15 "Payment state transitions" customer copy |
| D-PAY-B3 | Every applied observation is history with its effect; facts move only forward | 15 "adds facts monotonically"; 07 "An old event may add historical evidence without rolling current state backward" |
| D-PAY-B4 | The browser's `providerApprovalRef` is compared with the stored order, never evidence | CMD029 failure "Browser success … cannot create CommercialAuthorization"; S057 |
| D-PAY-B5 | A capture first seen REVERSED was completed at the provider: it is allocated and posted, then reversed | S059 "reversal arrives out of order before local capture observation"; the money moved twice |
| D-AUTH-B1 | Authorization issuance is re-checked by the database under the transition locks (KP004) | 07 "CommercialAuthorization"; S057, S058, S060 |
| D-AUTH-B2 | A reversal revokes the live authorization in the same transaction with the phase it leaves (KP006) | 07 "Payment reversal before execution prevents launch …"; 15 "Disputes and chargebacks" |
| D-AUTH-B3 | A capture completed after price expiry is honored when source, target, approval, capability and the quoted reviewed tax rule still bind (`honored_after_price_expiry`); otherwise a remedy refund | 15 "Price and source expiry races" ("honors the same price only when source, target, legal treatment and delivery scope remain valid"); M2 adds the tax-rule check to `authorizationBlockers` for this case |
| D-REF-B1 | Origins CUSTOMER_REQUEST, EXCESS_CAPTURE, KAURO_REMEDY; one REQUESTED per capture | 15 "Refund policy and calculation"; R2-140 excess obligation |
| D-REF-B2 | CMD032's serviceCents/taxCents approve the service and tax; an excess return approves the recorded excess with zero service and tax | registry CMD032 fields name the service/tax split; an excess is neither |
| D-REF-B3 | The commitment ceiling per component under a per-capture exclusive lock, READ COMMITTED (KP003, KP009) | 15 "Concurrent refund requests serialize that invariant" |
| D-REF-B4 | A standing policy applies only when ACTIVE, valid, for the origin, the current phase and the scope (FULL_REMAINING / EXCESS_ONLY / BOUNDED); otherwise a fresh step-up | CMD032 failure "a standing authorized policy must be referenced rather than invented"; 08 step-up for significant refunds |
| D-REF-B5 | A completed refund that leaves no service basis revokes the authorization in the same transaction (KP006) | CommercialAuthorization authority_revoked guard "Reversal or full service refund" |
| D-FISC-B1 | Reviewed fiscal profile versions; unreviewed treatments block quotes and fiscal drafts; validation re-checked by the database (KP011) | 15 "FiscalProfile"; R2-082; R2-128 |
| D-FISC-B2 | A credit note is required exactly when service or tax is refunded | 15 "Refunds … create the legally appropriate credit/debit document"; an excess is not a sale |
| D-FISC-B3 | Corrections keep lineage: a corrected draft names its predecessor; an issued document is corrected by an issued correction | registry TaxDocument corrected_draft_version, lawful_credit_or_correction_issued; 15 "Original issued facts are not overwritten" |
| D-LEDGER-B1 | Posting sets sourced by one event or settlement; idempotent by source; balanced per currency at commit; append-only; reversals mirror | 15 "Operational ledger"; reference/HASHING "Ledger posting and reconciliation" |
| D-LEDGER-B2 | Accounts OPS-1; a capture is contract liability; the actual reported fee is posted, never the illustration | 15 "Revenue recognition…", "actual statement fees replace the illustration" (R2-078) |
| D-LEDGER-B3 | Settlement postings are platform-level and B15's | R2-085 in B15 |
| D-SETTLE-B1 | Bank-available cash requires bank evidence and cannot exceed withdrawals | 15 "Settlement and withdrawal"; CMD034 failure |
| D-ROUTE-B1 | Merchant and fiscal issuer routes are configuration records qualified with evidence | 15 "Merchant identity and environment are fixed by server configuration"; "Accounting integration decision"; R2-083 |
| D-RPOL-B1 | Standing refund policies are versioned, step-up-authorized records with explicit applicability | CMD032 failure text |
| D-FAKE-B1 | Contract fakes are labelled CONTRACT_FAKE in code and evidence; a fake route can never be LIVE | the task's rule; 21 "Evidence classes" |
| D-BIND-B1 | Binding UNIQUE targets added to B06 tables | 07 "Composite foreign keys … prevent a project … from referencing another agency's revision, quote, package or client" |
| D-TX-B1 | New transition subjects and the global lock order of §6.2 | B06 D-TX-2 extended |
| D-RESP-B1 | B09 views derived under B06 D-RESP-1 with provider identifiers and evidence withheld | 10 "Read endpoints return safe projections"; "Raw sensitive provider responses stay in a restricted reconciliation store" |
| D-OUT-B1 | Route catalogues composed from B06 fragments plus B09 access and command outcomes | B06 D-OUT-1 |
| D-API-B1 | Designed routes are documented as planned operations until served | 10 "OpenAPI is generated from the owning contract registry and checked against actual routes" — a planned route is not an actual route |
| D-CONS-B1 | FINANCE, FISCAL, PAYMENT_SERVICE consumers in the payment service, idempotent by source identity and uniqueness | 07 "Outbox, inbox and event ordering" |
| D-LABEL-B1 | The refund reason is a label: stored and answered, covered by the authorization digest, never in an event | B06 D-API-1, D-LABEL-1 |

## 13. Open questions for the authority

- **Q-B09-1** TaxDocument states: manual 15 "TaxDocument state machine" names DRAFT, READY_TO_ISSUE, DISPATCHING,
  PROVIDER_PENDING, ACCEPTED, ACCEPTED_WITH_OBSERVATIONS, REJECTED, CORRECTION_REQUIRED, VOIDED_BY_VALID_CORRECTION; the registry
  contract and machine name DRAFT, VALIDATED, SUBMITTING, UNCERTAIN, ISSUED, REJECTED, CORRECTED. B09 follows the registry (contract
  and machine agree, and the machine is what the acceptance cases use). ACCEPTED_WITH_OBSERVATIONS has no registry equivalent.
- **Q-B09-2** The registry Refund contract lists `serviceCents`, `taxCents`, `authorizationHash` as required while a request has
  no approval: B09 keeps the proposal and the approved intent apart and the DTO says which basis it shows (`amountsBasis`).
- **Q-B09-3** No registry command exists for: recording a reviewed fiscal profile version, rejecting a refund, creating or
  retiring a standing refund policy, resolving a reconciliation case, qualifying or suspending a route, granting or revoking a
  corporate role. B09 provides the schema, machines, guards and ports; the matrix assigns them to B12 (owner application), B15
  and B16. Should they be catalogue commands?
- **Q-B09-4** The webhook freshness window has no policy value (proposal: 300 s, a deployment setting of the verifier).
- **Q-B09-5** PaymentAttempt.operation WITHDRAW has no order; B09 refuses it and leaves merchant withdrawals to B15's settlement
  design.
- **Q-B09-6** CMD035's runtime identity (FISCAL_SERVICE): B09's drafter runs as `kauro_payment`; B15 decides whether issuance
  shares it or gets its own group.
- **Q-B09-7** Partial reversals (a partial chargeback) have no representation in CaptureFact (REVERSED is whole).
- **Q-B09-8** The fiscal treatment of a chargeback (credit note or not) is the accountant's decision; B09 posts the ledger reversal
  only.
- **Q-B09-9** B06's owner table assigns CostGrant `actual_authorization_and_funding` to B09; nothing in B09's scope funds cost
  grants. Proposed owner: B03 (grants) with the owner's funding evidence of B12.
- **Q-B09-10** `evidenceRef` of CMD031 names an evidence artifact of the agency's scope whose store is another package's (support
  or upload); B09 stores the reference opaquely.
- **Q-B09-11** Honoring a capture completed after price expiry when the reviewed tax rule changed in between (D-AUTH-B3 treats it
  as not honorable: remedy refund and new quote).
- **Q-B09-12** Segregation of duties for refunds (D-AUTHZ-B2) is a decision, not an authority statement; a single-owner company
  may need an exception path.
- **Q-B09-13** Integration with B07: both packages number from 0008; B09 turns `domain_events.aggregate_kind` into a registry
  (B07 adds its kinds as rows of `kauro.aggregate_kinds` instead of editing a CHECK). The integrator renumbers.
- **Q-B09-14** 07 "Connection budget and operating limits" allots the api four connections per instance; serving the payment
  service's routes and the webhook ingress adds a `kauro_payment` and a `kauro_ingress` pool (§8.2). The budget must be
  recalculated (a material capacity change, 07), or the service surface moved to its own entrypoint.

## 14. Implementation mandates and verification

Three parallel mandates from this branch (details in the structured handoff), separated by the ports fixed here: **M1
persistence** — the `pg` adapters of every commerce port, the commerce unit of work (adoptScope, adoptFinanceScope, finance
binding), the journal's UNCERTAIN path, the harness fixtures, the B06 inspectors' commercial queries; **M2 domain services and
authorization** — `CommerceAuthorizer`, `CommerceReconciler` (§6.3) and the three `CommerceEventConsumer`s (FINANCE, FISCAL,
PAYMENT_SERVICE), the fiscal treatment and ledger flows, D-AUTH-B3; **M3 application and api** — the seven handlers on the
provider-effect runtime (calling the reconciler and authorizer ports), the reads, the webhook ingress route, the labelled
contract fakes, serving the routes (OpenAPI `paths`, matrix served sections, applicability rows) and the command-level case
tests of the case map. Each codes against the ports of this branch; the database-backed tests of M2 and M3 run on the
integration of M1 (the integrator merges M1, then M2, then M3, as B06 did).

Verification of this branch: `pnpm run verify` (generate, build, typecheck, test, arch, openapi, matrix, clean-consume) green;
the persistence suite applies 0001..0012 from empty on PostgreSQL 17 in every test file and runs the 16 B09 schema tests and
every B06 test; no temporary cluster is left running.
