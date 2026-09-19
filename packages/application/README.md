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

Handlers, the authorizer implementation and the HTTP adapter belong to the B06 implementation mandate; see
`docs/design/B06-domain-db-authz.md` §8 and `docs/design/B06-case-map.md`. Depends on `@kauro/contracts` and `@kauro/domain`.
