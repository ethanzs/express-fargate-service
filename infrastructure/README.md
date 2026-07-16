# Infrastructure (Terraform)

Provisions the AWS stack for both services on **ECR / ECS Fargate**, using the
well-maintained `terraform-aws-modules` (ALB, ECS, ECR, RDS, ElastiCache —
pinned to the latest majors): the always-on **api** service behind an ALB, the
**hydrator** as a scheduled one-shot task, and the data stores they share.
The network is **not** created here — an existing VPC and subnets are
referenced by id.


## What it creates

- **ECR** (`terraform-aws-modules/ecr`) — one image repo per service (api +
  hydrator) with **immutable** tags, scan-on-push, and a lifecycle policy
  keeping the last 10 images.
- **ALB** (`terraform-aws-modules/alb`) — public load balancer in the supplied
  public subnets; HTTP, or HTTP→HTTPS redirect + HTTPS when `certificate_arn` is
  set. Health check on `/healthz`, idle timeout 60s (below the app's 65s
  keep-alive).
- **ECS** (`terraform-aws-modules/ecs`) — Fargate cluster + the api service in
  the supplied private subnets, with Container Insights, a CloudWatch log group,
  a locked-down task (ALB-only ingress, read-only rootfs), and target-tracking
  autoscaling (see [Autoscaling](#autoscaling)). The api task gets
  `DATABASE_URL` injected from Secrets Manager and `VALKEY_URL` as environment
  (it reads the stores the hydrator fills).
- **Hydrator (scheduled task)** — a task-definition-only ECS entry
  (`create_service = false`: task definition, IAM roles, egress-only security
  group, log group — **no running service**) plus an **EventBridge Scheduler**
  schedule that launches one Fargate task per run (see
  [Hydrator schedule](#hydrator-schedule)).
- **RDS Postgres** (`terraform-aws-modules/rds`) — the system of record.
  Postgres 18 (major follows `db_engine_version`; keep in step with
  `code/compose.yaml`), encrypted storage with autoscaling, 7-day backups,
  **multi-AZ by default** (`db_multi_az = false` shrinks a dev stack).
  **Authentication is IAM**: each service connects as its
  own passwordless DB user (`api` = DML only, `hydrator` = owns DDL) with a
  short-lived token minted via its task role (`rds-db:connect`, scoped per
  user) — no database credential exists in any task. The master password is
  generated/rotated by RDS itself in Secrets Manager and used only to run the
  one-time [bootstrap script](#database-bootstrap-one-time).
- **ElastiCache Valkey** (`terraform-aws-modules/elasticache`) — the cache.
  Valkey 9.1, TLS in transit (the services connect via `rediss://`) +
  at-rest encryption; **two nodes with multi-AZ automatic failover by
  default** (`valkey_num_cache_clusters = 1` shrinks a dev stack).
- **Datastore security groups** — Postgres (5432) and Valkey (6379) admit
  **only** the api and hydrator task security groups; nothing else in the VPC.
- **CloudWatch alarms** — target 5xx count, p95 latency, and hydration-run
  failures (notify via an optional SNS topic).

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
| `main.tf` | All resource/module blocks (ECR, ALB, ECS, RDS, ElastiCache, schedule, alarms) |
| `outputs.tf` | ALB URL, ECR repos, datastore endpoints, secret ARN, cluster name, region |
| `db-bootstrap.sql` | One-time IAM DB-user bootstrap, run manually via psql |
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
(build context is the workspace root `../code`, so the `shared` package is in
context), then roll the service:

> **CI usually does this.** Merges to `main` release via semantic-release,
> which pushes both images tagged `vX.Y.Z` (see the root README's "Releases &
> versioning") — then deploying is just setting `image_tag`/
> `hydrator_image_tag` to that version and applying. The manual flow below is
> for bootstrapping or ad-hoc builds.

```bash
ECR_URL=$(terraform output -raw ecr_repository_url)
TAG=v1.4.0   # a release tag (or git-$(git -C ../code rev-parse --short HEAD) for ad-hoc)
AWS_REGION=$(terraform output -raw region)

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ECR_URL%/*}"

docker build --platform linux/amd64 -f ../code/api/Dockerfile -t "$ECR_URL:$TAG" ../code
docker push "$ECR_URL:$TAG"

aws ecs update-service --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service express-fargate-dev --force-new-deployment --region "$AWS_REGION"
```

Same for the hydrator image (tag = `hydrator_image_tag`; no service to roll —
the next scheduled run picks up whatever revision Terraform pinned):

```bash
HYDRATOR_ECR_URL=$(terraform output -raw hydrator_ecr_repository_url)
docker build --platform linux/amd64 -f ../code/hydrator/Dockerfile -t "$HYDRATOR_ECR_URL:$TAG" ../code
docker push "$HYDRATOR_ECR_URL:$TAG"
```

Reach the app at `terraform output -raw app_url`.

## Hydrator schedule

The hydrator has **no always-on service** — that's deliberate cost design. An
EventBridge Scheduler schedule (`hydrator_schedule_expression`, default daily
at 06:00 UTC) calls `ecs:RunTask` with `task_count = 1`; the task hydrates
Postgres and Valkey, then exits, so Fargate bills only for the minutes a run is
actually executing.

- **Configure the cadence** with `hydrator_schedule_expression` (`cron()` or
  `rate()`), and pause it entirely with `hydrator_schedule_enabled = false` —
  nothing is destroyed, runs just stop.
- **Failure model:** the scheduler retries only *launch* failures (RunTask
  errors, up to 2 attempts within an hour). If the app itself fails it exits 1
  and waits for the next scheduled run — its writes are idempotent, so the
  schedule is the retry. The `HydratorService/HydrationFailureCount` alarm
  (emitted via EMF by the app) flags a failed run.
- **No database credential** — the task connects as the `hydrator` IAM DB
  user with a per-connection auth token; only `DB_HOST`/`DB_PORT`/`DB_NAME`/
  `DB_USER` ride in the environment.

- **Run it off-schedule** (e.g. after changing seed data) with
  `aws ecs run-task --task-definition "$(terraform output -raw hydrator_task_definition_arn)"`
  (same cluster/network settings as the schedule), or from the ECS console.
- **Reachability:** the task runs in the private subnets with an egress-only
  security group; the RDS and ElastiCache security groups (managed here)
  admit it and the api service's SG — nothing else.

## Database bootstrap (one-time)

IAM auth needs the per-service Postgres users to exist — that's a SQL-level
step no AWS API covers. [`db-bootstrap.sql`](db-bootstrap.sql) is idempotent
(safe to re-run); run it **manually from your own CLI as the master user**
after the first `apply`, and again only if the user model ever changes:

```bash
# Master credentials live in the RDS-managed secret (never in any task).
PGPASSWORD=$(aws secretsmanager get-secret-value \
  --secret-id "$(terraform output -raw database_master_secret_arn)" \
  --query SecretString --output text | jq -r .password)

psql "postgresql://app@$(terraform output -raw database_endpoint)/app?sslmode=require" \
  -f db-bootstrap.sql
```

> **Network path required:** RDS lives in the private subnets and its SG only
> admits the task SGs — your CLI needs a route (VPN, bastion, or an SSM
> port-forward) **and** a temporary SG ingress rule for wherever you're
> connecting from. Remove the rule when done.

The script creates: `hydrator` (owns DDL — runs the drizzle migrations) and
`api` (DML only, incl. on tables the hydrator creates later, via default
privileges). Both are passwordless — `rds_iam` makes token auth the only way
in.

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
  `azure_tenant_id`, `azure_client_id`, `azure_ad_audience`, `image_tag`,
  `hydrator_image_tag`. Datastore sizing/versions have dev-friendly defaults
  (`db_*`, `valkey_*` variables).
- **Immutable images:** the ECR repo is `IMMUTABLE` and there is no `latest` — a
  tag can't be overwritten, so deploy a unique tag (e.g. the git SHA) every time.
- **Cost:** the ALB bills hourly. NAT for the private subnets is part of the
  pre-existing network you supply (not managed here).
