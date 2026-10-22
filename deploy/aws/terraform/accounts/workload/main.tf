# The workload account (D-21 A "carga"): the private network, the migration worker's host (B14-A contracts), the control plane's
# role, the GitHub image publisher, the PROPOSED database and this account's state bucket. One environment per account: the
# attempt roles' names carry no environment (worker contracts), so two environments in one account could reach each other's bucket.
# Applied in the owner's session, after the management root and before the data root (the data root needs the S3 gateway
# endpoint's id).

variable "region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = can(regex("^us-(east|west)-[12]$", var.region))
    error_message = "Legal checklist A-06: US Regions only."
  }
}

variable "environment" {
  description = "qualification first; production only after its own activation (procedures/ACTIVATION.md gate 9)."
  type        = string
  default     = "qualification"

  validation {
    condition     = contains(["qualification", "production"], var.environment)
    error_message = "qualification or production."
  }
}

variable "workload_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.workload_account_id))
    error_message = "A 12-digit AWS account id."
  }
}

variable "data_account_id" {
  type = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.data_account_id))
    error_message = "A 12-digit AWS account id."
  }
}

variable "owner_admin_role_pattern" {
  description = "Output of the management root."
  type        = string
}

variable "activation_authorization" {
  description = "The activation gate (Order 25 §9): the owner's written authorization for this account, KAURO-ACT-YYYY-MM-DD-WORKLOAD-<n>, confirming gates 1-4 of procedures/ACTIVATION.md (legal identity, the company account with MFA, the organization's three accounts, separation of permissions and spend limits). Without it no plan, and so no apply, is possible. A guard against accidents, not against the owner."
  type = object({
    reference       = string
    gates_confirmed = list(number)
  })
  default = null

  validation {
    condition     = try(can(regex("^KAURO-ACT-[0-9]{4}-[0-9]{2}-[0-9]{2}-WORKLOAD-[0-9]+$", var.activation_authorization.reference)) && length(setsubtract([1, 2, 3, 4], var.activation_authorization.gates_confirmed)) == 0, false)
    error_message = "Activation is not authorized for the workload account: the owner's reference KAURO-ACT-YYYY-MM-DD-WORKLOAD-<n> with gates 1-4 confirmed is required (deploy/aws/procedures/ACTIVATION.md). Nothing is planned without it."
  }
}

variable "worker_enabled" {
  description = "Create the worker's interface endpoints (its only fixed cost). False until a real attempt is authorized."
  type        = bool
  default     = false
}

variable "worker_image_digest" {
  description = "The worker image's sha256 digest, pinned by the owner after build and scan. Null: no task definition."
  type        = string
  default     = null

  validation {
    condition     = var.worker_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.worker_image_digest))
    error_message = "An image is pinned by its sha256 digest, never by a tag."
  }
}

variable "database_enabled" {
  description = "Create the PROPOSED RDS PostgreSQL 17 instance. False until the platform's runtime is decided and authorized."
  type        = bool
  default     = false
}

variable "github_repository" {
  type    = string
  default = "miguellopezndev-ui/kauro-platform"
}


locals {
  policies_dir   = "${path.module}/../../../policies"
  contracts_dir  = "${path.module}/../../../worker"
  object_bucket  = "kauro-${var.environment}-customer-data-${var.data_account_id}"
  journal_bucket = "kauro-${var.environment}-journal-${var.data_account_id}"
}

module "network" {
  source = "../../modules/network"

  environment              = var.environment
  region                   = var.region
  worker_endpoints_enabled = var.worker_enabled
  object_bucket_arns       = ["arn:aws:s3:::${local.object_bucket}", "arn:aws:s3:::${local.journal_bucket}"]
}

module "worker" {
  source = "../../modules/worker"

  contracts_dir       = local.contracts_dir
  policies_dir        = local.policies_dir
  environment         = var.environment
  region              = var.region
  workload_account_id = var.workload_account_id
  object_bucket       = local.object_bucket
  journal_bucket      = local.journal_bucket
  image_digest        = var.worker_image_digest
}

module "deploy_identity" {
  source = "../../modules/deploy-identity"

  policies_dir       = local.policies_dir
  environment        = var.environment
  github_repository  = var.github_repository
  ecr_repository_arn = module.worker.repository_arn
}

module "database" {
  source = "../../modules/database"

  environment       = var.environment
  enabled           = var.database_enabled
  subnet_ids        = module.network.database_subnet_ids
  security_group_id = module.network.database_security_group_id
}

module "state" {
  source = "../../modules/state-backend"

  account_id               = var.workload_account_id
  owner_admin_role_pattern = var.owner_admin_role_pattern
}

output "s3_gateway_endpoint_id" {
  description = "Input of the data root (the customer bucket admits attempt roles only through it)."
  value       = module.network.s3_gateway_endpoint_id
}

output "interface_endpoints" {
  value = module.network.interface_endpoints
}

output "worker" {
  value = {
    cluster_arn                = module.worker.cluster_arn
    repository_url             = module.worker.repository_url
    control_plane_role_arn     = module.worker.control_plane_role_arn
    attempt_boundary_arn       = module.worker.attempt_boundary_arn
    task_definition_registered = module.worker.task_definition_registered
    worker_subnet_id           = module.network.worker_subnet_id
    worker_security_group_id   = module.network.worker_security_group_id
  }
}

output "worker_task_definition" {
  value = module.worker.task_definition
}

output "worker_policies" {
  value = module.worker.policies
}

output "deploy_identity" {
  value = {
    role_arn = module.deploy_identity.role_arn
    subject  = module.deploy_identity.subject
    policy   = module.deploy_identity.policy
  }
}

output "database" {
  value = {
    enabled                  = module.database.enabled
    connection_budget_needed = module.database.connection_budget_needed
    endpoint                 = module.database.endpoint
  }
}

output "state_bucket" {
  value = module.state.bucket
}
