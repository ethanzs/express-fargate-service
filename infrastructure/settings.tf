# ==============================================================================
# Terraform
# ==============================================================================

terraform {
  # 1.11+ for write-only arguments (the RDS master password never touches
  # state); 1.10+ already gave native S3 state locking (use_lockfile).
  required_version = ">= 1.11.1"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Remote state. Left commented so `terraform init` works out of the box with
  # local state. For anything shared/long-lived, create a versioned + encrypted
  # S3 bucket once, then uncomment and `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket       = "my-terraform-state-bucket"
  #   key          = "express-fargate/terraform.tfstate"
  #   region       = "us-east-1"
  #   encrypt      = true
  #   use_lockfile = true
  # }
}

# ==============================================================================
# AWS Provider
# ==============================================================================

provider "aws" {
  region = var.region

  # Tag every taggable resource consistently.
  default_tags {
    tags = local.tags
  }
}