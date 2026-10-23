# Bedrock for Intelligence Core (Order 26A; A9 §4): prepared offline, created by nobody. With enabled = false (the default) this
# module asks AWS for nothing. Enabled, it creates three things and no others: the campaign runner's invoke policy, the Bedrock
# guard SCP (attached to the Workloads OU) and a Bedrock-only budget that notifies. It never creates an invocation logging
# configuration (inputs and outputs are not stored; the SCP denies anyone turning it on), provisioned throughput, a custom model,
# an agent or a model access subscription. Model access itself is an act in the console that the owner performs after the
# live probes (README.md); no resource here requests it.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "enabled" {
  description = "Off until the owner's activation reference exists (A9 §5: no AWS account yet)."
  type        = bool
  default     = false
}

variable "activation_reference" {
  description = "The owner's approval this activation stands on (the stage grant). Required when enabled."
  type        = string
  default     = null

  validation {
    condition     = var.activation_reference == null || can(regex("^[A-Za-z0-9._:/-]{8,128}$", var.activation_reference))
    error_message = "An activation reference is a label of 8 to 128 safe characters."
  }
}

variable "policies_dir" {
  description = "deploy/aws/bedrock/policies"
  type        = string
}

variable "account_id" {
  type = string
}

variable "workloads_ou_id" {
  type = string
}

variable "owner_admin_role_pattern" {
  description = "The owner's Identity Center administrator role pattern (Order 25's OWNER_ADMIN_ROLE_PATTERN): the one session that may subscribe to a model."
  type        = string
}

variable "source_region" {
  type    = string
  default = "us-east-1"

  validation {
    condition     = contains(["us-east-1", "us-west-2"], var.source_region)
    error_message = "The source Region is a US Region the us. geography profile is offered in (D4-BR-1)."
  }
}

variable "granted_profile_id" {
  type    = string
  default = "us.anthropic.claude-sonnet-5-5"

  validation {
    condition     = can(regex("^us\\.anthropic\\.claude-sonnet-", var.granted_profile_id))
    error_message = "Only a us. geography Sonnet profile is granted (A9 §4: Opus needs a new approval)."
  }
}

variable "granted_model_id" {
  description = "The foundation model behind the profile, as GetInferenceProfile lists it (PENDING_PROVIDER until probe P1)."
  type        = string
  default     = "anthropic.claude-sonnet-5-5*"
}

variable "budget_ceiling_usd" {
  description = "The Bedrock budget's limit: at most the sum of the owner's grants B04-A (40) and B04-B (120)."
  type        = number
  default     = 160

  validation {
    condition     = var.budget_ceiling_usd > 0 && var.budget_ceiling_usd <= 160
    error_message = "The Bedrock budget never exceeds the granted USD 160 (A9 §4)."
  }
}

variable "alert_email" {
  type    = string
  default = null
}

locals {
  on = var.enabled && var.activation_reference != null
  vars = {
    ACCOUNT_ID         = var.account_id
    SOURCE_REGION      = var.source_region
    GRANTED_PROFILE_ID = var.granted_profile_id
    GRANTED_MODEL_ID   = var.granted_model_id
  }
  invoke   = jsondecode(templatefile("${var.policies_dir}/bedrock-invoke.policy.json", local.vars))
  guard    = jsondecode(templatefile("${var.policies_dir}/scp-bedrock-guard.json", { OWNER_ADMIN_ROLE_PATTERN = var.owner_admin_role_pattern }))
  invoke_d = { Version = local.invoke.Version, Statement = local.invoke.Statement }
  guard_d  = { Version = local.guard.Version, Statement = local.guard.Statement }
}

resource "aws_iam_policy" "invoke" {
  count       = local.on ? 1 : 0
  name        = "kauro-ic-bedrock-invoke"
  path        = "/kauro-runtime/"
  description = "Order 26A: InvokeModel on the granted us. Sonnet profile only (${var.activation_reference})"
  policy      = jsonencode(local.invoke_d)
}

resource "aws_organizations_policy" "guard" {
  count       = local.on ? 1 : 0
  name        = "kauro-bedrock-guard"
  type        = "SERVICE_CONTROL_POLICY"
  description = "Order 26A: no stored invocations, no committed cost, US Regions, InvokeModel only, no Opus"
  content     = jsonencode(local.guard_d)
}

resource "aws_organizations_policy_attachment" "guard" {
  count     = local.on ? 1 : 0
  policy_id = aws_organizations_policy.guard[0].id
  target_id = var.workloads_ou_id
}

resource "aws_budgets_budget" "bedrock" {
  count        = local.on ? 1 : 0
  name         = "kauro-bedrock-grants"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_ceiling_usd)
  limit_unit   = "USD"
  time_unit    = "ANNUALLY"

  cost_filter {
    name   = "Service"
    values = ["Amazon Bedrock"]
  }

  dynamic "notification" {
    for_each = var.alert_email == null ? [] : [25, 50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.alert_email]
    }
  }
}

output "created" {
  value = local.on
}
