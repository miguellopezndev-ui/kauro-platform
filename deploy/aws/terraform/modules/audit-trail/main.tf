# The organization's audit trail and the retention guard's alarms, managed from the data account (D-21: "CloudTrail, alarms and the
# deletion function" live there). The data account is CloudTrail's delegated administrator (organization module), so it creates and
# manages the organization trail, which AWS makes a resource OWNED by the management account (its ARN names that account; the
# management account's own principals, outside every SCP, could stop it: the management root alarms on that). The trail records every account's management events (the first copy is free) and the data events of the protected buckets
# (D-19), into an Object Lock audit bucket kept for policy.json securityLogsDays. Alarms go by e-mail, outside AWS's consoles.

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

variable "organization_id" {
  type = string
}

variable "data_account_id" {
  type = string
}

variable "management_account_id" {
  description = "The organization trail a delegated administrator creates is owned by the management account (CloudTrail user guide): its ARN and log prefix name that account."
  type        = string
}

variable "owner_admin_role_pattern" {
  type = string
}

variable "security_log_days" {
  description = "policy.json retention.securityLogsDays."
  type        = number
  default     = 180
}

variable "protected_bucket_arns" {
  description = "Buckets whose S3 data events the trail records (the customer-data and journal buckets)."
  type        = list(string)
}

variable "deletion_role_names" {
  description = "Role names of the deletion identities (their bypasses are reported too, as information)."
  type        = list(string)
}

variable "alarm_email" {
  type = string

  validation {
    condition     = can(regex("@kaurodata\\.com$", var.alarm_email))
    error_message = "Alarms go to the company's professional mailbox (kaurodata.com)."
  }
}

locals {
  audit_bucket = "kauro-audit-${var.data_account_id}"
  trail_name   = "kauro-organization"
  trail_arn    = "arn:aws:cloudtrail:${var.region}:${var.management_account_id}:trail/${local.trail_name}"
}

module "audit_bucket" {
  source = "../protected-bucket"

  name                       = local.audit_bucket
  default_retention_days     = var.security_log_days
  current_expiration_days    = var.security_log_days + 1
  noncurrent_expiration_days = 1
  policy_templates           = ["${var.policies_dir}/data/audit-bucket.json"]
  policy_vars = {
    AUDIT_BUCKET             = local.audit_bucket
    TRAIL_ARN                = local.trail_arn
    DATA_ACCOUNT_ID          = var.data_account_id
    MANAGEMENT_ACCOUNT_ID    = var.management_account_id
    ORG_ID                   = var.organization_id
    OWNER_ADMIN_ROLE_PATTERN = var.owner_admin_role_pattern
  }
}

resource "aws_cloudtrail" "organization" {
  name                          = local.trail_name
  s3_bucket_name                = module.audit_bucket.name
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "Management events of every account"
    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  advanced_event_selector {
    name = "S3 data events of the protected buckets (D-19)"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field       = "resources.ARN"
      starts_with = [for arn in var.protected_bucket_arns : "${arn}/"]
    }
  }

  depends_on = [module.audit_bucket]
}

resource "aws_sns_topic" "guard" {
  name = "kauro-guard-alarms"
}

resource "aws_sns_topic_subscription" "owner" {
  topic_arn = aws_sns_topic.guard.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # EventBridge patterns over CloudTrail's "AWS API Call via CloudTrail" events in the data account.
  rules = {
    "kauro-guard-bucket-guards" = {
      description = "A protected bucket's policy, lock, lifecycle, versioning, access, encryption or replication changed."
      pattern = {
        source        = ["aws.s3"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventName = [
            "DeleteBucket", "DeleteBucketCors", "DeleteBucketEncryption", "DeleteBucketLifecycle", "DeleteBucketOwnershipControls",
            "DeleteBucketPolicy", "DeleteBucketPublicAccessBlock", "DeleteBucketReplication", "PutBucketAcl", "PutBucketCors", "PutBucketEncryption",
            "PutBucketLifecycle", "PutBucketObjectLockConfiguration", "PutBucketOwnershipControls", "PutBucketPolicy",
            "PutBucketPublicAccessBlock", "PutBucketReplication", "PutBucketVersioning"
          ]
        }
      }
    }
    "kauro-guard-retention-bypass" = {
      description = "A request bypassed governance retention (every bypass is reported, the deletion identity's included)."
      pattern = {
        source        = ["aws.s3"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          requestParameters = { "x-amz-bypass-governance-retention" = ["true"] }
        }
      }
    }
    "kauro-guard-holds-by-others" = {
      description = "A legal hold was placed or lifted by a principal other than a deletion identity."
      pattern = {
        source        = ["aws.s3"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventName    = ["PutObjectLegalHold"]
          userIdentity = { sessionContext = { sessionIssuer = { userName = [{ "anything-but" = var.deletion_role_names }] } } }
        }
      }
    }
    "kauro-guard-trail" = {
      description = "The audit trail was stopped, deleted or changed."
      pattern = {
        source        = ["aws.cloudtrail"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail        = { eventName = ["DeleteTrail", "PutEventSelectors", "PutInsightSelectors", "StopLogging", "UpdateTrail"] }
      }
    }
    "kauro-guard-iam" = {
      description = "An IAM principal or policy of the data account changed."
      pattern = {
        source        = ["aws.iam"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventName = [
            { prefix = "Attach" }, { prefix = "Create" }, { prefix = "Delete" }, { prefix = "Detach" }, { prefix = "Put" },
            { prefix = "Update" }, { prefix = "SetDefault" }
          ]
        }
      }
    }
    "kauro-guard-deletion-function" = {
      description = "The deletion function, its code-signing configuration or a signing profile changed."
      pattern = {
        source        = ["aws.lambda", "aws.signer"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventName = [
            { prefix = "CreateFunction" }, { prefix = "UpdateFunction" }, { prefix = "PublishVersion" }, { prefix = "DeleteFunction" },
            { prefix = "PutFunctionCodeSigningConfig" }, { prefix = "UpdateCodeSigningConfig" }, { prefix = "DeleteCodeSigningConfig" },
            { prefix = "UpdateAlias" }, { prefix = "AddPermission" }, "PutSigningProfile", "CancelSigningProfile", "RevokeSignature"
          ]
        }
      }
    }
  }
}

locals {
  # One uniform map (name => description, JSON pattern) for for_each: the patterns above differ in shape.
  rule_specs = { for name, rule in local.rules : name => { description = rule.description, pattern = jsonencode(rule.pattern) } }
}

resource "aws_cloudwatch_event_rule" "guard" {
  for_each = local.rule_specs

  name          = each.key
  description   = each.value.description
  event_pattern = each.value.pattern
}

resource "aws_cloudwatch_event_target" "guard" {
  for_each = local.rule_specs

  rule = aws_cloudwatch_event_rule.guard[each.key].name
  arn  = aws_sns_topic.guard.arn
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "EventBridgePublishesTheGuardRules"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.guard.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:events:${var.region}:${var.data_account_id}:rule/kauro-guard-*"]
    }
  }
}

resource "aws_sns_topic_policy" "guard" {
  arn    = aws_sns_topic.guard.arn
  policy = data.aws_iam_policy_document.topic.json
}

output "audit_bucket" {
  value = module.audit_bucket.name
}

output "audit_bucket_policy" {
  value = module.audit_bucket.policy
}

output "trail_arn" {
  value = aws_cloudtrail.organization.arn
}

output "rule_patterns" {
  value = { for name, spec in local.rule_specs : name => spec.pattern }
}
