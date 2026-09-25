# @kauro/application

The application layer of the Kauro platform: the contracts of the public commands and the ports orchestration depends on.

- `commands/contracts` — the seven B06 commands (CMD001 CreateAgency, CMD009 CreateClient, CMD010 ArchiveClient,
  CMD011 CreateProject, CMD023 RevisePlan, CMD025 ApprovePlan, CMD026 WithdrawApproval): body, result view, `CommandSpec`.
- `api/envelope` — request envelope (headers, limits, `CommandEnvelope`), command results.
- `api/problems` — the safe problem contract: stable codes, HTTP statuses, next actions, `problemOf`.
- `api/request-schemas` — closed JSON Schema 2020-12 request bodies (exactly the registry fields).
- `api/views` — safe DTO views (AgencyView, MembershipView, EndClientView, ProjectView, PlanView, ApprovalView).
- `ports/*` — authorizer, assurance verifier, abuse limiter, schema validator (closed over known schema ids), plan services
  (artifact resolver, patch compiler, disclosure composer), work inspectors, command handler/bus.
- `commands/runtime` — `runCommand`: one unit of work per command (access authorization with the membership share-locked →
  journal reserve, whose replay / conflict / pending answers go only to the caller just authorized → step-up assurance of a
  new execution → locked preconditions → state + events → journal commit, whose stored record is the answer: D-PORT-2),
  DomainFailure → CONFLICT / REJECTED / UNAVAILABLE, and the durable security fact of every authorization denial (recorded in
  its own transaction after the rollback, in the agency's stream only for a proven live member, otherwise in the caller's
  identity stream); `refuseUnauthenticated`: the anonymous fact of a command without an authenticated subject. Review record
  `docs/design/B06-review/A-pipeline-authorization.md`.
- `commands/handlers/*` — the seven handlers (`createB06Handlers(runtime, collaborators)`), each following design §8 step by step.
- `api/admission` — the transport-neutral admission pipeline of manual 10 (correlation id, content type, size, strict JSON,
  closed schema, headers, path ids, agency selector) producing the `CommandEnvelope`; `admitHeaders` is its header-only head
  (correlation id, content type) that a transport runs before it reads the body (I-INT-5). A client correlation id must be an
  `id` (I-INT-4).
- `api/strict-json`, `api/json-schema`, `api/schema-validation` — the RFC 8259 parser with duplicate-key/depth/length bounds
  and the dependency-free JSON Schema 2020-12 validator over the closed keyword vocabulary of the contract bundle (unknown
  keywords, foreign `$ref`s and unasserted formats are refused at compile time; `date-time` is a real Gregorian instant).
- `api/projections` — record → view projections and `readinessBlockersOf`.
- `testing/in-memory-ports` — the in-memory implementation of the domain ports for pure orchestration tests only.

The authorizer implementation is `@kauro/authorization`; the HTTP adapter is `apps/api`; the PostgreSQL adapters of the ports
and the B06 case tests against real PostgreSQL are the integration mandate (`docs/design/B06-case-map.md`). Depends on
`@kauro/contracts` and `@kauro/domain`.
