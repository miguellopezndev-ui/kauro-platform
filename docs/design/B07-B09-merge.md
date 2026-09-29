# B07 + B09 merge record (`integration/b07-b09`)

Base `main` `ac44af6`. Merged `b07/integration` `075b7c3` (merge `36b5956`, B07 keeps `0009`–`0012`), then `b09/integration` `d34760a`
(merge `d6d07eb`, 35 conflicted files resolved as unions). Not pushed; not merged into `main` (the package-close reviews run first).
Checklist: `.claude/b07-b09-impl/impl_args.json` (B07 and B09 `integration_obligations`), B07 design §17, B09 design §15.

## Obligations

| # | obligation | result | proof: test file :: exact title | commit |
|---|---|---|---|---|
| 1 | migrations | B09's `0009`–`0013` → `0013`–`0017` by `git mv`; headers, code comments, B09 design §1–§13, `migrations.test.ts` list and `tools/matrix.mjs` database line updated; re-applied from empty in every suite | `packages/persistence/test/migrations.test.ts` :: "every migration applied once, in order, with its checksum recorded; a second run applies nothing" | `d6d07eb` |
| 2 | aggregate-kind registry | 18 kinds (B06 7, B07 3, B09 8); `AGGREGATE_KINDS` the union; inserters `kauro_app`, `kauro_control`, `kauro_payment`; both read policies; `TABLE_OF` every kind | `packages/persistence/test/aggregate-kinds.test.ts` :: "every registered kind binds to the table TABLE_OF names; each B06 and B07 aggregate of A was born and walked under the role that owns it with one bound event per version, and an event at or below its version passes the binding (only the one-event-per-version identity refuses a second; package B09's commerce kinds are walked by its own schema tests)" | `d6d07eb`, `3d414a1` |
| 3 | events | `EVENT_TYPES` 102, `CONSUMERS` 10, `EVENT_SUBSCRIPTIONS` 62, no duplicate; both migrations lift FORCE RLS in their own file | `packages/persistence/test/migrations.test.ts` :: "registered event types in the database are exactly the domain EVENT_TYPES" | `d6d07eb` |
| 4 | `dataset_revisions` + race | B09's column grant unchanged; retention expiry vs authorization issuance serialize on the revision's transition lock, both orders, waits seen in `pg_stat_activity` | `packages/persistence/test/b07-b09-race.test.ts` :: "B07+B09 RACE: a retention expiry and a commercial authorization issuance of one revision serialize on its transition lock in either order — expiry first, the issuance waits (pg_stat_activity) and is refused KP004 with nothing of its capture left; issuance first, the expiry waits and commits behind the authorization issued while the revision was SEALED" | `2374529` |
| 5 | SourceAvailabilityReader | B09 port bound in `apps/api/src/edition.ts` to B07 persistence (`PgCommercialSourceReads`); M2 fake removed | `apps/api/test/b07-b09-seams.test.ts` :: "B07+B09 seam, SourceAvailabilityReader (B07 §17 item 5, B09 §15 item 5, D-QUOTE-B7): the quoted source's availability is B07's retention record — its SEALED revision, seal instant and UNPAID deadlines with their evidence hash — for the request handlers and, in its adopted agency only, the payment service (migration 0018); once B07's retention sweeper expires the record and the revision, GetQuote shows SOURCE_EXPIRED and CreatePaymentOrder answers 422 SOURCE_EXPIRED writing nothing" | `2374529`, `1ac2fda` |
| 6 | lineage (Q-B07-17) | B09 `SourceLineageReader` bound to B07's `RevisionLineageReader.descendsFrom` (B06 columns only); re-binder always binds it; M2 fake removed | `apps/api/test/b07-b09-seams.test.ts` :: "B07+B09 seam, SourceLineageReader (B09 D-QUOTE-B6, B07 D-REV-1): the replacement's lineage is CMD012's — read by the payment service in its adopted agency under its own column grant: the replaced and replacement revisions, the replacement SEALED once the source lifecycle sealed it, with the evidence hash of the path; a revision sealed beside the paid one without lineage answers none"; `apps/api/test/b09-payment-service.test.ts` :: "D-QUOTE-B6: …" (CMD012 replacement, REBOUND, allowance spent) | `2374529`, `1ac2fda` |
| 7 | CommercialScopeInspector | B07 port bound to B09 `findLiveByRevisionHash` (manifest hash read in CMD012's unit of work); also in `apps/control/test/support/product.ts` | `apps/api/test/b07-b09-seams.test.ts` :: "B07+B09 seam, CommercialScopeInspector (B07 §17 item 7, B09 §15 item 6): CreateRevision over a revision a paid purchase rests on names its live CommercialAuthorization — in the reply's invalidated authority and in dataset_revision.superseded.v1 — read from B09's commercial authorizations in CMD012's own unit of work; a replaced revision nothing was bought on names none" | `2374529`, `1ac2fda` |
| 8 | SQLSTATE, reasons | KA070–KA072 + KP001–KP013, both label fields; `FAILURE_REASONS` 174, no duplicate | `packages/persistence/test/source-adapters.test.ts` :: "the refusal translation of design §3.3: the envelope, capacity, one-mutable and supersedes-once constraints, the deadline checks and KA070..KA072 become their typed failures" | `d6d07eb` |
| 9 | domain shared files | `PlatformMachineName`, `machine()`, `SystemContext` (B07 bound agency beside SERVICE/OPERATOR), ports index: unions | typecheck + domain suite | `d6d07eb` |
| 10 | harness, fixtures | both logins and the TEST CLOCK; one factory: `run` (commerce), `runSource`; B09 fixtures seal recently through B07's fixture, expire through `expireSealedRevision`, replace through CMD012 | the B09 persistence and api suites | `d6d07eb`, `2374529` |
| 11 | runtime boundary | three-way union of both packages' reviewed entries, equal to a cluster migrated with both; plus 0018 (column grant + policy, D-MERGE-3) | `packages/persistence/test/runtime-boundary.test.ts` :: "N11/B06 work: every runtime role's table and column privileges and every row-security policy equal the reviewed matrix" | `d6d07eb`, `2374529` |
| 12 | OpenAPI | one `x-kauro-planned` mechanism; 39 operations served, none planned | `tools/test/openapi.test.mjs` :: "the committed document is the generated one, byte for byte, and matches every registered route of the composed api" | `d6d07eb` |
| 13 | matrix | 28 machines (12 registry, B06 2, B07 4, B09 10), 20 commands | `tools/test/matrix.test.mjs` :: "the committed matrix is the generated one and every source check passes: every edge of the 12 registry, 2 B06 platform, 4 B07 source-lifecycle and 10 B09 platform machines is owned, every served command has its catalogue and its applicability row, every specified B07 command and route its catalogue" | `d6d07eb` |
| 14 | application index, registries | both exports; `ROUTE_OUTCOME_FRAGMENTS` over the outcome kit; `viewSchemaOf` over the view kit | `packages/application/test/json-schema.test.ts` :: "the validator compiles exactly the 73 contracts, the 13 request schemas and the selection manifest document, the 12 COMPLETED envelopes and ACCEPTED, the 3 declared replies of the operational routes, the 12 read replies, the intake reply, the 7 payment request schemas with their 7 command replies and 4 read replies (B09), and Problem, and nothing else" | `d6d07eb` |
| 15 | test-only subpaths | one `./testing` export (`src/testing/index.ts`) re-exporting B09's commerce fakes; no composition root binds a fake | `packages/application/test/commerce-fakes.test.ts` :: "D-FAKE-B1: no contract fake is reachable from production wiring — the package's entry point never reaches the test-only commerce/testing modules, which only the ./testing subpath exports, and no production source of the workspace imports @kauro/application/testing" | `3d414a1` |

## Decisions

- **D-MERGE-1** The commerce unit of work is a source unit of work (`PgCommerceUnitOfWork extends PgSourceUnitOfWork`): one routed
  factory serves `run`, `runSource` and the commerce contexts; the source lifecycle answers B09 in the caller's own transaction.
- **D-MERGE-2** B09's `SourceAvailabilityReader` / `SourceLineageReader` stay B09's collaborator ports (they take the caller's unit of
  work) and have one implementation, B07's persistence (`@kauro/persistence` `commercialSourceReadsOf`), bound in `edition.ts` with
  binding `PLATFORM`. Their M2 contract fakes are deleted (with the part of the fakes' own test that exercised them).
- **D-MERGE-3** Migration `0018`: `kauro_payment` reads `retention_records` (id, agency, revision, state, effective and hard deadline)
  of its adopted agency only. Needed because CMD028/CMD029 build their quote view in the payment service's SERVICE unit of work.
- **D-MERGE-4** Commercial fixtures seal one hour ago (`sealedRevision(..., { base })`, `world.revision(..., { recent: true })`): the
  default fifteen-day-old fixture seal leaves no retention to quote (`quotes_source_binding` refused every B09 quote at first run).

## Seams found by the tests (each fixed; the failing test passes after the fix)

| seam | failing test before the fix | fix | commit |
|---|---|---|---|
| B09 quotes over 15-day-old B07 seals | every B09 api test (`23514 quotes_source_binding`) | D-MERGE-4 | `2374529` |
| B09 fixtures walked revisions to SEALED/EXPIRED by SQL | `b09-critique`, `b09-migrations`, `b09-scenarios`, `cmd028` (lifecycle guard) | B07 fixture seal, sweeper expiry, CMD012 replacement | `d6d07eb`, `2374529` |
| payment service reads retention | `cmd028-create-payment-order.test.ts` :: "OK: an AGENCY_BILLING member creates one order …" (404 from 42501) | D-MERGE-3 | `2374529` |
| probes used kinds now registered | `aggregate-kinds.test.ts` :: "an unregistered kind is refused: …"; `source-migrations.test.ts` B07-F7 row | probe `job` | `3d414a1` |
| guarded tables 19 → 23 | `migrations.test.ts` :: "R20: …" | count | `3d414a1` |
| one `./testing` export | `commerce-fakes.test.ts` :: "D-FAKE-B1: …" | test follows the one index | `3d414a1` |

## Revert proofs (file changed in place, test fails; restored, SHA-256 equal, test passes)

| proof | change | failing assertion | restored SHA-256 |
|---|---|---|---|
| race | 0015: `await_transition('kauro.dataset_revisions', …)` removed | "the issuance waits for the expiry" | `0f5e4c47…` |
| scope binding | `edition.ts`: inspector answers `[]` | CommercialScopeInspector seam: deepEqual | `afcba9ba…` |
| 0018 | grant and policy replaced by `SELECT 1/2` | SourceAvailabilityReader seam; cmd028 OK | `13ee6f70…` |

## Case status changes

| case | before | after | test file :: exact title | commit |
|---|---|---|---|---|
| B07 CMD012-DENY | PARTIAL (B08, B09) | PARTIAL (B08 only), 4 EXECUTED_LOCAL | `apps/api/test/b07-b09-seams.test.ts` :: "B07+B09 seam, CommercialScopeInspector …" | this record's commit |
| B07 CMD012-OK | PARTIAL (B09/B10) | PARTIAL (B10 only), 7 EXECUTED_LOCAL | `apps/api/test/b07-b09-seams.test.ts` :: "B07+B09 seam, SourceLineageReader …"; `apps/api/test/b09-payment-service.test.ts` :: "D-QUOTE-B6: …" | this record's commit |
| B09 S060 | PARTIAL (B07, B10) | PARTIAL (B10); source half no longer SIMULATED | `apps/api/test/b09-scenarios.test.ts` :: "S060: …" | this record's commit |
| B09 CMD028-DENY | PARTIAL (B07, B08, B15) | PARTIAL (B08, B15) | `apps/api/test/cmd028-create-payment-order.test.ts` :: "DENY: …", "DENY (race): …" | this record's commit |

Totals unchanged: B07 23 cases 13 EXECUTED_LOCAL / 10 PARTIAL / 0 MISSING; B09 30 cases 7 / 23 / 0.

## Later (unchanged owners)

B08: EXECUTION_CONTROL on `dataset_revision.superseded.v1` / `.expired.v1`, the paid retention class (subscribe to
`capture.completed.v1`), DeliveryCapacityPort. B10: CMD027 quote issuance from `SourceAvailabilityReader`, R2-092 replacement quote.
B15: live providers. B16: DeletionReceipt.

## Verification

`pnpm install --frozen-lockfile` then `pnpm run verify` at `9b41162` (the lockfile is B07's; B09 changed none):

| host | result | tests (pass / skip) |
|---|---|---|
| Windows 11, Node 24.14.1, pnpm 10.16.1, `C:\Tools\pgsql17\bin` | VERIFY_EXIT 0 | contracts 12, domain 107, application 125, persistence 218, authorization 11, data-plane 12, control 15, api 200 + 1 skipped (B06's Linux-only test), tools 41; 0 failed |
| WSL Ubuntu 24.04, fresh clone, Node 24.21.0, `PGBIN=/usr/lib/postgresql/17/bin` | VERIFY_EXIT 0 | the same, api 201; 0 failed; clone removed, 0 postgres processes left |

Both: architecture gate 8 packages, 23 edges, no violation; OpenAPI 39 operations served, 0 planned; matrix 28 machines, 252
edges and initial states owned, 20 commands, 16 reads, 1 intake; clean-consume green. The Windows run began at `818ec51`; the
one later commit changes `packages/persistence/README.md` only. The next commit adds this section only.

## Review fixes merge

The package-close review (amendment A4) of `integration/b07-b09` @ `0f15636` rejected both packages. Its fixes were made on
`fix/b07-review` (`f7dbd91`, R1..R4, design §19 "Review findings") and `fix/b09-review` (`f2e800d`, R1..R5, design §17 "Review findings").
Both branches start at `0f15636`; they were merged into `integration/b07-b09` one after the other (`3c4e2d4`, `9edc844`) with no conflict.
Not pushed; not merged into `main`.

| check after the two merges | result |
|---|---|
| migrations | B07 added none; B09 adds `0019_unknown_refund_cases.sql` (a second open case per capture and provider reference); the list in `migrations.test.ts` carries it, 0001..0019 applied from empty |
| generated documents | `pnpm run matrix:generate` writes the file the auto-merge of both branches produced (no diff); `pnpm run openapi` matches 39 operations, the new `GENERATION_NOT_OBSERVED` reason included |
| case maps | separate files, no overlap: B07 12 EXECUTED_LOCAL / 11 PARTIAL / 0 MISSING (CMD012 rows of the first merge untouched); B09's rows as its branch left them |
| findings | B07-R1..R4, B09-R1..R5: every test fails on `0f15636` and passes here (each branch's own table names the test and its commit) |

Verification, `pnpm install --frozen-lockfile` then `pnpm run verify` (Windows at `9edc844`, Linux at `10f2091`, whose only difference is this record; the lockfile did not change):

| host | result | tests (pass / skip) |
|---|---|---|
| Windows 11, `C:\Tools\pgsql17\bin` | VERIFY_EXIT 0 | contracts 12, domain 107, application 126, persistence 218, authorization 11, data-plane 13, control 17, api 205 + 1 skipped (B06's Linux-only test), tools 41; 0 failed |
| WSL Ubuntu 24.04, fresh clone, `PGBIN=/usr/lib/postgresql/17/bin` | VERIFY_EXIT 0 | the same counts, api 206 and 0 skipped; 0 failed; clone removed, 0 postgres processes left |

Both: architecture gate 8 packages, 23 edges, no violation; OpenAPI 39 operations served, 0 planned; matrix 28 machines, 252 edges
and initial states owned, 20 commands, 16 reads, 1 intake; clean-consume green.
