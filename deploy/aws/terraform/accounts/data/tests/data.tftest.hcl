# Offline plan tests of the data root (Order 25 §8: TESTED_LOCAL with a mocked provider). They prove what this configuration asks
# for — D-19's bucket settings, the composed bucket policies, the trail's data events, the alarms — never what AWS would enforce.

mock_provider "aws" {
  override_during = plan
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::kauro-mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::222222222222:role/kauro-deletion/kauro-qualification-retention-deletion" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:222222222222:kauro-guard-alarms" }
  }
  mock_resource "aws_signer_signing_profile" {
    defaults = { version_arn = "arn:aws:signer:us-east-1:222222222222:/signing-profiles/kauroqualificationdeletion/abcdefghij" }
  }
  mock_resource "aws_lambda_code_signing_config" {
    defaults = { arn = "arn:aws:lambda:us-east-1:222222222222:code-signing-config:csc-0123456789abcdef0" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

override_resource {
  override_during = plan
  target          = module.customer_data.aws_s3_bucket.this
  values          = { id = "kauro-qualification-customer-data-222222222222", arn = "arn:aws:s3:::kauro-qualification-customer-data-222222222222" }
}

override_resource {
  override_during = plan
  target          = module.journal.aws_s3_bucket.this
  values          = { id = "kauro-qualification-journal-222222222222", arn = "arn:aws:s3:::kauro-qualification-journal-222222222222" }
}

variables {
  organization_id                 = "o-abcdefghij"
  data_account_id                 = "222222222222"
  management_account_id           = "000000000000"
  workload_account_id             = "111111111111"
  s3_gateway_endpoint_id          = "vpce-0123456789abcdef0"
  owner_admin_role_pattern        = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_KauroOwnerAdministrator_*"
  deletion_publisher_role_pattern = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_KauroDeletionPublisher_*"
  activation_authorization        = { reference = "KAURO-ACT-2026-11-02-DATA-1", gates_confirmed = [1, 2, 3, 4] }
}

run "nothing_is_planned_without_the_owners_activation" {
  command = plan
  variables {
    activation_authorization = null
  }
  expect_failures = [var.activation_authorization]
}

run "the_customer_bucket_is_the_environments_and_the_data_accounts" {
  command = plan

  assert {
    condition     = output.customer_data_bucket == "kauro-qualification-customer-data-222222222222"
    error_message = "Customer-data bucket name."
  }
}

run "the_customer_bucket_policy_composes_the_data_and_worker_statements" {
  command = plan

  assert {
    condition = toset([for st in jsondecode(output.customer_data_bucket_policy).Statement : st.Sid]) == toset([
      "AttemptRolesWithinTheirCeiling", "ControlPlaneObjects", "ControlPlaneListing", "ControlPlaneCleansStagingOnly",
      "DeletesOutsideStagingOnlyByTheDeletionIdentity", "StagingDeletesOnlyByControlPlaneOrDeletionIdentity",
      "GovernanceBypassAndLegalHoldOnlyByTheDeletionIdentity", "BucketGuardsChangeOnlyInTheOwnerSession", "NeverComplianceMode",
      "NoObjectAcls", "NoOverwriteOutsideHeartbeats", "TlsOnly", "AttemptsOnlyThroughTheEndpoint", "CreateOnce", "AttemptsNeverDelete",
    ])
    error_message = "The customer bucket's statements differ from the data template plus the B14-A worker contract."
  }
  assert {
    condition     = strcontains(output.customer_data_bucket_policy, "\"aws:SourceVpce\":\"vpce-0123456789abcdef0\"")
    error_message = "Attempt roles reach the bucket only through the workload's S3 gateway endpoint."
  }
  assert {
    condition     = strcontains(output.customer_data_bucket_policy, "arn:aws:iam::111111111111:role/kauro-attempts/*")
    error_message = "The worker contract's ACCOUNT_ID is the workload account."
  }
  assert {
    condition     = !strcontains(output.customer_data_bucket_policy, "$${")
    error_message = "An unbound placeholder."
  }
}

run "the_journal_is_append_only" {
  command = plan

  assert {
    condition     = contains([for st in jsondecode(output.journal_bucket_policy).Statement : st.Sid], "AppendOnly")
    error_message = "The journal refuses an unconditional create."
  }
}

run "the_deletion_identity_alone_bypasses_and_its_function_is_not_created_here" {
  command = plan

  assert {
    condition     = output.deletion.function_name == "kauro-qualification-retention-deletion"
    error_message = "Function name."
  }
  assert {
    condition     = strcontains(output.deletion.policy, "s3:BypassGovernanceRetention")
    error_message = "The deletion identity holds the bypass."
  }
}

run "the_audit_bucket_admits_the_management_owned_organization_trail" {
  command = plan

  assert {
    condition     = strcontains(output.audit_bucket_policy, "arn:aws:cloudtrail:us-east-1:000000000000:trail/kauro-organization") && strcontains(output.audit_bucket_policy, "AWSLogs/000000000000/*")
    error_message = "The organization trail is owned by the management account even when the data account manages it."
  }
}

run "alarms_watch_the_guards" {
  command = plan

  assert {
    condition = toset(keys(output.guard_rule_patterns)) == toset([
      "kauro-guard-bucket-guards", "kauro-guard-retention-bypass", "kauro-guard-holds-by-others", "kauro-guard-trail",
      "kauro-guard-iam", "kauro-guard-deletion-function",
    ])
    error_message = "The guard alarms differ."
  }
}
