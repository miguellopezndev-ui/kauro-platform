# OpenTofu reads this file and ignores the .tftest.hcl of the same name (OpenTofu testing docs). It is the .tftest.hcl without
# override_during, an argument OpenTofu does not accept (it already knows mocked values at plan). tools/test/aws-infrastructure.test.mjs
# keeps the two identical otherwise.
# Offline plan tests of the PROPOSED database (mocked provider). R2-073: a rollout whose pools exceed the instance stops at plan.

mock_provider "aws" {}

variables {
  environment       = "qualification"
  subnet_ids        = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  security_group_id = "sg-0123456789abcdef0"
}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_db_instance.this) == 0 && output.endpoint == null
    error_message = "No database until it is enabled."
  }
}

run "r2_073_doubling_api_instances_beyond_the_budget_stops_the_plan" {
  command = plan
  variables {
    max_connections = 20
    connection_budget = {
      api_instances     = 4
      api_pool          = 4
      assurance_pool    = 2
      control_instances = 1
      control_pool      = 4
      migrator          = 1
      journal           = 1
      operators         = 2
    }
  }
  expect_failures = [terraform_data.connection_budget]
}

run "the_database_is_never_enabled_without_the_owners_backup_decision" {
  command = plan
  variables {
    enabled = true
  }
  expect_failures = [terraform_data.backup_decision]
}

run "enabled_instance_is_private_tls_only_protected_and_logs_no_statement" {
  command = plan
  variables {
    enabled = true
    backup  = { retention_days = 14, window = "08:00-08:30" }
  }

  assert {
    condition     = aws_db_instance.this[0].publicly_accessible == false && aws_db_instance.this[0].storage_encrypted == true
    error_message = "Private and encrypted."
  }
  assert {
    condition     = aws_db_instance.this[0].deletion_protection == true && aws_db_instance.this[0].skip_final_snapshot == false
    error_message = "Deletion protection and a final snapshot."
  }
  assert {
    condition     = aws_db_instance.this[0].engine == "postgres" && aws_db_instance.this[0].engine_version == "17"
    error_message = "PostgreSQL 17 (transaction_timeout)."
  }
  assert {
    condition     = aws_db_instance.this[0].backup_retention_period == 14 && aws_db_instance.this[0].backup_window == "08:00-08:30"
    error_message = "The owner's backup retention and window, exactly."
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.this[0].parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "TLS only."
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.this[0].parameter : p.value if p.name == "log_min_error_statement"]) == "panic" && one([for p in aws_db_parameter_group.this[0].parameter : p.value if p.name == "log_statement"]) == "none"
    error_message = "No statement text (no customer value) in the database's logs."
  }
}

run "point_in_time_recovery_cannot_be_turned_off" {
  command = plan
  variables {
    backup = { retention_days = 0, window = "08:00-08:30" }
  }
  expect_failures = [var.backup]
}
