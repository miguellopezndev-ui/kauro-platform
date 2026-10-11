# PV1 route internal adversary r5 on 450da31 (tests-only delta 164a809..450da31)

Verdict: PASS_WITH_MINOR (zero BLOCKING/MAJOR). Closes r4 ADV-1 (MAJOR) and ADV-3 (MINOR). Reviewer: kauro-adversary (Sonnet 5.5), Windows, embedded PostgreSQL.

## Reverts redone by the reviewer (hand edit, rebuild application + api, one cell group, `git checkout -- <file>`, rebuild, tree clean)

1. Baseline 450da31: `ADV-1` 2/2 green.
2. Delete `packages/application/src/commerce/bank/instructions.ts:342` (the `sessionLiveUntil` judgment): both ADV-1 cells FAIL, after their positive control passed:
   `AssertionError: idle: a session that ended between the effect-clock read and the view gets the authentication refusal` (actual `200 SUCCESS -`, expected `401 AUTHENTICATION_REQUIRED -`)
   and the identical `absolute:` twin. Restored: ADV-1 + ADV-3 4/4 green.
3. Restore the 5bac4cf read order at instructions.ts:132-134 (effect, then facts, then source deadline): the ADV-3 price cell FAILS
   (`the price deadline crossed between the probe and the effect read refuses the issuance`, actual `409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT`, expected `409 PRECONDITION_FAILED QUOTE_EXPIRED`);
   the ADV-3 source cell stays GREEN, as the builder said. Restored, rebuilt, `git status` clean.

## Cell reading
- ADV-1: hold = the first `kauro.effect_now()` statement after the third resume (`withResumeHeld(FINAL_I3_RESUME)` arms it; `armed` gate), so `SessionService.resume` can no longer refuse; only line 342 can. Positive control (+1 s, session >= 9 min from deadline) serves 200 with the digits, routing and reference (non-zero fixtures); the held crossing asserts 401, `noAccountDigits`, no reference in the body, and the next request is 401 (fenced). The absolute cell first walks the session until the idle deadline is bound to the absolute one (asserted).
- ADV-3: hold = the issuance's first effect-instant read (nth 1, step clock), crossing set after the hold, control 10 s short of the source deadline issues (201, one order, one instruction snapshot, accepted quote, events). Price cell asserts the refusal code and `NOTHING_ISSUED`.

## Question 3: documentary ADV-3 source cell
Acceptable as a documented behavior cell (the two orders agree: body vs COMMIT-time window judgment, both TRANSFER_WINDOW_TOO_SHORT, nothing issued), NOT a regression proof. It is so declared in pv1-route-codex-r2-fix-proof.md ("documents the code, not a revert proof"); the case map / evidence must not count it as red-proof (tools/red-proof.mjs should list only the price cell and the two ADV-1 cells for this delta).

## Findings (MINOR, no gate)
- ADV-4 MINOR evidence: the source cell title does not say "documentary"; the label lives only in the proof doc. Scope: apps/api/test/ach-route-cells.test.ts (ADV-3 loop, `fact === "source"`). Acceptance: keep it out of red-proof counts. Status OPEN, non-blocking.
- ADV-5 MINOR time (carried, r4 ADV-3 remainder): revision and capacity facts are still read at the probe instant (instructions.ts:132) and judged at the effect instant; a change between the probe and the effect read is bounded by the window judgment (TRANSFER_WINDOW_TOO_SHORT at COMMIT) and no money or rights outcome depends on it. No test of that exact interleaving. Non-blocking.

## Family coverage (scope path -> covering test; evidence.md of the Codex verification)
| Scope path | Covering test | Fails without the fix |
|---|---|---|
| instructions.ts:342 `liveUntil` judgment | ADV-1 idle, ADV-1 absolute | yes (reviewer-run, above) |
| instructions.ts:334 (`liveUntil` read from `still`) | same two cells (null would be served 200) | yes by construction (the judgment is skipped when null; same 200 vs 401) |
| sessions.ts:96-99, authenticator.ts:45, bank-route-routes.ts:156-159 (`liveUntil` propagation) | same two cells (control + held crossing travel the real stack: cookie -> authenticator -> route -> application) | yes by construction (a dropped value is the null path); not separately reverted |
| instructions.ts:132-134 read order (price expiry) | ADV-3 price | yes (reviewer-run, above) |
| instructions.ts:132-134 source deadline / window | ADV-3 source | NO, documentary only |
| r4 ADV-2 (other step-up callers, pre-await clock samples) | outside the delta; listed in pv1-route-adversary-r4.md for the coordinator (B09 accepted files) | n/a |

Counts: ach-route-cells 94 (90 + 4), builder-reported Linux focused verify 450da31 exit 0 (matrix 8/8, persistence 30/30, api 42/42); reviewer re-ran ADV-1 and ADV-3 (4/4) on Windows at 450da31 and the tree is clean.
