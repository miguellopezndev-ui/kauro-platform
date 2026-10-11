# PV1 route: internal adversary r8 (VERIFY of 9b849a4, delta b60fe6a..9b849a4; r7 ADV-1, ADV-2)

Verdict: **FAIL** (1 MAJOR evidence). r7 ADV-1 product fix is correct and red-proven; its covering cell does not pin the proof's
instants that the same fix moved into the store (r7 acceptance "control 299 s -> 201 with age <= 300 s" not asserted).

## Findings (review-schema.json)
| id | sev | family | file:line | finding |
|---|---|---|---|---|
| ADV-1 | MAJOR | evidence | packages/persistence/src/web-sessions.ts:294 (+:300-301) | b06f83f rewrote the proof's instants in the store (`issuedMs = Math.min(authMs, atMs)`, expiresAt = issued + freshness). Sabotage `issuedMs = atMs` (proof issued at the recording instant: freshness window extended by up to 300 s past the re-authentication, D-ASSUR-1 violated): b11-sessions 13/13 and the 19 step-up cells of ach-route-cells (incl. C r7) all GREEN. The C r7 299 s control asserts only `201` and one more row, not the age. |

ADV-1 reproduction: replace web-sessions.ts:294 with `const issuedMs = atMs;`, rebuild persistence, run `node --test --test-name-pattern="step-up|STEP_UP|stepUp|re-authentication" dist/test/ach-route-cells.test.js` and `dist/test/b11-sessions.test.js`: 0 failures.
Acceptance criterion: a recorded step-up's issued_at equals the re-authentication's auth_time (when not in the future) and expires_at = issued_at + 900 s, whatever the wait before the recording instant; created_at - issued_at <= 300 s.
Failing test: in `C r7 DENY ACH-M-R2-EXPIRY` (ach-route-cells.test.ts:3132) the 299 s control reads the new proof's issued_at/expires_at/created_at and asserts created_at - issued_at in [299 000, 300 000] ms and expires_at - issued_at = 900 000 ms (red with the sabotage above: difference 0). Optionally a future auth_time (within verifier skew) asserts issued_at = created_at.
Scope: web-sessions.ts:294 (issued = min(auth, at)); web-sessions.ts:300-301 (expiresAt from issued + freshnessSeconds); service.ts:273-274 (maxAge/freshness constants passed); b11-sessions.test.ts:440 (asserts only the 900 s difference, not the anchor). Status OPEN, reviewer_omission false (code rewritten in this delta; the r7 criterion named it).

## r7 findings re-checked
| r7 | status | proof |
|---|---|---|
| ADV-1 (age judged pre-lock) | FIXED (product) | Revert service.ts/ports/sessions.ts/web-sessions.ts to b60fe6a, rebuild, C r7 cell: `'201 SUCCESS -'` vs `'403 ASSURANCE_REQUIRED STEP_UP_STALE'` ("a re-authentication 301 s old at the post-lock instant is stale"). Narrow sabotage on the fixed store (`now()` sampled before `#boundary`/FOR UPDATE): same red. Restored: 19/19 step-up cells green. Coverage of the moved instants: see ADV-1 r8. |
| ADV-2 (docs) | FIXED | fix-proof.md:25 and :75-76 corrected; authority.ts:9-10 states the identity-row FOR KEY SHARE. Verified: identities is never locked FOR UPDATE/DELETE nor key-updated (tenancy.ts:114-118 is a non-key UPDATE ... FOR NO KEY UPDATE SKIP LOCKED; state trigger 0002:35 takes an advisory transition lock, not a row write lock on the key): no deadlock. Nit (not a finding): the binding UPDATE's FK KEY SHARE on the just-inserted proof row is unmentioned; that row is invisible to other transactions until COMMIT. |

## Checks requested
1. Callers: recordStepUp has one production caller (service.ts:276); StepUpRequest built only at service.ts:267-275 with `SESSION_POLICY.stepUpReauthenticationSeconds` (protocol.ts:40 = 300) and `STEP_UP_FRESHNESS_SECONDS` (assurance-and-admission.ts:13 = 900): same constants as b60fe6a, no drift; the boundary (`> maxAge*1000`) is the same strict comparison as before. Only implementation PgWebSessionStore; harness recordStepUp is a test fixture (harness.ts:362), not this port.
2. No-session branch (sessionSha256 null): reached only from a BEARER credential (sessions.ts:91, authenticator.ts:68); production binds an empty bearer map (bootstrap.ts:35: every bearer refused), LOCAL file only in LOCAL (bootstrap.ts:34). The instant is read inside the transaction after #begin's connection wait (web-sessions.ts:282), age judged there. Static LOCAL bearer has no revocation/expiry; identity DISABLED is not judged at step-up (pre-existing, both branches; the gated command re-reads the identity under its transition lock, tenancy.ts:86-88): note, not in delta.
3. Clock reads (verdict): service.ts:157 viewOf display only (not a gate); :190 open, instants of a NEW session (earlier sample only shortens it); :216, :243 revoke thunks -> web-sessions.ts:255 after FOR UPDATE; :225, :233 resume/hold thunks -> web-sessions.ts:188 after FOR UPDATE; :228 isLive after the store returned; :276 step-up thunk -> web-sessions.ts:282 after FOR UPDATE (or after the connection wait). web-sessions.ts:300-301 are formatting (`new Date(ms)`), not clock reads. No pre-lock sample remains.
4. Behaviour deltas (notes): ENDED is judged before STALE, so a stale re-auth on an ended session now answers 401 (was 403): correct precedence. A stale re-auth now takes a connection and the session row lock before refusing (bounded 5 s, own session). STALE leaves the tx empty and commits; DENY STEP_UP_STALE fact still recorded (b11-sessions.test.ts:449 green).
5. 403 vs 422: 403 ASSURANCE_REQUIRED STEP_UP_STALE is the existing refusal (b11-sessions.test.ts:425); r7's "422" was mine, the builder's 403 is right.

## Family coverage (scope path -> covering test, red without the fix)
| Scope path | Covering test |
|---|---|
| r7 ADV-1 age at post-lock instant, service.ts:267-279 / web-sessions.ts:282-295 | C r7 DENY ACH-M-R2-EXPIRY (red: 201 vs 403, revert + narrow sabotage) |
| step-up liveness post-lock, web-sessions.ts:278-292 | A r6 / item A cells (r7 proofs, unchanged code path) |
| proof instants web-sessions.ts:294-301 | NONE (ADV-1 r8) |
| docs fix-proof.md:25/:75-76, authority.ts:9-10 | n/a (docs) |

Evidence observed: tree clean at start and end; every revert/sabotage restored with `git checkout HEAD -- <file>` and rebuilt.
