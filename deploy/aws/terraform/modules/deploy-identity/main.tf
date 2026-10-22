# The workload account's only automated identity (A9: IAM + GitHub OIDC, no static keys). GitHub Actions assumes it only from the
# named repository's named deployment environment (a GitHub environment with the owner as required reviewer: available because
# kauro-platform is public), and it can only push worker images (policies/workload/deploy-role.policy.json). It cannot apply
# Terraform, touch IAM, reach the data account or change its own trust (scp-workload-guard.json).

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "policies_dir" {
  type = string
}

variable "environment" {
  type = string
}

variable "github_repository" {
  description = "owner/name of the repository allowed to deploy. It moves with the repository (WORKSPACE_POLICY §4: a private repository under the company's organization)."
  type        = string
  default     = "miguellopezndev-ui/kauro-platform"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "owner/name."
  }
}

variable "ecr_repository_arn" {
  type = string
}

locals {
  github_environment = "aws-${var.environment}"
  subject            = "repo:${var.github_repository}:environment:${local.github_environment}"
}

# AWS no longer validates thumbprints for GitHub's OIDC issuer (IAM user guide, OIDC providers), so none is pinned here.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.subject]
    }
  }
}

resource "aws_iam_role" "image_publisher" {
  name                 = "kauro-${var.environment}-image-publisher"
  path                 = "/kauro-deploy/"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

module "policy" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/workload/deploy-role.policy.json"]
  vars      = { ECR_REPOSITORY_ARN = var.ecr_repository_arn }
}

resource "aws_iam_role_policy" "image_publisher" {
  name   = "push-worker-images"
  role   = aws_iam_role.image_publisher.id
  policy = module.policy.json
}

output "role_arn" {
  value = aws_iam_role.image_publisher.arn
}

output "subject" {
  value = local.subject
}

output "policy" {
  value = module.policy.json
}
