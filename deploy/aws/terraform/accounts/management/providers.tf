# The provider refuses every account but the management account (allowed_account_ids), and it carries no credentials: the owner's
# Identity Center session supplies them at activation. Every resource is tagged with its source and the activation reference.
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.management_account_id]

  default_tags {
    tags = {
      Project    = "kauro"
      Account    = "management"
      ManagedBy  = "terraform"
      Source     = "deploy/aws/terraform/accounts/management"
      Activation = try(var.activation_authorization.reference, "none")
    }
  }
}
