# B09 — Payments and fiscal workflow: design

Branch `b09/design`, based on `main` at `ac44af6` (B05 monorepo and contracts, the final B06 domain, database and authorization,
and the foundation's shared aggregate-kind registry, migration 0008, `docs/design/FOUNDATION-aggregate-kinds.md`). Package B09 of
the build program (registry `program.json`: "Implement quotes, provider intents, capture reconciliation, CommercialAuthorization,
refunds, settlement and fiscal-document adapter/bridge. Use exact minor-unit arithmetic, provider uncertainty states and immutable
documents. Do not mark screenshots or redirects as payment. Preserve tax-profile unknowns as blockers."). Gates G-PAYMENT and
G-FISCAL_LOCAL; owning manuals 07, 10, 15, 16, 19; contracts, commands and cases from the vendored R2 registry under
`packages/contracts/registry` (provenance-checked). Thirty cases: S057–S060, R2-077, R2-078, R2-081, R2-128, R2-140 and the triads
of CMD028–CMD034 (`node tools/package-brief.mjs B09`); the case map is `docs/design/B09-case-map.md`.

This revision applies the adversarial review of the design (findings B09-F1..B09-F17, `.claude/b07-b09-design-review/critic_B09.json`;
every finding's disposition is §16 "Critique record") on the new base, and adds §15 "Integration obligations" for the merge with the
source lifecycle (B07), whose design is read from `b07/design` (never edited here).

Everything here is quoted from the authority (manual and section named, e.g. 15 "Capture and authority"; `reference/` files by
name; B06 decisions as "B06 D-…"; the foundation's as "FOUNDATION D-AGGK-…") or is a recorded decision of this package (`D-…-B…`,
register §12) with its rationale. Where the authority is silent or contradicts itself, the decision says so and §13 lists the
question to return to the authority. English only; the brand is Kauro (amendment A2) — the vendored registry stays byte-identical,
and the owner role it names under the pre-A2 brand is written KAURO_OWNER everywhere this package names it.

| delivered on this branch | left to the implementation mandates (§14) |
|---|---|
| `packages/persistence/migrations/0009..0013`: roles, tables, composite keys, state machines, triggers, RLS and grants of the whole workflow, the B09 rows of the shared aggregate-kind registry, applied from empty by the B06 runner and tested on PostgreSQL 17 (`test/b09-migrations.test.ts`, 16 tests; `test/b09-critique.test.ts`, 14 tests reproducing every probe of the review; the B06 and foundation suites extended where they enumerate runtime roles, event inserters or migrations) | the `pg` adapters of the commerce ports, the commerce unit of work, the journal's UNCERTAIN path (M1) |
| `@kauro/domain` commerce model: records, money and pricing arithmetic, fiscal treatment (the profile in force at a tax point), capture allocation, refund arithmetic and authority (the cumulative tax rule), the quote's release and re-binding predicates, ledger postings, provider vocabulary, principals, the ten platform machines, the event vocabulary, failure reasons, repository ports | the commerce authorizer, the reconciler, the re-binder, the consumers FINANCE / FISCAL / PAYMENT_SERVICE (M2) |
| `@kauro/application` commerce contracts: the seven command specs (with the settle step's runtime role), closed request schemas, closed response schemas and DTO views, outcome catalogues, provider / fiscal / evidence / service ports, the platform ports of B07 and B08 (source availability and lineage, delivery capacity), the provider-effect protocol types (T1..T4) | the seven handlers, the provider-command runtime, the routes and the webhook ingress, the labelled contract fakes (M3) |
| the generated OpenAPI document documents the eleven B09 operations as `x-kauro-planned`; the generated matrix owns every edge of the twelve B09 machines | serving the routes moves them into `paths` and into the matrix's served sections (M3) |

## 1. Scope and boundaries

In scope (the registry's B09 cases and the manuals' B09 obligations): the stored quote and its eligibility snapshot (the
issuance command CMD027 CreateQuote is the recurrence package's, B10, whose cases CMD027-* it owns; B09 stores and re-checks
what it issues, D-QUOTE-B1); checkout (CMD028); capture (CMD029); the provider ingress and its application (CMD030); refund
request, review and execution (CMD031–CMD033); reconciliation (CMD034); CommercialAuthorization issuance and revocation and the
re-binding of a paid capture under the included source replacement (D-QUOTE-B6); the fiscal profile, the fiscal document draft and
validation and the fiscal adapter/bridge port; the operational ledger; settlement observations; the reconciliation cases and
provider event exceptions.

Out of scope, with the owner the registry names: issuing a quote, first/repeat designation, founding slots, commission and the
replacement allowance's commercial decision (B10: CMD027, R2-080, R2-092, R2-093, R2-137); consuming an authorization, capacity
admission and publishing a package (B08: CMD036, delivery); the source lifecycle, its lineage and retention records (B07); fiscal
issuance (CMD035, the real integration package B15, with R2-082..R2-085); the dispute workflow (deadlines, evidence, response;
B15, D-DISPUTE-B1); real provider, OIDC, storage and fiscal integrations (B15); the agency, seller and owner applications (B11, B12).
Every provider and fiscal effect of B09 is reached through a port (§5); until B15 binds the real adapters, tests bind
contract-faithful fakes labelled `CONTRACT_FAKE` in code and evidence (D-FAKE-B1), never counted as integration (21 "Evidence
classes"). The platform components B09 meets at integration (B07's source availability and lineage, B08's capacity) are reached
through ports with a labelled contract fake until their package is on main (§15).

## 2. The B06 foundation, extended — never forked

B09 runs on B06's mechanisms and the foundation's registry unchanged and extends them only where a new principal or aggregate
needs it.

| B06 mechanism | how B09 uses it | extension (additive, named) |
|---|---|---|
| unit of work (`SET LOCAL` context, verified pools, one runtime group per login; B06 D-CTX-1) | every commerce write runs in a `PgUnitOfWork`; the commerce unit of work is the same transaction with the commerce repositories (`CommerceUnitOfWork extends UnitOfWork`) | contexts SERVICE (runs under the new group `kauro_payment`) and OPERATOR (runs under `kauro_app`, binds its user and a finance scope); `bindContext` clears `kauro.finance_agency_id` on every transaction (D-CTX-B1, D-CTX-B2) |
| runtime roles `kauro_app`, `kauro_control`, `kauro_assurance`, `kauro_validator`, `kauro_ingress` | the agency's intents under `kauro_app`; the ingress half of the webhook under `kauro_ingress` (B06 D-ING-1, PgInboxIngress); platform configuration under `kauro_control` | one new group `kauro_payment` (the payment service), created by 0009 with the same NOSUPERUSER/NOBYPASSRLS checks; `RUNTIME_ROLES` lists it; it is the only writer of provider-observed facts and entitlements (D-AUTH-B4) |
| pipeline authenticate → access decision → journal reserve/replay → assurance → execute (B06 D-PIPE-1) | unchanged order for every command, including the provider-effect protocol's T1 (§6.1) | the commerce authorizer for the principals B06 denies by default (operator, service, provider) (§3.4) |
| command journal (B06 D-IDEM-1..3) | idempotency of CMD028, CMD029, CMD031–CMD034; the orders, attempts and refunds name their journal entry (`intent_entry_id`) for resume | a provider effect of unknown outcome leaves the entry UNCERTAIN (the B06 guard admits RESERVED → UNCERTAIN → COMMITTED; the adapter gains the path, D-JOURNAL-B1); the journal is completed by the command's own principal in T4 after the payment service settled T3 (D-PROTO-B5); an operator's entry is identity-owned (`agency_id` NULL, D-IDEM-B2) |
| outbox, inbox, D-ING locks (B06 D-OUTBOX-1, D-ING-1/2) | every commerce event has its outbox rows; the provider inbox dedupes webhook deliveries by provider, environment and event id | the payment service is the consumer of payment providers' inbox records (KA012, KA007, READ COMMITTED); an observation no order can take becomes a provider event exception from any source (D-ING-B1..B3) |
| security facts (agency / identity / anonymous streams, B06 D-FACT-1) | operator facts go to the operator's identity stream with `requested_agency_id`; agency commands to the agency stream | the payment service's and the ingress's own facts: `agency_id` NULL, actor SERVICE, or ANONYMOUS for an unverified delivery (D-FACT-B1) |
| registry guards: `state_machines`, `state_transitions`, `enforce_initial_state`, `enforce_listed_transition` (B06 D-INIT-1) | every B09 table with a state seeds its machine and guards birth and edges | `_of` variants for a state column not named `state`; `enforce_observed_birth` for a provider fact (D-INIT-B1) |
| event-per-version, the foundation's registry `kauro.aggregate_kinds` and table-driven binding (FOUNDATION D-AGGK-1..5) | every versioned commerce aggregate: its kind is one INSERT in the migration that creates its table (quote 0010; payment_order, payment_attempt, capture, commercial_authorization 0011; refund, reconciliation_case 0012; tax_document 0013) | `kauro_payment` reads the registry through its own policy `aggregate_kinds_read_b09_payment` (FOUNDATION §4); no edit of 0008, of the foreign key or of the binding (D-EVT-B1) |
| composite foreign keys, scoped uniqueness (08 "Database isolation") | every commerce row carries `agency_id` and names its parents with `agency_id` in the key | binding UNIQUE targets added to B06 tables (plans, projects, approvals, command_journal, inbox_records, domain_events) so copies of a subject are the original's (D-BIND-B1) |
| transition locks (B06 D-TX-2) | commerce commands read agency, capability, source, target under B06's transition locks | new transition subjects: quotes, capture facts, commercial authorizations, fiscal profiles, fiscal issuers, payment routes, corporate grants, and the withdrawal of an approval (D-TX-B1) |
| closed response schemas validated at runtime, registry-derived views (B06 D-RESP-1), outcome catalogues (B06 D-OUT-1), error contract (B06 D-API-1, D-LABEL-1) | B09 views are `ViewDefinition`s compiled by `viewSchemaOf`, refusing forbidden members and open objects; catalogues compose `ROUTE_OUTCOME_FRAGMENTS` | the KP SQLSTATE class and 49 commerce failure reasons (§7) |
| generated OpenAPI and matrix (`tools/openapi.mjs`, `tools/matrix.mjs`, both in `pnpm run verify`) | the B09 machines' edges are owned; the B09 routes are generated | `x-kauro-planned` operations until served (with `x-kauro-settle-runtime-role`); the checks refuse a planned route that is registered or also served (D-API-B1) |
| test helpers `@kauro/persistence/testing` | the harness and its fixtures | a `kauro_payment_test` login, the payment pool and factory, `service()` and `operator()` contexts; commerce fixtures in `test/commerce-support.ts` (T1/T2 by the request handlers, T3 by the payment service) |

B06 objects B09 alters (all additive; the B06 and foundation suites run unchanged except where they enumerated migrations, roles,
machines, the guard triggers' names — now also their `_of` and observed-birth forms —, the event inserters that read the registry
(the foundation's test 4, extended with `kauro_payment` as FOUNDATION §4 prescribes) or, in CMD010's DENY test, asserted that no
refund table exists — it now asserts that the refund tables hold no row): `domain_events` (new UNIQUE `(event_id, agency_id)`; the
partial unique index `domain_events_capture_completed_once`), `event_types` (49 rows, seeded under a transaction-local lifting of
FORCE RLS; FOUNDATION Q-AGGK-2), `aggregate_kinds` (eight rows and one read policy), `plans`, `projects`, `approvals`,
`command_journal`, `inbox_records` (UNIQUE binding targets), `approvals` (transition-lock trigger on `withdrawn_at`), and
policies/grants for `kauro_payment`, the finance scope and the ingress on `agencies`, `projects`, `plans`, `approvals`,
`dataset_revisions` (with `supersedes_revision_id`, the lineage a re-binding checks), `target_contracts`, `capabilities`,
`domain_events`, `outbox_records`, `command_journal`, `security_events`, `inbox_records`, `inbox_body_conflicts`. The reviewed
runtime-boundary matrix (`packages/persistence/test/fixtures/runtime-boundary.json`) was regenerated from the catalog: every
entry of `main` (B06 and the foundation) is byte-identical, the rest is B09's.

## 3. Principals, runtime roles and scope

### 3.1 The four principals

| principal | who | context (`@kauro/domain` ExecutionContext) | runtime group | settings bound | commands |
|---|---|---|---|---|---|
| agency member | a verified person with a live membership (AGENCY_BILLING for commands, any role for reads; B06 §6) | TENANT | `kauro_app` | `kauro.agency_id`, `kauro.user_id` | the intent (T1), claim (T2) and journal completion (T4) of CMD028 and CMD029; CMD031; GetQuote, GetPaymentOrder, GetRefund |
| corporate operator | an individually managed corporate identity with an ACTIVE `KAURO_OWNER` grant (08 "Corporate operators and sellers use individually managed corporate identities") | OPERATOR (D-CTX-B2) | `kauro_app` | `kauro.user_id`, and after adoption `kauro.finance_agency_id` | CMD032; GetRefundReview; resolving a case, recording a fiscal profile version (Q-B09-3) |
| payment service | a verified service identity `payment-service` (10 "Internal command authentication") | SERVICE (D-CTX-B1) | `kauro_payment` | after adoption `kauro.agency_id` | the settle step (T3) of CMD028, CMD029 and CMD033 (D-PROTO-B5); CMD033, CMD034; the application of CMD030; the re-binding of a paid capture (D-QUOTE-B6); the consumers FINANCE, FISCAL, PAYMENT_SERVICE |
| authenticated provider | a provider event whose signature, freshness and environment verify (CMD030 precondition) | none: the ingress records it | `kauro_ingress` (B06) | none | CMD030 (ingress half) |

08 "Identity is not permission" and "Role and capability model": a service account has only its technical role and cannot act
as a human owner; the Private Owner has no automatic customer-record bypass; finance capability and customer-data support access
are separate. Hence two separate principals: the payment service sees one agency's commerce rows and column-scoped commercial
prerequisites; the operator sees one agency's commerce rows while its grant is ACTIVE, and none of the agency's customer rows.

The role boundary of provider facts (D-AUTH-B4; review finding B09-F1): 08 "Threat model and assets" names a malicious agency
member and a forged webhook as threat actors; the registry's CaptureFact invariant is "Browser claims cannot produce a capture
fact"; 07 "Transaction discipline": "Application checks improve messages but cannot be the sole protection"; 14 "Identity matrix":
"Runtime service identities have only required database roles"; B06 R14/R30 keep step-up proofs to the verifier and receipts to
the validator. So the request handlers (`kauro_app`) write only the intent of a provider effect — an order born INTENT_CREATED with
nothing learned from the provider, a CREATE_ORDER or CAPTURE attempt born PREPARED, the claim edges (order INTENT_CREATED → CREATING,
CREATED | APPROVED → CAPTURING; attempt PREPARED → DISPATCHING) and the PAYMENT_ORDER and REFUND scope rows — and only the payment
service (`kauro_payment`) writes what a provider reported: a provider identity, an attempt's result, a capture fact, its funds and
fee, an observation, a case, a server-originated refund request, a provider scope key, the issuance and revocation of a
CommercialAuthorization. The database enforces it with policies and column grants (0011, 0012) and
`b09-critique.test.ts` "B09-F1: …" performs each forbidden write as `kauro_app_test` and sees it refused.

### 3.2 The payment service's scope (D-CTX-B1, D-SCOPE-B1, D-SCOPE-B2)

COMMAND_CATALOGUE "Shared execution contract": service commands require a verified service identity and audience, "with scope
derived from the stored operation". A SERVICE unit of work starts with no agency bound (every tenant policy matches nothing) and
adopts exactly one agency, once, through the scope index `kauro.commerce_scopes`: `(scope_kind, scope_key) → agency_id`, kinds
PAYMENT_ORDER and REFUND (keyed by the platform id) and PROVIDER_ORDER, PROVIDER_CAPTURE, PROVIDER_REFUND (keyed
`<provider>|<ENVIRONMENT>|<external id>`). Every row names its order, and its capture or refund by kind, by composite foreign keys
with the agency in the key; a platform key is the object's own id; a provider key must be the identity its object learned
(`commerce_scopes_bind_key`, D-SCOPE-B2). The request handlers record the platform rows of the operations they create, the payment
service the provider keys it learns and the refund rows it files; nobody updates or deletes a row; a provider identity maps to one
agency (PaymentOrder: "order identity cannot migrate between tenants"). `CommerceUnitOfWork.adoptScope(kind, key)` resolves and
binds (`kauro.agency_id` for SERVICE); an unknown key answers NOT_FOUND and nothing is adopted. Platform-level work (settlement
observations, unattributed provider event exceptions, the inbox records of payment providers) runs with no agency adopted.

What `kauro_payment` may read of B06 tables is column-scoped (0009): agencies (id, version, state), projects (ids, mode,
capability, state — never `purpose`), plans (ids, state, hashes, approval — never `body`), approvals (ids, hashes, created,
withdrawn), dataset revisions (ids, state, manifest hash, sealed, predecessor), target contracts (ids, mode, body hash, confirmed,
superseded), capabilities. It holds no privilege on identities, memberships, invitations, end clients, processing authorities,
receipts or corporate grants (proven in `b09-migrations.test.ts` "D-CTX-B1 …").

### 3.3 The operator's finance scope (D-CTX-B2, D-CORP-B1)

`kauro.corporate_roles` holds a person's grants of corporate roles (`KAURO_OWNER` only in B09; 0009), provisioned by the control
plane, read by a person only for itself, revoked under the grant's transition lock. `kauro.holds_corporate_role(role)` is
SECURITY INVOKER over the self policy, so it finds only the session's own grants; `kauro.in_finance_scope(agency)` is true when
the agency is the adopted `kauro.finance_agency_id` and the session holds an ACTIVE `KAURO_OWNER` grant. Every agency-scoped
commerce table has a finance policy on `kauro_app` keyed on it (read; and review writes where the operator acts: refunds under
review, fiscal profile versions, case resolution); of the B06 tables only `domain_events` and `outbox_records` do, and only for
the eight commerce aggregate kinds — none of the agency's customer rows. An OPERATOR adopts the finance scope through the scope
index (`adoptScope("REFUND", refundId)`, which reads REFUND rows only while the grant is ACTIVE) or, for a review not keyed by a
stored operation, `adoptFinanceScope(agencyId)` (no catalogue command of B09 uses it; Q-B09-3). The operator's journal rows,
events and facts: an identity-owned journal entry (agency NULL, B06 policy), events and outbox rows in the finance scope (0009
policies), security facts in its identity stream naming the agency as `requested_agency_id` (B06 policy).

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
tenant and finance policies, the role boundary of provider facts (D-AUTH-B4), the grant check of every finance-scoped row and of a
refund review (KP007), segregation (KP008), the standing-policy applicability (KP010), and the payment service's policies that
never admit an order insert or a refund review. Every denial is a durable security fact (B06 D-FACT-1, D-FACT-B1).

## 4. Aggregates and tables

Conventions of every table (07 "Database representation"): UUIDv7 server-generated ids (`kauro.is_uuid_v7`); money in BIGINT
minor units within `kauro.is_money` (0..2^53−1, the exactly representable JSON integer range, D-MONEY-B1); instants
`timestamptz`, and every duration constraint in exact hours or seconds, never in days (D-TIME-B1); versions `bigint` bumped by
exactly one with an event per version (`kauro.enforce_version_bump`, `kauro.require_event_for_version`); every tenant row carries
`agency_id`, parents are named with `agency_id` in the key; uniqueness includes the scope; FORCE ROW LEVEL SECURITY on every
table; `updated_at` by trigger; immutable columns by `kauro.forbid_column_change`; columns learned once (a provider id, a
decision) by `kauro.forbid_reassignment` (0009).

### 4.1 Platform configuration and reference data (0009, 0010)

| table | holds | key rules | writers / readers |
|---|---|---|---|
| `payment_routes` | the merchant route of a provider and environment (15 "Merchant identity and environment are fixed by server configuration"): merchant ref, payee digest (SHA-256 of the payee id), currency, integration class | machine PaymentRoute (CONFIGURED → QUALIFIED → SUSPENDED); QUALIFIED cites evidence and `valid_from`; one QUALIFIED per provider+environment; a `CONTRACT_FAKE` route is never LIVE; transition lock keyed provider+environment | control writes; app and payment read |
| `fiscal_issuers` | the contracting and invoicing entity and its issuance route (15 "Accounting integration decision"; 19 "BusinessProfile and legal facts" statuses) | machine FiscalIssuerRoute over `route_state`; QUALIFIED only with OBSERVED or PROFESSIONALLY_CONFIRMED facts, a numbering authorization, verified entitlement (R2-083) and evidence; one QUALIFIED per jurisdiction | control writes; app and payment read |
| `corporate_roles` | ACTIVE/REVOKED grants of `KAURO_OWNER` | machine CorporateGrant; one ACTIVE per person and role; transition lock keyed user | control writes; a person reads its own |
| `refund_policies` | standing refund policies (CMD032 "a standing authorized policy must be referenced rather than invented") | kind, version, scope FULL_REMAINING / EXCESS_ONLY / BOUNDED (+ceiling), phase, origin, conditions hash, the authorizing owner's own step-up proof (composite key to `assurance_proofs`), validity; machine RefundPolicy | control writes; app and payment read |
| `commerce_scopes` | the scope index (§3.2) | append-only; each row names its order, and its capture or refund (composite keys added by 0011 and 0012); a platform key is the object's id, a provider key the identity its object learned (D-SCOPE-B2) | the tenant records PAYMENT_ORDER and REFUND rows; the payment service REFUND and provider rows in its adopted agency and reads all; an owner reads REFUND rows |
| `price_policies` (0010) | the known price policies (D-QUOTE-B5): quote seconds, lookback seconds, founding rate, included pre-execution replacements, the unpaid source's hard cap from the seal | migration-owned rows mirrored from policy.pricing and policy.retention (R2-INITIAL only; the persistence test proves equality); append-only | migrations only; app and payment read |
| `aggregate_kinds` (foundation 0008) | the eight B09 kinds, one INSERT each in the migration that creates its table | FOUNDATION D-AGGK-2 checks each row against the catalog | migrations only; `kauro_payment` reads it through `aggregate_kinds_read_b09_payment` |

### 4.2 Fiscal profile, quote, eligibility snapshot (0010)

**fiscal_profiles** (registry FiscalProfile; 15 "FiscalProfile"; D-FISC-B1): one reviewed version per row — operator legal ref
(an issuer), customer legal ref, classification, territory, `tax_treatment` (REVIEW_REQUIRED, DOMESTIC_TAXABLE, EXEMPT_EXPORT,
OTHER_REVIEWED), `tax_rule` (UNRESOLVED, RATE_HALF_UP, ZERO_REVIEWED) and `tax_rate_bps`, evidence, reviewer, validity,
supersession. Rules: REVIEW_REQUIRED ⇔ UNRESOLVED with rate 0 (the explicit unknown carries no rule); DOMESTIC_TAXABLE is a
positive rate; EXEMPT_EXPORT is a reviewed zero that requires `export_evidence_hash` (R2-128: "The adapter cannot infer export
exemption from currency or foreign email"; 15: "A foreign customer's address alone does not establish …"); a reviewed treatment
names its reviewer; one current (unsuperseded) profile per agency; supersession once, under the agency's transition lock. A
version is *in force* at an instant when its validity window covers it and it had not been superseded by then (D-FISC-B4): a new
quote and a new draft read the current version; a document is validated against the version in force at its tax point (§4.5).
Written by the finance scope, the reviewer being the session's person; read by the agency, the finance scope and the payment
service.

**quotes** (registry Quote; platform machine Quote, D-MACH-B1; 16 "Quote calculation"; D-QUOTE-B1..B7): the immutable terms of
one purchase. Composite keys make every subject column the original's: the project and its mode; the plan of that project with
exactly its body, source and target hashes; the approval of that plan; the fiscal profile with exactly its issuer and reviewed
rule; the eligibility snapshot's applied rate, policy and evaluation instant (checked at COMMIT: the snapshot's `as_of` is the
quote's `issued_at`). The price policy and the discount policy are known policies (foreign keys to `price_policies`; B09-F10).
Arithmetic CHECKs, in numeric so nothing overflows: discount = `kauro.round_half_up_bps(base, bps)` = floor((B×r+5000)/10000)
(reference/HASHING_AND_ACCOUNTING_RULES "Exact money"); service = base − discount; tax by the reviewed rule (RATE_HALF_UP rounded
once, ZERO_REVIEWED zero); total = service + tax; under price policy R2-INITIAL the base is the registry band of the mode and units
(`kauro.r2_initial_base_cents`, proven band by band equal to the vendored policy), the discount one the policy can produce, and
`expires_at` exactly 336 hours (1,209,600 s) after issuance — an interval in hours, so a session TimeZone with a daylight-saving
change cannot move the boundary (B09-F12, D-TIME-B1). The promised source availability (`source_available_until`, 16 "The quote
records … expiry and dataAvailableUntil") lies after the issuance and no later than the price expiry (`quotes_source_window`; 07
"A fourteen-day price lifetime does not extend seven-day source retention"), and the quoted revision is SEALED, sealed no later
than the issuance, with the promise no later than the policy's hard cap from the seal (`quotes_source_binding`, B06 columns only);
the exact effective deadline comes from the source lifecycle through `SourceAvailabilityReader` (D-QUOTE-B7). An unreviewed
treatment can never be quoted (R2-082). One live quote per project; states DRAFT → ISSUED (issue_quote, CMD027 in the same
transaction) → ACCEPTED_FOR_CHECKOUT (CMD028) → EXPIRED / SUPERSEDED / WITHDRAWN. Leaving ACCEPTED_FOR_CHECKOUT (the release
guard, 0012; D-QUOTE-B4) is refused while any payment of it is in flight or uncertain, and otherwise admitted only when the
purchase is closed — no live entitlement and every completed capture paying it wholly refunded or reversed — or when its paid
capture was re-bound to exactly the replacement that supersedes it (D-QUOTE-B6). A *replacement quote* (`replaces_quote_id`)
carries exactly the replaced quote's commercial terms (composite key `quotes_replacement_terms_fk`: project, mode, policies, base,
discount, service, tax rule and amounts), is excluded from the one-live index until it is accepted, is never charged (no order may
name it) and is accepted only by the payment service's re-binding. Its state is a transition subject: CMD028, CMD029 and
authorization issuance read it after the shared lock. Tenant writes (CMD027 of B10 inserts and issues; CMD028 accepts a quote
that is not a replacement); the payment service moves a quote only inside a re-binding; finance and payment read.

**price_eligibility_snapshots** (registry PriceEligibilitySnapshot; 16 "Recurrence decision", "Founding incentive"; D-QUOTE-B2):
the facts the quote was priced with, append-only: a distinct set of other projects of the same agency (trigger), its count, the
tier of that count (R2-INITIAL: 0 / 500 / 1000 / 1500 bps), the founding rate (0 or 2500) with its slot, the applied rate =
greatest of the two (MAX_NOT_STACKED), the exact 8760-hour (365 duration days) lookback evaluated at the quote's own issuance
instant (reference/HASHING "Evaluate the 365-day lookback at one server issuance instant"), under a known policy. Which projects
qualify, and whether a founding slot exists, is B10's decision; B09 stores the shape.

### 4.3 Orders, attempts, observations, captures, authorizations, re-bindings (0011)

**payment_orders** (registry PaymentOrder; platform machine PaymentOrder, D-MACH-B2; 15 "PaymentOrder and intent"): the quote's
exact accepted amounts (composite key to the quote's terms hash, total, service, tax, currency, project and approval), through
the qualified route's merchant (composite key to the route's provider, environment, merchant, payee, currency), created by one
CMD028 journal entry (`intent_entry_id`, composite with the agency; unique). The provider order id and approval URL are learned
once; one open order per project (INTENT_CREATED … CAPTURE_UNCERTAIN); a provider order id is unique across the platform.
`allocated_cents` is the obligation paid by completed captures, written only by the capture allocation (trigger depth, KP002),
never above the obligation, never down (KP005), exempt from the version bump. The request handlers insert the order at
INTENT_CREATED (nothing learned, nothing allocated, never for a replacement quote) and take only the claim edges; the payment
service applies every provider result (D-AUTH-B4) and never inserts.

**payment_attempts** (registry PaymentAttempt, machine as vendored): one physical provider effect: operation CREATE_ORDER,
CAPTURE or REFUND (WITHDRAW is kept in the vocabulary and refused, Q-B09-5), ordinal 1..3 per logical operation, the exact
request hash, the provider request identity `kauro-<attemptId>` (CHECK: an attempt can only ever repeat its own request),
the dispatch deadline set once with DISPATCHING, evidence for PROVIDER_PENDING / CONFIRMED / FAILED_NO_EFFECT, an outcome token
for FAILED_NO_EFFECT / UNCERTAIN / CANCELLED_BEFORE_DISPATCH. One live and one CONFIRMED attempt per logical operation; ordinal
n > 1 only after attempt n−1 proved no effect (KA008, D-PROTO-B3). A REFUND attempt names its refund of the same order. The request
handlers insert CREATE_ORDER and CAPTURE attempts PREPARED and claim them (PREPARED → DISPATCHING); every result and every REFUND
attempt is the payment service's.

**provider_observations** (D-PAY-B3): every authenticated observation applied to an order (DISPATCH_RESPONSE, WEBHOOK with its
inbox record, PROVIDER_QUERY with its stored artifact) and its effect (ADVANCED, NO_CHANGE, STALE_IGNORED, DUPLICATE, MISMATCH,
UNRECOGNIZED); append-only; a webhook event and a query artifact apply once per subject; an UNRECOGNIZED status is recorded as
such (15 "Unknown provider statuses become UNRECOGNIZED_PROVIDER_STATE"). Written by the payment service only.

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
(15 "Summed allocations must equal the total"). `funds_state` UNKNOWN / HELD / AVAILABLE and `provider_fee_cents` are
provider-reported facts learned after the status: each change is a new version with an event of its own —
`capture.funds_observed.v1`, `capture.fee_observed.v1` (FINANCE only) — and `capture.completed.v1` is published exactly once per
capture (`domain_events_capture_completed_once`; D-EVT-B2, B09-F8, B09-F15). The status is a transition subject; a reversal
cannot commit while an authorization of the capture is live (KP006, deferred). Written by the payment service only.

**commercial_authorizations** (registry CommercialAuthorization; platform machine, D-MACH-B4; 07 "CommercialAuthorization"):
the one logical processing entitlement. Composite keys make it the quoted subject exactly (quote's project, plan, approval,
hashes, mode, units; the approval's hash; the project's capability and version; the capturing order and the quote that order
charged, `order_quote_id`; the capture of the order). It is the order's own quote's entitlement, or — re-bound — a replacement
quote's with the recorded re-binding (`rebinding_id`; CHECK: exactly one of the two). One per quote, one original per capture, one
per re-binding, one live per capture, one live per project. `commercial_authorizations_require_capture` (KP004), under the shared
transition locks of agency, capability, approval, source revision, target contract, quote and capture, in that order: the capture
is COMPLETED, its amount is exactly the order's, its allocation is exactly the order's service and tax with no excess; a re-bound
one's re-binding exists and the entitlement it replaces is already revoked; the quote is ACCEPTED_FOR_CHECKOUT; the approval is
live; the agency ACTIVE; the quoted source revision SEALED; the target contract confirmed and current; the capability offered
(S057, S058, S060). A revocation records the phase of the state it leaves (ACTIVE → PRE_EXECUTION, CONSUMED → DURING_EXECUTION,
DELIVERED → POST_DELIVERY; KA008 otherwise). Its state is a transition subject (B08's CMD036 reads it after the shared lock).
`honored_after_price_expiry` records a capture completed after the price expiry (D-AUTH-B3). The payment service issues and
revokes; consumption and delivery are B08's edges, granted by B08's migration (§15).

**purchase_rebindings** (D-QUOTE-B6; B09-F2): the recorded allocation of one paid capture from the quote it paid to a replacement
quote — the included pre-execution source replacement of 16 "Scope changes and credits" ("one pre-execution source replacement
after revalidation, provided no paid execution has started and the new scope stays in the same band") and
COMMERCIAL_LEDGER_WORKED_EXAMPLES §18 ("Record the replacement against the purchased entitlement; do not charge a new project by
default"). Columns: the capture and its order, the replaced quote and entitlement, the replacement quote, the allowance ordinal,
the reason, the source lifecycle's lineage evidence, the requesting member. The guard (KP013), under the replaced entitlement's
exclusive transition lock (ordered with B08's consumption), the capture's shared lock (ordered with a reversal) and its refund
commitment lock (ordered with an approval): the replaced entitlement is ACTIVE; the capture alone pays its purchase; no refund of
it awaits review or commits; the replaced quote is ACCEPTED_FOR_CHECKOUT and the replacement an ISSUED replacement of it; the
capture's re-bindings stay within `price_policies.pre_execution_replacements_included`; the replacement revision is SEALED and its
lineage (`dataset_revisions.supersedes_revision_id`, B06) reaches the replaced one. At COMMIT (KP013) the replaced entitlement is
REVOKED as SOURCE_REPLACED, the replaced quote SUPERSEDED by the replacement, the replacement ACCEPTED_FOR_CHECKOUT and its
entitlement issued under this re-binding. Append-only; the payment service writes it (one SERVICE unit of work, `PurchaseRebinder`).

### 4.4 Refunds, cases, exceptions, the quote's release (0012)

**refunds** (registry Refund; platform machine Refund, D-MACH-B5; 15 "Refund policy and calculation"): origin CUSTOMER_REQUEST
(CMD031: the requester's membership and identity, composite key), EXCESS_CAPTURE or KAURO_REMEDY (server-originated, no
requester). The request keeps what was asked: the reason (a registry `label`, constraint `refunds_reason_code_label` mapped to
the field `reasonCode`; never in an event, B06 D-API-1), the evidence reference, the terms hash (composite key to the order), the
delivery phase at request, the proposed components. The approval records the immutable intent: approved service, tax and excess
(an excess return carries only excess, D-REF-B2), the authority (the approver's own step-up proof — composite key to
`assurance_proofs` — or a standing policy), the authorization and effects hashes, whether a credit note is required (exactly
when service or tax is refunded, D-FISC-B2), the approver and instant — all set once. One REQUESTED refund per capture and origin
(`refunds_one_requested_per_origin`; D-REF-B1, B09-F3): the reconciler's EXCESS_CAPTURE and KAURO_REMEDY requests of one capture
and a customer request coexist, a server request is filed with INSERT … ON CONFLICT DO NOTHING against that index, so a repeated
filing is a no-op that can never roll back the capture fact it follows. The review (REQUESTED → APPROVED / REJECTED) passes
`refunds_review_authority`: the reviewer is the session's person with an ACTIVE KAURO_OWNER grant after its transition lock
(KP007), never the requester (KP008), and a cited standing policy is ACTIVE and valid at the approval instant, for this origin and
the capture's current delivery phase (read after the authorization's transition lock), within a BOUNDED ceiling (KP010). The
commitment ceiling `refunds_commitment_ceiling` (D-REF-B3): READ COMMITTED only (KP009); the shared capture lock (orders the
approval with a reversal); the exclusive per-capture commitment lock (approvals of one capture take turns); then, with a new
snapshot, the capture is COMPLETED and the committing refunds (APPROVED, SUBMITTING, UNCERTAIN, COMPLETED) plus this one stay
within the allocation per component (KP003), and the approved tax is exactly the tax the approved service releases under the
sale's reviewed rule, cumulatively (`kauro.refund_tax_remaining`; KP012; D-REF-B6, B09-F6). A completed refund that leaves the
capture no service basis cannot commit while the authorization is live (KP006, D-REF-B5). Tenant reads and requests; the finance
scope reads and reviews a REQUESTED refund only; the payment service files server-originated requests and executes approved
refunds, never reviews one.

**The quote's release guard** (`kauro.quotes_release_guard`, D-QUOTE-B4; B09-F2) lives here because it reads refunds and
re-bindings: §4.2.

**reconciliation_cases** (platform machine ReconciliationCase, D-MACH-B6; 15 "Operational ledger": "Unexplained differences
create a case with amount and age"; 15 "Webhooks and reconciliation": "Exhausting retries leaves a visible case"): kinds
AMOUNT_MISMATCH, EXCESS_CAPTURE, CAPTURE_WITHOUT_VALID_SUBJECT, UNCERTAIN_EFFECT, UNRECOGNIZED_PROVIDER_STATE,
PROVIDER_INCONSISTENCY, REVERSAL, FEE_MISMATCH (opened by B15's settlement comparison), DISPUTE_OPEN (a dispute in progress with
its capture and disputed amount; D-DISPUTE-B1); a detail token, amount and currency, evidence; one OPEN case per kind and subject
(a repeated observation adds history, never a second case); opened by the payment service only; resolution recorded once by the
finance scope, whose event is the source of a correcting ledger posting set (D-LEDGER-B4).

**provider_event_exceptions** (D-ING-B2, D-ING-B3; B09-F9): an authenticated observation no order can take —
UNKNOWN_PROVIDER_REFERENCE, WRONG_PROVIDER, WRONG_ORDER, WRONG_PAYEE, WRONG_CURRENCY, WRONG_ENVIRONMENT (every CaptureMismatch of
the domain), UNRECOGNIZED_PROVIDER_STATE, BODY_CONFLICT — kept for the owner's review. Its source is exactly one of a delivered
webhook (its inbox record, composite key to its provider and environment; unattributed when it names no known order), a dispatch
response of a stored operation (its attempt) or a stored provider query (its artifact); the latter two are attributed to the stored
operation's order and agency. One per source and kind; append-only. No money, no commission, no authority follows from it.

### 4.5 Fiscal documents, ledger, settlements (0013)

**tax_documents** (registry TaxDocument, machine as vendored; 15 "TaxDocument state machine"; D-FISC-B1..B5): INVOICE of a
capture, CREDIT_NOTE of a refund (correcting the invoice), DEBIT_NOTE (schema only). The fiscal snapshot (profile, issuer,
treatment, rule, rate) is exactly the profile's (composite key). An unreviewed treatment is a blocked DRAFT with its concrete
blocker (FISCAL_TREATMENT_UNREVIEWED, FISCAL_PROFILE_NOT_EFFECTIVE, FISCAL_TREATMENT_CHANGED, FISCAL_ISSUER_MISMATCH,
ISSUER_FACTS_UNCONFIRMED) and can move nowhere; a draft is re-pointed at a re-reviewed profile only while DRAFT
(`tax_documents_draft_only`). DRAFT → VALIDATED is re-checked (`tax_documents_validation_guard`, KP011, after the profile's and
the issuer's transition locks): the document's profile is the version in force at the tax point (D-FISC-B4, B09-F4) — its window
covers the sale's tax point and it had not been superseded by then, so a re-review recorded after the sale neither blocks the
sale's invoice nor lends it a treatment that was not in force —, its treatment reviewed, the issuer's facts observed or
professionally confirmed with a numbering authorization; an INVOICE carries the capture's allocation and the rule the sale was
priced with (tax point: the capture's completion); a CREDIT_NOTE carries the completed refund's approved components and exactly the
fiscal snapshot of the invoice it corrects, which must be ISSUED (D-FISC-B5, B09-F16; it corrects the sale, so its profile is judged
at the sale's tax point); a DEBIT_NOTE is refused (no flow defines its basis; Q-B09-18). A legal number exists only with
authenticated issuance evidence (15: "A provider PDF existing does not prove DIAN acceptance"). One live invoice per capture, one
live credit note per refund, legal numbers and provider ids unique per issuer. → CORRECTED requires an actual successor (from
REJECTED) or an issued correction document (from ISSUED); the original record is never overwritten (15 "Original issued facts are
not overwritten"). The drafter (payment service) writes; issuance is CMD035 (B15; Q-B09-6); the agency and the finance scope read.

**ledger_entries** (registry LedgerEntry; 15 "Operational ledger"; D-LEDGER-B1..B4): balanced postings of reconciled money
movements only. A posting set has exactly one source — the domain event that records the movement or a settlement observation —
exposed as the registry's `eventId` (generated `event_id`), and that source is the set's idempotency identity: UNIQUE
`(event_id, line_no)`, so a replayed delivery posts nothing (reference/HASHING "a refund webhook replay does not post another
refund"). The source kind names the event that may source it (`ledger_entries_source_event`, KP001): CAPTURE `capture.completed.v1`,
FEE `capture.fee_observed.v1`, FUNDS `capture.funds_observed.v1` (PSP_RECEIVABLE / PSP_HELD / PSP_AVAILABLE, never bank cash),
CHARGEBACK `capture.reversed.v1`, REFUND `refund.completed.v1`, CORRECTION `reconciliation_case.resolved.v1` (the reviewed decision
whose reversing and adjusting entries correct an event-sourced posting) or a settlement's own correction, SETTLEMENT a settlement.
Every posting carries its effective date, its observed date (never after the posting) and its posting instant (15 "Every posting
includes event ID, source object, amount/currency, effective date, observed date, policy version and reversal relationship";
B09-F15). Each set balances within its currency and names one source kind, reference and agency at COMMIT (KP001); a correction
is a mirroring reversal entry, once, plus a new entry; append-only. Accounts (OPS-1): PSP_RECEIVABLE, PSP_HELD, PSP_AVAILABLE,
BANK_IN_TRANSIT, BANK_CASH, CONTRACT_LIABILITY, SERVICE_REVENUE, TAX_PAYABLE, CUSTOMER_OVERPAYMENT, REFUND_PAYABLE,
PROCESSOR_EXPENSE, COMMISSION_PAYABLE, COMMISSION_EXPENSE, OWNER_CONTRIBUTION, OWNER_DISTRIBUTION. A capture before delivery is a
contract liability, not revenue (15 "Revenue recognition follows the actual accounting policy"). Event-sourced postings belong to
the event's agency (composite key to `domain_events`); settlement postings to none. The FINANCE consumer (payment service) posts;
the finance scope reads.

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
| Quote (D-MACH-B1; 07 "Quote and checkout states" names the states) | DRAFT | issue_quote DRAFT→ISSUED; withdraw_quote DRAFT/ISSUED/ACCEPTED_FOR_CHECKOUT→WITHDRAWN; accept_terms_for_checkout ISSUED→ACCEPTED_FOR_CHECKOUT (CMD028; a replacement only by its re-binding); price_expiry_reached ISSUED/ACCEPTED→EXPIRED; superseding_quote_issued ISSUED/ACCEPTED→SUPERSEDED (a paid quote only when its purchase is closed or re-bound to that successor) |
| PaymentOrder (D-MACH-B2; the contract's states) | INTENT_CREATED | dispatch_intent_committed →CREATING; cancel_before_dispatch INTENT_CREATED→CANCELLED; provider_order_created CREATING→CREATED; creation_proved_no_effect CREATING→FAILED; buyer_approval_observed CREATED→APPROVED; capture_dispatch_committed CREATED/APPROVED→CAPTURING; capture_observed CREATED/APPROVED/CAPTURING/CAPTURE_UNCERTAIN→CAPTURED; capture_ambiguous CAPTURING→CAPTURE_UNCERTAIN; capture_proved_no_effect CAPTURING→APPROVED; capture_proved_no_effect_unapproved CAPTURING→CREATED; reconciliation_proves_no_capture CAPTURE_UNCERTAIN→APPROVED; reconciliation_proves_no_capture_unapproved CAPTURE_UNCERTAIN→CREATED; order_voided CREATED/APPROVED→CANCELLED; order_expired CREATED/APPROVED→EXPIRED |
| CaptureFact (D-MACH-B3) | PENDING (observed birth, D-INIT-B1) | provider_completed PENDING→COMPLETED; provider_denied PENDING→DENIED; provider_reversed PENDING/COMPLETED→REVERSED (the fee and funds observations are versions without a state change, D-EVT-B2) |
| CommercialAuthorization (D-MACH-B4) | ACTIVE | execution_admitted ACTIVE→CONSUMED (CMD036, B08); package_published CONSUMED→DELIVERED (B08); authority_revoked ACTIVE/CONSUMED/DELIVERED→REVOKED (reversal, full service refund, or SOURCE_REPLACED by a re-binding) |
| Refund (D-MACH-B5; the contract's states) | REQUESTED | approve_refund →APPROVED; reject_refund →REJECTED; dispatch_intent_committed APPROVED→SUBMITTING; authorization_lapsed APPROVED→FAILED; authenticated_completed SUBMITTING→COMPLETED; ambiguous_transport_result SUBMITTING→UNCERTAIN; proved_no_effect SUBMITTING→APPROVED; provider_refused SUBMITTING→FAILED; reconciliation_completed UNCERTAIN→COMPLETED; reconciliation_proves_no_effect UNCERTAIN→APPROVED; reconciliation_proves_refusal UNCERTAIN→FAILED |
| ReconciliationCase (D-MACH-B6) | OPEN | case_resolved OPEN→RESOLVED |
| PaymentRoute (D-MACH-B7), FiscalIssuerRoute (D-MACH-B8) | CONFIGURED | route_qualified CONFIGURED→QUALIFIED; route_suspended CONFIGURED/QUALIFIED→SUSPENDED |
| CorporateGrant (D-MACH-B9) | ACTIVE | grant_revoked ACTIVE→REVOKED |
| RefundPolicy (D-MACH-B10) | ACTIVE | policy_retired ACTIVE→RETIRED |

Every edge's performer (command or owning package) is in the generated matrix (`docs/design/B06-state-command-event-matrix.md`,
owner table in `tools/matrix.mjs`). The CostGrant edge `actual_authorization_and_funding`, which B06's table had assigned to
B09, is re-assigned to its grant package B03 with the reason Q-B09-9 (B09 funds no cost grant; B09-F17).

## 5. Ports

Domain repositories (`@kauro/domain` `ports/commerce.ts`, implemented over `pg` by M1): `PaymentRouteRepository`,
`FiscalRepository` (current profile after its transition lock; `profileInForceAt` for a document's tax point, D-FISC-B4; issuer
after its lock; `recordProfile` superseding once), `CorporateGrantRepository.activeGrant` (after the grant's lock),
`RefundPolicyRepository`, `PricePolicyRepository`, `ScopeIndex` (record / resolve), `QuoteRepository` (issue with snapshot; CAS
transitions), `PaymentOrderRepository` (insert, `findByIntentEntry`, `findOpenForProject`, CAS transitions with provider ids
learned once), `PaymentAttemptRepository` (prepare, `findLive`, `countFor`, `findByIntentEntry`, CAS transitions),
`CaptureFactRepository` (insert at first observed status, `advance`, versioned `observeFunds` and `observeFee`,
`committedRefunds`, `findByProviderCapture`), `ProviderObservationRepository`, `CommercialAuthorizationRepository` (issue,
`findLiveByCapture`, transitions), `PurchaseRebindingRepository`, `RefundRepository` (request, `fileServerRequest` idempotent per
capture and origin, approve with the immutable intent, transition, `findOpenForCapture(capture, origin)`), `TaxDocumentRepository`
(draft, redraft, transition, live invoice / credit note, blocked drafts), `LedgerRepository.post` (idempotent by source; observed
date; reversal links), `SettlementRepository`, `ReconciliationCaseRepository.open` (idempotent per kind and subject),
`PaymentInboxRepository` (lock for apply, settle), `ProviderExceptionRepository` (from any source, idempotent per source and
kind). `CommerceUnitOfWork extends UnitOfWork` adds `commerce`, `scopes`, `adoptScope`, `adoptFinanceScope`, `commerceScope`;
`CommerceUnitOfWorkFactory` runs it. Every versioned write is compare-and-swap and answers STALE with the current safe version and
state (B06 D-VER-1); every read of a fact relied on without change happens after that fact's transition lock (B06 D-TX-2).

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
called by M3), `CommerceEventConsumer` (FINANCE, FISCAL, PAYMENT_SERVICE; §8.1) and `PurchaseRebinder` (D-QUOTE-B6, implemented by
M2, called by B10's replacement flow). The platform ports of the packages B09 meets at integration (§15; each read inside the
caller's unit of work, never a call outside a transaction; `binding` PLATFORM or CONTRACT_FAKE): `DeliveryCapacityPort` (B08's
admission; D-CAP-B1), `SourceAvailabilityReader` and `SourceLineageReader` (B07's retention records and lineage; D-QUOTE-B7,
D-QUOTE-B6). The provider-effect protocol's phase interface is `ProviderCommandPhases` (`commerce/protocol.ts`, §6.1).

Contract fakes (D-FAKE-B1): until B15, the tests bind fakes of `PaymentProviderAdapter`, `WebhookVerifier`,
`ProviderEvidenceStore`, `FiscalDocumentBridge` and `ServiceAuthenticator` that implement the documented provider contract
(PayPal Orders v2 shapes of 15 "Capture and authority"), declare `integrationClass: "CONTRACT_FAKE"`, live under `test/` or a
`testing` subpath, and are named SIMULATED in the case map; until B07 and B08 are on main, the platform ports are bound to fakes
declaring `binding: "CONTRACT_FAKE"`, named SIMULATED the same way. The database refuses a fake route on LIVE; nothing in the
product wiring binds a fake.

## 6. Transaction discipline

### 6.1 The provider-effect protocol (D-PROTO-B1..B5)

07 "Transaction discipline": no database transaction stays open across a payment API call; the first accepted request records
its intent before external dispatch (10 "Idempotency contract"). CMD028 (create order), CMD029 (capture) and CMD033 (refund) run
as five steps (`commerce/protocol.ts`):

1. **T1 intent** — one unit of work of the command's principal in B06's pipeline order: access decision → journal reserve
   (RESERVED) → assurance → locked preconditions → durable intent (the order or refund row; the attempt PREPARED with its request
   hash and provider request identity; the platform scope rows) → events and outbox → COMMIT. The journal entry stays RESERVED.
2. **T2 claim** — one unit of work of the same principal: CAS the attempt PREPARED → DISPATCHING with `dispatch_deadline_at` =
   now + DISPATCH_TIMEOUT_SECONDS (30) + DISPATCH_WATCHDOG_MARGIN_SECONDS (30), and the aggregate's own dispatch edge (order
   CREATING / CAPTURING, refund SUBMITTING). The single serialization point of "dispatch at most once": a loser of the CAS never
   calls the provider.
3. **call** — outside any transaction: exactly the prepared request under `kauro-<attemptId>`, bounded by the deadline.
4. **T3 settle** — a SERVICE unit of work under `kauro_payment` (the spec's `settleRuntimeRole`; D-PROTO-B5, B09-F1), adopting the
   stored operation's agency (`adoptScope("PAYMENT_ORDER" | "REFUND", id)`): lock the aggregate, then the attempt; apply the
   authenticated result through the same reconciler the webhook and CMD034 use (§6.3). T3 never writes the journal.
5. **T4 complete** — the principal's unit of work: read the durable result and complete the journal: COMMITTED with the 2xx
   answer when conclusive, UNCERTAIN with a 202 operation reference when the effect is unknown (D-PROTO-B2; D-JOURNAL-B1).

**Resume** (same key, same digest; the journal answers PENDING for RESERVED/UNCERTAIN): re-run the access decision (B06
D-PIPE-1), find the operation by its journal entry (`intent_entry_id`), continue from its durable state: PREPARED → claim and
call; DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe (a read, never a second create) and settle when conclusive, else 202;
a proved no-effect permits a new deliberate attempt (ordinal + 1, a new request identity; at most MAX_ATTEMPTS_PER_OPERATION = 3,
enforced by `payment_attempts_sequence` and the ordinal CHECK, D-PROTO-B3); terminal (a crash between T3 and T4 included) →
complete the journal (T4) and answer. A crash at the intent/commit boundary — before T1 commits — leaves nothing, and the same key
is a new execution; a crash after it leaves a state from which the same key converges to one effect (07 "The client recovers the
same command result by its idempotency identity. It must not repeat the external effect under a new key"). **Watchdog**
(D-PROTO-B4): the payment service's sweep (07 "The sweeper repairs … ambiguous provider operations"; scheduled by the
PAYMENT_SERVICE consumer of `payment_attempt.dispatching.v1` / `provider_pending.v1` / `uncertain.v1` and by a bounded periodic
pass) observes every attempt past its `dispatch_deadline_at` (index `payment_attempts_watchdog`) and settles it through CMD034
with a stored observation; an attempt left UNCERTAIN stays visible with a case (15 "Exhausting retries leaves a visible case with
the exact unresolved effect"). **Cancel before dispatch**: an intent whose claim never committed and whose client never resumed it
— PREPARED for longer than the claim window, index `payment_attempts_unclaimed` — is cancelled by the same sweep (PREPARED →
CANCELLED_BEFORE_DISPATCH; an order still INTENT_CREATED → CANCELLED), since no provider call was possible: the claim (T2) is the
only path to a call, and a later resume of the same key finds the operation cancelled and answers it.

### 6.2 Isolation, lock order, transition subjects (D-TX-B1)

READ COMMITTED everywhere (07: constraints and row locks enforce the invariants; the refund ceiling and the inbox APPLIED
settlement refuse any other isolation because their re-check must read what committed while they waited). Every command takes
its locks in one global order, which also orders B09 after B06's (B06 D-TX-2: identity → membership → agency → client →
capability; plan → source revision → target contract):

**identity → membership → corporate grant → agency → capability → approval → source revision → target contract → payment route /
fiscal issuer / fiscal profile → quote → payment order → attempt → capture → commercial authorization → refund → tax document →
ledger.**

Facts relied on without change are read after the shared half of their transition lock (`kauro.await_transition`): the agency,
the capability of the mode, the approval (its withdrawal takes the exclusive half, 0011), the source revision, the target
contract, the payment route (provider+environment), the fiscal issuer, the fiscal profile (agency), the quote, the capture, the
commercial authorization, the corporate grant (user). Rows the command changes are locked `FOR UPDATE` in the order above. B06's
reader/writer rule holds for every subject: a command that changes a subject's state locks its row and takes no shared half (its
update takes the exclusive half through the subject's trigger); a command that relies on it without changing it takes the shared
half and no row lock (a row-level FOR SHARE would let later readers overtake a queued writer, B06 re-check N3). A handler reads
the ids it needs without a lock, takes the shared halves in the order above, then its row locks; the awaits inside the B09
triggers (authorization issuance, refund review and ceiling, fiscal validation, re-binding) re-acquire locks the handler already
holds and are the database's backstop. The refund commitment adds the exclusive per-capture lock `kauro.capture_refunds` after
the capture's shared half; the re-binding takes the replaced entitlement's exclusive half before both. `b09-migrations`
"CMD032-RACE" observes the approval waiting for a reversal in flight and then refused (KP003) — no sleep; the wait is observed in
`pg_stat_activity`.

### 6.3 The reconciler (one algorithm for every capture path)

CMD029's settle step, the application of a webhook (CMD030) and CMD034 apply an authenticated observation to an order the same
way, inside one SERVICE unit of work under the order's row lock:

1. **Attribute**: provider + environment + provider order / capture / refund id → the scope index (the webhook adopts the agency
   here; an unknown identity is a provider event exception UNKNOWN_PROVIDER_REFERENCE, never a guess from a payload's agency id —
   10: "It does not trust the agency ID in a provider payload without matching the stored order").
2. **Order the locks** (§6.2): since a completion may issue the authorization, the shared halves of the agency, the capability,
   the approval, the source revision, the target contract, the route and the quote are taken before the order's row lock (the
   ids are read without a lock first); a capture's own transition lock comes with its status update.
3. **Match** (`matchCapture`): provider, environment, provider order id, payee digest, currency; a mismatch is an exception of
   the same kind (WRONG_PROVIDER / WRONG_ENVIRONMENT / WRONG_ORDER / WRONG_PAYEE / WRONG_CURRENCY) with its source — the inbox
   record, the dispatch attempt or the stored query artifact — and no fact of the order changes (S058; D-ING-B3).
4. **Order the observation**: record it in `provider_observations`; an observation behind the subject's latest applied one, a
   duplicate, or a regression is kept as history (STALE_IGNORED / DUPLICATE) and changes nothing (15 "An old pending event cannot
   roll back a confirmed terminal capture"); a contradiction of a terminal state opens PROVIDER_INCONSISTENCY; an unknown status
   is UNRECOGNIZED and opens UNRECOGNIZED_PROVIDER_STATE.
5. **Step** (`captureStatusStep`): insert the fact at its observed status, or advance it along the lattice; on completion,
   allocate (`allocateCapture`: min(amount, owed) to the obligation, split cumulatively, the rest excess). A funds availability or
   a fee learned after the completion is a new version with `capture.funds_observed.v1` / `capture.fee_observed.v1` (D-EVT-B2).
6. **Consequences in the same transaction**: the order's edge (capture_observed, …); when the capture alone pays the whole
   obligation and every prerequisite still binds (`authorizationBlockers`; price expiry honored per D-AUTH-B3), issue the
   CommercialAuthorization; a partial amount opens AMOUNT_MISMATCH; an excess opens EXCESS_CAPTURE and files an EXCESS_CAPTURE
   refund request (R2-140); a capture whose subject no longer binds opens CAPTURE_WITHOUT_VALID_SUBJECT and files a KAURO_REMEDY
   request (15 "Price and source expiry races": refund and issue a new quote) — the two requests coexist (one per capture and
   origin) and each is filed with INSERT … ON CONFLICT DO NOTHING, so neither a second request nor a repeated filing can abort the
   transaction that records the capture (D-REF-B1, B09-F3; TRANSITIONS "it cannot ignore a real capture"); a dispute opened on the
   capture opens DISPUTE_OPEN with its amount and records the funds HELD, leaving the capture COMPLETED and its entitlement live
   (D-DISPUTE-B1); a reversal revokes the live authorization with its phase and lapses APPROVED refunds of the capture (Refund
   authorization_lapsed), and opens REVERSAL.
7. **Events and outbox**, the inbox record's settlement (webhook: APPLIED with the result event, IGNORED, REJECTED or RETRYABLE),
   and the observation's effect.

## 7. Error contract

Failure codes are B06's (10 "Responses and safe errors"; PAYMENT_PENDING, PAYMENT_UNCERTAIN and CAPACITY_UNAVAILABLE now used).
Reasons: the 49 `COMMERCE_FAILURE_REASONS` appended to `FAILURE_REASONS` (`@kauro/domain` `commerce/failure-reasons.ts`) —
principals (CORPORATE_ROLE_MISSING, SELF_APPROVAL_FORBIDDEN, SERVICE_NOT_PERMITTED, SERVICE_ENVIRONMENT_MISMATCH,
POLICY_NOT_APPLICABLE), provider ingress (PROVIDER_UNKNOWN, PROVIDER_SIGNATURE_INVALID, PROVIDER_EVENT_STALE,
PROVIDER_ENVIRONMENT_MISMATCH, PROVIDER_BODY_TOO_LARGE, EVIDENCE_NOT_FOUND, PROVIDER_SERVICES_UNAVAILABLE), quotes and checkout
(QUOTE_NOT_ACTIVE, QUOTE_EXPIRED, APPROVAL_NOT_CURRENT, PAYMENT_ROUTE_UNQUALIFIED, FISCAL_ROUTE_UNQUALIFIED,
FISCAL_TREATMENT_UNREVIEWED, FISCAL_PROFILE_NOT_EFFECTIVE, FISCAL_TREATMENT_CHANGED, ALREADY_PAID, DELIVERY_CAPACITY_UNAVAILABLE,
REPLACEMENT_NOT_ALLOWED), orders and captures (CREATION_IN_PROGRESS, CAPTURE_IN_PROGRESS, CAPTURE_UNCERTAIN, ORDER_NOT_CAPTURABLE,
PROVIDER_REFERENCE_MISMATCH, OBSERVATION_STALE, OBSERVATION_SUBJECT_MISMATCH, UNRECOGNIZED_PROVIDER_STATE), refunds
(NOTHING_TO_REFUND, REFUND_REQUEST_OPEN, REFUND_EXCEEDS_REMAINING, REFUND_COMPONENT_INVALID, REFUND_TAX_INCONSISTENT,
REFUND_NOT_REQUESTED, REFUND_NOT_APPROVED, REFUND_IN_PROGRESS, REFUND_UNCERTAIN, CAPTURE_NOT_REFUNDABLE), integrity
(LEDGER_UNBALANCED, OBLIGATION_OVER_ALLOCATED, FACT_REGRESSION, AUTHORITY_WITHOUT_CAPTURE, AUTHORITY_OUTLIVES_REVERSAL,
FINANCE_SCOPE_MISSING, COMMITMENT_ISOLATION, FISCAL_VALIDATION_REFUSED).

SQLSTATE class KP (0009 header; `packages/persistence/src/sqlstate.ts`): KP001 LEDGER_UNBALANCED, KP002
OBLIGATION_OVER_ALLOCATED, KP005 FACT_REGRESSION, KP004 AUTHORITY_WITHOUT_CAPTURE, KP006 AUTHORITY_OUTLIVES_REVERSAL, KP009
COMMITMENT_ISOLATION, KP011 FISCAL_VALIDATION_REFUSED → INTEGRITY_FAILURE (a handler that follows the domain rules never meets
them); KP003 REFUND_EXCEEDS_REMAINING, KP012 REFUND_TAX_INCONSISTENT (a racing approval can change the basis) and KP013
REPLACEMENT_NOT_ALLOWED → PRECONDITION_FAILED; KP007 CORPORATE_ROLE_MISSING and KP008 SELF_APPROVAL_FORBIDDEN → NOT_AUTHORIZED;
KP010 POLICY_NOT_APPLICABLE → ASSURANCE_REQUIRED; `refunds_reason_code_label` → INVALID_REQUEST SCHEMA_VIOLATION on `reasonCode`
(B06 D-LABEL-1). Unique indexes decided by the handler (B06 practice): `payment_orders_one_open_per_project` → PAYMENT_PENDING,
`refunds_one_requested_per_origin` → REFUND_REQUEST_OPEN (CUSTOMER_REQUEST; the server's origins file ON CONFLICT DO NOTHING),
`commercial_authorizations_one_*` → the replayed/current authorization, `capture_facts_provider_identity` → DUPLICATE,
`domain_events_capture_completed_once` → INTEGRITY_FAILURE (a reconciler that follows D-EVT-B2 never meets it).

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
every decision. "OK / DENY / RACE" restate the registry's expectation of the triad and name how the design meets its registry
*scenario* verbatim (cases.json: DENY "Foreign tenant/wrong role and then one missing material prerequisite"; RACE "Identical retry,
conflicting same-key request and crash at the intent/commit boundary"; 10 "Contract tests and compatibility": wrong role, wrong
agency, stale version, duplicate request, changed-body same key, lost response, external uncertainty; D-CASEMAP-B1, B09-F7). For
every command the RACE triad demonstrates: the identical retry replays (or resumes) the one operation; the same key with another
request digest is 409 IDEMPOTENCY_CONFLICT and writes nothing; a crash injected at the intent/commit boundary (before T1 commits)
leaves nothing and one after it converges to one effect under the same key — exactly as B06's journal and D-PROTO-B2 define.

### CMD028 CreatePaymentOrder — POST /api/v1/quotes/{quoteId}/payment-orders — AGENCY_BILLING — scope AGENCY_HEADER — provider effect CREATE_ORDER

Body `{ termsHash }`. **T1**: access (B06) → journal reserve → lock order: `await` agency, capability, approval, source
revision, target contract, payment route (the QUALIFIED route of the adapter's provider and environment), fiscal issuer, fiscal
profile; then the quote — `FOR UPDATE` while it is ISSUED (this command accepts it, the writer's path), its shared half once it
is ACCEPTED_FOR_CHECKOUT (a later order of the same quote only relies on it; a concurrent first acceptance leaves the loser
holding the row lock of the accepted quote, and the one-open-order index decides between them). Preconditions, in order (first
failure answers; `checkoutBlockers`): quote visible and not a replacement quote (NOT_FOUND); `termsHash` equals the quote's
(STALE_VERSION HASH_MISMATCH, current.mismatch); agency ACTIVE; quote ISSUED or ACCEPTED_FOR_CHECKOUT (QUOTE_NOT_ACTIVE); price
not expired (QUOTE_EXPIRED); not already paid (an authorization of the quote or a completed capture of one of its orders:
ALREADY_PAID); the project's open order is not uncertain (PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN) or in progress (PAYMENT_PENDING
CREATION_IN_PROGRESS / CAPTURE_IN_PROGRESS; retryable); source SEALED and within its effective deadline (`SourceAvailabilityReader`;
SOURCE_EXPIRED); approval current (APPROVAL_NOT_CURRENT); target current (TARGET_STALE); capability offered
(CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED); deliverable capacity for the purchased scope (`DeliveryCapacityPort`, B08's admission:
CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE, retryable; D-CAP-B1, B09-F5); route qualified (PAYMENT_ROUTE_UNQUALIFIED);
issuer route qualified (FISCAL_ROUTE_UNQUALIFIED); the current profile's reviewed rule equals the quote's
(FISCAL_TREATMENT_UNREVIEWED / FISCAL_TREATMENT_CHANGED); an adapter bound (INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE,
nothing written). Writes: the quote ISSUED → ACCEPTED_FOR_CHECKOUT on the first order (quote.accepted_for_checkout.v1); the order
INTENT_CREATED (payment_order.intent_created.v1) with `idempotency_hash` = `paymentIntentHash` (KAURO_PAYMENT_INTENT_V1: quote,
terms, amount, currency, route, provider, environment); the CREATE_ORDER attempt PREPARED (payment_attempt.prepared.v1) with the
prepared request's hash; the PAYMENT_ORDER scope row. **T2** CREATING / DISPATCHING. **call** `dispatch(prepareCreateOrder)`.
**T3** (payment service) ORDER_CREATED → attempt CONFIRMED, order CREATED with provider id and approval URL (host allowlisted),
PROVIDER_ORDER scope row; **T4** 201 `CreatePaymentOrderView { order (with checkout), quote }`, journal COMMITTED. AMBIGUOUS →
attempt UNCERTAIN, 202 (resume observes by request identity, never creates again, 15 "The adapter does not create another order
under a new local identity"); PROVED_NO_EFFECT → attempt FAILED_NO_EFFECT and, attempts spent, order FAILED; otherwise a new
deliberate attempt.

- **OK**: one order, one attempt, one provider order; the intent is durable before the call (T1 commits first).
- **DENY**: a foreign agency's quote (NOT_FOUND), a wrong role (VIEWER: NOT_AUTHORIZED ROLE_INSUFFICIENT) and then one missing
  material prerequisite at a time (expired source, stale terms, expired price, no deliverable capacity, unqualified route,
  unreviewed treatment) each refuse with no committed state and no provider call (S060: a price-valid quote whose source expired
  blocks checkout). "Source expiry racing order creation prevents new capture authority": a source transition after T1 is ordered
  after it (transition lock); authority is only ever issued at capture under the same checks (KP004), so the order may exist and
  still never carry authority.
- **RACE**: the identical retry replays or resumes the one operation; the same key with another termsHash is 409
  IDEMPOTENCY_CONFLICT with no effect; a crash injected between T1's commit and T2 resumes to one provider order; two keys: the
  second T1 fails `payment_orders_one_open_per_project` → PAYMENT_PENDING; an ambiguous creation is reconciled by request identity.

### CMD029 CapturePayment — POST /api/v1/payment-orders/{orderId}/capture — AGENCY_BILLING — scope AGENCY_HEADER — provider effect CAPTURE

Body `{ providerApprovalRef }`, a browser echo compared with the stored provider order id and never evidence (D-PAY-B4).
**T1**: access → journal → `await` agency, capability, approval, source, target, route, quote; `FOR UPDATE` the order.
Preconditions: order visible (NOT_FOUND); `providerApprovalRef` names it (INVALID_REQUEST PROVIDER_REFERENCE_MISMATCH,
UNKNOWN_REFERENCE; S057); order CREATED or APPROVED (ORDER_NOT_CAPTURABLE / ALREADY_PAID when CAPTURED); no live CAPTURE attempt
(PAYMENT_PENDING CAPTURE_IN_PROGRESS) or uncertain one (PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN); quote ACCEPTED_FOR_CHECKOUT
(QUOTE_NOT_ACTIVE) and price not expired before the capture starts (QUOTE_EXPIRED; 15 "If the quote expires before provider
capture starts, checkout is blocked"); every other blocker of checkout readiness (`checkoutBlockers` without the order's own
payment state): the subject blockers, deliverable capacity (CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE; D-CAP-B1), the
merchant and fiscal issuer routes still qualified, and the quoted reviewed tax rule still the current one (15 "Price and source
expiry races": the same terms stand only while "legal treatment … remain[s] valid"; FISCAL_TREATMENT_UNREVIEWED /
FISCAL_TREATMENT_CHANGED). Writes: CAPTURE attempt PREPARED. **T2** order CAPTURING, attempt DISPATCHING. **call**
`dispatch(prepareCapture)`. **T3** (payment service) through the reconciler (§6.3): CAPTURE_OBSERVED COMPLETED of the full
obligation → capture fact, order CAPTURED, authorization issued in the same transaction; PENDING → attempt PROVIDER_PENDING;
AMBIGUOUS → order CAPTURE_UNCERTAIN; PROVED_NO_EFFECT → order back to APPROVED (or CREATED when approval lapsed) with the attempt
FAILED_NO_EFFECT; a capture whose subject no longer binds → the capture, no authorization, the blockers named, a remedy request
filed. **T4**: 200 `CapturePaymentView { order, capture, commercialAuthorization, authorizationBlockers }` or 202.

- **OK**: server-side capture, authenticated result reconciled by the payment service, one authorization.
- **DENY**: a foreign agency's order (NOT_FOUND), a wrong role (NOT_AUTHORIZED ROLE_INSUFFICIENT) and one missing prerequisite (a
  browser echo naming another order, an expired price, no deliverable capacity) refuse before any effect; "Browser success, forged
  event or unknown result cannot create CommercialAuthorization": a forged webhook never passes ingress (§CMD030); an unknown
  result is UNCERTAIN (202), never authority; the request handlers' role cannot write a capture or an authorization at all
  (D-AUTH-B4); the database refuses any authorization without a completed capture that alone pays the obligation (KP004).
- **RACE**: the identical retry replays or resumes; the same key with another providerApprovalRef is 409 IDEMPOTENCY_CONFLICT with
  no effect; a crash between T1's commit and T2 and one between T3 and T4 converge to one capture and one authorization; capture
  vs webhook of the same capture: both serialize on the order row; the second sees the first's fact (DUPLICATE), one authorization
  (`one_per_quote`, `one_live_per_capture`). Two capture commands: one live CAPTURE attempt per order (unique) → PAYMENT_PENDING.
  Capture vs quote supersession: `quotes_release_guard` waits and refuses the release.

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
- **DENY**: the webhook's "wrong role" is an unauthenticated sender (a bad signature stores nothing but the ANONYMOUS denial); its
  "foreign tenant" is an event naming another environment or a provider reference no order of any agency holds (an exception,
  never a guess from the payload's agency); one missing prerequisite at a time — a wrong payee, currency, provider or order —
  never becomes a fact of the order (composite key, S058) and is the specific exception, the record REJECTED; a duplicate is the
  same inbox record and the same capture identity (unique), so no second capture, posting or commission event exists.
- **RACE**: identical redelivery is the same inbox record (DUPLICATE); a redelivery with another body under the same event id is a
  recorded conflict and the record is never APPLIED (the webhook's "same key, other digest"); a crash between the ingress commit
  and the application leaves a RECEIVED record the inbox worker applies once; delivery vs CMD029's settle: the order row lock
  orders them, the loser observes DUPLICATE.

### CMD031 RequestRefund — POST /api/v1/projects/{projectId}/refund-requests — AGENCY_BILLING — scope AGENCY_HEADER

Body `{ reasonCode (label), evidenceRef }`. Access → journal → project visible (NOT_FOUND) → its paid order's capture with a
refundable service or tax balance (`refundableBalance` of the latest COMPLETED capture; NOTHING_TO_REFUND) → no REQUESTED customer
refund of that capture (REFUND_REQUEST_OPEN; a pending server request of another origin does not block it, D-REF-B1). Writes:
refund REQUESTED (refund.requested.v1) with the proposal (`proposeRefund`: the whole remaining service and tax, which the
cumulative tax rule releases in full), the delivery phase (`deliveryPhaseOf` the authorization), the terms hash, the requester, the
REFUND scope row. 201 `RequestRefundView`. No provider effect.

- **OK**: a reviewable request with delivery, terms and evidence references.
- **DENY**: a foreign agency's project (NOT_FOUND), a wrong role (VIEWER) and one missing prerequisite (nothing refundable);
  "Customer cancellation is not direct permission to send arbitrary PSP refunds": the request is REQUESTED only; the agency holds
  no update on refunds, the approval needs a KAURO_OWNER (KP007) other than the requester (KP008).
- **RACE**: the identical retry replays; the same key with another reasonCode is 409 IDEMPOTENCY_CONFLICT with no effect; a crash
  at the intent/commit boundary leaves nothing (one transaction) and the retry files it once; two requests for one capture under
  two keys: `refunds_one_requested_per_origin` → REFUND_REQUEST_OPEN for the second.

### CMD032 ApproveRefund — POST /api/v1/refunds/{refundId}/approve — KAURO_OWNER — scope STORED_OPERATION

Body `{ expectedVersion, serviceCents, taxCents, authorizationRef }`. Access (`authorizeOperator`) → `adoptScope("REFUND", id)`
→ journal (identity-owned) → read the refund, `await` its capture and the capture's authorization, lock the refund →
`assureOperator` (standing policy that covers, else a fresh step-up of the operator: STEP_UP_MISSING / STEP_UP_STALE /
STEP_UP_NOT_OWNED / POLICY_NOT_APPLICABLE) → preconditions: version (STALE_VERSION); REQUESTED (REFUND_NOT_REQUESTED); capture
COMPLETED (CAPTURE_NOT_REFUNDABLE); components valid for the origin (`approvedComponents`, `checkRefundAmounts`:
REFUND_COMPONENT_INVALID; REFUND_EXCEEDS_REMAINING); the tax component is exactly the tax the service component releases under the
sale's reviewed rule, given every committed refund (`checkRefundTax`: PRECONDITION_FAILED REFUND_TAX_INCONSISTENT; D-REF-B6);
requester ≠ approver (SELF_APPROVAL_FORBIDDEN). Writes: the immutable intent (`authorizationHash` = KAURO_REFUND_AUTHORIZATION_V1
over the amounts, the approved reason — a label: a digest may cover it, a payload never carries it —, the authority, approver,
instant and `effectsHash` = KAURO_REFUND_EFFECTS_V1 over credit-note requirement, remaining service basis (cumulative, R2-081) and
whether it revokes); refund.approved.v1 → PAYMENT_SERVICE (execution). 200 `ApproveRefundView { refund, effects, authorizationKind }`.

- **OK**: the authorized amount and reason as an immutable intent.
- **DENY**: a refund of an agency outside the operator's grant (NOT_FOUND alike), a wrong role (no ACTIVE KAURO_OWNER grant:
  CORPORATE_ROLE_MISSING; the requester: SELF_APPROVAL_FORBIDDEN) and one missing prerequisite (a stale step-up, an amount above the
  remaining capture, a tax split the sale's rule does not release, a standing policy that does not cover it): "The total cannot
  exceed reconciled remaining capture; a standing authorized policy must be referenced rather than invented": the ceiling (domain
  and KP003), the tax rule (domain and KP012), the policy applicability (domain `policyCovers` and KP010), a step-up otherwise.
- **RACE**: the identical retry replays; the same key with other amounts is 409 IDEMPOTENCY_CONFLICT with no effect; a crash at
  the intent/commit boundary leaves the refund REQUESTED; two approvals of one version: the CAS admits one, the other
  STALE_VERSION; an approval vs a reversal of the capture: ordered by the capture's lock, the later approval refused (KP003;
  proven at DB level).

### CMD033 ExecuteRefund — POST /api/v1/refunds/{refundId}/execute — PAYMENT_SERVICE — scope STORED_OPERATION — provider effect REFUND

Body `{ expectedVersion }`. Access (`authorizeService`) → `adoptScope("REFUND", id)` → journal → read the refund, `await` its
capture, lock the refund → version; APPROVED (REFUND_NOT_APPROVED); capture still COMPLETED, else the refund lapses (APPROVED →
FAILED authorization_lapsed, CAPTURE_NOT_REFUNDABLE); no live REFUND attempt (PAYMENT_PENDING REFUND_IN_PROGRESS) and no UNCERTAIN
one ("any prior ambiguous submission is reconciled": PAYMENT_UNCERTAIN REFUND_UNCERTAIN until CMD034 settles it). **T1** REFUND
attempt PREPARED; **T2** refund SUBMITTING, attempt DISPATCHING; **call** `dispatch(prepareRefund)` for the approved total under
the attempt's request identity; **T3**: REFUND_OBSERVED COMPLETED with the exact amount → attempt CONFIRMED, refund COMPLETED
(refund.completed.v1 → FINANCE, FISCAL, COMMISSIONS, NOTIFICATIONS: the credit note, the ledger return posting and the commission
adjustment follow the event, once each); a completion that leaves no service basis revokes the authorization in the same
transaction (KP006, D-REF-B5); AMBIGUOUS → refund UNCERTAIN, attempt UNCERTAIN, 202; PROVED_NO_EFFECT → refund back to APPROVED
(a new deliberate attempt later); definitive refusal → FAILED (the commitment is released). **T4** completes the journal (the
same SERVICE principal).

- **OK**: "Submit once per reconciled provider identity and publish final refund/credit-note/commission events".
- **DENY**: a refund of another agency than the stored operation's (NOT_FOUND by the scope index), a wrong service identity
  (SERVICE_NOT_PERMITTED; another environment: SERVICE_ENVIRONMENT_MISMATCH) and one missing prerequisite (not APPROVED; a reversed
  capture lapses it); "Timeout stays UNCERTAIN with no blind duplicate financial effect": a second execute while UNCERTAIN is
  refused until reconciled; the one-live-attempt index and the request identity make a duplicate dispatch impossible.
- **RACE**: the identical retry resumes the same operation; the same key with another expectedVersion is 409
  IDEMPOTENCY_CONFLICT with no effect; a crash between T1's commit and T2 resumes to one provider refund; two executes: T2's CAS
  admits one claimant; the other observes the live attempt (PAYMENT_PENDING).

### CMD034 ReconcilePayment — POST /api/v1/payment-orders/{orderId}/reconcile — PAYMENT_SERVICE — scope STORED_OPERATION

Body `{ observationRef }`: a stored, authenticated provider query (the watchdog or the periodic reconciler performed it outside
any transaction and stored it). Access → `adoptScope("PAYMENT_ORDER", id)` → journal → the evidence exists (EVIDENCE_NOT_FOUND)
and is about this order, provider and environment (OBSERVATION_SUBJECT_MISMATCH) → lock order → reconcile (§6.3) including
uncertain attempts (UNCERTAIN → CONFIRMED / FAILED_NO_EFFECT), uncertain refunds (→ COMPLETED / APPROVED / FAILED), order
creation (CREATING → CREATED / FAILED), capture uncertainty, reversals, disputes, funds availability (`funds_state` as reported,
`capture.funds_observed.v1`; never available cash) and the reported fee (learned once, `capture.fee_observed.v1`; a fee that
differs from a fee already learned is a PROVIDER_INCONSISTENCY case; a statement fee differing is FEE_MISMATCH, B15's settlement
comparison). A capture of the order the query shows with another payee, currency or order is the specific exception with the
artifact as its source (D-ING-B3). 200 `ReconcilePaymentView { order, captures, commercialAuthorization, effects, openCases }`.

- **OK**: "Advance local facts from actual provider state and record mismatch incidents": a stored query advances an uncertain
  capture to CAPTURED with its authorization and records a partial capture of the same query as AMOUNT_MISMATCH.
- **DENY**: an order of another agency than the stored operation's (NOT_FOUND), a wrong service identity (SERVICE_NOT_PERMITTED /
  SERVICE_ENVIRONMENT_MISMATCH) and one missing prerequisite (no stored evidence; evidence of another order): "A provider
  pending/held state is never coerced to settled available cash": funds are HELD/AVAILABLE as reported; bank cash exists only in a
  settlement with bank evidence (`settlements_bank_evidence`, proven).
- **RACE**: the identical retry replays; the same key with another observationRef is 409 IDEMPOTENCY_CONFLICT with no effect; a
  crash at the intent/commit boundary leaves nothing and the retry applies the artifact once; reconcile vs webhook vs capture
  settle: the order row lock; observations are monotonic and idempotent per artifact and inbox record.

### 8.1 Consumers (D-CONS-B1)

The payment service runs three consumers of the outbox (B06 dispatch, at least once; each deduplicates by its own durable
identity — 07 "Consumers deduplicate by their own durable inbox identity"):

- **FINANCE** (capture.completed, capture.fee_observed, capture.funds_observed, capture.reversed, refund.completed,
  reconciliation_case.resolved): adopts the event's agency through its order, posts the balanced set (`capturePostings`,
  `providerFeePostings` of the reported fee, `fundsPostings`, `returnPostings`, a case's reversing and adjusting entries) with the
  event as source and its observed date; a replay is a no-op (UNIQUE `(event_id, line_no)`). A fee the provider reports after the
  completion is its own event, whose posting set carries only the fee lines; the completion is never re-published (D-EVT-B2).
- **FISCAL** (capture.completed, refund.completed; tax_document.validated / uncertain for B15): drafts the invoice / credit note
  (one live per capture / refund) under the profile version in force at the tax point (`profileInForceAt`, D-FISC-B4), resolves the
  treatment (`resolveFiscalTreatment`), validates or records the blocker; a credit note takes the corrected invoice's snapshot and
  waits for the invoice's issuance (D-FISC-B5); when a profile is re-reviewed, re-evaluates blocked drafts (`listBlockedDrafts`,
  `redraft`). It does not receive the fee or funds events (they are not a new collection).
- **PAYMENT_SERVICE** (payment_attempt.dispatching / provider_pending / uncertain; refund.approved / uncertain): the watchdog
  and the refund executor (CMD033 with its own journal key derived from the refund and version).

### 8.2 Where the payment service runs

The service routes (CMD033, CMD034), the settle steps of CMD028 and CMD029, the application of provider events and the
re-binding are units of work of `apps/api` authenticated as service identities (10 "Internal command authentication"), running on
a second verified pool whose login is a member of `kauro_payment` only (B06's pool verification refuses a login in two groups, so
the process holds one login per group); the webhook's ingress half uses the ingress pool (`kauro_ingress`, B06 PgInboxIngress),
the agency and operator routes the request-handler pool. The consumers run in the payment dispatcher: claims and settlements of
outbox records through B06's `PgOutboxDispatchStore` under `kauro_control` with a lease per consumer (B06 D-OUTBOX-1: "held by the
dispatcher of the consumer's package"), each effect in its own SERVICE unit of work under `kauro_payment` — delivery and effect are
separate transactions, so the consumers are idempotent (§8.1). The connection budget of an api instance with three pools is
Q-B09-14.

### 8.3 Reads

GetQuote, GetPaymentOrder, GetRefund (agency, any role; AGENCY_HEADER) and GetRefundReview (operator; STORED_OPERATION): the
B06 read discipline (the access decision, the policies, a durable fact of a denial), projections by the closed views (§10).
`checkoutReady`/`checkoutBlockers`/`paymentStatus`/`nextActions` are derived at read time from durable facts and are never
authority (10 "A UI readiness flag is informative"); `paymentStatus` (D-PAY-B2): CHECKING while any effect is uncertain
(15 "We are checking this payment"; next actions REFRESH_STATUS / CONTACT_SUPPORT, never "pay again").

## 9. Events and outbox

49 event types (`COMMERCE_EVENT_TYPES`; seeded by 0009): one per reachable state of each versioned commerce aggregate
(`<kind>.<state>.v1`; a back edge publishes the type of its target state with `previousState`) plus the capture's two later facts
(`capture.fee_observed.v1`, `capture.funds_observed.v1`; D-EVT-B2), 8 aggregate kinds (quote, payment_order, payment_attempt,
capture, commercial_authorization, refund, tax_document, reconciliation_case) registered in the foundation's registry. Payloads
follow B06 D-EVT-2 — ids, hashes, tokens, non-negative integers, booleans; no provider identifiers, no label (the refund's reason
stays on its row), server reasons as tokens (`outcomeCode`, `failureCode`, `revocationCode`, `rejectionCode`, `detailCode`); the
allowlists are `COMMERCE_EVENT_PAYLOAD_ALLOWLIST` (commercial_authorization.issued.v1 names `orderQuoteId` and `rebindingId`).
Consumers: FINANCE, FISCAL, PAYMENT_SERVICE (this package), COMMISSIONS (B10), EXECUTION_CONTROL (B08), NOTIFICATIONS; the
subscriptions are `COMMERCE_EVENT_SUBSCRIPTIONS` (e.g. capture.completed → FINANCE, FISCAL, COMMISSIONS; capture.fee_observed and
capture.funds_observed → FINANCE only; commercial_authorization.issued/revoked → EXECUTION_CONTROL, NOTIFICATIONS; refund.completed
→ FINANCE, FISCAL, COMMISSIONS, NOTIFICATIONS; refund.approved/uncertain and the dispatched attempts → PAYMENT_SERVICE;
reconciliation_case.resolved → FINANCE). TRANSITIONS "Cross-aggregate finalization": one reconciled financial event, several
separate idempotent effects.

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
settle runtime role, scope, idempotency, step-up, external effect and cases; security `bearerAuth` (persons), `serviceAuth`
(payment service), none for the webhook (signature). `tools/openapi.mjs check` refuses a planned route that is registered or also
documented as served, a duplicate operationId and a forbidden member (`tools/test/openapi.test.mjs` "B09: …").

## 11. The scenario cases

- **S057** browser success without a server capture → no authority: CMD029 compares the echo only; authority comes only from an
  authenticated capture that alone pays the obligation (KP004), written by the payment service only (D-AUTH-B4); the order view
  says PENDING/CHECKING, never paid.
- **S058** wrong amount / currency / payee / environment / signature → no authorization; reconcile or raise the incident: bad
  signature stores nothing; wrong payee/currency/environment/order cannot be the order's capture (composite key) and is the
  specific exception from whichever source observed it; a wrong amount is a real capture recorded with its allocation, never
  authority, AMOUNT_MISMATCH case (+ refund request).
- **S059** reversal before local capture observation or after delivery → reconcile the real order, phase-specific restriction, no
  second charge: a fact born REVERSED allocates and posts (D-PAY-B5); a reversal revokes with PRE_EXECUTION / DURING_EXECUTION /
  POST_DELIVERY (KP006, phase trigger); the order stays CAPTURED (never charged again); delivered history stays; a dispute in
  progress holds the funds without revoking anything until the provider reverses (D-DISPUTE-B1).
- **S060** a price-valid quote after source deletion → checkout blocked; identical reupload needs a new revision and approval:
  SOURCE_EXPIRED in CMD028/CMD029; the authorization requires the quoted revision SEALED (KP004); a new revision changes the
  revision hash, so the quote (bound to the plan's source) cannot be reused — a new plan approval and quote (B07/B08/B10), or, for
  a paid purchase before execution, the included replacement re-binding the capture (D-QUOTE-B6); a paid capture that can bind
  nothing is refunded as KAURO_REMEDY and then releases its quote (D-QUOTE-B4).
- **R2-077** 129500 at 2500 bps → discount 32375, service 97125: `discountCents`, `kauro.round_half_up_bps`, the quote CHECKs.
- **R2-078** fee 5275, net 91850 (illustration; actual fees replace it): `illustrativeProcessorFee` for the illustration; the
  ledger posts only the provider-reported fee (`providerFeePostings`, sourced by the completion or by `capture.fee_observed.v1`).
- **R2-081** one-cent refund sequence → cumulative entitlement reaches exactly zero: `cumulativeEntitlement` /
  `entitlementAdjustment` from the remaining service basis (`serviceBasisAfterCents` in refund.completed.v1), and the tax of the
  same sequence returns exactly the collected tax (D-REF-B6); the commission ledger itself is B10's.
- **R2-128** fiscal boundary: `resolveFiscalTreatment` receives no currency, country or email; an unreviewed profile blocks the
  draft (and quoting), the capture reconciles regardless.
- **R2-140** two actual captures for one obligation: both recorded (unique identities), the second allocated entirely as excess
  (KP002 refuses otherwise), one authorization, an EXCESS_CAPTURE refund request (coexisting with any other origin's), the
  commission basis capped to the obligation (only allocated service counts).

## 12. Decisions register

| id | decision | authority / rationale |
|---|---|---|
| D-CTX-B1 | The payment service is a SERVICE context on a new runtime group `kauro_payment`, adopting one agency per unit of work; column-scoped reads of B06 prerequisites | 08 "a service account has only its technical role"; COMMAND_CATALOGUE service commands "with scope derived from the stored operation"; 14 "runtime service identities have only required database roles". Reusing `kauro_control` would give the service cross-tenant operational rights it must not have |
| D-CTX-B2 | The corporate operator is an OPERATOR context on `kauro_app` with its user bound and a finance scope (`kauro.finance_agency_id`) admitted only while its KAURO_OWNER grant is ACTIVE; no B06 table keys on it | 08 "Corporate operators … individually managed corporate identities", "Private Owner has no automatic customer-record bypass", "Finance capability and customer-data support access are separate" |
| D-SCOPE-B1 | The scope index `commerce_scopes` maps stored operations and provider identities to their agency; append-only; adoption once per unit of work | COMMAND_CATALOGUE "Shared execution contract"; 10 "does not trust the agency ID in a provider payload without matching the stored order"; PaymentOrder "order identity cannot migrate between tenants" |
| D-SCOPE-B2 | Every scope row names its order and its capture or refund by composite keys; a platform key is the object's id; a provider key is the identity its object learned (`commerce_scopes_bind_key`); the request handlers record only PAYMENT_ORDER and REFUND rows, the payment service REFUND and provider rows | B09-F11; 07 composite foreign keys; D-SCOPE-B1 "a provider identity maps to one agency", "written by the transaction that creates the object"; D-AUTH-B4 |
| D-CORP-B1 | Corporate roles are grants in `corporate_roles`, read by the database for every finance-scoped row and every review; never a token claim | 08 "Identity is not permission"; B06 §6.2 left corporate roles denied by default for their packages |
| D-AUTHZ-B1 | Agency commands use the B06 authorizer (AGENCY_BILLING = OWNER or BILLING membership; reads any role) | B06 §6.2 role model; registry roles |
| D-AUTHZ-B2 | Segregation: the requester of a refund cannot review it (KP008) | 08 high-impact actions; 15 "It is not itself permission" — silence on segregation, decided for the owner's protection; Q-B09-12 |
| D-AUTHZ-B3 | Service roles are a code-owned table (payment-service → PAYMENT_SERVICE, provider-ingress → AUTHENTICATED_PROVIDER, fiscal-service → FISCAL_SERVICE) checked with the environment | 10 "Internal command authentication": issuer, audience, expected service identity and environment |
| D-AUTH-B4 | The payment service (`kauro_payment`) is the only writer of provider-observed facts (provider identities, attempt results, capture facts and their funds and fee, observations, cases, server refund requests, provider scope keys) and of the issuance and revocation of CommercialAuthorizations; the request handlers write only the intent and the claim edges of a provider effect; consumption and delivery of an entitlement are B08's edges | B09-F1; registry CaptureFact invariant "Browser claims cannot produce a capture fact"; 07 "Application checks improve messages but cannot be the sole protection"; 08 "Threat model and assets" (malicious agency member, forged webhook); 14 "Identity matrix"; B06 R14/R30 precedent (proofs by the verifier, receipts by the validator) |
| D-IDEM-B1 | Idempotency: the B06 command journal for CMD028/029/031–034; the provider inbox identity (provider, environment, event id) for CMD030 | 10 "Idempotency contract"; 15 "deduplicates by provider, environment and event ID"; 07 inbox identity |
| D-IDEM-B2 | An operator's journal entry is identity-owned (agency NULL), keyed by the operator | 10 identity "authenticated subject … agency"; the finance scope never binds `kauro.agency_id` |
| D-JOURNAL-B1 | A provider command whose outcome is unknown leaves its journal entry UNCERTAIN and answers 202; the resume commits it (the B06 guard admits the path; the adapter gains `markUncertain` and commit-from-UNCERTAIN) | 10 "The API indicates whether the operation is pending, rejected or uncertain"; registry RequestJournal "ambiguity is an explicit state" |
| D-ING-B1 | The payment service is the consumer of payment providers' inbox records (settles them in the transaction that applies them); the ingress stays B06's `kauro_ingress` | 07 "Consumers deduplicate by their own durable inbox identity and verify state before an effect"; B06 D-ING-1/2 |
| D-ING-B2 | A verified event no order can take is an exception for the owner's review; the provider is answered 200 with its disposition | 15 "Wrong payee/currency/order … rejects" (CMD030) and "record mismatch incidents"; a provider must not retry forever a correctly received event |
| D-ING-B3 | Provider exceptions are source-agnostic — exactly one of a webhook (inbox record), a dispatch response (attempt) or a stored query (artifact) — attributed to the stored operation's agency and order when the source is a stored operation; the kinds are the domain's CaptureMismatch plus the ingress's own | B09-F9; S058 "reconcile or raise the specific incident"; CMD030 failure; 15 "Acceptance" (wrong merchant, wrong currency, sandbox/live confusion, lost capture response); 10 "Provider adapter contract" |
| D-PROTO-B1 | Provider effects run as intent (T1) / claim (T2) / call / settle (T3) / complete (T4) | 07 "No database transaction remains open across … payment API calls"; 10 "The first accepted request records its intent before external dispatch" |
| D-PROTO-B2 | An ambiguous effect answers 202 with the durable operation; the same key resumes and converges | 10 "Long work returns 202 …"; "An ambiguous external effect requires reconciliation, not blind retry" |
| D-PROTO-B3 | A logical operation has at most three attempts; a later attempt only after a proved no-effect, with a new provider request identity | registry PaymentAttempt proved_no_effect "Allow a new deliberate attempt under policy, not a blind exception retry"; 15 "Its requests are bounded"; the bound is a decision (3) |
| D-PROTO-B4 | Every dispatched attempt carries a deadline; a watchdog reconciles past it | 15 "The periodic reconciler checks uncertain orders, captures, refunds"; registry PaymentAttempt observation_lost |
| D-PROTO-B5 | T3 settle runs as a SERVICE unit of work under `kauro_payment` whatever principal asked for the effect (the spec's `settleRuntimeRole`); T4 — the journal's completion — runs in the principal's own unit of work, deriving the answer from durable facts; a crash between T3 and T4 repeats only T4 | B09-F1; D-AUTH-B4; B06 journal ownership (the journal row is the principal's); 07 "The client recovers the same command result by its idempotency identity" |
| D-INIT-B1 | A provider capture is born in the status its first authenticated observation shows: the initial state or one listed edge from it (`enforce_observed_birth`) | 07 "Provider webhooks can arrive … out of order"; 15 "Events may arrive before the browser returns"; B06 D-INIT-1 refuses skipped edges — a first observation of COMPLETED is not a skipped decision but a late observation |
| D-MACH-B1..B10 | The ten platform machines of §4.6 | the registry contracts carry states without machines (Quote states named by 07; PaymentOrder, CaptureFact, Refund contracts); platform records need guarded lifecycles; declared like B06 D-AGG-1/2 |
| D-EVT-B1 | The B09 aggregate kinds are rows of the foundation's `kauro.aggregate_kinds`, one INSERT per kind in the migration that creates its table; `kauro_payment` reads the registry through its own policy; B09 never edits 0008, the foreign key or the binding | FOUNDATION D-AGGK-1..5 and §4 (resolves Q-B09-13); 08 "Dynamic SQL based on customer input is prohibited" (the identifiers are the migration-owned registry's) |
| D-EVT-B2 | A provider fact learned after the capture's status — the funds' availability, the fee — is a new capture version with its own event (`capture.funds_observed.v1`, `capture.fee_observed.v1`) routed to FINANCE only; `capture.completed.v1` is published once per capture (partial unique index on `domain_events`) | B09-F8, B09-F15; 15 "Repeated delivery cannot duplicate capture, authorization, refund or commission"; TRANSITIONS "Cross-aggregate finalization" (separate idempotent effects from the same reconciled financial event); CMD030 failure "duplicates do not add money or commissions" |
| D-FACT-B1 | Security facts of the payment service and the ingress: no agency, actor SERVICE or ANONYMOUS, action CMD030 for the ingress | 08 "Threat model and assets": "Every boundary has a schema, identity, authorization predicate, replay behavior and audit event" (provider webhook to inbox is one); B06 streams unchanged |
| D-MONEY-B1 | BIGINT minor units within 0..2^53−1; arithmetic CHECKs in numeric; one rounding primitive floor((B×r+5000)/10000) | 07 "Money uses BIGINT minor units"; reference/HASHING "Exact money"; 15 "Round once at the named monetary boundary" |
| D-TIME-B1 | Every duration constraint is exact hours or seconds on UTC instants (quote expiry 336 hours, lookback 8760 hours, source hard cap 1,209,600 s), never days on timestamptz | B09-F12; reference/HASHING "Retention formulas" ("Use UTC instants for storage … Duration days equal 86400 seconds") |
| D-QUOTE-B1 | B09 stores and re-checks quotes; issuance (CMD027) is B10's; the terms preimage names the issuer | registry cases CMD027-* are B10's; 16 "Quote calculation": "The quote records pricing version, quantity evidence, discount facts, tax profile, legal issuer, source/plan/target hashes, expiry and dataAvailableUntil. It is immutable once issued" |
| D-QUOTE-B2 | The eligibility snapshot's shape is enforced here, evaluated at the quote's own issuance instant; qualification is B10's | registry PriceEligibilitySnapshot; 16 "Recurrence decision"; reference/HASHING "at one server issuance instant" (B09-F10) |
| D-QUOTE-B3 | One live quote per project; a new quote supersedes the previous before it is created; a replacement quote counts once accepted | 07 "A changed price, quantity, discount or tax creates a new quote"; 16 "Quote calculation": "A material correction creates a superseding quote with a visible comparison"; D-QUOTE-B6 |
| D-QUOTE-B4 | A quote leaves ACCEPTED_FOR_CHECKOUT only with nothing of its payment in flight or uncertain, and then only when its purchase is closed (no live entitlement; every completed capture paying it wholly refunded or reversed) or re-bound to exactly the superseding replacement | B09-F2; 15 "Price and source expiry races" ("otherwise refund and issue a new quote"); 07 "Quote and checkout states" ("or refunds and requests a new acceptance"); TRANSITIONS "Cross-aggregate finalization" ("offer the documented reupload/reapproval or refund path"); 16 "Founding incentive" (release only after reconciling possible capture); a delivered purchase keeps its quote (Q-B09-15) |
| D-QUOTE-B5 | Quotes and snapshots name only known price policies (`price_policies`, migration-owned, R2-INITIAL today); the policy's durations and allowances are its rows | B09-F10; 16 "Quote calculation" and registry policy.pricing; 07 "Application checks … cannot be the sole protection" |
| D-QUOTE-B6 | The included pre-execution source replacement re-binds a paid capture to a replacement quote (same terms, new revision, plan and approval) in one SERVICE unit of work: a recorded re-binding within the policy's allowance (1), the replaced entitlement revoked SOURCE_REPLACED, the replaced quote superseded, the replacement accepted and entitled on the same capture; refused once execution started, when a refund is open or committed, without lineage, or beyond the allowance (KP013); B10 decides eligibility (R2-092/R2-093), B07 records the lineage | B09-F2; 16 "Scope changes and credits"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18 and §16; policy `pricing.customerPreExecutionSourceReplacementsIncluded`; B07 Q-B07-17 |
| D-QUOTE-B7 | A quote's source availability is bounded in the database by B06 columns (a SEALED revision of the project, sealed no later than issuance, promised no later than the policy's hard cap from the seal and the price expiry) and set exactly from the source lifecycle's effective deadline through `SourceAvailabilityReader` (B07) | B09-F10; 07 "A fourteen-day price lifetime does not extend seven-day source retention"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §16; reference/HASHING "Retention formulas"; FOUNDATION D-AGGK-5 (no reference to B07's tables) |
| D-CAP-B1 | CMD028 and CMD029 require deliverable capacity for the purchased scope, read through `DeliveryCapacityPort` (B08's admission) inside T1; unavailable or unanswered is CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE (retryable); B09 reserves nothing | B09-F5; 15 "PaymentOrder and intent" ("validates … capacity"); 07 "Quote and checkout states" (deliverable capacity), "Job and attempt states" (no unbounded queue of purchases); COMMERCIAL_LEDGER_WORKED_EXAMPLES §14; 10 stable code CAPACITY_UNAVAILABLE |
| D-PAY-B1 | Capture allocation: min(amount, owed) to the obligation, split cumulatively; the database caps it (KP002) | 15 "Summed allocations must equal the total"; R2-140 "cap commission basis to the service obligation" |
| D-PAY-B2 | The agency's payment status is derived: NOT_STARTED, PENDING, CONFIRMED, FAILED, CHECKING | 15 "Payment state transitions" customer copy |
| D-PAY-B3 | Every applied observation is history with its effect; facts move only forward | 15 "adds facts monotonically"; 07 "An old event may add historical evidence without rolling current state backward" |
| D-PAY-B4 | The browser's `providerApprovalRef` is compared with the stored order, never evidence | CMD029 failure "Browser success … cannot create CommercialAuthorization"; S057 |
| D-PAY-B5 | A capture first seen REVERSED was completed at the provider: it is allocated and posted, then reversed | S059 "reversal arrives out of order before local capture observation"; the money moved twice |
| D-AUTH-B1 | Authorization issuance is re-checked by the database under the transition locks (KP004) | 07 "CommercialAuthorization"; S057, S058, S060 |
| D-AUTH-B2 | A reversal revokes the live authorization in the same transaction with the phase it leaves (KP006) | 07 "Payment reversal before execution prevents launch …"; 15 "Disputes and chargebacks" |
| D-AUTH-B3 | A capture completed after price expiry is honored when source, target, approval, capability and the quoted reviewed tax rule still bind (`honored_after_price_expiry`); otherwise a remedy refund | 15 "Price and source expiry races" ("honors the same price only when source, target, legal treatment and delivery scope remain valid"); M2 adds the tax-rule check to `authorizationBlockers` for this case |
| D-DISPUTE-B1 | A dispute in progress is a DISPUTE_OPEN case with its capture and disputed amount and the funds HELD; the capture stays COMPLETED and its entitlement live until the provider actually reverses it (then S059's reversal path); the dispute record's workflow (provider case id, deadlines, evidence requirements, response, owner) is B15's | B09-F14; 15 "Disputes and chargebacks" (records contain case ID, deadlines, reason, amount, evidence requirements, status and owner; "A reversal revokes new execution authority where appropriate"); 15 "Acceptance" (dispute and held funds); Q-B09-17 |
| D-REF-B1 | Origins CUSTOMER_REQUEST, EXCESS_CAPTURE, KAURO_REMEDY; one REQUESTED per capture and origin; server origins filed ON CONFLICT DO NOTHING | B09-F3; 15 "Refund policy and calculation"; R2-140 excess obligation; TRANSITIONS "it cannot ignore a real capture" |
| D-REF-B2 | CMD032's serviceCents/taxCents approve the service and tax; an excess return approves the recorded excess with zero service and tax | registry CMD032 fields name the service/tax split; an excess is neither |
| D-REF-B3 | The commitment ceiling per component under a per-capture exclusive lock, READ COMMITTED (KP003, KP009) | 15 "Concurrent refund requests serialize that invariant" |
| D-REF-B4 | A standing policy applies only when ACTIVE, valid, for the origin, the current phase and the scope (FULL_REMAINING / EXCESS_ONLY / BOUNDED); otherwise a fresh step-up | CMD032 failure "a standing authorized policy must be referenced rather than invented"; 08 step-up for significant refunds |
| D-REF-B5 | A completed refund that leaves no service basis revokes the authorization in the same transaction (KP006) | CommercialAuthorization authority_revoked guard "Reversal or full service refund" |
| D-REF-B6 | Refunded tax follows refunded service cumulatively per capture at the sale's reviewed rule: the tax remaining after a refund is the rule applied once to the remaining service basis (never above the collected tax; all of it while no service is refunded, none once no basis remains), and a refund's tax is the difference; enforced in the domain (`checkRefundTax`) and at approval (KP012) | B09-F6; 15 "Exact representation and rounding" ("A partial refund allocates service and tax components explicitly … any rounding remainder follows a deterministic rule"); 15 "Refund policy and calculation" ("allocates tax consistently"); reference/HASHING cumulative recomputation; COMMERCIAL_LEDGER_WORKED_EXAMPLES §6, §19 |
| D-FISC-B1 | Reviewed fiscal profile versions; unreviewed treatments block quotes and fiscal drafts; validation re-checked by the database (KP011) | 15 "FiscalProfile"; R2-082; R2-128 |
| D-FISC-B2 | A credit note is required exactly when service or tax is refunded | 15 "Refunds … create the legally appropriate credit/debit document"; an excess is not a sale |
| D-FISC-B3 | Corrections keep lineage: a corrected draft names its predecessor; an issued document is corrected by an issued correction | registry TaxDocument corrected_draft_version, lawful_credit_or_correction_issued; 15 "Original issued facts are not overwritten" |
| D-FISC-B4 | A document is validated against the profile version in force at its tax point (window covers it, not superseded by then); the current version is required only for a new quote and a new draft's choice; a re-review that changes the treatment after a sale leaves the sale's documents under the treatment it was priced and in force with (a retroactive correction is a professional decision, Q-B09-20) | B09-F4; registry FiscalProfile validFrom/validUntil; 15 "FiscalProfile" (effective dates, reviewer evidence); registry TaxDocument DRAFT→VALIDATED guard |
| D-FISC-B5 | A credit note carries exactly the fiscal snapshot of the invoice it corrects, which must be ISSUED; a debit note is not validated until a flow defines its basis | B09-F16; 15 "TaxDocument state machine" ("relationship to the original"); Q-B09-18 |
| D-LEDGER-B1 | Posting sets sourced by one event or settlement; idempotent by source; balanced per currency at commit; append-only; reversals mirror | 15 "Operational ledger"; reference/HASHING "Ledger posting and reconciliation" |
| D-LEDGER-B2 | Accounts OPS-1; a capture is contract liability; the actual reported fee is posted, never the illustration | 15 "Revenue recognition…", "actual statement fees replace the illustration" (R2-078) |
| D-LEDGER-B3 | Settlement postings are platform-level and B15's | R2-085 in B15 |
| D-LEDGER-B4 | Every posting carries its observed date; each source kind names the event that may source it; a correction of an event-sourced posting is sourced by the reviewed resolution of its reconciliation case (reversing plus adjusting entries) | B09-F15; 15 "Operational ledger" ("Every posting includes … effective date, observed date … Corrections add reversing/adjusting entries"; "Unexplained differences create a case") |
| D-SETTLE-B1 | Bank-available cash requires bank evidence and cannot exceed withdrawals | 15 "Settlement and withdrawal"; CMD034 failure |
| D-ROUTE-B1 | Merchant and fiscal issuer routes are configuration records qualified with evidence | 15 "Merchant identity and environment are fixed by server configuration"; "Accounting integration decision"; R2-083 |
| D-RPOL-B1 | Standing refund policies are versioned, step-up-authorized records with explicit applicability | CMD032 failure text |
| D-FAKE-B1 | Contract fakes are labelled CONTRACT_FAKE in code and evidence; a fake route can never be LIVE; the platform ports of B07 and B08 are bound to fakes declaring `binding: "CONTRACT_FAKE"` until their package is on main | the task's rule; 21 "Evidence classes" |
| D-BIND-B1 | Binding UNIQUE targets and partial indexes added to B06 tables | 07 "Composite foreign keys … prevent a project … from referencing another agency's revision, quote, package or client" |
| D-TX-B1 | New transition subjects and the global lock order of §6.2 | B06 D-TX-2 extended |
| D-RESP-B1 | B09 views derived under B06 D-RESP-1 with provider identifiers and evidence withheld | 10 "Read endpoints return safe projections"; "Raw sensitive provider responses stay in a restricted reconciliation store" |
| D-OUT-B1 | Route catalogues composed from B06 fragments plus B09 access and command outcomes | B06 D-OUT-1 |
| D-API-B1 | Designed routes are documented as planned operations until served | 10 "OpenAPI is generated from the owning contract registry and checked against actual routes" — a planned route is not an actual route |
| D-CONS-B1 | FINANCE, FISCAL, PAYMENT_SERVICE consumers in the payment service, idempotent by source identity and uniqueness | 07 "Outbox, inbox and event ordering" |
| D-LABEL-B1 | The refund reason is a label: stored and answered, covered by the authorization digest, never in an event | B06 D-API-1, D-LABEL-1 |
| D-CASEMAP-B1 | Every DENY and RACE test title of CMD028–CMD034 in the case map states its registry scenario verbatim (foreign tenant, wrong role or service identity, one missing prerequisite; identical retry, same key with another digest → IDEMPOTENCY_CONFLICT, crash at the intent/commit boundary); `tools/test/b09-case-map.test.mjs` enforces it | B09-F7; registry cases.json scenarios; 10 "Contract tests and compatibility" |

## 13. Open questions for the authority

- **Q-B09-1** TaxDocument states: manual 15 "TaxDocument state machine" names DRAFT, READY_TO_ISSUE, DISPATCHING,
  PROVIDER_PENDING, ACCEPTED, ACCEPTED_WITH_OBSERVATIONS, REJECTED, CORRECTION_REQUIRED, VOIDED_BY_VALID_CORRECTION; the registry
  contract and machine name DRAFT, VALIDATED, SUBMITTING, UNCERTAIN, ISSUED, REJECTED, CORRECTED. B09 follows the registry (contract
  and machine agree, and the machine is what the acceptance cases use). ACCEPTED_WITH_OBSERVATIONS has no registry equivalent.
- **Q-B09-2** The registry Refund contract lists `serviceCents`, `taxCents`, `authorizationHash` as required while a request has
  no approval: B09 keeps the proposal and the approved intent apart and the DTO says which basis it shows (`amountsBasis`).
- **Q-B09-3** No registry command exists for: recording a reviewed fiscal profile version, rejecting a refund, creating or
  retiring a standing refund policy, resolving a reconciliation case, qualifying or suspending a route, granting or revoking a
  corporate role, or applying the included source replacement (R2-092 is B10's case without a command). B09 provides the schema,
  machines, guards and ports; the matrix assigns them to B10, B12, B15 and B16. Should they be catalogue commands?
- **Q-B09-4** The webhook freshness window has no policy value (proposal: 300 s, a deployment setting of the verifier).
- **Q-B09-5** PaymentAttempt.operation WITHDRAW has no order; B09 refuses it and leaves merchant withdrawals to B15's settlement
  design.
- **Q-B09-6** CMD035's runtime identity (FISCAL_SERVICE): B09's drafter runs as `kauro_payment`; B15 decides whether issuance
  shares it or gets its own group.
- **Q-B09-7** Partial reversals (a partial chargeback) have no representation in CaptureFact (REVERSED is whole).
- **Q-B09-8** The fiscal treatment of a chargeback (credit note or not) is the accountant's decision; B09 posts the ledger reversal
  only.
- **Q-B09-9** B06's owner table assigned CostGrant `actual_authorization_and_funding` to B09; nothing in B09's scope funds cost
  grants. Interim: re-assigned to B03 (grants) with the owner's funding evidence of B12 (B09-F17).
- **Q-B09-10** `evidenceRef` of CMD031 names an evidence artifact of the agency's scope whose store is another package's (support
  or upload); B09 stores the reference opaquely.
- **Q-B09-11** Honoring a capture completed after price expiry when the reviewed tax rule changed in between (D-AUTH-B3 treats it
  as not honorable: remedy refund and new quote).
- **Q-B09-12** Segregation of duties for refunds (D-AUTHZ-B2) is a decision, not an authority statement; a single-owner company
  may need an exception path.
- **Q-B09-13** Resolved by the foundation (migration 0008, FOUNDATION D-AGGK-1..5): B09 registers its eight kinds as rows and
  grants its payment service a read policy of its own; the integrator renumbers the second of B07/B09 to merge (§15).
- **Q-B09-14** 07 "Connection budget and operating limits" allots the api four connections per instance; serving the payment
  service's routes and settle steps and the webhook ingress adds a `kauro_payment` and a `kauro_ingress` pool (§8.2). The budget
  must be recalculated (a material capacity change, 07), or the service surface moved to its own entrypoint.
- **Q-B09-15** A delivered (or consumed) purchase keeps its quote ACCEPTED_FOR_CHECKOUT: 16 "Billable unit and fairness" makes a
  project one purchased revision, and "Once execution has begun, a customer-driven revision is separately assessed. Prior payment
  is credited or refunded". Whether a post-execution customer revision is a new quote of the same project (with a recorded credit)
  or a new project is B10's scope-change decision; interim: a new project.
- **Q-B09-16** A tax-only refund (a corrected fiscal treatment after the sale) has no flow: the cumulative rule (D-REF-B6) releases
  tax only with service. Interim: refused; the correction is a fiscal document decision of B15 with professional review.
- **Q-B09-17** The dispute workflow (provider case id, response deadline, evidence package, submission, outcome, owner assignment)
  is B15's (D-DISPUTE-B1); should a dispute be an aggregate of its own with a registry machine?
- **Q-B09-18** DEBIT_NOTE: no flow defines its basis (an upward correction is a new accepted scope, 15 "Price and source expiry
  races": "An additional fee requires a new accepted scope"); validation is refused until one does (D-FISC-B5).
- **Q-B09-19** Deliverable capacity at checkout (D-CAP-B1) is read, not reserved: the reservation is B08's at consumption
  (CMD036). If a paid purchase then finds no capacity, 15 "Capture and authority" ("The execution reservation must already cover the
  committed delivery") suggests a reservation at capture; B08 decides whether its admission holds capacity from the capture.
- **Q-B09-20** A retroactive fiscal re-review (a new version whose validity starts before a sale already invoiced) leaves the sale's
  documents under the version in force at the time (D-FISC-B4); correcting issued documents to the new treatment is a
  professional decision (credit/debit documents, B15).

## 14. Implementation mandates and verification

Three parallel mandates from this branch's head, separated by the ports fixed here (the structured handoff carries each one
self-contained): **M1 persistence** — the `pg` adapters of every commerce port (including `PurchaseRebindingRepository`,
`ProviderExceptionRepository`, `PricePolicyRepository`, the versioned `observeFunds` / `observeFee`, `fileServerRequest` with ON
CONFLICT DO NOTHING, `profileInForceAt`), the commerce unit of work (adoptScope, adoptFinanceScope, finance binding, the SERVICE
factory on the payment pool), the journal's UNCERTAIN path, the harness fixtures, the B06 inspectors' commercial queries and B07's
`CommercialScopeInspector` query; **M2 domain services and authorization** — `CommerceAuthorizer`, `CommerceReconciler` (§6.3),
`PurchaseRebinder` (D-QUOTE-B6) and the three `CommerceEventConsumer`s (FINANCE with fee, funds and correction postings; FISCAL
under the profile in force; PAYMENT_SERVICE), the fiscal treatment and ledger flows, D-AUTH-B3; **M3 application and api** — the
seven handlers on the provider-effect runtime (T1..T4, T3 in a SERVICE unit of work), the reads, the webhook ingress route, the
labelled contract fakes (providers, and the platform ports of B07 and B08), serving the routes (OpenAPI `paths`, matrix served
sections, applicability rows) and the command-level case tests of the case map. Each codes against the ports of this branch; the
database-backed tests of M2 and M3 run on the integration of M1 (the integrator merges M1, then M2, then M3, as B06 did).

Verification of this branch: `pnpm run verify` (generate, build, typecheck, test, arch, openapi, matrix, clean-consume) green on
Windows; the persistence suite applies 0001..0013 from empty on PostgreSQL 17 in every test file through the B06 runner and runs
the 16 B09 schema tests, the 14 critique tests and every B06 and foundation test; no temporary cluster is left running.

## 15. Integration obligations

What the integrator must wire when `b07/design`'s implementation and this package are both on `main` (read from
`b07/design:docs/design/B07-upload-source-lifecycle.md`; that branch is never edited from here). Neither package references the
other's tables; each port below is the seam.

1. **Migration numbering** (FOUNDATION D-AGGK-5): B07 numbers 0009..0012 and B09 0009..0013 on their branches. The second to merge
   is renumbered (git mv) before any shared database applies it, and every reference is updated: `packages/persistence/test/
   migrations.test.ts` (the file list), the case maps, the design documents, `tools/matrix.mjs` (the database line), and the
   migration headers. The runner's contiguity and checksums make a missed renumbering fail loudly.
2. **The shared aggregate-kind registry** (foundation 0008): both packages INSERT their kinds (B07: `upload_session`,
   `retention_record`, …; B09: the eight of §9); the foundation's test 4 lists the event inserters — the integrator merges both
   extensions (B09 adds `kauro_payment`; B07's D-CTRL-2 adds `kauro_control` with its own `aggregate_kinds_read_b07_control`), and
   `@kauro/domain` `AGGREGATE_KINDS` spreads both packages' kinds. The persistence test proves the registry equals the domain list.
3. **Event types** (FOUNDATION Q-AGGK-2): both packages extend `kauro.event_types` by lifting FORCE RLS inside their own migration;
   `EVENT_TYPES`, `EVENT_PAYLOAD_ALLOWLIST` and `EVENT_SUBSCRIPTIONS` of `@kauro/domain` model/events.ts merge both lists (B07's
   `CONSUMERS` and B09's `COMMERCE_CONSUMERS`).
4. **SQLSTATE and reasons** (`packages/persistence/src/sqlstate.ts`, `@kauro/domain` errors): B07 adds KA070..KA072, B09 KP001..KP013
   — disjoint classes, both entries kept; `FAILURE_REASONS` concatenates both packages' reasons (no shared token; the application
   test proves every outcome names a registered reason).
5. **B07 → B09 ports**: `SourceAvailabilityReader` (D-QUOTE-B7: B07's retention record of the sealed revision — effective and hard
   deadline) and `SourceLineageReader` (D-QUOTE-B6: B07's lineage with its evidence hash) are implemented by B07's persistence over
   its `retention_records` and `dataset_revisions` lineage and bound in the api composition; the contract fakes of M3 are removed
   from the product wiring. After both merge, the integrator may add the exact database binding of `quotes.source_available_until`
   to the retention record's effective deadline (a trigger in a new migration reading `retention_records`), keeping
   `quotes_source_binding` as the bound.
6. **B09 → B07 port**: B07's `CommercialScopeInspector.authorizationsBoundTo(uow, agencyId, revisionId)` (its CMD012 impact map) is
   implemented by B09's persistence (M1: the live commercial authorizations whose `revision_hash` is the revision's manifest hash) and
   bound in the composition; B07's case-map row "Commercial authorizations bound to a replaced revision" then cites B09's test.
7. **Events one consumes from the other**: `dataset_revision.expired.v1` and `.superseded.v1` (B07) reach EXECUTION_CONTROL (B08);
   B09 needs no subscription (it reads the revision state and deadline in T1 and at issuance under the transition lock). B09's
   `capture.completed.v1` anchors paid retention (policy `retention.paidDaysHardFromCapture`): the retention owner (B07's
   STORAGE_LIFECYCLE, or B08 per its design) subscribes to it when it implements PAID_ORDINARY records; B09 publishes it once per
   capture (D-EVT-B2), so a single subscription suffices.
8. **Served route inventory, OpenAPI and matrix**: `tools/openapi.mjs` documents B07's served routes under `paths` and B09's planned
   operations under `x-kauro-planned` (then `paths` when M3 serves them); `tools/matrix.mjs` merges B07's four machines and owner
   rows (the DatasetRevision owners B07 revised) with B09's twelve machines and the CostGrant re-assignment (B09-F17); both
   documents are regenerated (`pnpm run openapi:generate`, `pnpm run matrix:generate`) on the merged tree and checked by verify.
9. **Persistence harness and fixtures** (`@kauro/persistence/testing`): B07 adds the source-lifecycle fixture (`sealSourceRevision`,
   …) and B09 the payment login, pool and contexts; both extend `harness.ts`, `temporary-postgres.ts` (logins) and `index.ts`. B09's
   commerce fixtures (`test/commerce-support.ts`) seal sources through B06's `sealedSource` and `replacementSource`; after the merge
   they should seal through B07's fixture so that the retention record exists (the exact source binding of item 5 needs it).
10. **Runtime boundary matrix** (`test/fixtures/runtime-boundary.json`): regenerated from the merged catalog and reviewed; every
    entry of each package must be unchanged except the ones item 2 names.
11. **B08 edges and ports**: B08's migration grants its execution-control role the consumption edges of
    `commercial_authorizations` (UPDATE of `state`, `version`, `job_ref`, `consumed_at`, `delivered_at`, `updated_at` with USING
    `state IN ('ACTIVE','CONSUMED')` and WITH CHECK `state IN ('CONSUMED','DELIVERED')`) — B09 grants no runtime role those edges
    (D-AUTH-B4); B08 implements `DeliveryCapacityPort` (D-CAP-B1).
12. **B10 ports and commands**: CMD027 issues quotes with `source_available_until` from `SourceAvailabilityReader` and, for the
    included replacement (R2-092), a replacement quote (`replaces_quote_id`) and then calls `PurchaseRebinder`.

## 16. Critique record

Every finding of the adversarial review (`critic_B09.json`, run against `8a282bc`) and what this revision did with it. FIXED
findings name the files changed and the test that fails without the fix; the tests are in
`packages/persistence/test/b09-critique.test.ts` (database, through the runtime login roles), `packages/domain/test/
commerce-critique.test.ts`, `packages/application/test/commerce-contracts.test.ts` and `tools/test/`.

| finding | severity | disposition | evidence |
|---|---|---|---|
| B09-F1 request handlers mint provider facts and authority | BLOCKING | FIXED (D-AUTH-B4, D-PROTO-B5) | 0011 policies and column grants (tenant intent/claim only; payment writes captures, observations, results, authorizations), 0012 (no tenant case opening), 0009 scope policies; `protocol.ts` T3/T4, `contracts.ts` `settleRuntimeRole`; fixtures settle T3 as the payment service. Test "B09-F1: the request handlers cannot mint provider facts or execution authority …" performs P1 and every other forbidden write as `kauro_app_test` (42501 or no row) |
| B09-F2 a paid, unentitled or refunded purchase locks the project | MAJOR | FIXED (D-QUOTE-B4, D-QUOTE-B6) | 0012 `quotes_release_guard` (closed purchase or re-bound), 0010 replacement quotes, 0011 `purchase_rebindings` + guard + completeness + authorization re-binding; domain `quoteRelease`, `replacementBlockers`; port `PurchaseRebinder`. Tests "B09-F2 (remedy path): …" (P2 reproduced, then released) and "B09-F2 (replacement path): …" |
| B09-F3 two server refund requests abort the reconcile | MAJOR | FIXED (D-REF-B1) | 0012 `refunds_one_requested_per_origin`; port `fileServerRequest`. Test "B09-F3: an overpaid capture whose subject no longer binds files its EXCESS_CAPTURE and KAURO_REMEDY requests …" (P6 reproduced, committed) |
| B09-F4 invoice unvalidatable after a re-review | MAJOR | FIXED (D-FISC-B4) | 0013 `tax_documents_validation_guard` (in force at the tax point); domain `profileInForceAt`, `resolveFiscalTreatment`; port `profileInForceAt`. Tests "B09-F4: an invoice validates under the profile version in force …" (P3 reproduced, validates) and domain "B09-F4 (D-FISC-B4): …" |
| B09-F5 no deliverable-capacity precondition | MAJOR | FIXED (D-CAP-B1) | domain `checkoutBlockers` (DELIVERY_CAPACITY_UNAVAILABLE → CAPACITY_UNAVAILABLE), `DeliveryCapacityPort` (B08 adapter), outcomes of CMD028/CMD029. Tests domain "B09-F5 (D-CAP-B1): …", application "B09-F1/B09-F5/B09-F6: …"; the command DENY test is planned in the case map (M3, labelled fake) |
| B09-F6 partial-refund tax allocation unspecified | MAJOR | FIXED (D-REF-B6) | domain `taxRemainingAfter`, `refundTaxFor`, `checkRefundTax`; 0012 `kauro.refund_tax_remaining` + ceiling (KP012); outcome REFUND_TAX_INCONSISTENT. Tests domain "B09-F6 (D-REF-B6): … 19% rule … one-cent sequence …" and database "B09-F6: an approval whose tax does not follow its service …" |
| B09-F7 mapped titles miss the registry DENY/RACE scenarios | MAJOR | FIXED (D-CASEMAP-B1) | `docs/design/B09-case-map.md` (every CMD028–CMD034 DENY and RACE title states the scenario), §8 triads. Test `tools/test/b09-case-map.test.mjs` "B09-F7: …" (fails on the reviewed case map) |
| B09-F8 a later fee re-publishes capture.completed.v1 | MAJOR | FIXED (D-EVT-B2) | event types `capture.fee_observed.v1`, `capture.funds_observed.v1` (FINANCE only); 0011 funds no longer version-exempt, `domain_events_capture_completed_once`. Tests "B09-F8/B09-F15: a funds availability and a fee learned after the completion are capture versions …" and domain "B09-F8/B09-F15 (D-EVT-B2): …" |
| B09-F9 mismatches outside the webhook have no exception; vocabularies differ | MAJOR | FIXED (D-ING-B3) | 0012 `provider_event_exceptions` source-agnostic (webhook, attempt or artifact; attribution), kinds + WRONG_PROVIDER, WRONG_ORDER; domain `PROVIDER_EXCEPTION_KINDS`, `CAPTURE_MISMATCHES`; port `ProviderExceptionRepository`. Tests "B09-F9: a mismatched capture response …" and domain "B09-F9 (D-ING-B3): …" |
| B09-F10 quote under an unknown policy unchecked | MINOR | FIXED (D-QUOTE-B5, D-QUOTE-B7) | 0010 `price_policies`, policy foreign keys, `quotes_source_window`, `quotes_source_binding`, snapshot `as_of` = `issued_at`; ports `SourceAvailabilityReader`. Test "B09-F10: a quote under an unknown price policy …" (P4 reproduced, refused) |
| B09-F11 scope rows unbound; tenant squats provider identities | MINOR | FIXED (D-SCOPE-B2) | 0009 subject columns and tenant policy, 0011/0012 composite keys, 0012 `commerce_scopes_bind_key`. Test "B09-F11: the request handlers cannot claim a provider identity …" (P5 reproduced, refused) |
| B09-F12 time-zone dependent intervals | MINOR | FIXED (D-TIME-B1) | 0010 CHECKs in `336 hours` / `8760 hours`. Test "B09-F12: the fourteen-day price expiry is 1,209,600 seconds under any session TimeZone …" |
| B09-F13 CMD034-OK mapped to an unraisable FEE_MISMATCH | MINOR | FIXED | case map CMD034-OK now maps AMOUNT_MISMATCH (a partial capture of the stored query), §CMD034 specifies the fee comparison CMD034 does perform (PROVIDER_INCONSISTENCY) and leaves FEE_MISMATCH to B15's settlement comparison |
| B09-F14 disputes unmodeled | MINOR | FIXED (D-DISPUTE-B1; workflow to B15, Q-B09-17) | 0012 kind DISPUTE_OPEN (+ subject CHECK); provider kinds DISPUTE_OPENED / DISPUTE_CLOSED, `ObservedDispute`. Test "B09-F14: a dispute in progress opens DISPUTE_OPEN …" |
| B09-F15 postings without observed date; no funds or correction source | MINOR | FIXED (D-LEDGER-B4, D-EVT-B2); PARTIALLY REJECTED | 0013 `observed_at`, `ledger_entries_source_event`, FUNDS kind; domain `fundsPostings`. Test "B09-F15: every posting carries its observed date …". Rejected in part: the claim that "source_kind CORRECTION is allowed only for settlement sources" does not hold on 8a282bc (`ledger_entries_source_scope` admitted CORRECTION with an event source: `source_kind <> 'SETTLEMENT'`); what was missing was the event that sources it, now `reconciliation_case.resolved.v1` |
| B09-F16 credit/debit note validation incomplete | MINOR | FIXED (D-FISC-B5, Q-B09-18) | 0013 validation guard (credit note = corrected ISSUED invoice's snapshot; debit note refused). Test "B09-F16: a debit note never validates …" |
| B09-F17 matrix assigns CostGrant funding to B09 | MINOR | FIXED (Q-B09-9) | `tools/matrix.mjs` owner B03 with the reason, regenerated matrix. Test `tools/test/matrix.test.mjs` "B09-F17: …" |

Revert proofs (each database fix undone in place in its migration, `dist/test/b09-critique.test.js` run on a fresh PostgreSQL 17
cluster, the file restored byte for byte and checked by SHA-256): the tenant's capture policy widened to FOR ALL with INSERT and
UPDATE fails "B09-F1"; the release guard's refund test replaced by `true` fails "B09-F2 (remedy path)", its re-binding branch
disabled fails "B09-F2 (replacement path)"; the per-origin request index narrowed to the capture fails "B09-F3" (and the two tests
that file server requests); the validation guard requiring the current profile fails "B09-F4" and "B09-F16"; the KP012 check
disabled fails "B09-F6"; `domain_events_capture_completed_once` dropped, or `funds_state` exempted from the version bump again,
fails "B09-F8/B09-F15"; WRONG_PROVIDER and WRONG_ORDER removed from the exception kinds fails "B09-F9"; the price policy foreign key
dropped fails "B09-F10"; the scope key binding disabled fails "B09-F11"; `interval '336 hours'` back to `'14 days'` fails
"B09-F12"; DISPUTE_OPEN removed fails "B09-F14"; the ledger source binding disabled fails "B09-F15" and "B09-F8/B09-F15"; a debit
note validated fails "B09-F16". The case-map test fails on the reviewed case map (`8a282bc`) with "CMD028-DENY: no cited test
demonstrates the scenario …". Every other critique test stays green under each mutation.
