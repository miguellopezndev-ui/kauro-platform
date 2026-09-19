# @kauro/domain

The domain layer of the Kauro platform (07 "Platform topology": contracts → domain ports → application → adapters).

- `model/ids` — UUIDv7 aggregate ids (`encodeUuidV7`, `createIdGenerator`), UUIDv5 identity references (`identityUserId`),
  branded id types.
- `model/roles` — command role → membership role table (`roleSatisfies`), capability sets per role.
- `model/state-machines` — listed-transition guards over the registry machines (`transition`, `statesOf`).
- `model/events` — registered event types, per-type payload allowlists, code-owned outbox subscriptions.
- `model/errors` — the failure taxonomy (`FailureCode`, `FailureReason`, `DomainFailure`).
- `model/tenant` — execution contexts (TENANT / IDENTITY / SYSTEM), actors, identity facts.
- `model/aggregates` — aggregate records (registry contracts plus concurrency and lineage columns).
- `model/idempotency` — idempotency identity and the command request digest.
- `ports/*` — clock, id generator, unit of work with tenant context, event publisher, command journal, repositories,
  lease store, request journal.

Design: `docs/design/B06-domain-db-authz.md`. Depends on `@kauro/contracts` only.
