# The data account (D-21 A "datos"): the environment's customer-data bucket and authority-journal bucket (D-19: versioning, Object
# Lock GOVERNANCE, no default retention, noncurrent versions expire after one day), the organization trail with the protected
# buckets' data events, the guard alarms, the deletion identity's scaffolding and this account's state bucket. No automated
# identity exists here: every apply is the owner's session. Applied after the workload root (it needs the S3 gateway endpoint).

variable "region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = can(regex("^us-(east|west)-[12]$", var.region))
    error_message = "Legal checklist A-06: US Regions only."
  }
}

variable "environment" {
  type    = string
  default = "qualification"

  validation {
    condition     = contains(["qualification", "production"], var.environment)
    error_message = "qualification or production."
  }
}

variable "organization_id" {
  type = string

  validation {
    condition     = can(regex("^o-[a-z0-9]{10,32}$", var.organization_id))
    error_message = "An AWS Organizations id (o-â€¦)."
  }
}

variable "data_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.data_account_id))
    error_message = "A 12-digit AWS account id."
  }
}

variable "workload_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "A 12-digit AWS account id."
  }
}

variable "s3_gateway_endpoint_id" {
  description = "Output of the workload root."
  type        = string

  validation {
    condition     = can(regex("^vpce-[0-9a-f]{8,17}$", var.s3_gateway_endpoint_id))
    error_message = "A VPC endpoint id (vpce-â€¦)."
  }
}

variable "owner_admin_role_pattern" {
  description = "Output of the management root."
  type        = string
}

variable "deletion_publisher_role_pattern" {
  description = "Output of the management root."
  type        = string
}

variable "alarm_email" {
  type    = string
  default = "aws-data@kaurodata.com"
}

variable "activation_authorization" {
  description = "The activation gate (Order 25 §9): the owner's written authorization for this account, KAURO-ACT-YYYY-MM-DD-DATA-<n>, confirming gates 1-4 of procedures/ACTIVATION.md (legal identity, the company account with MFA, the organization's three accounts, separation of permissions and spend limits). Without it no plan, and so no apply, is possible. A guard against accidents, not against the owner."
  type = object({
    reference       = string
    gates_confirmed = list(number)
  })
  default = null

  validation {
    condition     = try(can(regex("^KAURO-ACT-[0-9]{4}-[0-9]{2}-[0-9]{2}-DATA-[0-9]+$", var.activation_authorization.reference)) && length(setsubtract([1, 2, 3, 4], var.activation_authorization.gates_confirmed)) == 0, false)
    error_message = "Activation is not authorized for the data account: the owner's reference KAURO-ACT-YYYY-MM-DD-DATA-<n> with gates 1-4 confirmed is required (deploy/aws/procedures/ACTIVATION.md). Nothing is planned without it."
  }
}


locals {
  policies_dir   = "${path.module}/../../../policies"
  contracts_dir  = "${path.module}/../../../worker"
  object_bucket  = "kauro-${var.environment}-customer-data-${var.data_account_id}"
  journal_bucket = "kauro-${var.environment}-journal-${var.data_account_id}"

  bucket_vars = {
    ACCOUNT_ID               = var.workload_account_id
    DATA_ACCOUNT_ID          = var.data_account_id
    ENVIRONMENT              = var.environment
    JOURNAL_BUCKET           = local.journal_bucket
    OBJECT_BUCKET            = local.object_bucket
    OWNER_ADMIN_ROLE_PATTERN = var.owner_admin_role_pattern
    S3_GATEWAY_ENDPOINT_ID   = var.s3_gateway_endpoint_id
    WORKLOAD_ACCOUNT_ID      = var.workload_account_id
  }
}

module "customer_data" {
  source = "../../modules/protected-bucket"

  name = local.object_bucket
  # The data account's statements first, then the worker protocol's own (B14-A contract, unchanged).
  policy_templates = [
    "${local.policies_dir}/data/customer-data-bucket.json",
    "${local.contracts_dir}/bucket-policy.template.json",
  ]
  policy_vars = local.bucket_vars
}

module "journal" {
  source = "../../modules/protected-bucket"

  name             = local.journal_bucket
  policy_templates = ["${local.policies_dir}/data/journal-bucket.json"]
  policy_vars      = local.bucket_vars
}

module "deletion" {
  source = "../../modules/deletion-function"

  policies_dir                    = local.policies_dir
  region                          = var.region
  environment                     = var.environment
  data_account_id                 = var.data_account_id
  object_bucket                   = local.object_bucket
  journal_bucket                  = local.journal_bucket
  owner_admin_role_pattern        = var.owner_admin_role_pattern
  deletion_publisher_role_pattern = var.deletion_publisher_role_pattern
}

module "audit" {
  source = "../../modules/audit-trail"

  policies_dir             = local.policies_dir
  region                   = var.region
  organization_id          = var.organization_id
  data_account_id          = var.data_account_id
  owner_admin_role_pattern = var.owner_admin_role_pattern
  protected_bucket_arns    = [module.customer_data.arn, module.journal.arn]
  deletion_role_names      = [module.deletion.role_name]
  alarm_email              = var.alarm_email
}

module "state" {
  source = "../../modules/state-backend"

  account_id               = var.data_account_id
  owner_admin_role_pattern = var.owner_admin_role_pattern
}

output "customer_data_bucket" {
  value = module.customer_data.name
}

output "customer_data_bucket_policy" {
  value = module.customer_data.policy
}

output "journal_bucket" {
  value = module.journal.name
}

output "journal_bucket_policy" {
  value = module.journal.policy
}

output "audit_bucket" {
  value = module.audit.audit_bucket
}

output "audit_bucket_policy" {
  value = module.audit.audit_bucket_policy
}

output "guard_rule_patterns" {
  value = module.audit.rule_patterns
}

output "deletion" {
  value = {
    function_name           = module.deletion.function_name
    role_arn                = module.deletion.role_arn
    code_signing_config_arn = module.deletion.code_signing_config_arn
    signing_profile_name    = module.deletion.signing_profile_name
    signing_bucket          = module.deletion.signing_bucket
    policy                  = module.deletion.deletion_policy
  }
}

output "state_bucket" {
  value = module.state.bucket
}
