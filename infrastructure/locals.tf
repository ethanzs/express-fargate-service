locals {
  name           = "${var.project_name}-${var.environment}"
  container_name = var.project_name

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
}
