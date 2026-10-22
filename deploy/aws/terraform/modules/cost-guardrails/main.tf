# Spend visibility and a backstop for the organization (Order 25 §6; R2-075). Applied in the management account, where consolidated
# billing lives. Costs: budget monitoring and notifications are free; the first two action-enabled budgets are free; Cost Anomaly
# Detection is free (AWS Budgets pricing page, read 2026-10-22). Billing data reaches Budgets hours late, so this is visibility and
# a backstop, never the cap: the application's reservations and job limits are (R2-075).

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "policies_dir" {
  type = string
}

variable "monthly_ceiling_usd" {
  description = "The owner's monthly cloud ceiling in USD. No default: A9 §6 says the historical figures are not an accepted budget, and the funding row of policy.json (USD 220/month) covers more than cloud. BLOCKED_OWNER until the owner states it."
  type        = number

  validation {
    condition     = var.monthly_ceiling_usd > 0 && var.monthly_ceiling_usd <= 220
    error_message = "The ceiling is positive and never above the owner's monthly funding (policy.json monthlyOwnerFundingCents = 22000)."
  }
}

variable "alert_email" {
  description = "Where budget and anomaly notices go (the owner's professional mailbox)."
  type        = string

  validation {
    condition     = can(regex("@kaurodata\\.com$", var.alert_email))
    error_message = "Alerts go to the company's professional mailbox (kaurodata.com)."
  }
}

variable "anomaly_threshold_usd" {
  description = "Absolute daily impact above which an anomaly is e-mailed."
  type        = number
  default     = 5
}

variable "spend_stop_approval" {
  description = "AUTOMATIC applies the spend-stop SCP at 100 % of actual spend; MANUAL e-mails the owner to approve it."
  type        = string
  default     = "AUTOMATIC"

  validation {
    condition     = contains(["AUTOMATIC", "MANUAL"], var.spend_stop_approval)
    error_message = "AUTOMATIC or MANUAL."
  }
}

variable "workloads_ou_id" {
  type = string
}

variable "owner_admin_role_pattern" {
  type = string
}

variable "management_account_id" {
  type = string
}

module "spend_stop" {
  source    = "../policy-template"
  templates = ["${var.policies_dir}/organization/scp-spend-stop.json"]
  vars      = { OWNER_ADMIN_ROLE_PATTERN = var.owner_admin_role_pattern }
}

# Created but attached by nobody: Budgets attaches it (below) when the ceiling is reached; the owner detaches it.
resource "aws_organizations_policy" "spend_stop" {
  name        = "kauro-spend-stop"
  type        = "SERVICE_CONTROL_POLICY"
  description = "Kauro Order 25: attached by AWS Budgets at the monthly ceiling (deploy/aws/policies/organization/scp-spend-stop.json)"
  content     = module.spend_stop.json
}

resource "aws_budgets_budget" "monthly" {
  name         = "kauro-monthly-ceiling"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_ceiling_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

data "aws_iam_policy_document" "budgets_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    # Confused-deputy guard: only this account's budgets assume the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.management_account_id]
    }
  }
}

resource "aws_iam_role" "budgets_action" {
  name               = "kauro-budgets-spend-stop"
  path               = "/kauro-guard/"
  assume_role_policy = data.aws_iam_policy_document.budgets_trust.json
}

data "aws_iam_policy_document" "budgets_action" {
  statement {
    sid       = "AttachOnlyTheSpendStop"
    actions   = ["organizations:AttachPolicy", "organizations:DetachPolicy"]
    resources = [aws_organizations_policy.spend_stop.arn, "arn:aws:organizations::*:ou/*/${var.workloads_ou_id}"]
  }
  statement {
    sid       = "DescribeTheSpendStopAndItsTarget"
    actions   = ["organizations:DescribePolicy", "organizations:ListPoliciesForTarget", "organizations:ListTargetsForPolicy"]
    resources = [aws_organizations_policy.spend_stop.arn, "arn:aws:organizations::*:ou/*/${var.workloads_ou_id}"]
  }
  statement {
    # DescribeOrganization has no resource-level permission (Service Authorization Reference).
    sid       = "DescribeTheOrganization"
    actions   = ["organizations:DescribeOrganization"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "budgets_action" {
  name   = "attach-spend-stop"
  role   = aws_iam_role.budgets_action.id
  policy = data.aws_iam_policy_document.budgets_action.json
}

resource "aws_budgets_budget_action" "spend_stop" {
  budget_name        = aws_budgets_budget.monthly.name
  action_type        = "APPLY_SCP_POLICY"
  approval_model     = var.spend_stop_approval
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.budgets_action.arn

  action_threshold {
    action_threshold_type  = "PERCENTAGE"
    action_threshold_value = 100
  }

  definition {
    scp_action_definition {
      policy_id  = aws_organizations_policy.spend_stop.id
      target_ids = [var.workloads_ou_id]
    }
  }

  subscriber {
    address           = var.alert_email
    subscription_type = "EMAIL"
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = "kauro-services"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily" {
  name             = "kauro-daily-anomalies"
  frequency        = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.services.arn]

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }
}

output "spend_stop_policy" {
  value = module.spend_stop.json
}

output "budget_limit" {
  value = aws_budgets_budget.monthly.limit_amount
}
