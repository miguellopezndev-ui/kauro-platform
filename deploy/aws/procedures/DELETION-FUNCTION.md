# Publishing the retention/deletion function (D-19, D-21 A)

The deletion function is the only code that may bypass governance retention (its role, `kauro-deletion/kauro-<env>-retention-deletion`,
is the only principal the guards let do it). Its creation and every publication are **the owner's act, in the owner's Identity
Center session with MFA**: the data account's SCP (`scp-data-identity-guard.json`) denies every other principal the function, its
alias, its role, its code-signing configuration and the signing profiles, and the code-signing configuration is in `Enforce` mode,
so only a package signed by the owner's profile deploys. The same SCP binds the owner's sessions too in one respect: nobody can create the function without a code-signing configuration, detach it, or relax a configuration. No GitHub token, pipeline or builder credential is in this path
(D-21: GitHub Pro has no required reviewers for private repositories, so the approval cannot depend on GitHub).

**Status: NOT_IMPLEMENTED.** The function's code is B16's (what it deletes, when, from which authorization record) and does not
exist. The data root creates what the function needs (role, log group, signing profile, code-signing configuration, signing bucket);
it does not create the function. This procedure is ready for the day the code exists.

## Inputs

- The package `deletion-function.zip`, built from a reviewed, merged commit of `main` (its SHA-256 recorded in the release notes).
- The data root's outputs: `deletion.function_name`, `deletion.role_arn`, `deletion.code_signing_config_arn`,
  `deletion.signing_profile_name`, `deletion.signing_bucket`.

## Steps (owner, `KauroDeletionPublisher` session, about five minutes)

```sh
aws sts get-caller-identity          # must show AWSReservedSSO_KauroDeletionPublisher_… in the data account
sha256sum deletion-function.zip      # must equal the release notes

aws s3api put-object --bucket "$SIGNING_BUCKET" --key unsigned/deletion-function.zip --body deletion-function.zip
VERSION=$(aws s3api head-object --bucket "$SIGNING_BUCKET" --key unsigned/deletion-function.zip --query VersionId --output text)
JOB=$(aws signer start-signing-job --profile-name "$SIGNING_PROFILE" \
  --source "s3={bucketName=$SIGNING_BUCKET,key=unsigned/deletion-function.zip,version=$VERSION}" \
  --destination "s3={bucketName=$SIGNING_BUCKET,prefix=signed/}" --query jobId --output text)
aws signer describe-signing-job --job-id "$JOB"      # status Succeeded; note signedObject.s3.key

# First publication only:
aws lambda create-function --function-name "$FUNCTION" --runtime nodejs24.x --architectures x86_64 \
  --role "$ROLE_ARN" --handler index.handler --code "S3Bucket=$SIGNING_BUCKET,S3Key=<signed key>" \
  --code-signing-config-arn "$CSC_ARN" --timeout 900 --memory-size 512 --publish
# Every later publication:
aws lambda update-function-code --function-name "$FUNCTION" --s3-bucket "$SIGNING_BUCKET" --s3-key <signed key> --publish
aws lambda update-alias --function-name "$FUNCTION" --name live --function-version <new version>   # create-alias the first time
```

## Checks after publishing (QUALIFICATION.md part D)

1. `aws lambda get-function-code-signing-config --function-name "$FUNCTION"` names the code-signing configuration; its policy is `Enforce`.
2. An unsigned package is refused: `update-function-code` with `unsigned/deletion-function.zip` fails (`CodeVerificationFailedException`).
3. The data account's administrator role (not the owner's sessions) is refused `lambda:UpdateFunctionCode`, `iam:PassRole` of the
   deletion role and `signer:StartSigningJob` (AccessDenied naming the SCP).
4. The guard alarm `kauro-guard-deletion-function` e-mailed the owner for the publication.
5. The release notes record: commit, package SHA-256, signing job id, function version, the owner's session ARN, date.

## Rollback

`aws lambda update-alias --name live --function-version <previous version>`: the previous signed version stays published. A
version is never deleted while a deletion it performed may need to be explained.
