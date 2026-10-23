# OpenTofu reads this file and ignores the .tftest.hcl of the same name (OpenTofu testing docs). It is the .tftest.hcl without
# override_during, an argument OpenTofu does not accept (it already knows mocked values at plan). tools/test/aws-infrastructure.test.mjs
# keeps the two identical otherwise.
# Offline plan tests of the management root (Order 25 §8: TESTED_LOCAL with a mocked provider). They prove which guard policies this
# configuration renders and where it attaches them, never how AWS evaluates them (deploy/aws/checks evaluates the same documents).

mock_provider "aws" {
  mock_resource "aws_organizations_organization" {
    defaults = {
      id                = "o-abcdefghij"
      master_account_id = "000000000000"
      roots             = [{ id = "r-ab12", arn = "arn:aws:organizations::000000000000:root/o-abcdefghij/r-ab12", name = "Root", policy_types = [] }]
    }
  }
  mock_resource "aws_organizations_organizational_unit" {
    defaults = { id = "ou-ab12-mockmock" }
  }
  mock_resource "aws_organizations_policy" {
    defaults = { id = "p-mockmock", arn = "arn:aws:organizations::000000000000:policy/o-abcdefghij/service_control_policy/p-mockmock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/kauro-guard/kauro-budgets-spend-stop" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:000000000000:kauro-guard-alarms" }
  }
  mock_resource "aws_ce_anomaly_monitor" {
    defaults = { arn = "arn:aws:ce::000000000000:anomalymonitor/mock" }
  }
  mock_resource "aws_ssoadmin_permission_set" {
    defaults = { arn = "arn:aws:sso:::permissionSet/ssoins-mock/ps-mock" }
  }
  mock_data "aws_ssoadmin_instances" {
    defaults = { arns = ["arn:aws:sso:::instance/ssoins-mock"], identity_store_ids = ["d-mockmock"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

override_resource {
  target = module.organization.aws_organizations_account.data
  values = { id = "222222222222" }
}

override_resource {
  target = module.organization.aws_organizations_account.workload
  values = { id = "111111111111" }
}

variables {
  management_account_id    = "000000000000"
  monthly_ceiling_usd      = 70
  spend_stop_approval      = "MANUAL"
  owner_principal_id       = "906700000a-0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0"
  activation_authorization = { reference = "KAURO-ACT-2026-11-02-MANAGEMENT-1", gates_confirmed = [1, 2, 3, 4] }
}

run "nothing_is_planned_without_the_owners_activation" {
  command = plan
  variables {
    activation_authorization = null
  }
  expect_failures = [var.activation_authorization]
}

run "the_management_root_needs_gates_one_and_two" {
  command = plan
  variables {
    activation_authorization = { reference = "KAURO-ACT-2026-11-02-MANAGEMENT-1", gates_confirmed = [1] }
  }
  expect_failures = [var.activation_authorization]
}

run "a_ceiling_above_the_owners_funding_is_refused" {
  command = plan
  variables {
    monthly_ceiling_usd = 250
  }
  expect_failures = [var.monthly_ceiling_usd]
}

run "every_guard_policy_fits_the_organizations_size_limit" {
  command = plan

  assert {
    condition     = alltrue([for size in values(output.guard_policy_sizes) : size <= 5120])
    error_message = "An SCP or RCP exceeds 5,120 characters."
  }
}

run "guards_attach_to_the_member_ous_never_the_root_or_management" {
  command = plan

  assert {
    condition = toset(keys(output.guard_attachments)) == toset([
      "kauro-member-baseline:data", "kauro-member-baseline:workloads", "kauro-data-retention:data", "kauro-data-identity:data",
      "kauro-data-perimeter:data", "kauro-workload-guard:workloads",
    ])
    error_message = "The guard attachments differ from the D-21 design."
  }
}

run "the_guards_name_the_real_accounts_and_the_owners_sessions" {
  command = plan

  assert {
    condition     = strcontains(output.guard_policies["kauro-data-perimeter"], "arn:aws:iam::222222222222:role/kauro-deletion/*")
    error_message = "The RCP's bypass exception is the data account's deletion identity."
  }
  assert {
    condition     = strcontains(output.guard_policies["kauro-data-perimeter"], "\"aws:PrincipalOrgID\":\"o-abcdefghij\"")
    error_message = "The RCP's perimeter is this organization."
  }
  assert {
    condition     = strcontains(output.guard_policies["kauro-workload-guard"], "\"aws:ResourceAccount\":\"222222222222\"")
    error_message = "The workload guard closes the data account's resources."
  }
  assert {
    condition     = strcontains(output.guard_policies["kauro-data-identity"], "AWSReservedSSO_KauroDeletionPublisher_")
    error_message = "Only the owner's sessions publish the deletion function."
  }
  assert {
    condition     = alltrue([for doc in values(output.guard_policies) : !strcontains(doc, "$comment") && !strcontains(doc, "$${")])
    error_message = "A rendered guard keeps a comment or an unbound placeholder."
  }
}

run "the_management_accounts_own_actions_on_the_guards_alarm" {
  command = plan

  assert {
    condition     = toset(keys(output.management_alarm_patterns)) == toset(["kauro-guard-organization-trail", "kauro-guard-organization-policies"])
    error_message = "No SCP binds the management account: stopping the trail or detaching a guard must at least alarm."
  }
}

run "the_spend_stop_spares_the_owners_recovery_session" {
  command = plan

  assert {
    condition     = strcontains(output.spend_stop_policy, "ecs:RunTask") && strcontains(output.spend_stop_policy, "AWSReservedSSO_KauroOwnerAdministrator_")
    error_message = "The spend stop denies new tasks to everyone but the owner's administrator session."
  }
}
