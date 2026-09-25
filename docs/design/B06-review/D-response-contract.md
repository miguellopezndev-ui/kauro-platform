# B06 review — fixer d (response contract): R23, R29

Branch `b06/fix-d` from `b06/integration` at `e435a9a`. Findings of `.claude/b06-review/group-d.json`. The integrator folds this
record into `docs/design/B06-domain-db-authz.md` (§7, §12c) and `docs/design/B06-case-map.md`; neither file is edited here.

| id | outcome | one line |
|---|---|---|
| R23 | FIXED | Closed 2020-12 response schemas derived from the registry, every reply checked against its route's declared contract before it is sent (INTEGRITY_FAILURE otherwise), an OpenAPI 3.1 document generated from the registry and checked against the registered routes in `verify`, and a sentinel-serialization test over the seven routes. |
| R29 | FIXED | ApprovalView carries `actorId`; a consumer recomputes `approvalHash` from the DTO alone. |

## R23 — no response DTO schemas, OpenAPI or runtime DTO validation

**Outcome: FIXED.**

**Authority read.** 10 "Version and validation": "Wire contracts use JSON Schema 2020-12 with closed objects"; "Fastify's
request validation and response serialization must use compatible schema semantics. A serializer assuming another schema
draft cannot silently ignore 2020-12 keywords"; "OpenAPI is generated from the owning contract registry and checked against
actual routes. The build fails on undocumented public routes, missing operation IDs, incompatible response schemas or a DTO
that exposes a forbidden field. TypeScript types alone are insufficient runtime validation". 10 "Responses and safe errors":
"Synchronous success returns a validated DTO and version"; problems "exclude stack traces, SQL, bucket names, session URIs,
raw cell values, internal secrets and foreign-resource existence". 10 "Agency and team routes": no "authentication provider
tokens, recovery settings or another member's private security evidence". 10 "Contract tests and compatibility": "The release
includes an API compatibility report, route/schema inventory ...". reference/FIELD_CONTRACTS.md "Common rules": "Unknown
fields reject the object ... Internal records are not automatically safe browser DTOs. Responses must select only authorized
fields and test serialization against sentinel data". 07 "Command outcomes and error taxonomy": "An unexpected exception is
recorded with an opaque correlation ID and safe technical classification"; integrity failure is a distinct outcome, and
"Retrying a nonretryable integrity failure is prohibited until the subject or implementation changes". 08 "Security
acceptance": "zero raw sentinel egress and zero secret leakage".

**Decision.**

1. *Response schemas* (`packages/application/src/api/response-schemas.ts`). One closed definition per view — AgencyView,
   MembershipView, EndClientView, RevisionSummary, ProjectView, PlanView, ApprovalView, ActiveWorkSummary,
   CompletedExternalAction, SupersededPlanSummary, PlanImpactMap (the RevisePlan impact map) and the per-command views
   CreateAgencyView, ArchiveClientView, RevisePlanView, ApprovePlanView, WithdrawApprovalView; the readiness blockers are the
   `READINESS_BLOCKERS` enum. The COMPLETED envelope of each served command (`urn:kauro:api:v1:response:CMDnnn`: `kind`,
   `version`, `replayed`, `data` → its view), the ACCEPTED envelope (`urn:kauro:api:v1:response:accepted`: `operationId`,
   `state`, `statusPath`, `pollAfterSeconds`; no B06 route declares it) and the existing closed Problem schema.
   *Derived from the registry where a contract exists*: a view that projects a registry contract (Agency, Membership,
   EndClient, DatasetRevision, Plan, Approval; ProjectView.capabilityVersion from Capability.version) takes each selected
   member's schema from the generated bundle `@kauro/contracts/schemas.json` at start-up (type, enum, bounds, pattern, format
   and the registry description). The build (`buildResponseSchemas`) refuses, as INTEGRITY_FAILURE: a registry member the view
   neither selects nor lists as withheld with its reason; a registry-required member the view leaves optional; a narrowing
   that overrides a registry keyword (only absent keywords may be added — ids gain the UUID pattern because the server mints
   UUIDv7/UUIDv5, D-ID-1/D-ID-2); a platform member that redeclares a registry member; a view name colliding with a registry
   definition; any object schema that is not closed; any member named in `FORBIDDEN_RESPONSE_FIELDS`. Withheld with reasons:
   Agency.legalProfileRef ("Private reviewed customer billing profile") and firstQualifyingCaptureId; the plan body
   (mappings, identities, transforms, relationships — possibly L3/L4, FIELD_CONTRACTS "Common rules"); DatasetRevision scope,
   files, manifest/projection hashes, sealedAt, lineage. Members without a registry contract are platform fields in the field
   vocabulary of FIELD_CONTRACTS "Common rules" (ProjectView — open question Q4; EndClientView.version — D-AGG-2/Q3;
   ApprovalView.approvalHash, planId, version, actorMembershipId, withdrawnByMembershipId; withdrawReasonCode typed as the
   registry CMD026 field type `label`, which admits both the current uppercase token and a label — compatible with whatever
   R17/R27 decide).
2. *One closed validator* (`api/schema-validation.ts`): `createSchemaValidator(bundle, operational?)` compiles the registry
   contracts, the request schemas, the response schemas (the views as definitions beside the registry's) and the Problem
   schema with the existing dependency-free strict compiler — the same one that admits requests. `KnownSchemaId` gains the
   response ids; nothing is compiled from a runtime value (S093 unchanged in substance; the closed-set tests list the response
   ids).
3. *Route contracts and the check* (`api/response-contract.ts`). `RouteResponses` = the declared replies by status (a command
   route: its COMPLETED status 200/201 with its envelope, `application/json`) plus the Problem document
   (`application/problem+json`) for every other status ≥ 400. `checkReply` refuses an undeclared status, another content type,
   a body the closed schema refuses (paths and codes, never values) and a Problem whose `status` differs from the HTTP status,
   throwing `ResponseContractViolation`. `responseIntegrityProblem` is the replacement: `422 INTEGRITY_FAILURE`, reason
   `RESPONSE_CONTRACT_VIOLATION` (new failure reason), nonretryable, CONTACT_SUPPORT, correlation id only.
4. *The send guard* (`apps/api/src/server.ts`). Every route must declare `config.responses`; a route that declares none refuses
   to register (onRoute) with a message naming the fix, so no route can exist undocumented and unchecked. A `preSerialization`
   hook checks every object reply — route handlers, the `onRequest` admission hook, the not-found handler and the error
   handler alike (verified on Fastify 5.12.5) — and an `onSend` hook refuses any body that never reached the check (a string,
   buffer or stream sent directly). A check that cannot run (a declared schema the validator does not know) refuses too. A
   refused reply is never sent: the violation goes to the internal-error sink under the reply's correlation id and the client
   receives the INTEGRITY_FAILURE problem (itself checked). The response schemas are deliberately *not* handed to Fastify's
   serializer: fast-json-stringify has draft-07 semantics and silently drops what a closed 2020-12 schema would refuse (10
   "Version and validation"); the reply is validated as is and serialized by `JSON.stringify`. `routeInventoryOf(app)` exposes
   the registered routes with their declarations.
5. *OpenAPI* (`tools/openapi.mjs`, document `apps/api/openapi.json`, root scripts `openapi` and `openapi:generate`, `verify`
   runs `pnpm run openapi` after the architecture gate). Generated, never hand-written: operations from the
   provenance-verified registry `commands.json` (path, method, `operationId` = registry `name`, role, idempotency, gate, cases,
   precondition/effect/failure; the application spec must equal the registry's method/path/name or generation fails), request
   bodies from `REQUEST_SCHEMAS`, responses from the very schema objects the validator compiles (`$id`/`$schema` stripped,
   `#/$defs/X` → `#/components/schemas/X`, `x-kauro-schema-id` naming the validator id), header parameters from the admission
   constants (`IDEMPOTENCY_KEY`, the correlation-id pattern, the agency selector), bearer security, and the registry file
   digests in `info`. Generation refuses the pre-A2 brand in the output. `check` fails, listing every failure, when the committed
   document is not the generated one (byte for byte), an operation lacks an operationId or two share one, a registered route is
   undocumented, a documented route is not registered, a registered route declares no response contract, a route's declared
   statuses/content types/schemas differ from the documented ones (compared component by component, transitively, against the
   runtime schema the route validates with), or any response schema reachable from an operation declares a forbidden member.
   The registered routes are those of the api the composition root builds (`assembleApi` over the real pg unit-of-work
   adapter); route registration needs no database — the pool is created lazily, never connected, and the check asserts it
   opened no connection (nothing simulates PostgreSQL).
6. *Operational (non-registry) routes.* `OPERATIONAL_ROUTES` (empty in this branch) is the explicit list the validator, the
   generator and the checker accept: `{ operationId, method, path, summary, authority, responses: { status: { description,
   contentType, schema } } }`; each declared reply is compiled as `urn:kauro:api:v1:response:op:<operationId>:<status>` (closed,
   forbidden-member-free), documented, and the route registers `config.responses = operationalRouteResponses(operationId)`.
   Liveness/readiness (fixer e, `apps/api/src/health.ts`) are not implemented here.

**Consequence recorded.** The check runs at the send boundary, after COMMIT. A COMPLETED reply its contract refuses is a
committed effect answered `422 INTEGRITY_FAILURE`; the journal holds that answer and a retry with the same key replays it
through the same check — refused again, never re-executed (test below). This is 10 "An unexpected 500 does not automatically
mean a command did not commit" and 07 "Retrying a nonretryable integrity failure is prohibited until the subject or
implementation changes". A second check inside `runCommand` before `journal.commit` would roll such an effect back instead;
it is not added here because `runCommand` is being restructured in parallel (R7/R12, fixer a) — a candidate hardening for the
integrator, not required by R23. The forbidden list is name-based: registry `Finding.subjectHash` ("Exact tested bundle", a
gate-evidence member of a later package) collides by name with the identity-provider `subjectHash` and would need a reviewed
exception when a Finding view is added.

**Regression tests.**

- `apps/api/test/response-contract.test.ts` :: "R23: a success reply its route's contract refuses is never sent — a member a collaborator adds to the ArchiveClient view is answered 422 INTEGRITY_FAILURE under the correlation id, and the sink receives the violation (path and code, never the value)"
- `apps/api/test/response-contract.test.ts` :: "R23: a problem its contract refuses is never sent — a collaborator failure carrying a raw value beside its field error and a reason outside the vocabulary answers 422 INTEGRITY_FAILURE; the withdrawal rolled back"
- `apps/api/test/response-contract.test.ts` :: "R23: every served route declares its replies (the route inventory the OpenAPI checker reads); a route that declares none refuses to register; a reply whose declared schema the validator never compiled, or whose body is sent as text instead of a checked object, is refused like any other violation"
- `apps/api/test/sentinel-serialization.test.ts` :: "CMD001 CreateAgency: ...", "CMD009 CreateClient: ...", "CMD010 ArchiveClient: ...", "CMD011 CreateProject: ...", "CMD023 RevisePlan: ...", "CMD025 ApprovePlan and CMD026 WithdrawApproval: ..." and "no sentinel, secret, internal column value or diagnostic text of any tenant appears in any reply the seven routes sent" — 28 replies (each route: success, closed-schema refusal carrying sentinel values under `password`/`tokenHash`/`sql`, a domain refusal, an unexpected exception whose message is SQL text), sent by people whose provider subjects and bearer tokens are sentinels; the oracle reads across every tenant the provider subject hashes, invitation token hashes, step-up proof ids, processing-authority/receipt/target-contract evidence, revision projection hashes, plan-body internals (including a sentinel reason inside a revised body), journal entry ids and request digests, event ids and payload hashes, and asserts none — nor a bearer token, a sentinel or diagnostic text (SQL, class names, stack frames, constraint names) — appears in any status, header or body.
- `packages/application/test/response-schemas.test.ts` :: "R23: every view member taken from the registry is the registry member, ...", "R23: the build refuses a registry member a view neither selects nor withholds, ...", "R23: every response schema is closed and none declares a forbidden member; ...", "R23: the validator compiles the COMPLETED envelope of every served command, ...", "R23: checkReply refuses an undeclared status, ...", "R23 / R29: the COMPLETED reply of each of the seven handlers satisfies its response schema; ..."
- `tools/test/openapi.test.mjs` :: "the committed document is the generated one, byte for byte, and matches every registered route of the composed api", "an undocumented registered route fails the check", "a documented route that is not registered fails the check", "a missing or duplicate operationId fails the check", "a response schema that differs from the one the route validates its replies with fails the check", "a DTO that exposes a forbidden field fails the check", "generation refuses registry prose that carries the pre-A2 brand (amendment A2)", "a registered route without a declared response contract and a stale document fail the check"

**Evidence (fails without the fix).** With the guard call removed from `createApiServer`, the three R23 route tests fail:
`actual: 200, expected: 422` (the view with `tokenHash`/`sql` members was sent), `actual: 400, expected: 422` (the problem with
the raw value and invented reason was sent), `actual: 201, expected: 422` (the text body was sent). The sentinel oracle detects
a leak on its own: with the guard removed and the approval projection mutated to carry `assuranceProofRef`, the final test
fails with `CMD025 success: a value of "step-up proof ids" reached the wire`; with the guard in place the same mutation is
refused as `data/approval/assuranceProofRef UNKNOWN_FIELD`. The tool tests run each failure class as a negative control
against the real document and the real route inventory. Before this branch `git grep -i "openapi\|sentinel\|responseSchema"`
found no implementation (the finding's reproduction).

**Files changed.** `packages/application/src/api/response-schemas.ts` (new), `packages/application/src/api/response-contract.ts`
(new), `packages/application/src/api/schema-validation.ts`, `packages/application/src/ports/schema-validator.ts`,
`packages/application/src/index.ts`, `packages/application/src/api/views.ts` (doc comment), `packages/domain/src/model/errors.ts`
(reason `RESPONSE_CONTRACT_VIOLATION`), `apps/api/src/server.ts`, `apps/api/src/index.ts`, `apps/api/openapi.json` (generated),
`tools/openapi.mjs` (new), `tools/test/openapi.test.mjs` (new), `package.json` (scripts), tests
`packages/application/test/response-schemas.test.ts` (new), `apps/api/test/response-contract.test.ts` (new),
`apps/api/test/sentinel-serialization.test.ts` (new), the closed-set assertions of `packages/application/test/schema-boundary.test.ts`
and `apps/api/test/schema-boundary.test.ts`, READMEs (root, `apps/api`, `packages/application`).

## R29 — ApprovalView omits actorId

**Outcome: FIXED.**

**Authority read.** Registry contract Approval (`contracts.json`; reference/FIELD_CONTRACTS.md "Approval"): `actorId | id |
Yes | Authenticated actor with approval capability`. reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation": the
approval hash (KAURO_PLAN_APPROVAL_V1, the manual's approval domain under amendment A2) is over "approvalId, actorId,
agencyId, planHash, revisionHash, targetContractHash, validationReceiptHash, disclosuresHash and createdAt", excluding
"withdrawnAt and later revocation events"; "A valid SHA-256 shape is only structural evidence; the consumer recomputes the
relevant preimage". 10 "Agency and team routes" forbids tokens, recovery settings and private security evidence — the actor's
identity reference is none of these (MembershipView already carries `userId`, the same kind of value).

**Decision.** ApprovalView selects every member of the registry Approval contract: `actorId` is added to the view type, to the
projection (`approvals.actor_id`, the UUIDv5 identity reference the handler hashed) and to the response schema as a
registry-derived required member (narrowed to the UUID pattern). With R23's derivation rule, the Approval contract can no
longer lose a member silently: ApprovalView withholds nothing, and a registry member it neither selects nor withholds fails
the build. The step-up proof (`assurance_proof_ref`) and the actor's membership version stay off the wire (security evidence;
not in the preimage).

**Regression tests.**

- `apps/api/test/response-contract.test.ts` :: "R29: the approval the routes answer carries actorId, and a consumer recomputes approvalHash from the wire DTO alone — when approved and after withdrawal"
- `packages/application/test/response-schemas.test.ts` :: "R29: ApprovalView selects every member of the KAURO_PLAN_APPROVAL_V1 preimage as required, and actorId is the registry's Approval.actorId"
- `packages/application/test/response-schemas.test.ts` :: "R23 / R29: the COMPLETED reply of each of the seven handlers satisfies its response schema; the approval view recomputes its KAURO_PLAN_APPROVAL_V1 hash from its own members"
- `tools/test/openapi.test.mjs` :: "the committed document is the generated one, ..." (the documented ApprovalView requires every preimage member)

**Evidence (fails without the fix).** With `actorId` removed from the projection and from the view definition (the pre-fix
state, withholding it), the api test fails with `actorId is on the wire — actual: 'undefined', expected: 'string'`, the
application R29 test with `AssertionError: actorId`, and the handler test with a digest mismatch; restored, all pass.

**Files changed.** `packages/application/src/api/views.ts`, `packages/application/src/api/projections.ts`,
`packages/application/src/api/response-schemas.ts` (ApprovalView definition), `apps/api/test/cmd025-approve-plan.test.ts` (the
ApprovalView key list of CMD025-OK now includes `actorId`).

## For the integrator

- `apps/api/openapi.json` is generated. After merging a branch that changes a request schema, a route or a view (for example
  R17/R27 reasonCode, R32 approval request members), `pnpm run openapi` fails with "not the generated document"; run
  `pnpm run openapi:generate` and review the diff (10: an incompatible wire change increments the API version).
- Liveness/readiness of fixer e: add their entries to `OPERATIONAL_ROUTES` (`packages/application/src/api/response-schemas.ts`)
  with closed reply schemas, register the routes with `config: { responses: operationalRouteResponses("<operationId>") }`,
  then regenerate the document. Until then `createApiServer` refuses to register them (message names these steps).
- The Problem schema's `correlationId` stays `1..128` characters (not the UUID pattern), so R28's decision on client
  correlation ids needs no change here; the guard takes the correlation id the reply already carries.
- Fixer f (R24, R48) edits the S093 and CMD025 test files this branch touches: the closed-set assertion of
  `apps/api/test/schema-boundary.test.ts` gains the response ids, and the CMD025-OK key list gains `actorId`.
