# B06 — Domain, database and authorization: design

Branch `b06/design`. Package B06 of the build program (22 "B06 — Domain, database and authorization": implement aggregate
identity, SQL migrations, tenant constraints, memberships, assurance, command idempotency and API schemas; use real PostgreSQL
to test pooled tenant context, composite foreign keys, last-owner races and every role's read/write boundary; provide complete
DTO/state/error contracts). Gates G-DOMAIN and G-TENANT. Owning manuals 07, 08, 10, 21; contracts and cases from the vendored
R2 registry under `packages/contracts/registry` (provenance-checked).

Everything in this document is either quoted from the authority (section named) or a recorded decision (`D-*`). Where the
authority is silent the decision states its rationale; §11 lists the questions to return to the authority. Product and source
language is English; the brand is Kauro (amendment A2), the vendored registry stays as quoted.

What this branch delivers, and what it does not:

| delivered here | left to the B06 implementation mandate |
|---|---|
| `packages/persistence/migrations/0001..0007` — the complete schema, roles, constraints, RLS, outbox/inbox, journals, leases, applied and tested on PostgreSQL 17.6 | repository / unit-of-work / event-publisher / journal / lease adapters over `pg` |
| `@kauro/domain` — identity scheme, role model, state-machine guards, event vocabulary, failure taxonomy, idempotency identity, ports | `@kauro/authorization` (the `Authorizer` implementation) |
| `@kauro/application` — command contracts of the seven commands, envelope, safe problem contract, closed request schemas, DTO views, ports | the seven command handlers, `apps/api` (Fastify + Ajv strict), the outbox dispatcher |
| `@kauro/persistence` — checksummed migration runner, temporary-cluster helper, SQLSTATE translation, 26 real-database tests | the 29 acceptance cases end to end (docs/design/B06-case-map.md names each test) |

## 1. Decisions register

| id | decision | why (authority) |
|---|---|---|
| D-SCOPE-1 | The agency selector is the path `agencyId` where the route has one; every other command route carries the active-agency context in the `X-Kauro-Agency` header. The server binds that agency as the transaction context, checks membership, and then looks the resource up under RLS: a resource of another agency is simply not found. No SECURITY DEFINER resolver exists. | 10 "Client-supplied agency IDs are selectors, not authority. The authenticated identity's membership and the resource's actual agency determine access"; 02 "A user who belongs to two agencies actively switches context and sees a persistent agency indicator"; 08 "SECURITY DEFINER functions require a specific justification" (none needed). |
| D-ID-1 | Aggregate ids are UUIDv7 minted by the server (`IdGenerator`); the database CHECKs the version nibble on every aggregate id column. | 07 "Internal IDs use server-generated UUIDv7 or a compatible opaque scheme fixed in the contract registry." |
| D-ID-2 | The identity reference of a person (`identities.user_id`) is UUIDv5(namespace, `provider:subject`), derived by the server. The raw provider subject is stored only as a SHA-256. | 03 "Opaque application identifiers are server-generated strings with an explicit entity type"; a derived id lets identity sync be a write under the caller's own row policy without any privileged lookup. |
| D-CTX-1 | Three execution contexts: TENANT (agency + user), IDENTITY (user only: CreateAgency, own memberships, identity sync), SYSTEM (control plane under `kauro_control`). Context is bound with `set_config(..., true)` (SET LOCAL) and therefore vanishes at COMMIT/ROLLBACK. | 08 "Tenant context is set transaction-locally and cleared on pool return ... A request without valid context fails closed." |
| D-CTX-2 | CreateAgency adopts the agency id it mints (IDENTITY → TENANT once, inside the same transaction) so the agency and owner rows satisfy WITH CHECK. | 08 "RLS policies apply both visibility and writes through USING and WITH CHECK"; the alternative (a policy allowing inserts without context) would open a hole. |
| D-RLS-1 | Every kauro table has RLS enabled and FORCED; runtime roles `kauro_app` (request handlers) and `kauro_control` (control plane) are NOLOGIN group roles with NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB; the migrator `kauro_owner` owns the objects and has no DML policy, so even the owner cannot read or write tenant rows. Login roles are provisioning (`... LOGIN IN ROLE kauro_app`). | 07 "Runtime roles are neither database owners nor superusers and do not have BYPASSRLS"; 08 "FORCE ROW LEVEL SECURITY is used where required by the ownership arrangement, and privileged migration roles are never used by request handlers." |
| D-RLS-2 | Request handlers never hold DELETE on any table. Deletion is a managed lifecycle (B07/B12 packages, control plane). | 07 "Restoration and migration"; 09 (deletion is a lifecycle, never a request side effect). |
| D-VER-1 | Every aggregate row carries `version`; an UPDATE either bumps it by exactly one or changes nothing (trigger `enforce_version_bump`, SQLSTATE KA002). Commands compare-and-swap on the expected version; a miss returns the current safe version and state. | 07 "Aggregate versions and event sequence numbers establish concurrency order"; 10 "A stale edit returns the current safe version and a code directing the UI to reload or compare." |
| D-EVT-1 | A new aggregate version cannot commit without its domain event: deferred constraint trigger `require_event_for_version` (KA003) on agencies, memberships, end_clients, projects, dataset_revisions, plans, approvals. | 07 "A successful command commits state, domain event and outbox record atomically." |
| D-EVT-2 | Event types are registered (`kauro.event_types`, FK from `domain_events`; mirrored by `EVENT_TYPES` in the domain, tested equal). Payloads are allowlisted per type: ids, hashes, uppercase tokens, non-negative integers, booleans, lists of ids/hashes — never a label. Outbox fan-out is code-owned (`EVENT_SUBSCRIPTIONS`). | 07 "DomainEvent ... contains references and safe counts, never CRM rows or secrets"; contract OutboxRecord "consumer: Registered destination". |
| D-IDEM-1 | Request digest = SHA-256 of the canonical JSON of `{domain: KAURO_COMMAND_REQUEST_V1, version: 1, payload: {operation, aggregate (path ids), body}}`. The domain string is a platform domain (the authority's digest table has no member for the request digest). | 10 "The stored request digest includes every material command field"; reference/HASHING_AND_ACCOUNTING_RULES "Every structured digest uses a named domain and version." |
| D-IDEM-2 | The journal row (state RESERVED) is the first write of a command and is completed (COMMITTED + stored response + resource link) in the same transaction. A rejected command rolls its reservation back: rejections leave no journal row; only committed outcomes replay. | 10 "The first accepted request records its intent before external dispatch. A concurrent duplicate receives the same durable operation reference or final result." |
| D-IDEM-3 | The R2 `RequestJournal` contract (manual 06: physical dispatch attempts, fences, reserved cents) is a separate table from the command journal (manual 10 idempotency). One committed command may produce several journaled dispatch attempts. | Contract RequestJournal fields (taskId, fence, usageState, reservedCents) describe a provider dispatch, not an HTTP command. |
| D-OWN-1 | The last-owner invariant is a counter on the agency row (`active_owner_count`) maintained by trigger on memberships; the counter UPDATE takes the agency row lock, which serializes concurrent owner removals; a removal that would leave zero active owners outside CLOSING/CLOSED is refused (KA001). | 07 "Concurrent owner removals lock or otherwise serialize the ownership invariant"; R2-043. |
| D-AUTHZ-1 | Command role → membership roles: AGENCY_OWNER {OWNER}; AGENCY_OWNER_OR_ADMIN and AGENCY_ADMIN {OWNER, ADMIN}; AGENCY_OPERATOR {OWNER, ADMIN, OPERATOR}; AGENCY_APPROVER {OWNER, APPROVER}; AGENCY_BILLING {OWNER, BILLING}; AGENCY_READER and AGENCY_MEMBER: any live membership. | 08 "Agency Owner can manage its agency, client workspaces, projects, team, billing and branding. It can approve plans ... Agency Member can create and work on projects ... Plan approval, billing execution, team management and deletion require explicit capability grants." |
| D-AUTHZ-2 | ADMIN does not approve plans and does not execute billing; APPROVER, BILLING and VIEWER do not create clients or projects. | 08 least privilege; the registry role vocabulary is the capability grant of this edition. |
| D-AUTHZ-3 | WithdrawApproval (CMD026) may be issued by the approval's own actor or by any OWNER; another APPROVER is refused with NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER. | CMD026 precondition "The actor controls this approval"; Plan machine guard "Current organization authority withdraws future use." |
| D-AUTHZ-4 | A caller with no live membership in the selected agency gets NOT_FOUND, not NOT_AUTHORIZED; a SUSPENDED member gets NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED; a wrong role gets NOT_AUTHORIZED / ROLE_INSUFFICIENT. | 08 "Requests for a foreign resource and nonexistent resource produce equivalent safe visibility where needed"; 07 SUSPENDED "Stop new commands/capabilities; preserve account history." |
| D-ASSUR-1 | Step-up freshness is 900 seconds; a proof is bound to the actor, reusable inside its window. The policy registry carries no value: open question Q1. | 08 "High-impact actions require recent step-up ... The policy registry owns assurance freshness values." |
| D-ASSUR-2 | VERIFIED_USER means identity state ACTIVE with `email_verified_at` and `mfa_enrolled_at` present. | 08 "Agency data access requires verified email and enrolled MFA under the launch policy." |
| D-CMD-1 | Creation abuse limit, structural half: one DRAFT agency per creating identity (partial unique index `agencies_one_draft_per_creator`). The `AbuseLimiter` port adds rate limits (open question Q2 for the values). | CMD001 precondition "creation abuse limits must admit the request"; 08 "A user cannot obtain a new free audit by retrying ..."; 07 "Unique constraints close races." |
| D-CMD-2 | Client and project creation are permitted while the agency is DRAFT or ACTIVE (`AGENCY_OPEN_STATES`); RESTRICTED, CLOSING and CLOSED refuse with PRECONDITION_FAILED / AGENCY_NOT_OPEN. Uploads and execution (later packages) require ACTIVE. | 07 "DRAFT permits identity and agreement setup but not customer-data execution"; 02 journey step 3 precedes upload; RESTRICTED "can block new purchases or data operations". |
| D-CMD-3 | ArchiveClient does not require the absence of active work: it stops new projects and *reports* the retained active work (open projects, active jobs, live commercial authorizations) in its response; that report is the "review". | 10 "Archiving a client stops new projects but does not delete active paid work implicitly"; CMD010 failure "Archiving cannot become an implicit deletion or refund." |
| D-CMD-4 | `targetInstanceRef` is optional in the CMD011 schema and required by the handler for HUBSPOT and SALESFORCE (CHECK `projects_crm_mode_declares_target`); CLEAN needs none. | 02 "Service modes": CLEAN "No live CRM contract required"; HUBSPOT/SALESFORCE need a target. |
| D-CMD-5 | `expectedVersion` is required in the body of every command whose catalogue entry lists it (CMD010, CMD023, CMD025, CMD026); `If-Match` is not used in v1. | 10 "Edits require If-Match or expectedVersion"; reference/COMMAND_CATALOGUE lists the field. |
| D-PLAN-1 | A plan revision is its own row (`plans.plan_id`). RevisePlan compare-and-swaps the predecessor to SUPERSEDED (version + 1), inserts the successor (DRAFT, version 1) and applies `compiled_or_edited` to it (VALIDATION_REQUIRED, version 2), all in one transaction. The predecessor names its successor and the successor its predecessor. | Plan machine: `new_plan_revision` moves the predecessor to SUPERSEDED "Keep predecessor history"; 07 "Edits create a new version." |
| D-PLAN-2 | Approval bindings are foreign keys, not application checks: `(plan_id, plan_hash, revision_hash, target_contract_hash)` must equal the plan's own body/source/target, and `validation_receipt_hash` must be a receipt of that same plan with those subjects. One live approval per plan (partial unique index). | CMD025 effect "Create immutable approval for exact plan/source/target/disclosures"; 07 "Application checks improve messages but cannot be the sole protection." |
| D-PLAN-3 | The disclosures hash is computed server-side (`DisclosureComposer`) from the validated plan and receipt and includes every CLEAR operation; the client echoes the hash it displayed; a mismatch is STALE_VERSION with `mismatch: ["disclosuresHash"]`. | CMD025 failure "generic cleanup approval cannot authorize undisclosed CLEAR"; 03 "CLEAR requires ... affected count and approval hash." |
| D-AGG-1 | Project (no registry contract) has states OPEN, CLOSED, DELETION_REQUESTED, DELETED with listed edges OPEN→CLOSED, OPEN→DELETION_REQUESTED, CLOSED→DELETION_REQUESTED, DELETION_REQUESTED→DELETED. B06 creates OPEN projects only. | 07 "Aggregate ownership" names Project; 07 "Package and import states" puts closure distinctions on delivery; 10 deletion-requests route. |
| D-AGG-2 | EndClient carries a `version` (the registry contract has none) because CMD010 names `expectedVersion`; its only listed edge is ACTIVE→ARCHIVED. The `EndClientView` DTO exposes the version. | CMD010 field list; 10 "Resource reads return a version or ETag where edits are supported." |
| D-ERR-1..3 | Three platform failure codes beside the seventeen of manual 10: PRECONDITION_FAILED (409, an aggregate is not in a state the listed transition allows), ADMISSION_LIMITED (429, abuse/capacity admission refused), INTERNAL_ERROR (500, opaque by correlation id). | 10 "Stable codes include ..." (the list is not closed); 07 "Authentication, authorization, stale version, invalid input ... are distinct." |
| D-LEASE-1 | Leases carry the immutable subject (`subject_hash`), the absolute `deadline_at` and the `checkpoint_hash` of the leased operation. A takeover advances the fence by one; a resume must present the stored checkpoint; deadline and subject never change; a renewal never extends past the deadline. | Contract Lease; 07 "A lease renewal cannot change the immutable execution subject"; S090. |
| D-S089/S090/S093 | See §10: the registry assigns these three cases to B06/G-DOMAIN although their subjects (mandate materialization, RESUME semantics, schema compilation) are owned by manuals 22 and 10. B06 demonstrates their domain/database half and names the boundary honestly. | 21 "NOT_APPLICABLE requires a reason; it is not a way to avoid a promised feature." |

## 2. Topology and packages (07 "Platform topology")

Dependencies flow contracts → domain ports → application → adapters; `architecture.rules.json` and `tools/architecture-gate.mjs`
enforce it (4 packages, 5 edges, no violation).

```
@kauro/contracts     registry (provenance), generated types + JSON Schemas, canonical JSON, digests
@kauro/domain        model/ids, model/roles, model/state-machines, model/events, model/tenant, model/aggregates,
                     model/errors, model/idempotency; ports/{clock,id-generator,unit-of-work,event-publisher,
                     command-journal,repositories,lease-store,request-journal}
@kauro/application   ports/{authorizer,assurance-and-admission,schema-validator,plan-services,work-inspectors,
                     command-handler}; api/{problems,envelope,request-schemas,views}; commands/contracts
@kauro/persistence   migrations/*.sql, migrations/runner, testing/temporary-postgres, sqlstate
```

Ports are TypeScript interfaces; the adapters (repositories over `pg`, unit of work, event publisher, journals, lease store),
the `Authorizer` (`@kauro/authorization`), the handlers and `apps/api` are the implementation mandate. A pure reference
implementation ships where the domain owns the algorithm and nothing else can: `createIdGenerator` (UUIDv7, monotonic within a
millisecond), `identityUserId` (UUIDv5), `commandRequestDigest`, `assertAllowlistedPayload`, `transition`.

## 3. Identity (07 "Database representation", 03 "Shared representations")

- Aggregate ids: UUIDv7, server-minted (`IdGenerator.next()`), CHECK `kauro.is_uuid_v7(...)` on every aggregate id column.
  Embedded time is diagnostic only; ordering is `version` (per aggregate) and `domain_events.sequence` (global append order).
- Person ids: UUIDv5(`6f1b0d2e-3c4a-4b5c-9d6e-7f8091a2b3c4`, `provider:subject`), CHECK `kauro.is_uuid_v5`. A customer-provided
  identifier is a value, never an application id; external references the platform did not mint (`target_instance_ref`) are
  stored as opaque uuids without the v7 check.
- Ids are scoped even when globally unique: every tenant-owned foreign key is composite `(agency_id, <id>)` (§4).
- Branded TypeScript ids (`AgencyId`, `ClientId`, ...) make a client id unusable where an agency id is required.

## 4. Database representation (07 "Database representation", 08 "Database isolation")

Schema `kauro`, PostgreSQL 17. Money is BIGINT minor units, instants are `timestamptz`, exact decimals stay text/numeric, JSONB
only for closed-schema variable content (`plans.body`, `target_contracts.objects`, `domain_events.payload`, receipts' `counts`).
Uniqueness always includes scope; list indexes start with `agency_id` and end with the unique tie-breaker of the pagination
order (`end_clients (agency_id, created_at, client_id)`; `projects (agency_id, client_id, created_at, project_id)`).

### 4.1 Tables

| table | aggregate / contract | key columns and constraints | RLS (kauro_app unless noted) |
|---|---|---|---|
| `identities` | Identity (08) | `user_id` v5 PK; `(provider, subject_hash)` unique; `state` ACTIVE/DISABLED; `email_verified_at`, `mfa_enrolled_at` | self: `user_id = current_user_id()` |
| `assurance_proofs` | step-up proofs (08) | v7 PK; FK identities; `kind` STEP_UP; `method` TOTP/WEBAUTHN/IDP_REAUTH; `expires_at > issued_at`; append-only | self |
| `agencies` | Agency | v7 PK; `version`; `state` (registry enum); `active_owner_count`; CHECK activation needs terms + privacy + legal profile; **unique `created_by_user_id` WHERE state = DRAFT** | tenant (`agency_id = current_agency_id()`) + member read |
| `memberships` | Membership | v7 PK; `(agency_id, membership_id)` unique; FK identities; `role`, `state` (registry enums); **one live membership per (agency, user)**; ACTIVE/SUSPENDED need `accepted_at`; REVOKED needs `revoked_at` | tenant + self read |
| `membership_invitations` | invitation token (08) | v7 PK; `token_hash` unique sha256; composite FKs to memberships; one open invitation per membership | tenant |
| `capabilities` | Capability | v7 PK; `kind`/`mode`; `state` (registry enum); offered/qualified states must cite evidence; **one offered capability per mode** | read all; `kauro_control` all |
| `processing_authorities` | EndClient.processingAuthorityRef evidence | v7 PK; `(agency_id, id)` unique; composite FK to the recording membership; append-only | tenant |
| `end_clients` | EndClient (+ version, D-AGG-2) | v7 PK; `(agency_id, client_id)` unique; **composite FK `(agency_id, processing_authority_ref)`**; ARCHIVED ⇔ `archived_at`; no uniqueness on `display_name` | tenant |
| `projects` | Project (D-AGG-1) | v7 PK; `(agency_id, project_id)` unique; **composite FKs to end_clients, memberships, dataset_revisions (deferred)**; FK capabilities; CRM mode ⇒ `target_instance_ref` | tenant |
| `dataset_revisions` | DatasetRevision identity | v7 PK; `(agency_id, revision_id)` unique; composite FKs to projects and to the superseded revision; sealed states need manifest/projection/sealed_at; **`(agency_id, manifest_hash)` unique** | tenant |
| `target_contracts` | TargetContract identity | v7 PK; composite FK to projects; `objects` JSONB array (data, S093) + `schema_bundle_digest`; immutable except confirmation/supersession | tenant |
| `plans` | Plan (revision row, D-PLAN-1) | v7 PK; `(agency_id, plan_id)` unique; **`(agency_id, plan_id, body_hash, revision_hash, target_contract_hash)` unique** (binding target); composite FKs to projects, predecessor, successor (deferred), membership; receipt FK; approval FK (deferred); **a predecessor is superseded once** (partial unique on `supersedes_plan_id`); semantic columns immutable | tenant |
| `validation_receipts` | ValidationReceipt | v7 PK; `(agency_id, receipt_hash)` unique; **six-column FK to plans** (a receipt is for an existing plan body with those subjects); VALID ⇒ no blocking codes; append-only | tenant |
| `approvals` | Approval (+ version, actor membership version, proof) | v7 PK; **FK to plans over (plan_id, plan_hash, revision_hash, target_contract_hash)** and **FK to validation_receipts over six columns**; **one live approval per plan**; withdrawal columns all-or-nothing, set once | tenant |
| `event_types` | registered event types | text PK; seeded (= `EVENT_TYPES`) | read |
| `domain_events` | DomainEvent | v7 PK; identity `sequence`; **`(aggregate_kind, aggregate_id, aggregate_version)` unique**; FK event_types; payload object ≤ 16 KiB + `payload_hash`; actor shape; append-only | tenant (agency_id); `kauro_control` all |
| `outbox_records` | OutboxRecord | v7 PK; FK domain_events; `(event_id, consumer)` unique; state enum; attempts never decrease; DELIVERED is final | tenant through the event; `kauro_control` all |
| `inbox_records` | InboxRecord | v7 PK; **`(provider, environment, external_event_id)` unique**; `body_hash`; APPLIED ⇔ `applied_at` | ingress (all) and control |
| `command_journal` | idempotency record (10) | v7 PK; **identity unique index `(environment, actor_kind, actor_id, coalesce(agency_id, nil), operation, idempotency_key)`**; digest; COMMITTED needs status+body+resource+time; final entries never change | tenant, or identity-owned when `agency_id IS NULL`; `kauro_control` read |
| `request_journal` | RequestJournal | v7 PK; full `request_hash`; `fence ≥ 1`; `reserved_cents > 0`; `cost_grant_id NOT NULL`; `(task_id, fence)` unique; response before consume; terminal states final; reservation immutable | `kauro_control` all; tenant read |
| `leases` | Lease (+ subject, deadline, checkpoint) | PK `(resource_kind, resource_id)`; `fence ≥ 1`; `expires_at ≤ deadline_at`; deadline/subject immutable; fence/checkpoint guard | `kauro_control` all |
| `security_events` | security facts (08) | v7 PK; actor/action/outcome/reason/policy/assurance/correlation/time; append-only | tenant or identity-owned insert; tenant read; control all |
| `state_transitions` | listed edges (reference/TRANSITIONS) | PK `(machine, from, to)`; seeded per machine; trigger `enforce_listed_transition` on every aggregate with a machine | read |

Shared triggers: `touch_updated_at`; `enforce_version_bump` (KA002, exempt list per table: `active_owner_count` on agencies);
`require_event_for_version` (KA003, deferred constraint trigger); `forbid_change` (append-only tables, KA004);
`forbid_column_change` (immutable columns, KA004); `enforce_listed_transition` (KA008); `maintain_active_owner_count` (KA001);
`approvals_withdraw_once` (KA004); `outbox_records_guard`, `command_journal_guard`, `request_journal_guard` (KA007);
`leases_guard` (KA005). Functions `claim_lease`, `heartbeat_lease`, `checkpoint_lease`, `cancel_lease` are the atomic lease
operations (SECURITY INVOKER, run by `kauro_control`).

### 4.2 Roles, grants, context

| role | kind | what it may do |
|---|---|---|
| `kauro_owner` | migrator, object owner, LOGIN CREATEROLE | DDL through the runner; no DML policy anywhere (FORCE RLS); never in a request path |
| `kauro_app` | NOLOGIN group, request handlers | SELECT/INSERT/UPDATE on tenant tables under the tenant/self policies; INSERT on events, outbox, journal, security events, receipts; SELECT on capabilities, event types, request journal (own tenant); no DELETE anywhere; no access to leases |
| `kauro_control` | NOLOGIN group, control plane | outbox, leases, request journal, inbox, capabilities, security events, events (all tenants); no access to agencies, memberships, clients, projects, plans in this edition |
| `kauro_app_test`, `kauro_control_test` | LOGIN members created by the test helper | what their group allows |

Context binding: `SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)` inside the transaction.
`kauro.current_agency_id()` / `kauro.current_user_id()` return NULL for a missing or empty setting and raise for an unparsable
one. Every policy compares against those functions, so no context means no rows and no writes. Verified on the real server:
after COMMIT, ROLLBACK or an exception the same connection has no context (test `tenant-isolation`); two pooled connections in
different contexts interleave without leakage.

## 5. Transaction discipline (07 "Transaction discipline")

Every command runs in exactly one unit of work (`UnitOfWorkFactory.run(context, work)`): READ COMMITTED, row locks on the
aggregates it edits (`SELECT ... FOR UPDATE` through `lock(...)`), compare-and-swap on `version`, and the following write order:

1. `journal.reserve(identity, digest)` — the intent row (RESERVED). A concurrent duplicate blocks on the identity index here.
2. authorization inside the same transaction (membership read under the bound context; DENY appends a security event and rolls back).
3. `lock()` the edited aggregate(s); check `expectedVersion`; check the listed transition and every precondition of §7 in order.
4. writes: aggregate rows, then `events.publish(...)` for each new aggregate version (domain_events + outbox records for the registered consumers).
5. `journal.commit(entryId, {status, body, resourceKind, resourceId})`.
6. COMMIT. The deferred constraints (event-per-version, deferred FKs) are checked here.

Why READ COMMITTED is enough for the seven commands (07: "The implementation documents why the chosen isolation prevents the
relevant interleaving"): every multi-row invariant is closed by a lock or a unique constraint, not by a snapshot —

| invariant | closed by |
|---|---|
| one logical operation per idempotency key | `command_journal_identity` unique index (a duplicate waits for the first transaction, then replays or proceeds) |
| one DRAFT agency per identity | `agencies_one_draft_per_creator` |
| at least one active owner | agency row lock taken by `maintain_active_owner_count` + counter check (R2-043 test: the second remover waits on the lock and is refused after the first commits) |
| one live membership per person per agency | `memberships_one_live_per_user` |
| one revision supersedes a predecessor | CAS on the predecessor version + `plans_supersedes_once` |
| one live approval per plan | CAS on the plan version + `approvals_one_live_per_plan` |
| approval binds the exact plan/source/target/receipt | composite foreign keys (immutable plan columns) |
| a project has a draft revision | deferred FK `projects_current_revision_fk` |
| every version has its event | deferred constraint trigger |

No transaction spans a model call, a cloud job, a payment call or full-data processing: the seven commands are database-only.
A lost HTTP response after commit is recovered by the same key (`journal.find` → stored status and body); the client never
mints a new key because it got no answer.

Outbox: `EVENT_SUBSCRIPTIONS` registers NOTIFICATIONS (agency.created, membership.invited, approval.created, approval.withdrawn)
and EXECUTION_CONTROL (approval.withdrawn, plan.withdrawn, plan.superseded). Dispatch (control plane, later package) is at
least once under a lease (`resource_kind OUTBOX_DISPATCH`); consumers deduplicate by their inbox identity. Delivery is not the
business effect.

## 6. Authorization (08)

### 6.1 Identity is not permission

Authentication (Identity Platform, `apps/api`) yields `IdentityFacts` (user id, verification timestamps, state). The
`Authorizer` decides per consequential operation, inside the unit of work, in this order; the first failure is the answer:

| step | check | failure |
|---|---|---|
| 1 | authenticated subject present | AUTHENTICATION_REQUIRED (edge) |
| 2 | identity ACTIVE and verified (email + MFA) | NOT_AUTHORIZED / IDENTITY_DISABLED or IDENTITY_UNVERIFIED |
| 3 | command role VERIFIED_USER → ALLOW with no membership | — |
| 4 | agency selector present (path or header) | INVALID_REQUEST / TENANT_CONTEXT_MISSING |
| 5 | live membership of the caller in the selected agency (`memberships.findLive`) | NOT_FOUND (no INVITED/ACTIVE/SUSPENDED row; foreign and nonexistent look alike) |
| 6 | membership ACTIVE | NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED or MEMBERSHIP_NOT_ACTIVE (INVITED) |
| 7 | `roleSatisfies(commandRole, membership.role)` (D-AUTHZ-1) | NOT_AUTHORIZED / ROLE_INSUFFICIENT |
| 8 | step-up when the command names `assuranceProofRef` (CMD025): proof of this user, kind STEP_UP, issued within 900 s | ASSURANCE_REQUIRED / STEP_UP_MISSING, STEP_UP_NOT_OWNED, STEP_UP_STALE |
| 9 | resource relationship: the resource is visible under the bound context (RLS) and belongs to the scope | NOT_FOUND |
| 10 | state/version preconditions (§7) | per command |

A DENY of a consequential command appends a `security_events` row (actor, scope, action = command id, outcome DENY, reason,
policy version `B06-1`, assurance class, correlation, time). No membership is cached across requests; SUSPENDED → ACTIVE
re-checks everything (07 "do not reuse stale cached grants").

### 6.2 Roles and capabilities

`Membership.role` is the least-privilege grant. Capabilities (`ROLE_CAPABILITIES`) are derived for DTO `permittedActions`:

| role | capabilities |
|---|---|
| OWNER | all: MANAGE_AGENCY, MANAGE_TEAM, MANAGE_CLIENTS, CREATE_CLIENTS, OPERATE_PROJECTS, APPROVE_PLANS, MANAGE_BILLING, REQUEST_DELETION, MANAGE_BRANDING, VIEW |
| ADMIN | MANAGE_TEAM, MANAGE_CLIENTS, CREATE_CLIENTS, OPERATE_PROJECTS, REQUEST_DELETION, MANAGE_BRANDING, VIEW |
| OPERATOR | CREATE_CLIENTS, OPERATE_PROJECTS, VIEW |
| APPROVER | APPROVE_PLANS, VIEW |
| BILLING | MANAGE_BILLING, VIEW |
| VIEWER | VIEW |

Corporate and service roles of the catalogue (KAURO_OWNER, PAYMENT_SERVICE, ...) are not memberships; `roleSatisfies` denies
them by default and their authorizers arrive with their packages.

### 6.3 Invitation, revocation, ownership

A membership starts INVITED (row) with a hashed single-use token in `membership_invitations` (expiry, one open invitation per
membership, consumed xor revoked). Acceptance binds the intended identity (`user_id` fixed at invitation). Revocation is a
listed edge to REVOKED with `revoked_at`; the last-owner trigger refuses removing, suspending or demoting the last ACTIVE OWNER
unless the agency is CLOSING/CLOSED (explicit closure authority). Ownership transfer (CMD007, B16) is a versioned pair of
role changes in one transaction; the trigger guarantees it cannot pass through zero owners. A technical operator has no policy
on memberships at all (`kauro_control` cannot read them).

### 6.4 Assurance

`Membership.assurancePolicy` (label, e.g. `MFA_REQUIRED`) is the required strength of the membership; `assurance_proofs`
records each step-up (method, issued/expires, correlation). `AssuranceVerifier.verifyStepUp` returns FRESH/STALE/MISSING.
Approvals record `assurance_proof_ref` and the actor's membership version (07 "PlanApproval records actor identity, membership
version, assurance evidence").

### 6.5 Admission

`AbuseLimiter.admit(operation, {userId, agencyId})` runs before CreateAgency; the database independently refuses a second DRAFT
agency per identity (`ADMISSION_LIMITED / DRAFT_AGENCY_EXISTS`).

## 7. API envelope, safe errors, request schemas (10)

Envelope: `X-Correlation-Id` (opaque, generated when absent, echoed), `Idempotency-Key` (required on every command,
`^[A-Za-z0-9_-]{16,128}$`), `X-Kauro-Agency` (D-SCOPE-1), `Content-Type: application/json`, body ≤ 1 MiB, parser depth ≤ 16,
strings ≤ 40 000 characters, pages 25 default / 100 maximum (R2 policy `api`). Validation order: content type, size, JSON
syntax, duplicate keys, closed schema (Ajv strict, `coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`,
calendar `date-time` asserted), authenticated subject, authorization, then application execution; database queries occur
after structural validation.

Command results (07 "Command outcomes"): COMPLETED (200/201, view + version, `replayed` flag on an idempotent replay), ACCEPTED
(202, operation id — none of the seven), CONFLICT (409 STALE_VERSION / IDEMPOTENCY_CONFLICT / PRECONDITION_FAILED), REJECTED
(4xx), UNAVAILABLE (503 with retry policy).

Problem (`Problem`): `type` (`urn:kauro:problem:<code>`), `title`, `status`, `code`, `reason?`, `correlationId`, `errors?`
(`{field, code}`, never a value), `retryable`, `retryAfterSeconds?`, `nextActions` (tokens RELOAD, COMPARE_VERSIONS,
REAUTHENTICATE, STEP_UP, RETRY_LATER, RETRY_SAME_KEY, REQUEST_NEW_REVIEW, CONTACT_SUPPORT, CHOOSE_ANOTHER_MODE),
`current?` (`{version, state, successorId?, mismatch?}` on STALE_VERSION). No stack, SQL, bucket, session URI, raw value or
foreign-resource existence.

| code | status | retryable | code | status | retryable |
|---|---|---|---|---|---|
| INVALID_REQUEST | 400 | no | CAPABILITY_UNAVAILABLE | 422 | no |
| AUTHENTICATION_REQUIRED | 401 | no | SOURCE_EXPIRED | 422 | no |
| ASSURANCE_REQUIRED | 403 | no | TARGET_STALE | 422 | no |
| NOT_AUTHORIZED | 403 | no | PLAN_NOT_VALIDATED | 422 | no |
| NOT_FOUND | 404 | no | INTEGRITY_FAILURE | 422 | no |
| STALE_VERSION | 409 | no | BUDGET_EXHAUSTED | 429 | no |
| IDEMPOTENCY_CONFLICT | 409 | no | ADMISSION_LIMITED | 429 | no |
| PRECONDITION_FAILED | 409 | no | CAPACITY_UNAVAILABLE | 503 | yes |
| PAYMENT_PENDING | 409 | yes | INTERNAL_ERROR | 500 | yes (same key) |
| PAYMENT_UNCERTAIN | 409 | no | OPERATION_CANCELLED | 409 | no |

Request schemas (`REQUEST_SCHEMAS`, ids `urn:kauro:api:v1:request:CMDnnn`): 2020-12, `additionalProperties: false`, no
defaults, properties exactly the catalogue fields (test `command-contracts` proves it against `commands.json`), scalar
shapes: id = lowercase RFC 9562 UUID, label = 1..200 characters without control characters, version = integer ≥ 1, hash =
64 lowercase hex, reasonCode = `^[A-Z][A-Z0-9_]{2,63}$`, mode = CLEAN | HUBSPOT | SALESFORCE. A body member `verified`,
`agencyOwner`, `state`, `agencyId` or `version` is unknown and rejected before any state change (R2-059); a string `"false"`
where a boolean is expected fails type validation with no coercion (R2-058; the seven bodies carry no boolean, the rule is
global Ajv configuration).

DTO views (`api/views.ts`): AgencyView (+ permittedActions), MembershipView (no tokens, recovery settings or security
evidence), EndClientView (+ version), ProjectView (+ currentRevision, readinessBlockers computed at read time from durable
facts: AGENCY_NOT_ACTIVE, NO_SEALED_REVISION, TARGET_CONTRACT_MISSING/UNCONFIRMED, PLAN_MISSING/NOT_VALIDATED/NOT_APPROVED,
CAPABILITY_RESTRICTED), PlanView, ApprovalView.

## 8. The seven commands

Common to all: role check per §6; journal reserve first; `expectedVersion` compared on the locked row (a miss → STALE_VERSION
with `current`); every new aggregate version publishes its event; the response snapshot is journaled; identical replay returns
the snapshot with `replayed: true`; a different digest under the same key → IDEMPOTENCY_CONFLICT with no effect; a crash before
COMMIT leaves nothing (journal, rows, events and outbox are one transaction); a crash after COMMIT is recovered by the key.

### CMD001 CreateAgency — POST /api/v1/agencies — VERIFIED_USER — scope NONE

Body `{displayName}`. Context IDENTITY. Identity `(env, USER user, agency ∅, CMD001, key)`.

1. reserve journal (identity-owned row, `agency_id NULL`);
2. identity verified (D-ASSUR-2) else NOT_AUTHORIZED / IDENTITY_UNVERIFIED;
3. `AbuseLimiter.admit` else ADMISSION_LIMITED (CREATION_RATE_LIMITED);
4. mint `agencyId`, `membershipId`; `uow.adoptTenant(agencyId)` (D-CTX-2);
5. INSERT agencies (DRAFT, version 1, `created_by_user_id`) — a second DRAFT for the same creator fails
   `agencies_one_draft_per_creator` → ADMISSION_LIMITED / DRAFT_AGENCY_EXISTS;
6. INSERT memberships (OWNER, ACTIVE, version 1, `assurance_policy` from the launch policy, `accepted_at = now`);
7. events `agency.created.v1` (agency v1), `membership.created.v1` (membership v1); outbox NOTIFICATIONS for agency.created;
8. journal commit (201, `{agency: AgencyView, membership: MembershipView}`, resource agency).

No contract, billing or capability is activated (state stays DRAFT; `agencies_activation_requires_agreements` makes ACTIVE
impossible without terms, privacy agreement and legal profile).

OK: one agency + one owner membership, both at version 1, two events, one outbox row, journal COMMITTED.
DENY: unverified identity (no MFA) → NOT_AUTHORIZED, zero rows; unauthenticated → 401; a second creation while a DRAFT
exists → ADMISSION_LIMITED, still one agency. "No unauthorized committed state or external effect": the oracle counts rows
across tenants before and after.
RACE: identical retry → same agency (replayed); same key + different displayName → 409 IDEMPOTENCY_CONFLICT, one agency;
crash before commit → nothing; response lost after commit → retry returns the journaled 201.

### CMD009 CreateClient — POST /api/v1/agencies/{agencyId}/clients — AGENCY_OPERATOR — scope AGENCY_PATH

Body `{displayName, processingAuthorityRef}`.

1. reserve; 2. authorize (ACTIVE membership, role ∈ {OWNER, ADMIN, OPERATOR}); 3. lock agency; state ∈ {DRAFT, ACTIVE}
   (D-CMD-2) else PRECONDITION_FAILED / AGENCY_NOT_OPEN; 4. `processingAuthorities.get(ref)` under RLS — absent (foreign or
   nonexistent) → INVALID_REQUEST with `errors: [{field: processingAuthorityRef, code: UNKNOWN_REFERENCE}]` (the composite FK is
   the second line of defence); 5. INSERT end_clients (ACTIVE, version 1); 6. `end_client.created.v1`; 7. journal commit (201,
   EndClientView).

Labels are not merged: two clients with the same label are two rows with distinct ids (test `tenant-isolation`).
DENY: member of another agency addressing this path → NOT_FOUND; VIEWER → NOT_AUTHORIZED / ROLE_INSUFFICIENT; authority of
another agency → INVALID_REQUEST / UNKNOWN_REFERENCE; no row in any case.
RACE: identical retry → same client; conflicting same key → 409; crash → atomic.

### CMD010 ArchiveClient — POST /api/v1/clients/{clientId}/archive — AGENCY_ADMIN — scope AGENCY_HEADER

Body `{expectedVersion}`.

1. reserve; 2. authorize (role ∈ {OWNER, ADMIN}); 3. `endClients.lock(clientId)` — not visible → NOT_FOUND; 4. version
   check → STALE_VERSION `{current}`; 5. state ACTIVE (listed edge ACTIVE→ARCHIVED) else PRECONDITION_FAILED / CLIENT_ARCHIVED;
6. `ActiveWorkInspector.inspectClient` → retained work summary (D-CMD-3); 7. UPDATE state ARCHIVED, `archived_at`,
   version + 1; 8. `end_client.archived.v1` (payload openProjects count); 9. journal commit (200, `{client, retainedActiveWork}`).

Nothing else changes: projects, revisions, approvals, receipts remain (test `discipline`: counts unchanged after archiving);
no deletion request and no refund exists (those are commands of their own, never side effects).
DENY: OPERATOR → NOT_AUTHORIZED; foreign client → NOT_FOUND; stale version → 409 STALE_VERSION with current version/state.
RACE: two archive calls with the same expected version → one ARCHIVED, one STALE_VERSION; identical retry → replay.

### CMD011 CreateProject — POST /api/v1/clients/{clientId}/projects — AGENCY_OPERATOR — scope AGENCY_HEADER

Body `{mode, purpose, targetInstanceRef?}`.

1. reserve; 2. authorize; 3. lock client → NOT_FOUND / state ACTIVE else PRECONDITION_FAILED / CLIENT_ARCHIVED; 4. agency
   state ∈ {DRAFT, ACTIVE}; 5. `capabilities.findMode(mode)` and `isOffered` (AVAILABLE_LIMITED or AVAILABLE) else
   CAPABILITY_UNAVAILABLE / MODE_NOT_OFFERED — before any quote or charge exists; 6. mode ≠ CLEAN ⇒ `targetInstanceRef`
   required else INVALID_REQUEST (TARGET_INSTANCE_REQUIRED) — the declaration claims no qualification; 7. INSERT projects
   (OPEN, v1, capability id + version snapshot, `current_revision_id` = minted) and dataset_revisions (DRAFT, v1) — the
   deferred FK guarantees the pair; 8. `project.created.v1`, `dataset_revision.created.v1`; 9. journal commit (201, ProjectView
   with readinessBlockers, e.g. `[AGENCY_NOT_ACTIVE, NO_SEALED_REVISION, TARGET_CONTRACT_MISSING]`).

DENY: wrong role/foreign → as above; mode with no offered capability → 422 CAPABILITY_UNAVAILABLE and zero rows; body with
`verified: true`/`agencyOwner: true` → 400 before the transaction opens (R2-059).
RACE: identical retry → same project; conflicting → 409; crash → no project without its draft revision.

### CMD023 RevisePlan — POST /api/v1/plans/{planId}/revisions — AGENCY_OPERATOR — scope AGENCY_HEADER

Body `{expectedVersion, decisionPatchArtifactRef}`.

1. reserve; 2. authorize; 3. `plans.lock(planId)` → NOT_FOUND; 4. version check → STALE_VERSION `{current, successorId}`
   (a stale UI holding a SUPERSEDED plan sees where the current content lives); 5. listed edge `new_plan_revision` from
   DRAFT / VALIDATION_REQUIRED / VALIDATED / APPROVED else PRECONDITION_FAILED (PLAN_SUPERSEDED / PLAN_WITHDRAWN);
6. `ArtifactResolver.resolveDecisionPatch(agency, ref)` → absent → INVALID_REQUEST UNKNOWN_REFERENCE;
   `PlanPatchCompiler.apply(body, patch)` → REJECTED → INVALID_REQUEST with the compiler reason (unknown candidate/field,
   effect not permitted); same body hash → PRECONDITION_FAILED / NO_SEMANTIC_CHANGE; 7. UPDATE predecessor: SUPERSEDED,
   `superseded_by_plan_id`, version + 1 (the serialization point; `plans_supersedes_once` closes the race); 8. INSERT successor
   (DRAFT v1, `supersedes_plan_id`, new body + hash, same revision/target/policy hashes) then UPDATE to VALIDATION_REQUIRED v2
   (`compiled_or_edited`: "Freeze this version's body hash; do not inherit old validation" — the successor has no receipt and no
   approval); 9. events `plan.superseded.v1` (predecessor, with `invalidatedApprovalId` / `invalidatedReceiptHash` when the
   predecessor was APPROVED/VALIDATED), `plan.created.v1`, `plan.validation_required.v1` (successor); outbox EXECUTION_CONTROL
   for plan.superseded; 10. journal commit (201, `{plan, supersededPlan, invalidated}`).

History is kept: the predecessor row, its receipt and its approval remain; they cannot attach to the successor (FK bindings).
DENY: APPROVER → NOT_AUTHORIZED; foreign plan → NOT_FOUND; stale version → STALE_VERSION; patch naming an unknown candidate →
INVALID_REQUEST; no row changes.
RACE (S051): two revisions with the same expected version → one successor, the other STALE_VERSION carrying `successorId`.

### CMD025 ApprovePlan — POST /api/v1/plans/{planId}/approve — AGENCY_APPROVER — scope AGENCY_HEADER

Body `{expectedVersion, planHash, validationReceiptHash, disclosuresHash, assuranceProofRef}`.

1. reserve; 2. authorize incl. step-up (ASSURANCE_REQUIRED); 3. lock plan → NOT_FOUND; 4. version → STALE_VERSION;
5. state VALIDATED (edge `agency_approval`) else PLAN_NOT_VALIDATED (or PRECONDITION_FAILED for SUPERSEDED/WITHDRAWN);
6. `planHash = plan.bodyHash` else STALE_VERSION `mismatch: [planHash]`; 7. receipt: `plan.validationReceiptHash =
   body.validationReceiptHash`, `receipts.findByHash` exists, `result = VALID`, no blocking codes, receipt hashes equal the
   plan's body/revision/target — else PLAN_NOT_VALIDATED / RECEIPT_NOT_CURRENT or RECEIPT_BLOCKING; 8. source:
   `revisions.findSealedByHash(plan.revisionHash)` SEALED (not EXPIRED/DELETED/SUPERSEDED) else SOURCE_EXPIRED; 9. target:
   `targetContracts.findCurrentByHash(plan.targetContractHash)` confirmed and unsuperseded else TARGET_STALE;
10. `DisclosureComposer.compose(plan, body, receipt)` → `disclosuresHash` must equal the body value else STALE_VERSION
    `mismatch: [disclosuresHash]` (an approval displayed without the CLEAR set cannot authorize it, D-PLAN-3);
11. INSERT approvals (v1: actor, membership id + version, proof, the five hashes, `approval_hash` = KAURO_PLAN_APPROVAL_V1
    digest of {approvalId, actorId, agencyId, planHash, revisionHash, targetContractHash, validationReceiptHash, disclosuresHash,
    createdAt}); UPDATE plan APPROVED, `approval_id`, version + 1; 12. events `approval.created.v1`, `plan.approved.v1`; outbox
    NOTIFICATIONS; 13. journal commit (201, `{approval, plan}`).

The database enforces 6–7 again as foreign keys and refuses a second live approval (test `discipline`).
DENY: OPERATOR → NOT_AUTHORIZED; foreign → NOT_FOUND; missing/stale step-up → ASSURANCE_REQUIRED; stale receipt →
PLAN_NOT_VALIDATED; disclosures without CLEAR → STALE_VERSION; expired source → SOURCE_EXPIRED; nothing committed.
RACE: two approvers, same expected version → one APPROVED, one STALE_VERSION; identical retry → replay; conflicting → 409.

### CMD026 WithdrawApproval — POST /api/v1/plans/{planId}/withdraw — AGENCY_APPROVER — scope AGENCY_HEADER

Body `{expectedVersion, reasonCode}`.

1. reserve; 2. authorize; 3. lock plan → NOT_FOUND; 4. version → STALE_VERSION; 5. state APPROVED (edge
   `withdraw_approval`) else PRECONDITION_FAILED / PLAN_NOT_APPROVED (WITHDRAWN, SUPERSEDED, VALIDATED ...);
6. `approvals.findLiveByPlan`; controller = approval actor or OWNER (D-AUTHZ-3) else NOT_AUTHORIZED /
   NOT_APPROVAL_CONTROLLER; 7. `ExternalActionInspector.completedForPlan` → identified separately in the response;
8. UPDATE approvals `withdrawn_at`, `withdrawn_by_membership_id`, `withdraw_reason_code`, version 2 (the only mutation the
   immutability triggers allow, once); UPDATE plan WITHDRAWN, version + 1; 9. events `approval.withdrawn.v1`,
   `plan.withdrawn.v1`; outbox NOTIFICATIONS + EXECUTION_CONTROL (route active work through cancellation/reconciliation, owned
   by the job package); 10. journal commit (200, `{approval, plan, completedExternalActions}`).

The approval row and its receipts stay (history); no rollback of an agency-performed import is promised (the response names
completed external actions; the platform has no authority to reverse them).
DENY: VIEWER → NOT_AUTHORIZED; other APPROVER → NOT_APPROVAL_CONTROLLER; foreign → NOT_FOUND; not APPROVED →
PRECONDITION_FAILED; stale version → STALE_VERSION.
RACE: two withdrawals → one WITHDRAWN, one STALE_VERSION; identical retry → replay; conflicting → 409.

## 9. Event vocabulary

Registered (`EVENT_TYPES` = `kauro.event_types`): agency.{created, activated, restricted, restriction_remedied, closing,
closed, ownership_transferred}.v1; membership.{created, invited, accepted, expired, suspended, reactivated, revoked,
role_changed}.v1; end_client.{created, archived}.v1; project.created.v1; dataset_revision.created.v1; plan.{created,
validation_required, validating, validated, superseded, approved, withdrawn}.v1; approval.{created, withdrawn}.v1. The Agency
and Membership lifecycle events are registered now because the machines are; their commands (CMD002–CMD007, CMD043) arrive
with B10/B16. Every payload key is allowlisted (`EVENT_PAYLOAD_ALLOWLIST`), schema version `1`.

## 10. S089, S090, S093 in B06 terms

- **S089** "A prompt has short SHA, failed upstream or spending without ceiling → reject runnable materialization until
  actual dependencies and grants are resolved." Manual 22 states it for mandates; in the product the runnable materialization
  is a dispatch intent (`request_journal`). B06 makes the structural half impossible to violate: `request_hash` must be a full
  SHA-256 (a short SHA is a CHECK violation), `reserved_cents > 0` (no spend without a ceiling), `cost_grant_id NOT NULL`
  (grants resolved), one attempt per `(task_id, fence)`, response stored before consumption, terminal states final,
  reservation immutable. The behavioural half (upstream task failure blocks dispatch) is the intelligence orchestrator (B08),
  which consumes the `RequestJournal` port.
- **S090** "RESUME lacks a checkpoint or resets an absolute deadline → reject restart; preserve original subject, clock, cost
  and checkpoint identity." Rendered on `leases`: `claim_lease` refuses a takeover that omits the stored checkpoint
  (RESUME_WITHOUT_CHECKPOINT) or names another one (CHECKPOINT_MISMATCH), refuses a changed `deadline_at` or `subject_hash`
  (IMMUTABLE_COLUMN), never extends a lease past the deadline, refuses claims after the deadline, advances the fence by exactly
  one per takeover and fences out the previous owner's heartbeats and checkpoints. Cost identity lives in `request_journal`
  (immutable reservation). Test `journals-leases` walks the full interleaving.
- **S093** "Customer target metadata is compiled as a trusted JSON Schema → reject the boundary; compile only reviewed
  application-owned schemas." The `SchemaValidator` port is closed over `KnownSchemaId` (registry contract names + the request
  schema ids + Problem); there is no compile-from-value entry; `target_contracts.objects` is JSONB *data* validated against the
  application-owned TargetContract schema and stamped with `schema_bundle_digest`. Test `schema-boundary` proves the closed set
  and that TargetContract types metadata as data; the Ajv strict configuration on live HTTP input is the api package's test.

## 11. Open questions for the authority

| # | question | interim decision |
|---|---|---|
| Q1 | Assurance freshness value for step-up (08 says the policy registry owns it; the R2 registry has none). | 900 s (D-ASSUR-1). |
| Q2 | Creation abuse limits for CreateAgency (rate per identity, per address). | one DRAFT per identity structurally; rate values with the AbuseLimiter adapter. |
| Q3 | EndClient has no `version` field in the registry although CMD010 names `expectedVersion`. | column + DTO version (D-AGG-2); propose adding `version` to the contract. |
| Q4 | Project has no registry contract or state machine. | D-AGG-1; propose a Project contract. |
| Q5 | S089/S090 are worded for mandate materialization (manual 22) but routed to B06/G-DOMAIN. | domain/database half demonstrated here; the behavioural half named for B08/B11 (§10). |
| Q6 | Whether an APPROVER other than the approving actor may withdraw an approval. | actor or OWNER (D-AUTHZ-3). |
| Q7 | Whether client/project creation should require an ACTIVE agency. | DRAFT or ACTIVE (D-CMD-2). |

## 12. Handoff to the implementation mandate

Build, in this order, each with its real-database tests: (1) `pg` adapters for `UnitOfWorkFactory` (context binding,
statement timeout, serialization retry), repositories, `EventPublisher`, `CommandJournal`, `LeaseStore`, `RequestJournal`;
(2) `@kauro/authorization` (`Authorizer`, `AssuranceVerifier`, `AbuseLimiter`); (3) the seven handlers against the contracts in
`@kauro/application`; (4) `apps/api` with Fastify + Ajv strict (schemas from `@kauro/contracts/schemas.json` and
`REQUEST_SCHEMAS`, calendar format asserted, problem translation, headers, limits); (5) the 29 cases per
`docs/design/B06-case-map.md`, each recorded with subject, environment, input manifest, presealed expected truth, actual
public result, external effect identity, exit status, artifact digests and independent review (21 "Execution record").
Nothing in this branch is "done" because its tests are green; G-DOMAIN and G-TENANT close only through the construction
service's independent review.

## 12a. Implementation notes (branch `b06/application-api`)

Recorded where the implementation had to decide something this document left open or stated ambiguously:

| id | note | why |
|---|---|---|
| I-DENY-1 | A DENY is recorded as a `security_events` row in its **own** unit of work after the command's transaction rolled back (`runCommand` → `recordDenial`). §6.1 says "DENY appends a security event and rolls back": inside one transaction the rollback would erase the event, and the case map requires the denial fact to survive with no journal row. The `Authorizer` therefore only decides; the runtime persists. Every AUTHENTICATION_REQUIRED / NOT_AUTHORIZED / ASSURANCE_REQUIRED outcome of a consequential command is recorded, including handler-level ones (CMD026 NOT_APPROVAL_CONTROLLER). | 08 "Audit events and retention": denials are durable facts, not logs; 10 "rejections leave no journal row" (D-IDEM-2). |
| I-ENV-1 | `CommandEnvelope` carries the `AuthenticatedSubject` (identity facts, provider label, subject SHA-256) beside `userId`; CMD001 calls `identities.syncOwn` before the owner membership insert so the membership's identity foreign key resolves under the self policy. | 08 "Authentication produces an identity reference and assurance facts"; §4.1 `memberships` FK identities. |
| I-VAL-1 | The schema validator is dependency-free (`api/json-schema`): it compiles exactly the keyword vocabulary the generated bundle and the request schemas use and refuses anything else at start-up, so no keyword is ever ignored and no schema can be compiled from a runtime value. Fastify's Ajv is not on the command path. | 10 "Version and validation" (strict, no coercion/defaults/removal), "Schema format execution" (calendar `date-time`, 2026-02-30 control), S093. |
| I-ERR-1 | New safe reasons for the HTTP boundary (`CONTENT_TYPE_UNSUPPORTED`, `BODY_TOO_LARGE`, `JSON_*`, `SCHEMA_VIOLATION`, `IDEMPOTENCY_KEY_*`, `AGENCY_SELECTOR_INVALID`, `PATH_ID_INVALID`, `CORRELATION_ID_INVALID`, `SUBJECT_UNAUTHENTICATED`) and for the typed patch (`PATCH_*`); a body larger than 1 MiB is `INVALID_REQUEST / BODY_TOO_LARGE` (400) to stay inside the closed status table. | 10 "Request envelope"; §7 status table. |
| I-ADM-1 | The admission limiter is process-local (sliding windows per identity and per client address hash; interim values five creations per identity per hour, twenty per address per hour). A fleet-wide counter is an operations concern behind the same port. | 08 "Abuse controls"; open question Q2. |
| I-AUTH-1 | `apps/api` authenticates through an `Authenticator` port; the shipped implementation binds opaque bearer tokens to subjects for LOCAL and tests. The Identity Platform verifier (issuer, audience, signature, email and MFA claims) is not in this branch. | 08 "Authentication and assurance". |

## 13. Verification performed on this branch

`pnpm run verify` (generate, build, typecheck, test, architecture gate, clean-consume) passes: 57 tests — contracts 12,
domain 11, application 8, persistence 26 (every persistence test starts its own PostgreSQL 17.6 cluster via initdb/pg_ctl on
a free 127.0.0.1 port, applies the seven migrations as `kauro_owner`, and exercises the runtime login roles). The persistence
tests are the review of the SQL: application and idempotent re-application, drift refusal, role/RLS/ownership facts, enum
CHECK lists equal to the registry, listed-transition seed equal to the registry machines, event-type seed equal to the domain,
fail-closed context, cross-tenant invisibility, composite FK refusal, pool reuse after commit/rollback/exception, concurrent
contexts, self policies, duplicate labels, version discipline (KA002), event-per-version at commit (KA003), unlisted edges
(KA008), immutable columns (KA004), archive without deletion, S051 race, approval bindings and uniqueness, withdrawal once,
outbox tenant policy and control delivery, journal digest/replay/conflict/concurrent duplicate, identity-owned CreateAgency
reservations, S089 structural checks, S090 lease guard, R2-043 deterministic last-owner race.
