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
| D-CTX-1 | Four execution contexts: TENANT (agency + user), IDENTITY (user only: CreateAgency, own memberships, identity sync), ANONYMOUS (neither user nor agency: it only records the durable DENY fact of a command that carried no authenticated subject, on the request-handler pool; review R26) and SYSTEM (control plane under `kauro_control`). Context is bound with `set_config(..., true)` (SET LOCAL) and therefore vanishes at COMMIT/ROLLBACK. | 08 "Tenant context is set transaction-locally and cleared on pool return ... A request without valid context fails closed"; 08 "Threat model and assets" (an unauthenticated visitor is a threat actor; every trust boundary has an audit event). |
| D-CTX-2 | CreateAgency adopts the agency id it mints (IDENTITY → TENANT once, inside the same transaction) so the agency and owner rows satisfy WITH CHECK. | 08 "RLS policies apply both visibility and writes through USING and WITH CHECK"; the alternative (a policy allowing inserts without context) would open a hole. |
| D-RLS-1 | Every kauro table has RLS enabled and FORCED; the runtime roles `kauro_app` (request handlers), `kauro_control` (control plane), `kauro_assurance` (the step-up verifier, the only writer of step-up proofs) and `kauro_validator` (the independent Migration validator, the only writer of validation receipts) are NOLOGIN group roles with NOSUPERUSER/NOBYPASSRLS/NOCREATEROLE/NOCREATEDB (the two evidence producers since review R14/R30, D-EVID-1); the migrator `kauro_owner` owns the objects and has no DML policy, so even the owner cannot read or write tenant rows. Login roles are provisioning (`... LOGIN IN ROLE kauro_app`); a login belongs to exactly one group (the verified pool refuses any other arrangement). | 07 "Runtime roles are neither database owners nor superusers and do not have BYPASSRLS"; 08 "FORCE ROW LEVEL SECURITY is used where required by the ownership arrangement, and privileged migration roles are never used by request handlers." |
| D-RLS-2 | Request handlers never hold DELETE on any table. Deletion is a managed lifecycle (B07/B12 packages, control plane). | 07 "Restoration and migration"; 09 (deletion is a lifecycle, never a request side effect). |
| D-VER-1 | Every aggregate row carries `version`; an UPDATE either bumps it by exactly one or changes nothing (trigger `enforce_version_bump`, SQLSTATE KA002). Commands compare-and-swap on the expected version; a miss returns the current safe version and state. | 07 "Aggregate versions and event sequence numbers establish concurrency order"; 10 "A stale edit returns the current safe version and a code directing the UI to reload or compare." |
| D-EVT-1 | A new aggregate version cannot commit without its domain event: deferred constraint trigger `require_event_for_version` (KA003) on agencies, memberships, end_clients, projects, dataset_revisions, plans, approvals. | 07 "A successful command commits state, domain event and outbox record atomically." |
| D-EVT-2 | Event types are registered (`kauro.event_types`, FK from `domain_events`; mirrored by `EVENT_TYPES` in the domain, tested equal). Payloads are allowlisted per type: ids, hashes, uppercase tokens, non-negative integers, booleans, lists of ids/hashes — never a label. Outbox fan-out is code-owned (`EVENT_SUBSCRIPTIONS`). An event's identity is tenant-scoped (`domain_events_one_per_aggregate_version` on agency, kind, id, version) and it names an aggregate of its own agency, visible to its writer, at or below that aggregate's version (`domain_events_bind_aggregate`; an unknown and a foreign aggregate look alike, KA006); the control plane reads events and appends none (review R3). | 07 "DomainEvent ... contains references and safe counts, never CRM rows or secrets"; contract OutboxRecord "consumer: Registered destination"; 08 "Database isolation" (foreign keys bind tenant and parent identity; uniqueness includes scope). |
| D-IDEM-1 | Request digest = SHA-256 of the canonical JSON of `{domain: KAURO_COMMAND_REQUEST_V1, version: 1, payload: {operation, aggregate (path ids), body}}`. The domain string is a platform domain (the authority's digest table has no member for the request digest). | 10 "The stored request digest includes every material command field"; reference/HASHING_AND_ACCOUNTING_RULES "Every structured digest uses a named domain and version." |
| D-IDEM-2 | The journal row (state RESERVED) is the first write of a command and is completed (COMMITTED + stored response + resource link) in the same transaction. A rejected command rolls its reservation back: rejections leave no journal row; only committed outcomes replay. The access decision, which reads and writes nothing tenant-scoped, precedes the reservation, so a replay, a conflict or a pending entry is answered only to a caller who is authorized now (D-PIPE-1). | 10 "The first accepted request records its intent before external dispatch. A concurrent duplicate receives the same durable operation reference or final result." |
| D-IDEM-3 | The R2 `RequestJournal` contract (manual 06: physical dispatch attempts, fences, reserved cents) is a separate table from the command journal (manual 10 idempotency). One committed command may produce several journaled dispatch attempts. | Contract RequestJournal fields (taskId, fence, usageState, reservedCents) describe a provider dispatch, not an HTTP command. |
| D-OWN-1 | The last-owner invariant is a counter on the agency row (`active_owner_count`) maintained by trigger on memberships; the counter UPDATE takes the agency row lock, which serializes concurrent owner removals; a removal that would leave zero active owners outside CLOSING/CLOSED is refused (KA001). The counter has a single writer: an agency is born with 0 and `guard_active_owner_count` admits a change only from the membership trigger's own UPDATE (trigger depth ≥ 2), so no role can raise it by hand (review R10). | 07 "Concurrent owner removals lock or otherwise serialize the ownership invariant"; 07 "Application checks improve messages but cannot be the sole protection"; R2-043. |
| D-AUTHZ-1 | Command role → membership roles: AGENCY_OWNER {OWNER}; AGENCY_OWNER_OR_ADMIN and AGENCY_ADMIN {OWNER, ADMIN}; AGENCY_OPERATOR {OWNER, ADMIN, OPERATOR}; AGENCY_APPROVER {OWNER, APPROVER}; AGENCY_BILLING {OWNER, BILLING}; AGENCY_READER and AGENCY_MEMBER: any live membership. | 08 "Agency Owner can manage its agency, client workspaces, projects, team, billing and branding. It can approve plans ... Agency Member can create and work on projects ... Plan approval, billing execution, team management and deletion require explicit capability grants." |
| D-AUTHZ-2 | ADMIN does not approve plans and does not execute billing; APPROVER, BILLING and VIEWER do not create clients or projects. | 08 least privilege; the registry role vocabulary is the capability grant of this edition. |
| D-AUTHZ-3 | WithdrawApproval (CMD026) may be issued by the approval's own actor or by any OWNER; another APPROVER is refused with NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER, before any version or state answer (review R18). The same controller rule governs every command that ends an approval's future use, RevisePlan of an APPROVED plan included (D-PLAN-4). | CMD026 precondition "The actor controls this approval"; Plan machine guard "Current organization authority withdraws future use." |
| D-AUTHZ-4 | A caller with no live membership in the selected agency gets NOT_FOUND, not NOT_AUTHORIZED — for a foreign and a nonexistent agency alike, byte for byte, because nothing tenant-scoped is written or probed before the membership is proven (review R1/R8); a SUSPENDED member gets NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED; a wrong role gets NOT_AUTHORIZED / ROLE_INSUFFICIENT. Every such denial is a durable fact (D-FACT-1). | 08 "Requests for a foreign resource and nonexistent resource produce equivalent safe visibility where needed ... Error messages do not disclose that a particular agency ... exists"; 07 SUSPENDED "Stop new commands/capabilities; preserve account history." |
| D-ASSUR-1 | Step-up freshness is 900 seconds; a proof is bound to the actor, reusable inside its window. The policy registry carries no value: open question Q1. A proof is recorded only by the step-up verifier's runtime group `kauro_assurance` (D-EVID-1), never by the request handlers whose gate it satisfies. | 08 "High-impact actions require recent step-up ... The policy registry owns assurance freshness values." |
| D-ASSUR-2 | VERIFIED_USER means identity state ACTIVE with `email_verified_at` and `mfa_enrolled_at` present. The state is read from the token's facts and from the stored identity row: a DISABLED row refuses whatever the token says; verification stays the token's, because the platform only copies it from the identity provider (review R16). | 08 "Agency data access requires verified email and enrolled MFA under the launch policy"; 07 "Aggregate ownership" (Identity owns security status). |
| D-CMD-1 | Creation abuse limit, structural half: one DRAFT agency per creating identity (partial unique index `agencies_one_draft_per_creator`). The `AbuseLimiter` port adds rate limits per identity and per client address (open question Q2 for the values); the address reaches it from the transport as a keyed hash of the client's network (E-ADDR-1, review R34). | CMD001 precondition "creation abuse limits must admit the request"; 08 "A user cannot obtain a new free audit by retrying ..."; 08 "Abuse controls"; 07 "Unique constraints close races." |
| D-CMD-2 | Client and project creation are permitted while the agency is DRAFT or ACTIVE (`AGENCY_OPEN_STATES`); RESTRICTED, CLOSING and CLOSED refuse with PRECONDITION_FAILED / AGENCY_NOT_OPEN. Uploads and execution (later packages) require ACTIVE. | 07 "DRAFT permits identity and agreement setup but not customer-data execution"; 02 journey step 3 precedes upload; RESTRICTED "can block new purchases or data operations". |
| D-CMD-3 | ArchiveClient does not require the absence of active work: it stops new projects and *reports* the retained active work (open projects, active jobs, live commercial authorizations) in its response; that report is the "review". | 10 "Archiving a client stops new projects but does not delete active paid work implicitly"; CMD010 failure "Archiving cannot become an implicit deletion or refund." |
| D-CMD-4 | `targetInstanceRef` is optional in the CMD011 schema and required by the handler for HUBSPOT and SALESFORCE (CHECK `projects_crm_mode_declares_target`); CLEAN needs none. | 02 "Service modes": CLEAN "No live CRM contract required"; HUBSPOT/SALESFORCE need a target. |
| D-CMD-5 | `expectedVersion` is required in the body of every command whose catalogue entry lists it (CMD010, CMD023, CMD025, CMD026); `If-Match` is not used in v1. | 10 "Edits require If-Match or expectedVersion"; reference/COMMAND_CATALOGUE lists the field. |
| D-PLAN-1 | A plan revision is its own row (`plans.plan_id`). RevisePlan compare-and-swaps the predecessor to SUPERSEDED (version + 1), inserts the successor (DRAFT, version 1) and applies `compiled_or_edited` to it (VALIDATION_REQUIRED, version 2), all in one transaction. The predecessor names its successor and the successor its predecessor. | Plan machine: `new_plan_revision` moves the predecessor to SUPERSEDED "Keep predecessor history"; 07 "Edits create a new version." |
| D-PLAN-2 | Approval bindings are foreign keys, not application checks: `(plan_id, plan_hash, revision_hash, target_contract_hash)` must equal the plan's own body/source/target, and `validation_receipt_hash` must be a receipt of that same plan with those subjects. One live approval per plan (partial unique index). Since the review: the approval binds its actor, the actor's own membership in the agency and a step-up proof of that same actor (`approvals_actor_membership_fk`, `approvals_actor_proof_fk`; R5/R13), and the approval and its withdrawal are acts of the acting session (insert and withdrawal policies, I-REV-5); the plan names only its own approval (`plans_approval_fk` on agency, approval and plan, deferred; R11) and only a VALID receipt of its own body and subjects (`plans_receipt_fk` on six columns, `plans_bind_valid_receipt`; R30); a live approval exists only on the APPROVED plan that names it (KA020, D-PLAN-4). | CMD025 effect "Create immutable approval for exact plan/source/target/disclosures"; 07 "Audit and plan states" (PlanApproval records actor identity, membership version, assurance evidence); 07 "Application checks improve messages but cannot be the sole protection." |
| D-PLAN-3 | The disclosures hash is computed server-side (`DisclosureComposer`) from the validated plan and receipt and includes every CLEAR operation; the client echoes the hash it displayed; a mismatch is STALE_VERSION with `mismatch: ["disclosuresHash"]`. | CMD025 failure "generic cleanup approval cannot authorize undisclosed CLEAR"; 03 "CLEAR requires ... affected count and approval hash." |
| D-AGG-1 | Project (no registry contract) has states OPEN, CLOSED, DELETION_REQUESTED, DELETED with listed edges OPEN→CLOSED, OPEN→DELETION_REQUESTED, CLOSED→DELETION_REQUESTED, DELETION_REQUESTED→DELETED. B06 creates OPEN projects only. | 07 "Aggregate ownership" names Project; 07 "Package and import states" puts closure distinctions on delivery; 10 deletion-requests route. |
| D-AGG-2 | EndClient carries a `version` (the registry contract has none) because CMD010 names `expectedVersion`; its only listed edge is ACTIVE→ARCHIVED. The `EndClientView` DTO exposes the version. | CMD010 field list; 10 "Resource reads return a version or ETag where edits are supported." |
| D-ERR-1..3 | Three platform failure codes beside the seventeen of manual 10: PRECONDITION_FAILED (409, an aggregate is not in a state the listed transition allows), ADMISSION_LIMITED (429, abuse/capacity admission refused), INTERNAL_ERROR (500, opaque by correlation id). | 10 "Stable codes include ..." (the list is not closed); 07 "Authentication, authorization, stale version, invalid input ... are distinct." |
| D-LEASE-1 | Leases carry the immutable subject (`subject_hash`), the absolute `deadline_at`, the cost identity (`cost_authority_id`: the funding authority the leased operation spends against — the CostGrant of a MODEL_TASK, the CommercialAuthorization of a JOB_ATTEMPT; none for OUTBOX_DISPATCH and SWEEP) and the `checkpoint_hash` of the leased operation. A takeover advances the fence by one; a resume must present the stored checkpoint; deadline, subject and cost identity never change; a renewal never extends past the deadline. | Contract Lease; 07 "A lease renewal cannot change the immutable execution subject"; 07 "CommercialAuthorization" (consumed by one logical processing job, with technical retries under that same entitlement); contract Audit ("retains its original deadlines and grant across retries"); 22 "Preserve original deadlines and cost grants"; S090 "preserve original subject, clock, cost and checkpoint identity". |
| D-S089/S090/S093 | See §10: the registry assigns these three cases to B06/G-DOMAIN although their subjects (mandate materialization, RESUME semantics, schema compilation) are owned by manuals 22 and 10. B06 implements and demonstrates every half its own contracts can carry (S089: full hash, positive ceiling, grant reference and resolved upstreams; S090: subject, clock, cost and checkpoint identity) and names the halves other packages own, with their registry cases (case map: S089 and S093 PARTIAL). | 21 "NOT_APPLICABLE requires a reason; it is not a way to avoid a promised feature"; prompts/B06 "If a case is not applicable, explain the precise contract/environment reason ... do not mark skipped work PASS". |

Decisions added by the independent review of `e435a9a` (§12d; the group records under `docs/design/B06-review/` carry the full
reasoning and the revert proofs):

| id | decision | why (authority) |
|---|---|---|
| D-PIPE-1 | One pipeline order for every command: structure (admission, no unit of work) → authenticated subject → **access** (`Authorizer.authorize`, §6.1 steps 1–7: the unit of work runs for the subject; identity ACTIVE by the token and by the stored row; verified; live membership read `FOR SHARE` and held to COMMIT; ACTIVE; role — nothing tenant-scoped written or probed) → **journal reserve** (a REPLAY, CONFLICT or PENDING entry answered only to the caller just authorized) → **assurance** (`Authorizer.assure`, step 8, a fresh step-up for a new execution only: a replay performs no effect and needs none, so a response lost after commit stays recoverable) → the handler (resource relationship before version and state) → the ALLOW facts of the effect → journal commit. Lock order: membership → the command's aggregates. Review R1/R8, R7/R12, R9, R16, R18. | 10 "Request envelope" (subject, then authorization, then execution); 10 "Idempotency contract"; 08 "Browser, API and cache isolation" (foreign and nonexistent look alike; revocation invalidates server-side access immediately); 07 "Agency and membership states"; 07 "Transaction discipline". |
| D-FACT-1 | Security facts belong to exactly one stream. A DENY is recorded in its own unit of work after the command rolled back: in the selected agency's stream only when that transaction proves and share-locks the caller's live membership there, otherwise in the caller's own identity stream naming the requested agency in `requested_agency_id` (no foreign key: recording a probe is not an existence check); a structurally admitted command without an authenticated subject leaves an anonymous DENY written in the ANONYMOUS context before the 401. Every DENY decision of the authorizer (NOT_FOUND / NOT_A_MEMBER included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED is recorded; a handler's NOT_FOUND for a resource invisible under the caller's proven scope is not. ALLOW facts: CMD001 OWNERSHIP_GRANTED and STEP_UP_FRESH for a step-up-authorized effect (CMD025), in the command's own transaction. The insert policy of `security_events` enforces the stream rule for the runtime role. Review R2, R26; corrects I-DENY-1. | 08 "Audit events and retention"; 08 "Threat model and assets"; 08 "Identity is not permission" (safe reason and policy version); 08 "Database isolation". |
| D-INIT-1 | Every aggregate is born in its machine's initial state: `kauro.state_machines (machine, initial_state)` is the parent of `state_transitions`, seeded from the registry (Agency DRAFT, Membership INVITED, Capability DESIGN, DatasetRevision DRAFT, Plan DRAFT) and the platform machines (EndClient ACTIVE, Project OPEN); `enforce_initial_state` refuses another birth state (KA008). Memberships are born INVITED except the founding owner of CreateAgency (ACTIVE OWNER of the session's own identity, the agency's creator, in a DRAFT agency with no membership yet). The DatasetRevision lifecycle events are registered so a revision reaches SEALED through its edges. Review R20. | registry `state_transitions.json` (`initial`; unlisted transitions rejected); reference/TRANSITIONS_AND_EVENT_EFFECTS; CMD001 effect; D-CAP-2, D-AGG-1, D-AGG-2, D-CTX-2. |
| D-EVID-1 | Evidence is written by its producer's own runtime group, never by the request handlers whose gate it satisfies: step-up proofs by `kauro_assurance` (the verifier, `PgAssuranceProofRecorder`: INSERT for the identity it binds, no read), validation receipts by `kauro_validator` (`PgValidationReceiptRecorder`: INSERT under the plan's tenant, no read); `kauro_app` reads both. A login belongs to exactly one runtime group. Their production callers are the Identity Platform verifier (B15) and CMD024 ValidatePlan with the B08 orchestration; in B06 the test harness is the only caller. Review R14, R30. | 08 "Identity is not permission", "Authentication and assurance", "Role and capability model" (a service account has only its technical role), "Database isolation"; 14 "Identity matrix"; registry contract ValidationReceipt (producer MC validator). |
| D-TX-1 | Preconditions a command relies on but does not change are re-read under a share lock held to COMMIT: CMD025 locks the sealed source revision (`lockSealedByHash`) and the current target contract (`lockCurrentByHash`); CMD011 the agency (`lockShared`) and the offered capability (`lockMode`), all `SELECT ... FOR SHARE`. Lock order: plan → source revision → target contract; agency → client → capability. A concurrent writer either waits for the command or committed first and is read (SOURCE_EXPIRED, TARGET_STALE, CAPABILITY_UNAVAILABLE, AGENCY_NOT_OPEN). The runtime role receives the capability lock and nothing else (`GRANT UPDATE (capability_id)` under an UPDATE policy whose WITH CHECK is false). Review R15/R19/R25. | 07 "Transaction discipline"; 10 "Concurrency and preconditions" (preconditions are rechecked inside the relevant transaction); CMD025 failure; CMD011 precondition. |
| D-PLAN-4 | RevisePlan of an APPROVED plan ends the approval's future use, so it requires the approval's controller (D-AUTHZ-3; in this edition an OWNER, since CMD023 is AGENCY_OPERATOR) before version and state, evaluates the edge guard "Commercial/execution consequences are reconciled" through `CommercialConsequenceInspector` (CONSEQUENCES_UNRECONCILED) and withdraws the approval in the same transaction (reason PLAN_SUPERSEDED, `approval.withdrawn.v1` naming `supersededByPlanId`). The database refuses a live approval on a plan that is not APPROVED under it (deferred constraint triggers, KA020 LIVE_APPROVAL_UNBOUND). In B06 the guard holds vacuously (`noCommercialConsequencesInThisEdition`: no Quote, PaymentOrder, CommercialAuthorization or ProcessingJob exists); B08/B09 bind the real inspector. Review R21. | registry Plan machine (APPROVED -new_plan_revision-> SUPERSEDED guard and effect; withdraw_approval); CMD026 precondition; reference/HASHING_AND_ACCOUNTING_RULES ("Withdrawal is a separately recorded authority event"); 07 "Aggregate ownership"; 07 "Transaction discipline". |
| D-CLIENT-1 | CMD009 records the end-client processing authority in its own unit of work under the evidence reference the agency names: a reference new to the platform is recorded (agency, recording membership, time), one this agency recorded binds again, one another agency recorded rejects (INVALID_REQUEST / UNKNOWN_REFERENCE). The reference's identity is global (primary key, `ON CONFLICT DO NOTHING` then a read under RLS); the design-invented `kind` and `evidence_hash` columns and the v7 check are dropped (open question Q10). Review R22. | COMMAND_CATALOGUE CMD009 ("... records the end-client processing authority"; "a foreign authority reference rejects"); contract EndClient `processingAuthorityRef`; reference/END_TO_END_PLAYBOOKS FLOW01; 07 "Acceptance obligations" (no local guess). |
| D-API-1 | CMD026 `reasonCode` is the registry `label` (1..200 characters, no control characters), checked on the approval row by `kauro.is_label`; being customer text it stays on the row and in the tenant's ApprovalView and never enters an event payload (`approval.withdrawn.v1`, `plan.withdrawn.v1`). A reason the server chooses (PLAN_SUPERSEDED) is a token, which is also a label. Review R17/R27. | registry commands.json CMD026 (`reasonCode: label`); reference/FIELD_CONTRACTS ("Common rules": labels are untrusted and may carry L3/L4 information); 07 "Outbox, inbox and event ordering"; D-EVT-2. |
| D-API-2 | A typed-patch rejection carries the field error `{decisionPatchArtifactRef, <reason>}` whose code is the compiler reason (PATCH_UNKNOWN_CANDIDATE, PATCH_UNKNOWN_FIELD, PATCH_EFFECT_NOT_PERMITTED, PATCH_MALFORMED — in the closed field-code vocabulary); UNKNOWN_REFERENCE only for a reference that does not resolve. Review R31. | 10 "Responses and safe errors" (control flow uses the code and typed fields); CMD023 precondition. |
| D-RESP-1 | The wire contract of replies: closed 2020-12 response schemas per view, derived from the registry contract bundle where a contract exists (every registry member selected or withheld with a reason; required stays required; narrowing only adds keywords), the COMPLETED envelope of each served command, the ACCEPTED envelope and the replies of the operational routes (`OPERATIONAL_ROUTES`: the probes). Every route declares its replies (`config.responses`) or refuses to register; every reply is checked by the same strict validator before it is sent and a refused one is replaced by 422 INTEGRITY_FAILURE / RESPONSE_CONTRACT_VIOLATION (the violation, never a value, to the sink); Fastify's serializer is not given the schemas. OpenAPI 3.1 (`apps/api/openapi.json`) is generated from the registry and those schemas and checked against the registered routes in `verify`. ApprovalView carries `actorId`, so a consumer recomputes `approvalHash` from the DTO. Review R23, R29. | 10 "Version and validation" (closed 2020-12 contracts; compatible serializer semantics; OpenAPI generated and checked against routes; TypeScript types are insufficient runtime validation); 10 "Responses and safe errors"; reference/FIELD_CONTRACTS "Common rules" (sentinel serialization); contract Approval; reference/HASHING_AND_ACCOUNTING_RULES. |
| E-CORR-1 | The correlation id is resolved once per request, as the Fastify request id: the client's `X-Correlation-Id` is adopted when it is an `id`; any other value is ignored — never refused, never echoed — and the server mints a UUIDv7, as when it is absent. The answer header, the problem, the request log (label `correlationId`), the sinks, the journal entry, the events and the security events carry it. Supersedes I-INT-4; CORRELATION_ID_INVALID withdrawn. Review R28, R45. | 10 "Request envelope" ("Every request receives an opaque correlation ID"); 07 "Command outcomes and error taxonomy"; reference/FIELD_CONTRACTS DomainEvent `correlationId: id`. |
| E-ADDR-1 | The client address reaches the admission limiter as HMAC-SHA256 (per-process key; the limiter is process-local, I-ADM-1) of its network — IPv4 as is, IPv6 as its /64 — taken from the socket peer or from exactly `KAURO_HTTP_TRUSTED_PROXY_HOPS` trusted proxy hops (required outside LOCAL, 0..4); the address itself never enters the application layer and is never persisted. Review R34. | 08 "Abuse controls" (rate limiting combines IP, verified identity, agency and operation); 14 "Initial architecture". |
| E-HTTP-1 | Framing at the boundary: a repeated single-valued envelope header is HEADER_REPEATED (the first admission check); an undecodable request target, an HTTP parser error or a body that is not its declared length is REQUEST_MALFORMED; a request not complete within the request timeout is REQUEST_TIMEOUT; an over-long path parameter is PATH_ID_INVALID — all 400 INVALID_REQUEST problems with a correlation id and nothing echoed. Bodies reach admission as bytes and are decoded as strict UTF-8 (an invalid sequence or a byte order mark is JSON_SYNTAX). Review R39, R40, R41. | 10 "Request envelope"; 10 "Responses and safe errors"; RFC 8259 §8.1. |
| E-OPS-1 | Deadlines and budgets from the environment: `KAURO_HTTP_REQUEST_TIMEOUT_MS`, `KAURO_HTTP_CONNECTION_TIMEOUT_MS`, `KAURO_SHUTDOWN_DEADLINE_MS` (≤ 9 000), `KAURO_DB_MIGRATOR_{CONNECT,STATEMENT,LOCK}_TIMEOUT_MS`; `KAURO_DB_POOL_MAX` is 1..4 for the api (`API_POOL_CEILING`), 24 staying the application-wide pool ceiling. Review R36, R37, R43. | 07 "Connection budget and operating limits" (API: at most two instances with four connections each); 07 "Restoration and migration" (explicit lock timeouts); 14 "Deployment and rollback" (explicit environment configuration). |
| E-OPS-2 | Shutdown drains within a deadline below the platform's grace period: from preClose every answer carries `Connection: close`, a request on a still-open connection is 503 CAPACITY_UNAVAILABLE (RETRY_SAME_KEY), readiness reports DRAINING; `bootstrap().shutdown()` gives up at `KAURO_SHUTDOWN_DEADLINE_MS`, closes what remains and reports DEADLINE_EXCEEDED. Review R35. | 14 "Initial architecture", "Monitoring and service health", "Deployment and rollback"; 10 "Idempotency contract". |
| E-OPS-3 | Diagnostics by safe tokens: every error a pooled connection raises — idle in the pool, or held by a unit of work, a recorder or a readiness read (I-REV-4) — reaches `PoolConfig.onError` as {pool, IDLE or IN_USE, error class, SQLSTATE or errno}; an error of a held connection never ends the process, the holder's next statement fails and the connection is destroyed. The composition root reports the cause of every CAPACITY_UNAVAILABLE outcome and of every NOT_READY probe by correlation id; the defaults are one stderr line (`classifyError`: never a message, host, role or value). Review R38. | 14 "Monitoring and service health" ("A database outage is visible without exposing credentials"); 07 "Command outcomes and error taxonomy". |
| E-OPS-4 | `GET /livez` (the process alone) and `GET /readyz` outside /api/v1, no credential, no customer row. Readiness reads `kauro_meta.schema_migrations` over a verified runtime connection (migration 0001 grants the runtime roles USAGE on `kauro_meta` and SELECT on the ledger, nothing more) and compares it with `listMigrations()` by version and checksum: COMPATIBLE (a newer expand migration is tolerated), DRIFTED or BEHIND (503). The probes are operational routes of the response contract (D-RESP-1, I-REV-2). Review R42. | 14 "Monitoring and service health" (liveness; readiness checks the minimum dependencies and schema compatibility); 14 "Deployment and rollback"; 07 "Restoration and migration". |
| E-MIG-1 | Migration runners serialize on a database-scoped session advisory lock (`MIGRATION_RUNNER_LOCK`) taken before the bootstrap DDL; the ledger is created and read under it; each pending file runs in its own transaction; every runner statement has local lock and statement timeouts; the migrator connection has a connect timeout. Review R33, R37. | 07 "Restoration and migration" (checksums and applied versions; explicit lock timeouts); 07 "Connection budget and operating limits" (two api instances may migrate on start). |
| E-SEC-1 | The migrator password is consumed at start: `bootstrap` removes `KAURO_DB_MIGRATOR_PASSWORD` from the environment before anything runs and hands it to the migration connection only; `ApiConfig` has no password; the variable without `KAURO_DB_MIGRATE_ON_START=true` refuses the start. A one-shot migrate-only entry point (the reviewer's stronger alternative) is not built. Review R44. | 07 "Restoration and migration" (migration roles are separate from runtime); 08 "Database isolation"; 08 "Secrets and supply chain"; 14 "Identity matrix". |
| E-PKG-1 | The test helpers are the test-only export subpath `@kauro/persistence/testing`; the architecture gate refuses importing a `testOnlySubpaths` entry from production source and a declared workspace dependency nothing imports; `@types/pg` is a pinned runtime dependency of persistence (its public declarations name pg's types); clean-consume type-checks every typed public entry point from the tarballs with the workspace's pinned pnpm. Review R46, R47. | 07 "Platform topology"; 08 "Secrets and supply chain" ("Dependencies are pinned"); S045. |

## 2. Topology and packages (07 "Platform topology")

Dependencies flow contracts → domain ports → application → adapters; `architecture.rules.json` and `tools/architecture-gate.mjs`
enforce it (on `b06/integration`: 6 packages, 13 edges, no violation; a test-only subpath is importable from test files only,
E-PKG-1).

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
| `assurance_proofs` | step-up proofs (08) | v7 PK; FK identities; **`(user_id, proof_id)` unique** (binding target of approvals); `kind` STEP_UP; `method` TOTP/WEBAUTHN/IDP_REAUTH; `expires_at > issued_at`; append-only; written by `kauro_assurance` only (D-EVID-1) | `kauro_app` self read; `kauro_assurance` insert for the bound identity, no read |
| `agencies` | Agency | v7 PK; `version`; `state` (registry enum, born DRAFT); `active_owner_count` (born 0, written only by the membership trigger: `guard_active_owner_count`, R10); CHECK activation needs terms + privacy + legal profile; **unique `created_by_user_id` WHERE state = DRAFT** | tenant (`agency_id = current_agency_id()`) + member read |
| `memberships` | Membership | v7 PK; `(agency_id, membership_id)` and **`(agency_id, membership_id, user_id)`** unique; FK identities; `role`, `state` (registry enums); born INVITED except the founding owner of CreateAgency (D-INIT-1); **one live membership per (agency, user)**; ACTIVE/SUSPENDED need `accepted_at`; REVOKED needs `revoked_at` | tenant + self read |
| `membership_invitations` | invitation token (08) | v7 PK; `token_hash` unique sha256; composite FKs to memberships; one open invitation per membership | tenant |
| `capabilities` | Capability | v7 PK; `kind`/`mode`; `state` (registry enum, born DESIGN); offered/qualified states must cite evidence; **one offered capability per mode** | read all; `kauro_app` lock-only (`UPDATE (capability_id)` under a WITH CHECK false policy, for `FOR SHARE`, D-TX-1); `kauro_control` all |
| `processing_authorities` | the end-client processing authority CMD009 records (D-CLIENT-1) | PK the reference the agency names (global identity, no v7 check); `(agency_id, id)` unique; composite FK to the recording membership; `recorded_at`; append-only | tenant |
| `end_clients` | EndClient (+ version, D-AGG-2) | v7 PK; `(agency_id, client_id)` unique; born ACTIVE; **composite FK `(agency_id, processing_authority_ref)`**; ARCHIVED ⇔ `archived_at`; no uniqueness on `display_name` | tenant |
| `projects` | Project (D-AGG-1) | v7 PK; `(agency_id, project_id)` unique; born OPEN; **composite FKs to end_clients, memberships, dataset_revisions (deferred)**; FK capabilities; CRM mode ⇒ `target_instance_ref` | tenant |
| `dataset_revisions` | DatasetRevision identity | v7 PK; `(agency_id, revision_id)` unique; born DRAFT, SEALED only along its edges (lifecycle events registered, D-INIT-1); composite FKs to projects and to the superseded revision; sealed states need manifest/projection/sealed_at; **`(agency_id, manifest_hash)` unique** | tenant |
| `target_contracts` | TargetContract identity | v7 PK; composite FK to projects; `objects` JSONB array (data, S093) + `schema_bundle_digest`; immutable except confirmation/supersession | tenant |
| `plans` | Plan (revision row, D-PLAN-1) | v7 PK; `(agency_id, plan_id)` unique; born DRAFT; **`(agency_id, plan_id, body_hash, revision_hash, target_contract_hash)` unique** (binding target); composite FKs to projects, predecessor, successor (deferred), membership; **receipt FK on six columns** (a receipt of this plan's body and subjects) and `plans_bind_valid_receipt` (only a VALID one, KA008); **approval FK `(agency_id, approval_id, plan_id)`** (its own approval, deferred); **a live approval only on the APPROVED plan naming it** (deferred constraint triggers, KA020); **a predecessor is superseded once** (partial unique on `supersedes_plan_id`); semantic columns immutable | tenant |
| `validation_receipts` | ValidationReceipt | v7 PK; `(agency_id, receipt_hash)` unique; **six-column FK to plans** (a receipt is for an existing plan body with those subjects); VALID ⇒ no blocking codes; append-only; written by `kauro_validator` only (D-EVID-1) | `kauro_app` tenant read; `kauro_validator` insert under the plan's tenant, no read |
| `approvals` | Approval (+ version, actor membership version, proof) | v7 PK; `(agency_id, approval_id, plan_id)` unique (binding target of plans); **FK to plans over (plan_id, plan_hash, revision_hash, target_contract_hash)** and **FK to validation_receipts over six columns**; **actor bound to its own membership `(agency_id, actor_membership_id, actor_id)` and to a proof of that actor `(actor_id, assurance_proof_ref)`**; **one live approval per plan**; withdrawal columns all-or-nothing, set once; `withdraw_reason_code` a label (D-API-1) | tenant read; insert only with `actor_id = current_user_id()`; withdrawal only by a membership of the session's user (I-REV-5) |
| `event_types` | registered event types | text PK; seeded (= `EVENT_TYPES`) | read |
| `domain_events` | DomainEvent | v7 PK; identity `sequence`; **`(agency_id, aggregate_kind, aggregate_id, aggregate_version)` unique (nulls not distinct)**; `domain_events_bind_aggregate`: the aggregate exists in the event's agency, visible to the writer, at or above the event's version (KA006 / KA002); FK event_types; payload object ≤ 16 KiB + `payload_hash`; actor shape; append-only | tenant (agency_id); `kauro_control` read only |
| `outbox_records` | OutboxRecord | v7 PK; FK domain_events; `(event_id, consumer)` unique; state enum; attempts never decrease; DELIVERED is final | tenant through the event; `kauro_control` all |
| `inbox_records` | InboxRecord | v7 PK; **`(provider, environment, external_event_id)` unique**; `body_hash`; APPLIED ⇔ `applied_at` | `kauro_app` insert only (RECEIVED, no outcome; target-less `ON CONFLICT DO NOTHING`); `kauro_control` read, insert, update |
| `command_journal` | idempotency record (10) | v7 PK; **identity unique index `(environment, actor_kind, actor_id, coalesce(agency_id, nil), operation, idempotency_key)`**; digest; COMMITTED needs status+body+resource+time; final entries never change | tenant, or identity-owned when `agency_id IS NULL`; `kauro_control` reads the safe technical columns only (no `response_body`, key, digest or actor: R4) |
| `request_journal` | RequestJournal (+ upstreams) | v7 PK; full `request_hash`; `fence ≥ 1`; `reserved_cents > 0`; `cost_grant_id NOT NULL`; `upstream_request_ids` declared (≤ 64), every one a CONSUMED attempt of the same scope at reservation (guard `request_journal_upstream_resolved`, KA009); `(task_id, fence)` unique; response before consume; terminal states final; reservation immutable | `kauro_control` all; tenant read |
| `leases` | Lease (+ subject, deadline, cost identity, checkpoint) | PK `(resource_kind, resource_id)`; `fence ≥ 1`; `expires_at ≤ deadline_at`; `cost_authority_id` present exactly for MODEL_TASK and JOB_ATTEMPT; deadline/subject/cost identity immutable; fence/checkpoint guard | `kauro_control` all |
| `security_events` | security facts (08, D-FACT-1) | v7 PK; actor (USER, SERVICE, SYSTEM, ANONYMOUS)/action/outcome/reason/policy/assurance/correlation/time; `requested_agency_id` (no FK); `security_events_one_scope` (a stream or a requested agency, never both), `security_events_anonymous_denial`; append-only | insert: an agency stream only by a writer with a live membership there, as itself; an identity fact by its writer; an anonymous DENY with no context bound; tenant reads its own stream only; control all |
| `state_machines` | machines and their initial states (D-INIT-1) | PK `machine`; `initial_state`; seeded from the registry and the platform machines; trigger `enforce_initial_state` on every aggregate with a machine | read |
| `state_transitions` | listed edges (reference/TRANSITIONS) | PK `(machine, from, to)`, FK `machine` → `state_machines`; seeded per machine; trigger `enforce_listed_transition` on every aggregate with a machine | read |

Shared triggers: `touch_updated_at`; `enforce_version_bump` (KA002, exempt list per table: `active_owner_count` on agencies);
`require_event_for_version` (KA003, deferred constraint trigger, matching the event on the aggregate's own agency);
`forbid_change` (append-only tables, KA004); `forbid_column_change` (immutable columns, KA004); `enforce_listed_transition`
(KA008); `enforce_initial_state` and `enforce_membership_initial_state` (birth state, KA008; D-INIT-1);
`maintain_active_owner_count` (KA001) and `guard_active_owner_count` (its single writer, KA004; R10); `domain_events_bind_aggregate`
(KA006 / KA002; R3); `plans_bind_valid_receipt` (KA008; R30); `plans_live_approval_binding` / `approvals_live_approval_binding`
(deferred, KA020; D-PLAN-4); `approvals_withdraw_once` (KA004); `outbox_records_guard`, `command_journal_guard`,
`request_journal_guard` (KA007); `request_journal_upstream_resolved` (KA009, S089); `leases_guard` (KA005). Functions
`claim_lease`, `heartbeat_lease`, `checkpoint_lease`, `cancel_lease` are the atomic lease operations (SECURITY INVOKER, run by
`kauro_control`).

### 4.2 Roles, grants, context

| role | kind | what it may do |
|---|---|---|
| `kauro_owner` | migrator, object owner, LOGIN CREATEROLE | DDL through the runner; no DML policy anywhere (FORCE RLS); never in a request path |
| `kauro_app` | NOLOGIN group, request handlers | SELECT/INSERT/UPDATE on tenant tables under the tenant/self policies; INSERT on events, outbox, journal and security events (the three streams of D-FACT-1); INSERT only on the inbox (ingress, R6); SELECT on its own step-up proofs and its tenant's receipts, never INSERT (D-EVID-1); SELECT on capabilities (plus the lock-only `UPDATE (capability_id)`, D-TX-1), event types, request journal (own tenant) and the migration ledger (readiness, E-OPS-4); approvals only as the acting session (I-REV-5); no DELETE anywhere; no access to leases |
| `kauro_control` | NOLOGIN group, control plane | outbox, leases, request journal, inbox, capabilities, security events (all tenants); events read only (R3); the command journal's safe technical columns only (R4); the migration ledger (read); no access to agencies, memberships, clients, projects, plans in this edition |
| `kauro_assurance` | NOLOGIN group, the step-up verifier (D-EVID-1) | INSERT on `assurance_proofs` for the identity it binds; nothing else, no read; runs no unit of work |
| `kauro_validator` | NOLOGIN group, the independent Migration validator (D-EVID-1) | INSERT on `validation_receipts` under the plan's tenant context; nothing else, no read; runs no unit of work |
| `kauro_app_test`, `kauro_control_test`, `kauro_assurance_test`, `kauro_validator_test` | LOGIN members created by the test helper, one per group | what their group allows |

Context binding: `SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)` inside the transaction
(the ANONYMOUS context binds both empty).
`kauro.current_agency_id()` / `kauro.current_user_id()` return NULL for a missing or empty setting and raise for an unparsable
one. Every policy compares against those functions, so no context means no rows and no writes. Verified on the real server:
after COMMIT, ROLLBACK or an exception the same connection has no context (test `tenant-isolation`); two pooled connections in
different contexts interleave without leakage.

## 5. Transaction discipline (07 "Transaction discipline")

Every command runs in exactly one unit of work (`UnitOfWorkFactory.run(context, work)`): READ COMMITTED, row locks on the
aggregates it edits (`SELECT ... FOR UPDATE` through `lock(...)`), share locks on the rows its preconditions rely on
(`FOR SHARE`, D-TX-1), compare-and-swap on `version`, and the following order (D-PIPE-1; before the review the journal was
reserved first, which let a nonexistent agency be told apart from a foreign one and served a replay to an ex-member, R1/R7):

1. access authorization (§6.1 steps 1–7) inside the transaction: the caller's identity row, then the live membership in the
   selected agency read `FOR SHARE` and held to COMMIT — nothing tenant-scoped is written or probed; a DENY rolls back and is
   recorded as a durable fact in its own transaction (D-FACT-1).
2. `journal.reserve(identity, digest)` — the intent row (RESERVED), the first write. A concurrent duplicate blocks on the
   identity index here; a REPLAY, CONFLICT or PENDING entry is answered to the caller just authorized.
3. assurance (§6.1 step 8, `Authorizer.assure`): the fresh step-up of a new execution (CMD025); never applied to a replay.
4. `lock()` the edited aggregate(s); the resource relationship (CMD026 and an APPROVED predecessor of CMD023: the approval's
   controller); check `expectedVersion`; check the listed transition and every precondition of §8 in order, re-reading the
   rows the command relies on under share locks.
5. writes: aggregate rows, then `events.publish(...)` for each new aggregate version (domain_events + outbox records for the
   registered consumers), then the ALLOW facts of a step-up-authorized effect (D-FACT-1).
6. `journal.commit(entryId, {status, body, resourceKind, resourceId})`.
7. COMMIT. The deferred constraints (event-per-version, deferred FKs, the live-approval binding) are checked here.

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
| the actor's authority for the whole command (a suspension, revocation or role change is ordered before or after it) | share lock on the actor's membership row (`memberships.findLive` FOR SHARE, D-PIPE-1; R9 RACE test: a change issued meanwhile waits for the command, one committed first makes the command wait and then refuses it) |
| an approval never commits over a source that stopped being SEALED, or a target contract superseded, while it was in flight | `lockSealedByHash` / `lockCurrentByHash` FOR SHARE held to COMMIT (D-TX-1; RACE tests of both interleavings: SOURCE_EXPIRED, TARGET_STALE) |
| a project is never admitted on a capability suspended, or in an agency that left DRAFT/ACTIVE, while the command was in flight | `lockMode` on the capability (lock-only grant) and `agencies.lockShared`, FOR SHARE (D-TX-1: CAPABILITY_UNAVAILABLE, AGENCY_NOT_OPEN); concurrent project creations do not serialize on each other |
| no live approval on a SUPERSEDED or WITHDRAWN plan | RevisePlan and WithdrawApproval both lock the plan FOR UPDATE and withdraw the approval in the same transaction; deferred constraint triggers `plans_live_approval_binding` / `approvals_live_approval_binding` (KA020, D-PLAN-4) |
| one processing-authority record per evidence reference, never shared across agencies | primary key on `processing_authorities.processing_authority_id` (`ON CONFLICT DO NOTHING` waits for a concurrent recording, then reads under RLS; D-CLIENT-1) |
| a dispatch intent never materializes on an upstream that is not resolved | `request_journal_upstream_resolved` reads each upstream FOR SHARE (an upstream transition is ordered entirely before or after the reservation; CONSUMED is terminal; S089) |
| one event per aggregate version, in the aggregate's own agency | `domain_events_one_per_aggregate_version` (tenant-scoped) + `domain_events_bind_aggregate` (R3) |

Lock order, which the later writers of these rows must follow (B07 revision expiry and supersession, B08 target supersession,
CMD043 agency closure, the control plane's CMD058/CMD059): membership → plan → source revision → target contract;
membership → agency → client → capability. A writer taking the opposite order is detected by PostgreSQL (40P01, mapped to
CAPACITY_UNAVAILABLE, retryable); whether it locks the plans first or retries is that package's decision.

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
`Authorizer` decides per consequential operation, inside the unit of work, in this order; the first failure is the answer.
Steps 1–7 are `Authorizer.authorize` (access, before the journal reservation: nothing tenant-scoped has been written or
probed); step 8 is `Authorizer.assure` (a new execution only, after the reservation; a replay is never asked for a step-up);
steps 9–10 are the handler's (D-PIPE-1):

| step | check | failure |
|---|---|---|
| 1 | authenticated subject present, and the unit of work runs for that subject | AUTHENTICATION_REQUIRED (edge: `refuseUnauthenticated` records the anonymous fact first) / SUBJECT_UNAUTHENTICATED |
| 2 | identity ACTIVE — by the token's facts and by the stored identity row (a DISABLED row refuses whatever the token says; a never-synced identity is decided by the token) — and verified (email + MFA, the token's facts) | NOT_AUTHORIZED / IDENTITY_DISABLED or IDENTITY_UNVERIFIED |
| 3 | command role VERIFIED_USER → ALLOW with no membership | — |
| 4 | agency selector present (path or header) | INVALID_REQUEST / TENANT_CONTEXT_MISSING |
| 5 | live membership of the caller in the selected agency (`memberships.findLive`, `FOR SHARE` held to COMMIT) | NOT_FOUND / NOT_A_MEMBER (no INVITED/ACTIVE/SUSPENDED row; foreign and nonexistent agencies answer byte-equal problems) |
| 6 | membership ACTIVE | NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED or MEMBERSHIP_NOT_ACTIVE (INVITED) |
| 7 | `roleSatisfies(commandRole, membership.role)` (D-AUTHZ-1) | NOT_AUTHORIZED / ROLE_INSUFFICIENT |
| 8 | step-up when the command names `assuranceProofRef` (CMD025): proof of this user, kind STEP_UP, issued within 900 s | ASSURANCE_REQUIRED / STEP_UP_MISSING, STEP_UP_NOT_OWNED, STEP_UP_STALE |
| 9 | resource relationship: the resource is visible under the bound context (RLS) and belongs to the scope; for CMD026 (and CMD023 on an APPROVED plan) the caller controls the plan's approval (D-AUTHZ-3) | NOT_FOUND; NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER |
| 10 | state/version preconditions (§8) | per command |

Every DENY of the authorizer (NOT_FOUND / NOT_A_MEMBER included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED of
a consequential command is a durable `security_events` fact (actor, scope, action = command id, outcome DENY, reason, policy
version `B06-1`, assurance class, correlation, time), written in its own transaction after the rollback, in the agency's stream
only when that transaction proves the caller's live membership, otherwise in the caller's identity stream naming the requested
agency; an unauthenticated command leaves an anonymous fact; a step-up-authorized effect and the owner grant of CMD001 leave
ALLOW facts (D-FACT-1). No membership is cached across requests; SUSPENDED → ACTIVE re-checks everything (07 "do not reuse
stale cached grants"), and a membership change during a command is ordered before or after it by the share lock of step 5.

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
records each step-up (method, issued/expires, correlation), written only by the step-up verifier's runtime group
`kauro_assurance` (`PgAssuranceProofRecorder`; D-EVID-1 — the Identity Platform verifier that calls it is B15).
`AssuranceVerifier.verifyStepUp` returns FRESH/STALE/MISSING. Approvals record `assurance_proof_ref` and the actor's
membership version (07 "PlanApproval records actor identity, membership version, assurance evidence"); the database binds the
proof to the actor and the actor to its own membership (D-PLAN-2).

### 6.5 Admission

`AbuseLimiter.admit(operation, {userId, agencyId, clientAddressHash?})` runs before CreateAgency's first write, with the keyed
hash of the client network the transport computed (E-ADDR-1: the per-identity and the per-address windows of I-ADM-1 are both
live); the database independently refuses a second DRAFT agency per identity (`ADMISSION_LIMITED / DRAFT_AGENCY_EXISTS`).

## 7. API envelope, safe errors, request schemas (10)

Envelope: `X-Correlation-Id` (adopted when it is an `id`; any other value, and an absent one, is replaced by a server UUIDv7 —
never refused, never echoed; the request id of the transport and the id of every record of the request, E-CORR-1, superseding
I-INT-4), `Idempotency-Key` (required on every command, `^[A-Za-z0-9_-]{16,128}$`), `X-Kauro-Agency` (D-SCOPE-1),
`Content-Type: application/json`, body ≤ 1 MiB, parser depth ≤ 16, strings ≤ 40 000 characters, pages 25 default / 100
maximum (R2 policy `api`). Validation order: a repeated single-valued envelope header (HEADER_REPEATED, E-HTTP-1), content
type, size, strict UTF-8 and JSON syntax, duplicate keys, closed schema (the strict validator with the behaviour of Ajv's
`coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`, calendar `date-time` asserted; I-VAL-1), idempotency
key, path ids, agency selector, authenticated subject, authorization, then application execution; database queries occur
after structural validation (an unauthenticated refusal writes only its anonymous fact, D-FACT-1). Framework and below-HTTP
errors are problems too (REQUEST_MALFORMED, PATH_ID_INVALID, REQUEST_TIMEOUT, E-HTTP-1); requests and sockets are bounded by
the request and connection timeouts (E-OPS-1).

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
64 lowercase hex, reasonCode = label (the registry type; D-API-1 — until the review it was narrowed to an uppercase token),
mode = CLEAN | HUBSPOT | SALESFORCE. A body member `verified`,
`agencyOwner`, `state`, `agencyId` or `version` is unknown and rejected before any state change (R2-059); a string `"false"`
where a boolean is expected fails type validation with no coercion (R2-058; the seven bodies carry no boolean, the rule is
global Ajv configuration).

DTO views (`api/views.ts`): AgencyView (+ permittedActions), MembershipView (no tokens, recovery settings or security
evidence), EndClientView (+ version), ProjectView (+ currentRevision, readinessBlockers computed at read time from durable
facts: AGENCY_NOT_ACTIVE, NO_SEALED_REVISION, TARGET_CONTRACT_MISSING/UNCONFIRMED, PLAN_MISSING/NOT_VALIDATED/NOT_APPROVED,
CAPABILITY_RESTRICTED), PlanView, ApprovalView (+ `actorId`, so the approval hash is recomputable from the DTO; R29).

Response contract (D-RESP-1): every view, the COMPLETED envelope of each command (`urn:kauro:api:v1:response:CMDnnn`), the
ACCEPTED envelope and the replies of the probes (`urn:kauro:api:v1:response:op:<operationId>:<status>`) are closed 2020-12
schemas the same strict validator compiles; a view that projects a registry contract takes each member from the generated
bundle (selected or withheld with a reason). Every route declares its replies and every reply is checked before it is sent — a
refused one is 422 INTEGRITY_FAILURE / RESPONSE_CONTRACT_VIOLATION, its violation (never a value) handed to the sink under the
correlation id. `apps/api/openapi.json` (OpenAPI 3.1: the seven commands and the two probes) is generated from the registry
and these schemas by `tools/openapi.mjs` and checked against the registered routes in `verify`.

## 8. The seven commands

Common to all (D-PIPE-1): access authorization per §6.1 steps 1–7 first (nothing written), then the journal reservation (the
first write), then — for CMD025 — the step-up; `expectedVersion` compared on the locked row (a miss → STALE_VERSION with
`current`); every new aggregate version publishes its event; the response snapshot is journaled; identical replay returns the
snapshot with `replayed: true` to a caller who is still authorized; a different digest under the same key →
IDEMPOTENCY_CONFLICT with no effect; a crash before COMMIT leaves nothing (journal, rows, events and outbox are one
transaction); a crash after COMMIT is recovered by the key. Every denial of §6.1 is a durable fact (D-FACT-1). The step lists
below number the command's own work after the access decision and the reservation.

### CMD001 CreateAgency — POST /api/v1/agencies — VERIFIED_USER — scope NONE

Body `{displayName}`. Context IDENTITY. Identity `(env, USER user, agency ∅, CMD001, key)`.

1. identity ACTIVE (token and stored row) and verified (D-ASSUR-2) else NOT_AUTHORIZED / IDENTITY_DISABLED or
   IDENTITY_UNVERIFIED (recorded in the caller's identity stream);
2. reserve journal (identity-owned row, `agency_id NULL`);
3. `AbuseLimiter.admit` with the identity and the client address hash (E-ADDR-1) else ADMISSION_LIMITED
   (CREATION_RATE_LIMITED);
4. the caller's identity row synced (self policy); mint `agencyId`, `membershipId`; `uow.adoptTenant(agencyId)` (D-CTX-2);
5. INSERT agencies (DRAFT, version 1, `active_owner_count` 0, `created_by_user_id`) — a second DRAFT for the same creator fails
   `agencies_one_draft_per_creator` → ADMISSION_LIMITED / DRAFT_AGENCY_EXISTS;
6. INSERT memberships (OWNER, ACTIVE, version 1, `assurance_policy` from the launch policy, `accepted_at = now`) — the one
   membership born ACTIVE (D-INIT-1); the trigger counts the owner;
7. the ALLOW fact OWNERSHIP_GRANTED in the new agency's stream (D-FACT-1);
8. events `agency.created.v1` (agency v1), `membership.created.v1` (membership v1); outbox NOTIFICATIONS for agency.created;
9. journal commit (201, `{agency: AgencyView, membership: MembershipView}`, resource agency).

No contract, billing or capability is activated (state stays DRAFT; `agencies_activation_requires_agreements` makes ACTIVE
impossible without terms, privacy agreement and legal profile).

OK: one agency + one owner membership, both at version 1, two events, one outbox row, journal COMMITTED.
DENY: unverified identity (no MFA) → NOT_AUTHORIZED, zero rows but its identity-stream fact; unauthenticated → 401 with its
anonymous fact; a second creation while a DRAFT exists → ADMISSION_LIMITED, still one agency. "No unauthorized committed state
or external effect": the oracle counts rows across tenants before and after.
RACE: identical retry → same agency (replayed); same key + different displayName → 409 IDEMPOTENCY_CONFLICT, one agency;
crash before commit → nothing; response lost after commit → retry returns the journaled 201.

### CMD009 CreateClient — POST /api/v1/agencies/{agencyId}/clients — AGENCY_OPERATOR — scope AGENCY_PATH

Body `{displayName, processingAuthorityRef}`.

1. authorize (ACTIVE membership, role ∈ {OWNER, ADMIN, OPERATOR}); 2. reserve; 3. lock agency; state ∈ {DRAFT, ACTIVE}
   (D-CMD-2) else PRECONDITION_FAILED / AGENCY_NOT_OPEN; 4. record the end-client processing authority (D-CLIENT-1:
   `processingAuthorities.record` — a reference new to the platform is recorded by this membership now, one this agency
   recorded binds again, one another agency recorded → INVALID_REQUEST with `errors: [{field: processingAuthorityRef, code:
   UNKNOWN_REFERENCE}]`; the composite FK is the second line of defence); 5. INSERT end_clients (ACTIVE, version 1);
   6. `end_client.created.v1`; 7. journal commit (201, EndClientView).

Labels are not merged: two clients with the same label are two rows with distinct ids (test `tenant-isolation`).
DENY: member of another agency addressing this path → NOT_FOUND (a fact of the prober's identity stream); VIEWER →
NOT_AUTHORIZED / ROLE_INSUFFICIENT; authority of another agency → INVALID_REQUEST / UNKNOWN_REFERENCE; no row in any case.
RACE: identical retry → same client; conflicting same key → 409; crash → atomic.

### CMD010 ArchiveClient — POST /api/v1/clients/{clientId}/archive — AGENCY_ADMIN — scope AGENCY_HEADER

Body `{expectedVersion}`.

1. authorize (role ∈ {OWNER, ADMIN}); 2. reserve; 3. `endClients.lock(clientId)` — not visible → NOT_FOUND; 4. version
   check → STALE_VERSION `{current}`; 5. state ACTIVE (listed edge ACTIVE→ARCHIVED) else PRECONDITION_FAILED / CLIENT_ARCHIVED;
6. `ActiveWorkInspector.inspectClient` → retained work summary (D-CMD-3); 7. UPDATE state ARCHIVED, `archived_at`,
   version + 1; 8. `end_client.archived.v1` (payload openProjects count); 9. journal commit (200, `{client, retainedActiveWork}`).

Nothing else changes: projects, revisions, approvals, receipts remain (test `discipline`: counts unchanged after archiving);
no deletion request and no refund exists (those are commands of their own, never side effects).
DENY: OPERATOR → NOT_AUTHORIZED; foreign client → NOT_FOUND; stale version → 409 STALE_VERSION with current version/state.
RACE: two archive calls with the same expected version → one ARCHIVED, one STALE_VERSION; identical retry → replay; the same key
with another expected version or another client → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the client ACTIVE and
the same key then archives it; a response lost after COMMIT is recovered by the key.

### CMD011 CreateProject — POST /api/v1/clients/{clientId}/projects — AGENCY_OPERATOR — scope AGENCY_HEADER

Body `{mode, purpose, targetInstanceRef?}`.

1. authorize; 2. reserve; 3. share-lock the agency (`agencies.lockShared`), lock client → NOT_FOUND / state ACTIVE else
   PRECONDITION_FAILED / CLIENT_ARCHIVED; 4. agency state ∈ {DRAFT, ACTIVE} else AGENCY_NOT_OPEN; 5. `capabilities.lockMode(mode)`
   (FOR SHARE, D-TX-1) and `isOffered` (AVAILABLE_LIMITED or AVAILABLE) else CAPABILITY_UNAVAILABLE / MODE_NOT_OFFERED — before
   any quote or charge exists; 6. mode ≠ CLEAN ⇒ `targetInstanceRef`
   required else INVALID_REQUEST (TARGET_INSTANCE_REQUIRED) — the declaration claims no qualification; 7. INSERT projects
   (OPEN, v1, capability id + version snapshot, `current_revision_id` = minted) and dataset_revisions (DRAFT, v1) — the
   deferred FK guarantees the pair; 8. `project.created.v1`, `dataset_revision.created.v1`; 9. journal commit (201, ProjectView
   with readinessBlockers, e.g. `[AGENCY_NOT_ACTIVE, NO_SEALED_REVISION, TARGET_CONTRACT_MISSING]`).

DENY: wrong role/foreign → as above; mode with no offered capability → 422 CAPABILITY_UNAVAILABLE and zero rows; body with
`verified: true`/`agencyOwner: true` → 400 before the transaction opens (R2-059).
RACE: identical retry → same project; conflicting → 409; crash → no project without its draft revision (including a unit of
work interrupted between the two inserts); a capability suspension or an agency transition racing the command waits for it or,
committed first, refuses it (D-TX-1).

### CMD023 RevisePlan — POST /api/v1/plans/{planId}/revisions — AGENCY_OPERATOR — scope AGENCY_HEADER

Body `{expectedVersion, decisionPatchArtifactRef}`.

1. authorize; 2. reserve; 3. `plans.lock(planId)` → NOT_FOUND; an APPROVED predecessor: its live approval must be controlled
   by the caller (D-PLAN-4, D-AUTHZ-3) else NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER; 4. version check → STALE_VERSION
   `{current, successorId}` (a stale UI holding a SUPERSEDED plan sees where the current content lives); 5. listed edge
   `new_plan_revision` from DRAFT / VALIDATION_REQUIRED / VALIDATED / APPROVED else PRECONDITION_FAILED (PLAN_SUPERSEDED /
   PLAN_WITHDRAWN); an APPROVED predecessor: the edge guard through `CommercialConsequenceInspector` else PRECONDITION_FAILED /
   CONSEQUENCES_UNRECONCILED;
6. `ArtifactResolver.resolveDecisionPatch(agency, ref)` → absent → INVALID_REQUEST UNKNOWN_REFERENCE;
   `PlanPatchCompiler.apply(body, patch)` → REJECTED → INVALID_REQUEST with the compiler reason and the same code on the field
   (PATCH_UNKNOWN_CANDIDATE, PATCH_UNKNOWN_FIELD, PATCH_EFFECT_NOT_PERMITTED, PATCH_MALFORMED; D-API-2); same body hash →
   PRECONDITION_FAILED / NO_SEMANTIC_CHANGE; 7. UPDATE predecessor: SUPERSEDED,
   `superseded_by_plan_id`, version + 1 (the serialization point; `plans_supersedes_once` closes the race); 8. INSERT successor
   (DRAFT v1, `supersedes_plan_id`, new body + hash, same revision/target/policy hashes) then UPDATE to VALIDATION_REQUIRED v2
   (`compiled_or_edited`: "Freeze this version's body hash; do not inherit old validation" — the successor has no receipt and no
   approval); an APPROVED predecessor's approval is withdrawn in the same transaction (version 2, reason PLAN_SUPERSEDED, by the
   caller's membership); 9. events `plan.superseded.v1` (predecessor, with `invalidatedApprovalId` / `invalidatedReceiptHash`
   when the predecessor was APPROVED/VALIDATED), `approval.withdrawn.v1` (naming `supersededByPlanId`, when an approval was
   live), `plan.created.v1`, `plan.validation_required.v1` (successor); outbox EXECUTION_CONTROL for plan.superseded (and
   EXECUTION_CONTROL + NOTIFICATIONS for approval.withdrawn); 10. journal commit (201, `{plan, supersededPlan, invalidated}`).

History is kept: the predecessor row, its receipt and its approval remain; they cannot attach to the successor (FK bindings),
and no live approval ever remains on the SUPERSEDED plan (KA020).
DENY: APPROVER → NOT_AUTHORIZED; foreign plan → NOT_FOUND; stale version → STALE_VERSION; patch naming an unknown candidate →
INVALID_REQUEST with PATCH_UNKNOWN_CANDIDATE on the field; an APPROVED plan revised by an OPERATOR or an ADMIN →
NOT_APPROVAL_CONTROLLER; unreconciled consequences → CONSEQUENCES_UNRECONCILED; no row changes.
RACE (S051): two revisions with the same expected version → one successor, the other STALE_VERSION carrying `successorId`;
identical retry → replay; the same key with another patch → 409; a crash leaves the predecessor unsuperseded; RevisePlan of an
APPROVED plan and WithdrawApproval serialize on the plan lock and end the approval once.

### CMD025 ApprovePlan — POST /api/v1/plans/{planId}/approve — AGENCY_APPROVER — scope AGENCY_HEADER

Body `{expectedVersion, planHash, validationReceiptHash, disclosuresHash, assuranceProofRef}`.

1. authorize (role ∈ {OWNER, APPROVER}); 2. reserve, then the step-up of this new execution (`Authorizer.assure`,
   ASSURANCE_REQUIRED; a replay is answered without it, D-PIPE-1); 3. lock plan → NOT_FOUND; 4. version → STALE_VERSION;
5. state VALIDATED (edge `agency_approval`) else PLAN_NOT_VALIDATED (or PRECONDITION_FAILED for SUPERSEDED/WITHDRAWN);
6. `planHash = plan.bodyHash` else STALE_VERSION `mismatch: [planHash]`; 7. receipt: `plan.validationReceiptHash =
   body.validationReceiptHash`, `receipts.findByHash` exists, `result = VALID`, no blocking codes, receipt hashes equal the
   plan's body/revision/target — else PLAN_NOT_VALIDATED / RECEIPT_NOT_CURRENT or RECEIPT_BLOCKING; 8. source:
   `revisions.lockSealedByHash(plan.revisionHash)` SEALED (not EXPIRED/DELETED/SUPERSEDED), read FOR SHARE and held to COMMIT
   (D-TX-1), else SOURCE_EXPIRED; 9. target: `targetContracts.lockCurrentByHash(plan.targetContractHash)` confirmed and
   unsuperseded, FOR SHARE, else TARGET_STALE;
10. `DisclosureComposer.compose(plan, body, receipt)` → `disclosuresHash` must equal the body value else STALE_VERSION
    `mismatch: [disclosuresHash]` (an approval displayed without the CLEAR set cannot authorize it, D-PLAN-3);
11. INSERT approvals (v1: actor, membership id + version, proof, the five hashes, `approval_hash` = KAURO_PLAN_APPROVAL_V1
    digest of {approvalId, actorId, agencyId, planHash, revisionHash, targetContractHash, validationReceiptHash, disclosuresHash,
    createdAt}); UPDATE plan APPROVED, `approval_id`, version + 1; 12. events `approval.created.v1`, `plan.approved.v1`; outbox
    NOTIFICATIONS; the ALLOW fact STEP_UP_FRESH (assurance class STEP_UP) in the agency's stream; 13. journal commit (201,
    `{approval, plan}`, the ApprovalView carrying `actorId`).

The database enforces 6–7 again as foreign keys, binds the actor to its own membership and to a proof of itself, binds the
insert to the acting session, and refuses a second live approval (tests `discipline`, `integrity-guards`). The wire names
`planHash`, not the source and target hashes manual 10 lists for approval commands: open question Q9 and its interim binding.
DENY: OPERATOR → NOT_AUTHORIZED; foreign → NOT_FOUND; missing/stale step-up → ASSURANCE_REQUIRED; stale receipt →
PLAN_NOT_VALIDATED; disclosures without CLEAR → STALE_VERSION; expired source → SOURCE_EXPIRED; superseded target →
TARGET_STALE; nothing committed.
RACE: two approvers, same expected version → one APPROVED, one STALE_VERSION; identical retry → replay; conflicting → 409; a
crash before COMMIT leaves the plan VALIDATED; a source expiry or target supersession racing the approval waits for it or,
committed first, refuses it (D-TX-1).

### CMD026 WithdrawApproval — POST /api/v1/plans/{planId}/withdraw — AGENCY_APPROVER — scope AGENCY_HEADER

Body `{expectedVersion, reasonCode}`.

1. authorize; 2. reserve; 3. lock plan → NOT_FOUND; the approval the plan carries (live, or the one it carried before a
   withdrawal): controller = its approving actor or an OWNER (D-AUTHZ-3) else NOT_AUTHORIZED / NOT_APPROVAL_CONTROLLER, before
   any version or state answer (R18; a plan that never carried an approval answers its version and state); 4. version →
   STALE_VERSION; 5. state APPROVED (edge `withdraw_approval`) else PRECONDITION_FAILED / PLAN_NOT_APPROVED (WITHDRAWN,
   SUPERSEDED, VALIDATED ...); 6. `approvals.findLiveByPlan` (an APPROVED plan without it is an integrity failure);
   7. `ExternalActionInspector.completedForPlan` → identified separately in the response;
8. UPDATE approvals `withdrawn_at`, `withdrawn_by_membership_id` (the caller's own membership, bound by the withdrawal policy),
   `withdraw_reason_code` (a label, D-API-1), version 2 (the only mutation the immutability triggers allow, once); UPDATE plan
   WITHDRAWN, version + 1; 9. events `approval.withdrawn.v1`, `plan.withdrawn.v1` (their payloads never carry the reason);
   outbox NOTIFICATIONS + EXECUTION_CONTROL (route active work through cancellation/reconciliation, owned by the job package);
   10. journal commit (200, `{approval, plan, completedExternalActions}`).

The approval row and its receipts stay (history); no rollback of an agency-performed import is promised (the response names
completed external actions; the platform has no authority to reverse them).
DENY: VIEWER → NOT_AUTHORIZED; other APPROVER → NOT_APPROVAL_CONTROLLER (with a stale version or on a WITHDRAWN plan too);
foreign → NOT_FOUND; not APPROVED → PRECONDITION_FAILED; stale version → STALE_VERSION; a reason that is not a label → 400.
RACE: two withdrawals → one WITHDRAWN, one STALE_VERSION; identical retry → replay; conflicting → 409; a crash before COMMIT
leaves the approval live.

## 9. Event vocabulary

Registered (`EVENT_TYPES` = `kauro.event_types`): agency.{created, activated, restricted, restriction_remedied, closing,
closed, ownership_transferred}.v1; membership.{created, invited, accepted, expired, suspended, reactivated, revoked,
role_changed}.v1; end_client.{created, archived}.v1; project.created.v1; dataset_revision.created.v1; plan.{created,
validation_required, validating, validated, superseded, approved, withdrawn}.v1; approval.{created, withdrawn}.v1;
dataset_revision.{uploading, inspecting, ready_to_seal, sealed, rejected, cancelled, superseded, expired, deleted}.v1 (review
R20, D-INIT-1: a revision reaches SEALED only through its edges, and every version needs its event). The Agency, Membership and
DatasetRevision lifecycle events are registered now because the machines are; their commands (CMD002–CMD007, CMD043; the
revision commands of B07) arrive with B07/B10/B16. Every payload key is allowlisted (`EVENT_PAYLOAD_ALLOWLIST`), schema
version `1`; `approval.withdrawn.v1` carries `supersededByPlanId` when a revision withdrew the approval (D-PLAN-4), and neither
it nor `plan.withdrawn.v1` carries the withdrawal reason, which is a label (D-API-1).

## 10. S089, S090, S093 in B06 terms

- **S089** "A prompt has short SHA, failed upstream or spending without ceiling → reject runnable materialization until
  actual dependencies and grants are resolved." Manual 22 states it for mandates; in the product the runnable materialization
  is a dispatch intent (`request_journal`, state RESERVED). B06 makes it impossible to materialize one with a short SHA
  (`request_hash` must be a full SHA-256, CHECK), without a ceiling (`reserved_cents > 0`), without a grant reference
  (`cost_grant_id NOT NULL`) or on an unresolved upstream: the intent declares `upstream_request_ids`, and the guard
  `request_journal_upstream_resolved` (BEFORE INSERT, reading each upstream FOR SHARE) refuses it with KA009 → PRECONDITION_FAILED
  / UPSTREAM_UNRESOLVED unless every upstream is a CONSUMED attempt of the same tenant scope — CONSUMED is terminal, so a
  resolved dependency can never turn into a failed one, and an upstream failing concurrently is ordered before the reservation.
  One attempt per `(task_id, fence)`, response stored before consumption, terminal states final, reservation and upstream list
  immutable. Not in B06 (case map, PARTIAL): that `cost_grant_id` names an actual funded CostGrant with room under its ceiling —
  CostGrant is not a B06 contract; grant admission is S041 and IC-12 (B03) and R2-044 (B08) — and the public commands that
  materialize provider work, CMD020 StartAudit (B03) and CMD036 ExecuteProject (B08). Tests `journals-leases` (database) and
  `adapters-journals-outbox` (the `RequestJournal` port, with the concurrent interleavings).
- **S090** "RESUME lacks a checkpoint or resets an absolute deadline → reject restart; preserve original subject, clock, cost
  and checkpoint identity." Rendered on `leases`: `claim_lease` refuses a takeover that omits the stored checkpoint
  (RESUME_WITHOUT_CHECKPOINT) or names another one (CHECKPOINT_MISMATCH), refuses a changed `deadline_at` (clock),
  `subject_hash` or `cost_authority_id` (IMMUTABLE_COLUMN; the adapter answers DEADLINE_IMMUTABLE, SUBJECT_IMMUTABLE,
  COST_IMMUTABLE), never extends a lease past the deadline, refuses claims after the deadline, advances the fence by exactly one
  per takeover and fences out the previous owner's heartbeats and checkpoints. The cost identity is the funding authority the
  leased operation spends against (D-LEASE-1), so a takeover continues under the same grant or entitlement and cannot reset what
  the operation already spent. No command of the catalogue performs a resume (a takeover is a worker's claim); the `LeaseStore`
  port is the boundary. Tests `journals-leases` and `adapters-leases` walk the full interleaving.
- **S093** "Customer target metadata is compiled as a trusted JSON Schema → reject the boundary; compile only reviewed
  application-owned schemas." The `SchemaValidator` port is closed over `KnownSchemaId` (registry contract names + the request
  schema ids + the application-owned response schema ids of D-RESP-1 + Problem); there is no compile-from-value entry; `target_contracts.objects` is JSONB *data* validated against the
  application-owned TargetContract schema and stamped with `schema_bundle_digest`. Test `schema-boundary` proves the closed set
  and that TargetContract types metadata as data; the HTTP half is `apps/api/test/schema-boundary.test.ts`, on the routes B06
  serves and the validator instance the api composes. The command that carries customer target metadata into a transaction is
  CMD018 CreateTargetContract, whose cases belong to package B17; B06 serves none of it, so S093 is PARTIAL in the case map.

## 11. Open questions for the authority

| # | question | interim decision |
|---|---|---|
| Q1 | Assurance freshness value for step-up (08 says the policy registry owns it; the R2 registry has none). | 900 s (D-ASSUR-1). |
| Q2 | Creation abuse limits for CreateAgency (rate per identity, per address). | one DRAFT per identity structurally; rate values with the AbuseLimiter adapter. |
| Q3 | EndClient has no `version` field in the registry although CMD010 names `expectedVersion`. | column + DTO version (D-AGG-2); propose adding `version` to the contract. |
| Q4 | Project has no registry contract or state machine. | D-AGG-1; propose a Project contract. |
| Q5 | S089/S090 are worded for mandate materialization (manual 22) but routed to B06/G-DOMAIN, whose contracts (prompts/B06) do not include RequestJournal or CostGrant. | S089 on `request_journal` (full hash, ceiling, grant reference, resolved upstreams) and S090 on `leases` (subject, clock, cost and checkpoint identity) are implemented and demonstrated here; the actual-grant half of S089 is routed to S041/IC-12 (B03) and R2-044 (B08) (§10; case map: S089 PARTIAL). |
| Q6 | Whether an APPROVER other than the approving actor may withdraw an approval. | actor or OWNER (D-AUTHZ-3). |
| Q7 | Whether client/project creation should require an ACTIVE agency. | DRAFT or ACTIVE (D-CMD-2). |
| Q8 | Whether a cancelled logical operation (cancel_version > 0) must refuse new lease claims, or only be observed by the holder. | observed only; the `CANCELLED` claim refusal is not produced (D-LEASE-2). |
| Q9 | Manual 10 "Concurrency and preconditions" says approval commands name sourceRevisionHash, planHash and targetContractHash; the CMD025 catalogue fields are expectedVersion, planHash, validationReceiptHash, disclosuresHash, assuranceProofRef. Which is authoritative for the wire? (review R32) | Follow the catalogue (the request schema is exactly its fields). The approver names planHash, the Plan bodyHash whose preimage contains revisionHash and targetContractHash; the plan's source and target columns are immutable; the approval's composite key binds them to the plan; expectedVersion pins the displayed version; source and target currency are re-read under share locks (D-TX-1). The columns equal the body's members because the plan adapter derives them; no database CHECK ties them (the database cannot recompute the body digest either). If the authority adds the two fields, they become required members compared to the plan's columns (STALE_VERSION mismatch). |
| Q10 | The registry has no ProcessingAuthority contract and no command that admits processing-authority evidence (the role chain of 19 "Data processing agreement", D41). What does `processingAuthorityRef` identify, and who mints it? (review R22) | D-CLIENT-1: CMD009 records the authority under the reference the agency names (agency, recording membership, time); references are global and a foreign one rejects; the evidence itself (document, role chain, digest) is not modelled until the authority defines its contract and admission command. |

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

## 12a. Implementation record — branch `b06/persistence` (step (1) of §12)

The `pg` adapters of every domain port are delivered in `@kauro/persistence` (`src/pool`, `src/unit-of-work`,
`src/repositories/{tenancy,workspace,plans}`, `src/event-publisher`, `src/command-journal`, `src/request-journal`,
`src/lease-store`, `src/sql`) with the harness `test/harness.ts` and four adapter test files (30 tests on real PostgreSQL 17).
Decisions the implementation had to add:

| id | decision | why (authority) |
|---|---|---|
| D-PORT-1 | `UnitOfWork` gains `ids: IdGenerator` and `resolveMembership(membershipId)`. Without them the port's own invariants ("adoptTenant only with an id the server minted in this unit of work"; "resolvedMembershipId once it has been resolved") had no enforcing mechanism. `adoptTenant` accepts only an id minted through `uow.ids`; `resolveMembership` is TENANT-only and once. | 07 "Database representation" (server-generated ids); 08 "Identity is not permission" (the membership the command uses is the one read in this transaction). |
| D-POOL-1 | The pool verifies every physical connection once: not SUPERUSER, not BYPASSRLS, not CREATEROLE/CREATEDB, not the database owner, member of exactly one runtime group; a privileged login is destroyed. The connection ceiling is a mandatory input (1..24). A SYSTEM context is refused on a `kauro_app` pool and TENANT/IDENTITY on a `kauro_control` pool. | 08 "Database isolation" (runtime roles are not owners, superusers or BYPASSRLS; privileged migration roles never serve requests); 07 "Connection budget" (the ceiling is a capacity decision). |
| D-UOW-1 | After `COMMIT` the adapter checks the command tag: PostgreSQL answers `ROLLBACK` (no error) when the transaction block was aborted earlier, which would let a handler that swallowed a refusal "succeed" with nothing persisted. Such a unit of work is `INTEGRITY_FAILURE`. | 07 "Transaction discipline" (a successful command commits state, event and outbox atomically — or nothing); 10 "An unexpected 500 does not automatically mean a command did not commit" (the converse must hold too). |
| D-UOW-2 | Error translation: `DomainFailure` passes through; a database refusal becomes the SQLSTATE-table failure (`57014` query_canceled added as `CAPACITY_UNAVAILABLE`, retryable); an unmapped unique violation is `ConstraintViolation` (INTEGRITY_FAILURE carrying the constraint name for the handler); anything else is `INTERNAL_ERROR` naming only the correlation id, with the original error as server-side `cause`. `40001`/`40P01` re-run the work in a fresh transaction up to `maxRetries` (default 0 at READ COMMITTED, 2 above). | 10 "Responses and safe errors"; 07 "Command outcomes" (resource saturation is distinct and retryable); 07 "bounded serializable retries". |
| D-JOURNAL-1 | Reservation is `INSERT ... ON CONFLICT (identity index expression) DO NOTHING RETURNING`: a concurrent duplicate blocks on the identity index until the first transaction ends, then reads the committed row (REPLAY / CONFLICT / PENDING) or proceeds as first after a rollback — no savepoint, no second round trip in the common case. A FAILED entry with the same digest replays as FAILED. `commit` accepts only 2xx outcomes. | 10 "Idempotency contract" (a concurrent duplicate receives the same durable result); D-IDEM-2. |
| D-LEASE-2 | `claim` runs under a savepoint so a refusal is an outcome (`RESUME_WITHOUT_CHECKPOINT` also covers a checkpoint mismatch, `DEADLINE_IMMUTABLE`, `SUBJECT_IMMUTABLE`, `COST_IMMUTABLE`, `DEADLINE_PASSED`) and the control-plane unit of work continues. The port's `CANCELLED` reason is not produced: the schema has no rule that refuses a claim because of cancellation (cancellation is a generation the owner observes). Open question Q8 for the authority. | 07 "Job and attempt states"; S090; 07 "Outbox" (the sweeper repairs abandoned leases in bounded batches). |
| D-CAP-1 | `CapabilityRepository.findMode` returns the offered capability of the mode when one is published (at most one by index), otherwise the newest capability of the mode, so the handler names `MODE_NOT_OFFERED` against a real state. | CMD011 precondition; 02 "Capability publication contract". |
## 12b. Implementation notes — branch `b06/application-api` (steps (2)–(4) of §12)

Recorded where the implementation had to decide something this document left open or stated ambiguously:

| id | note | why |
|---|---|---|
| I-DENY-1 (corrected by the review, R26; D-FACT-1) | A DENY is recorded as a `security_events` row in its **own** unit of work after the command's transaction rolled back (`runCommand` → `recordDenial`): every DENY decision of the authorizer (NOT_FOUND / NOT_A_MEMBER included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED (CMD026 and CMD023 NOT_APPROVAL_CONTROLLER). It enters the agency's stream only when that transaction proves and share-locks the caller's live membership there; otherwise it is a fact of the caller's own identity stream naming the requested agency. A structurally admitted command without an authenticated subject is recorded as an anonymous DENY (`refuseUnauthenticated`, ANONYMOUS context) before the 401. ALLOW facts: CMD001 OWNERSHIP_GRANTED and STEP_UP_FRESH for a step-up-authorized effect, in the command's own transaction. A handler's NOT_FOUND for a resource invisible under the caller's proven scope is not a security fact. (The original text claimed every AUTHENTICATION_REQUIRED outcome was recorded, while the edge answered 401 before the runtime ran, and recorded no NOT_FOUND and no ALLOW fact.) | 08 "Audit events and retention": denials are durable facts, not logs; 08 "Threat model and assets"; 10 "rejections leave no journal row" (D-IDEM-2). |
| I-ENV-1 | `CommandEnvelope` carries the `AuthenticatedSubject` (identity facts, provider label, subject SHA-256) beside `userId`; CMD001 calls `identities.syncOwn` before the owner membership insert so the membership's identity foreign key resolves under the self policy. | 08 "Authentication produces an identity reference and assurance facts"; §4.1 `memberships` FK identities. |
| I-VAL-1 | The schema validator is dependency-free (`api/json-schema`): it compiles exactly the keyword vocabulary the generated bundle and the request schemas use and refuses anything else at start-up, so no keyword is ever ignored and no schema can be compiled from a runtime value. Fastify's Ajv is not on the command path. | 10 "Version and validation" (strict, no coercion/defaults/removal), "Schema format execution" (calendar `date-time`, 2026-02-30 control), S093. |
| I-ERR-1 | New safe reasons for the HTTP boundary (`CONTENT_TYPE_UNSUPPORTED`, `BODY_TOO_LARGE`, `JSON_*`, `SCHEMA_VIOLATION`, `IDEMPOTENCY_KEY_*`, `AGENCY_SELECTOR_INVALID`, `PATH_ID_INVALID`, `SUBJECT_UNAUTHENTICATED`, and since the review `HEADER_REPEATED`, `REQUEST_MALFORMED`, `REQUEST_TIMEOUT` — E-HTTP-1; `CORRELATION_ID_INVALID` is withdrawn, E-CORR-1) and for the typed patch (`PATCH_*`, also field codes since D-API-2); a body larger than 1 MiB is `INVALID_REQUEST / BODY_TOO_LARGE` (400) to stay inside the closed status table. The review also added `RESPONSE_CONTRACT_VIOLATION` (D-RESP-1), `CONSEQUENCES_UNRECONCILED` and `LIVE_APPROVAL_UNBOUND` (D-PLAN-4) and `UPSTREAM_UNRESOLVED` (S089). | 10 "Request envelope"; §7 status table. |
| I-ADM-1 | The admission limiter is process-local (sliding windows per identity and per client address hash; interim values five creations per identity per hour, twenty per address per hour). A fleet-wide counter is an operations concern behind the same port. Since the review the transport feeds the address window (E-ADDR-1, R34); before, only the identity window was live. | 08 "Abuse controls"; open question Q2. |
| I-AUTH-1 | `apps/api` authenticates through an `Authenticator` port; the shipped implementation binds opaque bearer tokens to subjects for LOCAL and tests. The Identity Platform verifier (issuer, audience, signature, email and MFA claims) is not in this branch. | 08 "Authentication and assurance". |

## 12c. Integration record — branch `b06/integration` (steps (4)–(5) of §12)

`b06/integration` merges `b06/design`, `b06/persistence`, `b06/domain` and `b06/application-api`, applies D-PORT-1 across the
handlers, the authorizer and the in-memory ports, and adds the composition root of `apps/api` (`config`, `composition`,
`edition`, `bootstrap`, `main`), the real-database acceptance fixture `apps/api/test/support.ts` and the files that
demonstrate the 29 cases through the HTTP routes (`docs/design/B06-case-map.md`). The persistence harness moved from
`packages/persistence/test/harness.ts` to `src/testing/harness.ts` and is exported, with `startTemporaryPostgres`, by the
test-only subpath `@kauro/persistence/testing` for the entrypoint's tests (since the review, E-PKG-1: the main entry exports
no test helper); it is never wired into a deployment. Decisions and corrections the integration made (amended by the review
where noted; §12d):

| id | decision | why (authority) |
|---|---|---|
| I-INT-1 | The composition root runs in two steps. `openDatabase(config)`: pending migrations as the owner role over a dedicated connection (`applyMigrationsAs`, which refuses a SUPERUSER or BYPASSRLS migrator every time), then the runtime pool with the configured ceiling, one connection verified at once — a privileged login or a member of `kauro_control` refuses the start instead of the first request. `assembleApi(assembly)`: the authorizer, the admission limiter, the seven handlers over the edition's collaborators and the Fastify server. Configuration comes from the environment only (`loadConfig`): every variable is validated, a refusal names the variable and never its value, `KAURO_DB_POOL_MAX` has no default, the migrator must differ from the runtime login. Amended by the review: the api pool is 1..4 and the request, socket, shutdown and migrator limits are configuration (E-OPS-1); runners serialize on an advisory lock (E-MIG-1); the migrator password is consumed at start and never retained (E-SEC-1); shutdown drains within a deadline (E-OPS-2); outages and pool errors reach safe sinks (E-OPS-3); `/livez` and `/readyz` report the schema's compatibility (E-OPS-4). | 14 "Deployment and rollback" (explicit environment configuration; refuse to start when an input is missing); 07 "Restoration and migration" (migration roles are separate from runtime); 08 "Database isolation"; 07 "Connection budget and operating limits". |
| I-INT-2 | The plan-side collaborators are not bound in this edition: in a deployment CMD023 and CMD025 answer INTEGRITY_FAILURE / PLAN_SERVICES_UNAVAILABLE inside the unit of work (rolled back, no journal row). The retained-work inspector counts open projects; the external-action inspector reports none, because no ImportStage or PackageVersion aggregate exists yet. The acceptance tests bind deterministic implementations of ArtifactResolver, PlanPatchCompiler and DisclosureComposer, and for CMD026 an ExternalActionInspector that adds the completed stages a test registers — ports of `@kauro/application`, never fakes of the database. | 07 "Command outcomes and error taxonomy" (integrity failure is distinct and nonretryable until the implementation changes); 07 "Acceptance obligations" ("a downstream team must not fill a missing domain rule with a local guess"); 21 "Gate aliases and scoped closures". |
| I-INT-3 | Authentication of this edition: LOCAL reads a closed bearer-token file (provider facts per token; its instants must be real calendar instants — the contract validator's `isCalendarDateTime`, because `Date.parse` rolls 2026-02-30 into March); SANDBOX and LIVE refuse to start, since the Identity Platform verifier is not bound. | 08 "Authentication and assurance"; 10 "Schema format execution" (2026-02-30 is the rejection control); 14 "Deployment and rollback". |
| I-INT-4 (superseded by E-CORR-1, review R28: a malformed value is now ignored and replaced by a minted id, never refused) | A client-supplied correlation id is echoed only when it is an `id` (lowercase RFC 9562 UUID, the request-schema id shape); anything else is INVALID_REQUEST / CORRELATION_ID_INVALID and an absent one is minted. Before, any `[A-Za-z0-9._:-]{1,128}` token was admitted and every command carrying one failed with 500 at its first insert, since the journal, the events and the security events store a uuid — found when the in-memory api tests were ported to the real database. | Registry contract DomainEvent `correlationId: id` ("Safe operation trace"); reference/FIELD_CONTRACTS "Application IDs are opaque server identities"; 10 "Every request receives an opaque correlation ID". |
| I-INT-5 | The header-only head of the admission — the correlation id, then the content type (`admitHeaders`); since the review a repeated single-valued envelope header, then the content type, the correlation id being resolved by the transport (E-HTTP-1, E-CORR-1) — runs in a route `onRequest` hook before the body is read; `admitStructure` repeats it. Before, an oversized body of an unsupported type was answered BODY_TOO_LARGE by the parser's body limit instead of CONTENT_TYPE_UNSUPPORTED. | 10 "Request envelope" (content type, byte size, JSON syntax, duplicate keys, schema, authenticated subject, authorization); §7 validation order. |
| D-PORT-2 | `CommandJournal.commit` returns the committed entry as stored (`RETURNING`), and the runtime answers the first execution with the journaled body, decoded exactly as a replay decodes it. The first answer, a concurrent duplicate's answer and the recovery of a lost response are byte-equal except `replayed`; before, jsonb's key normalization made them equal only as JSON values. | 10 "Idempotency contract" ("A concurrent duplicate receives the same durable operation reference or final result"; "A response lost after commit is recovered by the same key"); S052 "identical replay recovers the original durable result". |
| D-CAP-2 | A capability becomes offered through its own lifecycle, not by a new row: a Capability row is born DESIGN for its revision and reaches an offered state only by the listed edges DESIGN → IMPLEMENTED_UNACCEPTED → QUALIFIED_INTERNAL → AVAILABLE_LIMITED (→ AVAILABLE), each edge recording the evidence its guard names (QUALIFIED_INTERNAL onward cite evidence hashes; AVAILABLE_LIMITED sets `valid_from`). A changed profile or envelope is a new capability version (CMD058 "Create a prospective version", manual 20), and restoring sale eligibility after SUSPENDED needs a new version and requalification; how CMD058 records a version is that package's decision — the B06 schema admits a second row of a mode only under another revision label (`capabilities_mode_version`), and no version is a shortcut to an offered state. The fixtures follow this (the harness's `offeredCapability` inserts DESIGN and walks the edges, `publishCapability` walks an existing row, and the persistence tests' raw fixture does the same); the database refuses a skipped edge (KA008) and a second row of the same mode and revision. | Registry `state_transitions` "Capability" (initial DESIGN, unlisted transitions rejected) and reference/TRANSITIONS_AND_EVENT_EFFECTS "Capability" (guards and effects per edge; "New version and requalification are required to restore sale eligibility"); registry contract Capability ("Requested, implemented and qualified are different states"; `version` "Capability revision"; `qualificationEvidenceHashes`; `validFrom` "Activation after acceptance"); 02 "Capability publication contract"; CMD058 ChangeCapability. |
| I-VIEW-1 | ApprovalView carries `withdrawnByMembershipId` beside `withdrawnAt` and `withdrawReasonCode`, so the CMD026 answer states when, by whom and why (the approving actor's membership is already in the view; no token or security evidence is added). | CMD026 (withdrawal is an authority event of its own); 07 "Audit and plan states" (PlanApproval records the actor's identity and membership); 10 "Responses and safe errors" (safe projections). |
| I-TEST-1 | Command-level acceptance tests live in `apps/api/test/`: through the real route (Fastify `inject`), the real composition root and a real PostgreSQL 17, with the superuser oracle reading every table and deterministic hold points inside the unit of work (the second request of a race is observed waiting on its lock in `pg_stat_activity`). The in-memory api tests of `e24d4f7` were replaced by real-database ones; every assertion was carried over (case map). | 07 "Acceptance obligations" (real PostgreSQL for tenant constraints, transactions, migrations and concurrency); 21 "Independent oracles", "Concurrency and crash matrix"; 10 "Contract tests and compatibility". |

## 12d. Independent review record — review of `b06/integration` at `e435a9a`

Five independent refuters, one lens each (tenant isolation, authorization and races, authority fidelity, case genuineness,
operability and safety), reviewed `b06/integration` at `e435a9a` and reported 54 findings, R1–R54, most of them reproduced
against a real PostgreSQL 17; seven are duplicates (R8 = R1, R12 = R7, R13 = R5, R19 = R15, R25 = R15, R27 = R17, R50 = R24).
Six fixers worked in parallel, one group each, on `b06/fix-a` … `b06/fix-f`; for every finding they reproduced the scenario as a
failing test first (real routes, the real composition root and a real PostgreSQL 17, or the runtime role on a real cluster),
chose the resolution the authority supports — a reviewer's proposed fix was treated as a proposal — and proved the test
depends on the fix by reverting it (the test fails) and restoring it (the test passes). The detailed records, with every
decision, its authority, the tests and the revert proofs, are the group files:

| group | findings | record |
|---|---|---|
| A — pipeline order and authorization | R1, R8, R2, R7, R12, R9, R16, R18, R26 | [`B06-review/A-pipeline-authorization.md`](B06-review/A-pipeline-authorization.md) |
| B — database integrity | R3, R4, R5, R13, R6, R10, R11, R14, R20, R30 | [`B06-review/B-database-integrity.md`](B06-review/B-database-integrity.md) (revert proof: `B-database-integrity-proof.mjs` and its spec) |
| C — handler semantics and locking | R15, R19, R25, R21, R22, R17, R27, R31, R32 | [`B06-review/C-handler-semantics.md`](B06-review/C-handler-semantics.md) |
| D — response contract | R23, R29 | [`B06-review/D-response-contract.md`](B06-review/D-response-contract.md) |
| E — transport and operability | R28, R33–R47 | [`B06-review/E-transport-operability.md`](B06-review/E-transport-operability.md) |
| F — case genuineness | R24, R50, R48, R49, R51, R52, R53, R54 | [`B06-review/F-case-genuineness.md`](B06-review/F-case-genuineness.md) |

The integration merged the branches in the order b, a, c, f, e, d, keeping both intents in every conflict (§12d.2), connected
what the fixers left to it, finished two observations the fixers recorded but were not assigned (§12d.2), and re-proved the
fixes on the merged tree: the revert proof of group B (fourteen specifications, every one failing without its fix and passing
restored) and eight revert-and-run mutations of groups A, C, D, E and F and of the integration (§12d.3). Every finding is
FIXED; none is DEFERRED or NOT_A_DEFECT. What stays open is listed in §12d.4.

### 12d.1 Findings

Tests are named `file :: test name` as they exist on `b06/integration`; "(dup.)" rows were resolved with their original.

| id | outcome | decision | authority | regression test |
|---|---|---|---|---|
| R1 | FIXED | The access decision (§6.1 steps 1–7) runs before the journal reservation: the first statements of a tenant command are the caller's identity row and the membership lookup under RLS, which see nothing for a foreign and for a nonexistent agency alike (404 NOT_FOUND / NOT_A_MEMBER, byte-equal); the journal INSERT, whose agency is a foreign key checked without RLS, happens only once a live membership is proven. D-PIPE-1. | 08 "Browser, API and cache isolation"; 10 "Request envelope", "Responses and safe errors"; COMMAND_CATALOGUE "Shared execution contract"; D-AUTHZ-4 | `apps/api/test/pipeline-authorization.test.ts` :: "R1/R8 DENY: a nonexistent agency and an existing foreign agency answer byte-equal problems on a path-scoped and on a header-scoped route; no journal row, no effect, nothing in any agency's stream" |
| R2 | FIXED | A denial enters an agency's stream only when the recording transaction proves (share-locked) the caller's live membership there; otherwise it is a fact of the caller's identity stream naming the selected agency in `requested_agency_id` (no FK). The insert policy of `security_events` enforces the same rule for the runtime role. D-FACT-1. | 08 "Database isolation", "Audit events and retention", "Threat model and assets"; D-RLS-1 | `apps/api/test/pipeline-authorization.test.ts` :: "R2 DENY: an unverified or disabled outsider writes nothing into another agency's security stream; its denial is a fact of its own identity stream naming the agency it selected; an unverified member's denial stays in its agency's stream"; `packages/persistence/test/security-events.test.ts` :: "R2: a fact in an agency's stream needs the writer's live membership in that agency — an outsider bound to the agency's context is refused, a member is admitted, a revoked member is refused, and nobody writes as someone else" |
| R3 | FIXED | Event identity is tenant-scoped (`domain_events_one_per_aggregate_version` on agency, kind, id, version); `domain_events_bind_aggregate` requires the named aggregate in the event's agency, visible to the writer, at or above the event's version (unknown and foreign alike, KA006); `require_event_for_version` matches on the aggregate's agency; the control plane reads events and appends none. D-EVT-2. | 08 "Database isolation"; 07 "Outbox, inbox and event ordering", "Database representation"; contract DomainEvent | `packages/persistence/test/integrity-guards.test.ts` :: "R3: an event names an aggregate of its own agency — agency A's runtime role can neither occupy B's next client version nor tell B's ids from unknown ones, and B's own event still commits"; `apps/api/test/database-integrity.test.ts` :: "R3: agency A's runtime role cannot occupy the next version of B's client; B's owner then archives it through CMD010 (200, version 2)" |
| R4 | FIXED | The control plane keeps its row policy on `command_journal` with a column grant of the safe technical metadata only (no `response_body`, `idempotency_key`, `request_digest`, `actor_id`). | 08 "Role and capability model" (Technical Operator: safe technical metadata), "Support access and break-glass"; §4.2 | `packages/persistence/test/integrity-guards.test.ts` :: "R4: the control plane reads the command journal's safe technical metadata across tenants, never the journaled response, the key, the digest or the actor"; `apps/api/test/database-integrity.test.ts` :: "R4: a client created through CMD009 journals its label; the control pool reads the journal's metadata of that entry but never its response" |
| R5 | FIXED | `approvals_actor_membership_fk (agency_id, actor_membership_id, actor_id)` and `approvals_actor_proof_fk (actor_id, assurance_proof_ref)` bind the actor, its own membership in the agency and a step-up proof of that same actor; the membership version is recorded, not keyed. Integration (I-REV-5): the approval and its withdrawal are acts of the acting session. D-PLAN-2. | 07 "Audit and plan states" (PlanApproval records actor identity, membership version, assurance evidence), "Transaction discipline"; 08 "Database isolation", "Role and capability model"; contract Approval `actorId` | `packages/persistence/test/integrity-guards.test.ts` :: "R5/R13: an approval binds its actor, the actor's own membership in this agency and a step-up proof of that same actor" and :: "R5 (acting session): an approval and its withdrawal are acts of the session's own identity — nobody records an approval in the approver's name, even with the approver's membership and fresh proof, nor a withdrawal under another member's membership; the approver's own session and the owner's own membership can" |
| R6 | FIXED | The request handlers hold INSERT only on `inbox_records` (RECEIVED, no outcome, deduplicated by a target-less `ON CONFLICT DO NOTHING`); reading, processing and settling belong to the control plane. | 10 webhook ingress; 15 "Webhooks and reconciliation"; 07 "Outbox, inbox and event ordering"; 08 "Threat model and assets" | `packages/persistence/test/integrity-guards.test.ts` :: "R6: the request handlers record provider events into the inbox once and can neither read nor rewrite any inbox row; the control plane consumes them" |
| R7 | FIXED | The journal is reserved after the access decision, so a REPLAY / CONFLICT / PENDING entry is answered only to a caller who now holds a live ACTIVE membership with the command's role; otherwise the current DENY answers and is recorded. The Authorizer port is split into `authorize` (steps 1–7) and `assure` (step 8, a new execution only), so a response lost after commit stays recoverable after the step-up aged. The alternative (document an exception) was rejected. D-PIPE-1. | 10 "Idempotency contract", "Request envelope"; 08 "Browser, API and cache isolation" (revocation invalidates server-side access immediately); reference/TRANSITIONS_AND_EVENT_EFFECTS "Membership" | `apps/api/test/pipeline-authorization.test.ts` :: "R7/R12 DENY: an idempotent replay is answered only to a caller who is still authorized — suspended 403, revoked 404, each recorded; a conflicting body gets the same refusal; reactivated, the replay is the original answer byte for byte" and :: "R7 control (recovery kept): a CMD025 replay needs the approver's current membership and role, not a fresh step-up — after the proof aged past the freshness window the replay still returns the journaled approval, while a new approval with that proof is ASSURANCE_REQUIRED"; `packages/authorization/test/authorizer.test.ts` :: "access and assurance are two decisions (R7): access never reads a proof — the replay of a step-up command is answered to a current member whose proof has aged; assurance is step 8 of a new execution only; a unit of work bound to another person decides nothing" |
| R8 | FIXED (dup. of R1) | Resolved with R1. | as R1 | as R1 |
| R9 | FIXED | `memberships.findLive` (the authorizer's read) is `SELECT … FOR SHARE`, held to the end of the unit of work: a suspension, revocation or role change of the actor's membership waits for the command, and one committed first is what the command reads. Lock order membership → aggregates. D-PIPE-1. | 07 "Agency and membership states", "Audit and plan states", "Transaction discipline"; 21 "Concurrency and crash matrix" | `apps/api/test/pipeline-authorization.test.ts` :: "R9 RACE: a command in flight holds its actor's membership — a revocation issued meanwhile waits until the approval commits; a revocation, suspension or role change committed first makes the command wait on the membership and then refuses it" |
| R10 | FIXED | `guard_active_owner_count`: an agency is born with `active_owner_count = 0`, and the counter changes only at trigger depth ≥ 2, the membership trigger's own UPDATE; no statement a role sends reaches that depth. The alternative (drop the counter) was not taken. D-OWN-1. | 07 "Agency and membership states", "Transaction discipline"; 08 "Database isolation"; R2-043 | `packages/persistence/test/integrity-guards.test.ts` :: "R10: active_owner_count is written only by the membership trigger — the runtime role can neither raise it by hand nor forge it at birth, so the last real owner stays protected" |
| R11 | FIXED | `plans_approval_fk (agency_id, approval_id, plan_id)` → `approvals (agency_id, approval_id, plan_id)`, deferred: a plan names only its own approval. D-PLAN-2. | CMD025 effect; contract Approval; 07 "Transaction discipline" | `packages/persistence/test/integrity-guards.test.ts` :: "R11: a plan names only its own approval — pointing plan Y at plan X's approval is refused at COMMIT and Y stays VALIDATED"; `apps/api/test/database-integrity.test.ts` :: "R11: plan X approved through CMD025; plan Y cannot be pointed at X's approval, and CMD025 then approves Y with an approval of its own" |
| R12 | FIXED (dup. of R7) | Resolved with R7. | as R7 | as R7 |
| R13 | FIXED (dup. of R5) | Resolved with R5. | as R5 | as R5 |
| R14 | FIXED | Step-up proofs are written only by the runtime group `kauro_assurance` (the verifier; INSERT for the identity it binds, no read) through `PgAssuranceProofRecorder`; `kauro_app` reads its own proofs; a login belongs to exactly one of the four runtime groups. D-EVID-1. | 08 "Identity is not permission", "Authentication and assurance", "Role and capability model", "Database isolation"; 14 "Identity matrix" | `packages/persistence/test/integrity-guards.test.ts` :: "R14: step-up proofs are written only by the step-up verifier — the request handlers cannot mint one, not even their own; the verifier writes only for the identity it binds and reads nothing" and :: "R14/R30: a verifier or validator login is its own runtime group — it runs no request-handler unit of work, and a login in two groups is refused by the verified pool"; `apps/api/test/database-integrity.test.ts` :: "R14/R30: the request-handler role cannot mint the evidence CMD025 checks — a step-up proof or a VALID receipt — while the verifier's proof and the validator's receipt admit the approval" |
| R15 | FIXED | Preconditions a command relies on but does not change are re-read under share locks held to COMMIT (CMD025: sealed source and current target; CMD011: agency and offered capability, the capability through a lock-only grant); lock order plan → revision → target, agency → client → capability. D-TX-1. | 07 "Transaction discipline"; 10 "Concurrency and preconditions"; CMD025 failure; CMD011 precondition | `apps/api/test/cmd025-approve-plan.test.ts` :: "RACE: a source expiry racing ApprovePlan — the sealed revision is held under a share lock to COMMIT: an expiry that comes second waits and then reads the approval; an expiry committed first is refused 422 SOURCE_EXPIRED" and :: "RACE: a target-contract supersession racing ApprovePlan — the contract is held under a share lock to COMMIT: a supersession that comes second waits and then reads the approval; one committed first is refused 422 TARGET_STALE"; `apps/api/test/cmd011-create-project.test.ts` :: "RACE: a capability suspension racing CreateProject — the capability is held under a share lock to COMMIT: a suspension that comes second waits for the project; one committed first refuses it 422 CAPABILITY_UNAVAILABLE" and :: "RACE: an agency transition racing CreateProject — the agency is held under a share lock to COMMIT: a closure that comes second waits for the project; one committed first refuses it 409 AGENCY_NOT_OPEN" |
| R16 | FIXED | Step 2 reads the caller's own `identities` row beside the token's facts: a DISABLED row refuses whatever the token says; verification stays the token's; the unit of work must run for the authenticated subject. D-ASSUR-2. | 07 "Aggregate ownership" (Identity owns security status); 08 "Identity is not permission", "Invitation, recovery and ownership transfer" | `apps/api/test/pipeline-authorization.test.ts` :: "R16 DENY: the authorizer consults the stored identity state — a member whose identity row is DISABLED is refused IDENTITY_DISABLED although the token says ACTIVE, CreateAgency likewise, and nothing re-enables the row; enabled again, the member is admitted"; `packages/authorization/test/authorizer.test.ts` :: "R16: the stored identity row is consulted beside the token — a DISABLED row refuses a token that says ACTIVE, for a member and for CreateAgency; a stored row never verifies a token that is not, and no stored row leaves the token's facts to decide" |
| R17 | FIXED | CMD026 `reasonCode` is the registry `label`, checked by `kauro.is_label` on the approval row; being customer text it stays on the row and in the tenant's ApprovalView and leaves the `approval.withdrawn.v1` / `plan.withdrawn.v1` payloads. The alternative (keep the token and cite "Stable reason") does not hold: FIELD_CONTRACTS types that field `label` too. D-API-1. | registry commands.json CMD026; reference/FIELD_CONTRACTS "Common rules"; 07 "Outbox, inbox and event ordering"; D-EVT-2 | `apps/api/test/cmd026-withdraw-approval.test.ts` :: "OK (reason label): the withdrawal reason is the registry's label — 'Customer asked us to stop' is accepted, stored and answered verbatim, and never copied into an event payload" |
| R18 | FIXED | After the plan lock, CMD026 resolves the approval the plan carries (live, or the one it carried before a withdrawal) and refuses anyone but its approving actor or an OWNER with NOT_APPROVAL_CONTROLLER (recorded) before the version and state answers; a plan that never carried an approval answers its version and state. D-AUTHZ-3. | §6.1 (step 9 before step 10); 08 "Identity is not permission"; CMD026 precondition | `apps/api/test/pipeline-authorization.test.ts` :: "R18 DENY: CMD026 checks the approval controller before version and state — a non-controlling APPROVER is NOT_APPROVAL_CONTROLLER (recorded) with a stale version and on a WITHDRAWN plan; the controller and an OWNER get the version and state answers; a plan that never carried an approval answers its state" |
| R19 | FIXED (dup. of R15) | Resolved with R15. | as R15 | as R15 |
| R20 | FIXED | Every aggregate is born in its machine's initial state (`kauro.state_machines`, `enforce_initial_state`, KA008); memberships are born INVITED except the founding owner of CreateAgency; the fixtures walk the listed edges and the DatasetRevision lifecycle events are registered. D-INIT-1. | registry `state_transitions.json`; reference/TRANSITIONS_AND_EVENT_EFFECTS; CMD001 effect; D-CAP-2, D-AGG-1, D-AGG-2, D-CTX-2 | `packages/persistence/test/integrity-guards.test.ts` :: "R20: every aggregate is born in its machine's initial state — a row inserted in a later state is refused as the runtime role that would write it (KA008)" and :: "R20: the founding owner of CreateAgency is the one membership born ACTIVE — a founding ADMIN, a founding owner for somebody else, an owner written by another session and a second owner are all refused"; `packages/persistence/test/migrations.test.ts` :: "R20: the initial-state seed equals the registry machines (and the platform machines of D-AGG-1/D-AGG-2); every table that guards its listed edges also guards its birth state" |
| R21 | FIXED | Revising an APPROVED plan takes the approval's controller before version and state, evaluates the edge guard through `CommercialConsequenceInspector` (vacuous in B06, recorded), and withdraws the approval in the same transaction with its own event; the database refuses a live approval on a plan that is not APPROVED under it (KA020). D-PLAN-4. | registry Plan machine (edges new_plan_revision from APPROVED, withdraw_approval); CMD026 precondition; reference/HASHING_AND_ACCOUNTING_RULES; 07 "Transaction discipline" | `apps/api/test/cmd023-revise-plan.test.ts` :: "APPROVED: revising an approved plan takes the approval's controller and reconciled consequences; the approval is withdrawn with its own event in the same transaction, so no live approval remains on the SUPERSEDED plan" and :: "RACE: RevisePlan of an APPROVED plan and WithdrawApproval serialize on the plan lock — one of them ends the approval, once" |
| R22 | FIXED | CMD009 records the end-client processing authority in its own unit of work under the reference the agency names; a reference another agency recorded rejects; the design-invented `kind`/`evidence_hash` columns are dropped (open question Q10). D-CLIENT-1. | COMMAND_CATALOGUE CMD009 precondition and failure; contract EndClient; reference/END_TO_END_PLAYBOOKS FLOW01; 07 "Acceptance obligations" | `apps/api/test/cmd009-create-client.test.ts` :: "OK (deployment path): CreateClient records the end-client processing authority in its own unit of work — an agency created through the route creates its first client with nothing recorded beforehand; its reference binds a second workspace; another agency cannot record or use it" |
| R23 | FIXED | Closed response schemas derived from the registry; every route declares its replies and every reply is checked before it is sent (422 INTEGRITY_FAILURE / RESPONSE_CONTRACT_VIOLATION otherwise); OpenAPI 3.1 generated from the registry and checked against the registered routes in `verify`; sentinel serialization over the seven routes. Integration: the probes are operational routes of the same contract (I-REV-2) and the problem written below HTTP is checked too (I-REV-3). D-RESP-1. | 10 "Version and validation", "Responses and safe errors", "Contract tests and compatibility"; reference/FIELD_CONTRACTS "Common rules"; 07 "Command outcomes and error taxonomy"; 08 "Security acceptance" | `apps/api/test/response-contract.test.ts` :: "R23: a success reply its route's contract refuses is never sent — a member a collaborator adds to the ArchiveClient view is answered 422 INTEGRITY_FAILURE under the correlation id, and the sink receives the violation (path and code, never the value)", :: "R23: a problem its contract refuses is never sent — a collaborator failure carrying a raw value beside its field error and a reason outside the vocabulary answers 422 INTEGRITY_FAILURE; the withdrawal rolled back" and :: "R23: every served route declares its replies (the route inventory the OpenAPI checker reads); a route that declares none refuses to register; a reply whose declared schema the validator never compiled, or whose body is sent as text instead of a checked object, is refused like any other violation"; `apps/api/test/sentinel-serialization.test.ts` :: "no sentinel, secret, internal column value or diagnostic text of any tenant appears in any reply the seven routes sent"; `tools/test/openapi.test.mjs` :: "the committed document is the generated one, byte for byte, and matches every registered route of the composed api" |
| R24 | FIXED (S089 and S093 PARTIAL in the case map) | S089: a dispatch intent declares `upstream_request_ids` and `request_journal_upstream_resolved` (each upstream FOR SHARE) refuses it (KA009 UPSTREAM_UNRESOLVED) unless every upstream is a CONSUMED attempt of the same scope. S090: `leases.cost_authority_id` is fixed by the first claim and immutable (COST_IMMUTABLE). The halves other packages own are named: S089's actual funded grant (S041/IC-12 of B03, R2-044 of B08) and S093's metadata command (CMD018 of B17). D-S089/S090/S093, D-LEASE-1. | reference/ACCEPTANCE_SCENARIOS S089, S090, S093; 22 "Materialization", "Repair and resume"; 07 "CommercialAuthorization", "Job and attempt states"; 21 "Evidence classes", "Completion rule" | `packages/persistence/test/journals-leases.test.ts` :: "S089: a request journal entry cannot be materialized with a short SHA, without a positive reservation, without a grant or with an upstream that is not resolved (failed, cancelled, uncertain, unconsumed, unknown, of another scope, repeated or itself); the valid controls commit" and :: "S090: a lease preserves subject, deadline, cost and checkpoint identity across a takeover; a resume without the checkpoint, with a reset deadline, another subject or another cost authority is refused"; `packages/persistence/test/adapters-journals-outbox.test.ts` :: "S089 failed upstream through the adapter: a dispatch intent naming an upstream that failed, was cancelled, is uncertain, is not yet consumed, is unknown or belongs to another agency is refused UPSTREAM_UNRESOLVED and materializes nothing; naming consumed upstreams it is RESERVED; an upstream that fails or is consumed concurrently is ordered before the reservation"; `packages/persistence/test/adapters-leases.test.ts` :: "S090 through the adapter: claim, HELD, checkpoint under the fence, refused resumes (no or another checkpoint, reset deadline, another subject, another cost authority), a valid takeover that keeps subject, clock, cost and checkpoint identity, advances the fence and fences the old owner out" |
| R25 | FIXED (dup. of R15) | Resolved with R15. | as R15 | as R15 |
| R26 | FIXED | Every authorizer DENY (NOT_FOUND included) and every handler-level NOT_AUTHORIZED / ASSURANCE_REQUIRED is a durable fact; an unauthenticated command leaves an anonymous DENY written in the ANONYMOUS context before the 401; ALLOW facts OWNERSHIP_GRANTED (CMD001) and STEP_UP_FRESH (CMD025) commit with the effect; I-DENY-1 corrected. D-FACT-1, D-CTX-1. | 08 "Threat model and assets", "Audit events and retention", "Identity is not permission" | `apps/api/test/pipeline-authorization.test.ts` :: "R26: an unauthenticated command, a non-member probe and an identity-status denial each leave one durable DENY fact of the right shape; CMD001 records the owner grant and CMD025 the step-up as ALLOW facts in the agency's stream, and a replay records nothing"; `packages/persistence/test/security-events.test.ts` :: "R26: the anonymous fact — written with no user and no agency bound, by nobody, as a DENY of assurance NONE; refused under any user context, as an ALLOW, or in a stream" and :: "R26: the ANONYMOUS context runs on the request-handler pool only, sees no row, and writes nothing but its anonymous fact" |
| R27 | FIXED (dup. of R17) | Resolved with R17. | as R17 | as R17 |
| R28 | FIXED | The correlation id is resolved once, as the request id: adopted when the client's value is an `id`, otherwise minted; never refused, never echoed. E-CORR-1 (supersedes I-INT-4). | 10 "Request envelope"; reference/FIELD_CONTRACTS DomainEvent `correlationId`; 07 "Command outcomes and error taxonomy" | `apps/api/test/transport.test.ts` :: "R28: a client correlation id that is not an id never refuses the command — the server mints a UUIDv7, answers and records the command under it, and never echoes the client value"; `packages/application/test/admission.test.ts` :: "R28: a malformed client correlation id is never refused and never adopted — the server mints its own; a well-formed one is adopted; a missing one is minted" |
| R29 | FIXED | ApprovalView selects every member of the registry Approval contract, `actorId` included, so a consumer recomputes `approvalHash` from the DTO; the proof and the membership version stay off the wire. D-RESP-1. | contract Approval `actorId`; reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation"; 10 "Agency and team routes" | `apps/api/test/response-contract.test.ts` :: "R29: the approval the routes answer carries actorId, and a consumer recomputes approvalHash from the wire DTO alone — when approved and after withdrawal"; `packages/application/test/response-schemas.test.ts` :: "R29: ApprovalView selects every member of the KAURO_PLAN_APPROVAL_V1 preimage as required, and actorId is the registry's Approval.actorId" |
| R30 | FIXED | Receipts are written only by the runtime group `kauro_validator` (under the plan's tenant, no read) through `PgValidationReceiptRecorder`; `plans_receipt_fk` binds a plan to a receipt of its own body and subjects (six columns); `plans_bind_valid_receipt` refuses a receipt that is not VALID. D-EVID-1, D-PLAN-2. | registry contract ValidationReceipt (producer MC validator); reference/FIELD_CONTRACTS; 06 "Migration validation and final states"; 07 "Audit and plan states"; CMD024; 14 "Identity matrix" | `packages/persistence/test/integrity-guards.test.ts` :: "R30: validation receipts are written only by the validator, under the plan's own tenant; a plan binds only a VALID receipt of its own body and subjects" and :: "R14/R30: a verifier or validator login is its own runtime group — it runs no request-handler unit of work, and a login in two groups is refused by the verified pool"; `apps/api/test/database-integrity.test.ts` :: "R14/R30: the request-handler role cannot mint the evidence CMD025 checks — a step-up proof or a VALID receipt — while the verifier's proof and the validator's receipt admit the approval" |
| R31 | FIXED | A typed-patch rejection carries the compiler reason as the field code (PATCH_UNKNOWN_CANDIDATE, PATCH_UNKNOWN_FIELD, PATCH_EFFECT_NOT_PERMITTED, PATCH_MALFORMED); UNKNOWN_REFERENCE only for a reference that does not resolve. D-API-2. | 10 "Responses and safe errors"; CMD023 precondition | `apps/api/test/cmd023-revise-plan.test.ts` :: "DENY (typed patch): each compiler rejection answers its own reason and the same code on the field; only a reference that does not resolve is UNKNOWN_REFERENCE" |
| R32 | FIXED (a missing record; no code defect) | The manual-10 / catalogue conflict on the approval command's hashes is recorded as open question Q9 with its interim binding (planHash, composite keys, expectedVersion, share-locked currency). The test pins what the binding rests on; it passes before and after, because the defect was the missing record (`e435a9a` had no mention of it in the design). | 10 "Concurrency and preconditions", "Request envelope"; registry CMD025; reference/HASHING_AND_ACCOUNTING_RULES; D-PLAN-2 | `apps/api/test/cmd025-approve-plan.test.ts` :: "the approval binds its source and target through the planHash the approver names (the interim binding of the manual-10 / catalogue conflict, open question Q9)" |
| R33 | FIXED | Migration runners serialize on a database-scoped session advisory lock taken before the bootstrap DDL; the ledger is created and read under it. E-MIG-1. | 07 "Restoration and migration", "Connection budget and operating limits" | `packages/persistence/test/migration-runner.test.ts` :: "R33: two runners started at once on a fresh database serialize on the runner lock — both succeed, one applies every migration, the other re-reads the ledger under the lock and skips them" |
| R34 | FIXED | The transport hashes the client network (HMAC-SHA256, IPv4, IPv6 /64) from the socket peer or exactly the configured trusted proxy hops; the envelope carries it; CMD001 passes it to the limiter, so the per-address window is live. E-ADDR-1. | 08 "Abuse controls"; 14 "Initial architecture"; I-ADM-1 | `apps/api/test/operability.test.ts` :: "R34: one client address cannot rotate identities past the per-address creation window of the running api — twenty verified identities are admitted, the next is 429 CREATION_RATE_LIMITED, and a forged X-Forwarded-For moves nothing when no proxy hop is trusted"; `apps/api/test/transport.test.ts` :: "R34: the client address reaches the creation limiter as a keyed hash of its network — through exactly the configured proxy hops; N+1 identities from one client are limited, another client is not, and a forged X-Forwarded-For moves nothing when no hop is trusted" |
| R35 | FIXED | Shutdown drains: `Connection: close` from preClose, 503 on still-open connections, readiness DRAINING, and a deadline below the platform grace period. E-OPS-2. | 14 "Initial architecture", "Monitoring and service health", "Deployment and rollback"; 10 "Idempotency contract" | `apps/api/test/operability.test.ts` :: "R35: shutdown drains — the in-flight command is answered with Connection: close, a request completed on an open connection meanwhile is a 503 problem, readiness reports DRAINING, and close() ends with the in-flight work instead of waiting for keep-alive sockets" and :: "R35: the shutdown deadline is kept — a command blocked past it has its connection closed and shutdown() returns DEADLINE_EXCEEDED; the close completes once the database lets the command go" |
| R36 | FIXED | Request and connection timeouts from the environment (Node's checking interval and headers timeout bounded by them); a timed-out request is a REQUEST_TIMEOUT problem and closed. E-OPS-1, E-HTTP-1. | 10 "Request envelope" | `apps/api/test/operability.test.ts` :: "R36: a request that stalls is not held forever — past the request timeout it is answered REQUEST_TIMEOUT and closed; a silent socket is closed past the connection timeout" |
| R37 | FIXED | The migrator connection has a connect timeout and session statement and lock timeouts; every runner transaction sets both locally; the api reads the three limits when migrating on start. E-MIG-1, E-OPS-1. | 07 "Restoration and migration" | `packages/persistence/test/migration-runner.test.ts` :: "R37: the migrator is bounded — a host that accepts and never answers refuses within the connect timeout, and a lock held on the ledger refuses within the lock timeout instead of hanging the start"; `apps/api/test/operability.test.ts` :: "R37: with migrations on start, a database host that accepts and never answers refuses the start within the migrator's connect timeout" |
| R38 | FIXED | Pool errors reach `PoolConfig.onError` as safe tokens — idle ones and, since the integration (I-REV-4), those of a connection a caller holds, which no longer end the process; the api reports the cause of every CAPACITY_UNAVAILABLE and NOT_READY by correlation id. E-OPS-3. | 14 "Monitoring and service health"; 07 "Command outcomes and error taxonomy"; 08 "Audit events and retention" | `packages/persistence/test/pool-diagnostics.test.ts` :: "R38: an idle connection the server terminates reaches the pool's error sink as pool name, class and SQLSTATE — never the message or a connection parameter", :: "R38: without a configured sink the classification is written to stderr, one line, and nothing is swallowed" and :: "R38: a connection the server terminates while a unit of work holds it fails that unit of work and reaches the sink as an in-use connection error — no error event is left unhandled, and the pool then serves a fresh connection"; `apps/api/test/operability.test.ts` :: "R42 and R38: /livez and /readyz outside /api/v1 — readiness verifies a connection and the schema against the shipped migrations (503 when drifted or behind, tolerant of a newer expand); a database outage is visible by correlation id in the unavailable and not-ready sinks and in the pool sink, never with a credential" |
| R39 | FIXED | Framework errors (an undecodable URL, an over-long path parameter) go through the problem translation; errors below HTTP are answered with a problem and a minted correlation id. E-HTTP-1. | 10 "Responses and safe errors" | `apps/api/test/transport.test.ts` :: "R39: framework errors are problems — an undecodable URL is REQUEST_MALFORMED, an over-long path parameter PATH_ID_INVALID, an unreadable request line REQUEST_MALFORMED; each with a correlation id and nothing echoed" |
| R40 | FIXED | Bodies reach admission as bytes and are decoded as strict UTF-8 (an invalid sequence or a BOM is JSON_SYNTAX); a body that is not its declared length is REQUEST_MALFORMED. E-HTTP-1. | 10 "Request envelope"; RFC 8259 §8.1 | `apps/api/test/transport.test.ts` :: "R40: the body is strict UTF-8 — invalid bytes are JSON_SYNTAX with Content-Length and when chunked, nothing is stored with U+FFFD; a body shorter or longer than its Content-Length is REQUEST_MALFORMED"; `packages/application/test/admission.test.ts` :: "R40: the body is decoded as strict UTF-8 — an invalid byte sequence or a byte order mark is JSON_SYNTAX, never replaced; valid multi-byte text is admitted unchanged" |
| R41 | FIXED | A repeated single-valued envelope header is refused HEADER_REPEATED as the first admission check, before any value is used. E-HTTP-1. | 10 "Request envelope"; 08 "Identity is not permission" | `apps/api/test/transport.test.ts` :: "R41: a repeated Authorization, Content-Type, Idempotency-Key, X-Correlation-Id or X-Kauro-Agency is refused as HEADER_REPEATED before any value is used — a second bearer token cannot choose the acting subject"; `packages/application/test/admission.test.ts` :: "the header-only head of the order (a repeated envelope header, then the content type) is decided before a body exists; everything else waits for the body" |
| R42 | FIXED | `GET /livez` and `GET /readyz` outside /api/v1; readiness compares the migration ledger, read over a verified runtime connection, with the shipped migrations by version and checksum. Integration (I-REV-2): the probes are operational routes of the response contract. E-OPS-4. | 14 "Monitoring and service health", "Deployment and rollback"; 07 "Restoration and migration" | `packages/persistence/test/schema-readiness.test.ts` :: "R42: the runtime roles read the ledger (and cannot write it); compared with the shipped migrations it is COMPATIBLE, DRIFTED on a changed checksum, BEHIND on a missing version, and tolerates a newer expand migration"; `apps/api/test/operability.test.ts` :: "R42 and R38: /livez and /readyz outside /api/v1 — readiness verifies a connection and the schema against the shipped migrations (503 when drifted or behind, tolerant of a newer expand); a database outage is visible by correlation id in the unavailable and not-ready sinks and in the pool sink, never with a credential" |
| R43 | FIXED | `KAURO_DB_POOL_MAX` is 1..4 for the api; 24 stays the application-wide pool ceiling. E-OPS-1. | 07 "Connection budget and operating limits" | `apps/api/test/operability.test.ts` :: "configuration of the operating limits: the api pool stays inside the four-connection budget (R43), the proxy hop count is explicit outside LOCAL (R34), request, socket and shutdown deadlines are bounded (R35, R36), the migrator's limits are read with migrations on start (R37), and its password is never configuration (R44)"; `apps/api/test/composition.test.ts` :: "configuration: every variable is validated and a missing or malformed one refuses the start by name, never by value; the pool ceiling is a required input" |
| R44 | FIXED | `bootstrap` consumes the migrator password: removed from the environment before anything runs, used for the migration connection only, never retained; without migrations on start it refuses the start. The one-shot migrate-only entry point is not built (§12d.4). E-SEC-1. | 07 "Restoration and migration"; 08 "Database isolation", "Secrets and supply chain"; 14 "Identity matrix" | `apps/api/test/operability.test.ts` :: "R44: bootstrap consumes the migrator password — it leaves the environment before anything runs and is no part of the configuration the running process keeps" |
| R45 | FIXED | The request id is the correlation id (`genReqId`, log label `correlationId`); every log line, sink and answer carries it, a below-HTTP answer included. E-CORR-1. | 07 "Command outcomes and error taxonomy"; 14 "Monitoring and service health" | `apps/api/test/transport.test.ts` :: "R45: the request log's id is the correlation id — supplied or minted, every log line of a request carries the id its answer names, the internal-error sink uses the same id, and an answer below HTTP is logged under its id too" |
| R46 | FIXED | The test helpers are the test-only subpath `@kauro/persistence/testing`; the architecture gate refuses it in production source. E-PKG-1. | 07 "Platform topology"; 08 "Secrets and supply chain" | `packages/persistence/test/package-surface.test.ts` :: "R46: the production entry point exports no test helper; the test-only subpath @kauro/persistence/testing does"; `tools/test/architecture-gate.test.mjs` :: "a test-only subpath is importable from a test file only, never from production source; a declared workspace dependency nothing imports is refused" |
| R47 | FIXED | Persistence no longer declares `@kauro/application`; `@types/pg` is a pinned runtime dependency; the gate refuses an unused declared workspace dependency; clean-consume type-checks the tarballs. E-PKG-1. | 08 "Secrets and supply chain" (dependencies pinned); S045 | `packages/persistence/test/package-surface.test.ts` :: "R47: every declared workspace dependency is imported, and the pg types the public declarations name are a pinned runtime dependency"; `tools/test/architecture-gate.test.mjs` :: "a test-only subpath is importable from a test file only, never from production source; a declared workspace dependency nothing imports is refused" |
| R48 | FIXED | A golden vector for KAURO_PLAN_APPROVAL_V1 whose hex was derived outside the product (GNU sha256sum over a hand-written canonical preimage, cross-checked with python3), and an oracle written from the authority text, checked against the vector before the api test trusts it; the api test reads the nine members from the oracle's row. | reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation"; 21 "Independent oracles"; CMD025-OK | `packages/application/test/approval-hash.test.ts` :: "CMD025-OK golden vector: approvalHashOf over the fixed KAURO_PLAN_APPROVAL_V1 preimage equals the hex derived outside the product; the test oracle reproduces it" and :: "every one of the nine members is bound by the approval hash, and the domain separates it from every other digest class"; `apps/api/test/cmd025-approve-plan.test.ts` :: "OK: an APPROVER with a fresh step-up approves a VALIDATED plan whose receipt, source and target are current; the approval hash binds the named preimage" |
| R49 | FIXED | The CMD010 RACE test covers the whole registry scenario (version race, identical retry, conflicting same-key request, crash before COMMIT after the writes, response lost after COMMIT); CMD023-RACE gains the conflicting same-key request and CMD025-RACE the crash after the writes. | registry CMD010/CMD023/CMD025-RACE; 10 "Idempotency contract"; 07 "Transaction discipline"; 21 "Concurrency and crash matrix" | `apps/api/test/cmd010-archive-client.test.ts` :: "RACE: two archive calls with the same expectedVersion → one 200, one 409; identical retry replays; the same key with another expectedVersion or another client → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the client ACTIVE and the same key then archives it; a response lost after COMMIT is recovered by the key"; `apps/api/test/cmd023-revise-plan.test.ts` :: "RACE: two revisions on one version → one successor; identical retry replays; the same key with another patch → 409 IDEMPOTENCY_CONFLICT; crash leaves the predecessor unsuperseded and the same key then revises it once"; `apps/api/test/cmd025-approve-plan.test.ts` :: "RACE: two approvers on one version → one 201, one 409; identical retry replays; conflicting → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the plan VALIDATED with no approval and the same key then approves it once" |
| R50 | FIXED (dup. of R24) | Resolved with R24. | as R24 | as R24 |
| R51 | FIXED | The persistence S051 test drives `PgPlanRepository` on two runtime-role connections (one CAS applies; the loser, observed waiting, reads STALE) and shows `plans_supersedes_once` refusing a second successor with its event present. | S051; 07 "Transaction discipline"; §5 | `packages/persistence/test/discipline.test.ts` :: "S051: two revisions racing on one plan version through the plan adapter — one compare-and-swap applies, the loser waits on the row lock and reads STALE with the current version; a second successor of the same predecessor is refused by plans_supersedes_once" |
| R52 | FIXED | The persistence S052 test drives `PgCommandJournal.reserve`/`commit` (REPLAY, CONFLICT with one row, another agency's key another identity) above the raw database facts. | S052; 10 "Idempotency contract" | `packages/persistence/test/journals-leases.test.ts` :: "S052: through the command journal adapter the same digest replays the stored response and a different digest under the same key is CONFLICT with no second row; the identity index makes the key unique, a committed entry is final, the same key in another agency is another identity" |
| R53 | FIXED | The concurrent-duplicate test observes the wait with `waitForLockWait` (throws when no backend waits) and exercises both interleavings. Integration (I-REV-6): the api RACE tests let their held request go in a `finally`, so a wait that never happens fails the test instead of hanging it. | 21 "Concurrency and crash matrix" | `packages/persistence/test/journals-leases.test.ts` :: "a concurrent duplicate blocks on the identity until the first transaction commits, then sees the committed entry; after a rollback it proceeds as first" |
| R54 | FIXED | A real hold point between the two statements of `insertWithDraftRevision`: the command is observed waiting on its revision INSERT while holding its project row, the statement is cancelled there (503, nothing committed), and the same key then creates the pair once. The claim was made true rather than renamed away. | registry CMD011-RACE; 07 "Transaction discipline"; 21 "Concurrency and crash matrix" | `apps/api/test/cmd011-create-project.test.ts` :: "RACE: identical retry replays; conflicting same key → 409; a crash before COMMIT commits nothing; a unit of work interrupted between the project insert and the revision insert commits nothing and the same key then creates the pair once; a project row without its revision cannot commit (deferred FK)" |

### 12d.2 Integration record

Conflicts, each resolved keeping both intents:

- `packages/persistence/src/pool.ts` (a, b, e): the header names the four execution contexts (a), the four runtime groups (b)
  and the error sink (e).
- `create-client.ts`, `create-project.ts`, `revise-plan.ts` (a, c): a's order (authorize, then reserve) with c's locks,
  authority recording and APPROVED-predecessor steps; `withdraw-approval.ts` keeps a's controller-first check through c's
  shared `controlsApproval`, the rule RevisePlan applies too.
- Migration 0001 and `sqlstate.ts` (b, f, c): the SQLSTATE vocabulary lists KA009 UPSTREAM_UNRESOLVED (f) and KA020
  LIVE_APPROVAL_UNBOUND (c) beside b's widened KA008; both are mapped.
- `cmd011` and `cmd025` tests (b, c, f): the union of the imports; the CMD025-OK oracle keeps f's agency and disclosures members
  with b's approver membership version 2 (invited, then accepted).
- `@kauro/persistence` exports (b, e): e's runner, readiness and diagnostics beside b's `RUNTIME_ROLES` and evidence recorders;
  the testing subpath exports b's `LoginRole`; every test that imports a helper now does so from `@kauro/persistence/testing`.
- `apps/api` composition, index and server (a, c, d, e): e's transport (request id as correlation id, bytes, draining, framework
  and below-HTTP problems) carries d's route inventory and send guard, a's unauthenticated branch and c's commercial-consequence
  collaborator; the guard's correlation id is the request id (E-CORR-1).
- Test combinations the merged fixtures broke and that now use the listed edges: a's R2 revocation and R9 race expect the
  member's current version (b's fixtures invite, then accept: members are at version 2); d's response-schema test binds c's
  `commercialConsequences`; d's sentinel oracle no longer reads `processing_authorities.evidence_hash`, which c removed.

Decisions the integration made:

| id | decision | why (authority) |
|---|---|---|
| I-REV-1 | Merge order b, a, c, f, e, d (the database first, the pipeline over it, the handlers, the case tests, the transport, the response contract last, since it checks every reply the others produce). | 21 "Finite audit procedure" (repair, then repeat only invalidated checks). |
| I-REV-2 | The liveness and readiness probes (E-OPS-4) are the operational routes of the response contract: `OPERATIONAL_ROUTES` of `@kauro/application` declares `getLiveness` and `getReadiness` with their closed reply schemas; `health.ts` serves them from that list and registers each with `operationalRouteResponses`, so the validator compiles their replies, the send guard checks them and the OpenAPI document (nine operations) documents them. `tools/openapi.mjs` gives `assembleApi` the database handle the transport requires — the build's schema version and a readiness read that refuses loudly, since registering routes serves no request. | 10 "Version and validation" ("The build fails on undocumented public routes"); 14 "Monitoring and service health". |
| I-REV-3 | The one answer written without a Fastify reply — the problem of an error below HTTP (`clientErrorHandler`) — is checked against the unrouted contract before it is written, and the status line names the problem's own status. | 10 "Responses and safe errors"; D-RESP-1 (a reply the contract refuses is never sent). |
| I-REV-4 | A pooled connection is listened to for as long as a caller holds it: pg-pool detaches its idle listener at checkout, so a connection lost mid-request (failover, administrator termination) raised an unhandled `error` event and would end the process with every request in flight (fixer F's observation). The error now reaches the pool sink as an IN_USE connection error, the holder's next statement fails on its own (the unit of work answers INTERNAL_ERROR by correlation id; a COMMIT in flight may have happened, so retrying with the same key is the recovery), and the release destroys the connection. | 14 "Monitoring and service health" (a database outage is visible without exposing credentials); 07 "Command outcomes and error taxonomy"; 10 "An unexpected 500 does not automatically mean a command did not commit". |
| I-REV-5 | An approval and its withdrawal are acts of the acting session (fixer B's observation): the insert policy of `approvals` requires `actor_id = current_user_id()`, and the withdrawal policy requires the recorded withdrawer to be a membership of the session's user in the agency; SELECT stays tenant-wide. The R5/R13 probes now run in the session of the actor they name, so only the key under test can refuse them. | 07 "Audit and plan states"; 08 "Role and capability model" (nobody acts as another by putting an ID in a request); 07 "Transaction discipline" (application checks cannot be the sole protection). |
| I-REV-6 | Every api RACE test lets its held request go (or crashes it) in a `finally` around the lock-wait observation, so a wait that never happens fails the test instead of leaving a transaction open and hanging the file (fixer F's observation). | 21 "Concurrency and crash matrix"; the rule that a wait that can fall through is itself a defect. |

### 12d.3 Proof on the merged tree

- Group B's revert proof (`node docs/design/B06-review/B-database-integrity-proof.mjs`, fourteen specifications over the
  migrations): every specification fails without its fix and passes restored (R3, R3-bind, R4, R5-membership, R5-proof, R6,
  R10, R11, R14, R20, R20-membership, R30-insert, R30-fk, R30-valid).
- Revert-and-run mutations of the other groups and of the integration, each rebuilt, run by name, restored and re-run:
  R1 (the journal reserved before the access decision: "path: status" 400 ≠ 404), R9 (the membership read without FOR SHARE:
  no revocation waits), R15 (the source read without FOR SHARE: no expiry waits), R21 (the KA020 trigger on plans removed:
  the raw supersession commits), R23 (no send guard: the refused view is sent), R34 (no address hash: the twenty-first
  identity is admitted), R24 (the upstream guard removed: an unresolved upstream is admitted), I-REV-2 (a probe without its
  declared replies: the route refuses to register) — every one fails without the fix and passes restored.
- I-REV-4 and I-REV-5 were written test-first: without the listener the new pool test fails with the unhandled 57P01
  "terminating connection due to administrator command"; without the policies the forged approval commits ("Missing expected
  rejection") and, with the insert policy alone, so does the withdrawal under another member's membership.

### 12d.4 What stays open (none of it a finding of this review)

- S089 and S093 are PARTIAL in the case map: S089's funded-grant half belongs to B03 (S041, IC-12) and B08 (R2-044, CMD036),
  S093's metadata command to B17 (CMD018); S090 is demonstrated at the `LeaseStore` boundary because no catalogue command
  performs a resume (open question Q5).
- The production callers of the evidence recorders (D-EVID-1) are the Identity Platform verifier (B15) and CMD024 with the B08
  orchestration; in B06 the harness is their only caller. The commercial-consequence guard of D-PLAN-4 is vacuous until B08/B09
  bind the real inspector. The later writers of the share-locked rows must follow the lock order of §5.
- No response check runs inside `runCommand` before `journal.commit`: a COMPLETED reply its contract refuses is committed and
  answered 422 (a retry replays the refusal; nothing re-executes). A pre-commit check would roll such an effect back; it is
  optional hardening (fixer D's record), not required by R23. `FORBIDDEN_RESPONSE_FIELDS` matches names: registry
  `Finding.subjectHash` will need a reviewed exception when a Finding view is added.
- The one-shot migrate-only entry point (R44's stronger alternative) is not built; the delivered guarantee is that a serving
  process keeps no owner credential after start and one that does not migrate never receives it.
- An unauthenticated but structurally valid command now costs one insert (its anonymous fact, R26); the admission limiter is not
  applied to anonymous requests. How a rate-limited unauthenticated request is recorded is a decision for the abuse controls of
  08 and the operations package.
- The identity sync of CMD001 still writes `identities.email_verified_at` / `mfa_enrolled_at` as `kauro_app` from the token's
  facts; the authorizer never reads them (verification is the token's, D-ASSUR-2), so the write grants nothing. Whether those
  columns move to the verifier's role is a question for B15. The plan's `revision_hash` / `target_contract_hash` equal the
  body's members because the adapter derives them; no CHECK ties them (Q9).
- The architecture gate does not see an in-package relative import into `src/testing`; `package-surface.test.ts` covers
  `@kauro/persistence`. `node --test --test-name-pattern` over a file with no matching test starts its cluster and does not
  exit (tooling observation of fixer F; `pnpm run verify` runs every test and is unaffected).

## 13. Verification performed on `b06/integration`

After the independent review was integrated (§12d), `pnpm run verify` (generate, build, typecheck, test, architecture gate,
OpenAPI check, clean-consume) passes on Windows 11 (Node 24.14.1, PostgreSQL 17.6 from `C:\Tools\pgsql17\bin`) and on Linux
(Ubuntu 24.04 under WSL as the unprivileged user `miguel`, a fresh clone of the branch, `pnpm install --frozen-lockfile`,
Node 24.21.0, pnpm 10.16.1, `PGBIN=/usr/lib/postgresql/17/bin`, PostgreSQL 17.11): 312 tests, 0 failures — contracts 12,
domain 53, application 55, authorization 11, persistence 83, api 86, tools 12 (before the review: 216). Every persistence and
api test file starts its own PostgreSQL 17 cluster (initdb/pg_ctl on a free 127.0.0.1 port, the seven migrations applied as
`kauro_owner`, one login role in each runtime group: `kauro_app`, `kauro_control`, `kauro_assurance`, `kauro_validator`);
nothing fakes the database. The architecture gate reports 6 packages, 13 edges and no violation; the OpenAPI check finds the
committed document to be the generated one and to match the nine registered routes (the seven commands and the two probes);
clean-consume installs the publishable packages from their tarballs alone and type-checks their ten typed entry points.

The persistence tests are the review of the SQL: application and idempotent re-application, drift refusal, the serialized and
bounded runner, role/RLS/ownership facts, enum CHECK lists equal to the registry, listed-transition and initial-state seeds
equal to the registry machines, event-type seed equal to the domain, fail-closed context, cross-tenant invisibility, composite
FK refusal, pool reuse after commit/rollback/exception, pool errors idle and in use, concurrent contexts, self policies,
duplicate labels, version discipline (KA002), event-per-version at commit (KA003), unlisted edges and birth states (KA008),
immutable columns (KA004), the integrity guards as the runtime role that would break them (event binding, control-plane
journal columns, approval bindings and the acting session, the ingress-only inbox, the owner counter's single writer, the
evidence producers, VALID receipts of the plan itself), the three streams of security facts, archive without deletion, S051
through the plan adapter, approval bindings and uniqueness, withdrawal once, outbox tenant policy and control delivery, S052
through the journal adapter and the concurrent duplicate, identity-owned CreateAgency reservations, S089 (structure and failed
upstream), S090 (subject, clock, cost and checkpoint identity), R2-043 deterministic last-owner race, the readiness ledger, the
published surface, and the `pg` adapters of every port. The api tests are the review of the commands: the OK/DENY/RACE triads
of the seven commands with every denial's durable fact, S051 and S052 at the command level, the HTTP half of S093, R2-058,
R2-059, the pipeline order and its authorization, the share-locked preconditions under concurrent writers, the admission order
of manual 10, the correlation id, the transport's framing and client address, the response contract and sentinel
serialization, the opaque internal error, the route inventory, and the deployment path and its operation (`bootstrap` on a
real cluster over a socket: limits, drain, probes, outages, the migrator's secret). The revert proofs of the review were
re-run on the merged tree (§12d.3).
