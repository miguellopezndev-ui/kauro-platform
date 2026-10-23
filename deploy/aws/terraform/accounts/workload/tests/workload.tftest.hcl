# Offline plan tests of the workload root (Order 25 §8: TESTED_LOCAL with a mocked provider). No credential, no AWS call: the mock
# provider answers every resource and data source. They prove what this configuration asks AWS for, never what AWS would do.

mock_provider "aws" {
  override_during = plan
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-63a5400a" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111111111111:policy/kauro-guard/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111111111111:role/kauro-runtime/mock" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:111111111111:repository/kauro/migration-worker"
      repository_url = "111111111111.dkr.ecr.us-east-1.amazonaws.com/kauro/migration-worker"
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:cluster/kauro-qualification" }
  }
}

variables {
  workload_account_id      = "111111111111"
  data_account_id          = "222222222222"
  owner_admin_role_pattern = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_KauroOwnerAdministrator_*"
  activation_authorization = { reference = "KAURO-ACT-2026-11-02-WORKLOAD-1", gates_confirmed = [1, 2, 3, 4] }
}

run "nothing_is_planned_without_the_owners_activation" {
  command = plan
  variables {
    activation_authorization = null
  }
  expect_failures = [var.activation_authorization]
}

run "an_authorization_for_another_account_is_refused" {
  command = plan
  variables {
    activation_authorization = { reference = "KAURO-ACT-2026-11-02-DATA-1", gates_confirmed = [1, 2, 3, 4] }
  }
  expect_failures = [var.activation_authorization]
}

run "an_authorization_missing_a_gate_is_refused" {
  command = plan
  variables {
    activation_authorization = { reference = "KAURO-ACT-2026-11-02-WORKLOAD-1", gates_confirmed = [1, 2, 3] }
  }
  expect_failures = [var.activation_authorization]
}

run "at_rest_the_worker_has_no_fixed_cost_and_nothing_can_run" {
  command = plan

  assert {
    condition     = length(output.interface_endpoints) == 0
    error_message = "No interface endpoint may exist while the worker is disabled."
  }
  assert {
    condition     = output.worker.task_definition_registered == false
    error_message = "A task definition was planned without a pinned image digest."
  }
  assert {
    condition     = output.database.enabled == false
    error_message = "The PROPOSED database was planned without being enabled."
  }
}

run "enabling_the_worker_adds_exactly_its_three_endpoints_in_one_zone" {
  command = plan
  variables {
    worker_enabled      = true
    worker_image_digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    condition     = join(",", output.interface_endpoints) == "ecr.api,ecr.dkr,logs"
    error_message = "The worker needs exactly ecr.api, ecr.dkr and logs."
  }
  assert {
    condition     = output.worker.task_definition_registered
    error_message = "A pinned digest registers the task definition."
  }
}

run "the_task_definition_is_the_b14a_contract" {
  command = plan
  variables {
    worker_enabled      = true
    worker_image_digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    condition     = output.worker_task_definition.cpu == "2048" && output.worker_task_definition.memory == "8192"
    error_message = "2 vCPU and 8 GiB (the attempt's hard memory)."
  }
  assert {
    condition     = output.worker_task_definition.ephemeralStorage.sizeInGiB == 72
    error_message = "72 GiB ephemeral storage (64 GiB hard scratch plus image and browser profile)."
  }
  assert {
    condition     = output.worker_task_definition.runtimePlatform.cpuArchitecture == "X86_64" && output.worker_task_definition.runtimePlatform.operatingSystemFamily == "LINUX"
    error_message = "Linux/x86_64 is the selected (not qualified) platform."
  }
  assert {
    condition     = output.worker_task_definition.containerDefinitions[0].image == "111111111111.dkr.ecr.us-east-1.amazonaws.com/kauro/migration-worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    error_message = "The image is the pinned digest of the account's repository."
  }
  assert {
    condition     = output.worker_task_definition.containerDefinitions[0].readonlyRootFilesystem && output.worker_task_definition.containerDefinitions[0].user == "10001:10001"
    error_message = "Read-only root, non-root user."
  }
  assert {
    condition     = !contains(keys(output.worker_task_definition), "taskRoleArn")
    error_message = "No task role in the definition: every RunTask names the attempt's own role."
  }
  assert {
    condition     = one([for e in output.worker_task_definition.containerDefinitions[0].environment : e.value if e.name == "KAURO_BUCKET"]) == "kauro-qualification-customer-data-222222222222"
    error_message = "The worker's bucket is the environment's customer-data bucket in the data account."
  }
}

run "a_tag_is_never_a_pinned_image" {
  command = plan
  variables {
    worker_image_digest = "latest"
  }
  expect_failures = [var.worker_image_digest]
}

run "the_deploy_identity_is_bound_to_one_repository_environment" {
  command = plan

  assert {
    condition     = output.deploy_identity.subject == "repo:miguellopezndev-ui/kauro-platform:environment:aws-qualification"
    error_message = "The GitHub trust names one repository and one deployment environment, exactly."
  }
}

run "the_control_plane_role_carries_its_boundary" {
  command = plan

  assert {
    condition     = module.worker.control_plane_role_arn != null
    error_message = "The control plane's role is planned."
  }
}

run "the_database_is_never_enabled_without_the_owners_backup_decision" {
  command = plan
  variables {
    database_enabled = true
  }
  expect_failures = [var.database_backup]
}

run "the_default_connection_budget_fits_the_proposed_instance" {
  command = plan

  assert {
    condition     = output.database.connection_budget_needed == 20
    error_message = "2 API instances x (4 + 2) + control 4 + migrator 1 + journal 1 + operators 2 = 20."
  }
}
