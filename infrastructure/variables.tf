variable "project_name" {
  description = "Short name used to prefix/identify resources."
  type        = string
  default     = "express-fargate"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)."
  type        = string
  default     = "dev"
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags merged onto the default tags."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Networking (pre-existing VPC)
# ---------------------------------------------------------------------------

variable "vpc_id" {
  description = "Id of the existing VPC to deploy into."
  type        = string

  validation {
    condition     = can(regex("^vpc-", var.vpc_id))
    error_message = "vpc_id must be a VPC id (vpc-...)."
  }
}

variable "public_subnet_ids" {
  description = "Existing public subnet ids for the internet-facing ALB."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "Provide at least two public subnets (across AZs) for the ALB."
  }
}

variable "private_subnet_ids" {
  description = "Existing private subnet ids for the Fargate tasks (need NAT egress)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Provide at least two private subnets (across AZs) for the tasks."
  }
}

# ---------------------------------------------------------------------------
# Container / service sizing
# ---------------------------------------------------------------------------

variable "container_port" {
  description = "Port the app listens on (must match PORT)."
  type        = number
  default     = 3000
}

variable "cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "memory" {
  description = "Fargate task memory (MiB)."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Baseline number of running tasks."
  type        = number
  default     = 2
}

variable "autoscaling_min_capacity" {
  description = "Minimum tasks under autoscaling."
  type        = number
  default     = 2
}

variable "autoscaling_max_capacity" {
  description = "Maximum tasks under autoscaling."
  type        = number
  default     = 6
}

variable "autoscaling_request_count_target" {
  description = "Primary signal: target ALB requests per task per minute. Calibrate from a load test (≈70-80% of a single task's sustainable RPS)."
  type        = number
  default     = 1000
}

variable "autoscaling_cpu_target" {
  description = "Guardrail: target average CPU utilization (%)."
  type        = number
  default     = 70
}

variable "autoscaling_memory_target" {
  description = "Guardrail: target average memory utilization (%)."
  type        = number
  default     = 70
}

variable "autoscaling_scale_out_cooldown" {
  description = "Seconds between scale-out actions (bias: fast out)."
  type        = number
  default     = 60
}

variable "autoscaling_scale_in_cooldown" {
  description = "Seconds between scale-in actions (bias: slow in)."
  type        = number
  default     = 300
}

variable "image_tag" {
  description = "Immutable container image tag to deploy (e.g. the git SHA). No 'latest'."
  type        = string

  validation {
    condition     = length(var.image_tag) > 0 && var.image_tag != "latest"
    error_message = "image_tag must be an explicit immutable tag (e.g. a git SHA), not 'latest'."
  }
}

# ---------------------------------------------------------------------------
# App configuration (passed to the container as environment)
# ---------------------------------------------------------------------------

variable "log_level" {
  description = "Application LOG_LEVEL."
  type        = string
  default     = "info"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the service log group."
  type        = number
  default     = 30
}

variable "cors_origins" {
  description = "Browser origins allowed to call the API (the SPA)."
  type        = list(string)
  default     = []
}

variable "azure_tenant_id" {
  description = "Entra ID tenant id (AZURE_TENANT_ID). Required — the app exits without it in production."
  type        = string

  validation {
    condition     = length(var.azure_tenant_id) > 0
    error_message = "azure_tenant_id must be set."
  }
}

variable "azure_client_id" {
  description = "Entra ID application (client) id (AZURE_CLIENT_ID)."
  type        = string

  validation {
    condition     = length(var.azure_client_id) > 0
    error_message = "azure_client_id must be set."
  }
}

variable "azure_ad_audience" {
  description = "Expected token audience (AZURE_AD_AUDIENCE)."
  type        = string

  validation {
    condition     = length(var.azure_ad_audience) > 0
    error_message = "azure_ad_audience must be set."
  }
}

# ---------------------------------------------------------------------------
# Load balancer / TLS
# ---------------------------------------------------------------------------

variable "certificate_arn" {
  description = "ACM certificate ARN. When set, the ALB serves HTTPS and redirects HTTP→HTTPS; when empty, HTTP only."
  type        = string
  default     = ""
}

variable "enable_deletion_protection" {
  description = "Protect the ALB from accidental deletion (enable for prod)."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

variable "alarm_sns_topic_arn" {
  description = "Optional SNS topic ARN that CloudWatch alarms notify. Empty disables notifications."
  type        = string
  default     = ""
}
