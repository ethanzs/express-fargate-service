# ==============================================================================
# ECR
# ==============================================================================

# https://registry.terraform.io/modules/terraform-aws-modules/ecr/aws
module "ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "~> 3.0"

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

# Separate repo for the hydrator image; same policies as the app repo.
module "hydrator_ecr" {
  source  = "terraform-aws-modules/ecr/aws"
  version = "~> 3.0"

  repository_name = local.hydrator_name

  repository_image_scan_on_push   = true
  repository_image_tag_mutability = "IMMUTABLE"

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
  version = "~> 10.0"

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
  version = "~> 7.0"

  cluster_name = local.name

  # Container Insights for cluster-level observability.
  cluster_setting = [{
    name  = "containerInsights"
    value = "enabled"
  }]

  # Associate the built-in Fargate capacity providers; default to FARGATE.
  # (FARGATE_SPOT is available for non-critical workloads.)
  cluster_capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy = {
    FARGATE = { weight = 100 }
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
            { name = "VALKEY_URL", value = local.valkey_url },
            # IAM database auth: no password anywhere — the app mints
            # short-lived tokens as the `api` DB user via its task role.
            { name = "DB_AUTH", value = "iam" },
            { name = "DB_HOST", value = module.db.db_instance_address },
            { name = "DB_PORT", value = tostring(module.db.db_instance_port) },
            { name = "DB_NAME", value = local.db_name },
            { name = "DB_USER", value = local.db_service_users.api },
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

      # The task role may mint IAM auth tokens for the `api` DB user only.
      tasks_iam_role_statements = [
        {
          sid       = "RdsIamConnect"
          actions   = ["rds-db:connect"]
          resources = ["${local.rds_connect_arn_prefix}/${local.db_service_users.api}"]
        }
      ]

      load_balancer = {
        app = {
          target_group_arn = module.alb.target_groups["app"].arn
          container_name   = local.container_name
          container_port   = var.container_port
        }
      }

      subnet_ids = var.private_subnet_ids

      # Allow inbound only from the ALB; allow all egress (ECR pull, JWKS, logs).
      security_group_ingress_rules = {
        alb = {
          from_port                    = var.container_port
          to_port                      = var.container_port
          ip_protocol                  = "tcp"
          referenced_security_group_id = module.alb.security_group_id
        }
      }
      security_group_egress_rules = {
        all = {
          ip_protocol = "-1"
          cidr_ipv4   = "0.0.0.0/0"
        }
      }

      tags = local.tags
    }

    # The hydrator is a run-to-completion job, not a service: create_service =
    # false makes the module produce only the task definition + IAM roles +
    # security group + log group. EventBridge Scheduler (below) launches one
    # task per schedule; it exits when hydration finishes, so nothing runs (or
    # bills) between runs.
    hydrator = {
      create_service = false

      cpu    = var.hydrator_cpu
      memory = var.hydrator_memory

      container_definitions = {
        (local.hydrator_container_name) = {
          essential = true
          image     = "${module.hydrator_ecr.repository_url}:${var.hydrator_image_tag}"

          # No ports — the hydrator serves nothing.
          readonly_root_filesystem = true

          environment = [
            { name = "NODE_ENV", value = lower(var.environment) },
            { name = "LOG_LEVEL", value = var.log_level },
            { name = "SERVICE_NAME", value = local.hydrator_name },
            { name = "VALKEY_URL", value = local.valkey_url },
            # IAM database auth: short-lived tokens as the `hydrator` DB user.
            { name = "DB_AUTH", value = "iam" },
            { name = "DB_HOST", value = module.db.db_instance_address },
            { name = "DB_PORT", value = tostring(module.db.db_instance_port) },
            { name = "DB_NAME", value = local.db_name },
            { name = "DB_USER", value = local.db_service_users.hydrator },
          ]

          create_cloudwatch_log_group            = true
          cloudwatch_log_group_retention_in_days = var.log_retention_days
        }
      }

      # The task role may mint IAM auth tokens for the `hydrator` DB user only.
      tasks_iam_role_statements = [
        {
          sid       = "RdsIamConnect"
          actions   = ["rds-db:connect"]
          resources = ["${local.rds_connect_arn_prefix}/${local.db_service_users.hydrator}"]
        }
      ]

      subnet_ids = var.private_subnet_ids

      # No ingress — nothing calls the hydrator. Egress for ECR/logs and to
      # reach RDS/Valkey (their SGs admit this task SG).
      security_group_egress_rules = {
        all = {
          ip_protocol = "-1"
          cidr_ipv4   = "0.0.0.0/0"
        }
      }

      tags = local.tags
    }

  }

  tags = local.tags
}

# ==============================================================================
# Data stores (RDS Postgres + ElastiCache Valkey)
# ==============================================================================

# Postgres is the system of record, Valkey the cache in front of it. The
# hydrator writes both on its schedule; the api reads cache-first. Both stores
# admit only the two task security groups — nothing else in the VPC.

resource "aws_security_group" "db" {
  name_prefix = "${local.name}-postgres-"
  description = "RDS Postgres - ingress only from the api and hydrator tasks"
  vpc_id      = var.vpc_id

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each = local.datastore_clients

  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from the ${each.key} tasks"
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  referenced_security_group_id = each.value

  tags = local.tags
}

resource "aws_security_group" "valkey" {
  name_prefix = "${local.name}-valkey-"
  description = "ElastiCache Valkey - ingress only from the api and hydrator tasks"
  vpc_id      = var.vpc_id

  tags = local.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "valkey" {
  for_each = local.datastore_clients

  security_group_id            = aws_security_group.valkey.id
  description                  = "Valkey from the ${each.key} tasks"
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  referenced_security_group_id = each.value

  tags = local.tags
}

# https://registry.terraform.io/modules/terraform-aws-modules/rds/aws
module "db" {
  source  = "terraform-aws-modules/rds/aws"
  version = "~> 7.0"

  identifier = "${local.name}-postgres"

  engine         = "postgres"
  engine_version = var.db_engine_version
  family         = local.db_parameter_group_family
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_encrypted     = true

  db_name  = local.db_name
  username = local.db_username
  # Services authenticate with IAM (short-lived tokens via their task roles),
  # so no credential is distributed anywhere. The master password exists only
  # for the one-time db_bootstrap task and is generated, stored, and rotatable
  # by RDS itself in Secrets Manager.
  manage_master_user_password         = true
  iam_database_authentication_enabled = true

  multi_az               = var.db_multi_az
  create_db_subnet_group = true
  subnet_ids             = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.db.id]

  auto_minor_version_upgrade = true
  backup_retention_period    = 7
  deletion_protection        = var.enable_deletion_protection
  skip_final_snapshot        = !var.enable_deletion_protection

  tags = local.tags
}

# https://registry.terraform.io/modules/terraform-aws-modules/elasticache/aws
module "valkey" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "~> 1.11"

  replication_group_id = "${local.name}-valkey"
  description          = "Valkey cache for ${local.name} (hydrator writes, api reads)"

  engine         = "valkey"
  engine_version = var.valkey_engine_version
  node_type      = var.valkey_node_type

  # Single shard; >1 node turns on automatic failover across AZs.
  num_cache_clusters         = var.valkey_num_cache_clusters
  automatic_failover_enabled = var.valkey_num_cache_clusters > 1
  multi_az_enabled           = var.valkey_num_cache_clusters > 1

  # TLS in transit — the services connect with rediss:// (see local.valkey_url).
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true

  create_parameter_group = true
  parameter_group_family = local.valkey_parameter_group_family

  subnet_group_name = "${local.name}-valkey"
  subnet_ids        = var.private_subnet_ids

  create_security_group = false
  security_group_ids    = [aws_security_group.valkey.id]

  tags = local.tags
}

# ==============================================================================
# Hydrator schedule (EventBridge Scheduler → ecs:RunTask)
# ==============================================================================

# Role EventBridge Scheduler assumes to launch the task.
resource "aws_iam_role" "hydrator_scheduler" {
  name = "${local.hydrator_name}-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "hydrator_scheduler" {
  name = "run-hydrator-task"
  role = aws_iam_role.hydrator_scheduler.id

  # RunTask is pinned to the current task-definition revision; Terraform updates
  # the policy and the schedule together on each deploy.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = module.ecs.services["hydrator"].task_definition_arn
        Condition = {
          ArnEquals = { "ecs:cluster" = module.ecs.cluster_arn }
        }
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          module.ecs.services["hydrator"].task_exec_iam_role_arn,
          module.ecs.services["hydrator"].tasks_iam_role_arn,
        ]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_scheduler_schedule" "hydrator" {
  name        = local.hydrator_name
  description = "Launches one hydrator task; it exits when hydration completes."
  state       = var.hydrator_schedule_enabled ? "ENABLED" : "DISABLED"

  schedule_expression = var.hydrator_schedule_expression

  # Fire at the exact scheduled time (no jitter window) — keeps runs predictable
  # and lines up with the failure alarm's evaluation period.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.ecs.cluster_arn
    role_arn = aws_iam_role.hydrator_scheduler.arn

    ecs_parameters {
      task_definition_arn = module.ecs.services["hydrator"].task_definition_arn
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [module.ecs.services["hydrator"].security_group_id]
        assign_public_ip = false
      }
    }

    # Retries cover launch failures (the RunTask call) only. If the app itself
    # fails it exits 1 and waits for the next scheduled run — writes are
    # idempotent, so the schedule is the retry.
    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
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

# A hydration run reported failure (the app's per-run EMF metric). Missing data
# is not breaching — the metric only exists when a run happens; a schedule that
# never fires won't alarm here (watch the schedule/logs for that).
resource "aws_cloudwatch_metric_alarm" "hydrator_failures" {
  alarm_name          = "${local.hydrator_name}-run-failed"
  alarm_description   = "The most recent hydration run failed (exit 1 / HydrationFailureCount > 0)."
  namespace           = "HydratorService"
  metric_name         = "HydrationFailureCount"
  statistic           = "Sum"
  period              = 86400 # one evaluation bucket per day — matches the daily schedule
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    service = local.hydrator_name
    env     = lower(var.environment)
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