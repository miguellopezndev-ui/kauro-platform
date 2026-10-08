# PV1 route: internal adversary r12 (verify-only), candidate 45b4cd5

Scope: `git diff 8ca6225..45b4cd5` (a73c448, 45b4cd5). Verdict: **PASS** (0 findings). Receipt: adversary PASS kauro-platform@45b4cd5.
Findings JSON (Codex schema, empty): `.kauro/reviews/pv1-route-45b4cd5-adversary.json`.

## Delta shape
- Files: `pv1-route-pv1r07-design.md`, `pv1-route-test-repairs.md`, `pv1-route-touched-B06.md`, all under docs/review. Nothing else.
- `git diff 81d2509..45b4cd5 -- ':!docs'` is empty: the code tree is identical to the one r11 judged. Its code verdicts, red proofs
  (in-memory mutations: COMMIT swallowed 5/5 red, liveAt true 4/4 red, FOR SHARE dropped 6/6 red) and family table stand.

## r11 findings
| Id | State | Evidence |
|---|---|---|
| ADV-1 (MAJOR) | CLOSED | touched-B06 gains the B11 `b11-sessions.test.ts` W2 row (old and new assertions, D-AUTH-1a, 81d2509) and `request/runtime.ts` as an accepted-B09 touch (replay judgment receives the unit; cells H6, H7), removed from the lane-file row. test-repairs records the W2 re-ruling as a RULED CHANGE (RELAXED: 0 kept). The text matches the 81d2509 hunk of `b11-sessions.test.ts:452` assertion by assertion (count(*) -> 0 rows; session_id SELECT, UPDATE revoked_at, DELETE denied; presented hash + own user visible FOR SHARE; UPDATE session_id refused; other user 0 rows). |
| ADV-2 (MINOR) | CLOSED, text accurate | K2 and §5 now say observed and pinned 500 INTERNAL_ERROR; same-key retry settles (H7). |
| ADV-3 (MINOR) | CLOSED | getBankRoute (H5) and shared replay (H6) rows: lock-to-judgment N/A, reason "no await between the fence statement and the judgment" (authority.ts:46-49, r11 check 1); getBankRoute idempotency "N/A no key"; P2 removed from the cell list ("not a cell, none written"). |

## K2 accuracy (the question asked)
"57P01 reaches the idle client, next statement fails without SQLSTATE" is accurate. Path: the holder is the unit's own backend, paused
between statements (no active query). pg 8.23.0 `client.js:426-434`: an ErrorResponse with no active query goes to
`_handleErrorEvent(msg)`, which sets `_queryable = false` and emits `error` on the client (the 57P01 DatabaseError is the event payload).
`pool.ts:206-209` records it as `lost` and sends it to the sink (diagnostic classification only, pool.ts:76). The unit's next statement
or COMMIT is rejected by `client.js:747-749` with a plain `Error('Client has encountered a connection error and is not queryable')`
(no `code`); `unit-of-work.ts` maps a non-database error to INTERNAL_ERROR (500, :366), so the `57P01 -> CAPACITY_UNAVAILABLE`
entry (`sqlstate.ts:174`) is never consulted for the reply. One precision only (not a finding): "no SQLSTATE reaching sqlstate.ts" is true
for the reply mapping; the 57P01 does reach `classifyError` in the pool diagnostic sink. The doc's "emitted on the client, not on a query"
already says this. Had the kill landed during an active query the answer would be 503; the cells pause between statements by design.

## Family sweep
No code path changed. The scope paths of r11 and of the earlier Codex findings keep the covering cells in the r11 family table.
The only new claim, "Red on 83a51be at the old first assertion" for W2, is consistent: `count(*)` as kauro_app returns 0 rows
after 0047, so `assert.rejects(..., /permission denied/)` fails there.
