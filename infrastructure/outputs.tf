output "alb_dns_name" {
  description = "Public DNS name of the load balancer."
  value       = module.alb.dns_name
}

output "app_url" {
  description = "Base URL to reach the service."
  value       = "${var.certificate_arn == "" ? "http" : "https"}://${module.alb.dns_name}"
}

output "ecr_repository_url" {
  description = "ECR repository to push the image to."
  value       = module.ecr.repository_url
}

output "hydrator_ecr_repository_url" {
  description = "ECR repository to push the hydrator image to."
  value       = module.hydrator_ecr.repository_url
}

output "hydrator_task_definition_arn" {
  description = "Hydrator task definition (handy for a manual `aws ecs run-task`)."
  value       = module.ecs.services["hydrator"].task_definition_arn
}

output "hydrator_schedule_name" {
  description = "EventBridge Scheduler schedule that launches hydration runs."
  value       = aws_scheduler_schedule.hydrator.name
}

output "database_endpoint" {
  description = "RDS Postgres endpoint (host:port)."
  value       = module.db.db_instance_endpoint
}

output "database_master_secret_arn" {
  description = "RDS-managed master credentials secret (used only to run db-bootstrap.sql once)."
  value       = module.db.db_instance_master_user_secret_arn
}

output "valkey_url" {
  description = "Valkey endpoint URL (VALKEY_URL, TLS) passed to both services."
  value       = local.valkey_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs.cluster_name
}

output "region" {
  description = "AWS region the stack is deployed in."
  value       = var.region
}