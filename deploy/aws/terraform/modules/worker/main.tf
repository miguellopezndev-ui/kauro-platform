# The migration worker's AWS host, built from the B14-A contracts in deploy/aws/worker/ without restating them: ECS RunTask on
# Fargate, Linux/x86_64, one task and one role per attempt (SELECTED_NOT_QUALIFIED, docs/design/B14-A-aws-host-qualification.md).
# The task definition, the execution role, the attempt boundary and the launcher policy are rendered from those files; this module
# only binds their placeholders. The task definition is registered only once the owner pins an image digest that was built and
# scanned (there is none yet); until then the cluster holds nothing that can run.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "contracts_dir" {
  description = "deploy/aws/worker."
  type        = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "workload_account_id" {
  type = string
}

variable "object_bucket" {
  description = "The environment's customer-data bucket (data account)."
  type        = string
}

variable "journal_bucket" {
  description = "The environment's authority-journal bucket (data account)."
  type        = string
}

variable "image_digest" {
  description = "sha256 digest of the worker image the owner pinned after its build and scan (procedures/PROVISIONING.md). Null: no task definition."
  type        = string
  default     = null

  validation {
    condition     = var.image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "An image is pinned by its sha256 digest, never by a tag."
  }
}

variable "log_retention_days" {
  description = "policy.json retention.ordinaryLogsDays."
  type        = number
  default     = 30
}

variable "control_plane_trusted_service" {
  description = "The service that runs the control plane. PROPOSED: ECS tasks (the API/control runtime decision, R-A1, is not recorded)."
  type        = string
  default     = "ecs-tasks.amazonaws.com"

  validation {
    condition     = contains(["ecs-tasks.amazonaws.com", "lambda.amazonaws.com"], var.control_plane_trusted_service)
    error_message = "The control plane runs on ECS tasks or Lambda."
  }
}

variable "policies_dir" {
  description = "deploy/aws/policies."
  type        = string
}

locals {
  cluster_name             = "kauro-${var.environment}"
  family                   = "kauro-migration-worker"
  log_group                = "/kauro/${var.environment}/migration-worker"
  execution_role_name      = "kauro-${var.environment}-worker-execution"
  control_plane_role_name  = "kauro-${var.environment}-control-plane"
  attempt_boundary_name    = "kauro-attempt-boundary"
  attempt_boundary_arn     = "arn:aws:iam::${var.workload_account_id}:policy/kauro-guard/${local.attempt_boundary_name}"
  control_boundary_name    = "kauro-control-plane-boundary"
  cluster_arn              = "arn:aws:ecs:${var.region}:${var.workload_account_id}:cluster/${local.cluster_name}"
  task_definition_arn_base = "arn:aws:ecs:${var.region}:${var.workload_account_id}:task-definition/${local.family}"
  execution_role_arn       = "arn:aws:iam::${var.workload_account_id}:role/kauro-runtime/${local.execution_role_name}"
  repository_name          = "kauro/migration-worker"
  repository_arn           = "arn:aws:ecr:${var.region}:${var.workload_account_id}:repository/${local.repository_name}"
  repository_uri           = "${var.workload_account_id}.dkr.ecr.${var.region}.amazonaws.com/${local.repository_name}"

  contract_vars = {
    ACCOUNT_ID                           = var.workload_account_id
    ATTEMPT_BOUNDARY_POLICY_ARN          = local.attempt_boundary_arn
    CLUSTER_ARN                          = local.cluster_arn
    CLUSTER_NAME                         = local.cluster_name
    ECR_REPOSITORY_ARN                   = local.repository_arn
    ECR_REPOSITORY_URI                   = local.repository_uri
    ENVIRONMENT                          = var.environment
    EXECUTION_ROLE_ARN                   = local.execution_role_arn
    IMAGE_DIGEST                         = coalesce(var.image_digest, "sha256:${join("", [for _ in range(64) : "0"])}")
    OBJECT_BUCKET                        = var.object_bucket
    TASK_DEFINITION_ARN_WITHOUT_REVISION = local.task_definition_arn_base
  }

  # The task definition contract, decoded. Every field is the contract's; Terraform adds nothing to the container.
  task_definition = jsondecode(templatefile("${var.contracts_dir}/task-definition.template.json", local.contract_vars))
}

# --- Image repository -------------------------------------------------------------------------------------------------------------

resource "aws_ecr_repository" "worker" {
  name                 = local.repository_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Untagged layers and images go after one day."
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 1 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the ten most recent images (the pinned digest and its rollback candidates)."
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
        action       = { type = "expire" }
      }
    ]
  })
}

data "aws_iam_policy_document" "repository" {
  statement {
    sid     = "OnlyThisAccount"
    effect  = "Deny"
    actions = ["ecr:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalAccount"
      values   = [var.workload_account_id]
    }
  }
}

resource "aws_ecr_repository_policy" "worker" {
  repository = aws_ecr_repository.worker.name
  policy     = data.aws_iam_policy_document.repository.json
}

# --- Cluster and logs -------------------------------------------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  # Container Insights is a paid CloudWatch feature; the worker reports its own peaks (B14-A executor design §5).
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

# --- Roles and policies from the contracts ----------------------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.workload_account_id]
    }
  }
}

module "execution_policy" {
  source    = "../policy-template"
  templates = ["${var.contracts_dir}/iam/execution-role.policy.template.json"]
  vars      = local.contract_vars
}

resource "aws_iam_role" "execution" {
  name               = local.execution_role_name
  path               = "/kauro-runtime/"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy" "execution" {
  name   = "worker-execution"
  role   = aws_iam_role.execution.id
  policy = module.execution_policy.json
}

module "attempt_boundary" {
  source    = "../policy-template"
  templates = ["${var.contracts_dir}/iam/attempt-boundary.policy.json"]
  vars      = local.contract_vars
}

resource "aws_iam_policy" "attempt_boundary" {
  name        = local.attempt_boundary_name
  path        = "/kauro-guard/"
  description = "B14-A: the ceiling of every per-attempt role (deploy/aws/worker/iam/attempt-boundary.policy.json)."
  policy      = module.attempt_boundary.json
}

module "launcher_policy" {
  source    = "../policy-template"
  templates = ["${var.contracts_dir}/iam/launcher.policy.template.json"]
  vars      = local.contract_vars
}

resource "aws_iam_policy" "launcher" {
  name        = "kauro-${var.environment}-launcher"
  path        = "/kauro-runtime/"
  description = "B14-A: hosting attempts (deploy/aws/worker/iam/launcher.policy.template.json)."
  policy      = module.launcher_policy.json
}

module "control_boundary" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/workload/control-plane-boundary.policy.json"]
  vars      = { WORKLOAD_ACCOUNT_ID = var.workload_account_id }
}

resource "aws_iam_policy" "control_boundary" {
  name        = local.control_boundary_name
  path        = "/kauro-guard/"
  description = "Order 25: the ceiling of the control plane's role."
  policy      = module.control_boundary.json
}

data "aws_iam_policy_document" "control_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = [var.control_plane_trusted_service]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.workload_account_id]
    }
  }
}

# The control plane's role exists so that the launcher policy, the bucket grants and the SCP's exception all name one principal.
# Nothing assumes it until the control plane's runtime is chosen and built (R-A1; apps/control has no long-running process yet).
resource "aws_iam_role" "control_plane" {
  name                 = local.control_plane_role_name
  path                 = "/kauro-runtime/"
  assume_role_policy   = data.aws_iam_policy_document.control_trust.json
  permissions_boundary = aws_iam_policy.control_boundary.arn
}

resource "aws_iam_role_policy_attachment" "control_plane_launcher" {
  role       = aws_iam_role.control_plane.name
  policy_arn = aws_iam_policy.launcher.arn
}

module "control_storage" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/workload/control-plane-storage.policy.json"]
  vars = {
    OBJECT_BUCKET  = var.object_bucket
    JOURNAL_BUCKET = var.journal_bucket
  }
}

resource "aws_iam_role_policy" "control_plane_storage" {
  name   = "platform-objects"
  role   = aws_iam_role.control_plane.id
  policy = module.control_storage.json
}

# --- Task definition (only with a pinned digest) ----------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "worker" {
  count = var.image_digest == null ? 0 : 1

  family                   = local.task_definition.family
  requires_compatibilities = local.task_definition.requiresCompatibilities
  network_mode             = local.task_definition.networkMode
  cpu                      = local.task_definition.cpu
  memory                   = local.task_definition.memory
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions    = jsonencode(local.task_definition.containerDefinitions)

  runtime_platform {
    operating_system_family = local.task_definition.runtimePlatform.operatingSystemFamily
    cpu_architecture        = local.task_definition.runtimePlatform.cpuArchitecture
  }

  ephemeral_storage {
    size_in_gib = local.task_definition.ephemeralStorage.sizeInGiB
  }

  dynamic "volume" {
    for_each = local.task_definition.volumes
    content {
      name = volume.value.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.worker]
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "repository_arn" {
  value = aws_ecr_repository.worker.arn
}

output "repository_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "control_plane_role_arn" {
  value = aws_iam_role.control_plane.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "attempt_boundary_arn" {
  value = aws_iam_policy.attempt_boundary.arn
}

output "task_definition" {
  description = "The contract as bound (for tests)."
  value       = local.task_definition
}

output "task_definition_registered" {
  value = length(aws_ecs_task_definition.worker) == 1
}

output "policies" {
  value = {
    execution        = module.execution_policy.json
    attempt_boundary = module.attempt_boundary.json
    launcher         = module.launcher_policy.json
    control_boundary = module.control_boundary.json
    control_storage  = module.control_storage.json
  }
}
