# Renders one or more policy templates of deploy/aws/policies (and the worker contracts in deploy/aws/worker) into one IAM policy
# document. The templates are the single source the offline evaluator (deploy/aws/checks) reads too: Terraform never restates a
# statement by hand. "$comment" members are documentation and are dropped; the statements of every template are concatenated in order.

terraform {
  required_version = ">= 1.9.0"
}

variable "templates" {
  description = "Paths of the JSON templates whose statements form the document, in order."
  type        = list(string)

  validation {
    condition     = length(var.templates) > 0
    error_message = "At least one template is required."
  }
}

variable "vars" {
  description = "Values of the $${NAME} placeholders. Every placeholder a template uses must be given."
  type        = map(string)
}

locals {
  decoded    = [for path in var.templates : jsondecode(templatefile(path, var.vars))]
  statements = flatten([for doc in local.decoded : doc.Statement])
  sids       = [for statement in local.statements : statement.Sid]
  document   = jsonencode({ Version = "2012-10-17", Statement = local.statements })
}

output "json" {
  description = "The minified policy document."
  value       = local.document

  precondition {
    condition     = length(local.sids) == length(distinct(local.sids))
    error_message = "Two statements share a Sid; IAM refuses the document."
  }
}

output "statements" {
  description = "The statements, for tests."
  value       = local.statements
}

output "size" {
  description = "Characters of the minified document (SCPs and RCPs: at most 5,120)."
  value       = length(local.document)
}
