# IAM Identity Center permission sets for the owner (D-21 A). Applied in the management account after the owner enables Identity
# Center there (a console step: AWS offers no API to enable an organization instance) and sets MFA to "every time they sign in"
# (also a console setting, procedures/ACTIVATION.md gate 2). The guard policies recognise these sessions by role name, because
# aws:MultiFactorAuthPresent is absent for federated sessions (IAM condition-keys reference): MFA is Identity Center's guarantee,
# proved live (PENDING_PROVIDER), not a policy condition.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "policies_dir" {
  type = string
}

variable "region" {
  type = string
}

variable "owner_principal_id" {
  description = "The owner's Identity Center user id (identity store). Null until the owner's user exists; no assignment is made without it."
  type        = string
  default     = null
}

variable "data_account_id" {
  type = string
}

variable "workload_account_id" {
  type = string
}

variable "management_account_id" {
  type = string
}

variable "owner_admin_permission_set" {
  type = string
}

variable "deletion_publisher_permission_set" {
  type = string
}

variable "signing_bucket" {
  description = "The data account's signing-artifact bucket (deletion-function module naming)."
  type        = string
}

data "aws_ssoadmin_instances" "this" {}

locals {
  instance_arn      = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]
}

resource "aws_ssoadmin_permission_set" "owner_admin" {
  name             = var.owner_admin_permission_set
  description      = "Kauro owner: administration of the member accounts (Terraform applies). MFA on every sign-in."
  instance_arn     = local.instance_arn
  session_duration = "PT1H"
}

resource "aws_ssoadmin_managed_policy_attachment" "owner_admin" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.owner_admin.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_ssoadmin_permission_set" "deletion_publisher" {
  name             = var.deletion_publisher_permission_set
  description      = "Kauro owner: sign and publish the retention/deletion function (D-21 A). Nothing else."
  instance_arn     = local.instance_arn
  session_duration = "PT1H"
}

module "publisher_policy" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/data/deletion-publisher.policy.json"]
  vars = {
    REGION          = var.region
    DATA_ACCOUNT_ID = var.data_account_id
    SIGNING_BUCKET  = var.signing_bucket
  }
}

resource "aws_ssoadmin_permission_set_inline_policy" "deletion_publisher" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.deletion_publisher.arn
  inline_policy      = module.publisher_policy.json
}

resource "aws_ssoadmin_permission_set" "owner_read_only" {
  name             = "KauroOwnerReadOnly"
  description      = "Kauro owner: read-only inspection of every account (billing included). The everyday session."
  instance_arn     = local.instance_arn
  session_duration = "PT4H"
}

resource "aws_ssoadmin_managed_policy_attachment" "owner_read_only" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.owner_read_only.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

locals {
  # Which session the owner gets in which account. The publisher exists only in the data account.
  assignments = var.owner_principal_id == null ? {} : {
    "admin:data"          = { set = aws_ssoadmin_permission_set.owner_admin.arn, account = var.data_account_id }
    "admin:workload"      = { set = aws_ssoadmin_permission_set.owner_admin.arn, account = var.workload_account_id }
    "admin:management"    = { set = aws_ssoadmin_permission_set.owner_admin.arn, account = var.management_account_id }
    "publisher:data"      = { set = aws_ssoadmin_permission_set.deletion_publisher.arn, account = var.data_account_id }
    "readonly:data"       = { set = aws_ssoadmin_permission_set.owner_read_only.arn, account = var.data_account_id }
    "readonly:workload"   = { set = aws_ssoadmin_permission_set.owner_read_only.arn, account = var.workload_account_id }
    "readonly:management" = { set = aws_ssoadmin_permission_set.owner_read_only.arn, account = var.management_account_id }
  }
}

resource "aws_ssoadmin_account_assignment" "owner" {
  for_each = local.assignments

  instance_arn       = local.instance_arn
  permission_set_arn = each.value.set
  principal_id       = var.owner_principal_id
  principal_type     = "USER"
  target_id          = each.value.account
  target_type        = "AWS_ACCOUNT"
}

output "identity_store_id" {
  value = local.identity_store_id
}

output "publisher_policy" {
  value = module.publisher_policy.json
}

output "assignments" {
  value = keys(local.assignments)
}
