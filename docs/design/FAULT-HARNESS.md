# Common fault harness

One reusable way, for every package from B09 to B19, to test the failure family behind most blocking review findings of B06–B08: concurrency, time (expiry, timeouts), a crash between steps, retries and duplicates, revocation and fencing, partial failure. It lives in `packages/persistence/src/testing/faults/` and is exported from the test-only subpath `@kauro/persistence/testing` (the architecture gate keeps it out of production). Real PostgreSQL 17 only; nothing sleeps to synchronize. Self-test: `packages/persistence/test/fault-harness.test.ts`.

## Primitives

| Need | API | Fails when |
|---|---|---|
| Controlled time | `controlledClock(start?)`: a `Clock` frozen until moved — `advance(ms)`, `set(t)`, `past(boundary, margin?)`, `before(boundary, margin?)`, `at(offset)`; `onServer(session)` sets `kauro.server_now()` of that transaction exactly to the clock (the labelled TEST CLOCK) and checks the server reads it. `moveLog` records each forward move (from, to); `useLog` each use: the application instant read (`now`, `nowMs`, `date`) or a transaction positioned by `onServer`. Moving to the instant the clock already reads is not a move; the instant a move returns is not a use | moved backwards |
| Crash or pause at a named point | `FaultPoints`: `crash(name)`, `pause(name)` → `reached`, `reachedBy(op)`, `release()`, `crash()`; code passes points with `pass(name)`. A crash is recorded when it fires in the code under test, never before | `assertAllReached()`: an armed point never reached; `reachedBy`: the operation finished first; `crash()`/`release()` of a pause already released or crashed throws |
| Crash around COMMIT | `crashableFactory(factory, points, "uow", ["run"])`: points `uow.before-commit` (the unit rolls back) and `uow.after-commit` (committed, answer lost). It records a commit crash only when it fired at its own boundary: before-commit when the factory then rejected (COMMIT never issued), after-commit after the factory resolved (`PgUnitOfWorkFactory` resolves only when COMMIT answered COMMIT). Undecorated members are the real factory's, bound to it (private fields work) | as above |
| Crash around a provider call / dispatch | `instrumentPort(port, points, "storage")`: `storage.<method>.before` (no effect) and `.after` (effect landed, answer lost) | as above |
| Process death | `terminateBackend(oracle, victim)`: `pg_terminate_backend` from the oracle (another connection) on the pid the server announced when the victim connected (`connectionPid`, never a query on the victim, which would queue behind a blocked statement); the open transaction is aborted by the server. Recorded in `points.crashes`, but never a crash at a commit boundary | backend survives; oracle is the victim |
| Lock wait | `mustWait(oracle, { waiter, holder }, op, what)` → `{ pending }`: the operation's own backend pid (taken before it started) waits on a lock and `pg_blocking_pids(waiter)` contains the holder's pid; the outcome is re-checked after every look | `InterleavingNotObserved`: the op settled without waiting, or waited only on another backend |
| Two-actor race | `inOrder(scenario, first)`, `bothOrders(scenario)`: each actor (`name`, dedicated `client`, `begin`, `act`) holds the lock once while the other is observed waiting on it (pids from `connectionPid`); then holder COMMIT, waiter COMMIT; `verify({ order, state, outcomes })` with each actor's `act`, `commit`, `committed`. A COMMIT answered `ROLLBACK` (an aborted transaction) is a rejected commit (`TransactionNotCommitted`), never `committed`, as in the production factory | the waiter never waited on the holder |
| Duplicates / retries | `concurrently(n, req)`, `sequentially(n, req)`, `partition(outcomes)` | fewer than 2 copies |
| Crash predicate | `crashedAt(point?)` for `assert.rejects` (follows `cause`, as a unit of work wraps the crash) | |

## A matrix cell becomes a test

```ts
faultCell({ id: "B06-R1", step: "LeaseStore.claim takeover", fault: "expiry", expect: "REFUSED RESUME_WITHOUT_CHECKPOINT" }, async (ctx) => {
  const expiresAt = ctx.deadline(ctx.clock.at(120_000), "lease's time to live");  // the boundary the cell names
  await claim(owner1, ctx.clock.now());          // the step at t0
  ctx.clock.past(expiresAt);                     // the fault: one move across the deadline
  assert.deepEqual(await claim(owner2, ctx.clock.now()), { kind: "REFUSED", reason: "RESUME_WITHOUT_CHECKPOINT" });  // used past it
});
```

The title is `<id> [<fault>] <step> -> <expect>` (`[<fault> at <at>]` for a crash cell). The body gets a fresh `FaultContext`: `points`, `clock`, `deadline()`, the counted `mustWait`, `inOrder`, `bothOrders`, `concurrently`, `sequentially`, `attempt()`, and `revoked()`, `fenced()`, `partial()`, `kill()`. `faultMatrix(cells, bodies)` registers a whole matrix keyed by `cellKey` (`id|step|fault`) and refuses a cell without a body, a body without a cell or a duplicated cell, so a package's matrix maps 1:1 to tests.

### Rules: a cell can never pass unless its fault demonstrably happened at the boundary it names

After the body, every armed point must have been reached and the cell's kind must have its proof, recorded only by the harness from what it observed (a flag or a count the body sets is never evidence); otherwise the cell fails with `FaultNotInjected`.

| Kind | Proof |
|---|---|
| `race` | `ctx.inOrder` / `ctx.bothOrders` / `ctx.mustWait` observed the operation's own backend waiting on a lock held by the intended holder (`pg_blocking_pids`), before the operation settled. |
| `expiry`, `timeout` | At least one deadline declared with `ctx.deadline(instant)`. Every declared deadline (in any kind) is crossed by one move of the clock (`before < deadline <= after`; `set()` to the current instant is no move, a move short of the deadline proves nothing) and the clock is used after that move at or past the deadline: `onServer` on the transaction under test (a server-clock step), or the application instant read (`now`, `nowMs`, `date` — the Clock port, or the instant a step takes as its parameter). |
| `crash-before-commit` | The cell names `at` (the `crashableFactory` name); a crash fired at `<at>.before-commit` inside the unit's work and the factory then rejected: COMMIT was never issued. A crash at any other point, at `<at>.after-commit`, a point passed by hand or a killed connection is not this proof. |
| `crash-after-commit` | The cell names `at`; the factory resolved (COMMIT answered COMMIT) and a crash then fired at `<at>.after-commit`. Killing an idle connection is not a crash at a commit. |
| `retry` | The request ran and settled at least twice: `ctx.attempt(req)`, or each copy of `ctx.concurrently` / `ctx.sequentially`, counts once its callback executed and resolved or rejected — never on request. |
| `revocation` | `ctx.revoked(what, fn | actorOutcome)` took effect — the function resolved, or a race actor outcome the harness produced committed — and then `ctx.fenced(what, fn | actorOutcome, refusal)` observed an operation refused after it: the function rejected with the named refusal, or an actor the harness settled after the revocation did not commit and its COMMIT's (or write's) error is the named refusal. |
| `partial` | `ctx.partial(what, at, op)` armed a crash at the point `at`; the operation failed there, after at least one earlier point of the same run passed (a step that completed). The body asserts what survived. |

## Examples

`packages/persistence/test/fault-harness-cells.test.ts` re-expresses four existing tests (the originals stay), each with every assertion of its original: B06-R1 lease takeover without a checkpoint (`expiry`, the lease's time to live declared and crossed), B08-R1 a revoked source admission fencing a publication (`revocation`: the revocation actor committed, the waiting publication and a later one refused KA081), R2-045 revocation vs publication in both orders (`race`, `bothOrders`), B07-R1 a retried release claim vs a newer hold (`retry`, three attempts of the release request; the 900-second claim and its 10-second in-flight bound, the database's refusals of a second live claim, a release under an unanswered claim, a superseded answer, a premature hold and a claim for an undecided release, the once-only answer and the persisted claims and holds; the clock crosses the claim's bound and the in-flight bound, both declared). Self-test of every rule, including each vacuous cell that must fail: `packages/persistence/test/fault-harness.test.ts`.
