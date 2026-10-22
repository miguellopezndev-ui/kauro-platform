# Offline plan tests of the workload network (mocked provider): no public address, endpoints in one zone, the worker's only egress.

mock_provider "aws" {
  override_during = plan
  mock_data "aws_ec2_managed_prefix_list" {
    defaults = { id = "pl-63a5400a" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0123456789abcdef0" }
  }
}

variables {
  environment        = "qualification"
  region             = "us-east-1"
  object_bucket_arns = ["arn:aws:s3:::kauro-qualification-customer-data-222222222222"]
}

run "no_subnet_gives_a_public_address" {
  command = plan

  assert {
    condition     = aws_subnet.worker.map_public_ip_on_launch == false && alltrue([for s in aws_subnet.database : s.map_public_ip_on_launch == false])
    error_message = "Private subnets only."
  }
  assert {
    condition     = aws_subnet.database[0].availability_zone_id != aws_subnet.database[1].availability_zone_id
    error_message = "RDS needs its subnet group in two zones."
  }
  assert {
    condition     = aws_subnet.worker.availability_zone_id == "use1-az1"
    error_message = "Zones are pinned by zone ID, so a new zone never moves a subnet."
  }
}

run "the_s3_endpoint_is_a_free_gateway" {
  command = plan

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" && aws_vpc_endpoint.s3.service_name == "com.amazonaws.us-east-1.s3"
    error_message = "S3 is reached through the gateway endpoint."
  }
}

run "worker_egress_is_https_to_s3_and_the_endpoints_only" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_egress_rule.worker_to_s3.from_port == 443 && aws_vpc_security_group_egress_rule.worker_to_s3.prefix_list_id == "pl-63a5400a" && aws_vpc_security_group_egress_rule.worker_to_s3.cidr_ipv4 == null
    error_message = "HTTPS to the S3 prefix list, no CIDR."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.worker_to_endpoints.to_port == 443 && aws_vpc_security_group_egress_rule.worker_to_endpoints.cidr_ipv4 == null
    error_message = "HTTPS to the endpoints' group, no CIDR."
  }
}

run "endpoints_exist_only_when_enabled_and_in_one_zone" {
  command = plan
  variables {
    worker_endpoints_enabled = true
  }

  assert {
    condition     = length(aws_vpc_endpoint.interface) == 3 && alltrue([for e in aws_vpc_endpoint.interface : length(e.subnet_ids) == 1 && e.private_dns_enabled])
    error_message = "Three interface endpoints, one subnet (one AZ) each, private DNS."
  }
}
