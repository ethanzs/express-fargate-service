locals {
  name           = "${var.project_name}-${var.environment}"
  container_name = var.project_name

  hydrator_name           = "${local.name}-hydrator"
  hydrator_container_name = "${var.project_name}-hydrator"

  tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
    },
    var.tags,
  )

  # CloudWatch alarm actions are wired only when an SNS topic is supplied.
  alarm_actions = var.alarm_sns_topic_arn == "" ? [] : [var.alarm_sns_topic_arn]

  # Data stores. The parameter-group family follows the engine major.
  # Postgres auth is IAM: each service connects as its own passwordless DB
  # user with a short-lived token minted via its task role — no standing
  # credential reaches a task. The master user (password managed/rotated by
  # RDS in Secrets Manager) is used only to run db-bootstrap.sql once.
  db_name                   = "app"
  db_username               = "app" # master
  db_parameter_group_family = "postgres${split(".", var.db_engine_version)[0]}"

  # Per-service Postgres users created by db-bootstrap.sql (hydrator owns DDL,
  # api gets DML via default privileges). Names must match that script.
  db_service_users = {
    api      = "api"
    hydrator = "hydrator"
  }

  # rds-db:connect resources are scoped per DB user.
  rds_connect_arn_prefix = "arn:aws:rds-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:dbuser:${module.db.db_instance_resource_id}"

  valkey_parameter_group_family = "valkey${split(".", var.valkey_engine_version)[0]}"

  valkey_url = "rediss://${module.valkey.replication_group_primary_endpoint_address}:6379"

  # Task SGs allowed to reach the data stores.
  datastore_clients = {
    api      = module.ecs.services["app"].security_group_id
    hydrator = module.ecs.services["hydrator"].security_group_id
  }
}
