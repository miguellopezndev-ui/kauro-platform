# @kauro/application

The application layer of the Kauro platform: the contracts of the public commands and the ports orchestration depends on.

- `commands/contracts` — the seven B06 commands (CMD001 CreateAgency, CMD009 CreateClient, CMD010 ArchiveClient,
  CMD011 CreateProject, CMD023 RevisePlan, CMD025 ApprovePlan, CMD026 WithdrawApproval): body, result view, `CommandSpec`.
- `api/envelope` — request envelope (headers, limits, `CommandEnvelope`), command results.
- `api/problems` — the safe problem contract: stable codes, HTTP statuses, next actions, `problemOf`.
- `api/request-schemas` — closed JSON Schema 2020-12 request bodies (exactly the registry fields).
- `api/views` — safe DTO views (AgencyView, MembershipView, EndClientView, ProjectView, PlanView, ApprovalView — which carries
  `actorId`, so a consumer recomputes the approval hash from the DTO).
- `api/response-schemas` — the closed JSON Schema 2020-12 wire contract of every view, derived from the registry contract
  bundle where a contract exists (every registry member selected or withheld with a reason, required stays required, narrowing
  only adds keywords), the COMPLETED envelope of each served command, the ACCEPTED envelope, the operational routes
  (`OPERATIONAL_ROUTES`: the liveness and readiness probes `getLiveness` and `getReadiness`, with `LIVENESS_RESPONSE_SCHEMA`
  and `READINESS_RESPONSE_SCHEMA`) and the member names no response may declare (`FORBIDDEN_RESPONSE_FIELDS`).
- `api/response-contract` — what each route may answer (`commandRouteResponses`, `operationalRouteResponses`) and
  `checkReply`, the check every reply passes before it is sent (a refusal is a `ResponseContractViolation`, answered
  INTEGRITY_FAILURE by the transport).
- `ports/*` — authorizer (`authorize`: access; `assure`: the step-up of a new execution), assurance verifier, abuse limiter
  (identity and client address hash), schema validator (closed over known schema ids), plan services (artifact resolver, patch
  compiler, disclosure composer), work inspectors (active work, completed external actions, unreconciled commercial
  consequences of an approved plan), command handler/bus.
- `commands/runtime` — `runCommand`: one unit of work per command (access authorization with the membership share-locked →
  journal reserve, whose replay / conflict / pending answers go only to the caller just authorized → step-up assurance of a
  new execution → locked preconditions → state + events → journal commit, whose stored record is the answer: D-PORT-2),
  DomainFailure → CONFLICT / REJECTED / UNAVAILABLE, and the durable security fact of every authorization denial (recorded in
  its own transaction after the rollback, in the agency's stream only for a proven live member, otherwise in the caller's
  identity stream); `refuseUnauthenticated`: the anonymous fact of a command without an authenticated subject. Review record
  `docs/design/B06-review/A-pipeline-authorization.md`.
- `commands/handlers/*` — the seven handlers (`createB06Handlers(runtime, collaborators)`), each following design §8 step by step.
- `api/admission` — the transport-neutral admission pipeline of manual 10 (a repeated single-valued envelope header, content
  type, size, strict UTF-8 and strict JSON, closed schema, headers, path ids, agency selector) producing the `CommandEnvelope`;
  `admitHeaders` is its header-only head (a repeated envelope header, then the content type) that a transport runs before it
  reads the body (I-INT-5). The correlation id and the client address hash are the transport's: a client correlation id is
  adopted when it is an `id` and otherwise replaced by a minted one, never refused (E-CORR-1, review R28); the address reaches
  the envelope only as a keyed hash of its network (E-ADDR-1).
- `api/strict-json`, `api/json-schema`, `api/schema-validation` — the RFC 8259 parser with duplicate-key/depth/length bounds
  and the dependency-free JSON Schema 2020-12 validator over the closed keyword vocabulary of the contract bundle (unknown
  keywords, foreign `$ref`s and unasserted formats are refused at compile time; `date-time` is a real Gregorian instant).
- `api/projections` — record → view projections and `readinessBlockersOf`.
- `testing/in-memory-ports` — the in-memory implementation of the domain ports for pure orchestration tests only.

The labelled contract fakes of three provider ports of the source lifecycle (B07 mandate B07-PROVIDER-FAKES; design
`docs/design/B07-upload-source-lifecycle.md` §2, §15, D-FAKE-1) are the separate, TEST-ONLY export subpath
`@kauro/application/testing` (`src/testing/index.ts`; architecture rule `testOnlySubpaths`: importable only from a `test/`
directory, so no composition root can bind one). Each reports `evidenceClass: "SIMULATED"` and a `contract-fake-*` provider token
and is never counted as real integration (B15 binds the real adapters):

- `ContractFakeObjectStorage` (`contract-fake-storage`) — `ObjectStoragePort`: generations with no-overwrite preconditions,
  resumable sessions usable until a configurable provider horizon (the application deadline is unknown to the provider),
  cancellation answering CONFIRMED, UNSUPPORTED or UNCERTAIN as scripted, stat, exact-generation read and copy, delete by
  generation, soft delete with a configurable retention read-back, listings, a call log without bearer references, hold points
  and scripted faults; the browser side of a session (`writeThroughSession`) and `completionRefOf` for forged claims (S053).
- `ContractFakeSessionVault` (`contract-fake-vault`) — `SessionVaultPort`: AES-256-GCM under a labelled test key, the binding
  (agency, upload, requester, attempt) as associated data.
- `ContractFakeAuthorityJournal` (`contract-fake-journal`) — `AuthorityJournalPort`: an append-only file outside the database,
  idempotent by event id, the port's tombstone contract checked, listed per agency in sequence order.

The malware scanner's fake is `@kauro/data-plane/testing` (B07-DATA-PLANE). Tests: `test/source-provider-fakes.test.ts`.

The authorizer implementation is `@kauro/authorization`; the HTTP adapter is `apps/api`; the PostgreSQL adapters of the ports
are `@kauro/persistence`; the B06 case tests against real PostgreSQL live in `apps/api/test` and `packages/persistence/test`
(`docs/design/B06-case-map.md`). Depends on `@kauro/contracts` and `@kauro/domain`.
