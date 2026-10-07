# AWS-HOLD-MFA r3: S3 replacement of the D-HOLD-4 provider fence (B07) and a Cognito second-factor proof (B11)
Planner r3, 2026-10-06. Base a7315df. r1 0392abb and r2 b56240f FAILED (adversary reviews `aws-hold-mfa-0392abb-adversary.json`,
`aws-hold-mfa-b56240f-adversary.json`); r3 resolves ADV-2, 11-14 per the coordinator rulings (§12). Appendix A = `AWS-HOLD-MFA-B14-IAM.md` (exact IAM statements,
alarms, real-account rows V7, V11, V13-V17). Input: AWS-DELTA §2.4, §2.7, §5 (Q-AWS-3/4/5). Evidence class: DESIGN; nothing ran against AWS (no account, D-14).
Governing: 09 "Soft delete, versioning and holds" (the 7-day deletion promise; a disclosed design may enable versioning); 08 "Authentication and assurance"; 07
"Transaction discipline"; B07 D-HOLD-1..4, D-OBJ-2; B06 D-ASSUR-1, D-EVID-1; B11 D-AUTH-2..4, D-W2-7; A9; owner D-19 (approved, §10).
**Honesty statement (ADV-5).** The Cloud Storage contracts and their tests are unchanged and keep running on the default fake profile. On the S3 profile, three B07
contracts are WEAKER, named as S3 variants with their own tests, and stay PARTIAL until B15 qualifies them on a real account: **D-HOLD-1/S3** (provider protection is
a 7-day renewable lease that depends on OBJECT_INVENTORY running, plus a bucket policy against overwrites; detected and alerted when it lapses: T15); **D-HOLD-3/S3**
(a release does not clear the provider protection: it lingers until `provider_hold_until` + 300 s; deletion is not delayed, because it bypasses: T18);
**D-OBJ-2/S3** (lifecycle removal of noncurrent versions is asynchronous with no documented bound: a measured value is recorded, V6). Every other S3 cell is GAP
until its new test passes; accepted tests count on S3 only when they are DB-level (§5 note).

## 1. AWS facts (fetched with curl from docs.aws.amazon.com, 2026-10-06; no web-search tool in this session)
| # | Fact | URL (prefix `https://docs.aws.amazon.com/`) |
|---|---|---|
| F1 | Object Lock needs versioning and protects only the named version. It does not stop new versions or delete markers. A versioned DELETE of a protected version returns 403. Any holder of PutObjectRetention can EXTEND a retain-until date. Overriding GOVERNANCE needs `s3:BypassGovernanceRetention` plus the header `x-amz-bypass-governance-retention:true`. COMPLIANCE cannot be shortened by anyone, root included. A legal hold is independent of retention. | AmazonS3/latest/userguide/object-lock.html |
| F2 | Once Object Lock is enabled it cannot be disabled, and versioning cannot be suspended. Lifecycle cannot delete a locked version. Delete markers are not WORM-protected. A bypass holder can delete a version, shorten retention, or REMOVE it with PutObjectRetention and EMPTY parameters. The console sends the bypass header automatically for any holder. Bypass does not affect a legal hold. A bucket policy with `s3:object-lock-remaining-retention-days` denies a retention longer than the limit. | AmazonS3/latest/userguide/object-lock-managing.html |
| F3/F4 | PutObjectLegalHold and PutObjectRetention have no precondition header; the retention call takes Mode, RetainUntilDate and the bypass header | AmazonS3/latest/API/API_PutObjectLegalHold.html, API_PutObjectRetention.html |
| F5 | `If-None-Match: *` returns 412 when a current version exists, but succeeds when the current version is a delete marker | AmazonS3/latest/userguide/conditional-writes.html |
| F6 | Conditional writes are enforced with `s3:if-none-match`. Multipart must be exempted with `s3:ObjectCreationOperation`. Under enforcement, CopyObject fails (403 or 501). | AmazonS3/latest/userguide/conditional-writes-enforce.html |
| F7-F11 | Cognito: ID token shape, acr/amr claims, levels (loa:4 = password + TOTP), refresh keeps acr, amr and auth_time, no trigger can alter acr/amr, federated acr/amr come from the IdP (`fed` only when the IdP sends nothing recognised), USER_AUTH with TARGET_ACR_VALUES/MAX_AGE (Essentials/Plus), JWKS/RS256/aud/token_use, MFA settings | cognito/latest/developerguide/{amazon-cognito-user-pools-using-the-id-token, cognito-user-pools-step-up-authentication, authentication-flows-selection-sdk, amazon-cognito-user-pools-using-tokens-verifying-a-jwt, user-pool-settings-mfa}.html |
| F12 | Lifecycle: "There may be a delay between the expiration date and the date at which Amazon S3 removes an object" | AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html |
| F13 | CloudTrail does not log S3 data events by default; they cost extra | AmazonS3/latest/userguide/cloudtrail-logging-s3-info.html |
| F14 | Lifecycle `AbortIncompleteMultipartUpload` with DaysAfterInitiation | AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html |
| F15 | UploadPartCopy pins a source version with `x-amz-copy-source: /bucket/key?versionId=<id>` | AmazonS3/latest/API/API_UploadPartCopy.html |
VERIFY in B15 on the real account (EXECUTED_PROVIDER, after D-14): V1 amr present on an ordinary sign-in; V2 RetainUntilDate precision; V3 VersionId max length; V4 a
presigned PUT whose signature covers If-None-Match is refused without it; V5 EventBridge "Object Deleted" shape; **V6 actual lag of noncurrent-version and
incomplete-upload expiry, and confirmation that a versioned delete leaves no listed version**; **V7 the condition key `s3:object-lock-mode`** (the Service
Authorization page is JS-rendered and could not be fetched); V8 the S8 deny allows CreateMultipartUpload/UploadPartCopy and refuses PutObject/Complete without the
header; V9 how the root user interacts with the S5 deny; **V10 the D-19 E2E: a customer deletion under active retention reaches DELETED, the version is gone, and
CloudTrail shows DeleteObjectVersion by the deletion role**. F16-F18 and V11-V17: Appendix A.

## 2. Design H: D-HOLD-5 (S3 profile of the seal-integrity hold)
The B07 hold is reason SEAL_INTEGRITY only (0020 CHECK); legal hold is reserved (S4). **Zones (ADV-12):** holds exist only in zone ACCEPTED (0020:202), so ONLY the
ACCEPTED bucket has Object Lock. QUARANTINE, STAGING, DELIVERY, PROFILE, MINIMIZED, IMPORT_RECEIPT buckets: versioning ON (stable VersionId), NO Object Lock, so a
version there can never be retained; S6/S7/S8, noncurrent and incomplete-upload expiry apply. LEGAL_FINANCE/SECURITY: untouched (09 legal profile).
1. **DB fence = authority.** D-HOLD-2/3 protocol unchanged. Migration 0045 (provisional) adds `object_holds.provider_hold_until` (at intent = `server_now()` +
   `S3_HOLD_LEASE_SECONDS` 601 200 = 7 d - 1 h, so the lock never exceeds 7 d under the S3 cap's rounding, V11; never decreases), `confirmed_hold_until` (observed
   lower bound; never decreases, trigger), `object_hold_reassertions.observed_hold_until` + finding in {HELD, GENERATION_NOT_LIVE, HOLD_SHORTENED, HOLD_LAPSED},
   `object_hold_releases.release_mode` in {PROVIDER_PRECONDITION (GCS), LAPSE (S3)} + `lapses_at`, append-only `kauro.object_retained_deletions` (object_id,
   generation, authorized_at), append-only `kauro.object_lock_findings` (§2.7), and StoredObject state `DELETION_BLOCKED_COMPLIANCE` (+ `compliance_until`;
   transitions DELETION_REQUESTED/DELETION_FAILED -> it, and it -> DELETION_REQUESTED only once server_now() >= compliance_until). `generation` = VersionId as
   `s3v1.<base64url>`; `kauro.is_generation` = int64 OR that form. **Lock order:** `kauro.lock_object_holds(object)` -> object_holds rows by hold id ->
   stored_objects row; never with a revision/upload/file lock (D-HOLD-2); every new writer (intent, SEALED, LAPSE, renewal intent, re-assertion record,
   retained-deletion authorization) takes it first.
2. **Extend-only backstop.** `placeHold(..., holdUntil)` = HeadObject (current VersionId must equal `generation`, else GENERATION_NOT_LIVE) then
   `PutObjectRetention(GOVERNANCE, holdUntil)` WITHOUT bypass, by `kauro-api` (seal, re-assertion) or `kauro-control` (renewal) only (S9); a 403 because a later date
   is set (race loser) is re-observed and answered HELD at the observed date, never PROVIDER_ERROR. HELD reports retain-until epoch ms as the incarnation. Late calls
   only extend (F1).
3. **Release never shortens.** Attempt cleanup (REFUSED/ABANDONED/replay) and the SEALED release at retention end make NO provider call: LAPSE with `lapses_at =
   provider_hold_until` read under the hold lock (a renewal committed before is included, T16).
4. **Deletion (ADV-1, ADV-12, owner condition 1).** *Ordinary path*: the nine call sites (storage-lifecycle.ts:97,132; upload-inspection.ts:240,520; janitor.ts:146
   via requestAndDelete; deletion-retries.ts:29; object-inventory.ts:200,272; retention.ts:113) stay in the general control process, role `kauro-control`, and call
   the plain `delete` = DeleteObjectVersion WITHOUT the bypass header (S7 allows it; S1 denies the header to them). It succeeds when no retention or legal hold is
   set. A 403 is classified by HeadObject(versionId): GOVERNANCE retention in the future -> **RETAINED_HANDOFF**: in one hold-locked unit of work the control process
   commits the `object_retained_deletions` authorization (guard KA071: object DELETION_REQUESTED/DELETION_FAILED, irreversible 0009:300-310; no hold INTENDED or
   SEALED; no release claim unanswered) and an outbox message (object id only) to `control-deletion`; the object stays DELETION_REQUESTED (no DELETION_FAILED dead
   end) and DELETION_RETRIES skips handed-off objects for 15 min. Legal hold ON -> DELETION_FAILED `LEGAL_HOLD` (alarm). COMPLIANCE -> `DELETION_BLOCKED_COMPLIANCE`
   (below). Nothing of these -> DELETION_FAILED `POLICY_DENIED` + alarm AL8. *Retained path*: `control-deletion` (role `kauro-storage-deletion`, own function,
   Appendix A2) takes an object id, re-reads the DB, re-runs the guard in its own hold-locked transaction (it trusts no message), then ONE
   `DeleteObjectVersion(versionId)` with `x-amz-bypass-governance-retention:true` (port `deleteRetained`) and records the deletion. It never lists prefixes, reads
   object bytes or inspects uploads. A sweep inside `control-deletion` (every 15 min) picks up authorizations without a DELETED object older than 5 min (lost
   message). A placement or renewal landing between authorization and delete is overridden by the same call; a legal hold is never bypassed (F2). **COMPLIANCE
   (ADV-13):** `deleteRetained` answering 403 with HeadObject mode COMPLIANCE -> state `DELETION_BLOCKED_COMPLIANCE` with `compliance_until` = the observed
   retain-until, a security fact, alarm AL8 and an owner card (generated text names object, scope, retain-until); visible in the operations read model; a sweep
   returns it to DELETION_REQUESTED once compliance_until passed. The S3 cap (7 d) bounds it. The plain `delete` contract is unchanged; the S3 branch drops the
   unclaimed release of `storage-work.ts:149`. Retention removal, if ever needed, = PutObjectRetention with EMPTY parameters + bypass (F2), never a past date
   (unused). The 09 seven-day promise holds: handoff is immediate, the retained delete ignores GOVERNANCE, and no lock outlives 7 d (T18, T21).
5. **Lapse detection.** OBJECT_INVENTORY renews every SEALED hold with `confirmed_hold_until` < now + `S3_HOLD_RENEW_AHEAD_SECONDS` 259 200 (renewal intent committed
   before the call); per SEALED hold HeadObject(versionId): missing -> GENERATION_MISSING revoke; delete marker or another current version -> GENERATION_CHANGED
   revoke; retain-until < confirmed -> HOLD_SHORTENED; no retention or retain-until <= now -> HOLD_LAPSED; both re-extend + security fact + metric (AL8). Heartbeat
   metric per run; AL7 after 36 h.
6. **Multipart copy.** `copy` = CreateMultipartUpload (destination metadata `kauro-copy-id` = destination object id) -> UploadPartCopy with source pinned
   `?versionId=` (F15) -> CompleteMultipartUpload `If-None-Match: *`. On 412 or NoSuchUpload: HeadObject the destination: own `kauro-copy-id` -> success with that
   VersionId; another object -> PRECONDITION_FAILED; **no object -> a retryable failure (transient; the caller retries the copy from a new upload; ADV-14)**.
   OBJECT_INVENTORY aborts incomplete uploads older than `COPY_UPLOAD_MAX_AGE_SECONDS` 3 600 (copy bound 900 s); lifecycle AbortIncompleteMultipartUpload 1 d is the
   backstop (F14; V6).
7. **COMPLIANCE audit over ALL versions (ADV-13).** OBJECT_INVENTORY, once per day per ACCEPTED location, pages ListObjectVersions and HeadObject's every version
   (registered or not, sealed or not); mode COMPLIANCE, a retain-until beyond now + 7 d, or a legal hold not recorded by break-glass -> `object_lock_findings` row
   (COMPLIANCE_LOCKED / RETENTION_OVER_CAP / LEGAL_HOLD_UNRECORDED), security fact, AL8 and an owner card. Cost: one HEAD per version per day.
**Bucket and IAM (B14 `infra/**`; ADV-2, owner condition 1): exact statements in Appendix A** (S1-S9 bucket policy; A2 deletion role on `lambda:SourceFunctionArn`;
A3 break-glass trust, disclosed holder; A4 deploy boundary D1-D7 with code signing and the release path; A5 alarms AL1-AL9 and CloudTrail data events). The adapter
refuses an ACCEPTED location without versioning/Object Lock or with a default retention (LOCATION_POLICY_UNQUALIFIED).
**D-OBJ-2/S3 (ADV-4).** A versioned delete keeps no soft-deleted copy: `softDeleteRetentionSeconds` = 0 for Kauro deletions (V6 confirms). Noncurrent versions arise
only out of band: `listSoftDeleted` lists them with `expiresAt = noncurrent_since + 1 d + S3_LIFECYCLE_LAG_ALLOWANCE` (configuration, 7 d until V6 measures),
evidence ESTIMATED, never presented as a bound.
**Port (additive).** `capabilities().holdFence: "PROVIDER_METAGENERATION" | "MONOTONIC_RETENTION"`; `placeHold(..., holdUntil?)`; `ObjectObservation.holdUntil?`,
`holdMode?`, `legalHold?`; `HoldRelease` + `"LAPSE"`; `delete` may answer `"RETAINED"`, `"LEGAL_HOLD"`, `"COMPLIANCE_LOCKED"`, `"POLICY_DENIED"` only when holdFence
is MONOTONIC_RETENTION; `deleteRetained?(location, name, generation): "DELETED" | "ALREADY_ABSENT" | "LEGAL_HOLD" | "COMPLIANCE_LOCKED"`. Fake: `profile: "S3"` with
principals (`as("api"|"control"|"deletion"|"deploy"|"break-glass")`) enforcing S1-S9.

## 3. Design M: D-AUTH-6 (Cognito second factor)
Verifier profile COGNITO (`identity-verifier.ts`): RS256 by JWKS kid; `iss` = pool; `aud` = app client; `token_use` = "id"; exp/iat/auth_time as today. **Federated
refused (ADV-8):** any `identities` claim or `fed` in `amr` -> defect `FEDERATED`. `secondFactor = "totp"` iff `amr` is a string array containing "otp" and "mfa" AND
`acr` = the configured level-4 value; passkey-only, SMS or e-mail OTP -> null (08: TOTP is the initial factor); malformed acr/amr -> CLAIM; neither acr nor amr ->
`assuranceClaims: "ABSENT"` (new optional field). Step-up with ABSENT -> 503 `CAPACITY_UNAVAILABLE` reason `ASSURANCE_CLAIMS_ABSENT`, not retryable (builder confirms
against `apps/api/test/outcome-catalogue.test.ts`), no proof, denial fact recorded (fail closed, ADV-9). Refresh (ADV-10): refresh keeps auth_time (F8), so freshness
counts from auth_time only; proof issuedAt = auth_time, a refresh never extends it (D-W2-7). Provider "cognito" (D-ID-2; no production identities yet). B06 files and
the assurance contract unchanged. Browser (S-E/B15): USER_AUTH, TARGET_ACR_VALUES=[loa:4], no access token (fresh sign-in). Pool (B14 tests): MFA OPTIONAL TOTP-only,
no device remembering, no IdP, Essentials, default ACR names.

## 4. Case map skeleton
| Case | Evidence after this design | Later (PARTIAL) | Tests |
|---|---|---|---|
| CMD017-OK/-RACE/-DENY (B07) | GCS: unchanged SIMULATED. S3: SIMULATED via T1-T20 | B15 EXECUTED_PROVIDER (V1-V10) | T4-T9, T19; DB-level acc tests |
| S053 (B07) | S3 SIMULATED | B15 | T2, T9, T11, T19 |
| D-19 condition 1 (deletion under retention) | SIMULATED | B15 V10, V16, V17 | T18, T21 |
| D-19 GOVERNANCE only / bypass exclusive | SIMULATED (fake principals) + B14 simulator tests | B15 V7, V11, V13, V14 | T3, T22; Appendix A tests |
| Step-up consumers CMD005/007/025/043 | SIMULATED (Cognito-shaped fake) | B15 Cognito live | M1-M8 |

## 5. Failure-mode matrix (S3 / Cognito profiles). Cells: a new test id = GAP until green. "acc-DB" = an accepted DB-level test,
valid on both profiles because the database has no profile (`source-adapters.test.ts:1229,1761,1869,1984`). Provider-level accepted tests
(`seal-holds.test.ts:264,346,424,498,602,675`, cmd017) are GCS only: their S3 variants are T4, T18, T6, T9/T8, T4/T5 and T19. Tier 1 = integrity/authority (rule 9).
| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| H1 intent UoW (+provider_hold_until) | T5 both orders (vs deletion request) | N/A: one DB statement; a lock wait is a journal 503 (acc-DB :1761) | T10 (bound from server_now) | acc-DB :1761 (rolled back) | T6 (intent committed, process dies before placing: abandoned, LAPSE, no provider call) | T13 | T5 (object enters deletion) | N/A: one INSERT per hold in one tx; T10 asserts all-or-none |
| H2 placeHold (Head+Put) | T1 (race loser → HELD) | T8 tier1 | N/A: date fixed at intent; bound enforced at H3 (KA072 acc-DB) | N/A: no DB write in this step | T6 tier1 (placed, answer lost by crash before H3) | T1, T13 | T5 | T8 (Head ok, Put lost) |
| H3 SEALED commit | T19 | N/A: DB tx; journal 503 | T19 (past the attempt bound → KA072) | T19 (crash before seal COMMIT: hold stays INTENDED → T6 path) | T19 (journal replay answers 200) | T13 | T19 (file revoked mid-seal → 409) | T10 (value set once with SEALED) |
| H4 post-commit re-assertion | T7 (vs renewal) | T8 | N/A: extend-only; lapse is H8 | N/A: after COMMIT, no own write before the record | T9 (record lost → inventory re-asserts) | T13 | T9 tier1 | T12 |
| H5 attempt cleanup = LAPSE | T4 tier1 (vs new seal) | N/A: no provider call (§2.3) | T10 (abandon before bound refused) | T10 | T4 (recorded once) | T4 | N/A: control-plane action, no user authority read | T10 (closeAttempt multi-row) |
| H6a SEALED release at retention end = LAPSE | T16 tier1 (vs renewal, both orders) | N/A: no provider call | T18 (at the retention deadline, TEST CLOCK) | T16 | T16 | T16 | N/A: sweep identity | T10 |
| H6b.1 retained-deletion authorization COMMIT (control) | T5 tier1 (vs intent, both orders) | N/A: one DB tx; a lock wait fails the run and DELETION_RETRIES repeats it | N/A: deletion has no deadline inside the step; the promise is end-to-end (T18, T21) | T17 (crash before COMMIT: no row, delete not issued) | T17 (row committed, crash: next run re-authorizes; append-only) | T17 | T18c (legal hold → LEGAL_HOLD) | N/A: single INSERT under guard |
| H6b.2 control-deletion: guard re-check + DeleteObjectVersion+bypass | T17 (late renewal in between: deleted anyway; two concurrent deleteRetained: DELETED + ALREADY_ABSENT) | T17 (unanswered -> sweep re-runs after 5 min) | N/A: no deadline in the call; a COMPLIANCE lock is T18d | N/A: the guard tx writes nothing | T17 (deleted, answer lost -> ALREADY_ABSENT) | T17 | T18c legal hold, T18d COMPLIANCE tier1 | N/A: one provider call |
| H6b.3 recordDeletion COMMIT | T17 (two recorders, both orders: one DELETED, the other a no-op; acc-DB :1229 for the residual) | N/A: one DB statement; a lock wait leaves the object for the sweep | N/A: no deadline on recording | T17 | T17 (sweep replays) | T17 | N/A: no authority is read; the object is irreversibly in deletion | N/A: single UPDATE (acc-DB :1229) |
| H11 ordinary delete + 403 classification + handoff (control) | T21 (handoff vs concurrent seal intent: refused KA071) | T21 (Head unanswered -> DELETION_FAILED, retried; never a bypass) | T21 (promise on the TEST CLOCK) | T21 (crash before handoff COMMIT: object stays DELETION_REQUESTED, retried) | T21 (handoff committed, message lost -> control-deletion sweep) | T21 (duplicate message: one deletion) | T21 (legal hold appears -> LEGAL_HOLD) | T21 (authorization ok, outbox fails: one tx, both or none) |
| H12 COMPLIANCE audit (all versions) | N/A: read-only audit with an append-only finding | T22 (Head unanswered -> next run) | T22 (retain-until beyond now + 7 d) | N/A: one INSERT per finding | T22 (finding recorded, card lost -> re-raised next run) | T22 (no duplicate finding per version and run) | N/A: the sweep acts on no user authority | N/A: one INSERT |
| H7 renewal intent+call+confirm | T16, T7 | T12 | T7 (before/at/after renew-ahead) | T12 | T12 | T13 | N/A: sweep identity fixed | T12 (intent ok, call fails) |
| H8 inventory reconciliation | T9 (vs seal) | T9 (Head unanswered → unconfirmed, retried) | T15 tier1 (sweep stalled 7 d + 1 s → HOLD_LAPSED + alarm) | N/A: reads, then the existing revoke tx (acc) | T9 (revocation event replay) | T9 | T9 tier1 | N/A: revocation is one tx (acc) |
| H9 location qualification | N/A: read-back with no shared row | T14 | N/A: no deadline | N/A: read-only until the record tx | N/A: an idempotent append, re-run safe | T14 | T14 (policy changed after boot) | N/A: single INSERT |
| H10 multipart copy + cleanup | T20 (abort sweep vs in-flight copy) | T20 (Complete answer lost → own copy-id recognised) | T20 (aged upload aborted) | N/A: no DB write inside the copy | T20 (copy done, crash before record: recognised by copy-id) | T20 | N/A: zone move, no user authority | T20 (parts copied, Complete refused 412) |
| A1 Cognito verify | M4 (kid rotation) | M4 | M7 | N/A: pure | N/A: pure | N/A: pure | M6 tier1 | N/A: pure |
| A2 stepUp record | b11-sessions:410 acc | M8 (claims absent → 503, nothing recorded) | M5, M7 | b11-sessions acc (rollback) | b11-sessions acc | b11-sessions acc | M6 tier1 | b11-sessions acc |
| A3 profile boot | N/A: single-threaded boot | N/A: no I/O | N/A: no deadline | N/A: no write | N/A: no write | N/A: deterministic | M3 (wrong profile refused) | N/A: no write |

## 6. Tests (exact titles; new files only)
`packages/application/test/source-provider-fakes-s3.test.ts`:
- T1 "OK S3 profile: placeHold extends a GOVERNANCE retain-until on exactly the current version and only ever later; a placement that loses to a later concurrent extension (403 without bypass) is re-observed and answers HELD at the later date, never PROVIDER_ERROR"
- T2 "DENY S3 profile: a retained version refuses a delete without bypass; an overwrite without If-None-Match, a copy onto its name and a simple delete are refused by the bucket policy; nothing changed (S053)"
- T3 "DENY S3 profile principals: only the deletion principal sends the bypass and deleteRetained deletes one version in one call; LEGAL_HOLD while a legal hold is on, COMPLIANCE_LOCKED under COMPLIANCE; PutObjectRetention in COMPLIANCE, beyond 7 days or by the deploy or break-glass principal is refused"
- T20 "RACE S3 profile multipart copy: source pinned to its versionId; a lost Complete answer is recognised by kauro-copy-id; a foreign object answers PRECONDITION_FAILED; NoSuchUpload with no destination object is a retryable failure; an upload older than COPY_UPLOAD_MAX_AGE_SECONDS is aborted by the sweep, a younger in-flight one is not" `apps/control/test/seal-holds-s3.test.ts`:
- T4 "RACE (late release) S3: the 09faf25 reproduction on the S3 profile: the cleanup records LAPSE and makes no provider call, a retry records nothing new, a new SealRevision extends and waits at its journal commit, an overwrite is refused and the seal commits the live held version"
- T5 "RACE (deletion vs seal) S3, both orders: an intent on an object in deletion is refused KA071 (503 GENERATION_NOT_OBSERVED), and a retained-deletion authorization is refused while a hold is INTENDED or SEALED"
- T6 "RACE (crash around placement) S3: a seal dies after its intent COMMIT and again after its extension landed; RETENTION abandons each past the bound, records LAPSE at provider_hold_until, and the revision then seals with a new extension"
- T7 "RACE (expiry) S3: OBJECT_INVENTORY renews a sealed hold within S3_HOLD_RENEW_AHEAD_SECONDS, renewal intent before the call, before/at/after the boundary on the TEST CLOCK, while a post-commit re-assertion runs"
- T8 "RACE (timeout) S3: an unanswered extension makes the seal 503 GENERATION_NOT_OBSERVED before commit and leaves the re-assertion unconfirmed after it; the late extension only extends and is recorded as observed"
- T9 "REVOCATION (out of band) S3: a version deleted with bypass, a retention shortened out of band and a delete marker on the name are found by OBJECT_INVENTORY: GENERATION_MISSING and GENERATION_CHANGED revoke the file naming the sealed revision, HOLD_SHORTENED re-extends and raises the security fact"
- T13 "RACE (retry) S3: a replayed SealRevision answers the journaled 200 with no extension beyond the recorded horizon; a duplicated OBJECT_INVENTORY run renews each hold once"
- T14 "DENY S3 location qualification: no versioning, no Object Lock or a default retention is refused before any write (LOCATION_POLICY_UNQUALIFIED); a later differing read-back is recorded and blocks new deletions until re-qualified"
- T15 "EXPIRY (sweep stall) S3: OBJECT_INVENTORY stopped for 7 days + 1 s on the TEST CLOCK; the next run records HOLD_LAPSED for every lapsed sealed hold, raises the alarm fact and re-extends; confirmed_hold_until never moves back"
- T16 "RACE (renewal vs retention release) S3, both orders under the hold lock: a renewal committed first is included in lapses_at; a release committed first makes the renewal refuse with no provider call"
- T17 "RACE (crash) S3 retained deletion: crashes before and after the authorization COMMIT and after the bypass delete; a late renewal between authorization and delete; an unanswered delete; two concurrent deleteRetained (DELETED and ALREADY_ABSENT, both orders); each ends DELETED with one authorization row per attempt"
- T21 "RACE (ordinary deletion) S3: kauro-control deletes an unretained version without bypass; a retained one answers 403, is classified RETAINED and handed off in one transaction with its authorization, and control-deletion deletes it within the seven-day promise on the TEST CLOCK; a lost message is recovered by the control-deletion sweep; a legal hold is LEGAL_HOLD, a 403 with no lock POLICY_DENIED with its alarm fact; never DELETION_FAILED for a retained version"
- T22 "EXPIRY (lock audit) S3: the daily audit HEADs every version of the ACCEPTED location, registered or not; COMPLIANCE, a retention beyond 7 days and an unrecorded legal hold are recorded once each with the security fact, the alarm metric and the owner card text" `apps/api/test/b07-s3-deletion-under-retention.test.ts` (owner condition 1, end-to-end through the routes and control consumers):
- T18 "D-19 condition 1: (a) a failed seal leaves a 7-day GOVERNANCE retention; the customer supersedes the revision (CMD012), STORAGE_LIFECYCLE deletes the revoked accepted generation: DB DELETED, no version left at the provider, within the 09 seven-day promise on the TEST CLOCK; (b) a sealed file at its retention end is released LAPSE and deleted the same way; (c) a legal hold makes it DELETION_FAILED LEGAL_HOLD, never bypassed; (d) a COMPLIANCE lock makes it DELETION_BLOCKED_COMPLIANCE, visible with its owner card, and once compliance_until passes it is deleted"
- T19 "CMD017 on the S3 profile: OK seals the held VersionId; DENY a changed version (409 GENERATION_CHANGED); past the attempt bound KA072; a crash before the seal COMMIT leaves the hold INTENDED; a replay answers the journaled 200; a file revoked mid-seal answers 409" `packages/persistence/test/source-holds-s3.test.ts`:
- T10 "DENY migration 0045: provider_hold_until set at intent from server_now() + S3_HOLD_LEASE_SECONDS; it and confirmed_hold_until never decrease; LAPSE is recorded under the hold lock with lapses_at = provider_hold_until; closeAttempt commits all or none; abandon before the bound is refused (KA071/KA072)"
- T11 "OK migration 0045: kauro.is_generation accepts the int64 and the s3v1 forms only; every pre-0045 row stays valid"
- T12 "PARTIAL S3 renewal and re-assertion: the intent commits and the provider call fails or is unanswered; provider_hold_until is only an upper bound, confirmed_hold_until keeps the observed value, the next sweep re-extends" `apps/api/test/identity-verifier-cognito.test.ts`:
- M1 "OK Cognito ID token: pool issuer, app-client aud, token_use id, RS256 by JWKS kid, amr [pwd, otp, mfa] and acr loa:4 give secondFactor totp"
- M2 "DENY Cognito ID token: an access token, another aud or iss, no amr claim, amr without otp or without mfa, acr below level 4, passkey-only, malformed acr or amr give the named defect or secondFactor null; an identities claim or fed in amr is refused FEDERATED even with loa:4"
- M3 "DENY Cognito profile: an Identity Platform token is refused under COGNITO and the reverse; the Cognito-shaped CONTRACT_FAKE is refused outside LOCAL"
- M4 "RACE (timeout) Cognito JWKS: an unanswered fetch is UNAVAILABLE (503); an unknown kid refreshes at most once a minute while another verify is in flight" `apps/api/test/b11-sessions-cognito.test.ts`:
- M5 "W2 step-up (Cognito): amr [pwd, otp, mfa] at most 300 s after auth_time records a STEP_UP proof method TOTP issued at auth_time that CMD025 accepts; a refreshed token is judged by its unchanged auth_time and never extends the proof; password-only, passkey and foreign-subject sign-ins are refused ASSURANCE_REQUIRED"
- M6 "REVOCATION (Cognito): an identity suspended in Kauro between the Cognito sign-in and the exchange is refused at session creation, at step-up and at the command gate although the token still verifies offline"
- M7 "EXPIRY step-up (Cognito): auth_time 299, 300 and 301 s old on the TEST CLOCK; the proof expires 900 s after auth_time"
- M8 "DENY step-up (Cognito) without assurance claims: a verified token with neither acr nor amr answers 503 ASSURANCE_CLAIMS_ABSENT, records no proof and records the denial fact"

## 7. Files touched (A6: only these parts are re-reviewed)
B07 (accepted 4b33e26): `packages/application/src/ports/source-providers.ts:43-170` (additive), `provider-holds.ts:59-139`, `seal-revision.ts:440-540`, the fake
(`profile: "S3"`), `packages/domain/src/model/source/{policy.ts,records.ts,index.ts}`, `packages/domain/src/ports/source-store.ts`,
`packages/persistence/src/source/{holds.ts,objects.ts}`, migration 0045, `apps/control/src/storage-work.ts:38-215`,
`sweepers/{object-inventory.ts,retention.ts,deletion-retries.ts}`, new `apps/control/src/deletion/{executor.ts,entry.ts}` (control-deletion), `docs/design/B07-upload-source-lifecycle.md` (D-HOLD-5; S3 variants of D-HOLD-1/3 and D-OBJ-2). B08:
`ports/worker-host.ts:35`. Data plane `artifact-writer.ts:45` (owned by lane B14-worker-host; coordinate). B06: none. B11 (not accepted):
`apps/api/src/{identity-verifier.ts,config.ts:90-100,300-315, bootstrap.ts:37,58}`, `packages/application/src/ports/sessions.ts:17-50` (additive: FEDERATED,
assuranceClaims), `sessions/service.ts:225-260`, `testing/identity-issuer.ts`, `docs/design/B11-agency-app.md` (D-AUTH-6). Integration:
`apps/api/src/composition.ts:469,511`. Elsewhere: B14 (Appendix A: S1-S9, D1-D7, A2/A3 roles, AL1-AL9, CloudTrail, lifecycle, `control-deletion` function, release
path, pool config), B15 (S3/Cognito adapters, V1-V10), S-E (web IdentityClient, CSP), LEGAL-D08B (`docs/legal/**`, §10).

## 8. Lane cut (by file ownership; models: designer and adversary Opus 5.5, builder Sonnet 5.5)
| Lane | Branch | Files | Cells | Done | Estimate (tokens, min) |
|---|---|---|---|---|---|
| L0 KIT | `aws/gen-kit` | new `packages/contracts/src/storage/generation.ts`, migration 0045 (incl. DELETION_BLOCKED_COMPLIANCE, lock findings), worker-host.ts:35 | T10, T11 | red then green; ci-local green | designer 90k/35, builder 180k/70 |
| L1 HOLD-S3 (after L0) | `aws/hold-s3` | B07 files of §7 except the migration; control-deletion; tests T1-T9, T12-T22 | H1-H12 | all T green and red-proven with the fix reverted; GCS suites unchanged and green; adversary PASS | designer 300k/115, builder 650k/240, adversary 130k/45 |
| L2 MFA (parallel) | `aws/mfa-cognito` | B11 files of §7; M1-M8 | A1-A3 | M green and red-proven; W2 tests unchanged and green | designer 100k/40, builder 200k/70, adversary 60k/20 |
| Outside this plan | B14-infra, B15, S-E, LEGAL-D08B | §7 "elsewhere" | V1-V10 | their lanes | not counted |

Total: about 1.71M agent tokens, about 10.6 agent-hours, about 6.5 h wall (L2 runs in parallel). B14 Appendix A work is the B14 lane's. Stop-loss at 2x per lane.
Codex reviews: the r3 design, then tier-1 lane reviews of L1 and L2, then the touched-part re-review of B07 and of B08 line 35.

## 9. Context packets (<= 3k tokens each; agents do not re-read the design)
**P-L0** (`repos/pw-aws-gen-kit`, origin/main). Read `0009_source_uploads_registry.sql:48-50,300-310`, `0020_source_object_holds.sql:74-160,195-300`,
`worker-host.ts:30-40`. Build §2.1 (columns, never-decrease triggers, release_mode/lapses_at, `object_retained_deletions` + KA071 guard, is_generation widening).
Harness `@kauro/persistence/testing` (`controlledClock`, `FaultPoints`, `bothOrders`, `faultCell`). Tests T10, T11. Done: red on base, green after; no existing
migration edited; ci-local green via run-heavy.
**P-L1 designer** (`repos/pw-aws-hold-s3`, rebased on L0). Read `source-providers.ts:43-170`, `provider-holds.ts:59-139`, `seal-revision.ts:440-540`,
`storage-work.ts:38-215`, `object-inventory.ts:1-60,140-275`, `retention.ts:90-115`, `consumers/storage-lifecycle.ts:85-135`, fake `:343-560,724-810` (holdNext,
failNext, plantObject, deleteOutOfBand), patterns in `apps/control/test/seal-holds.test.ts:264-675`, route harness `apps/api/test/cmd017-seal-revision.test.ts`.
Write T1-T9 and T12-T22 against the §2 S3 profile spec (ordinary vs retained deletion, §2.4; lock audit, §2.7); each fails on base for its stated reason (record the
assertion). Budget 300k/115 min. Report: titles, failing assertion per test, cells covered.
**P-L1 builder** (same worktree). Implement §2 parts 2-7, the port additions, the control-deletion executor and entry (object id in, guard re-check, one call), the
403 classification and handoff, and the S3 fake profile with principals S1-S9 (GOVERNANCE extend-only, bypass only via `deleteRetained`, COMPLIANCE and > 7-day
refusals, enforced If-None-Match, simple delete denied, multipart with copy-id, test helper `placeLegalHoldOutOfBand`); the application branches on `holdFence`; GCS
behaviour identical (every accepted test unchanged and green). Done: T1-T22 green; red-proof per test with src stashed; ci-local Linux green; no existing test file
edited. Budget 650k/240 min.
**P-L2** (`repos/pw-aws-mfa`). Read `identity-verifier.ts:1-40,160-245`, `config.ts:90-100,300-315`, `sessions.ts:17-60`, `service.ts:105-115,225-260`,
`identity-issuer.ts:1-120,330-350`, `b11-sessions.test.ts:410-470`, `outcome-catalogue.test.ts`. Implement §3: `KAURO_IDENTITY_PROFILE=COGNITO`,
`KAURO_COGNITO_{REGION,USER_POOL_ID,CLIENT_ID,ACR_LEVEL4}`; JWKS via `jwksResolver` + fetch cache; Cognito-shaped fake issuer (identities and fed variants). The
designer writes M1-M8 red first. Done: green and red-proven; W2 tests unchanged. Budget designer 100k/40, builder 200k/70.

## 10. Owner decision D-19: APPROVED by Miguel 2026-10-06 with two conditions (recorded, no longer a question)
Approved for customer-data buckets in S3: versioning (all zones) and Object Lock (ACCEPTED bucket only, permanent), no default retention, per-version GOVERNANCE
retentions of at most 7 days (lease 7 d - 1 h, renewable) only for seal integrity (D-HOLD-5), noncurrent expiration, legal hold reserved for a future owner decision.
Does not change R2: it is the disclosed design 09 allows ("unless a separately disclosed retention design is approved"); no lock outlives the 7-day promise and
nothing blocks lawful early deletion. **Condition 1** -> §2.4, Appendix A: GOVERNANCE only, never COMPLIANCE (S2 + S3 cap 7 d + S9 + lock audit T22 + the
DELETION_BLOCKED_COMPLIANCE outcome); `s3:BypassGovernanceRetention` only for the deletion identity (S1, A2 with `lambda:SourceFunctionArn`), unobtainable by deploy
(A4 D1-D7, code signing, AL1-AL9); break-glass DISCLOSED as a transitive holder (owner-only, MFA, 1 h; used only on an owner card); CloudTrail data events on;
end-to-end T18 + T21 (SIMULATED) and V10, V16, V17 (EXECUTED_PROVIDER, B15). **Condition 2**: the legal texts (D-08b, LEGAL-D08B, `docs/legal/**`) must not promise
"1 día"; wording "puede persistir unos días tras el borrado" (AWS documents no maximum, F12); the real lag is measured in qualification (V6) and recorded. The
coordinator routes the wording to LEGAL-D08B. **New owner act (light):** approve each `control-deletion` release as the required reviewer of the GitHub environment
`deletion-release` (rare; the function changes only with this design). MFA: no owner decision; Cognito Essentials, CloudTrail data events and the daily lock audit
HEADs are cost inputs to AWS-COST.md (B14).

## 11. Caveats (each is a cell or a cited decision)
- C1 The late release is closed by construction on S3 (no non-final shortening; the final deletion is one bypass call) -> H5, H6, T4, T5, T17.
- C2 A sweep stall is detected (T15, AL7), not prevented; meanwhile the DB fence and S1/S7 decide every delete.
- C3 Bypass holders, disclosed: `kauro-storage-deletion` (direct, only inside control-deletion), `kauro-break-glass` (transitive via S5, owner only), the root user (V9; owner MFA, CloudTrail alarm).
- C4 Without `s3:object-lock-mode` (V7) a S9 principal (`kauro-api`, `kauro-control`) could set COMPLIANCE <= 7 d: bounded by S3, detected (AL6, T22), outcome DELETION_BLOCKED_COMPLIANCE; the 7-day promise holds.
- C5 A step-up proof stays valid 900 s after the user removes TOTP: B06 D-ASSUR-1, 08 "policy registry owns freshness"; Kauro identity revocation -> M6.
- C6 Offline token verification: a Cognito-revoked token verifies until exp; used only at the exchange (auth_time <= 300 s) -> M6, M7.
- C7 V1-V17 keep every S3/Cognito/IAM row PARTIAL until B15 (D-14).

## 12. Resolution (r1: ADV-1..11 fixed in r2, 9 confirmed by b56240f; r3 below)
| Id | r3 resolution |
|---|---|
| ADV-2 BLOCKING | Appendix A: deploy boundary D1-D7 (PassRole, control-deletion code/config, role trust/policies, CloudTrail, alarms, owner principal, self-escalation); deletion role identity policy on `lambda:SourceFunctionArn` (F16); code signing + `kauro-release-deletion` path (F17); break-glass trust owner-only MFA 1 h (F18), disclosed (C3); AL1-AL9; simulator tests; V13-V15, V17. |
| ADV-12 MAJOR | §2.4: nine call sites stay in `kauro-control` with plain DeleteObjectVersion (S7); bypass header only via S1; 403 classified by HeadObject; RETAINED hands off through the DB-authorized path to control-deletion (object id only, never inspects uploads); only ACCEPTED is locked; row H11, T21, V16. |
| ADV-13 MAJOR | Cap 7 d (S3, lease 7 d - 1 h, V11); S9 limits PutObjectRetention to api, control, deletion; daily audit of all versions (§2.7, H12, T22, AL8); COMPLIANCE 403 -> DELETION_BLOCKED_COMPLIANCE + alarm + owner card, visible (T18d); V7 kept as a real-account row with the bounded residual (C4). |
| ADV-11 MINOR | N/A reasons on every cell of H6b.1-3, H11, H12; citation :1229; concurrent double deleteRetained in T17. |
| ADV-14 MINOR | NoSuchUpload with no destination object = retryable failure (§2.6, T20). |
