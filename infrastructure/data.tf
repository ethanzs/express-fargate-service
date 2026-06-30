# ==============================================================================
# Network (pre-existing VPC + subnets)
# ==============================================================================

# Pulls the existing VPC by id; its CIDR scopes the ALB→tasks egress rule.
data "aws_vpc" "selected" {
  id = var.vpc_id
}

# Validate the provided subnet ids belong to the VPC (and expose their details).
data "aws_subnet" "public" {
  for_each = toset(var.public_subnet_ids)
  id       = each.value

  lifecycle {
    postcondition {
      condition     = self.vpc_id == var.vpc_id
      error_message = "Public subnet ${self.id} is not in VPC ${var.vpc_id}."
    }
  }
}

data "aws_subnet" "private" {
  for_each = toset(var.private_subnet_ids)
  id       = each.value

  lifecycle {
    postcondition {
      condition     = self.vpc_id == var.vpc_id
      error_message = "Private subnet ${self.id} is not in VPC ${var.vpc_id}."
    }
  }
}