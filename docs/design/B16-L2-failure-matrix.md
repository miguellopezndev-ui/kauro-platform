# B16 lane L2 failure-mode matrix (CMD060 RequestRetentionExtension)

Source rows: `.kauro/mandates/B16-REST-PLAN.md` section 2 "CMD060 RequestRetentionExtension (L2)" and section 5 conflict C1. Template and
columns: `docs/design/FAILURE-MATRIX-TEMPLATE.md`. Tests were written first (base 425be8d8: no route, no extension table, no grant): every
cell below names its test as `file :: "exact title"`; a cell moves from **GAP (red)** to **C** in the builder's commit, with the
red-proof (`node tools/builder/red-proof.mjs <base> <head> --tests <file>`) named in the commit message.

Test file: `E` = `apps/api/test/cmd060-request-retention-extension.test.ts`.

## Contract the tests bind (decided here, from the plan; the builder implements it)

- Route: `POST /api/v1/projects/{projectId}/retention-extensions`, role AGENCY_OWNER_OR_ADMIN, idempotency REQUIRED, answer **200**
  `COMPLETED`. Body `{ expectedVersion, requestedSeconds, purpose, termsVersion }`; `expectedVersion` = the governing PAID_ORDINARY /
  PAID_STAGED record's version; `requestedSeconds` 1..259200 (schema bound: more is `400 INVALID_REQUEST SCHEMA_VIOLATION`).
- View `data`: `extensionId, projectId, retentionId, retentionVersion, requestedSeconds, grantedSeconds, previousSoftDeadline,
  softDeadline, hardDeadline, effectiveDeadline, cappedAtHardDeadline` (the exact capped endpoint is disclosed).
- Granted end = `least(soft + requested, hard)` (C1); the hard deadline never moves; `retention_records.version` + 1.
- DB: one COMMIT = record soft/effective + one `kauro.retention_extensions` row (columns used by tests: `agency_id, project_id,
  retention_id`; unique `(agency_id, project_id)`) + `retention_record.extended.v1` (aggregate version = new record version, outbox
  consumer AUTHORITY_JOURNAL; `AUTHORITY_TOMBSTONES` kind `RETENTION_EXTENDED`) + command journal entry CMD060 COMMITTED 200.
- Refusals (`409 PRECONDITION_FAILED <reason>` unless named): `EXTENSION_ALREADY_USED` (checked before room), `NO_SOFT_DEADLINE`,
  `SOFT_DEADLINE_PASSED` (judged at `kauro.effect_now()` after the record lock), `RETENTION_EXPIRED` (record re-read after the lock),
  `NO_EXTENSION_ROOM` (granted end <= soft; not consumed), `NO_EXTENDABLE_RECORD` (UNPAID only: C1), `409 STALE_VERSION -`,
  `403 NOT_AUTHORIZED ROLE_INSUFFICIENT`, `404 NOT_FOUND -` (foreign), `403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED`.
- DB guard (rule 12): `kauro.retention_records_soft_deadline()` gets a second named path; a request session moving `soft_deadline`
  without its extension row raises **KA085** (B16_L2_RETENTION_A; KA086 = B16_L2_RETENTION_B reserved, PR #97).

## Cells

| Cell | Status | Proof |
|---|---|---|
| OK (+ GAP-RET-9 consumers RETENTION, GetRevision) | GAP (red) | E :: "CMD060-OK: one extension of a PAID_ORDINARY soft deadline by <=259200 s inside the hard cap: exact endpoint returned, hard_deadline unchanged, retention_record.extended.v1 and the journal entry written, RETENTION and GetRevision read the new effective deadline" |
| R2-123 | GAP (red) | E :: "R2-123: 72 h requested 24 h before the hard cap grants exactly the hard cap, discloses it and consumes the one extension" |
| R2-124 | GAP (red) | E :: "R2-124: a second extension and one after expiry are refused; no clock, access or tombstone changes" |
| RACE GAP-RET-1 | GAP (red) | E :: "CMD060-RACE: an extension held at the record lock against RETENTION expiry, both orders — first the sweeper's CAS misses and nothing expires, then the extension refuses RETENTION_EXPIRED; two extensions of one project: one 200, one 409 EXTENSION_ALREADY_USED or STALE_VERSION" |
| RACE D vs A, DENY GAP-RET-2 | GAP (red) | E :: "CMD060-DENY: a VIEWER or BILLING member, another agency, more than 259200 s, a stale version, an UNPAID-only project and no room before the hard cap are refused with nothing written; before the first package there is no soft deadline: NO_SOFT_DEADLINE, and a publication in flight makes the extension wait and answer STALE_VERSION" |
| TIMEOUT | N/A here (C runtime) | lock/statement timeout -> retryable CAPACITY_UNAVAILABLE, no change: `packages/persistence/test/adapters-unit-of-work.test.ts` "statement_timeout is transaction-local ..." |
| EXPIRY GAP-RET-3 | GAP (red) | E :: "RACE (expiry): the extension's lock wait crosses the existing soft deadline — judged at effect_now after the record lock, refused SOFT_DEADLINE_PASSED, nothing written" |
| CRASH-BEFORE GAP-RET-4 | GAP (red) | E :: "RACE (crash before COMMIT): a crash after the journal row and the writes leaves the record unchanged and no extension; the same key then extends once" |
| CRASH-AFTER GAP-RET-5 | GAP (red) | E :: "RACE (crash after COMMIT): the lost answer is recovered by the key; the extension is not consumed twice" |
| RETRY GAP-RET-6 | GAP (red) | E :: "RETRY: an identical replay answers 200 byte for byte and writes nothing; the same key with another requestedSeconds is 409 IDEMPOTENCY_CONFLICT" |
| REVOCATION GAP-RET-7 | GAP (red) | E :: "REVOCATION: a membership suspended before the extension is refused 403 MEMBERSHIP_SUSPENDED; one suspended in flight makes the extension wait on the authorizer and then refuses it, the record unchanged" |
| PARTIAL GAP-RET-8 | GAP (red) | E :: "PARTIAL: a fault at the extension's event, after the record and extension writes, rolls back soft_deadline, the extension row, the event and the journal entry; the same key then extends once" |
| Consumer AUTHORITY_JOURNAL GAP-RET-10 | GAP (red), request half | E :: "consumer: the extension's event is routed once to AUTHORITY_JOURNAL as a RETENTION_EXTENDED tombstone and a replay routes nothing more" — the control half (AuthorityJournal appends once, redelivery ALREADY_PRESENT, subject read for `retention_record`) needs an `apps/control/test/authority-journal.test.ts` test once the writer exists (no cross-entrypoint seam on the base) |
| Consumer CMD038 window | L5 | — |
| DENY (forged) GAP-RET-11 | GAP (red) | E :: "DENY (forged): a request session moving soft_deadline without an extension row is refused KA085" |

Notes. GAP-RET-8 faults the event INSERT (third write, after the record UPDATE and the extension INSERT), so both earlier writes must
roll back; the plan's "INSERT extension" fault point is the same footprint. GAP-RET-3 places the API transaction's TEST CLOCK 1.5 s
before the soft deadline and holds the record lock until the waiting transaction has run > 2.5 s: `server_now()` (transaction start)
is before the deadline, `effect_now()` after the lock is past it. The D-vs-A order "extension first" is a refusal (no lock outlives it):
the publication then sets the soft deadline unchanged.
