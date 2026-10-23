# OpenTofu reads this file and ignores the .tftest.hcl of the same name (OpenTofu testing docs). It is the .tftest.hcl without
# override_during, an argument OpenTofu does not accept (it already knows mocked values at plan). tools/test/aws-infrastructure.test.mjs
# keeps the two identical otherwise.
# Offline plan tests of the protected bucket (D-19), mocked provider: what the configuration asks S3 for, not what S3 enforces.

mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::kauro-qualification-customer-data-222222222222", id = "kauro-qualification-customer-data-222222222222" }
  }
}

variables {
  name             = "kauro-qualification-customer-data-222222222222"
  policy_templates = ["../../../policies/data/customer-data-bucket.json", "../../../worker/bucket-policy.template.json"]
  policy_vars = {
    ACCOUNT_ID               = "111111111111"
    DATA_ACCOUNT_ID          = "222222222222"
    ENVIRONMENT              = "qualification"
    OBJECT_BUCKET            = "kauro-qualification-customer-data-222222222222"
    OWNER_ADMIN_ROLE_PATTERN = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_KauroOwnerAdministrator_*"
    S3_GATEWAY_ENDPOINT_ID   = "vpce-0123456789abcdef0"
    WORKLOAD_ACCOUNT_ID      = "111111111111"
  }
}

run "d19_versioning_object_lock_and_no_default_retention" {
  command = plan

  assert {
    condition     = aws_s3_bucket.this.object_lock_enabled == true
    error_message = "Object Lock is enabled at creation."
  }
  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning on."
  }
  assert {
    condition     = length(aws_s3_bucket_object_lock_configuration.this) == 0
    error_message = "D-19: no default retention on a customer bucket."
  }
  assert {
    condition     = aws_s3_bucket.this.force_destroy == false
    error_message = "A protected bucket is never force-destroyed."
  }
}

run "d19_noncurrent_versions_expire_after_one_day_and_uploads_abort" {
  command = plan

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].noncurrent_version_expiration[0].noncurrent_days == 1
    error_message = "D-19: noncurrent versions expire one day after they become noncurrent (the real lag is measured, A-20)."
  }
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].abort_incomplete_multipart_upload[0].days_after_initiation == 1
    error_message = "Incomplete multipart uploads are aborted after a day (worker contract)."
  }
  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.this.rule[0].expiration[0].expired_object_delete_marker == true
    error_message = "Current versions never expire on a bucket holding the worker's protocol keys (a delete marker reopens If-None-Match)."
  }
}

run "every_public_path_is_closed" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.this.block_public_acls, aws_s3_bucket_public_access_block.this.block_public_policy,
      aws_s3_bucket_public_access_block.this.ignore_public_acls, aws_s3_bucket_public_access_block.this.restrict_public_buckets,
    ])
    error_message = "Every public access block is on."
  }
  assert {
    condition     = aws_s3_bucket_ownership_controls.this.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "ACLs are disabled."
  }
  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "SSE-S3."
  }
}

run "a_default_retention_is_governance_never_compliance" {
  command = plan
  variables {
    default_retention_days = 180
  }

  assert {
    condition     = aws_s3_bucket_object_lock_configuration.this[0].rule[0].default_retention[0].mode == "GOVERNANCE"
    error_message = "GOVERNANCE only (D-19)."
  }
}

run "a_bucket_outside_the_guarded_names_is_refused" {
  command = plan
  variables {
    name = "customer-data"
  }
  expect_failures = [var.name]
}
