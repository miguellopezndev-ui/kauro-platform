# @kauro/domain

The domain layer of the Kauro platform (07 "Platform topology": contracts → domain ports → application → adapters).
Pure TypeScript over `@kauro/contracts` only: no database, framework, payments or UI. Every aggregate operation takes the
records the handler read inside its unit of work and yields the next records plus the events of the new versions; the
persistence adapter writes them and the database re-checks every invariant (07 "Application checks improve messages but
cannot be the sole protection").

## Modules

- `model/ids` — UUIDv7 aggregate ids (`encodeUuidV7`, `createIdGenerator`), UUIDv5 identity references (`identityUserId`),
  branded id types.
- `model/fields` — the field vocabulary the aggregates enforce on their inputs (labels, reason codes, ids, instants;
  reference/FIELD_CONTRACTS "Common rules"); refusals name the field, never the value.
- `model/versioning` — optimistic concurrency (`assertExpectedVersion`, `nextVersion`; 10 "Concurrency and preconditions",
  D-VER-1).
- `model/errors` — the typed error contract: `FailureCode` (manual 10 codes + three platform codes), `FailureReason`,
  `FAILURE_HTTP_STATUS`, `FAILURE_TITLES`, `RETRYABLE_FAILURE_CODES`, the `DomainFailure` family and `describeFailure`
  (the wire-safe projection; 10 "Responses and safe errors"); the closed field-code vocabulary of `FieldError`, the typed-patch
  codes included (`TypedPatchFieldCode`, D-API-2).
- `model/roles` — command role → membership role table (`roleSatisfies`), capability sets per role (D-AUTHZ-1/2).
- `model/state-machines` — listed-transition guards over the registry machines plus the two platform machines the registry
  lacks (EndClient D-AGG-2, Project D-AGG-1) under the registry's unlisted-transition policy (`transition`, `statesOf`,
  `eventsOf`).
- `model/events` — registered event types (the DatasetRevision lifecycle included, D-INIT-1), per-type payload allowlists
  (never a label: the CMD026 reason stays off the payloads, D-API-1), code-owned outbox subscriptions, `AggregateEvent` (an
  event minus request provenance) and `withProvenance`.
- `model/tenant` — execution contexts (TENANT / IDENTITY / SYSTEM / ANONYMOUS — the last only records the denial of an
  unauthenticated command), actors and the security-fact actor, identity facts, `TenantScope` checks
  (`assertInScope`: foreign and nonexistent look alike).
- `model/identity` — Identity aggregate (`registerIdentity`, `syncIdentity`, `assertVerifiedIdentity`) and step-up assurance
  (`evaluateStepUp`, `assertFreshStepUp`; 08 "Authentication and assurance", D-ASSUR-1/2).
- `model/agency` — Agency aggregate: `createAgency` (CMD001) and one operation per registry edge (`activateAgency`,
  `restrictAgency`, `remedyRestriction`, `requestClosure`, `abandonSetup`, `completeClosure`), the open/active/closure
  predicates (D-CMD-2).
- `model/membership` — Membership aggregate: `createOwnerMembership` (CMD001), invitation lifecycle (`inviteMember`,
  `acceptInvitation`, `expireInvitation`, `revokeInvitation`; hashed single-use tokens), `suspendMembership`,
  `reactivateMembership`, `revokeMembership` (CMD006), `changeMembershipRole` (CMD005), `transferOwnership` (CMD007), the
  last-owner rule (`wouldLeaveNoActiveOwner`, `assertOwnershipPreserved`; 07, R2-043) and team authority.
- `model/end-client` — `createEndClient` (CMD009), `archiveEndClient` (CMD010), `assertClientActive`.
- `model/project` — `createProject` (CMD011): OPEN project with its DRAFT revision, capability snapshot, target rule (D-CMD-4).
- `model/authorization` — the pure authorization kernel `decideCommandAccess` (08 "Identity is not permission", design §6.1
  order, D-AUTHZ-1..4) the `@kauro/authorization` adapter runs inside the unit of work.
- `model/aggregates` — aggregate records (registry contracts plus concurrency and lineage columns, `InvitationRecord`).
- `model/idempotency` — idempotency identity and the command request digest.
- `ports/*` — clock, id generator, unit of work with tenant context, event publisher, command journal, repositories (the
  authorizer's membership read share-locked, D-PIPE-1; the preconditions a command relies on read under share locks, D-TX-1;
  the processing authority recorded by CMD009, D-CLIENT-1; no step-up proof written by the request handlers, D-EVID-1),
  lease store (the cost identity of a leased operation, S090) and request journal (a reservation declares its upstreams,
  S089).

## Decisions recorded by the implementation (beside the design register)

| id | decision | why (authority) |
|---|---|---|
| D-MEM-1 | Grantable subset of CMD003: an OWNER may invite any role; an ADMIN any role except OWNER. | CMD003 precondition "The requested role is within the inviter's grantable subset"; 08 "Granting a capability is itself an owner action". |
| D-MEM-2 | An ADMIN has no authority over an OWNER membership (suspend, revoke, revoke its invitation). | 08 "Default is deny", least privilege: otherwise team management by an ADMIN is an escalation path over the owner. |
| D-MEM-3 | Acceptance by an identity other than the intended one is NOT_FOUND without a reason; a wrong token by the intended identity is NOT_AUTHORIZED / INVITATION_TOKEN_MISMATCH; revoked, consumed and expired invitations are PRECONDITION_FAILED with the matching reason. | 08 "A forwarded or expired token cannot grant membership to a different person"; COMMAND_CATALOGUE "NOT_FOUND is used where revealing a foreign resource would leak existence". |
| D-MEM-4 | Ownership transfer (CMD007) is one outcome with three versioned records: successor → OWNER, current owner → ADMIN, agency version + 1 with `agency.ownership_transferred.v1`; the successor must be ACTIVE, verified and have a recorded acceptance; a co-owner successor is NO_SEMANTIC_CHANGE. | 08 "Agency ownership transfer requires an active verified successor, acceptance ... Concurrent transfers cannot leave zero owners or create an unintended owner"; CMD007 fields (expectedVersion on the agency path). |
| D-MEM-5 | Reactivation (SUSPENDED → ACTIVE) requires the member's identity to be verified now and the agency to be open; invitations require an open agency (DRAFT or ACTIVE). | Membership edge guard "Current role, identity, assurance and agency readiness are rechecked"; Agency CLOSING effect "revoke new access grants". |
| D-MEM-6 | A role change (CMD005) applies to ACTIVE or SUSPENDED memberships only; an INVITED membership is reissued instead; the same role is NO_SEMANTIC_CHANGE. | 08 "Changing the role after sending invalidates or reissues the invite"; reference/TRANSITIONS "Routine retry of the same state is an idempotent command result, not a new business transition". |
| D-AGY-1 | Activation compares the accepted agreement versions with the versions the launch policy requires (`required`); an older acceptance is PRECONDITION_FAILED / AGREEMENTS_INCOMPLETE. | Agency edge guard "required agreement versions are present"; CMD002 failure "Missing agreements ... leave the agency draft; no implicit signature". |
| D-ERR-4 | The HTTP status and title tables live in the domain (`FAILURE_HTTP_STATUS`, `FAILURE_TITLES`); `@kauro/application` `PROBLEM_STATUS`/`PROBLEM_TITLE` carry the same values and should be derived from them by the API implementer. | 07 "HTTP status follows the API contract; business state is not inferred solely from status code". |
| D-PRJ-1 | The capability version snapshotted on a project must be a safe token (it enters the event payload); a published version that is not one is INTEGRITY_FAILURE, never a request error. | 07 payloads carry references and safe tokens, never labels; CMD058 territory publishes capabilities. |

Design: `docs/design/B06-domain-db-authz.md`. Depends on `@kauro/contracts` only.
