# PROPOSED_NOT_QUALIFIED (docs/design/B14-B-aws-infrastructure.md §5): Amazon RDS for PostgreSQL 17, one Single-AZ instance. It is
# the only candidate that is the engine the platform is tested on, with the direct connection the contracts require (no pooler:
# pg_terminate_backend on the backend's pid, unit-of-work.ts; no Data API: it does not run VERIFY_SQL; PG17 transaction_timeout).
# Aurora Serverless v2 is not chosen: an open pool keeps it from pausing, so its floor (0.5 ACU) costs more than this instance, and
# its compatibility is unproved. Nothing here is qualified until the live checks of the design document pass.
#
# R2-073 ("autoscaling exhausts the SQL pool"): max_connections is fixed here and the plan fails when the declared pools exceed it.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "environment" {
  type = string
}

variable "enabled" {
  description = "Create the database. False until the platform's runtime (R-A1) and its first deployment are authorized."
  type        = bool
  default     = false
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_id" {
  type = string
}

variable "instance_class" {
  description = "db.t4g.micro: USD 0.016/hour Single-AZ PostgreSQL (us-east-1 price list, 2026-10-22). Its real fit is measured, not assumed."
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage_gib" {
  type    = number
  default = 20
}

variable "max_allocated_storage_gib" {
  description = "Storage autoscaling ceiling (a cost bound)."
  type        = number
  default     = 50
}

variable "backup_retention_days" {
  description = "Automated backups and point-in-time recovery window (DPA: daily metadata backups with PITR). The number is not set by any contract: BLOCKED_OWNER, 7 is a placeholder the owner confirms or changes at activation."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "RDS keeps automated backups 1 to 35 days; 0 would turn point-in-time recovery off, which the DPA promises."
  }
}

variable "max_connections" {
  description = "Fixed max_connections of the instance."
  type        = number
  default     = 60
}

variable "connection_budget" {
  description = "Every pool that may connect at once, by role: instances × pool size (apps/api config: API_POOL_CEILING 4, at most two instances; assurance pool at most 2; one migrator; the control plane's pool)."
  type = object({
    api_instances     = number
    api_pool          = number
    assurance_pool    = number
    control_instances = number
    control_pool      = number
    migrator          = number
    journal           = number
    operators         = number
  })
  default = {
    api_instances     = 2
    api_pool          = 4
    assurance_pool    = 2
    control_instances = 1
    control_pool      = 4
    migrator          = 1
    journal           = 1
    operators         = 2
  }
}

locals {
  # RDS keeps superuser_reserved_connections (3 by default) and connections for its own agents; 5 are left aside for both.
  reserved      = 5
  budget_needed = var.connection_budget.api_instances * (var.connection_budget.api_pool + var.connection_budget.assurance_pool) + var.connection_budget.control_instances * var.connection_budget.control_pool + var.connection_budget.migrator + var.connection_budget.journal + var.connection_budget.operators
  budget_ok     = local.budget_needed <= var.max_connections - local.reserved
  identifier    = "kauro-${var.environment}"
}

resource "aws_db_parameter_group" "this" {
  count  = var.enabled ? 1 : 0
  name   = "${local.identifier}-postgres17"
  family = "postgres17"

  # TLS only (Q-AWS-8); the clients verify the CA (KAURO_DB_TLS_CA_FILE, persistence/src/tls.ts).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name         = "max_connections"
    value        = tostring(var.max_connections)
    apply_method = "pending-reboot"
  }

  # No customer value in database logs (DPA §logs): no statement text, not even with an error.
  parameter {
    name  = "log_statement"
    value = "none"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }

  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }

  parameter {
    name  = "log_error_verbosity"
    value = "terse"
  }
}

# Evaluated on every plan, with or without the instance: a rollout whose pools exceed the instance stops here (R2-073).
resource "terraform_data" "connection_budget" {
  input = local.budget_needed

  lifecycle {
    precondition {
      condition     = local.budget_ok
      error_message = "R2-073: the declared pools need ${local.budget_needed} connections, more than max_connections - ${local.reserved}. Change the pools or the instance before rollout."
    }
  }
}

resource "aws_db_subnet_group" "this" {
  count      = var.enabled ? 1 : 0
  name       = local.identifier
  subnet_ids = var.subnet_ids
}

resource "aws_db_instance" "this" {
  count = var.enabled ? 1 : 0

  identifier     = local.identifier
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gib
  max_allocated_storage = var.max_allocated_storage_gib
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = "kauro"
  username                    = "kauro_admin"
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this[0].name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = false
  parameter_group_name   = aws_db_parameter_group.this[0].name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.backup_retention_days
  backup_window             = "06:00-06:30"
  maintenance_window        = "sun:07:00-sun:07:30"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.identifier}-final"

  auto_minor_version_upgrade          = true
  iam_database_authentication_enabled = false
  performance_insights_enabled        = false
  monitoring_interval                 = 0
  enabled_cloudwatch_logs_exports     = []
  apply_immediately                   = false

  lifecycle {
    prevent_destroy = true
  }
}

output "enabled" {
  value = var.enabled
}

output "connection_budget_needed" {
  value = local.budget_needed
}

output "connection_budget_ok" {
  value = local.budget_ok
}

output "endpoint" {
  value = var.enabled ? aws_db_instance.this[0].address : null
}
