# Alarms in the management account (independent review, Order 25). No SCP or RCP binds the management account's own principals, so
# what they do to the guards is made visible instead: stopping or changing the organization trail (which AWS makes a management
# account resource even though the data account manages it), and detaching, changing or disabling the guard policies. E-mail to the
# owner's professional mailbox; EventBridge rules on AWS API events of the account's default bus.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "region" {
  type = string
}

variable "management_account_id" {
  type = string
}

variable "alarm_email" {
  type = string

  validation {
    condition     = can(regex("@kaurodata\\.com$", var.alarm_email))
    error_message = "Alarms go to the company's professional mailbox (kaurodata.com)."
  }
}

locals {
  rules = {
    "kauro-guard-organization-trail" = {
      description = "The organization trail (owned by this account) was stopped, deleted or changed."
      pattern = {
        source        = ["aws.cloudtrail"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail        = { eventName = ["DeleteTrail", "PutEventSelectors", "PutInsightSelectors", "StopLogging", "UpdateTrail"] }
      }
    }
    "kauro-guard-organization-policies" = {
      description = "A guard SCP or RCP was detached, changed, deleted, or a policy type disabled."
      pattern = {
        source        = ["aws.organizations"]
        "detail-type" = ["AWS API Call via CloudTrail"]
        detail = {
          eventName = ["AttachPolicy", "DeletePolicy", "DetachPolicy", "DisablePolicyType", "MoveAccount", "RemoveAccountFromOrganization", "UpdatePolicy"]
        }
      }
    }
  }
  rule_specs = { for name, rule in local.rules : name => { description = rule.description, pattern = jsonencode(rule.pattern) } }
}

resource "aws_sns_topic" "guard" {
  name = "kauro-guard-alarms"
}

resource "aws_sns_topic_subscription" "owner" {
  topic_arn = aws_sns_topic.guard.arn
  protocol  = "email"
  endpoint  = var.alarm_email
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
      values   = ["arn:aws:events:${var.region}:${var.management_account_id}:rule/kauro-guard-*"]
    }
  }
}

resource "aws_sns_topic_policy" "guard" {
  arn    = aws_sns_topic.guard.arn
  policy = data.aws_iam_policy_document.topic.json
}

output "rule_patterns" {
  value = { for name, spec in local.rule_specs : name => spec.pattern }
}
