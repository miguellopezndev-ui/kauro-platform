# What the retention/deletion function needs before it can exist (D-19, D-21 A): its role (the only principal any policy lets bypass
# governance retention), its log group, a signing profile, an enforced code-signing configuration and the versioned bucket its
# packages are signed from. The function itself is NOT created here: its code is B16's and does not exist yet, and its creation and
# every publication are the owner's MFA session's act through procedures/DELETION-FUNCTION.md, which the data account's SCP enforces.
# AWS Signer for Lambda and code signing carry no charge (owner card D-21; to be re-read at activation).

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

variable "environment" {
  type = string
}

variable "data_account_id" {
  type = string
}

variable "object_bucket" {
  type = string
}

variable "journal_bucket" {
  type = string
}

variable "owner_admin_role_pattern" {
  type = string
}

variable "deletion_publisher_role_pattern" {
  type = string
}

variable "security_log_days" {
  type    = number
  default = 180
}

locals {
  function_name  = "kauro-${var.environment}-retention-deletion"
  signing_bucket = "kauro-signing-${var.data_account_id}"
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.data_account_id]
    }
    # No aws:SourceArn condition: AWS does not document that Lambda sends it when assuming an execution role, and without it the
    # role could never be assumed. Who may hand this role to a function is the data account's SCP (PassRole: the owner's sessions
    # only) and which function may run with it is the code-signing configuration (QUALIFICATION part D).
  }
}

resource "aws_iam_role" "deletion" {
  name                 = local.function_name
  path                 = "/kauro-deletion/"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

module "deletion_policy" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/data/deletion-role.policy.json"]
  vars = {
    OBJECT_BUCKET   = var.object_bucket
    JOURNAL_BUCKET  = var.journal_bucket
    REGION          = var.region
    DATA_ACCOUNT_ID = var.data_account_id
    ENVIRONMENT     = var.environment
  }
}

resource "aws_iam_role_policy" "deletion" {
  name   = "retention-deletion"
  role   = aws_iam_role.deletion.id
  policy = module.deletion_policy.json
}

resource "aws_cloudwatch_log_group" "deletion" {
  name              = "/kauro/${var.environment}/retention-deletion"
  retention_in_days = var.security_log_days
}

resource "aws_signer_signing_profile" "deletion" {
  name_prefix = "kauro${var.environment}deletion"
  platform_id = "AWSLambda-SHA384-ECDSA"

  signature_validity_period {
    value = 5
    type  = "YEARS"
  }
}

resource "aws_lambda_code_signing_config" "deletion" {
  description = "Kauro ${var.environment} retention/deletion: only packages signed by the owner's profile deploy."

  allowed_publishers {
    signing_profile_version_arns = [aws_signer_signing_profile.deletion.version_arn]
  }

  policies {
    untrusted_artifact_on_deployment = "Enforce"
  }
}

# The versioned bucket signing jobs read from and write to (AWS Signer requires a versioned source). Not a customer-data bucket:
# no Object Lock retention is needed beyond versioning, but it is still a kauro-* bucket, so the data account's guards cover it.
resource "aws_s3_bucket" "signing" {
  bucket        = local.signing_bucket
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "signing" {
  bucket = aws_s3_bucket.signing.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "signing" {
  bucket = aws_s3_bucket.signing.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Signed packages are kept (a published version must stay explainable); only unfinished uploads are cleaned.
resource "aws_s3_bucket_lifecycle_configuration" "signing" {
  bucket = aws_s3_bucket.signing.id

  rule {
    id     = "incomplete-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.signing]
}

resource "aws_s3_bucket_public_access_block" "signing" {
  bucket                  = aws_s3_bucket.signing.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "signing" {
  bucket = aws_s3_bucket.signing.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "signing_bucket" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.signing.arn, "${aws_s3_bucket.signing.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "OnlyTheOwnerSessionsAndSignerWrite"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.signing.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnNotLike"
      variable = "aws:PrincipalArn"
      values   = [var.owner_admin_role_pattern, var.deletion_publisher_role_pattern]
    }
    condition {
      test     = "Bool"
      variable = "aws:PrincipalIsAWSService"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "signing" {
  bucket     = aws_s3_bucket.signing.id
  policy     = data.aws_iam_policy_document.signing_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.signing]
}

output "function_name" {
  value = local.function_name
}

output "role_arn" {
  value = aws_iam_role.deletion.arn
}

output "role_name" {
  value = aws_iam_role.deletion.name
}

output "code_signing_config_arn" {
  value = aws_lambda_code_signing_config.deletion.arn
}

output "signing_profile_name" {
  value = aws_signer_signing_profile.deletion.name
}

output "signing_bucket" {
  value = aws_s3_bucket.signing.id
}

output "deletion_policy" {
  value = module.deletion_policy.json
}
