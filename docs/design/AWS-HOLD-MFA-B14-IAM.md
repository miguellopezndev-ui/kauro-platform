# AWS-HOLD-MFA r3, Appendix A: B14 obligations (exact IAM statements) for owner condition 1 (D-19)

Owner: lane B14-infra (`infra/**`). Main design: `AWS-HOLD-MFA.md` §2 and §10. Placeholders: `${ACCT}`, `${REGION}`,
`${ACCEPTED_BUCKET}` (the only bucket under Object Lock), `${CUSTOMER_BUCKETS}` (ACCEPTED + QUARANTINE + STAGING + DELIVERY +
PROFILE + MINIMIZED + IMPORT_RECEIPT), `${OWNER_PRINCIPAL}` (the owner's IAM Identity Center permission-set role ARN, or an IAM
user ARN). Roles:
- `kauro-deploy`: Terraform/CI
- `kauro-control`: the general control process, which hosts the nine ordinary deletion call sites
- `kauro-api`: seal and re-assertion
- `kauro-storage-deletion`: the execution role of the `control-deletion` function
- `kauro-break-glass`: owner only
- `kauro-release-deletion`: the only path that deploys `control-deletion`

Each statement below has a B14 test (IAM policy simulator, or `terraform test` with simulated principal calls) and a B15 row on
the real account (§V).

## A1. Bucket policy of `${ACCEPTED_BUCKET}`
All are explicit Deny with `"Principal": "*"`. Statements S6, S7 and S8 also go on every other `${CUSTOMER_BUCKETS}` bucket;
there S7 lists `kauro-control` only.

| Id | Action(s) | Condition (the Deny applies when…) |
|---|---|---|
| S1 | `s3:BypassGovernanceRetention` | `ArnNotEquals aws:PrincipalArn` = `kauro-storage-deletion` |
| S2 | `s3:PutObjectRetention` | `StringEquals s3:object-lock-mode` = `COMPLIANCE` (V7) |
| S3 | `s3:PutObjectRetention` | `NumericGreaterThan s3:object-lock-remaining-retention-days` = `7` (owner: never more than 7 d; lease 601 200 s, V11) |
| S4 | `s3:PutObjectLegalHold` | `ArnNotEquals aws:PrincipalArn` = `kauro-break-glass` |
| S5 | `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy`, `s3:PutBucketObjectLockConfiguration`, `s3:PutBucketVersioning`, `s3:PutLifecycleConfiguration`, `s3:PutReplicationConfiguration` | `ArnNotEquals aws:PrincipalArn` = `kauro-break-glass` |
| S6 | `s3:DeleteObject` (a simple delete, which creates a delete marker) | always |
| S7 | `s3:DeleteObjectVersion` | `ArnNotEquals aws:PrincipalArn` = [`kauro-control`, `kauro-storage-deletion`] |
| S8 | `s3:PutObject` | `Null s3:if-none-match` = `true` AND `Bool s3:ObjectCreationOperation` = `true` |
| S9 | `s3:PutObjectRetention` | `ArnNotEquals aws:PrincipalArn` = [`kauro-api`, `kauro-control`, `kauro-storage-deletion`] |

What S7 does NOT do: it does not grant the bypass. A versioned delete by `kauro-control` on a retained version gets 403
(object-lock.html). Only S1 decides the bypass header, and only `kauro-storage-deletion` passes it. This is ADV-12 (ii).

## A2. Identity policy of `kauro-storage-deletion` (inline; no managed policy, so no policy versions)
```json
{"Version":"2012-10-17","Statement":[{"Sid":"RetainedDeleteOnlyFromControlDeletion","Effect":"Allow",
 "Action":["s3:BypassGovernanceRetention","s3:DeleteObjectVersion","s3:GetObject","s3:GetObjectVersion","s3:GetObjectRetention","s3:GetObjectLegalHold"],
 "Resource":"arn:aws:s3:::${ACCEPTED_BUCKET}/*",
 "Condition":{"ArnEquals":{"lambda:SourceFunctionArn":"arn:aws:lambda:${REGION}:${ACCT}:function:control-deletion"}}}]}
```
`lambda:SourceFunctionArn` is valid only in identity-based policies or SCPs, never in a bucket policy (F16). Trust policy:
`Principal.Service = lambda.amazonaws.com`, `Condition.StringEquals aws:SourceAccount = ${ACCT}`.

## A3. Trust policy of `kauro-break-glass` (disclosed bypass holder: it can rewrite the bucket policy through S5)
```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"${OWNER_PRINCIPAL}"},"Action":"sts:AssumeRole",
 "Condition":{"Bool":{"aws:MultiFactorAuthPresent":"true"},"NumericLessThan":{"aws:MultiFactorAuthAge":"900"}}}]}
```
Settings: `MaxSessionDuration = 3600` (the minimum AWS allows). It is used only on an owner card. Every AssumeRole raises an
alarm (A5).

## A4. Permission boundary on `kauro-deploy`
The boundary's Allow is `*` in the account (B14 scopes it). Its Deny statements, with `Resource` = the deletion, break-glass and
release roles, the `control-deletion` function, the trail and the alarm resources:

| Id | Denied actions | Resource |
|---|---|---|
| D1 | `iam:PassRole` | `kauro-storage-deletion`, `kauro-break-glass`, `kauro-release-deletion` |
| D2 | `lambda:CreateFunction`, `UpdateFunctionCode`, `UpdateFunctionConfiguration` (layers, environment, role), `DeleteFunction`, `PublishVersion`, `CreateAlias`, `UpdateAlias`, `PutFunctionCodeSigningConfig`, `DeleteFunctionCodeSigningConfig`, `AddPermission` | `function:control-deletion*` |
| D3 | `iam:UpdateAssumeRolePolicy`, `PutRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `DeleteRolePolicy`, `PutRolePermissionsBoundary`, `DeleteRolePermissionsBoundary`, `UpdateRole`, `DeleteRole` | the three roles above |
| D4 | `iam:DeleteRolePermissionsBoundary`, `PutRolePermissionsBoundary`, `CreatePolicyVersion`, `SetDefaultPolicyVersion` | `kauro-deploy` itself and its boundary policy (no self-escalation) |
| D5 | `cloudtrail:StopLogging`, `DeleteTrail`, `PutEventSelectors`, `PutInsightSelectors`, `UpdateTrail` | the Kauro trail; plus S5-like actions on the trail log bucket |
| D6 | `iam:CreateAccessKey`, `CreateLoginProfile`, `UpdateLoginProfile`, `DeactivateMFADevice`, `EnableMFADevice`, `ResyncMFADevice`, `sso:*`, `identitystore:*` | `${OWNER_PRINCIPAL}` |
| D7 | `cloudwatch:DeleteAlarms`, `DisableAlarmActions`, `PutMetricAlarm`, `events:DeleteRule`, `DisableRule`, `PutRule`, `RemoveTargets`, `sns:DeleteTopic`, `sns:SetTopicAttributes`, `sns:Unsubscribe` | the security alarms, their rules and their topic |

Enforcement:
- `iam:CreateRole` and `iam:CreateUser` are allowed only with `iam:PermissionsBoundary` = this boundary (condition).
- A new role still cannot bypass, because S1 names one ARN.
- `control-deletion` has a code-signing configuration in Enforce mode (F17). Its signing profile is usable only by
  `kauro-release-deletion`.
- `kauro-release-deletion` is assumable only from a GitHub environment `deletion-release` (OIDC `sub` = that environment)
  that has a required reviewer. Every use is audited (A5).

## A5. Alarms
EventBridge on CloudTrail management events → SNS → owner e-mail. Plus CloudWatch metric alarms. Each is tested by a B14 test
event.

| Alarm | Fires on |
|---|---|
| AL1 | `lambda:CreateFunction` or `UpdateFunction*` naming `control-deletion` or the deletion role |
| AL2 | any D3 action on the three roles |
| AL3 | `sts:AssumeRole` of `kauro-break-glass` or `kauro-release-deletion` |
| AL4 | `cloudtrail:StopLogging`, `DeleteTrail`, `PutEventSelectors`, `UpdateTrail` |
| AL5 | any S5 action on a customer bucket, and any `AccessDenied` on S1/S2/S3/S9 (data events) |
| AL6 | `PutObjectRetention` with mode COMPLIANCE (data event) |
| AL7 | the OBJECT_INVENTORY heartbeat missing for 36 h |
| AL8 | the HOLD_LAPSED, HOLD_SHORTENED, COMPLIANCE_LOCKED, POLICY_DENIED and DELETION_BLOCKED_COMPLIANCE metrics > 0 |
| AL9 | `PutFunctionCodeSigningConfig` / `DeleteFunctionCodeSigningConfig` |

CloudTrail data events on `${CUSTOMER_BUCKETS}` cover DeleteObject*, PutObjectRetention, PutObjectLegalHold and
CompleteMultipartUpload. Logs go to a log bucket under its own Object Lock and the same S5 protection.

## A6. Facts (curl from docs.aws.amazon.com, 2026-10-06)
- **F16**: `lambda:SourceFunctionArn` "in an IAM identity-based policy or SCP … cannot use … in resource-based policies"
  (https://docs.aws.amazon.com/lambda/latest/dg/permissions-source-function-arn.html).
- **F17**: code signing in Enforce mode "blocks the deployment of the code package"; it "only prevent[s] new deployments of
  unsigned code" (https://docs.aws.amazon.com/lambda/latest/dg/configuration-codesigning.html).
- **F18**: `aws:MultiFactorAuthPresent` / `aws:MultiFactorAuthAge` in a role trust policy
  (https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html).

## §V. Real-account rows (B15, EXECUTED_PROVIDER, after D-14)
| Row | Check |
|---|---|
| V7 | `s3:object-lock-mode` exists and S2 denies COMPLIANCE. If absent: residual = a COMPLIANCE lock ≤ 7 d by a S9 principal, detected by T22/AL6/AL8 and recorded DELETION_BLOCKED_COMPLIANCE; the 7-day promise still holds through the S3 cap |
| V11 | the rounding of `s3:object-lock-remaining-retention-days`: a 601 200 s lease passes and 7 d + 1 h is denied |
| V13 | `lambda:SourceFunctionArn`: the deletion role's credentials used outside `control-deletion` get AccessDenied |
| V14 | `kauro-deploy` gets AccessDenied for every D1-D7 action and cannot assume `kauro-break-glass` |
| V15 | each AL1-AL9 delivers within 15 min |
| V16 | `kauro-control` deletes an unretained version and gets 403 on a retained one, without the bypass header |
| V17 | the console with `kauro-control` credentials cannot bypass (S1) |
