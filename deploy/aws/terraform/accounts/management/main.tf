# The management account (D-21 A): the organization, its OUs and member accounts, the guard SCPs and RCP, Identity Center's
# permission sets, the spend backstop and this account's state bucket. No workload and no customer data ever live here. Applied
# only in the owner's session, after the activation gate (procedures/ACTIVATION.md).

variable "region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = can(regex("^us-(east|west)-[12]$", var.region))
    error_message = "Legal checklist A-06: US Regions only."
  }
}

variable "management_account_id" {
  description = "The management account's id. No default: the provider refuses any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.management_account_id))
    error_message = "A 12-digit AWS account id."
  }
}

variable "activation_authorization" {
  description = "The activation gate (Order 25 §9): the owner's written authorization for this account, KAURO-ACT-YYYY-MM-DD-MANAGEMENT-<n>, confirming gates 1-2 of procedures/ACTIVATION.md (legal identity; the company account with MFA and Identity Center). Gates 3 and 4 are what this root then builds. Without it no plan, and so no apply, is possible. A guard against accidents, not against the owner."
  type = object({
    reference       = string
    gates_confirmed = list(number)
  })
  default = null

  validation {
    condition     = try(can(regex("^KAURO-ACT-[0-9]{4}-[0-9]{2}-[0-9]{2}-MANAGEMENT-[0-9]+$", var.activation_authorization.reference)) && length(setsubtract([1, 2], var.activation_authorization.gates_confirmed)) == 0, false)
    error_message = "Activation is not authorized for the management account: the owner's reference KAURO-ACT-YYYY-MM-DD-MANAGEMENT-<n> with gates 1-2 confirmed is required (deploy/aws/procedures/ACTIVATION.md). Nothing is planned without it."
  }
}

variable "data_account" {
  type = object({ email = string, name = string })
  default = {
    email = "aws-data@kaurodata.com"
    name  = "Kauro Data"
  }
}

variable "workload_account" {
  type = object({ email = string, name = string })
  default = {
    email = "aws-load@kaurodata.com"
    name  = "Kauro Workloads"
  }
}

variable "owner_principal_id" {
  description = "The owner's Identity Center user id; null until it exists."
  type        = string
  default     = null
}

variable "monthly_ceiling_usd" {
  description = "BLOCKED_OWNER: the owner's monthly cloud ceiling in USD (see cost-guardrails). No default: no figure has been accepted (A9 §6)."
  type        = number

  validation {
    condition     = var.monthly_ceiling_usd > 0 && var.monthly_ceiling_usd <= 220
    error_message = "The ceiling is positive and never above the owner's monthly funding (policy.json monthlyOwnerFundingCents = 22000)."
  }
}

variable "alert_email" {
  type    = string
  default = "aws-mgmt@kaurodata.com"
}


locals {
  policies_dir                      = "${path.module}/../../../policies"
  owner_admin_permission_set        = "KauroOwnerAdministrator"
  deletion_publisher_permission_set = "KauroDeletionPublisher"
}

module "organization" {
  source = "../../modules/organization"

  policies_dir                      = local.policies_dir
  allowed_region                    = var.region
  data_account                      = var.data_account
  workload_account                  = var.workload_account
  owner_admin_permission_set        = local.owner_admin_permission_set
  deletion_publisher_permission_set = local.deletion_publisher_permission_set
}

module "identity_center" {
  source = "../../modules/identity-center"

  policies_dir                      = local.policies_dir
  region                            = var.region
  owner_principal_id                = var.owner_principal_id
  management_account_id             = var.management_account_id
  data_account_id                   = module.organization.data_account_id
  workload_account_id               = module.organization.workload_account_id
  owner_admin_permission_set        = local.owner_admin_permission_set
  deletion_publisher_permission_set = local.deletion_publisher_permission_set
  signing_bucket                    = "kauro-signing-${module.organization.data_account_id}"
}

module "cost_guardrails" {
  source = "../../modules/cost-guardrails"

  policies_dir             = local.policies_dir
  monthly_ceiling_usd      = var.monthly_ceiling_usd
  alert_email              = var.alert_email
  workloads_ou_id          = module.organization.workloads_ou_id
  owner_admin_role_pattern = module.organization.owner_admin_role_pattern
}

module "state" {
  source = "../../modules/state-backend"

  account_id               = var.management_account_id
  owner_admin_role_pattern = module.organization.owner_admin_role_pattern
}

output "organization_id" {
  value = module.organization.organization_id
}

output "data_account_id" {
  value = module.organization.data_account_id
}

output "workload_account_id" {
  value = module.organization.workload_account_id
}

output "owner_admin_role_pattern" {
  value = module.organization.owner_admin_role_pattern
}

output "deletion_publisher_role_pattern" {
  value = module.organization.deletion_publisher_role_pattern
}

output "guard_policies" {
  value = module.organization.policy_documents
}

output "guard_policy_sizes" {
  value = module.organization.policy_sizes
}

output "guard_attachments" {
  value = module.organization.attachments
}

output "spend_stop_policy" {
  value = module.cost_guardrails.spend_stop_policy
}

output "state_bucket" {
  value = module.state.bucket
}
