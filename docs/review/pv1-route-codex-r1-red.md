# PV1 L-ROUTE Codex r1 (REJECT on db5f0e3): red-before evidence

Findings: `docs/review/pv1-route-codex-r1.json`. Product state: db5f0e3 (no src change in this commit). Windows, `tsc` build,
`node --test --test-name-pattern "<PV1R-0n>" dist/test/<file>`. Each test fails on its own assertion (no harness `FaultNotInjected`,
no setup failure); the positive controls placed before the red assertion pass.

| Finding | File :: test | Red on db5f0e3 (first failing assertion) |
|---|---|---|
| PV1R-01 | `apps/api/test/ach-route-cells.test.ts` :: `PV1R-01 DENY ACH-M-R2-REVOCATION (unsafe cookie request, CMD201 configure): ...` | `CMD201 configure: no Origin` actual `201 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` |
| PV1R-01 | same, `(..., CMD202 verify)` | `CMD202 verify: no Origin` actual `200 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` |
| PV1R-01 | same, `(..., CMD203 enable)` | `CMD203 enable: no Origin` actual `200 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` |
| PV1R-01 | same, `(..., CMD204 disable)` | `CMD204 disable: no Origin` actual `200 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` |
| PV1R-01 | same, `(..., CMD205 replace-details)` | `CMD205 replace-details: no Origin` actual `200 SUCCESS -`, expected `403 NOT_AUTHORIZED ORIGIN_REJECTED` |
| PV1R-01 | `ach-route-cells.test.ts` :: `PV1R-01 DENY ACH-M-I3-REVOCATION (ambiguous credentials on the reads): ...` | `getBankRoute: cookie beside bearer` actual `401 AUTHENTICATION_REQUIRED -`, expected `400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS` |
| PV1R-02 | `ach-route-cells.test.ts` :: `PV1R-02 DENY ACH-M-I3-REVOCATION (session ended during the route-lock wait): ...` | live iteration passes (served after the wait); `revoked: the held read is refused like the next request` actual `200 SUCCESS -`, expected `401 AUTHENTICATION_REQUIRED -` |
| PV1R-03 | `ach-route-cells.test.ts` :: `PV1R-03 DENY ACH-M-R2-EXPIRY (step-up expires during the enable evidence read): ...` | control 200 passes; `a proof stale once the evidence read returns refuses the enable` actual `200 SUCCESS -`, expected `403 ASSURANCE_REQUIRED STEP_UP_STALE` |
| PV1R-03 | `... (details expire during the enable evidence read): ...` | control passes; `details expired at the effect refuse the enable` actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED` |
| PV1R-03 | `... (step-up expires before COMMIT, verify|enable|disable|replace-details): ...` (4 tests) | control passes; `<cmd>: a proof expired at COMMIT refuses the effect` actual `200 SUCCESS -`, expected `403 ASSURANCE_REQUIRED STEP_UP_STALE` |
| PV1R-03 | `... (details expire before COMMIT, verify|enable): ...` (2 tests) | control passes; `<cmd>: details expired at COMMIT refuse the effect` actual `200 SUCCESS -`, expected `409 PRECONDITION_FAILED DETAILS_EXPIRED` |
| PV1R-04 | `packages/persistence/test/bank-kit-migrations.test.ts` :: `PV1R-04 the CHECK lists of the tables are the same vocabulary, column by column and exactly ...` | PASSES on db5f0e3: the schema is right (23 enumerated columns incl. `outbound_execution_attempts.currency = 'USD'`, the freeze-reason subset); test-only defect |
| PV1R-04 | same file :: `PV1R-04 mutation self-test: an added foreign token or a removed legitimate token ...` | passes with the per-column comparison; with the db5f0e3 global token search substituted into the compiled test (scratch, uncommitted): `bank_review_cases.environment: an added foreign token is detected` actual `[]`, expected `['bank_review_cases.environment: permits foreign ["BOGUS"]']` |
| PV1R-05 | `tools/test/matrix.test.mjs` :: `PV1R-05 every Refund transition event of the candidate machine ...` | `every Refund event has an entry in EDGE_OWNERS.Refund` actual `['manual_execution_declared', 'manual_execution_window_lapsed', 'manual_return_recorded', 'owner_attested_no_effect']`, expected `[]` |
| PV1R-05 | same file :: `PV1R-05 pnpm run matrix completes: ...` | `Got unwanted exception: generateMatrix renders the candidate's machines` — `TypeError: Cannot read properties of undefined (reading 'command')` |

## Notes for the builder

- PV1R-03 at COMMIT: the cells hold at the harness point `uow.before-commit` (after the handler returned, before the factory's COMMIT)
  and move the cell's step clock there. The harness's expiry evidence (`deadlineGap`) requires that an operation consume an instant
  at or past the deadline: a re-judgement must read the effect instant through the unit of work it runs in (`co.effectNow(uow)`,
  which the harness repositions on the step clock) after that point, e.g. a pre-commit hook the factory runs after the work. A
  database-only check at COMMIT reading the server clock would not see the moved step clock (the offset is set only by `onServer`).
- PV1R-01 positive controls use a step-up recorded for the owner's user (`w.stepUp`), presented under the owner's cookie session.
  If the fixed boundary binds step-up proofs to the session, the control will say so (`the valid browser request is served`).
- PV1R-02 proves the wait position by the database waiter (`ctx.mustWait` on the holder's pid): the holder locks only the route row
  FOR NO KEY UPDATE, which conflicts only with the read's `repo.lockShare` route guard, taken after `stillAuthenticated`.
- PV1R-05 entry shape for planned-not-implemented edges (`tools/matrix.mjs` `checkSources`): `{ owner: "<lane>", why: "<reason>",
  event: "<registered event type>" | null }` — no `command` key (a `command` must be a registry id and, if served, its handler must
  publish the event). The generator renders it as `<owner>: <why>`; the Stored column says `database` when the migrations seed the
  edge into `kauro.state_transitions`, else `—`. The existing `matrix.test.mjs` first test (`sources.machines.length, 29`) and the
  committed B06 matrix also need regenerating once owners exist.
