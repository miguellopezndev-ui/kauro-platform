# The workload VPC (B14-A qualification §4; deploy/aws/worker/README.md "Configuration per environment"). Private subnets only: no
# internet gateway, no NAT, no public IP, no route out of the VPC except the S3 gateway endpoint (free) and, while the worker is
# enabled, the ecr.api, ecr.dkr and logs interface endpoints in ONE Availability Zone (A9: no permanent HA). Interface endpoints are
# the worker's only fixed cost (USD 0.01 per endpoint-hour, plus USD 0.01/GB processed, us-east-1 price list): with
# worker_endpoints_enabled = false they do not exist, no worker task can pull its image or log, and RunTask fails closed.
# The database subnets are two because RDS requires a subnet group in two Availability Zones even for one Single-AZ instance.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 6.68.0, < 7.0.0" }
  }
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "cidr" {
  description = "The VPC's CIDR block."
  type        = string
  default     = "10.40.0.0/16"
}

variable "worker_endpoints_enabled" {
  description = "Create the three interface endpoints the worker needs (about USD 21.90/month in one AZ). False until the first real attempt is authorized."
  type        = bool
  default     = false
}

variable "object_bucket_arns" {
  description = "The customer-data buckets (data account) the S3 gateway endpoint may reach."
  type        = list(string)
}

variable "zone_ids" {
  description = "Two Availability Zone IDs (zone IDs, not names: names map to different zones in each account). The first holds the worker and its endpoints; both hold the database subnet group. Fargate and db.t4g availability in them is checked at activation."
  type        = list(string)
  default     = ["use1-az1", "use1-az2"]

  validation {
    condition     = length(var.zone_ids) == 2 && length(distinct(var.zone_ids)) == 2
    error_message = "Exactly two distinct zone IDs."
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "kauro-${var.environment}" }
}

# The default security group of the VPC denies everything: no rule at all.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "worker" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 4, 0)
  availability_zone_id    = var.zone_ids[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "kauro-${var.environment}-worker", Tier = "private" }
}

resource "aws_subnet" "database" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.cidr, 8, 32 + count.index)
  availability_zone_id    = var.zone_ids[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "kauro-${var.environment}-database-${count.index}", Tier = "private" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "kauro-${var.environment}-private" }
}

resource "aws_route_table_association" "worker" {
  subnet_id      = aws_subnet.worker.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- S3 gateway endpoint: free; the only S3 path of the VPC; limited to the platform's buckets and ECR's layer bucket ---------------

data "aws_iam_policy_document" "s3_endpoint" {
  statement {
    sid     = "PlatformBuckets"
    actions = ["s3:*"]
    resources = flatten([
      for arn in var.object_bucket_arns : [arn, "${arn}/*"]
    ])
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
  statement {
    # Fargate platform 1.4 pulls ECR image layers from this AWS-owned bucket (Amazon ECR user guide, VPC endpoints).
    sid       = "EcrLayers"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::prod-${var.region}-starport-layer-bucket/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  policy            = data.aws_iam_policy_document.s3_endpoint.json
  tags              = { Name = "kauro-${var.environment}-s3" }
}

data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.region}.s3"
}

# --- Security groups --------------------------------------------------------------------------------------------------------------

resource "aws_security_group" "worker" {
  name        = "kauro-${var.environment}-worker"
  description = "Migration worker tasks: no ingress; HTTPS only to the VPC endpoints and the S3 gateway prefix list."
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "kauro-${var.environment}-worker" }
}

resource "aws_vpc_security_group_egress_rule" "worker_to_s3" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS to S3 through the gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
}

resource "aws_security_group" "endpoints" {
  name        = "kauro-${var.environment}-endpoints"
  description = "Interface endpoints: HTTPS from the worker and platform groups only; no egress."
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "kauro-${var.environment}-endpoints" }
}

resource "aws_vpc_security_group_egress_rule" "worker_to_endpoints" {
  security_group_id            = aws_security_group.worker.id
  description                  = "HTTPS to the interface endpoints (ECR, logs)"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_worker" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from worker tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.worker.id
}

# The platform group is what the control plane (and, once its runtime is chosen, the API) runs in. It reaches the database, the
# endpoints and S3; nothing reaches it from outside the VPC (no load balancer exists: B14-api-runtime is undecided).
resource "aws_security_group" "platform" {
  name        = "kauro-${var.environment}-platform"
  description = "Control plane (and future API) tasks: no ingress; HTTPS to endpoints and S3, PostgreSQL to the database group."
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "kauro-${var.environment}-platform" }
}

resource "aws_vpc_security_group_egress_rule" "platform_to_s3" {
  security_group_id = aws_security_group.platform.id
  description       = "HTTPS to S3 through the gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
}

resource "aws_vpc_security_group_egress_rule" "platform_to_endpoints" {
  security_group_id            = aws_security_group.platform.id
  description                  = "HTTPS to the interface endpoints"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.endpoints.id
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_from_platform" {
  security_group_id            = aws_security_group.endpoints.id
  description                  = "HTTPS from platform tasks"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.platform.id
}

resource "aws_security_group" "database" {
  name        = "kauro-${var.environment}-database"
  description = "PostgreSQL: TCP 5432 from the platform group only; no egress."
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "kauro-${var.environment}-database" }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_platform" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from platform tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.platform.id
}

resource "aws_vpc_security_group_egress_rule" "platform_to_database" {
  security_group_id            = aws_security_group.platform.id
  description                  = "PostgreSQL to the database"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

# --- Interface endpoints (fixed cost; one AZ; only while the worker is enabled) -----------------------------------------------------

locals {
  interface_services = var.worker_endpoints_enabled ? toset(["ecr.api", "ecr.dkr", "logs"]) : toset([])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.worker.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "kauro-${var.environment}-${each.key}" }
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "worker_subnet_id" {
  value = aws_subnet.worker.id
}

output "database_subnet_ids" {
  value = aws_subnet.database[*].id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "platform_security_group_id" {
  value = aws_security_group.platform.id
}

output "database_security_group_id" {
  value = aws_security_group.database.id
}

output "s3_gateway_endpoint_id" {
  value = aws_vpc_endpoint.s3.id
}

output "interface_endpoints" {
  value = sort(tolist(local.interface_services))
}
