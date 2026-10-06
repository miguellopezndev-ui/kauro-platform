# CMD043 Windows race timeout

The reported assertion is `+ '503 CAPACITY_UNAVAILABLE -'` versus
`- '409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED'`, with
`cause=DatabaseError code=57014`. A `CAPACITY_UNAVAILABLE` whose cause is a
`DomainFailure` is different evidence; it does not establish database cancellation.

## Transaction and lock path

1. Order first (`apps/api/test/cmd043-close-agency.test.ts:398`): CMD028's T1
   TENANT / kauro_app unit reserves its journal, takes the agency's shared
   transition half during checkout prerequisite reads, and writes its intent.
   The journal's agency foreign key takes a row KEY SHARE lock (migration
   `0006_journals_leases.sql:21`); other intent foreign keys also name the agency.
   `provider-effects.ts` calls `INTENT_BEFORE_COMMIT` inside that transaction.
   `ProtocolHolds.hook` pauses in JavaScript without committing or releasing locks.
2. CMD043 starts another TENANT / kauro_app transaction. After authorization,
   journal reservation and step-up verification, `close-agency.ts:69` calls
   `uow.agencies.lock`. `repositories/tenancy.ts:192` issues
   `SELECT ... FROM kauro.agencies WHERE agency_id = $1 FOR UPDATE`.
   UPDATE conflicts with CMD028's KEY SHARE (the race comment describes this as
   reading for sharing; the journal FK supplies the actual row lock). The expected server wait is Lock /
   transactionid (a ShareLock on the holder's transaction id), not the closure
   inventory's later exclusive advisory lock. The FOR UPDATE has not returned,
   so `closureObligations` has not yet taken that advisory lock.
3. `waitForApiLockWait` observes that SELECT through `waitForLockWait`. Until
   observation returns and its `finally` releases the hold, CMD028 remains open.
   The waiter also waits for CMD028's remaining work and COMMIT after release.
   Without cancellation, it reads the committed in-flight order and returns
   the original required 409.
4. Close first (`cmd043-close-agency.test.ts:421`): CMD043 holds FOR UPDATE and
   its exclusive advisory half at `journal.commit`. CMD028 waits inside
   `INSERT INTO kauro.command_journal`: its agency FK's KEY SHARE conflicts with
   CMD043's row lock. After release it sees CLOSING and returns AGENCY_NOT_ACTIVE.

Both units run through `PgUnitOfWorkFactory.#once`, which issues
`SET LOCAL statement_timeout = '10000ms'` in the original test configuration
(`unit-of-work.ts:427`). The API world passes that value via `openDatabase` and
`defaultStatementTimeoutMs`. Routed fault factories originally omitted the
option when `FaultRouting.statementTimeoutMs` was null, inheriting the same
10 s factory default. A timeout applies to **each statement**, including its
lock wait; it does not measure the whole transaction or a JavaScript pause.
There is no active SQL timer on the idle holder while its point is paused.
The waiting SELECT, however, is active and is cancelled when execution plus
wait reaches 10 s. `sqlstate.ts` translates 57014 to retriable CAPACITY_UNAVAILABLE;
the command rolls back and the API returns 503. No retry of this cancellation
is performed (the factory's transient states are 40001 and 40P01).

`runtime-transaction.ts` also sets a transaction-local statement timeout, but
its 5 s default belongs to public stores, not CMD043/CMD028. The inquiry store
explicitly selects 10 s, overriding that default; configuring a pool or command
factory alone cannot change it. Its public race at `b11-public-routes.test.ts:538`
holds the admission table and observes an INSERT and an advisory waiter before
release, and shares the observation-versus-statement mismatch. The inquiry
store now accepts an optional timeout argument; only the test supplies the
race allowance. Its production default remains 10 s and the public runtime
transaction default remains 5 s.

## Configuration repair

`testing/faults/bounds.ts` derives the allowance from the existing 400 polls ×
25 ms = 10,000 ms observation sleeps. Those polls additionally execute two
oracle queries each; the polling total is **not** a hard wall-clock maximum.
The 10 s `mustWait` and `observeBlocked` deadlines are also unchanged. Pauses
have no automatic expiry: the test releases them after observation and any
intervening work. Treating the original 10 s statement cap as an allowance
for that same observation period was inconsistent.

Test units now use 3 × that allowance = 30,000 ms: observation, oracle/runner
scheduling, and holder release/remaining writes/COMMIT. This also accommodates
the races that observe two waits before release. This is finite slack for a
slow runner, not a guarantee against arbitrarily long scheduling stalls.
The exported configuration lives only on `@kauro/persistence/testing` and
is passed explicitly by API/payment/commission/control test factories and
fixture factories. No production default changed. Explicit timeout cells
(`b10-failure-cells-close2.test.ts:471`, 1,500 ms;
`adapters-unit-of-work.test.ts:273`, 200 ms) remain explicit and unchanged.
`mustWait`, pause/rejection semantics, assertions, cases and expectations are
unchanged; only poll literals were named, retaining exactly 400 × 25 ms.

## Deterministic builder reproduction

Run on Linux with TCP listen permission, Node 24, pnpm and PostgreSQL 17:

```sh
pnpm --filter '!@kauro/web' -r --workspace-concurrency=1 run build
PGBIN=/usr/lib/postgresql/17/bin node tools/reproduce-cmd043-timeout.mjs
PGBIN=/usr/lib/postgresql/17/bin pnpm --filter @kauro/persistence --filter @kauro/api --filter @kauro/control -r run test
```

The reproduction runs every original CMD043 case twice, with the holder's
release delayed 11,000 ms **after** its wait is genuinely observed. First it
reverts the timeout configuration via `KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS=10000`;
then it removes that override and uses the derived 30,000 ms. It requires the
original failing assertion and DatabaseError 57014 in the first run, and all
cases passing with no such cancellation in the second. Both use the same
`KAURO_TEST_LOCK_RELEASE_DELAY_MS=11000`; no assertion or observation is bypassed.
It records the observed waiter query, wait event, blocker pids and statement
age on stderr. Logs are `${TMPDIR:-/tmp}/cmd043-before.log` and `cmd043-after.log`.
Both environment knobs are test-only and absent in ordinary CI runs.

Equivalent commands to inspect each run independently:

```sh
PGBIN=/usr/lib/postgresql/17/bin KAURO_TEST_LOCK_RELEASE_DELAY_MS=11000 KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS=10000 node --test --test-reporter=spec apps/api/dist/test/cmd043-close-agency.test.js
PGBIN=/usr/lib/postgresql/17/bin KAURO_TEST_LOCK_RELEASE_DELAY_MS=11000 node --test --test-reporter=spec apps/api/dist/test/cmd043-close-agency.test.js
```

The historical Windows log does not contain waiter/holder pids or elapsed
lock-wait timing. The path above is traced from source and the reported
assertion; its exact historical elapsed pause cannot be reconstructed.
This sandbox denies TCP listen (`listen EPERM 127.0.0.1`). The database test
was attempted and failed in setup, before any race ran. **The before/after
DB results remain for the builder to establish; they are not claimed here.**

## Sandbox validation

- `pnpm --filter '!@kauro/web' -r --workspace-concurrency=1 run build`: passed.
  Control was rebuilt after its test factory configuration changed.
- `pnpm run typecheck`: passed for the workspace; affected persistence/API/control
  typechecks passed again after the last edit.
- Contracts/domain/application/authorization/UI: 393 tests passed in 61 files,
  run file by file with `node --test --test-isolation=none --test-reporter=spec`.
  Persistence `package-surface.test.js`: both tests passed.
- Web: 235 tests passed; nine failures require TCP listen or the standalone
  Next.js build. Tools: 77 tests passed; ten failures in architecture-gate,
  b11-identity-fake and web-client require captured child processes or TCP listen.
  A direct capture probe reports `spawnSync /usr/bin/node EPERM` with empty
  output even when status is 0. These failures are reported, not quarantined.
- `node tools/architecture-gate.mjs`, `node tools/fixture-clock-lint.mjs`,
  `node --check tools/reproduce-cmd043-timeout.mjs`, and `git diff --check`: passed.
- Full `pnpm run build` stopped in Next.js with
  `Could not parse output from TypeScript's --showConfig` under the same
  child-process capture restriction. Backend build succeeded separately.
- CMD043 DB command with `--test-isolation=none` exposes the setup failure:
  `Error: listen EPERM: operation not permitted 127.0.0.1`. No DB race outcome
  was obtained. The reproduction script must run on the builder as above.

Logs in `/tmp/cmd043-*.log` record the commands' output. No test was skipped
or quarantined in the executed files; none of the existing assertions changed.

## Family search

The following are lock-observation/contend call sites (source lines). API,
control and fixture units involved now share the derived test configuration.
Some persistence rows also exercise raw clients with no statement timeout;
those raw clients need no timeout change. Harness self-tests retain their
rejection behavior. Operability's deliberately bounded failures and the
explicit cancellation cells are excluded from the repair.

| File | Lines |
| --- | --- |
| apps/api/test/b10-commission-service.test.ts | 311 |
| apps/api/test/b10-failure-cells-accrual.test.ts | 250, 386, 387, 436, 456, 472, 512, 555, 582, 879, 905, 931, 990, 1023, 1051 |
| apps/api/test/b10-failure-cells-close.test.ts | 92, 135, 173, 181, 249, 281 |
| apps/api/test/b10-failure-cells-conversion.test.ts | 767, 841, 860, 889, 924, 951, 1002 |
| apps/api/test/b10-failure-cells-correct.test.ts | 111, 135 |
| apps/api/test/b10-failure-cells-funds-fence.test.ts | 189 |
| apps/api/test/b10-failure-cells-pay.test.ts | 101, 298, 667, 787 |
| apps/api/test/b10-scenarios.test.ts | 586, 650 |
| apps/api/test/b11-public-routes.test.ts | 543, 544 |
| apps/api/test/cmd001-create-agency.test.ts | 131 |
| apps/api/test/cmd002-activate-agency.test.ts | 213 |
| apps/api/test/cmd009-create-client.test.ts | 171 |
| apps/api/test/cmd010-archive-client.test.ts | 143 |
| apps/api/test/cmd011-create-project.test.ts | 162, 202, 286, 358, 392, 428 |
| apps/api/test/cmd012-create-revision.test.ts | 239 |
| apps/api/test/cmd013-reserve-upload.test.ts | 238 |
| apps/api/test/cmd014-complete-upload.test.ts | 215, 234 |
| apps/api/test/cmd015-cancel-upload.test.ts | 149, 182 |
| apps/api/test/cmd016-select-input-tables.test.ts | 188, 222 |
| apps/api/test/cmd017-seal-revision.test.ts | 347, 408, 452, 526 |
| apps/api/test/cmd020-start-audit.test.ts | 257 |
| apps/api/test/cmd021-cancel-audit.test.ts | 188 |
| apps/api/test/cmd022-create-plan.test.ts | 218 |
| apps/api/test/cmd023-revise-plan.test.ts | 174, 209, 343 |
| apps/api/test/cmd024-validate-plan.test.ts | 148 |
| apps/api/test/cmd025-approve-plan.test.ts | 292, 345, 462, 514, 547 |
| apps/api/test/cmd026-withdraw-approval.test.ts | 273 |
| apps/api/test/cmd027-create-quote.test.ts | 580, 744, 841, 863 |
| apps/api/test/cmd030-payment-webhook.test.ts | 243 |
| apps/api/test/cmd032-approve-refund.test.ts | 260, 285 |
| apps/api/test/cmd034-reconcile-payment.test.ts | 201 |
| apps/api/test/cmd036-execute-project.test.ts | 243, 281, 306 |
| apps/api/test/cmd037-cancel-job.test.ts | 189, 232, 261 |
| apps/api/test/cmd043-close-agency.test.ts | 405, 426 |
| apps/api/test/cmd044-create-support-case.test.ts | 270 |
| apps/api/test/cmd045-register-prospect.test.ts | 192 |
| apps/api/test/cmd046-claim-prospect.test.ts | 193 |
| apps/api/test/cmd047-accept-attribution.test.ts | 256 |
| apps/api/test/cmd048-assign-account.test.ts | 234 |
| apps/api/test/cmd049-activate-seller.test.ts | 155 |
| apps/api/test/cmd050-terminate-seller.test.ts | 311 |
| apps/api/test/cmd051-close-commission-period.test.ts | 313, 344, 346 |
| apps/api/test/cmd052-approve-commission-payout.test.ts | 262 |
| apps/api/test/cmd053-reconcile-commission-payout.test.ts | 229 |
| apps/api/test/idempotency.test.ts | 223, 252 |
| apps/api/test/pipeline-authorization.test.ts | 268, 304, 423, 480, 483 |
| apps/control/test/job-admission.test.ts | 51 |
| apps/control/test/upload-inspection.test.ts | 353 |
| packages/persistence/test/adapters-commerce-balances.test.ts | 131, 194 |
| packages/persistence/test/adapters-commerce-checkout.test.ts | 220 |
| packages/persistence/test/adapters-commerce-refunds-ledger.test.ts | 177, 207, 248 |
| packages/persistence/test/adapters-journals-outbox.test.ts | 127, 147, 358 |
| packages/persistence/test/audit-adapters.test.ts | 90 |
| packages/persistence/test/audit-migrations.test.ts | 238 |
| packages/persistence/test/b07-b09-race.test.ts | 91, 123 |
| packages/persistence/test/b09-migrations.test.ts | 426 |
| packages/persistence/test/b10-agency-adapters.test.ts | 85 |
| packages/persistence/test/b10-ledger-adapters.test.ts | 583 |
| packages/persistence/test/b10-recurrence-adapters.test.ts | 200 |
| packages/persistence/test/b10-recurrence-migrations.test.ts | 403, 413, 614 |
| packages/persistence/test/discipline.test.ts | 137 |
| packages/persistence/test/execution-adapters.test.ts | 96, 125, 161, 179 |
| packages/persistence/test/execution-migrations.test.ts | 499, 540, 849 |
| packages/persistence/test/inbox-outbox.test.ts | 81, 176, 191, 205 |
| packages/persistence/test/invitations.test.ts | 172 |
| packages/persistence/test/journals-leases.test.ts | 116 |
| packages/persistence/test/last-owner.test.ts | 35, 69, 108 |
| packages/persistence/test/migration-runner.test.ts | 51, 52 |
| packages/persistence/test/source-adapters.test.ts | 965, 1012 |
| packages/persistence/test/source-migrations.test.ts | 698, 735, 820, 841, 1235, 1256, 1295, 1315 |
