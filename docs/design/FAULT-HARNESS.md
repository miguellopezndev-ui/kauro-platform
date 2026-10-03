# Common fault harness

One reusable way, for every package from B09 to B19, to test the failure family behind most blocking review findings of B06–B08: concurrency, time (expiry, timeouts), a crash between steps, retries and duplicates, revocation and fencing, partial failure. It lives in `packages/persistence/src/testing/faults/` and is exported from the test-only subpath `@kauro/persistence/testing` (the architecture gate keeps it out of production). Real PostgreSQL 17 only; nothing sleeps to synchronize. Self-test: `packages/persistence/test/fault-harness.test.ts`.

## Primitives

| Need | API | Fails when |
|---|---|---|
| Controlled time | `controlledClock(start?)`: a `Clock` frozen until moved — `advance(ms)`, `set(t)`, `past(boundary, margin?)`, `before(boundary, margin?)`, `at(offset)`; `onServer(session)` sets `kauro.server_now()` of that transaction exactly to the clock (the labelled TEST CLOCK) | moved backwards |
| Crash or pause at a named point | `FaultPoints`: `crash(name)`, `pause(name)` → `reached`, `reachedBy(op)`, `release()`, `crash()`; code passes points with `pass(name)` | `assertAllReached()`: an armed point never reached; `reachedBy`: the operation finished first |
| Crash around COMMIT | `crashableFactory(factory, points, "uow", ["run"])`: points `uow.before-commit` (the unit rolls back) and `uow.after-commit` (committed, answer lost) | as above |
| Crash around a provider call / dispatch | `instrumentPort(port, points, "storage")`: `storage.<method>.before` (no effect) and `.after` (effect landed, answer lost) | as above |
| Process death | `terminateBackend(oracle, client)`: `pg_terminate_backend`; the open transaction is aborted by the server | backend survives |
| Lock wait | `mustWait(oracle, {pid} or {applicationName, query}, op, what)` → `{ pending }` | `InterleavingNotObserved`: the op settled without waiting |
| Two-actor race | `inOrder(scenario, first)`, `bothOrders(scenario)`: each actor (`name`, dedicated `client`, `begin`, `act`) holds the lock once while the other is observed waiting; then holder COMMIT, waiter COMMIT; `verify({ order, state, outcomes })` with each actor's `act`, `commit`, `committed` | the waiter never waited |
| Duplicates / retries | `concurrently(n, req)`, `sequentially(n, req)`, `partition(outcomes)` | fewer than 2 copies |
| Crash predicate | `crashedAt(point?)` for `assert.rejects` (follows `cause`, as a unit of work wraps the crash) | |

## A matrix cell becomes a test

```ts
faultCell({ id: "B06-R1", step: "LeaseStore.claim takeover", fault: "expiry", expect: "REFUSED RESUME_WITHOUT_CHECKPOINT" }, async (ctx) => {
  const expiresAt = ctx.clock.at(120_000);
  await claim(owner1, ctx.clock.now());          // the step at t0
  ctx.clock.past(expiresAt);                     // the fault
  assert.deepEqual(await claim(owner2, ctx.clock.now()), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });
});
```

The title is `<id> [<fault>] <step> -> <expect>`. The body gets a fresh `FaultContext` (`points`, `clock`, and counted `mustWait`, `inOrder`, `bothOrders`, `concurrently`, `sequentially`, `retried()`, `kill()`). After the body the cell fails unless its fault really happened: `race` → a lock wait observed; `expiry`/`timeout` → the clock moved; `crash-before-commit`/`crash-after-commit` → a crash fired; `retry` → the request ran at least twice; `revocation`/`partial` → proven by the body's own assertions. Every armed point must have been reached. `faultMatrix(cells, bodies)` registers a whole matrix keyed by `cellKey` (`id|step|fault`) and refuses a cell without a body, a body without a cell or a duplicated cell, so a package's matrix maps 1:1 to tests.

## Examples

`packages/persistence/test/fault-harness-cells.test.ts` re-expresses four existing tests (the originals stay): B06-R1 lease takeover without a checkpoint (`expiry`), B08-R1 a revoked source admission fencing a publication (`revocation`, `inOrder`), R2-045 revocation vs publication in both orders (`race`, `bothOrders`), B07-R1 a retried release claim vs a newer hold (`retry`, clock past the claim and in-flight bounds).
