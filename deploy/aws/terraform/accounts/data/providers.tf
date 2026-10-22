# The provider refuses every account but the data account (allowed_account_ids), and it carries no credentials: the owner's
# Identity Center session supplies them at activation. The data account has no automated identity at all.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.data_account_id]

  default_tags {
    tags = {
      Project     = "kauro"
      Account     = "data"
      Environment = var.environment
      ManagedBy   = "terraform"
      Source      = "deploy/aws/terraform/accounts/data"
      Activation  = try(var.activation_authorization.reference, "none")
    }
  }
}
