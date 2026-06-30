# Infrastructure (Terraform)

Provisions the AWS stack for the Express service on **ECR / ECS Fargate**, using
the well-maintained `terraform-aws-modules` for ALB, ECS, and ECR. The network
is **not** created here — an existing VPC and subnets are referenced by id.

## What it creates

- **ECR** (`terraform-aws-modules/ecr`) — image repo with **immutable** tags,
  scan-on-push, and a lifecycle policy keeping the last 10 images.
- **ALB** (`terraform-aws-modules/alb`) — public load balancer in the supplied
  public subnets; HTTP, or HTTP→HTTPS redirect + HTTPS when `certificate_arn` is
  set. Health check on `/healthz`, idle timeout 60s (below the app's 65s
  keep-alive).
- **ECS** (`terraform-aws-modules/ecs`) — Fargate cluster + service in the
  supplied private subnets, with Container Insights, a CloudWatch log group, a
  locked-down task (ALB-only ingress, read-only rootfs), and target-tracking
  autoscaling (see [Autoscaling](#autoscaling)).
- **CloudWatch alarms** — target 5xx count and p95 latency (notify via an
  optional SNS topic).

> **Network is an input.** Bring an existing VPC (`vpc_id`) plus public and
> private subnet ids. The private subnets must have NAT egress so tasks can pull
> from ECR and reach Microsoft's JWKS endpoint.

## Layout

| File | Purpose |
| ---- | ------- |
| `settings.tf` | `terraform` block, version constraints, backend, AWS provider |
| `variables.tf` | All inputs |
| `locals.tf` | Naming, tags, derived values |
| `data.tf` | Existing VPC + subnet lookups |
| `main.tf` | All resource/module blocks (ECR, ALB, ECS, alarms) |
| `outputs.tf` | ALB URL, ECR repo, cluster name, region |
| `terraform.tfvars.example` | Copy to `terraform.tfvars` and fill in |

## Usage

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars   # set vpc_id, subnets, azure_*, image_tag
terraform init
terraform plan
terraform apply
```

Build & push the image with the **exact immutable tag** you set in `image_tag`
(build context is `../code`), then roll the service:

```bash
ECR_URL=$(terraform output -raw ecr_repository_url)
TAG=git-$(git -C ../code rev-parse --short HEAD)   # whatever you set image_tag to
AWS_REGION=$(terraform output -raw region)

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

docker build --platform linux/amd64 -t "$ECR_URL:$TAG" ../code
docker push "$ECR_URL:$TAG"

aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service express-fargate-dev --force-new-deployment --region "$AWS_REGION"
```

Reach the app at `terraform output -raw app_url`.

## Autoscaling

The service scales tasks horizontally with **AWS Application Auto Scaling** using
**three target-tracking policies**. Target tracking works like a thermostat: for
each policy AWS keeps a metric near a target value, auto-creating the CloudWatch
alarms and adjusting the service's desired task count to hold it there.

| Policy | Metric | Default target | Role |
| ------ | ------ | -------------- | ---- |
| `requests` | `ALBRequestCountPerTarget` | 1000 req/task/min | **Primary** — the actual load driver for a stateless API |
| `cpu` | `ECSServiceAverageCPUUtilization` | 70% | Guardrail — catches CPU-bound spikes (e.g. JWT crypto) |
| `memory` | `ECSServiceAverageMemoryUtilization` | 70% | Guardrail — catches heap growth / leaks |

### How the three policies combine

App Auto Scaling evaluates every policy independently and takes the **largest**
desired count any of them asks for:

- **Scale out** happens as soon as **any** policy is above its target (e.g. a
  traffic spike trips `requests` before CPU even moves).
- **Scale in** happens only when **all** policies agree there's spare capacity —
  the guardrails can add tasks but never force a premature scale-in.

Task count is bounded **`autoscaling_min_capacity` (2) … `autoscaling_max_capacity` (6)**.
`desired_count` (2) only seeds the initial count; the module sets
`ignore_changes = [desired_count]`, so the autoscaler owns it afterward and
Terraform won't reset it.

### Reaction speed

Cooldowns are intentionally asymmetric — **fast out, slow in** — so bursts are
absorbed quickly while capacity is released conservatively:

- `autoscaling_scale_out_cooldown` — **60s** (default)
- `autoscaling_scale_in_cooldown` — **300s** (default)

### Tuning

All targets and cooldowns are variables (see `variables.tf` /
`terraform.tfvars.example`):
`autoscaling_request_count_target`, `autoscaling_cpu_target`,
`autoscaling_memory_target`, `autoscaling_scale_out_cooldown`,
`autoscaling_scale_in_cooldown`, plus the `autoscaling_min_capacity` /
`autoscaling_max_capacity` bounds.

**Calibrate the primary target before relying on it:** load-test a single task to
find the requests/min it sustains at your p99 latency SLO, then set
`autoscaling_request_count_target` to ~70–80% of that (headroom for the ~60s
scale-out delay). The metric counts requests per task per minute, so it assumes
endpoints are roughly uniform in cost — revisit if you add a heavy endpoint.

> Why request-count as primary? For a light, I/O-bound API, CPU can stay low
> while latency degrades (event-loop or connection saturation), so CPU-only
> scaling under-reacts. Requests/task tracks real load and scales proportionally;
> CPU and memory remain as guardrails.

## Remote state

`settings.tf` ships with the S3 backend commented, so `init` works immediately
with local state. For shared/team use, create a versioned + encrypted S3 bucket,
uncomment the block, and run `terraform init -migrate-state`. Terraform ≥ 1.10
locks state natively in S3 (`use_lockfile`), so no DynamoDB table is needed.

## Notes

- **Required inputs:** `vpc_id`, `public_subnet_ids`, `private_subnet_ids`,
  `azure_tenant_id`, `azure_client_id`, `azure_ad_audience`, `image_tag`.
- **Immutable images:** the ECR repo is `IMMUTABLE` and there is no `latest` — a
  tag can't be overwritten, so deploy a unique tag (e.g. the git SHA) every time.
- **Cost:** the ALB bills hourly. NAT for the private subnets is part of the
  pre-existing network you supply (not managed here).
