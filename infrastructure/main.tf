# ==============================================================================
# ECR
# ==============================================================================

# https://registry.terraform.io/modules/terraform-aws-modules/ecr/aws
module "ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "~> 2.0"

  repository_name = local.name

  # Scan images for CVEs on push.
  repository_image_scan_on_push = true

  # Immutable tags: a tag can never be overwritten. Deploy unique tags (e.g. the
  # git SHA) via image_tag — there is no "latest".
  repository_image_tag_mutability = "IMMUTABLE"

  # Keep the repo tidy: retain the 10 most recent images.
  repository_lifecycle_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })

  tags = local.tags
}

# ==============================================================================
# Load Balancer (ALB)
# ==============================================================================

# https://registry.terraform.io/modules/terraform-aws-modules/alb/aws
module "alb" {
  source  = "terraform-aws-modules/alb/aws"
  version = "~> 9.0"

  name    = local.name
  vpc_id  = var.vpc_id
  subnets = var.public_subnet_ids

  enable_deletion_protection = var.enable_deletion_protection

  # The app's keep-alive (65s) sits above this idle timeout (60s) to avoid 502s.
  idle_timeout = 60

  # Public ingress on 80/443; egress only to the tasks' container port.
  security_group_ingress_rules = {
    http = {
      from_port   = 80
      to_port     = 80
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
    https = {
      from_port   = 443
      to_port     = 443
      ip_protocol = "tcp"
      cidr_ipv4   = "0.0.0.0/0"
    }
  }

  # Egress to the tasks' port within the VPC. (Referencing the ECS SG directly
  # would create an ALB<->ECS cycle; the ECS SG ingress references the ALB SG.)
  security_group_egress_rules = {
    to_tasks = {
      from_port   = var.container_port
      to_port     = var.container_port
      ip_protocol = "tcp"
      cidr_ipv4   = data.aws_vpc.selected.cidr_block
    }
  }

  # HTTP only when no cert; otherwise redirect HTTP→HTTPS and serve HTTPS.
  # (Both action keys are kept with one null so the conditional stays type-consistent.)
  listeners = merge(
    {
      http = {
        port     = 80
        protocol = "HTTP"
        forward  = var.certificate_arn == "" ? { target_group_key = "app" } : null
        redirect = var.certificate_arn == "" ? null : {
          port        = "443"
          protocol    = "HTTPS"
          status_code = "HTTP_301"
        }
      }
    },
    var.certificate_arn == "" ? {} : {
      https = {
        port            = 443
        protocol        = "HTTPS"
        certificate_arn = var.certificate_arn
        ssl_policy      = "ELBSecurityPolicy-TLS13-1-2-2021-06"
        forward         = { target_group_key = "app" }
      }
    },
  )

  target_groups = {
    app = {
      backend_protocol = "HTTP"
      backend_port     = var.container_port
      target_type      = "ip" # Fargate awsvpc tasks register by IP
      # ECS registers/deregisters targets, not the module.
      create_attachment = false

      health_check = {
        enabled             = true
        path                = "/healthz"
        port                = "traffic-port"
        protocol            = "HTTP"
        matcher             = "200"
        interval            = 30
        timeout             = 5
        healthy_threshold   = 2
        unhealthy_threshold = 3
      }

      deregistration_delay = 30
    }
  }

  tags = local.tags
}

# ==============================================================================
# ECS (Fargate cluster + service)
# ==============================================================================

# https://registry.terraform.io/modules/terraform-aws-modules/ecs/aws
module "ecs" {
  source  = "terraform-aws-modules/ecs/aws"
  version = "~> 5.0"

  cluster_name = local.name

  # Container Insights for cluster-level observability.
  cluster_settings = [{
    name  = "containerInsights"
    value = "enabled"
  }]

  # Fargate-only capacity. FARGATE_SPOT is available for non-critical workloads.
  fargate_capacity_providers = {
    FARGATE = {
      default_capacity_provider_strategy = { weight = 100 }
    }
  }

  services = {
    app = {
      cpu           = var.cpu
      memory        = var.memory
      desired_count = var.desired_count

      # Roll forward safely.
      deployment_minimum_healthy_percent = 100
      deployment_maximum_percent         = 200

      # Autoscaling. Primary signal is requests-per-task (the actual load driver
      # for a stateless API); CPU and memory are guardrails. App Auto Scaling
      # scales OUT on whichever policy wants the most tasks and IN only when all
      # agree, so the guardrails can add capacity but never force premature
      # scale-in.
      enable_autoscaling       = true
      autoscaling_min_capacity = var.autoscaling_min_capacity
      autoscaling_max_capacity = var.autoscaling_max_capacity
      autoscaling_policies = {
        requests = {
          policy_type = "TargetTrackingScaling"
          target_tracking_scaling_policy_configuration = {
            predefined_metric_specification = {
              predefined_metric_type = "ALBRequestCountPerTarget"
              # Required for this metric. Format: <alb-arn-suffix>/<tg-arn-suffix>.
              resource_label = "${module.alb.arn_suffix}/${module.alb.target_groups["app"].arn_suffix}"
            }
            target_value       = var.autoscaling_request_count_target
            scale_out_cooldown = var.autoscaling_scale_out_cooldown
            scale_in_cooldown  = var.autoscaling_scale_in_cooldown
          }
        }
        cpu = {
          policy_type = "TargetTrackingScaling"
          target_tracking_scaling_policy_configuration = {
            predefined_metric_specification = {
              predefined_metric_type = "ECSServiceAverageCPUUtilization"
            }
            target_value       = var.autoscaling_cpu_target
            scale_out_cooldown = var.autoscaling_scale_out_cooldown
            scale_in_cooldown  = var.autoscaling_scale_in_cooldown
          }
        }
        memory = {
          policy_type = "TargetTrackingScaling"
          target_tracking_scaling_policy_configuration = {
            predefined_metric_specification = {
              predefined_metric_type = "ECSServiceAverageMemoryUtilization"
            }
            target_value       = var.autoscaling_memory_target
            scale_out_cooldown = var.autoscaling_scale_out_cooldown
            scale_in_cooldown  = var.autoscaling_scale_in_cooldown
          }
        }
      }

      container_definitions = {
        (local.container_name) = {
          essential = true
          image     = "${module.ecr.repository_url}:${var.image_tag}"

          port_mappings = [{
            name          = local.container_name
            containerPort = var.container_port
            protocol      = "tcp"
          }]

          # The app is stateless and logs to stdout — lock down the filesystem.
          readonly_root_filesystem = true

          environment = [
            { name = "NODE_ENV", value = lower(var.environment) },
            { name = "PORT", value = tostring(var.container_port) },
            { name = "LOG_LEVEL", value = var.log_level },
            { name = "SERVICE_NAME", value = local.name },
            { name = "CORS_ORIGINS", value = join(",", var.cors_origins) },
            { name = "AZURE_TENANT_ID", value = var.azure_tenant_id },
            { name = "AZURE_CLIENT_ID", value = var.azure_client_id },
            { name = "AZURE_AD_AUDIENCE", value = var.azure_ad_audience },
          ]

          # Module creates the CloudWatch log group and awslogs config.
          create_cloudwatch_log_group            = true
          cloudwatch_log_group_retention_in_days = var.log_retention_days

          # Container-level health check (independent of the ALB target check).
          health_check = {
            command = [
              "CMD-SHELL",
              "node -e \"fetch('http://127.0.0.1:${var.container_port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            ]
            interval    = 30
            timeout     = 5
            retries     = 3
            startPeriod = 10
          }
        }
      }

      load_balancer = {
        app = {
          target_group_arn = module.alb.target_groups["app"].arn
          container_name   = local.container_name
          container_port   = var.container_port
        }
      }

      subnet_ids = var.private_subnet_ids

      # Allow inbound only from the ALB; allow all egress (ECR pull, JWKS, logs).
      security_group_rules = {
        alb_ingress = {
          type                     = "ingress"
          from_port                = var.container_port
          to_port                  = var.container_port
          protocol                 = "tcp"
          source_security_group_id = module.alb.security_group_id
        }
        egress_all = {
          type        = "egress"
          from_port   = 0
          to_port     = 0
          protocol    = "-1"
          cidr_blocks = ["0.0.0.0/0"]
        }
      }

      tags = local.tags
    }
  }

  tags = local.tags
}

# ==============================================================================
# Monitoring (CloudWatch alarms)
# ==============================================================================

# Alarms on the load balancer's view of the service. Actions fire only when an
# SNS topic is supplied. ALB metrics are always present (unlike the app's EMF
# metrics, which require traffic), so they're reliable for alerting.

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-target-5xx"
  alarm_description   = "Backend tasks are returning 5xx responses."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = module.alb.arn_suffix
    TargetGroup  = module.alb.target_groups["app"].arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
  tags          = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  alarm_name          = "${local.name}-target-latency"
  alarm_description   = "p95 target response time is high."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1 # seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = module.alb.arn_suffix
    TargetGroup  = module.alb.target_groups["app"].arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions
  tags          = local.tags
}