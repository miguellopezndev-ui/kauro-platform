# A protected bucket of the data account (owner decision D-19): versioning on, Object Lock on in GOVERNANCE mode only (never
# COMPLIANCE), no default retention, noncurrent versions expired one day after they become noncurrent, incomplete multipart uploads
# aborted after one day, SSE-S3, every public path closed, ACLs disabled. The policy comes from the templates the caller names.
# Object Lock cannot be disabled and versioning cannot be suspended once the bucket exists (S3 user guide, Object Lock
# considerations): that permanence is the point.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "name" {
  type = string

  validation {
    condition     = can(regex("^kauro-[a-z0-9-]{3,56}$", var.name))
    error_message = "Protected buckets are named kauro-… (the data account's guard policies match kauro-*)."
  }
}

variable "policy_templates" {
  type = list(string)
}

variable "policy_vars" {
  type = map(string)
}

variable "default_retention_days" {
  description = "GOVERNANCE default retention in days, or null for none (D-19: customer buckets have none; the audit bucket keeps its logs this long)."
  type        = number
  default     = null
}

variable "noncurrent_expiration_days" {
  description = "D-19: 1. The real lag before a noncurrent version disappears is measured live (legal checklist A-20); never promised as one day."
  type        = number
  default     = 1
}

variable "current_expiration_days" {
  description = "Expire current versions after this many days (null: never). Never set it on a bucket that holds worker protocol keys: a delete marker reopens If-None-Match (S3 conditional writes)."
  type        = number
  default     = null
}

resource "aws_s3_bucket" "this" {
  bucket              = var.name
  object_lock_enabled = true
  force_destroy       = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  count  = var.default_retention_days == null ? 0 : 1
  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.default_retention_days
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "noncurrent-and-incomplete-uploads"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }

    expiration {
      expired_object_delete_marker = var.current_expiration_days == null ? true : null
      days                         = var.current_expiration_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

module "policy" {
  source    = "../policy-template"
  templates = var.policy_templates
  vars      = var.policy_vars
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = module.policy.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}

output "name" {
  value = aws_s3_bucket.this.id
}

output "arn" {
  value = aws_s3_bucket.this.arn
}

output "policy" {
  value = module.policy.json
}

output "statements" {
  value = module.policy.statements
}
