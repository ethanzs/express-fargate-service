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

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs.cluster_name
}

output "region" {
  description = "AWS region the stack is deployed in."
  value       = var.region
}