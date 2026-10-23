# AWS Organizations for Kauro (owner decision D-21 A with the owner's adjustment: three accounts). Applied only in the management
# account, in the owner's session. The management account holds the organization and billing and nothing else: no workload, no
# customer file, no trail of its own. SCPs and RCPs never restrict the management account (AWS Organizations user guide), so no
# guarantee below is claimed for it; its protection is that only the owner signs in to it, with MFA.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "policies_dir" {
  description = "deploy/aws/policies."
  type        = string
}

variable "allowed_region" {
  description = "The one Region every member account may use (legal checklist A-06: US Regions)."
  type        = string

  validation {
    condition     = can(regex("^us-(east|west)-[12]$", var.allowed_region))
    error_message = "Only a US Region is allowed (A-06)."
  }
}

variable "data_account" {
  description = "The data account: its root e-mail (a kaurodata.com alias, D-28) and display name."
  type        = object({ email = string, name = string })
}

variable "workload_account" {
  description = "The workload account: its root e-mail (a kaurodata.com alias, D-28) and display name."
  type        = object({ email = string, name = string })
}

variable "owner_admin_permission_set" {
  description = "Name of the owner's administrator permission set (identity-center module)."
  type        = string
}

variable "deletion_publisher_permission_set" {
  description = "Name of the owner's deletion-publisher permission set (identity-center module)."
  type        = string
}

resource "aws_organizations_organization" "this" {
  feature_set                   = "ALL"
  enabled_policy_types          = ["SERVICE_CONTROL_POLICY", "RESOURCE_CONTROL_POLICY"]
  aws_service_access_principals = ["cloudtrail.amazonaws.com", "sso.amazonaws.com"]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_organizations_organizational_unit" "data" {
  name      = "Data"
  parent_id = aws_organizations_organization.this.roots[0].id
}

resource "aws_organizations_organizational_unit" "workloads" {
  name      = "Workloads"
  parent_id = aws_organizations_organization.this.roots[0].id
}

# Creating a member account is the owner's act (Order 25 §9): this resource runs only in the owner's session, after the activation
# gate. An account that already exists is adopted with an import block (procedures/PROVISIONING.md), never re-created. Closing an
# account is never a Terraform side effect.
resource "aws_organizations_account" "data" {
  name                       = var.data_account.name
  email                      = var.data_account.email
  parent_id                  = aws_organizations_organizational_unit.data.id
  iam_user_access_to_billing = "DENY"
  close_on_deletion          = false

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

resource "aws_organizations_account" "workload" {
  name                       = var.workload_account.name
  email                      = var.workload_account.email
  parent_id                  = aws_organizations_organizational_unit.workloads.id
  iam_user_access_to_billing = "DENY"
  close_on_deletion          = false

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

locals {
  # Identity Center creates one role per permission set in each member account, under the reserved path that only AWS can write
  # (and that scp-member-baseline also closes): arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/[<region>/]AWSReservedSSO_<set>_<suffix>.
  # The suffix is matched as exactly sixteen characters, so a permission set named KauroOwnerAdministrator_x does not match
  # (QUALIFICATION A3 checks the real format).
  owner_admin_role_pattern        = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_${var.owner_admin_permission_set}_????????????????"
  deletion_publisher_role_pattern = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_${var.deletion_publisher_permission_set}_????????????????"

  template_vars = {
    ALLOWED_REGION                  = var.allowed_region
    ORG_ID                          = aws_organizations_organization.this.id
    DATA_ACCOUNT_ID                 = aws_organizations_account.data.id
    WORKLOAD_ACCOUNT_ID             = aws_organizations_account.workload.id
    OWNER_ADMIN_ROLE_PATTERN        = local.owner_admin_role_pattern
    DELETION_PUBLISHER_ROLE_PATTERN = local.deletion_publisher_role_pattern
  }

  # policy => [type, attached to]
  policies = {
    "kauro-member-baseline" = { file = "scp-member-baseline.json", type = "SERVICE_CONTROL_POLICY", targets = ["data", "workloads"] }
    "kauro-data-retention"  = { file = "scp-data-retention-guard.json", type = "SERVICE_CONTROL_POLICY", targets = ["data"] }
    "kauro-data-identity"   = { file = "scp-data-identity-guard.json", type = "SERVICE_CONTROL_POLICY", targets = ["data"] }
    "kauro-workload-guard"  = { file = "scp-workload-guard.json", type = "SERVICE_CONTROL_POLICY", targets = ["workloads"] }
    "kauro-data-perimeter"  = { file = "rcp-data-perimeter.json", type = "RESOURCE_CONTROL_POLICY", targets = ["data"] }
  }

  ou_ids = {
    data      = aws_organizations_organizational_unit.data.id
    workloads = aws_organizations_organizational_unit.workloads.id
  }

  attachments = merge([
    for name, policy in local.policies : {
      for target in policy.targets : "${name}:${target}" => { policy = name, target = target }
    }
  ]...)
}

module "policy" {
  source   = "../policy-template"
  for_each = local.policies

  templates = ["${var.policies_dir}/organization/${each.value.file}"]
  vars      = local.template_vars
}

resource "aws_organizations_policy" "this" {
  for_each = local.policies

  name        = each.key
  type        = each.value.type
  description = "Kauro Order 25 guard (deploy/aws/policies/organization/${each.value.file})"
  content     = module.policy[each.key].json

  lifecycle {
    precondition {
      condition     = module.policy[each.key].size <= 5120
      error_message = "${each.key} exceeds the 5,120-character limit of an SCP or RCP."
    }
  }
}

resource "aws_organizations_policy_attachment" "this" {
  for_each = local.attachments

  policy_id = aws_organizations_policy.this[each.value.policy].id
  target_id = local.ou_ids[each.value.target]
}

# CloudTrail's organization trail is created and kept in the data account (D-21: the trail and its alarms live there), which this
# makes the delegated administrator for CloudTrail. The management account keeps no trail of its own.
resource "aws_cloudtrail_organization_delegated_admin_account" "data" {
  account_id = aws_organizations_account.data.id
}

output "organization_id" {
  value = aws_organizations_organization.this.id
}

output "management_account_id" {
  value = aws_organizations_organization.this.master_account_id
}

output "data_account_id" {
  value = aws_organizations_account.data.id
}

output "workload_account_id" {
  value = aws_organizations_account.workload.id
}

output "workloads_ou_id" {
  value = aws_organizations_organizational_unit.workloads.id
}

output "owner_admin_role_pattern" {
  value = local.owner_admin_role_pattern
}

output "deletion_publisher_role_pattern" {
  value = local.deletion_publisher_role_pattern
}

output "policy_documents" {
  description = "The rendered guard policies, for tests and review."
  value       = { for name, _ in local.policies : name => module.policy[name].json }
}

output "policy_sizes" {
  value = { for name, _ in local.policies : name => module.policy[name].size }
}

output "attachments" {
  value = { for key, attachment in local.attachments : key => attachment }
}
