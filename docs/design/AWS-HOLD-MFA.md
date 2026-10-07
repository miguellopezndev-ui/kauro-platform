# AWS-HOLD-MFA: S3 replacement of the D-HOLD-4 provider fence (B07) and a Cognito second-factor proof (B11/B06)

Planner: kauro-planner, 2026-10-06. Base `origin/main` a7315df. Input: `origin/b14/aws-foundation:docs/design/AWS-DELTA.md` §2.4,
§2.7, §5 (Q-AWS-3, Q-AWS-4, Q-AWS-5). Evidence class of this document: DESIGN. Nothing ran against AWS (no account, D-14).
Governing: 09 "Soft delete, versioning and holds"; 08 "Authentication and assurance"; 07 "Transaction discipline"; B07 D-HOLD-1..4,
D-OBJ-2; B06 D-ASSUR-1, D-EVID-1; B11 D-AUTH-2..4, D-W2-7; A9. Nothing in an accepted contract or test is removed or weakened:
every existing test keeps running unchanged on the default (Cloud Storage) profile of the contract fake; S3 is a second profile.

## 1. AWS facts relied on (fetched from docs.aws.amazon.com with curl on 2026-10-06; no web-search tool in this session)
| # | Fact | URL |
|---|---|---|
| F1 | Object Lock works only with versioning; protects only the named version; does not prevent new versions or delete markers; a permanent DELETE (with versionId) of a protected version is 403; GOVERNANCE retention can be overridden only with `s3:BypassGovernanceRetention` + header `x-amz-bypass-governance-retention:true`; any holder of `s3:PutObjectRetention` can EXTEND a retain-until date (a later date replaces it); legal hold is independent of retention and removable by any holder of `s3:PutObjectLegalHold` | https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html |
| F2 | After Object Lock is enabled, it cannot be disabled and versioning cannot be suspended; lifecycle expiration cannot delete a locked version; delete markers are not WORM-protected | https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html |
| F3 | `PutObjectLegalHold` request headers: Content-MD5, checksum, request-payer, expected-bucket-owner. No If-Match / version precondition: a legal-hold change is unconditional (confirms Q-AWS-3) | https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObjectLegalHold.html |
| F4 | `PutObjectRetention`: Mode GOVERNANCE/COMPLIANCE, RetainUntilDate, bypass header; no precondition header | https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObjectRetention.html |
| F5 | `If-None-Match: *` on PutObject / CompleteMultipartUpload / CopyObject → 412 when a current version exists; in a versioned bucket it SUCCEEDS when the current version is a delete marker | https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html |
| F6 | Bucket policy condition keys `s3:if-none-match` / `s3:if-match` enforce conditional writes; multipart needs `s3:ObjectCreationOperation` exemption; under enforcement CopyObject fails (403 without header, 501 with it) | https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html |
| F7 | Cognito ID token: `iss https://cognito-idp.<region>.amazonaws.com/<poolId>`, `aud` = app client id, `token_use` = id, `auth_time`, and the `acr`/`amr` claims | https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html |
| F8 | ACR levels fixed: loa:4 = password + TOTP; `amr` values `pwd`, `otp` (TOTP), `sms`, `email_otp`, `swk`, `hwk`, `mfa` (two or more distinct factors), `fed`; acr/amr preserved on refresh and refresh does not reset `auth_time`; acr/amr cannot be customized, overridden, added or suppressed by a pre-token-generation or any other Lambda trigger; requesting step-up needs the Essentials or Plus plan | https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-step-up-authentication.html |
| F9 | USER_AUTH step-up: `TARGET_ACR_VALUES` + `MAX_AGE`; without ACCESS_TOKEN Cognito authenticates from scratch toward the target level; all-or-nothing; a token already at the level returns an error | https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-selection-sdk.html |
| F10 | Verify: RS256, JWKS at `<iss>/.well-known/jwks.json`, `aud` = app client id, check `token_use` | https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html |
| F11 | MFA optional/required, TOTP factor; required MFA restricts choice-based sign-in to PASSWORD/PASSWORD_SRP | https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html |
VERIFY (closed by B15 live qualification, EXECUTED_PROVIDER, after D-14): V1 `amr` present on an ordinary sign-in without
TARGET_ACR_VALUES and on the feature plan chosen; V2 RetainUntilDate precision read back by HeadObject; V3 VersionId max length;
V4 a presigned PUT that signs `If-None-Match: *` is refused when the browser drops it; V5 EventBridge "Object Deleted" event shape.

## 2. Design H: D-HOLD-5 (S3 profile of the seal-integrity hold)
Correction to the brief: the B07 hold is reason `SEAL_INTEGRITY` only (0020 CHECK; D-HOLD-1 "never a legal hold"); no legal-hold
product command exists. The D-HOLD-4 failure: an uncancelled late release clears a newer hold. S3 has no metageneration and no
precondition on hold changes (F3, F4), so the fence is rebuilt from three parts:
1. **DB fence (authority).** Unchanged D-HOLD-2/3 protocol (intent before the call, hold lock, release claims with `release_id`,
   KA071/KA072). Added (migration 0045, provisional number): `object_holds.provider_hold_until` (requested upper bound, set at intent
   = `server_now()` + `S3_HOLD_LEASE_SECONDS` 604 800, only ever moves later, CHECKed), `object_holds.confirmed_hold_until` (lower
   bound observed by HeadObject), `object_hold_reassertions.observed_hold_until`, `object_hold_releases.release_mode`
   (`PROVIDER_PRECONDITION` GCS | `LAPSE` S3 | `FINAL_BYPASS` S3). `generation` = the S3 VersionId in tagged form `s3v1.<base64url>`
   (`kauro.is_generation` widened to int64 OR that form; every existing row stays valid).
2. **Provider backstop that is monotonic by S3's own rule.** The S3 hold is a per-version GOVERNANCE retention, never a legal hold.
   `placeHold(location, name, generation, holdUntil)` = HeadObject (current VersionId must equal `generation`, else
   GENERATION_NOT_LIVE, as today) then `PutObjectRetention(versionId, GOVERNANCE, max(current, holdUntil))` WITHOUT bypass. Without
   bypass S3 only accepts a later date (F1), so every runtime call can only lengthen protection: a late placement or re-assertion
   is harmless by construction. HELD reports `metageneration` = retain-until in epoch ms (non-decreasing, fits the bigint column).
3. **No provider shortening except the final one.** Attempt cleanup (REFUSED, ABANDONED, replayed) issues NO provider call: the
   claim is answered `LAPSE` with `lapsesAt = provider_hold_until` (D-HOLD-3 bound becomes "no provider retention outlives the
   latest recorded provider_hold_until + PROVIDER_CLOCK_MARGIN 300 s"). The only shortening is `FINAL_BYPASS`
   (`PutObjectRetention` with bypass to now, then `DeleteObject(versionId)`), issued only under a claim, only for a
   `stored_objects` row in DELETION_REQUESTED/DELETION_FAILED; such an object can never take a hold again (0020 intent guard
   requires PRESENT/VERIFIED) and no release is decided while a hold is INTENDED or SEALED (KA071). So no late call can meet a newer
   hold. The S3 branch removes the unclaimed release of `storage-work.ts:149` (safe on GCS only through the metageneration).
Bucket (B14, infra/**): versioning Enabled + Object Lock enabled, NO default retention (unsealed objects stay freely deletable,
lawful early deletion never blocked: the deletion role bypasses); lifecycle `NoncurrentVersionExpiration` 1 day +
expired-delete-marker cleanup; bucket policy: Deny `s3:PutObject` when `s3:if-none-match` is Null (F6, multipart exempt);
Deny `s3:DeleteObject` (simple delete = delete marker, F5 hole) to every principal; Allow `s3:DeleteObjectVersion` and
`s3:BypassGovernanceRetention` only to the control-plane deletion role; Deny `s3:PutObjectLegalHold`, `PutBucketVersioning`,
`PutBucketObjectLockConfiguration`, `PutLifecycleConfiguration`, `PutBucketPolicy` except the deploy role (legal hold reserved
for a future owner-authorized LEGAL_HOLD design). Port `copy` uses UploadPartCopy + CompleteMultipartUpload(If-None-Match), not
CopyObject (F6). `readRetentionPolicy` reports `objectVersioning: true`, `softDeleteRetentionSeconds` = noncurrent expiration
(86 400, conservative upper bound for D-OBJ-2), and the adapter refuses a location without versioning, Object Lock, or with a
default retention (LOCATION_POLICY_UNQUALIFIED). `listSoftDeleted` = ListObjectVersions noncurrent versions + delete markers.
Out-of-band reconciliation (OBJECT_INVENTORY, apps/control): renews every SEALED hold whose confirmed_hold_until < now +
`S3_HOLD_RENEW_AHEAD_SECONDS` 259 200 (renewal intent committed before the call); per sealed hold HeadObject(versionId): missing →
GENERATION_MISSING revoke (existing step 4); current version is a delete marker or another version → GENERATION_CHANGED revoke;
retain-until below the confirmed value → re-extend + finding `HOLD_SHORTENED` (security fact); legal hold ON → deletion
DELETION_FAILED `LEGAL_HOLD`, never bypassed. Optional accelerator (B14, V5): S3 → EventBridge "Object Deleted" → SQS → inventory
of that key; the sweep stays the authority.
Port changes (additive): `capabilities().holdFence: "PROVIDER_METAGENERATION" | "MONOTONIC_RETENTION"`; `placeHold` 4th param
`holdUntil?: UtcInstant` (required when MONOTONIC_RETENTION); `ObjectObservation.holdUntil?`; `HoldRelease` gains `"LAPSE"`;
`generation` doc = opaque provider version token. Fake: `new ContractFakeObjectStorage({ profile: "S3" })`; default stays GCS.

## 3. Design M: D-AUTH-6 (Cognito second-factor proof)
Primary (verifiable, provider-signed): Cognito computes `acr`/`amr` and no trigger can forge or suppress them (F8). Verifier
profile `COGNITO` in `identity-verifier.ts`: RS256 by JWKS kid (F10), `iss` = pool issuer, `aud` = app client id, `token_use` =
"id", `exp`/`iat`/`auth_time` as today; `secondFactor = "totp"` iff `amr` is an array of strings containing `"otp"` AND `"mfa"`
AND `acr` equals the configured level-4 value (default `urn:cognito:loa:4`); `fed` in amr, passkey-only (`swk`/`hwk` without
otp), sms/email OTP → `secondFactor = null` (08: TOTP is the initial second factor). Malformed acr/amr → CLAIM. Provider name
`"cognito"` (D-ID-2: user id = UUIDv5(provider, sub); no production identities exist yet). The assurance contract is unchanged:
`VerifiedIdentityToken`, `stepUp` (secondFactor present, auth_time ≤ 300 s, proof method TOTP, B06 STEP_UP proof by
`kauro_assurance`, D-EVID-1, freshness 900 s D-ASSUR-1): B06 files are not touched.
Browser (S-E/B15): step-up = `InitiateAuth USER_AUTH` with `TARGET_ACR_VALUES=[loa:4]`, NO access token (fresh sign-in, F9),
then `RespondToAuthChallenge` (password, SOFTWARE_TOKEN_MFA); token handed to `POST /api/v1/assurance/step-ups`; client signs
out; CSP `connect-src` swaps Google origins for `https://cognito-idp.<region>.amazonaws.com` on D-AUTH-2 pages only.
Pool config (B14, asserted in Terraform tests): MFA OPTIONAL with SOFTWARE_TOKEN_MFA only, device remembering off, no federated
IdP on the app client, ALLOW_USER_AUTH, Essentials plan (F8/F9), default ACR names.
Fallback only if V1 fails (amr absent): Kauro-run TOTP is NOT chosen (it would store MFA seeds, 08 secrets surface); instead
step-up always goes through TARGET_ACR_VALUES (which then must yield acr/amr, F9) and the verifier refuses step-up tokens without
amr. If Cognito yields no acr/amr at all, the step-up route answers 503 ASSURANCE_UNAVAILABLE (fail closed) and a decision card is
raised; no weaker proof is accepted.

## 4. Case map skeleton
| Case | Evidence now (this design) | Later | Proving tests |
|---|---|---|---|
| CMD017-OK / -RACE / -DENY (B07) | SIMULATED on both fake profiles (EXECUTED_LOCAL DB side) | PARTIAL → EXECUTED_PROVIDER in B15 (S3 live, after D-14) | T1-T14 + existing seal-holds.test.ts:264,346,424,498,602,675 |
| S053 (B07) | SIMULATED (generation = VersionId observed before admission/seal) | PARTIAL → B15 | T2, T9, T11 |
| CMD005/025/007/043-OK step-up consumers (B16/B08/B06) | SIMULATED (Cognito-shaped fake) | PARTIAL → B15 Cognito live | M1-M7 + b11-sessions.test.ts:410 |

## 5. Failure-mode matrix (S3 / Cognito profiles; GCS cells stay as accepted in B07)
Cells: test id (§6) = C once green, GAP until then (all new tests are GAP now, written first); "acc" = accepted B07 test still
binding, unchanged; N/A with reason. Tier 1 = authority/integrity (rule 9).
| Row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| H1 seal intent UoW (+provider_hold_until) | GAP T5 (vs deletion request, both orders) + acc source-adapters:1761 | N/A one statement (journal 503) | GAP T10 (bound from server_now) | acc :1761 (intent rolled back) | N/A answer is the later seal | GAP T13 | GAP T5 (object enters DELETION_REQUESTED) | N/A single INSERT per hold, tx-atomic (acc :1761) |
| H2 placeHold S3 (Head + extend) | GAP T1 (two extenders, max wins) | GAP T8 tier1 | N/A attempt bound checked at H3 (acc KA072) | GAP T6 tier1 | N/A no commit in step | GAP T1/T13 | GAP T5 | GAP T8 (Head ok, Put lost) |
| H3 SEALED commit (incarnation = retain-until ms) | acc cmd017 RACE | N/A DB tx | acc KA072 past bound | acc seal-holds:424 | acc journal replay | acc | acc | N/A writes unchanged; value only (T10 asserts value) |
| H4 post-commit re-assertion | GAP T7 (vs renewal) | GAP T8 | N/A extend-only | N/A after commit | acc seal-holds:498(c) | GAP T13 | GAP T9 tier1 | GAP T12 |
| H5 attempt cleanup = LAPSE | GAP T4 tier1 (vs new seal) | N/A no provider call (by design D-HOLD-5 §2.3) | acc KA072 abandon-before-bound | GAP T10 | GAP T4 (answer lost, recorded once) | GAP T4 | N/A no authority read | GAP T10 (closeAttempt multi-row) |
| H6 FINAL_BYPASS release + delete version | GAP T5 tier1 | GAP T5 (late bypass lands, meets no hold) | acc claim bound | GAP T3 | GAP T3 (deleted, record lost → ALREADY_ABSENT) | GAP T3 (DELETION_RETRIES) | GAP T3 (legal hold ON → DELETION_FAILED) | GAP T3 (release ok, delete fails) |
| H7 inventory renewal | GAP T7 | GAP T12 | GAP T7 (before/at/after renew-ahead) | GAP T12 | GAP T13 | GAP T13 | N/A sweep identity fixed | GAP T12 |
| H8 inventory out-of-band reconciliation | GAP T9 (vs seal) | GAP T9 (Head unanswered → unconfirmed) | N/A | N/A reads + existing revoke tx (acc) | acc revoke event replay | GAP T9 | GAP T9 tier1 | N/A revoke is one tx (acc) |
| H9 location qualification | N/A read-back | GAP T14 | N/A | N/A record tx | N/A | GAP T14 (each read-back recorded) | GAP T14 (policy changed after boot) | N/A |
| A1 Cognito verify (JWKS) | GAP M4 (kid rotation) | GAP M4 | GAP M7 | N/A no write | N/A | N/A pure; replays handled by stepUp | GAP M6 tier1 | N/A |
| A2 stepUp proof record | acc :410 | N/A unchanged | GAP M7 | acc | acc | acc | GAP M6 tier1 (Kauro-suspended identity) | acc |
| A3 profile/config boot | N/A | N/A | N/A | N/A | N/A | N/A | GAP M3 (wrong profile refused) | N/A |

## 6. Tests (exact titles; new files only, existing files untouched)
`packages/application/test/source-provider-fakes-s3.test.ts`:
- T1 "OK S3 profile: placeHold extends a GOVERNANCE retain-until on exactly the current version and only ever later; an earlier request changes nothing and still answers HELD at the current retain-until; two concurrent placements end at the later date (D-HOLD-5)"
- T2 "DENY S3 profile: a retained version refuses delete without bypass, an overwrite or copy onto its name is refused by enforced If-None-Match, a simple delete is refused by the delete-marker deny; nothing changed (S053)"
- T3 "RACE (deletion) S3 profile: FINAL_BYPASS only for a DELETION_REQUESTED object under its claim; a lost delete answer replays ALREADY_ABSENT; a release that succeeds and a delete that fails stays DELETION_FAILED and DELETION_RETRIES finishes; a legal hold ON makes the deletion DELETION_FAILED LEGAL_HOLD and is never bypassed"
`apps/control/test/seal-holds-s3.test.ts`:
- T4 "RACE (late release) S3: the D-HOLD-4 reproduction of 09faf25 on the S3 profile: a failed seal's cleanup records LAPSE and issues no provider call, a retry past the claim bound records nothing new, a new SealRevision extends the retention and waits at its journal commit, an overwrite is attempted and the seal resumes: the new hold survives and the seal commits the live held version"
- T5 "RACE (deletion vs seal) S3: a deletion's FINAL_BYPASS held at the provider and a SealRevision of the same file, both orders: the intent is refused KA071 (503 GENERATION_NOT_OBSERVED) or the release is refused while the hold is INTENDED; the late bypass never meets a newer hold"
- T6 "RACE (crash between placement and commit) S3: a seal dies after its extension; RETENTION abandons it past the bound and records LAPSE at provider_hold_until; the revision then seals with a new extension the lapse never shortens"
- T7 "RACE (expiry) S3: OBJECT_INVENTORY renews a sealed hold whose confirmed_hold_until is within S3_HOLD_RENEW_AHEAD_SECONDS, renewal intent before the call, never one further out, at before/at/after the boundary on the TEST CLOCK, while a post-commit re-assertion runs"
- T8 "RACE (timeout) S3: an unanswered extension leaves the seal 503 GENERATION_NOT_OBSERVED before commit and the re-assertion unconfirmed after it; the late extension only extends and OBJECT_INVENTORY records the observed retain-until"
- T9 "REVOCATION (out of band) S3: a version deleted by a bypass principal, a retention shortened out of band and a delete marker on the name are each found by OBJECT_INVENTORY: GENERATION_MISSING and GENERATION_CHANGED revoke the file naming the sealed revision, a shortened retention is re-extended and recorded HOLD_SHORTENED; never a silent success"
- T13 "RACE (retry) S3: a replayed SealRevision answers the journaled 200 and issues no extension beyond the recorded horizon; a duplicated OBJECT_INVENTORY run renews each hold once"
- T14 "DENY S3 location qualification: a location without versioning, without Object Lock or with a default retention is refused before any write (LOCATION_POLICY_UNQUALIFIED); the noncurrent expiration is recorded as softDeleteRetentionSeconds; a later read-back that differs is recorded and refuses new deletions until re-qualified"
`packages/persistence/test/source-holds-s3.test.ts`:
- T10 "DENY migration 0045: provider_hold_until set at intent from server_now() + S3_HOLD_LEASE_SECONDS and only ever later; a LAPSE answer only for an object not in deletion, a FINAL_BYPASS claim only for DELETION_REQUESTED/DELETION_FAILED; closeAttempt of several holds commits all or none (KA071/KA072)"
- T11 "OK migration 0045: kauro.is_generation accepts the int64 form and the tagged s3v1 form only; every pre-0045 row stays valid"
- T12 "PARTIAL S3 renewal: the renewal intent commits and the provider call fails or is unanswered: provider_hold_until is only an upper bound, confirmed_hold_until keeps the observed value, the next sweep re-observes and re-extends"
`apps/api/test/identity-verifier-cognito.test.ts`:
- M1 "OK Cognito ID token: pool issuer, app-client aud, token_use id, RS256 by JWKS kid, amr [pwd, otp, mfa] and acr loa:4 verify with secondFactor totp"
- M2 "DENY Cognito ID token: an access token, another client's aud, another pool's iss, amr without otp or without mfa, acr below level 4, fed, passkey-only and malformed acr/amr yield the named defect or secondFactor null, never totp"
- M3 "DENY Cognito profile: an Identity Platform token is refused under COGNITO and a Cognito token under GOOGLE_X509; the Cognito-shaped CONTRACT_FAKE is refused outside LOCAL"
- M4 "RACE (timeout) Cognito JWKS: an unanswered fetch is UNAVAILABLE (503), an unknown kid refreshes at most once a minute while another verify is in flight, Cache-Control honoured"
`apps/api/test/b11-sessions-cognito.test.ts`:
- M5 "W2 step-up (Cognito): amr [pwd, otp, mfa] at most 300 s old records a STEP_UP proof method TOTP that CMD025 accepts; a refreshed token, a password-only or passkey sign-in and a foreign subject are refused ASSURANCE_REQUIRED"
- M6 "REVOCATION (Cognito): an identity suspended in Kauro between the Cognito sign-in and the exchange is refused at session creation, at step-up and at the command gate although the token still verifies offline"
- M7 "EXPIRY step-up (Cognito): auth_time 299, 300 and 301 s old on the TEST CLOCK; a proof expires at 900 s"

## 7. Files touched and A6 re-review scope (only these parts of accepted packages)
B07 (REVIEW_ACCEPTED 4b33e26): `packages/application/src/ports/source-providers.ts:43-170` (additive), `.../sources/provider-holds.ts:59-139`,
`.../sources/handlers/seal-revision.ts:440-540`, `.../testing/contract-fake-object-storage.ts` (S3 profile; GCS paths unchanged),
`packages/domain/src/model/source/{policy.ts:80-110,records.ts,index.ts}`, `packages/domain/src/ports/source-store.ts`,
`packages/persistence/src/source/holds.ts`, new `packages/persistence/migrations/0045_s3_hold_lease.sql`,
`apps/control/src/storage-work.ts:38-170`, `apps/control/src/sweepers/object-inventory.ts`, `docs/design/B07-upload-source-lifecycle.md`
(new D-HOLD-5 row; S3 notes on D-HOLD-1, D-OBJ-2). B08 (88cf29d): `packages/application/src/ports/worker-host.ts:35` (generation
regex → shared `isProviderGeneration`). Data-plane `packages/data-plane/src/attempt/artifact-writer.ts:45` (same; lane B14-worker-host
owns the file → coordinate). B06: NO file touched (not re-opened). B11 (not accepted): `apps/api/src/identity-verifier.ts`,
`apps/api/src/config.ts:97-99,300-315`, `apps/api/src/bootstrap.ts:37,58`, `packages/application/src/ports/sessions.ts:17-30` (doc),
`packages/application/src/testing/identity-issuer.ts` (Cognito profile), `docs/design/B11-agency-app.md` (D-AUTH-6).
Integration commit (coordinator + Codex doc-review): `apps/api/src/composition.ts:469,511`. Elsewhere: B14 `infra/**`, B15
`packages/adapters-*/**`, S-E `apps/web/src/client/identity/*`, `apps/web/test/security-headers.test.ts:26`.

## 8. Lane cut (by file ownership)
| Lane | Branch | Files | Cells | Done | Estimate | Model |
|---|---|---|---|---|---|---|
| L0 KIT | `aws/gen-kit` | `packages/contracts/src/storage/generation.ts` (new), migration 0045 (is_generation + hold columns + guards), worker-host.ts:35 | T10, T11 | T10/T11 red then green; ci-local green | designer 60k/25 min, builder 120k/45 min | Opus 5.5 / Sonnet 5.5 |
| L1 HOLD-S3 (after L0) | `aws/hold-s3` | every B07 file of §7 except migration; new tests T1-T9, T12-T14 | H1-H9 | all T green, each red with fix reverted (red-proof), all accepted hold tests unchanged and green, adversary PASS | designer 180k/70 min, builder 400k/150 min, adversary 100k/30 min | Opus / Sonnet / Opus |
| L2 MFA-COGNITO (parallel to L0/L1) | `aws/mfa-cognito` | B11 files of §7; new tests M1-M7 | A1-A3 | M1-M7 green and red-proven; b11-sessions.test.ts unchanged and green | designer 90k/35 min, builder 180k/60 min, adversary 60k/20 min | Opus / Sonnet / Opus |
| External | B14-infra, B15-adapters, S-E | bucket/pool Terraform + tests; S3/Cognito live adapters; web IdentityClient + CSP | V1-V5 | per their lanes | not in this total | n/a |
Total: about 1.19M agent tokens, about 7.5 agent-hours; wall about 4.5 h (L2 parallel). Codex: this design review, one tier-1
lane review each for L1 and L2 (integrity/authority), then the touched-part re-review of B07 (and B08 line 35).

## 9. Context packets
**P-L0 (designer, then builder)**. Worktree `repos/pw-aws-gen-kit` from origin/main. Read only: `packages/persistence/migrations/0009_source_uploads_registry.sql:48-50`
(is_generation), `0020_source_object_holds.sql:74-160,195-300` (hold columns, guards KA071/KA072), `packages/application/src/ports/worker-host.ts:30-40`.
Migration 0045 adds: `object_holds.provider_hold_until timestamptz` (set at INSERT = server_now() + 604800 s when the location's
holdFence is MONOTONIC_RETENTION, monotonic via forbid-decrease trigger), `confirmed_hold_until`, `object_hold_reassertions.observed_hold_until`,
`object_hold_releases.release_mode` CHECK IN ('PROVIDER_PRECONDITION','LAPSE','FINAL_BYPASS') default 'PROVIDER_PRECONDITION',
FINAL_BYPASS only when the object is DELETION_REQUESTED/DELETION_FAILED, LAPSE only otherwise (KA071); is_generation = existing
regex OR `^s3v1\.[A-Za-z0-9_-]{1,1368}$`. Harness: `@kauro/persistence/testing` (`controlledClock`, `FaultPoints`, `bothOrders`,
`faultCell`). Titles T10, T11 (§6). Done: red on base, green after; ci-local Linux green (via run-heavy); no existing migration edited.
**P-L1 designer**. Worktree `repos/pw-aws-hold-s3` (rebased on L0). Read: `source-providers.ts:43-170`, `provider-holds.ts:59-139`,
`seal-revision.ts:440-540`, `storage-work.ts:38-170`, `object-inventory.ts:1-60,140-200`, fake `contract-fake-object-storage.ts:343-560,724-810`
(holdNext, failNext, plantObject, deleteOutOfBand, generationsOf), model test `apps/control/test/seal-holds.test.ts:602-675` (the
D-HOLD-4 reproduction to mirror). Write T1-T9, T12-T14 in the new files of §6 against the S3 fake profile spec of §2 (write the
profile's expected behaviour, not code). Each test must fail on the current base for the stated reason (record the failing
assertion). Budget 180k tokens, 70 min. Report: titles, failing assertion per test, cells covered.
**P-L1 builder**. Same worktree. Implement §2 points 1-3 and the port additions exactly; S3 fake profile (`profile: "S3"`):
GOVERNANCE retain-until per version, extend-only without bypass, bypass only via release in FINAL_BYPASS, enforced If-None-Match,
simple delete denied, legal hold flag settable only by a test helper `placeLegalHoldOutOfBand`. Application branches on
`capabilities().holdFence`; GCS code paths must be byte-identical in behaviour (all accepted hold tests green, unchanged). Done:
T1-T14 green; red-proof per test with the src change stashed; ci-local Linux green; no edits to existing test files. Budget 400k, 150 min.
**P-L2 designer+builder**. Worktree `repos/pw-aws-mfa`. Read: `apps/api/src/identity-verifier.ts:1-40,160-245`, `apps/api/src/config.ts:90-100,300-315`,
`packages/application/src/ports/sessions.ts:17-60`, `packages/application/src/sessions/service.ts:105-115,225-260`,
`packages/application/src/testing/identity-issuer.ts:1-120,330-350`, `apps/api/test/b11-sessions.test.ts:410-470` (pattern).
Design per §3: profile `COGNITO` (`KAURO_IDENTITY_PROFILE`, `KAURO_COGNITO_REGION`, `KAURO_COGNITO_USER_POOL_ID`,
`KAURO_COGNITO_CLIENT_ID`, `KAURO_COGNITO_ACR_LEVEL4` default `urn:cognito:loa:4`), JWKS key source reusing `jwksResolver` with
fetch + Cache-Control cache; fake issuer gains a Cognito claim shape. Designer writes M1-M7 first (red); builder implements.
Done: M1-M7 green and red-proven; existing W2 tests unchanged and green; config refuses a Cognito profile with a GCP project id
and vice versa. Budget designer 90k/35 min, builder 180k/60 min.

## 10. Owner decision (owner card D-19)
**D-19 Diseño de retención divulgado para buckets de datos de clientes en S3 (09 "Soft delete, versioning and holds")** — antes del 10-oct; desbloquea B07 en AWS, B14 bucket, B15 S3.
- Decisión solicitada: aprobar para los buckets de datos de clientes: versionado ACTIVADO (permanente), Object Lock ACTIVADO
  (permanente, no se puede apagar, F2), SIN retención por defecto, retenciones GOVERNANCE por versión de 7 días renovables solo
  para la integridad del sellado (D-HOLD-5), expiración de versiones no actuales a 1 día, retención legal (legal hold) reservada a
  una decisión tuya futura.
- Recomendación: SÍ. Es la única forma en S3 de tener un identificador estable de versión y una protección del proveedor.
- Qué habilita: que un archivo sellado no pueda desaparecer bajo el sello en AWS (equivalente de D-HOLD-1/4); B15 S3 en vivo.
- Qué pasa si dices NO: sin versionado no hay VersionId ni Object Lock; la protección queda solo en la base de datos y en IAM;
  D-HOLD-1 pierde su respaldo del proveedor y Codex lo marcaría PARCIAL; CMD017/S053 no pasan de SIMULATED en AWS.
- Impacto: costo casi nulo (versiones no actuales ≤ 1 día; peticiones PutObjectRetention de centavos al mes). Borrado temprano
  legal sigue siendo inmediato (el rol de borrado omite GOVERNANCE). Copias de clientes borradas pueden persistir hasta 1 día como
  versión no actual: hay que decirlo en los textos legales (D-08b: dentro de la promesa de 7 días).
- Ejemplo: un cliente sube ventas.xlsx, se sella la revisión; aunque alguien con acceso intente borrarlo por consola, S3 lo niega
  durante la retención; cuando vence la retención del proyecto, Kauro lo borra de inmediato y no queda copia.
- Riesgos: Object Lock y versionado no se pueden desactivar en ese bucket (habría que crear otro); un rol de borrado comprometido
  puede omitir GOVERNANCE (igual que hoy en Google).
- ¿Cambia R2?: NO. Es la aprobación que 09 mismo prevé ("unless a separately disclosed retention design is approved"); no se
  activa ningún bloqueo que impida el borrado legal temprano. Se registra como decisión del dueño, no como enmienda.
MFA: no owner decision. Cognito Essentials plan is a cost input to AWS-COST.md (B14), inside the D-14 account grant.

## 11. Caveats (each is a cell or a cited decision)
- C1 Late release (D-HOLD-4): closed by construction on S3 (no non-final shortening; extend-only rule F1) → cells H5/H6, T4/T5.
  Not a time bound: no claim relies on a call finishing.
- C2 Unclaimed deletion release (`storage-work.ts:149`) is safe on GCS only through the metageneration; S3 branch claims it → T5.
- C3 Provider lapse window: if OBJECT_INVENTORY stops for > 4 days a sealed version loses its S3 backstop; the DB fence and IAM
  still decide every delete and T9 detects; recorded as HOLD_SHORTENED/renewal findings (tier 1 if unproven → T7/T12).
- C4 Root user and the deletion role can bypass GOVERNANCE (F1): parity with Google (holder of storage.objects.update); IAM
  boundary is B14's (S073); out-of-band deletes are reconciled by T9, never silent.
- C5 CopyObject is unusable under enforced conditional writes (F6): the S3 `copy` uses multipart copy; B15 qualifies.
- C6 Step-up proof stays valid 900 s after the user removes TOTP: B06 D-ASSUR-1 and 08 ("policy registry owns freshness"); the
  proof attests the re-authentication at auth_time; parity with Identity Platform. Revocation of the Kauro identity → M6.
- C7 Offline ID-token verification: a Cognito-revoked token verifies until exp; Kauro uses it only at the exchange (step-up
  auth_time ≤ 300 s); Kauro sessions are revoked by Kauro → M6, M7.
- C8 V1-V5 keep CMD017/S053/step-up consumers PARTIAL until B15 EXECUTED_PROVIDER (needs D-14 AWS account).
