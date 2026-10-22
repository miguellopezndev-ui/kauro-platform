# The provider refuses every account but the workload account (allowed_account_ids), and it carries no credentials: the owner's
# Identity Center session supplies them at activation (the GitHub deploy identity cannot apply Terraform).
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.workload_account_id]

  default_tags {
    tags = {
      Project     = "kauro"
      Account     = "workload"
      Environment = var.environment
      ManagedBy   = "terraform"
      Source      = "deploy/aws/terraform/accounts/workload"
      Activation  = try(var.activation_authorization.reference, "none")
    }
  }
}
