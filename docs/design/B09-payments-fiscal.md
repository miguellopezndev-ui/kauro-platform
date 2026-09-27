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
source lifecycle (B07), whose design is read from `b07/design` (never edited here). A second revision closes the residual findings
of the independent re-check, B09-N1..B09-N8 (§16): the event each version publishes and who may publish it (D-EVT-B3), the closed
views' vocabularies, the out-of-order reversal (D-PAY-B5), the provider balance a posting takes money from (D-LEDGER-B5), the
fiscal version of a sale (D-FISC-B6), the attempt's order binding (D-BIND-B2), the claim's deadline (D-PROTO-B6) and the staged,
self-contained implementation mandates (§14, D-STAGE-B1).

Everything here is quoted from the authority (manual and section named, e.g. 15 "Capture and authority"; `reference/` files by
name; B06 decisions as "B06 D-…"; the foundation's as "FOUNDATION D-AGGK-…") or is a recorded decision of this package (`D-…-B…`,
register §12) with its rationale. Where the authority is silent or contradicts itself, the decision says so and §13 lists the
question to return to the authority. English only; the brand is Kauro (amendment A2) — the vendored registry stays byte-identical,
and the owner role it names under the pre-A2 brand is written KAURO_OWNER everywhere this package names it.

| delivered on this branch | left to the implementation mandates (§14) |
|---|---|
| `packages/persistence/migrations/0009..0013`: roles, tables, composite keys, state machines, triggers, RLS and grants of the whole workflow, the B09 rows of the shared aggregate-kind registry, the event bindings and subscriptions of the commerce events, applied from empty by the B06 runner and tested on PostgreSQL 17 (`test/b09-migrations.test.ts`, 16 tests; `test/b09-critique.test.ts`, 20 tests reproducing every probe of the review and of the re-check; the B06 and foundation suites extended where they enumerate runtime roles, event inserters or migrations) | stage 1: the `pg` adapters of the commerce ports, the commerce unit of work, the journal's UNCERTAIN path, the harness fixtures (M1) |
| `@kauro/domain` commerce model: records, money and pricing arithmetic, fiscal treatment (the profile in force at a tax point, the version of a sale), capture allocation, refund arithmetic and authority (the cumulative tax rule), the quote's release and re-binding predicates, ledger postings by provider balance, provider vocabulary and the claim's deadline bound, principals, the ten platform machines, the event vocabulary with the event each version publishes and who may publish it, failure reasons, repository ports | stage 1: the commerce core — planners, the reconciler, the provider-effect runtime, the authorizer — and the labelled contract fakes (M2) |
| `@kauro/application` commerce contracts: the seven command specs (with the settle step's runtime role), closed request schemas, closed response schemas and DTO views derived from the domain's vocabularies, outcome catalogues, provider / fiscal / evidence / service ports, the platform ports of B07 and B08 (source availability and lineage, delivery capacity), the provider-effect protocol types (T1..T4) | stage 2: the payment service's side — T3 wiring, webhook ingress and application, CMD033, CMD034, the consumers, the re-binder (M3); the request side — CMD028, CMD029, CMD031, CMD032, the reads and their routes (M4) |
| the generated OpenAPI document documents the eleven B09 operations as `x-kauro-planned`; the generated matrix owns every edge of the twelve B09 machines | serving the routes moves them into `paths` and into the matrix's served sections (M3, M4) |

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
| runtime roles `kauro_app`, `kauro_control`, `kauro_assurance`, `kauro_validator`, `kauro_ingress` | the agency's intents under `kauro_app`; the ingress half of the webhook under `kauro_ingress` (B06 D-ING-1, PgInboxIngress); platform configuration under `kauro_control` | one new group `kauro_payment` (the payment service), created by 0009 with the same NOSUPERUSER/NOBYPASSRLS checks; `RUNTIME_ROLES` lists it; it is the only writer of provider-observed facts and entitlements (D-AUTH-B4), and the request handlers publish only their own edges' events (restrictive `domain_events_commerce_request_handlers`, D-EVT-B3) |
| pipeline authenticate → access decision → journal reserve/replay → assurance → execute (B06 D-PIPE-1) | unchanged order for every command, including the provider-effect protocol's T1 (§6.1) | the commerce authorizer for the principals B06 denies by default (operator, service, provider) (§3.4) |
| command journal (B06 D-IDEM-1..3) | idempotency of CMD028, CMD029, CMD031–CMD034; the orders, attempts and refunds name their journal entry (`intent_entry_id`) for resume | a provider effect of unknown outcome leaves the entry UNCERTAIN (the B06 guard admits RESERVED → UNCERTAIN → COMMITTED; the adapter gains the path, D-JOURNAL-B1); the journal is completed by the command's own principal in T4 after the payment service settled T3 (D-PROTO-B5); an operator's entry is identity-owned (`agency_id` NULL, D-IDEM-B2) |
| outbox, inbox, D-ING locks (B06 D-OUTBOX-1, D-ING-1/2) | every commerce event has its outbox rows; the provider inbox dedupes webhook deliveries by provider, environment and event id | the payment service is the consumer of payment providers' inbox records (KA012, KA007, READ COMMITTED); an observation no order can take becomes a provider event exception from any source (D-ING-B1..B3); a commerce event's outbox records go only to its registered consumers (`kauro.commerce_event_subscriptions`, restrictive `outbox_records_commerce_subscribers`; D-EVT-B3) |
| security facts (agency / identity / anonymous streams, B06 D-FACT-1) | operator facts go to the operator's identity stream with `requested_agency_id`; agency commands to the agency stream | the payment service's and the ingress's own facts: `agency_id` NULL, actor SERVICE, or ANONYMOUS for an unverified delivery (D-FACT-B1) |
| registry guards: `state_machines`, `state_transitions`, `enforce_initial_state`, `enforce_listed_transition` (B06 D-INIT-1) | every B09 table with a state seeds its machine and guards birth and edges | `_of` variants for a state column not named `state`; `enforce_observed_birth` for a provider fact (D-INIT-B1) |
| event-per-version, the foundation's registry `kauro.aggregate_kinds` and table-driven binding (FOUNDATION D-AGGK-1..5) | every versioned commerce aggregate: its kind is one INSERT in the migration that creates its table (quote 0010; payment_order, payment_attempt, capture, commercial_authorization 0011; refund, reconciliation_case 0012; tax_document 0013), and B06's `require_event_for_version` on its table | `kauro_payment` reads the registry through its own policy `aggregate_kinds_read_b09_payment` (FOUNDATION §4); no edit of 0008, of the foreign key or of the binding (D-EVT-B1); beside them, each commerce event type is bound to its kind and to the state or provider fact its version records (`kauro.commerce_event_bindings`, `domain_events_commerce_kind`, the `*_event_type_per_version` triggers; D-EVT-B3) |
| composite foreign keys, scoped uniqueness (08 "Database isolation") | every commerce row carries `agency_id` and names its parents with `agency_id` in the key | binding UNIQUE targets added to B06 tables (plans, projects, approvals, command_journal, inbox_records, domain_events) so copies of a subject are the original's (D-BIND-B1) |
| transition locks (B06 D-TX-2) | commerce commands read agency, capability, source, target under B06's transition locks | new transition subjects: quotes, capture facts, commercial authorizations, fiscal profiles, fiscal issuers, payment routes, corporate grants, and the withdrawal of an approval (D-TX-B1) |
| closed response schemas validated at runtime, registry-derived views (B06 D-RESP-1), outcome catalogues (B06 D-OUT-1), error contract (B06 D-API-1, D-LABEL-1) | B09 views are `ViewDefinition`s compiled by `viewSchemaOf`, refusing forbidden members and open objects; catalogues compose `ROUTE_OUTCOME_FRAGMENTS` | the KP SQLSTATE class and 49 commerce failure reasons (§7) |
| generated OpenAPI and matrix (`tools/openapi.mjs`, `tools/matrix.mjs`, both in `pnpm run verify`) | the B09 machines' edges are owned; the B09 routes are generated | `x-kauro-planned` operations until served (with `x-kauro-settle-runtime-role`); the checks refuse a planned route that is registered or also served (D-API-B1) |
| test helpers `@kauro/persistence/testing` | the harness and its fixtures | a `kauro_payment_test` login, the payment pool and factory, `service()` and `operator()` contexts; commerce fixtures in `test/commerce-support.ts` (T1/T2 by the request handlers, T3 by the payment service) |

B06 objects B09 alters (all additive; the B06 and foundation suites run unchanged except where they enumerated migrations, roles,
machines, the guard triggers' names — now also their `_of` and observed-birth forms —, the event inserters that read the registry
(the foundation's test 4, extended with `kauro_payment` as FOUNDATION §4 prescribes) or, in CMD010's DENY test, asserted that no
refund table exists — it now asserts that the refund tables hold no row): `domain_events` (new UNIQUE `(event_id, agency_id)`; the
partial unique index `domain_events_capture_completed_once`, keyed on the capture it records; the trigger
`domain_events_commerce_kind`; the restrictive policy `domain_events_commerce_request_handlers`), `outbox_records` (the restrictive
policy `outbox_records_commerce_subscribers`), `event_types` (49 rows, seeded under a transaction-local lifting of
FORCE RLS; FOUNDATION Q-AGGK-2), `aggregate_kinds` (eight rows and one read policy), `plans`, `projects`, `approvals`,
`command_journal`, `inbox_records` (UNIQUE binding targets), `approvals` (transition-lock trigger on `withdrawn_at`), and
policies/grants for `kauro_payment`, the finance scope and the ingress on `agencies`, `projects`, `plans`, `approvals`,
`dataset_revisions` (with `supersedes_revision_id`, the lineage a re-binding checks), `target_contracts`, `capabilities`,
`domain_events`, `outbox_records`, `command_journal`, `security_events`, `inbox_records`, `inbox_body_conflicts`. The reviewed
runtime-boundary matrix (`packages/persistence/test/fixtures/runtime-boundary.json`) was regenerated from the catalog: every
entry of `main` (B06 and the foundation) is byte-identical, the rest is B09's (the second revision adds only the SELECT grants and
read policies of the two vocabulary tables and the two restrictive policies; the file prints a policy's command, roles and
expressions, not whether it is restrictive — the migration names it `AS RESTRICTIVE`).

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
`b09-critique.test.ts` "B09-F1: …" performs each forbidden write as `kauro_app_test` and sees it refused. The events are bound the
same way (D-EVT-B3; B09-N1): the request handlers publish only the event types of their own edges — an agency member the quote
lifecycle, the intent and claim of a provider effect and its refund request; a corporate owner a refund's review and a case's
resolution —, every other commerce type is the payment service's (or, for consumption and delivery, B08's), and every event
records exactly what its version records; "B09-N1: …" publishes every other type as `kauro_app_test` and sees it refused.

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
| `commerce_event_bindings` (0009) | every commerce event type: the aggregate kind it records (its `<kind>.` prefix), the state — or, for a capture's later facts, the fact FEE / FUNDS — of the version it records, and the request handlers' principal that authors it (TENANT, OPERATOR, or none: the payment service; D-EVT-B3) | migration-owned, append-only; mirrors `COMMERCE_STATE_EVENT_TYPES` and `COMMERCE_REQUEST_HANDLER_EVENT_TYPES` (the persistence test proves equality); read by `domain_events_commerce_request_handlers` and `kauro.require_commerce_event_type` | migrations only; app and payment read |
| `commerce_event_subscriptions` (0009) | the registered consumers of each commerce event type | migration-owned, append-only; mirrors `COMMERCE_EVENT_SUBSCRIPTIONS`; an outbox record of a commerce event goes only to one of them (`outbox_records_commerce_subscribers`) | migrations only; app and payment read |

### 4.2 Fiscal profile, quote, eligibility snapshot (0010)

**fiscal_profiles** (registry FiscalProfile; 15 "FiscalProfile"; D-FISC-B1): one reviewed version per row — operator legal ref
(an issuer), customer legal ref, classification, territory, `tax_treatment` (REVIEW_REQUIRED, DOMESTIC_TAXABLE, EXEMPT_EXPORT,
OTHER_REVIEWED), `tax_rule` (UNRESOLVED, RATE_HALF_UP, ZERO_REVIEWED) and `tax_rate_bps`, evidence, reviewer, validity,
supersession. Rules: REVIEW_REQUIRED ⇔ UNRESOLVED with rate 0 (the explicit unknown carries no rule); DOMESTIC_TAXABLE is a
positive rate; EXEMPT_EXPORT is a reviewed zero that requires `export_evidence_hash` (R2-128: "The adapter cannot infer export
exemption from currency or foreign email"; 15: "A foreign customer's address alone does not establish …"); a reviewed treatment
names its reviewer; one current (unsuperseded) profile per agency; supersession once, under the agency's transition lock, at
exactly the instant the successor is recorded (`fiscal_profiles_successor_fk`), in one lineage per agency
(`fiscal_profiles_supersession_lineage`: a version is superseded only by its successor, only the first version supersedes
nothing) — so the version *current* at an instant (recorded by then, not superseded by then) is unique. A version is *in force* at
an instant when its validity window covers it and it had not been superseded by then (D-FISC-B4). One rule decides the version of
every document of a sale (D-FISC-B6; B09-N5): a new quote reads the current version (`quotableTaxRule`); the documents of a sale
take the version of the sale's tax point — the capture's completion, never a refund's — chosen by `saleProfileAt`: the version
current at the tax point while it carries a reviewed treatment, else the latest-recorded reviewed version in force at it (a later
review whose validity reaches back to the sale resolves an unknown treatment for it; it never changes a known one), else the
unknown itself (a blocked draft). The invoice is drafted under that version and every credit note carries exactly the corrected
invoice's snapshot (§4.5).
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
the dispatch deadline set once with DISPATCHING — in the future and at most DISPATCH_DEADLINE_SECONDS (60) ahead of the claim,
whoever claims (`payment_attempts_dispatch_deadline_bound`, D-PROTO-B6; B09-N7) —, evidence for PROVIDER_PENDING / CONFIRMED /
FAILED_NO_EFFECT, an outcome token
for FAILED_NO_EFFECT / UNCERTAIN / CANCELLED_BEFORE_DISPATCH. One live and one CONFIRMED attempt per logical operation; ordinal
n > 1 only after attempt n−1 proved no effect (KA008, D-PROTO-B3). A REFUND attempt names its refund of the same order, and every
row that names an attempt — an observation, a capture fact, a provider exception — names an attempt of its own order
(`payment_attempts_order_binding`; D-BIND-B2, B09-N6). The request
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
S058). Born in the status its first authenticated observation shows (D-INIT-B1: the initial PENDING, or one listed edge away), with
its funds UNKNOWN; moves PENDING → COMPLETED / DENIED, COMPLETED → REVERSED. A reversal returns money that was captured, so a capture
first seen REVERSED — or reversed while known only as PENDING — is recorded COMPLETED and then REVERSED, two versions and two events
in one transaction (D-PAY-B5; B09-N3): its completion is allocated, published and posted, its reversal returns it, and its
completion instant stays its tax point (`capture_facts_completion_time` covers REVERSED). When it completes its amount is allocated
once: `allocated_service + allocated_tax + excess = amount`, PENDING and DENIED allocate nothing; the
allocation never changes afterwards, the observation time never goes back, known funds availability never becomes unknown
(KP005). `kauro.capture_facts_allocate` (AFTER trigger, under the order's row lock): the part applied to the obligation is
exactly min(amount, still owed), and the service and tax paid by all completed captures never exceed the order's (KP002) — the
domain's `allocateCapture` splits cumulatively by largest remainder so partial captures sum exactly to the quoted service and tax
(15 "Summed allocations must equal the total"). `funds_state` UNKNOWN / HELD / AVAILABLE and `provider_fee_cents` are
provider-reported facts learned after the status: each change is a new version with an event of its own —
`capture.funds_observed.v1`, `capture.fee_observed.v1` (FINANCE only) — and `capture.completed.v1` is published exactly once per
capture (`domain_events_capture_completed_once`, keyed on the capture it records; D-EVT-B2, B09-F8, B09-F15). Every capture version
publishes the event of what it records — its status, or the one later fact it learned, never two in one version (D-EVT-B3). The status is a transition subject; a reversal
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
(a repeated observation adds history, never a second case); a case that names several subjects names one purchase — its capture
and its refund are its order's (`reconciliation_cases_capture_order_fk`, `…_refund_order_fk`, `…_refund_capture_fk`; D-BIND-B2,
B09-N6); opened by the payment service only; resolution recorded once by the finance scope, whose event is the source of a
correcting ledger posting set (D-LEDGER-B4).

**provider_event_exceptions** (D-ING-B2, D-ING-B3; B09-F9): an authenticated observation no order can take —
UNKNOWN_PROVIDER_REFERENCE, WRONG_PROVIDER, WRONG_ORDER, WRONG_PAYEE, WRONG_CURRENCY, WRONG_ENVIRONMENT (every CaptureMismatch of
the domain), UNRECOGNIZED_PROVIDER_STATE, BODY_CONFLICT — kept for the owner's review. Its source is exactly one of a delivered
webhook (its inbox record, composite key to its provider and environment; unattributed when it names no known order), a dispatch
response of a stored operation (its attempt) or a stored provider query (its artifact); the latter two are attributed to the stored
operation's order and agency, and a dispatch response's attempt is an attempt of exactly that order
(`provider_event_exceptions_attempt_fk`; D-BIND-B2, B09-N6). One per source and kind; append-only. No money, no commission, no
authority follows from it.

### 4.5 Fiscal documents, ledger, settlements (0013)

**tax_documents** (registry TaxDocument, machine as vendored; 15 "TaxDocument state machine"; D-FISC-B1..B5): INVOICE of a
capture, CREDIT_NOTE of a refund (correcting the invoice), DEBIT_NOTE (schema only). The fiscal snapshot (profile, issuer,
treatment, rule, rate) is exactly the profile's (composite key). An unreviewed treatment is a blocked DRAFT with its concrete
blocker (FISCAL_TREATMENT_UNREVIEWED, FISCAL_PROFILE_NOT_EFFECTIVE, FISCAL_TREATMENT_CHANGED, FISCAL_ISSUER_MISMATCH,
ISSUER_FACTS_UNCONFIRMED) and can move nowhere; a draft is re-pointed at a re-reviewed profile only while DRAFT
(`tax_documents_draft_only`). DRAFT → VALIDATED is re-checked (`tax_documents_validation_guard`, KP011, after the profile's and
the issuer's transition locks): the document's profile is the version in force at the tax point (D-FISC-B4, B09-F4) — its window
covers the sale's tax point and it had not been superseded by then, so a re-review recorded after the sale neither blocks the
sale's invoice nor lends it a treatment that was not in force; a version recorded after the sale is admitted only with the rule
the sale was priced with (it can resolve an unknown treatment, never change a known one; the drafter's choice is `saleProfileAt`,
D-FISC-B6) —, its treatment reviewed, the issuer's facts observed or
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
refund"). The source kind names the event that may source it, and the source reference is that event's own aggregate
(`ledger_entries_source_event`, KP001; B09-N1): CAPTURE `capture.completed.v1`, FEE `capture.fee_observed.v1`, FUNDS
`capture.funds_observed.v1`, CHARGEBACK `capture.reversed.v1` — each an event of the capture named —, REFUND `refund.completed.v1` of
the refund named, CORRECTION `reconciliation_case.resolved.v1` of the case named (the reviewed decision whose reversing and adjusting
entries correct an event-sourced posting) or a settlement's own correction, SETTLEMENT a settlement. The money a capture brought in
sits in one provider balance at a time — PSP_RECEIVABLE, PSP_HELD or PSP_AVAILABLE by its funds state —; every fee, refund and
chargeback posting takes money from the balance its event names (`fundsState`) — at most the capture's movable balance before it
(`movableBalanceCents`), the rest, only ever a fee the provider keeps, from the merchant's available balance (D-LEDGER-B6) —, and a
funds observation moves the capture's movable balance — its amount less the reported fee and the money returned — between them
(D-LEDGER-B5; B09-N4). The database admits a
FUNDS set only on the three provider balances (`ledger_entries_funds_accounts`) and bank money, in transit or cash, only from a
settlement observation (`ledger_entries_bank_accounts`; the bank-available amount itself needs bank evidence).
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
| CaptureFact (D-MACH-B3) | PENDING (observed birth, D-INIT-B1) | provider_completed PENDING→COMPLETED; provider_denied PENDING→DENIED; provider_reversed COMPLETED→REVERSED (a capture first seen reversed is recorded COMPLETED then REVERSED, D-PAY-B5; the fee and funds observations are versions without a state change, D-EVT-B2) |
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
`FiscalRepository` (current profile after its transition lock; `saleProfileAt`, the version of a sale's tax point, D-FISC-B6; issuer
after its lock; `recordProfile` superseding once, at the successor's own instant), `CorporateGrantRepository.activeGrant` (after the grant's lock),
`RefundPolicyRepository`, `PricePolicyRepository`, `ScopeIndex` (record / resolve), `QuoteRepository` (issue with snapshot; CAS
transitions), `PaymentOrderRepository` (insert, `findByIntentEntry`, `findOpenForProject`, CAS transitions with provider ids
learned once), `PaymentAttemptRepository` (prepare, `findLive`, `countFor`, `findByIntentEntry`, CAS transitions),
`CaptureFactRepository` (insert at first observed status with funds UNKNOWN, `advance` one edge per version, versioned `observeFunds`
and `observeFee` — one fact per version —,
`committedRefunds`, `findByProviderCapture`), `ProviderObservationRepository`, `CommercialAuthorizationRepository` (issue,
`findLiveByCapture`, `findLiveByRevisionHash` — the query behind B07's impact map, §15 item 6 —, transitions), `PurchaseRebindingRepository`, `RefundRepository` (request, `fileServerRequest` idempotent per
capture and origin, approve with the immutable intent, transition, `findOpenForCapture(capture, origin)`), `TaxDocumentRepository`
(draft, redraft, transition, live invoice / credit note, blocked drafts), `LedgerRepository.post` (idempotent by source; the source
reference is the event's aggregate; observed date; reversal links), `SettlementRepository`, `ReconciliationCaseRepository.open` (idempotent per kind and subject),
`PaymentInboxRepository` (lock for apply, settle), `ProviderExceptionRepository` (from any source, idempotent per source and
kind). `CommerceUnitOfWork extends UnitOfWork` adds `commerce`, `scopes`, `adoptScope`, `adoptFinanceScope`, `commerceScope`;
`CommerceUnitOfWorkFactory` runs it. Every versioned write is compare-and-swap and answers STALE with the current safe version and
state (B06 D-VER-1); every read of a fact relied on without change happens after that fact's transition lock (B06 D-TX-2); every
version is published with the event `commerceVersionEventType` names (D-EVT-B3), its outbox records addressed to that type's
subscribers only.

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
`CommerceReconciler` (the §6.3 algorithm behind the settle step of CMD028, CMD029 and CMD033, the webhook's application and CMD034 —
implemented by M2 over the column-scoped `PurchasedSubjectReader`, D-CORE-B2, called by M3 and M4), `CommerceEventConsumer` (FINANCE, FISCAL, PAYMENT_SERVICE; §8.1; implemented by M3) and
`PurchaseRebinder` (D-QUOTE-B6, implemented by M3, called by B10's replacement flow). The platform ports of the packages B09 meets at integration (§15; each read inside the
caller's unit of work, never a call outside a transaction; `binding` PLATFORM or CONTRACT_FAKE): `DeliveryCapacityPort` (B08's
admission; D-CAP-B1), `SourceAvailabilityReader` and `SourceLineageReader` (B07's retention records and lineage; D-QUOTE-B7,
D-QUOTE-B6). The provider-effect protocol's phase interface is `ProviderCommandPhases` (`commerce/protocol.ts`, §6.1).

Contract fakes (D-FAKE-B1): until B15, the tests bind fakes of `PaymentProviderAdapter`, `WebhookVerifier`,
`ProviderEvidenceStore`, `FiscalDocumentBridge` and `ServiceAuthenticator` that implement the documented provider contract
(PayPal Orders v2 shapes of 15 "Capture and authority"), declare `integrationClass: "CONTRACT_FAKE"`, live under `test/` or a
`testing` subpath, and are named SIMULATED in the case map; until B07 and B08 are on main, the platform ports are bound to fakes
declaring `binding: "CONTRACT_FAKE"`, named SIMULATED the same way. Every fake has one owner, the stage-1 mandate M2 (§14). The
database refuses a fake route on LIVE; nothing in the
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
   now() + DISPATCH_DEADLINE_SECONDS (DISPATCH_TIMEOUT_SECONDS 30 + DISPATCH_WATCHDOG_MARGIN_SECONDS 30), computed by the database
   in the claim's own statement, never on the claimant's clock — the database refuses any other deadline, in the past or further
   ahead, whoever claims (`payment_attempts_dispatch_deadline_bound`, D-PROTO-B6; B09-N7), so no claimed attempt stays out of the
   watchdog's due set — and the aggregate's own dispatch edge (order CREATING / CAPTURING, refund SUBMITTING). The single serialization point of "dispatch at most once": a loser of the CAS never
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
the capture's shared half, and so does a refund's completion (`refunds_completion_order`, D-REF-B7: the completions of one capture
run in turn, each reading the ones before it); the re-binding takes the replaced entitlement's exclusive half before both. `b09-migrations`
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
5. **Step** (`captureStatusStep`): insert the fact at its observed status with its funds UNKNOWN, or advance it along the lattice,
   one version and one event per edge — an observation of REVERSED for a capture unknown or PENDING walks its completion first
   (`then`: COMPLETED, then REVERSED, in this transaction; D-PAY-B5); on completion, allocate (`allocateCapture`: min(amount, owed)
   to the obligation, split cumulatively, the rest excess). A funds availability or a fee learned after the completion is a new
   version with `capture.funds_observed.v1` / `capture.fee_observed.v1`, one fact per version (D-EVT-B2, D-EVT-B3); a funds
   observation's event carries the capture's movable balance, read after the capture's row lock (FOR UPDATE) so that a refund
   completing concurrently is either seen or ordered after it (D-LEDGER-B5).
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
7. **Events and outbox** — each version's event is the one `commerceVersionEventType` names, a fee's, a refund's completion and a
   reversal's payload name the funds state their money is taken from and the capture's movable balance before it (D-EVT-B3,
   D-LEDGER-B5, D-LEDGER-B6), and the outbox records go to the
   type's subscribers —, the inbox record's settlement (webhook: APPLIED with the result event, IGNORED, REJECTED or RETRYABLE),
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
The guards of the second revision are met only by a writer that bypassed the domain rules, and translate to INTEGRITY_FAILURE:
the event bindings (`domain_events_commerce_kind`, the `*_event_type_per_version` triggers) answer KA003 EVENT_MISSING; the
restrictive policies on `domain_events` and `outbox_records` answer 42501 like every other policy (B06); the adapters of M1
translate by constraint name the checks `payment_attempts_dispatch_deadline_bound` (the claim writes the database's own deadline),
`fiscal_profiles_supersession_lineage` and `fiscal_profiles_successor_fk` (a re-review writes its two instants as one),
`ledger_entries_funds_accounts` and `ledger_entries_bank_accounts` (postings come from `planPostings`) and the attempt keys of
D-BIND-B2 to INTEGRITY_FAILURE rather than to B06's default INVALID_REQUEST.

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
leaves nothing and one after it converges to one effect under the same key — exactly as B06's journal and D-PROTO-B2 define. A
provider-effect command (CMD028, CMD029, CMD033) also injects the crash between the claim (T2) and the settle (T3), after the
provider call, where the resume may only observe by the attempt's request identity and never dispatch again (D-CASEMAP-B1).

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
  IDEMPOTENCY_CONFLICT with no effect; a crash injected before T1 commits leaves nothing; one between T1's commit and T2 resumes to
  one provider order; one between T2 and T3 — after the provider call — resumes by observing the order under the attempt's request
  identity and never creates a second one; two keys: the second T1 fails `payment_orders_one_open_per_project` → PAYMENT_PENDING;
  an ambiguous creation is reconciled by request identity.

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
  no effect; a crash before T1 commits leaves nothing; a crash between T1's commit and T2, one between T2 and T3 (after the provider
  call: the resume observes the capture by the attempt's request identity and never dispatches again) and one between T3 and T4
  converge to one capture and one authorization; capture
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
adjustment follow the event, once each; its payload names the capture's funds state, read after the capture's row lock FOR SHARE,
D-LEDGER-B5); a completion that leaves no service basis revokes the authorization in the same
transaction (KP006, D-REF-B5); AMBIGUOUS → refund UNCERTAIN, attempt UNCERTAIN, 202; PROVED_NO_EFFECT → refund back to APPROVED
(a new deliberate attempt later); definitive refusal → FAILED (the commitment is released). **T4** completes the journal (the
same SERVICE principal).

- **OK**: "Submit once per reconciled provider identity and publish final refund/credit-note/commission events".
- **DENY**: a refund of another agency than the stored operation's (NOT_FOUND by the scope index), a wrong service identity
  (SERVICE_NOT_PERMITTED; another environment: SERVICE_ENVIRONMENT_MISMATCH) and one missing prerequisite (not APPROVED; a reversed
  capture lapses it); "Timeout stays UNCERTAIN with no blind duplicate financial effect": a second execute while UNCERTAIN is
  refused until reconciled; the one-live-attempt index and the request identity make a duplicate dispatch impossible.
- **RACE**: the identical retry resumes the same operation; the same key with another expectedVersion is 409
  IDEMPOTENCY_CONFLICT with no effect; a crash before T1 commits leaves nothing; one between T1's commit and T2 resumes to one
  provider refund; one between T2 and T3 (after the provider call) observes the refund by the attempt's request identity and never
  dispatches it again; two executes: T2's CAS admits one claimant; the other observes the live attempt (PAYMENT_PENDING).

### CMD034 ReconcilePayment — POST /api/v1/payment-orders/{orderId}/reconcile — PAYMENT_SERVICE — scope STORED_OPERATION

Body `{ observationRef }`: a stored, authenticated provider query (the watchdog or the periodic reconciler performed it outside
any transaction and stored it). Access → `adoptScope("PAYMENT_ORDER", id)` → journal → the evidence exists (EVIDENCE_NOT_FOUND)
and is about this order, provider and environment (OBSERVATION_SUBJECT_MISMATCH) → lock order → reconcile (§6.3) including
uncertain attempts (UNCERTAIN → CONFIRMED / FAILED_NO_EFFECT), uncertain refunds (→ COMPLETED / APPROVED / FAILED), order
creation (CREATING → CREATED / FAILED), capture uncertainty, reversals, disputes, funds availability (`funds_state` as reported,
`capture.funds_observed.v1` with the movable balance; never bank cash) and the reported fee (learned once, `capture.fee_observed.v1`; a fee that
differs from a fee already learned is a PROVIDER_INCONSISTENCY case; a statement fee differing is FEE_MISMATCH, B15's settlement
comparison). A capture of the order the query shows with another payee, currency or order is the specific exception with the
artifact as its source (D-ING-B3). 200 `ReconcilePaymentView { order, captures, commercialAuthorization, effects, openCases }`.

- **OK**: "Advance local facts from actual provider state and record mismatch incidents": a stored query advances an uncertain
  capture to CAPTURED with its authorization and records a partial capture of the same query as AMOUNT_MISMATCH.
- **DENY**: an order of another agency than the stored operation's (NOT_FOUND), a wrong service identity (SERVICE_NOT_PERMITTED /
  SERVICE_ENVIRONMENT_MISMATCH) and one missing prerequisite (no stored evidence; evidence of another order): "A provider
  pending/held state is never coerced to settled available cash": funds are HELD/AVAILABLE as reported; bank cash exists only in a
  settlement with bank evidence (`settlements_bank_evidence`, proven), a FUNDS posting touches only the provider balances and no
  event-sourced posting touches bank money (`ledger_entries_funds_accounts`, `ledger_entries_bank_accounts`; B09-N4, proven).
- **RACE**: the identical retry replays; the same key with another observationRef is 409 IDEMPOTENCY_CONFLICT with no effect; a
  crash at the intent/commit boundary leaves nothing and the retry applies the artifact once; reconcile vs webhook vs capture
  settle: the order row lock; observations are monotonic and idempotent per artifact and inbox record.

### 8.1 Consumers (D-CONS-B1)

The payment service runs three consumers of the outbox (B06 dispatch, at least once; each deduplicates by its own durable
identity — 07 "Consumers deduplicate by their own durable inbox identity"):

- **FINANCE** (capture.completed, capture.fee_observed, capture.funds_observed, capture.reversed, refund.completed,
  reconciliation_case.resolved): adopts the event's agency through its order, posts the balanced set (`capturePostings`,
  `providerFeePostings` of the reported fee from the provider balance its event names, `fundsPostings` of the movable balance
  between the provider balances, `returnPostings` from the balance a refund's or reversal's event names — each fee and return up to
  the movable balance its event carries, the kept fee beyond it from the merchant's available balance —, a case's reversing and
  adjusting entries; D-LEDGER-B5, D-LEDGER-B6) with the event as source — the source reference its aggregate — and its observed date; a replay is a no-op (UNIQUE `(event_id, line_no)`). A fee the provider reports after the
  completion is its own event, whose posting set carries only the fee lines; the completion is never re-published (D-EVT-B2).
- **FISCAL** (capture.completed, refund.completed; tax_document.validated / uncertain for B15): drafts the invoice (one live per
  capture) under the version of the sale's tax point — the capture's completion — (`saleProfileAt`; D-FISC-B4, D-FISC-B6) and a
  credit note (one live per refund) with exactly the corrected invoice's snapshot, judged at the sale's tax point, never at the
  refund's completion (D-FISC-B5, B09-N5); resolves the treatment (`resolveFiscalTreatment`), validates or records the blocker; a
  credit note waits for the invoice's issuance; when a profile is re-reviewed, re-evaluates blocked drafts (`listBlockedDrafts`,
  `redraft`: a later review whose validity reaches back to the sale resolves an unknown treatment; it never changes a known one). It does not receive the fee or funds events (they are not a new collection).
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
capture, commercial_authorization, refund, tax_document, reconciliation_case) registered in the foundation's registry. What each
type records and who may publish it is enforced by the database, not only by the code (D-EVT-B3; B09-N1):
`kauro.commerce_event_bindings` binds every type to its aggregate kind and to the state — or, for the capture's later facts, the
fact — its version records, and to the request handlers' principal that authors it (`COMMERCE_STATE_EVENT_TYPES`,
`COMMERCE_REQUEST_HANDLER_EVENT_TYPES`, `commerceVersionEventType`); `domain_events_commerce_kind` refuses a commerce type on another
kind, each commerce table's `*_event_type_per_version` trigger refuses a version whose event is not the one of what it records
(KA003), `domain_events_commerce_request_handlers` refuses `kauro_app` every type its principal does not author (42501), and
`outbox_records_commerce_subscribers` addresses a commerce event's outbox records only to its subscribers
(`kauro.commerce_event_subscriptions`). Payloads
follow B06 D-EVT-2 — ids, hashes, tokens, non-negative integers, booleans; no provider identifiers, no label (the refund's reason
stays on its row), server reasons as tokens (`outcomeCode`, `failureCode`, `revocationCode`, `rejectionCode`, `detailCode`); the
allowlists are `COMMERCE_EVENT_PAYLOAD_ALLOWLIST` (commercial_authorization.issued.v1 names `orderQuoteId` and `rebindingId`;
capture.fee_observed.v1, capture.reversed.v1 and refund.completed.v1 name `fundsState` and `movableBalanceCents`, the balance
their money is taken from and the capture's movable balance before it, D-LEDGER-B5 and D-LEDGER-B6).
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
  second charge: a reversal observed before the capture is recorded as the capture's completion and then its reversal — allocated,
  posted and returned (D-PAY-B5; B09-N3); a reversal revokes with PRE_EXECUTION / DURING_EXECUTION /
  POST_DELIVERY (KP006, phase trigger); the order stays CAPTURED (never charged again); delivered history stays; a dispute in
  progress holds the funds without revoking anything until the provider reverses (D-DISPUTE-B1).
- **S060** a price-valid quote after source deletion → checkout blocked; identical reupload needs a new revision and approval:
  SOURCE_EXPIRED in CMD028/CMD029; the authorization requires the quoted revision SEALED (KP004); a new revision changes the
  revision hash, so the quote (bound to the plan's source) cannot be reused — a new plan approval and quote (B07/B08/B10), or, for
  a paid purchase before execution, the included replacement re-binding the capture (D-QUOTE-B6); a paid capture that can bind
  nothing is refunded as KAURO_REMEDY and then releases its quote (D-QUOTE-B4).
- **R2-077** 129500 at 2500 bps → discount 32375, service 97125: `discountCents`, `kauro.round_half_up_bps`, the quote CHECKs.
- **R2-078** fee 5275, net 91850 (illustration; actual fees replace it): `illustrativeProcessorFee` for the illustration; the
  ledger posts only the provider-reported fee (`providerFeePostings`, sourced by the completion or by `capture.fee_observed.v1`), from
  the provider balance its event names, and the funds move net of it (D-LEDGER-B5); a fee the provider keeps on a full return is
  the merchant's, never a negative receivable of the capture (D-LEDGER-B6).
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
| D-EVT-B2 | A provider fact learned after the capture's status — the funds' availability, the fee — is a new capture version with its own event (`capture.funds_observed.v1`, `capture.fee_observed.v1`) routed to FINANCE only; `capture.completed.v1` is published once per capture (partial unique index on `domain_events`, keyed on the capture) | B09-F8, B09-F15; 15 "Repeated delivery cannot duplicate capture, authorization, refund or commission"; TRANSITIONS "Cross-aggregate finalization" (separate idempotent effects from the same reconciled financial event); CMD030 failure "duplicates do not add money or commissions" |
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
| D-PAY-B5 | A capture first seen REVERSED — or reversed while known only as PENDING — was completed at the provider: it is recorded COMPLETED (allocated, `capture.completed.v1`, the CAPTURE posting, its completion instant as the tax point — the observation's own, never invented, D-PAY-B6) and then REVERSED (`capture.reversed.v1`, the CHARGEBACK posting) in one transaction; the machine has no PENDING → REVERSED edge and a REVERSED birth is refused | S059 "reversal arrives out of order before local capture observation"; the money moved twice; B09-N3; 15 "Operational ledger"; D-INIT-B1 (a REVERSED birth is two edges from the initial state) |
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
| D-FISC-B4 | A document is validated against a profile version in force at the sale's tax point (window covers it, not superseded by then) carrying the rule the sale was priced with; the current version is required only for a new quote; which version a sale's documents take is D-FISC-B6; a re-review that changes the treatment after a sale leaves the sale's documents under the treatment it was priced and in force with (a retroactive correction is a professional decision, Q-B09-20) | B09-F4; registry FiscalProfile validFrom/validUntil; 15 "FiscalProfile" (effective dates, reviewer evidence); registry TaxDocument DRAFT→VALIDATED guard |
| D-FISC-B5 | A credit note carries exactly the fiscal snapshot of the invoice it corrects, which must be ISSUED; a debit note is not validated until a flow defines its basis | B09-F16; 15 "TaxDocument state machine" ("relationship to the original"); Q-B09-18 |
| D-LEDGER-B1 | Posting sets sourced by one event or settlement; idempotent by source; balanced per currency at commit; append-only; reversals mirror | 15 "Operational ledger"; reference/HASHING "Ledger posting and reconciliation" |
| D-LEDGER-B2 | Accounts OPS-1; a capture is contract liability; the actual reported fee is posted, never the illustration | 15 "Revenue recognition…", "actual statement fees replace the illustration" (R2-078) |
| D-LEDGER-B3 | Settlement postings are platform-level and B15's | R2-085 in B15 |
| D-LEDGER-B4 | Every posting carries its observed date; each source kind names the event that may source it; a correction of an event-sourced posting is sourced by the reviewed resolution of its reconciliation case (reversing plus adjusting entries) | B09-F15; 15 "Operational ledger" ("Every posting includes … effective date, observed date … Corrections add reversing/adjusting entries"; "Unexplained differences create a case") |
| D-SETTLE-B1 | Bank-available cash requires bank evidence and cannot exceed withdrawals | 15 "Settlement and withdrawal"; CMD034 failure |
| D-ROUTE-B1 | Merchant and fiscal issuer routes are configuration records qualified with evidence | 15 "Merchant identity and environment are fixed by server configuration"; "Accounting integration decision"; R2-083 |
| D-RPOL-B1 | Standing refund policies are versioned, step-up-authorized records with explicit applicability | CMD032 failure text |
| D-FAKE-B1 | Contract fakes are labelled CONTRACT_FAKE in code and evidence; a fake route can never be LIVE; the platform ports of B07 and B08 are bound to fakes declaring `binding: "CONTRACT_FAKE"` until their package is on main; every fake has one owner, the stage-1 mandate M2 | the task's rule; 21 "Evidence classes" |
| D-BIND-B1 | Binding UNIQUE targets and partial indexes added to B06 tables | 07 "Composite foreign keys … prevent a project … from referencing another agency's revision, quote, package or client" |
| D-TX-B1 | New transition subjects and the global lock order of §6.2 | B06 D-TX-2 extended |
| D-RESP-B1 | B09 views derived under B06 D-RESP-1 with provider identifiers and evidence withheld | 10 "Read endpoints return safe projections"; "Raw sensitive provider responses stay in a restricted reconciliation store" |
| D-OUT-B1 | Route catalogues composed from B06 fragments plus B09 access and command outcomes | B06 D-OUT-1 |
| D-API-B1 | Designed routes are documented as planned operations until served | 10 "OpenAPI is generated from the owning contract registry and checked against actual routes" — a planned route is not an actual route |
| D-CONS-B1 | FINANCE, FISCAL, PAYMENT_SERVICE consumers in the payment service, idempotent by source identity and uniqueness | 07 "Outbox, inbox and event ordering" |
| D-LABEL-B1 | The refund reason is a label: stored and answered, covered by the authorization digest, never in an event | B06 D-API-1, D-LABEL-1 |
| D-CASEMAP-B1 | Every DENY and RACE test title of CMD028–CMD034 in the case map states its registry scenario verbatim (foreign tenant, wrong role or service identity, one missing prerequisite; identical retry, same key with another digest → IDEMPOTENCY_CONFLICT, crash at the intent/commit boundary); the RACE of a provider-effect command (CMD028, CMD029, CMD033) injects the crash on both sides of the intent commit and between the claim and the settle, after the provider call, where only an observation by request identity may follow; `tools/test/b09-case-map.test.mjs` enforces both | B09-F7 (its fix names "a crash injected between intent commit and claim, and between claim and settle"); registry cases.json scenarios; 10 "Contract tests and compatibility" (lost response, external uncertainty); 07 "It must not repeat the external effect under a new key" |
| D-EVT-B3 | An event records one version of one aggregate of its own kind — the state that version reaches or, for a capture version that keeps its status, the one later provider fact it learned (never two) —; the request handlers publish only the event types of their own edges (TENANT: the quote lifecycle, the intent and claim of a provider effect, the refund request; OPERATOR: a refund's review, a case's resolution); a commerce event's outbox records go only to its registered consumers. The database enforces all of it beside B06's event-per-version rule, never by editing B06's or the foundation's objects: `kauro.commerce_event_bindings` and `kauro.commerce_event_subscriptions` (0009), the trigger `domain_events_commerce_kind`, the per-table `*_event_type_per_version` triggers (`kauro.require_commerce_event_type`, KA003), the restrictive policies `domain_events_commerce_request_handlers` and `outbox_records_commerce_subscribers` (42501); the ledger's source binding then trusts the event it names | B09-N1; 07 "Outbox, inbox and event ordering" (an event carries its aggregate ID and version; one event per committed version); 07 "Application checks improve messages but cannot be the sole protection"; 08 "Threat model and assets" (a malicious agency member); registry CaptureFact invariant "Browser claims cannot produce a capture fact"; 15 "Repeated delivery cannot duplicate capture, authorization, refund or commission"; CMD030 failure "duplicates do not add money or commissions"; D-AUTH-B4; FOUNDATION D-AGGK-4 (the binding is not edited) |
| D-LEDGER-B5 | The money of a capture sits in one provider balance at a time, by its funds state (UNKNOWN → PSP_RECEIVABLE, HELD → PSP_HELD, AVAILABLE → PSP_AVAILABLE); a fee, a refund and a chargeback are taken from the balance their event names (`fundsState` in the payload, read under the capture's row lock) — up to the capture's movable balance before them, the kept fee beyond it from the merchant's available balance (D-LEDGER-B6) —, and a funds observation moves the capture's movable balance — its amount less the reported fee and the money returned, never below zero — between the balances; every amount is fixed by its event, so the balances do not depend on the order of delivery; the database admits a FUNDS posting only on the provider balances and bank money only from a settlement | B09-N4; 15 "Operational ledger" (balanced monetary allocations; "Reconciliation checks captured amounts, refunds, disputes, provider fees, settlement and bank receipts"); 15 "Settlement and withdrawal" ("A provider 'completed' withdrawal and an actual bank credit are separately reconciled"); 15 "Disputes and chargebacks" ("tracks processor fees separately from the customer refund"); CMD034 failure "A provider pending/held state is never coerced to settled available cash"; reference/HASHING "Ledger posting and reconciliation"; 07 "Application checks … cannot be the sole protection" |
| D-FISC-B6 | Every document of a sale takes the version of the sale's tax point, the capture's completion (`saleProfileAt`): the version current then — recorded by then and not superseded by then — while it carries a reviewed treatment, else the latest-recorded reviewed version in force at the tax point (a later review resolving an unknown), else the unknown; the invoice is drafted under it, a credit note carries exactly the invoice's snapshot; an agency's versions form one lineage in which a version is superseded exactly when its successor is recorded (`fiscal_profiles_successor_fk`, `fiscal_profiles_supersession_lineage`), so the version current at an instant is unique | B09-N5; D-FISC-B4, D-FISC-B5; 15 "FiscalProfile" ("Unknown facts remain unresolved and block affected fiscal claims"; effective dates and reviewer evidence); 15 "TaxDocument state machine" ("relationship to the original"); registry TaxDocument DRAFT→VALIDATED guard; the authority is silent on a review that reaches back to a sale (Q-B09-20, Q-B09-22) |
| D-PROTO-B6 | The claim's deadline is bounded by the database: in the future and at most DISPATCH_DEADLINE_SECONDS (DISPATCH_TIMEOUT_SECONDS + DISPATCH_WATCHDOG_MARGIN_SECONDS = 60) after the claim's transaction instant, whoever claims (`payment_attempts_dispatch_deadline_bound`); the claimant writes it as now() + 60 s in the claim's own statement, so no clock of a process decides it | B09-N7; D-PROTO-B4; 15 "Webhooks and reconciliation" ("The periodic reconciler checks uncertain orders, captures, refunds"); 07 "Application checks … cannot be the sole protection"; the principle of D-AUTH-B4 (the role a gate protects against never sets what protects against it) |
| D-BIND-B2 | A row that names an attempt and an order names an attempt of that order (UNIQUE `(agency_id, attempt_id, order_id)` on attempts, composite keys from observations, capture facts and provider exceptions); a case that names several subjects names one purchase (its capture and its refund are its order's) | B09-N6; 07 "Composite foreign keys or equivalent enforced constraints prevent … referencing another …"; 08 "Database isolation"; D-ING-B3 ("attributed to the stored operation's order and agency") |
| D-STAGE-B1 | The implementation runs in two stages of parallel mandates (§14): stage 1 — M1 persistence, M2 the commerce core and every contract fake — from this design's head; stage 2 — M3 the payment service's side, M4 the request side — from the integrator's merge of stage 1 (`b09/impl-stage1`); every fake has one owner (M2); no mandate codes against a port of an unmerged package (B07's CommercialScopeInspector is bound by the integrator to B09's own query, §15 item 6); the cross-mandate scenario tests are the stage-2 integrator's | B09-N8; the task's rule on staged, self-contained mandates; FOUNDATION D-AGGK-5 (never depend on an unmerged package's code); B06's precedent (in-memory ports only for pure orchestration tests, database-backed case tests on real PostgreSQL) |
| D-EVT-B4 | (implementation M1) The event a commerce repository publishes for a version carries the provenance of its unit of work, never one an adapter invents: the actor of the context (the person of a TENANT or OPERATOR context, the verified service of a SERVICE context), its correlation id, and as causation the cause its caller names (`PgCommerceUnitOfWork.causedBy`: a consumer's source event, the reconciler's inbox record, a stored operation), else the command journal entry the unit of work reserved or resumed (`PgCommandJournal` tells its unit of work the entry), else the correlation id. `causedBy` is an addition of the `pg` unit of work, not of the domain port: the stage-2 composition that runs a consumer or the reconciler names the cause on the unit of work it holds | registry DomainEvent `causationId` ("Command or prior event cause") and `correlationId` ("Safe operation trace"); 07 "Outbox, inbox and event ordering"; B06 D-EVT-2 and B06's command runtime, which causes a command's events by its journal entry (`runtime.ts`); D-EVT-B3 |
| D-INSP-B1 | (implementation M1; re-check residual FINAL-N3) The queries behind B06's inspectors are `commercialInspectionsOf(uow)` of `@kauro/persistence`, run in the command's own unit of work under its tenant policies: `unreconciledForPlan(planId)` answers the plan's live quotes (DRAFT, ISSUED, ACCEPTED_FOR_CHECKOUT), the open payment orders of those quotes and its non-revoked commercial authorizations as `{ kind, referenceId }` (the application's `UnreconciledConsequence`, less B08's jobs), and `liveAuthorizationsOfClient(clientId)` the count of `ActiveWorkSummary.liveCommercialAuthorizations`; the shapes are the application ports' own, written structurally because `@kauro/persistence` does not depend on `@kauro/application`. The api composition binds them: `apps/api/src/edition.ts` `commercialConsequencesInspector` and `activeWorkInspector` replace `noCommercialConsequencesInThisEdition` and the zero count (bound at the stage-1 integration, before M3 and M4 start; `apps/api/test/b09-inspectors.test.ts` holds the CMD023 DENY and CMD010 route tests with a live authorization) | registry Plan edge APPROVED -new_plan_revision-> SUPERSEDED, guard "Commercial/execution consequences are reconciled"; 07 "Aggregate ownership" (Quote, PaymentOrder and CommercialAuthorization own those facts); 07 "CommercialAuthorization" ("A materially changed customer scope requires new commercial analysis"); B06 D-PLAN-4, D-CMD-3 and `apps/api/src/edition.ts` ("Their packages bind the real inspector through the same port") |
| D-BIND-B3 | (implementation M1; re-check residual FINAL-N1) A case that names a refund and a capture names the refund's own capture whether or not it names an order: 0012 adds the binding target `refunds_capture_binding` UNIQUE `(agency_id, refund_id, capture_id)` and the key `reconciliation_cases_refund_own_capture_fk`, because every key of D-BIND-B2 carries the nullable `order_id` and MATCH SIMPLE skips it when the order is absent; the adapters translate the key to INTEGRITY_FAILURE. The migration's first form committed a PROVIDER_INCONSISTENCY case naming the refund of one purchase and the capture of another (the adapter test "B09-FINAL-N1 (D-BIND-B2): …" fails on it with a missing rejection) | 07 "Composite foreign keys or equivalent enforced constraints prevent … referencing another …"; 08 "Database isolation"; D-BIND-B2 ("a case that names several subjects names one purchase"); B09-N6 |
| D-CORE-B1 | Who publishes a version's event (implementation M2): the commerce core plans the event of every version it writes (`commerceVersionEventType`, the allowlisted payload) and, after each write, publishes it unless the unit of work already holds an event of exactly that aggregate version — an adapter that publishes in the repository, as §14 asks of M1; an event already published must be of the planned type (INTEGRITY_FAILURE otherwise) and is never published twice (`publishVersionEvent`). Exactly one event per version reaches the outbox whichever side writes it | 07 "Outbox, inbox and event ordering" (one event per committed version, with its aggregate id and version); the domain ports' text ("the caller publishes", B06 practice) and §14 M1 ("publishes, in the same unit of work through B06's `EventPublisher`") disagree, and the two stage-1 mandates run in parallel (D-STAGE-B1), so the core is correct under both; the database refuses a missing or foreign event anyway (KA003, 42501; D-EVT-B3) |
| D-CORE-B2 | The payment service reads the purchased subject an issuance relies on — the agency's state, the quoted plan's state, approval and body hash, the approval's hash and withdrawal, the quoted revision's state, the quoted target contract's confirmation and supersession, the project's capability — through the application port `PurchasedSubjectReader` (`commerce/core/subject.ts`), whose adapter selects exactly the columns 0009 grants `kauro_payment`, after the shared halves of the transition locks in the order of §6.2; the B06 repositories select every column (plan bodies, project purposes) and cannot run under `kauro_payment`. Its PostgreSQL adapter is bound in stage 2 by the service composition (M3); the in-memory reader of the orchestration tests is on the test-only subpath | §3.2 and D-CTX-B1 (column-scoped reads of B06 prerequisites; never a plan body or a purpose); §6.3 step 2; 07 "CommercialAuthorization" (issued only while every prerequisite binds; KP004 re-checks it); 14 "Identity matrix" (runtime identities hold only the roles they need); B06 D-TX-2 |
| D-CORE-B3 | The provider's view of an order (`ProviderOrderObservation`) names its approval page when the provider does (`approvalUrl`): a creation whose response was lost is learned from the view read by the attempt's request identity, with its approval page kept only on an allowlisted host — otherwise the order is learned without it and PROVIDER_INCONSISTENCY `APPROVAL_HOST_NOT_ALLOWED` is opened | 15 "The adapter does not create another order under a new local identity"; registry PaymentOrder provider_order_created ("Authenticated creation response or query with the recorded request identity"); 10 "Provider adapter contract" (redirects never go to an arbitrary origin) |
| D-CORE-B4 | The durable operation of a provider command carries the provider identities a read-only observation needs outside any transaction (the provider order of a capture, the provider capture of a refund), read from durable facts; the claim (T2) re-prepares the exact request from durable facts in its own unit of work and the call sends it only when its digest equals the attempt's recorded request hash (INTEGRITY_FAILURE otherwise, nothing sent: `DispatchTicket.request`); the settle input is a dispatch result or a read-only observation of the provider's view (the resume's read by request identity), applied by the same reconciler | 07 "No database transaction remains open across ... payment API calls"; 10 "Idempotency contract" (the prepared intent is durable before a potentially billable dispatch) and "Provider adapter contract"; reference/HASHING "Provider request hash"; D-PROTO-B1..B3 |
| D-CORE-B5 | `CommerceAuthorizer.authorizeOperator` takes the stored operation a command is keyed by (CMD032 and GetRefundReview: the refund) and, after the grant, resolves and adopts it through the scope index as the operator's finance scope; a foreign and an unknown key are both NOT_FOUND (no reason) and adopt nothing | §3.4 (CMD032: "the refund resolvable in the scope index (NOT_FOUND alike for foreign and unknown)"); D-SCOPE-B1; 08 "Database isolation" (a foreign and a nonexistent object look alike) |
| D-PAY-B6 | A capture's completion — observed COMPLETED, or REVERSED while unknown or PENDING (D-PAY-B5) — is recorded only with the provider's completion instant carried by the observation itself: it is the sale's tax point (D-FISC-B4) and what the price expiry is compared with (D-AUTH-B3). When a webhook or a dispatch response lacks it, nothing of that capture is applied and no observation row is appended (the webhook's inbox record stays applicable and is settled RETRYABLE) and the reconciler answers `providerQueryRequired`: the payment service stores a provider query of the order and applies it (CMD034); when a stored query lacks it too, PROVIDER_INCONSISTENCY `COMPLETION_TIME_UNKNOWN` is opened and nothing is applied — a tax point is never invented | the re-check's residual FINAL-N2; 07 "Acceptance obligations" (a downstream team must not fill a missing domain rule with a local guess); D-PAY-B5, D-FISC-B4, D-AUTH-B3; S059; 15 "Webhooks and reconciliation" (the periodic reconciler checks uncertain captures) |
| D-LEDGER-B6 | (stage-1 integration; the re-check's residual N4) What a fee or a return takes out of a capture beyond the capture's movable balance before it — only ever a fee the provider keeps: a full refund or a chargeback after a reported fee, or a fee reported after the money went back — is taken from the merchant's available balance at the provider (`MERCHANT_BALANCE_ACCOUNT` = PSP_AVAILABLE), never from the capture's receivable or held balance: `providerFeePostings` and `returnPostings` credit at most `movableBalanceCents` to the balance of the funds state their event names and the rest to PSP_AVAILABLE. `capture.fee_observed.v1`, `capture.reversed.v1` and `refund.completed.v1` carry the capture's movable balance before them (for a fee, the amount less the money returned; for a refund or a chargeback, the amount less the reported fee and the money the completions before it returned), read under the capture's row lock — for a refund's completion after the completions of the capture that committed before it (D-REF-B7) —, so every amount stays fixed by its event and the balances do not depend on the order of delivery. A capture's receivable and held balances end at zero once its money has left; the available balance carries exactly the fees the provider kept, which is where the provider nets them. Chosen over stating that a capture's balance may go negative by a kept fee (the alternative the residual allowed): the receivable and held accounts would then carry the kept fees of every fully returned capture forever, which no provider statement shows | the re-check's residual N4 (the replay: amount 97125, fee 5275 while UNKNOWN, then a full return left PSP_RECEIVABLE at -5275; with HELD, PSP_HELD at -5275); 15 "Operational ledger" (balanced monetary allocations; the suggested provider receivable account); 15 "Disputes and chargebacks" ("tracks processor fees separately from the customer refund": the fee stays its own FEE set, the return's set says where the provider took the money from); 15 "Webhooks and reconciliation" ("Reconciliation checks captured amounts, refunds, disputes, provider fees, settlement and bank receipts"); D-LEDGER-B5; Q-B09-23 |
| D-REF-B7 | (stage-1 integration) The completions of one capture's refunds run in turn: a completion takes the capture's shared transition half and the exclusive per-capture refund lock `kauro.capture_refunds` — the approvals' lock — in its update (0012 `refunds_completion_order`), so a completion that waited for another reads it: the remaining service basis its `refund.completed.v1` publishes (R2-081), the movable balance its money is taken from (D-LEDGER-B6) and the full-service check at COMMIT (KP006, D-REF-B5). Before it two completions of one capture ran side by side, each blind to the other: both events published a basis that ignored the other refund, and two halves of a full refund whose checks ran before either committed both committed with the entitlement live | 15 "Refund policy and calculation" ("concurrent refund requests serialize that invariant"); 07 "Application checks … cannot be the sole protection"; R2-081 ("Cumulative entitlement reaches exactly zero"); CommercialAuthorization authority_revoked guard "Reversal or full service refund"; §6.2 (the capture before the refund; the approvals' lock) |
| D-M3-B1 | (implementation M3) The payment service's three routes — CMD030, CMD033, CMD034 (`COMMERCE_SERVED_COMMAND_IDS`) — are registered by the api's composition in every edition, each with its declared replies (`commerceCommandRouteResponses`: the COMPLETED envelope, the ACCEPTED envelope for CMD033, the Problem document constrained to its closed catalogue), and the api's validator compiles the payment commands' closed request schemas and response views beside B06's (`createSchemaValidator(…, { commerce: true })`, never shadowing a B06 or registry schema), so the send guard checks the payment replies exactly as B06's. An edition that binds no payment service serves them all the same: the webhook knows no provider (404 PROVIDER_UNKNOWN, nothing stored) and a service route finds no verified service identity (401 AUTHENTICATION_REQUIRED with B06's anonymous refusal recorded). The webhook's acknowledgement is a COMPLETED envelope whose `version` is 1 (an inbox record has no aggregate version) and whose `replayed` is the duplicate flag. OpenAPI documents the served operations under `paths` from the same contracts and the others stay under `x-kauro-planned` (D-API-B1) | 10 "Version and validation" ("OpenAPI is generated from the owning contract registry and checked against actual routes. The build fails on undocumented public routes, missing operation IDs, incompatible response schemas …"); D-API-B1, D-FAKE-B1 (no product wiring binds a contract fake: the provider adapters are B15's); B06 R26 (the refusal of an unauthenticated request is a durable fact); D-IDEM-B1 (the webhook's identity is the inbox) |
| D-M3-B2 | (implementation M3) `ProviderEvidenceStore.findByDigest(sha256)`: the store is content-addressed, and the inbox worker finds the verified body of a RECEIVED or RETRYABLE record by the record's body hash (B06 `inbox_records.body_hash`), then applies it exactly as the ingress would have: a crash between the ingress commit and the application leaves a record applied once. M2's labelled evidence-store fake gains the method (its one owner stays M2; no second fake). A record whose body the store does not hold is reported and left to be claimed again, never guessed | 10 "Raw sensitive provider responses stay in a restricted reconciliation store"; 07 "Consumers deduplicate by their own durable inbox identity"; CMD030-RACE (design §8: "a crash between the ingress commit and the application leaves a RECEIVED record the inbox worker applies once"); D-FAKE-B1 (one owner per fake) |
| D-M3-B3 | (implementation M3) What the payment service needs of SQL lives in `@kauro/persistence`, exported for the api, though M3's scope is `apps/api`: `PgPurchasedSubjects` (the adapter of D-CORE-B2 — the granted columns only, each fact after the shared half of its transition lock in the order agency → capability → approval → source revision → target contract; bound as M2's `PurchasedSubjectReader` in `apps/api/src/payments/runtime.ts`), `PgPaymentSweeps` (the periodic pass: the agencies that hold stored payment operations from the scope index, then per adopted agency the due attempts of `payment_attempts_watchdog` and the unclaimed intents of `payment_attempts_unclaimed`), `PgIngressFactRecorder` (the ingress's own CMD030 facts on the `kauro_ingress` pool, D-FACT-B1: ANONYMOUS DENY for a delivery that does not verify, SERVICE `provider-ingress` ALLOW for an authenticated event, each in its own short transaction) and the test fixture `checkoutOrder` (an order the provider created, nothing captured, the first half of `paidPurchase`) | 08 "Database isolation" and 14 "Identity matrix" (the SQL of a runtime role belongs to the adapter of its group); architecture.rules.json (the api reaches the database only through `@kauro/persistence`); D-CORE-B2; D-PROTO-B4; D-FACT-B1; 08 "Threat model and assets" ("every boundary has … an audit event") |
| D-M3-B4 | (implementation M3) The cancel-before-dispatch sweep cancels an intent still PREPARED only after the claim window `CLAIM_WINDOW_SECONDS` = `DISPATCH_DEADLINE_SECONDS` (60 s) from its start: the command that recorded the intent claims it at once, so an older intent was left by a request that died between T1 and T2 and was not resumed. The cancellation takes the order's row lock and then the attempt's, as a claim does, so the compare-and-swap admits one of them; it records PREPARED → CANCELLED_BEFORE_DISPATCH with `outcomeCode` CLAIM_NEVER_COMMITTED (and a CREATE_ORDER order still INTENT_CREATED → CANCELLED); a later resume of the same key answers from the cancelled operation and never calls the provider | D-PROTO-B1, D-PROTO-B4, D-PROTO-B6; registry PaymentAttempt `cancel_before_dispatch` ("no provider call was possible"); 10 "An ambiguous external effect requires reconciliation, not blind retry"; 07 "No database transaction remains open across … payment API calls" |
| D-M3-B5 | (implementation M3) The work the payment service starts itself runs under its own verified identity (`payment-service`, the journal's actor SERVICE) with a journal key derived from what makes it one operation: the refund executor `refund-execute-<refundId>-v<approved version>` (§8.1), the watchdog's application `watchdog-<stored query ref>` and D-PAY-B6's completion query `completion-query-<stored query ref>`; a redelivery resumes or replays the one operation and never repeats a provider effect. CMD034 applies its stored query in one SERVICE unit of work; when a concurrent writer of an attempt or a refund wins a compare-and-swap (STALE_VERSION) the whole application is retried, at most three times, then answered CAPACITY_UNAVAILABLE (retryable, same key) | 10 "Idempotency contract" ("The idempotency identity includes environment, authenticated subject or trusted system actor, agency, operation and key"; "A concurrent duplicate receives the same durable operation reference or final result"); 07 "Transaction discipline" ("the client recovers the same command result by its idempotency identity. It must not repeat the external effect under a new key"); design §8.1 (the refund executor's key); D-PROTO-B4; D-PAY-B6; 10 stable code CAPACITY_UNAVAILABLE |
| D-M3-B6 | (implementation M3) `PurchaseRebinder.rebind` runs in a SERVICE unit of work that its caller has adopted to the paid order's scope first (`adoptScope("PAYMENT_ORDER", <the capture's order>)`); the re-binder refuses a unit of work that adopted nothing (INTEGRITY_FAILURE, before anything is read) and a capture its adopted agency does not hold (NOT_FOUND). The port's input names the capture, not the order, and the payment service sees nothing of an agency before it adopts one of its stored operations, so the re-binder cannot adopt by itself; B10's replacement flow reads the capture's order where it reads the capture. Found by the route test "D-QUOTE-B6: …", which answered NOT_FOUND for the capture of a paid purchase before the change | D-SCOPE-B1 ("adoption once per unit of work"; the payment service sees one agency, the one it adopted); D-CTX-B1; D-QUOTE-B6; 08 "Database isolation" |
| D-M3-B7 | (implementation M3) The watchdog reschedules an attempt that is not due at the first millisecond past its dispatch deadline and settles it only then: the attempt's record carries the deadline at the millisecond precision of `UtcInstant`, while the database wrote it with `now()` to the microsecond (D-PROTO-B6), so rescheduling at the recorded instant could run up to a millisecond before the database's deadline. Found by the route test "the PAYMENT_SERVICE watchdog (D-PROTO-B4): …", which compared the rescheduled instant with the database's deadline | D-PROTO-B4 ("a watchdog reconciles past it"); D-PROTO-B6 (the deadline is the database's); 07 "Outbox, inbox and event ordering" ("Every repair is bounded by the original subject, deadline and budget") |
| D-M3-B8 | (implementation M3) The payment dispatcher holds one B06 lease per consumer (`PgLeaseStore`, resource kind OUTBOX_DISPATCH, the resource a name-based UUID of the consumer, fenced, renewed by a heartbeat before every settlement, 120 s between heartbeats; a dispatcher lease spends no cost, so its absolute deadline is a far constant); it claims at most a bounded page of the consumer's due records for 120 s, settles each after its effect under the claim's attempt (DELIVERED; RETRYABLE at the instant the effect names — a watchdog not yet due, a credit note awaiting its invoice — or after a backoff of min(300, 2^attempt) s; DEAD_LETTER once a failure is not retryable or ten attempts are spent), and stops at the first settlement another dispatcher fenced | B06 D-OUTBOX-1 ("held by the dispatcher of the consumer's package"); 07 "Outbox, inbox and event ordering" ("Outbox dispatch is at least once. Consumers deduplicate by their own durable inbox identity"; "The sweeper repairs undispatched outbox records, abandoned leases …"); B06 `PgOutboxDispatchStore` (DELIVERED, RETRYABLE, DEAD_LETTER under the claim's attempt); D-CONS-B1; §8.2 |
| D-M3-B9 | (implementation M3) The state/command matrix reads the events a served payment command publishes from a declared table (`tools/matrix.mjs` `COMMERCE_PUBLISHED`), not from a handler file: every version the reconciler writes is published with the type `commerceVersionEventType` names (D-EVT-B3, D-CORE-B1), so CMD030 and CMD034 list the reconciler's types and CMD033 adds its own intent and claim (the REFUND attempt PREPARED and DISPATCHING, the refund SUBMITTING); the database refuses any other type anyway (KA003, 42501) | 10 "the catalogue records applicability and rationale"; D-EVT-B3; D-CORE-B1; B06's matrix (the served commands' events and their consumers) |
| D-REQ-B1 | (implementation M4) What a deployment binds for the request side (`CommerceRequestCollaborators`) and what the api answers for each collaborator it does not bind. The payment provider adapter (B15's) and the payment service's units of work (SERVICE on `kauro_payment`, the payment service's composition): unbound, CreatePaymentOrder and CapturePayment answer INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE inside the unit of work with nothing written, after every checkout blocker (without an adapter no merchant route can be qualified: its blocker then stands for the unbound adapter and is answered last, and GetQuote names PAYMENT_ROUTE_UNQUALIFIED); a journal entry an earlier deployment left pending is answered, never dispatched. B08's `DeliveryCapacityPort`: unbound, capacity is unanswered and checkout answers CAPACITY_UNAVAILABLE DELIVERY_CAPACITY_UNAVAILABLE. B07's `SourceAvailabilityReader`: unbound, the quote's own promise (`sourceAvailableUntil`, set at issuance) is the effective deadline, with the revision's SEALED state read after its transition lock. `apps/api/src/edition.ts` `commerceEdition()` binds only the reads of its own database; a deployment and the acceptance tests bind the rest through `ApiAssembly.commerce` — the tests bind M2's labelled contract fakes there, never production wiring. Test `apps/api/test/b09-request-side.test.ts` "D-REQ-B1: …" (through the composition root, as deployed and with the admission bound) | §8 CMD028 ("an adapter bound (INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE, nothing written)"); D-CAP-B1 (unanswered is CAPACITY_UNAVAILABLE); D-QUOTE-B7; D-FAKE-B1; B06 I-INT-2 and `apps/api/src/edition.ts` (an edition names what it does not bind); 07 "Acceptance obligations" (no local guess for a missing rule) |
| D-REQ-B2 | (implementation M4) The request side's queries beyond the repository ports (`CommerceRequestQueries`: the shared half of a quote, capture or entitlement a command relies on without changing it; a quote's orders and completed capture for ALREADY_PAID; a project's latest completed capture for CMD031; the ACTIVE standing refund policies the owner's review lists) and a PostgreSQL adapter of M2's `PurchasedSubjectReader` are `@kauro/persistence` `PgCommerceRequestReads` (`commerceRequestReadsOf(uow)`). They run in the caller's commerce unit of work under its policies — TENANT, OPERATOR in its adopted finance scope, or SERVICE after the payment service adopted the stored operation's agency; the subject is read after the shared halves in the order of §6.2 and selects only the columns 0009 grants `kauro_payment`. The api binds them (`apps/api/src/edition.ts` `purchasedSubjectReader`, `commerceRequestQueries`). M4's route tests are the first to run M2's reconciler over M1's adapters on a real database (the stage-1 carried item), so M4 needed the reader before M3 delivers it; M3 writes its own adapter of the same port in parallel (`packages/persistence/src/repositories/commerce-subject.ts` on `b09/m3-payment-service`). The stage-2 integrator keeps one adapter, binds it in both compositions and removes the other | D-CORE-B2; §3.2 (column-scoped reads of B06 prerequisites), §6.2, §6.3 step 2; 14 "Identity matrix"; B06 D-TX-2; D-INSP-B1 (the port's shape written structurally, because `@kauro/persistence` does not depend on `@kauro/application`) |
| D-REQ-B3 | (implementation M4) The domain has one checkout blocker for an open checkout of the project (PAYMENT_IN_PROGRESS); CMD028 answers it as the design names it: PAYMENT_PENDING, retryable, with reason CAPTURE_IN_PROGRESS when the open order is CAPTURING and CREATION_IN_PROGRESS otherwise. The quote blockers (QUOTE_NOT_ACTIVE, QUOTE_EXPIRED) and AGENCY_NOT_ACTIVE carry the current version and state of the quote or the agency; every other blocker answers the domain's `blockerFailure` | §8 CMD028 ("in progress (PAYMENT_PENDING CREATION_IN_PROGRESS / CAPTURE_IN_PROGRESS; retryable)"); §7 (the error contract: a refusal about an aggregate's state names its current version and state) |
| D-REQ-B4 | (implementation M4) CMD029 answers an order that is not CREATED or APPROVED from its committed row, before any lock: CAPTURED is PRECONDITION_FAILED ALREADY_PAID, CAPTURING is PAYMENT_PENDING CAPTURE_IN_PROGRESS (retryable), CAPTURE_UNCERTAIN is PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN (reconciled, never repeated), any other state is PRECONDITION_FAILED ORDER_NOT_CAPTURABLE, each with the order's current version and state where the catalogue carries them. An order another writer moved out of the claimable states while this command waited for its row lock is answered from its new state. Once the order's three CAPTURE attempts are spent, the answer is ORDER_NOT_CAPTURABLE | §8 CMD029 (ORDER_NOT_CAPTURABLE / ALREADY_PAID; PAYMENT_PENDING CAPTURE_IN_PROGRESS for a live attempt; PAYMENT_UNCERTAIN CAPTURE_UNCERTAIN for an uncertain one; the order's CAPTURING and CAPTURE_UNCERTAIN states are those attempts' order-level mirror); D-PROTO-B3 (at most three attempts); D-REQ-B8; 10 "An ambiguous external effect requires reconciliation, not blind retry" |
| D-REQ-B5 | (implementation M4) The security facts of the request side. An agency member's DENY goes through B06's `recordDenialFact` (the agency's stream when the recording transaction proves a live membership, else the member's identity stream naming the selected agency). A corporate owner's DENY is recorded in its own transaction after the command rolled back, in the operator's identity stream (agency NULL), naming the agency it had adopted when it had adopted one (`requested_agency_id`: a name, never a reference). The ALLOW fact of an effect authorized beyond the session is committed with the effect or not at all: CMD032's in the operator's identity stream naming the adopted agency, reason STEP_UP_FRESH (assurance STEP_UP) or STANDING_POLICY_APPLIED (assurance SESSION; the policy is also the intent's recorded authority). CMD028, CMD029 and CMD031 are authorized by the member's session alone and record no ALLOW fact, as B06 records none for a session-authorized command; `runProviderCommand` records their denials through `recordDenial`. `authorizeOperator` with the stored operation (the refund) runs in the access step, before the journal reservation and in the same unit of work, so the operator's identity-owned entry is reserved with the finance scope already adopted | B06 D-FACT-1 (one stream per fact; the ALLOW fact of a step-up-authorized effect committed with it); D-FACT-B1; D-IDEM-B2; D-CORE-B5; D-REF-B4 and D-RPOL-B1 (a standing policy authorizes instead of a step-up); 08 "Threat model and assets" (every boundary has its audit event) |
| D-REQ-B6 | (implementation M4) Crashes in the provider-effect route tests are injected at the protocol's own points. `CommerceRequestCollaborators.protocolHold` is a test-only hook that no deployment binds (`commerceEdition()` omits it). The runtime calls it at INTENT_BEFORE_COMMIT, AFTER_INTENT, AFTER_CLAIM, AFTER_CALL and AFTER_SETTLE. A throw ends the request like a process death at that point: the transport answers INTERNAL_ERROR, and nothing of the unit of work in progress commits. A pause holds the request at that point until the test releases it; this is how a capture races its own webhook. No sleep synchronizes anything | the case map's RACE titles (D-CASEMAP-B1: "a crash before the intent commits", "between the intent commit and the claim", "between the claim and the settle"); M2's `ProtocolPoint`; B06's hold-point technique (`apps/api/test/support.ts` HoldPoints); the build rules (interleavings by hold points, never sleeps) |
| D-REQ-B7 | (implementation M4) Serving a B09 operation. `packages/application/src/commerce/served.ts` lists the served commands and reads (`COMMERCE_SERVED_COMMAND_IDS`, `COMMERCE_SERVED_READ_IDS`) and gives each route's reply contract: the COMPLETED envelope, 202 ACCEPTED where a provider effect can be unknown or in flight, and the Problem document of the closed outcome catalogue. Everything else follows from those lists: the route inventory, the api's send guard, the closed validator (the payment request schemas and reply envelopes, compiled with B06's), `tools/openapi.mjs` (the operation moves from `x-kauro-planned` into `paths`) and `tools/matrix.mjs` (the served sections and the manual-10 applicability). `COMMERCE_COMMAND_EVENTS` lists the events a served command's whole run may publish: T1 and T2 by the request handler, T3 by the payment service through the reconciler's planner. No handler source spells these out, so every route test asserts that each event its run published is listed. M3 appends its operations to the same lists | D-API-B1; §10; B06 N13 (closed outcome catalogues enforced by the send guard) and D-RESP-1; 10 "OpenAPI is generated from the owning contract registry and checked against actual routes", "Contract tests and compatibility" |
| D-REQ-B8 | (implementation M4) The request handlers lock only the rows they move. `payment_orders_tenant_claim` admits `kauro_app`'s row lock of an order only in INTENT_CREATED, CREATED and APPROVED. M2's runtime locked the CREATING order in the member's unit of work, both at a later creation attempt's claim and when it prepared a new deliberate attempt after a proved no-effect. The policy hides that row from the lock, so the member's own order answered NOT_FOUND (404) — found by the first real-database run. The claim now locks the order only where it writes it: a creation's first claim (INTENT_CREATED → CREATING), a capture's claim (CREATED or APPROVED → CAPTURING) and a refund's claim (the payment service's own). A later creation attempt reads the order and writes only the attempt; the one-live-attempt index and the ordinal sequence decide between two resumes that both saw the proved no-effect. By the same rule, CMD029 answers a non-claimable order from its committed row (D-REQ-B4), and CMD032 answers a refund no longer REQUESTED from its committed row (`refunds_finance_review` admits the finance scope's lock only while REQUESTED). The change is in M2's `commerce/core/provider-effects.ts` (`subjectOf`, the NEW_ATTEMPT step); M3's REFUND claim keeps its lock | D-AUTH-B4 (the request handlers write only the intent and claim edges); D-PROTO-B3 (a later attempt follows only a proved no-effect); §6.2; 07 "Application checks improve messages but cannot be the sole protection" (the indexes decide); test `apps/api/test/cmd028-create-payment-order.test.ts` "D-REQ-B8: …" (fails with 404 on the stage-1 core; §16 M4-1) |

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
- **Q-B09-21** Funds availability is modelled per capture as a whole (UNKNOWN, HELD, AVAILABLE), and a funds observation moves the
  capture's whole movable balance (D-LEDGER-B5); a provider hold of part of a capture (a dispute holding only the disputed amount)
  has no representation, like a partial reversal (Q-B09-7). Interim: the capture's funds are HELD while any part is held.
- **Q-B09-22** A later fiscal review whose validity reaches back to a sale resolves an unknown treatment for that sale (D-FISC-B6);
  15 "FiscalProfile" asks for effective dates and reviewer evidence but is silent on a review dated before its own recording.
  Should such a retroactive resolution carry a professional confirmation distinct from an ordinary review?
- **Q-B09-23** (answered by D-LEDGER-B6 at the stage-1 integration) A return larger than the capture's movable balance (a full
  refund or a chargeback while the provider keeps its fee) takes the movable balance from the provider balance its event names and
  the kept fee from the merchant's available balance, where the provider nets it; no provider balance of the capture is left
  negative. B15's settlement comparison reconciles the available balance against the statement; how the operational accounts map
  to the legal chart stays the accountant's (15 "Operational ledger": "the accountant maps them to the legal chart").

## 14. Implementation mandates and verification

Two stages of parallel mandates (D-STAGE-B1; B09-N8), separated by the ports fixed here. Each mandate below is self-contained: it
names its stage, the exact branch it starts from, the fakes it owns (every fake has exactly one owner), its scope, the tests it
writes and when it is done; none codes against a port of a package that is not on `main` (B07's `CommercialScopeInspector` is the
integrator's binding, §15 item 6). The structured hand-off of this revision carries the same texts with the head's hash and
supersedes the pre-review hand-off `.claude/b07-b09-design-review/architect_B09.json` (its mandates start from `8a282bc`, migrations
0008–0012; no mandate may start from it; §15 item 15). Every mandate works in its own worktree, commits with the required identity
and trailer, never pushes, and leaves no temporary PostgreSQL cluster running.

**Stage 1** — both mandates start from `b09/design` at the commit that carries this section, in parallel.

- **M1 — persistence adapters** (stage 1; owns no fake). Scope: `packages/persistence` only (`src/repositories/commerce-*.ts`,
  `src/unit-of-work.ts`, `src/command-journal.ts`, `src/sqlstate.ts`, `src/testing/*`, `test/`). Implement over migrations
  0009..0013 the `pg` adapters of every port of `packages/domain/src/ports/commerce.ts`, as §3–§7 describe: PaymentRouteRepository;
  FiscalRepository (`currentProfile`; `saleProfileAt` = the domain's `saleProfileAt` over the agency's versions read after
  `kauro.await_transition('kauro.fiscal_profiles', agency)`; `recordProfile` writes the predecessor's `superseded_at` and the
  successor's `created_at` as one instant in one unit of work — `fiscal_profiles_successor_fk`, `fiscal_profiles_supersession_lineage`);
  CorporateGrantRepository; RefundPolicyRepository; PricePolicyRepository; ScopeIndex; QuoteRepository; PaymentOrderRepository;
  PaymentAttemptRepository (the claim writes `dispatch_deadline_at = now() + make_interval(secs => DISPATCH_DEADLINE_SECONDS)` in its
  own statement — `payment_attempts_dispatch_deadline_bound` refuses anything else); CaptureFactRepository (birth with funds
  UNKNOWN; one edge or one later fact per version; an out-of-order reversal written as COMPLETED then REVERSED; the funds
  observation's movable balance read after `SELECT … FOR UPDATE` of the capture row); ProviderObservationRepository;
  CommercialAuthorizationRepository (with `findLiveByRevisionHash`); PurchaseRebindingRepository; RefundRepository
  (`fileServerRequest` with ON CONFLICT DO NOTHING against `refunds_one_requested_per_origin`; a completion reads the capture's funds
  state after `FOR SHARE` of the capture row); TaxDocumentRepository; LedgerRepository (`post` idempotent by source, the source
  reference the event's aggregate); SettlementRepository; ReconciliationCaseRepository (`open` idempotent per kind and subject);
  PaymentInboxRepository (B06 inbox guards, READ COMMITTED); ProviderExceptionRepository. Every versioned write is compare-and-swap
  (STALE with the current safe version and state) and publishes, in the same unit of work through B06's `EventPublisher`, the event
  `commerceVersionEventType` names, with the payload of `COMMERCE_EVENT_PAYLOAD_ALLOWLIST` and outbox records only for the consumers
  `COMMERCE_EVENT_SUBSCRIPTIONS` lists for that type. The commerce unit of work (`CommerceUnitOfWork`, `CommerceUnitOfWorkFactory`):
  `adoptScope` once per unit of work (SERVICE binds `kauro.agency_id`, OPERATOR `kauro.finance_agency_id`; an unknown key answers
  NOT_FOUND and adopts nothing), `adoptFinanceScope` (OPERATOR only), `commerceScope`, SERVICE on a verified `kauro_payment` pool;
  B06's `bindContext` clears the finance agency on every transaction. `PgCommandJournal.markUncertain` and commit from UNCERTAIN
  (D-JOURNAL-B1). SQLSTATE translation of `src/sqlstate.ts` (the KP class; unique violations decided by constraint name). The
  queries behind B06's `CommercialConsequenceInspector` and `ActiveWorkInspector` commercial counts. Replace the raw SQL of
  `test/commerce-support.ts` with adapter-driven fixtures. Tests: `test/adapters-commerce-*.test.ts` on real PostgreSQL 17
  (`C:\Tools\pgsql17\bin`) as the runtime logins — a CAS loser answered STALE, finance-scope invisibility without an ACTIVE grant, the
  approval/reversal race observed waiting in `pg_stat_activity` (no sleep), a replayed post that writes nothing, every published
  event type equal to `commerceVersionEventType`'s. Done when `pnpm run verify` is green, `test/b09-migrations.test.ts` and
  `test/b09-critique.test.ts` pass unchanged, `test/fixtures/runtime-boundary.json` is unchanged, and no provider port is called.
- **M2 — the commerce core and the labelled contract fakes** (stage 1; owns every fake: PaymentProviderAdapter, WebhookVerifier,
  ProviderEvidenceStore, FiscalDocumentBridge, ServiceAuthenticator, SourceAvailabilityReader, SourceLineageReader,
  DeliveryCapacityPort). Scope: `packages/application` only (`src/commerce/core/*`, `src/commerce/testing/*` exported through a new
  `./testing` subpath — a test-only subpath of `architecture.rules.json`, never imported by production source —, `test/`); no `pg`
  import. Pure planners: `planObservation` (§6.3 steps 3–6 over a facts snapshot and one normalized observation: the writes in the
  lock order of §6.2, each version's event by `commerceVersionEventType`, `captureStatusStep` including its `then` edges,
  authorization issue and revocation with its phase, cases, server refund requests, provider exceptions, the observation's effect),
  `planPostings` (FINANCE: `capturePostings`, `providerFeePostings`, `fundsPostings`, `returnPostings` by the funds state the event
  names, case corrections; D-LEDGER-B5), `planFiscalDocument` (FISCAL: `saleProfileAt`, `resolveFiscalTreatment`, a credit note's
  invoice snapshot, blocked drafts' re-evaluation; D-FISC-B6), `nextProtocolStep` (the resume table of §6.1). Executors coded against
  the repository ports: `CommerceReconciler` (applies a plan in one SERVICE unit of work under the order's row lock), the
  provider-effect runtime `ProviderCommandPhases` (T1 intent, T2 claim, the call, T3 settle in a SERVICE unit of work under
  `kauro_payment`, T4 completion; resume by journal entry; 202 with the durable operation), `CommerceAuthorizer`
  (`authorizeService`, `authorizeOperator`, `assureOperator`; D-AUTHZ-B1..B3). The labelled contract fakes (`integrationClass` or
  `binding` `CONTRACT_FAKE`; PayPal Orders v2 shapes; a call log; programmable ORDER_CREATED, CAPTURE_OBSERVED, REFUND_OBSERVED,
  PROVED_NO_EFFECT, AMBIGUOUS and UNRECOGNIZED results; observation by provider id and by request identity `kauro-<attemptId>`) with
  contract tests. A completion is recorded only with the provider's completion instant; without it nothing is applied and a stored
  provider query is asked for (D-PAY-B6; residual FINAL-N2). Orchestration tests may use an in-memory commerce store that extends
  B06's `createInMemoryPorts` under its rule —
  never a database, never case evidence. Done when `pnpm run verify` is green and no fake is reachable from production wiring.

**Stage 2** — both mandates start from `b09/impl-stage1`: the integrator's merge of M1, then M2, onto the stage-1 base, verify green
on Windows and Linux. They run in parallel and own no fake (they bind M2's).

- **M3 — the payment service's side** (stage 2). Scope: `apps/api` — the service composition (the `kauro_payment` pool and M1's
  SERVICE and OPERATOR unit-of-work factory; the payment dispatcher claiming outbox records through B06's `PgOutboxDispatchStore`
  under `kauro_control` with a lease per consumer, each effect in its own SERVICE unit of work), the webhook route CMD030 (ingress
  half under `kauro_ingress` with `WebhookVerifier` over the exact raw bytes; application half by M2's reconciler, immediately and by
  the inbox worker), the service routes CMD033 and CMD034 (`authorizeService`, `adoptScope`, M2's runtime), the consumers FINANCE
  (`planPostings` → `LedgerRepository.post`), FISCAL (`planFiscalDocument`) and PAYMENT_SERVICE (the watchdog over
  `payment_attempts_watchdog`, the cancel-before-dispatch sweep over `payment_attempts_unclaimed`, the refund executor with its
  journal key from the refund and version), `PurchaseRebinder` (D-QUOTE-B6), D-AUTH-B3's honored-after-expiry check, the PostgreSQL
  adapter of M2's `PurchasedSubjectReader` over the payment service's column-scoped reads (D-CORE-B2). Tests on real
  PostgreSQL 17 through the routes, under exactly the titles the case map marks PLANNED (M3) (`apps/api/test/cmd030-payment-webhook`,
  `cmd033-execute-refund`, `cmd034-reconcile-payment`, `b09-ledger`, `b09-fiscal`), preconditions set up through M1's adapters, never
  through M4's routes. Done when verify is green with M3's operations served (OpenAPI `paths`, the matrix's served sections) and
  the others still planned.
- **M4 — the request side** (stage 2). Scope: `apps/api` agency and operator routes — CMD028 and CMD029 (T1, T2 and T4 in the
  principal's unit of work, T3 through M2's runtime in a SERVICE unit of work), CMD031, CMD032 (`authorizeOperator`,
  `assureOperator`), the reads GetQuote, GetPaymentOrder, GetRefund and GetRefundReview with the closed views — and
  `tools/evidence.mjs` reading `docs/design/B09-case-map.md`. Tests on real PostgreSQL 17 through the routes, under exactly the titles
  the case map marks PLANNED (M4) (`apps/api/test/cmd028-create-payment-order`, `cmd029-capture-payment`, `cmd031-request-refund`,
  `cmd032-approve-refund`); a capture racing its own webhook applies the webhook through M2's reconciler, not M3's worker. Done when
  verify is green with M4's operations served.

**Stage-2 integration** (the integrator): merge M3, then M4, onto `b09/impl-stage1`; resolve the files both edit
(`apps/api/src/composition.ts` and the route registration, `packages/application/src/commerce/index.ts`, the OpenAPI and matrix
served sections) and regenerate both documents; write the cross-mandate scenario tests the case map marks PLANNED (INT-2)
(`apps/api/test/b09-scenarios.test.ts`); verify on Windows and Linux.

**Stage-1 integration record** (`b09/impl-stage1`, from `b09/design` @ `3f4af4a`): M1 (`b09/m1-persistence` @ `7d486ca`), then M2
(`b09/m2-commerce-core` @ `96bba56`; the mandate text's `b09/m2-core`) merged with no code conflict — the design doc's decisions
register and the case map kept both mandates' rows; each fake has one owner (M2, `@kauro/application/testing`), and M1's control-plane
fixtures (`recordQualifiedPaymentRoute`, `recordQualifiedFiscalIssuer`, the corporate grant) are configuration rows, not fakes. The
integration closed the re-check's residual N4 (D-LEDGER-B6: `movableBalanceCents` on the fee, reversal and refund-completion events;
the kept fee from the merchant's available balance), found and fixed INT1-1 (D-REF-B7: the completions of one capture's refunds in
turn, 0012 `refunds_completion_order`), and bound the commercial inspectors in the api composition (residual FINAL-N3,
`apps/api/src/edition.ts`); FINAL-N1 (D-BIND-B3) and FINAL-N2 (D-PAY-B6) were closed by M1 and M2. What stage 2 inherits: the
entrypoints' paid-purchase fixture `@kauro/persistence/testing` `paidPurchase` (with `activateAgency` and
`recordReviewedFiscalProfile`), written through M1's adapters, for M3's and M4's preconditions; every FINANCE set built from a payload
passes `movableBalanceCents` to `providerFeePostings` / `returnPostings` (`planPostings` does); M2's reconciler still needs M3's
`pg` `PurchasedSubjectReader` (D-CORE-B2) before it runs over M1's adapters on a real database, which M3's and M4's route tests are
the first to do. The case map records every case's closure status at this stage (EXECUTED_LOCAL, PARTIAL, MISSING).

**Stage-2 M3 record** (`b09/m3-payment-service`, from `b09/impl-stage1` @ `de457f6`; decisions D-M3-B1..B9): the payment service's
side is served by `apps/api/src/payments/` — the composition over three verified pools (`openPaymentPools`: `kauro_payment`,
`kauro_control`, `kauro_ingress`) and M1's commerce unit-of-work factory, M2's reconciler bound to the column-scoped
`PgPurchasedSubjects` (D-CORE-B2), the webhook (CMD030: ingress, immediate application, the inbox worker), the service routes
CMD033 and CMD034, the FINANCE, FISCAL and PAYMENT_SERVICE consumers in the payment dispatcher (one lease per consumer), the periodic
pass (watchdog and cancel before dispatch), the re-binder and D-AUTH-B3's check. M3 binds M2's contract fakes and owns none; it
extended M2's evidence-store fake with `findByDigest` (D-M3-B2). The route tests on real PostgreSQL 17 under the case map's
titles are `apps/api/test/cmd030-payment-webhook`, `cmd033-execute-refund`, `cmd034-reconcile-payment`, `b09-ledger` and
`b09-fiscal`; what the payment service does beyond the thirty cases (the manual-10 admission of its routes, an edition without a
payment service, the refund executor, the watchdog, the sweep, D-PAY-B6's completion query, D-AUTH-B3, the re-binder) is
`apps/api/test/b09-payment-service.test.ts`, and the stage-1 obligation that FINANCE posts the movable balance a payload carries
(D-LEDGER-B6) is `b09-ledger`'s "D-LEDGER-B6 through the FINANCE consumer: …" (a full refund after a kept fee, through the route). Two defects were found by those tests and fixed with them: the re-binder read the
capture before any scope was adopted (D-M3-B6), and the watchdog rescheduled up to a millisecond before the database's deadline
(D-M3-B7). The rows M3 demonstrates are restated in the case map as `(stage 2, M3: …)`: every clause through the routes and a real
database, the provider-side facts from the labelled contract fakes, so each stays PARTIAL with only the live integration remaining
(B15). The OpenAPI document serves CMD030, CMD033 and CMD034 under `paths`; M4's operations stay planned.

**Stage-2 record of M4** (`b09/m4-request-side`, from `b09/impl-stage1` @ `de457f6`): the request side is served — CMD028,
CMD029, CMD031, CMD032, GetQuote, GetPaymentOrder, GetRefund and GetRefundReview — through the composition root
(`apps/api/src/composition.ts`, `edition.ts` `commerceEdition`, `server.ts`), the application's `commerce/request/*` and
`commerce/served.ts`, and `@kauro/persistence` `PgCommerceRequestReads` (D-REQ-B1..B8). The twelve route tests the case map marked
PLANNED (M4) exist under exactly their titles and pass on PostgreSQL 17, with `apps/api/test/b09-request-side.test.ts` (the
boundary, the four reads, D-REQ-B1) and the D-REQ-B8 regression beside them; they bind M2's labelled contract fakes and add none.
M2's hand-off is met: a CAPTURE attempt's `intentEntryId` is its command's journal entry (the runtime passes the reservation's
entry as the intent's causation), so a resume finds it by `attempts.findByIntentEntry`; the CAPTURE resume observes the provider
order read-only and never dispatches again (CMD029-RACE: one capture call in the fake's log and an OBSERVE_ORDER by the provider
order id); `authorizeOperator` with the stored refund runs before the journal reservation in the same unit of work; the ALLOW facts
are D-REQ-B5's. The first run of M2's runtime over M1's adapters on a real database found D-REQ-B8 (§16 M4-1). `tools/evidence.mjs`
seals and maps this case map beside B06's. The files M3 edits too, which the stage-2 integrator merges: `commerce/served.ts` (both
mandates create it: the union of the served lists), `commerce/index.ts`, `src/api/schema-validation.ts`, `apps/api/src/composition.ts`,
`server.ts` and `index.ts`, `apps/api/openapi.json` and the matrix document (both regenerated after the merge), `tools/openapi.mjs`,
`tools/matrix.mjs`, `tools/test/openapi.test.mjs`, the api tests `request-validation`, `response-contract` and `schema-boundary`,
`packages/persistence/src/testing/commerce-purchases.ts` (M4's `issueQuote`), `src/unit-of-work.ts`, `src/index.ts`, this case map
with its checks (`tools/test/b09-case-map.test.mjs`, `b09-design.test.mjs`), and the second adapter of `PurchasedSubjectReader`
(D-REQ-B2).

Verification of this branch: `pnpm run verify` (generate, build, typecheck, test, arch, openapi, matrix, clean-consume) green on
Windows; the persistence suite applies 0001..0013 from empty on PostgreSQL 17 in every test file through the B06 runner and runs
the 16 B09 schema tests, the 20 critique tests and every B06 and foundation test; no temporary cluster is left running.

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
   its `retention_records` and `dataset_revisions` lineage and bound in the api composition; the contract fakes of M2 are removed
   from the product wiring. After both merge, the integrator may add the exact database binding of `quotes.source_available_until`
   to the retention record's effective deadline (a trigger in a new migration reading `retention_records`), keeping
   `quotes_source_binding` as the bound.
6. **B09 → B07 port**: B07's `CommercialScopeInspector.authorizationsBoundTo(uow, agencyId, revisionId)` (its CMD012 impact map;
   defined on `b07/design` only) is bound by the integrator, in the composition, to B09's own query
   `CommercialAuthorizationRepository.findLiveByRevisionHash(agencyId, revisionHash)` (M1 implements it on B09's types: the live
   authorizations whose `revision_hash` is that manifest hash): the adapter reads the revision's manifest hash in B07's unit of work
   and maps the records to B07's return shape. No B09 mandate codes against a B07 port (D-STAGE-B1; B09-N8); B07's case-map row
   "Commercial authorizations bound to a replaced revision" then cites the integrator's test of the binding.
7. **Events one consumes from the other**: `dataset_revision.expired.v1` and `.superseded.v1` (B07) reach EXECUTION_CONTROL (B08);
   B09 needs no subscription (it reads the revision state and deadline in T1 and at issuance under the transition lock). B09's
   `capture.completed.v1` anchors paid retention (policy `retention.paidDaysHardFromCapture`): the retention owner (B07's
   STORAGE_LIFECYCLE, or B08 per its design) subscribes to it when it implements PAID_ORDINARY records; B09 publishes it once per
   capture (D-EVT-B2), so a single subscription suffices.
8. **Served route inventory, OpenAPI and matrix**: `tools/openapi.mjs` documents B07's served routes under `paths` and B09's planned
   operations under `x-kauro-planned` (then `paths` when M3 and M4 serve them); `tools/matrix.mjs` merges B07's four machines and owner
   rows (the DatasetRevision owners B07 revised) with B09's twelve machines and the CostGrant re-assignment (B09-F17); both
   documents are regenerated (`pnpm run openapi:generate`, `pnpm run matrix:generate`) on the merged tree and checked by verify.
9. **Persistence harness and fixtures** (`@kauro/persistence/testing`): B07 adds the source-lifecycle fixture (`sealSourceRevision`,
   `sealReadyRevision`, `expireSealedRevision`, …) and B09 the payment login, pool and contexts; both extend `harness.ts`,
   `temporary-postgres.ts` (logins) and `index.ts` — the merge keeps both sets of logins and contexts. B07 changes the shared test
   helpers of `packages/persistence/test/support.ts`: `sealedSource(clients: SourceClients, …)` and `plan(clients, …)` take
   `{ app, control }` and seal through the lifecycle (its restrictive tenant target states, D-ROLE-2, and the lifecycle guard refuse
   a tenant that walks a revision to SEALED by itself). B09's commerce fixtures (`test/commerce-support.ts`: `approvedSubject`,
   `replacementSource`, and the `b09-migrations` / `b09-critique` call sites) call `sealedSource(app, …)` and `plan(app, …)` and walk
   the replacement revision directly; on the merged tree the integrator passes `{ app, control }`, creates the replacement as B07's
   CMD012 does (a DRAFT naming `supersedes_revision_id`, the predecessor SEALED → SUPERSEDED in the same transaction) and seals it
   through B07's fixture, so the retention record exists (the exact source binding of item 5 needs it) and the re-binding's lineage
   check (`purchase_rebindings_guard`, which reads only `supersedes_revision_id` and the replacement's SEALED state) sees the
   lifecycle's own rows. The B09 assertions are unchanged; only the fixtures move.
10. **Runtime boundary matrix** (`test/fixtures/runtime-boundary.json`): regenerated from the merged catalog and reviewed; every
    entry of each package must be unchanged except the ones item 2 names.
11. **B08 edges and ports**: B08's migration grants its execution-control role the consumption edges of
    `commercial_authorizations` (UPDATE of `state`, `version`, `job_ref`, `consumed_at`, `delivered_at`, `updated_at` with USING
    `state IN ('ACTIVE','CONSUMED')` and WITH CHECK `state IN ('CONSUMED','DELIVERED')`) — B09 grants no runtime role those edges
    (D-AUTH-B4); B08 implements `DeliveryCapacityPort` (D-CAP-B1).
12. **B10 ports and commands**: CMD027 issues quotes with `source_available_until` from `SourceAvailabilityReader` and, for the
    included replacement (R2-092), a replacement quote (`replaces_quote_id`) and then calls `PurchaseRebinder`.
13. **Event bindings and subscriptions** (D-EVT-B3): B08's execution-control role writes the consumption and delivery versions of
    `commercial_authorizations`, so B08's migration grants that role SELECT on `kauro.commerce_event_bindings` (the deferred
    `commercial_authorizations_event_type_per_version` check reads it as the writer) and a read policy of its own, and publishes
    exactly `commercial_authorization.consumed.v1` / `.delivered.v1` for those versions. A package that consumes a commerce event
    adds its `(event_type, consumer)` rows to `kauro.commerce_event_subscriptions` in its own migration and to
    `COMMERCE_EVENT_SUBSCRIPTIONS` (the rows of EXECUTION_CONTROL, COMMISSIONS and NOTIFICATIONS are seeded already); an outbox
    record to an unlisted consumer is refused (42501). B07's own event writer (`kauro_control`, B07 D-CTRL-2) is unaffected: the
    commerce kind trigger reads no table, and the restrictive policies name `kauro_app` and `kauro_payment` only.
14. **Renumbering carries the new objects**: B09's 0009 now also creates the two vocabulary tables, the kind trigger, the
    event-type function and the two restrictive policies; 0010..0013 carry the `*_event_type_per_version` triggers, the fiscal
    lineage, the attempt order binding, the claim's deadline bound and the ledger's account checks. Renumbering the second package
    moves them with their files; no object name changes.
15. **The structured hand-off**: the pre-review hand-off `.claude/b07-b09-design-review/architect_B09.json` (mandates from `8a282bc`,
    migrations 0008–0012) is superseded by this revision's hand-off (§14 and the workflow result of this revision, which name the
    head's hash). The workflow that owns that directory replaces the file before any implementer starts; no mandate branches from
    `8a282bc` (the file lies outside this branch's worktree and is not edited from here).

## 16. Critique record

Every finding of the adversarial review (`critic_B09.json`, run against `8a282bc`) and of the independent re-check of `30a3202`
(B09-N1..B09-N8), and what the revisions did with each. FIXED findings name the files changed and the test that fails without the
fix; the tests are in
`packages/persistence/test/b09-critique.test.ts` (database, through the runtime login roles), `packages/domain/test/
commerce-critique.test.ts`, `packages/application/test/commerce-contracts.test.ts` and `tools/test/`.

| finding | severity | disposition | evidence |
|---|---|---|---|
| B09-F1 request handlers mint provider facts and authority | BLOCKING | FIXED (D-AUTH-B4, D-PROTO-B5) | 0011 policies and column grants (tenant intent/claim only; payment writes captures, observations, results, authorizations), 0012 (no tenant case opening), 0009 scope policies; `protocol.ts` T3/T4, `contracts.ts` `settleRuntimeRole`; fixtures settle T3 as the payment service. Test "B09-F1: the request handlers cannot mint provider facts or execution authority …" performs P1 and every other forbidden write as `kauro_app_test` — the provider identity, an attempt's result, a capture fact, its status, funds and fee, the order's allocation, an observation, a REFUND attempt, a case, a server refund request, a provider scope key, a re-binding, an entitlement's issuance, consumption and revocation (42501, or no row for a result the claim policy does not admit) |
| B09-F2 a paid, unentitled or refunded purchase locks the project | MAJOR | FIXED (D-QUOTE-B4, D-QUOTE-B6) | 0012 `quotes_release_guard` (closed purchase or re-bound), 0010 replacement quotes, 0011 `purchase_rebindings` + guard + completeness + authorization re-binding; domain `quoteRelease`, `replacementBlockers`; port `PurchaseRebinder`. Tests "B09-F2 (remedy path): …" (P2 reproduced, then released) and "B09-F2 (replacement path): …" |
| B09-F3 two server refund requests abort the reconcile | MAJOR | FIXED (D-REF-B1) | 0012 `refunds_one_requested_per_origin`; port `fileServerRequest`. Test "B09-F3: an overpaid capture whose subject no longer binds files its EXCESS_CAPTURE and KAURO_REMEDY requests …" (P6 reproduced, committed) |
| B09-F4 invoice unvalidatable after a re-review | MAJOR | FIXED (D-FISC-B4) | 0013 `tax_documents_validation_guard` (in force at the tax point); domain `profileInForceAt`, `resolveFiscalTreatment`; port `profileInForceAt` (since B09-N5 `saleProfileAt`). Tests "B09-F4: an invoice validates under the profile version in force …" (P3 reproduced, validates) and domain "B09-F4 (D-FISC-B4): …" |
| B09-F5 no deliverable-capacity precondition | MAJOR | FIXED (D-CAP-B1) | domain `checkoutBlockers` (DELIVERY_CAPACITY_UNAVAILABLE → CAPACITY_UNAVAILABLE), `DeliveryCapacityPort` (B08 adapter), outcomes of CMD028/CMD029. Tests domain "B09-F5 (D-CAP-B1): …", application "B09-F1/B09-F5/B09-F6: …"; the command DENY test is planned in the case map (M4, labelled fake) |
| B09-F6 partial-refund tax allocation unspecified | MAJOR | FIXED (D-REF-B6) | domain `taxRemainingAfter`, `refundTaxFor`, `checkRefundTax`; 0012 `kauro.refund_tax_remaining` + ceiling (KP012); outcome REFUND_TAX_INCONSISTENT. Tests domain "B09-F6 (D-REF-B6): … 19% rule … one-cent sequence …" and database "B09-F6: an approval whose tax does not follow its service …" |
| B09-F7 mapped titles miss the registry DENY/RACE scenarios | MAJOR | FIXED (D-CASEMAP-B1) | `docs/design/B09-case-map.md` (every CMD028–CMD034 DENY and RACE title states the scenario; the RACE of CMD028, CMD029 and CMD033 crashes before the intent commits, between the intent commit and the claim, and between the claim and the settle), §8 triads. Tests `tools/test/b09-case-map.test.mjs` "B09-F7: …" (the second fails on the reviewed case map, and on a provider-effect RACE title without the claim/settle crash) |
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
| B09-N1 request handlers publish provider-fact event types; the ledger accepts them | MAJOR | FIXED (D-EVT-B3) | 0009 `kauro.commerce_event_bindings`, `kauro.commerce_event_subscriptions`, trigger `domain_events_commerce_kind`, function `kauro.require_commerce_event_type`, restrictive policies `domain_events_commerce_request_handlers` and `outbox_records_commerce_subscribers`; 0010–0013 the `*_event_type_per_version` triggers; 0011 `domain_events_capture_completed_once` keyed on `(aggregate_kind, aggregate_id)`; 0013 `ledger_entries_source_event` checks the event's kind and that its aggregate is the source reference; domain `COMMERCE_STATE_EVENT_TYPES`, `commerceVersionEventType`, `COMMERCE_REQUEST_HANDLER_EVENT_TYPES`. Tests "B09-N1: an event records a version of an aggregate of its own kind …" (the probe reproduced as `kauro_app_test`: `capture.completed.v1` on its quote refused KA003, another state's type refused KA003 at COMMIT, each of the 37 types it does not author refused 42501 on a visible aggregate of its kind, four more as a corporate owner, outbox records of its quote event to FINANCE, FISCAL, COMMISSIONS and EXECUTION_CONTROL refused 42501; the payment service's mislabelled versions refused KA003; a CAPTURE posting of the completion under the quote, the order or another capture refused KP001) and domain "B09-N1 (D-EVT-B3): …" |
| B09-N2 closed views refuse DELIVERY_CAPACITY_UNAVAILABLE and DISPUTE_OPEN | MINOR | FIXED (B06 D-RESP-1, D-CAP-B1, D-DISPUTE-B1) | `packages/application/src/commerce/response-schemas.ts` derives `CHECKOUT_BLOCKER_TOKENS` from the domain's `CHECKOUT_BLOCKERS` (so `maxItems` is its size) and the `openCases` kind enum from `RECONCILIATION_CASE_KINDS` (`commerce/records.ts`, the 0012 CHECK's order); OpenAPI regenerated. Test application "B09-N2: the closed views admit every token the domain can put in them …" |
| B09-N3 a capture first observed REVERSED can never be posted and has no tax point | MINOR | FIXED (D-PAY-B5) | domain `captureStatusStep` (a REVERSED observation of an unknown or PENDING capture walks COMPLETED first, `then`), the CaptureFact machine without PENDING → REVERSED, port `NewCaptureFact.status`; 0011 seed without the edge (so `enforce_observed_birth` refuses a REVERSED birth), `capture_facts_completion_time` covers REVERSED, allocation only at the COMPLETED version; matrix regenerated. Tests "B09-N3: a capture first seen REVERSED is recorded COMPLETED and then REVERSED …" (the probe's birth refused KA008; the two-version path posts CAPTURE and CHARGEBACK, nets the receivable to zero and validates the invoice at its completion) and domain "B09-N3 (D-PAY-B5): …" |
| B09-N4 funds postings drain the receivable fees and returns still credit; FUNDS to BANK_CASH admitted; CMD034-DENY claimed without a test | MINOR | FIXED (D-LEDGER-B5) | domain `commerce/ledger.ts` (`fundsAccountOf`; `providerFeePostings` and `returnPostings` take the funds state their event names; `fundsPostings` moves `movableBalanceOf`; header rewritten), payload `fundsState` on `capture.fee_observed.v1`, `capture.reversed.v1`, `refund.completed.v1`; 0013 `ledger_entries_funds_accounts`, `ledger_entries_bank_accounts`; case map CMD034-DENY now cites "B09-N4: …". Tests "B09-N4: a FUNDS posting moves money only between the provider's receivable, held and available balances …" (the probe's BANK_CASH set refused 23514) and domain "B09-N4 (D-LEDGER-B5): …" (no provider balance of a capture negative across completion, fee, HELD, refund, AVAILABLE) |
| B09-N5 the fiscal version of a credit note is specified inconsistently | MINOR | FIXED (D-FISC-B4, D-FISC-B6) | domain `commerce/fiscal.ts` (`FiscalTreatmentInput.taxPoint`: the sale's tax point for every document; `profileInForceAt` as the database reads it; `saleProfileAt`, the one rule), `records.ts` `recordedAt`, port `FiscalRepository.saleProfileAt`; 0010 `fiscal_profiles_successor_fk`, `fiscal_profiles_supersession_lineage` (the version current at an instant is unique); design §4.2, §4.5, §8.1, D-FISC-B4. Tests domain "B09-N5 (D-FISC-B4, D-FISC-B6): … a credit note drafted after a re-review keeps the invoice's version …" and "B09-N5: fiscal profile versions form one lineage …" (a credit note of a refund completed after the re-review validates under the invoice's version and is refused under the re-review) |
| B09-N6 attribution keys do not bind an attempt to the order the row names | MINOR | FIXED (D-BIND-B2) | 0011 `payment_attempts_order_binding` UNIQUE `(agency_id, attempt_id, order_id)`, `provider_observations_attempt_fk`, `capture_facts_attempt_fk`; 0012 `provider_event_exceptions_attempt_fk`, `reconciliation_cases_capture_order_fk`, `…_refund_order_fk`, `…_refund_capture_fk`. Test "B09-N6: an attempt named by a provider exception, an observation or a capture fact is an attempt of the order that row names …" (the probe's exception refused 23503) |
| B09-N7 the request handlers set an unbounded dispatch deadline | MINOR | FIXED (D-PROTO-B6) | 0011 `payment_attempts_dispatch_deadline_bound` (in the future and at most 60 s after the claim's instant, whoever claims); domain `DISPATCH_DEADLINE_SECONDS`; §6.1 T2. Tests "B09-N7: a claim records a dispatch deadline in the future and at most the protocol's 60 seconds ahead …" (the probe's 876,000-hour deadline refused 23514) and application "B09-N2: … B09-N7: the claim deadline's bound is the protocol's timeout plus the watchdog margin" |
| B09-N8 the implementation mandates are not self-contained; the stale hand-off | MINOR | FIXED (D-STAGE-B1) | §14 rewritten as staged, self-contained mandates (stage, starting branch, owned fakes, scope, tests, done-when); M1 implements B09's own `CommercialAuthorizationRepository.findLiveByRevisionHash` and the integrator binds B07's `CommercialScopeInspector` to it (§15 item 6); the `observeFunds` / `observeFee` typo gone; the stale `architect_B09.json` is declared superseded (§14, §15 item 15) — the file lies outside this worktree, so the workflow replaces it from this revision's hand-off. Test `tools/test/b09-design.test.mjs` "B09-N8: …" (fails on `30a3202`'s §14) |
| FINAL-N1 (re-check of `3f4af4a`) a case with no order can name the refund of one purchase and the capture of another | MINOR | FIXED by M1 (D-BIND-B3) | 0012 `refunds_capture_binding`, `reconciliation_cases_refund_own_capture_fk`; `src/sqlstate.ts` `COMMERCE_INTEGRITY_CONSTRAINTS`. Test `packages/persistence/test/adapters-commerce-refunds-ledger.test.ts` "B09-FINAL-N1 (D-BIND-B2): …" (fails on the migration's first form: the crossed case commits) |
| N4 residual (re-check of `3f4af4a`) a full return after a reported fee drives the capture's receivable or held balance negative by the fee | MINOR | FIXED at the stage-1 integration (D-LEDGER-B6; Q-B09-23 answered) | domain `commerce/ledger.ts` (`MERCHANT_BALANCE_ACCOUNT`; `providerFeePostings` and `returnPostings` take the movable balance before them and credit the rest to PSP_AVAILABLE; `movableBalanceOf`'s comment no longer contradicts them), `commerce/events.ts` (`movableBalanceCents` on capture.fee_observed.v1, capture.reversed.v1, refund.completed.v1); M1's adapters publish it (`commerce-captures.ts` observeFee and the REVERSED edge, `commerce-refunds.ts` the completion, after D-REF-B7's wait); M2's `planPostings` and `planObservation` carry and read it. Tests domain "B09-N4 residual (D-LEDGER-B6): …" (the residual's replay: the receivable ended at -5275 on the merged heads; also HELD, a chargeback after a partial refund, and a fee reported after the whole capture went back), application "planPostings — D-LEDGER-B6 (the re-check's residual N4): …" (replaces the M2 test that documented the negative receivable), persistence `adapters-commerce-balances.test.ts` "D-LEDGER-B6 and D-REF-B7 (the re-check's residual N4): …" (the payloads the adapters publish, posted through LedgerRepository: receivable 0, available -5275); the domain B09-N4 title now scopes its claim to returns within the movable balance |
| FINAL-N2 (re-check of `3f4af4a`) a REVERSED observation without a completion instant has no rule | MINOR | FIXED by M2 (D-PAY-B6) | `planObservation` records a completion only with the observation's own completion instant; without it nothing is applied, no observation row is appended, the webhook's record is settled RETRYABLE and `providerQueryRequired` asks for a stored provider query; a stored query without it opens PROVIDER_INCONSISTENCY `COMPLETION_TIME_UNKNOWN`. Tests `packages/application/test/commerce-planners.test.ts` "planObservation — D-PAY-B5 (B09-N3): … without its completion instant nothing is applied (D-PAY-B6)" and `commerce-core.test.ts` "CommerceReconciler — D-PAY-B6 (residual FINAL-N2): …"; the database half is `capture_facts_completion_time` (0011) |
| INT1-1 (stage-1 integration) two completions of one capture's refunds run side by side | MINOR | FIXED at the stage-1 integration (D-REF-B7) | found while carrying the movable balance into refund.completed.v1: a completion took only FOR SHARE of the capture row, which two completions share, so each read the capture's completed refunds without the other — the service basis its event published (R2-081) and, with D-LEDGER-B6, the movable balance were wrong for the second, and two halves of a full refund whose deferred checks ran before either committed both committed with the entitlement live (KP006 bypassed). 0012 `refunds_completion_order` takes the capture's shared transition half and its exclusive refund lock in the completion's update. Tests `packages/persistence/test/adapters-commerce-balances.test.ts` "D-LEDGER-B6 and D-REF-B7 …" (the second completion observed waiting, its payload counting the first) and "D-REF-B7: the database orders the completions of one capture's refunds whatever writes them — …" (with the check run at once in both transactions the second waits and is refused KP006) |
| FINAL-N3 (re-check of `3f4af4a`) no mandate binds the commercial inspectors | MINOR | FIXED — M1's half (D-INSP-B1) and the binding at the stage-1 integration | `@kauro/persistence` `commercialInspectionsOf(uow)` (`unreconciledForPlan`, `liveAuthorizationsOfClient`; `src/repositories/commerce-inspections.ts`), bound in `apps/api/src/edition.ts` (`commercialConsequencesInspector`, `activeWorkInspector`) and the composition root. Tests `packages/persistence/test/adapters-commerce-unit-of-work.test.ts` "the queries behind B06's inspectors: …" and, through the routes with a paid, live authorization written by the commerce adapters (`@kauro/persistence/testing` `paidPurchase`), `apps/api/test/b09-inspectors.test.ts` "FINAL-N3 (D-INSP-B1) CMD023 DENY: …" and "FINAL-N3 (D-INSP-B1) CMD010: …" — both fail with the edition's former constant bindings (the revision commits 201; the archive reports 0) |
| M4-1 (stage 2, M4) a creation the provider proved had no effect answers the member NOT_FOUND | MINOR | FIXED by M4 (D-REQ-B8) | found by the first run of M2's provider-effect runtime over M1's policies on a real database: a later creation attempt's claim, and the preparation of a new deliberate attempt after PROVED_NO_EFFECT, locked the CREATING order `FOR UPDATE` in the member's unit of work, and `payment_orders_tenant_claim` admits `kauro_app`'s lock only in INTENT_CREATED, CREATED and APPROVED, so the lock found no row and the member's own order answered 404. `packages/application/src/commerce/core/provider-effects.ts` (`subjectOf` locks the order only where the claim writes it; the NEW_ATTEMPT step reads it and writes only the attempt); CMD029 and CMD032 answer a state their role may not lock from the committed row. Test `apps/api/test/cmd028-create-payment-order.test.ts` "D-REQ-B8: …" (fails on the stage-1 core with "expected 201, got 404") |

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
demonstrates the scenario …", and on this revision's first case map (`b6adfdb`, whose provider-effect RACE titles named only the
crash between the intent commit and the claim) with "CMD028-RACE: no cited test injects the crash on both sides of the intent
commit and between the claim and the settle of the provider call". Every other critique test stays green under each mutation.

Revert proofs of the re-check's fixes (each database fix undone in place in its migration, `dist/test/b09-critique.test.js` run
with the finding's test on a fresh PostgreSQL 17 cluster, the file restored and checked by SHA-256): the kind trigger dropped, the
request-handler policy moved off `kauro_app`, the event-type function returning early, the subscribers' policy moved off the
writers, or the ledger's source binding reduced to the event type, each fails "B09-N1"; the PENDING → REVERSED edge seeded again
fails "B09-N3"; `ledger_entries_funds_accounts` or `ledger_entries_bank_accounts` dropped fails "B09-N4"; `fiscal_profiles_successor_fk`
or the lineage trigger dropped fails "B09-N5"; the exception's or the capture's attempt key narrowed to `(agency_id, attempt_id)`
fails "B09-N6"; the deadline bound's trigger dropped fails "B09-N7". The domain, application and tools tests of B09-N1..N5, N7 and
N8 do not compile or fail on `30a3202` (`saleProfileAt`, `movableBalanceOf`, `DISPATCH_DEADLINE_SECONDS`, `RECONCILIATION_CASE_KINDS`
and the staged §14 do not exist there; `captureStatusStep(null, "REVERSED")` answers a REVERSED insert).

Revert proofs of the stage-1 integration: `refunds_completion_order` removed from 0012 in place (the file restored and checked by
SHA-256) fails both tests of `adapters-commerce-balances.test.ts` — the second completion is never observed waiting ("no backend of
kauro-test-payment waited on a lock while running UPDATE kauro.refunds AS t") and, in the database test, the second completion settles
without waiting; `returnPostings` and `providerFeePostings` crediting the whole amount to the funds state's balance again (the merged
heads' behaviour) fail the domain "B09-N4 residual (D-LEDGER-B6): …" test with the receivable at -5275.

Revert proof of M4 (stage 2): `packages/application/src/commerce/core/provider-effects.ts` restored to its stage-1 form (`de457f6`)
fails the "D-REQ-B8: …" test of `apps/api/test/cmd028-create-payment-order.test.ts` with "expected 201, got 404" (the member's own
order hidden from the lock the tenant policy does not admit); the file restored and checked by SHA-256 (`4d4e2a75…`) passes it again.
