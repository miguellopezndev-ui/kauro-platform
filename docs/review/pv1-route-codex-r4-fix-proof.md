# PV1 route: Codex r4 PV1R-07 fix proof (session fenced FOR SHARE inside the effect's own transaction)

Design: `pv1-route-pv1r07-design.md`. Red evidence (cells written first): `pv1-route-codex-r4-red.md` (0619f7a). Fix: migration `0047_session_fence.sql`,
`PgSessionFence` (the unit's own client), `SessionFence` port, `SessionService.holdIn`, `RequestAuthority.hold(uow)`, `judgedUnderHold(authority, uow, clock)`.
The separate assurance hold, every `release()` call and the swallow at `request-authority.ts:46` are gone: the release is the unit's checked COMMIT.

## Revert proof (rule 3)
`git diff 0619f7a HEAD -- packages/persistence/src packages/persistence/migrations packages/application/src apps/api/src > patch; git apply -R patch`, rebuild, run;
then `git apply patch` and rebuild (tests, fixture and docs untouched).
| Cell | Reverted (red) | Fixed (green) |
|---|---|---|
| H1 I3, holder lost during the effect-clock wait | `AssertionError: the read whose lock holder was lost is not served (200 SUCCESS -)` | 500 INTERNAL_ERROR, next request 401 |
| H3 verify, holder lost before COMMIT | `AssertionError: verify: nothing commits under a lost lock (200 SUCCESS -)` | 500 INTERNAL_ERROR, nothing committed, next 401 |
| F1 fence vs revoke | `error: permission denied for table web_sessions` (42501) | revoke waits behind the app backend, then revokes |

## Observed status after holder loss (pinned)
All 14 H1-H6 holder-loss cells (H1/H2 2, H3 4 commands x 2 positions = 8, H4 2, H5 1, H6 1): exactly `500 INTERNAL_ERROR -` (design K2: the unit's connection failure, the next request is 401). The cells accept only that value. H7 (post-COMMIT answer loss, then revocation; replay refused) is a separate scenario, not a holder termination.

## Focused runs on the fix
persistence: migrations, runtime-boundary (P1), source-migrations (unchanged, green), aggregate-kinds, session-fence (F1-F6, T2, T3): 58/58.
apps/api `ach-route-cells`: 131/131 (H1-H7, S1 x4, E1, R1, the three repaired tests; `pv1-route-test-repairs.md`).
