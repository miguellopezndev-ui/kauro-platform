# Pinned toolchain (Order 25 §8). The provider is pinned exactly and its checksums are committed in .terraform.lock.hcl; Terraform
# and OpenTofu both run this root (CI: .github/workflows/aws-iac.yml).
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.68.0"
    }
  }

  # Partial configuration: bucket, key and region come from backend.hcl at activation (procedures/PROVISIONING.md). Offline
  # checks run with -backend=false; nothing in the repository names a real bucket.
  backend "s3" {}
}
