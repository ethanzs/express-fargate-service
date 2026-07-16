# Production-readiness roadmap

Tracking the maturity/best-practice improvements for this service. Checked items
are implemented; update this file as work lands (see the docs-in-sync rule in
`CLAUDE.md`).

## Tier 1 — high impact, low effort

- [x] **ALB keep-alive timeouts** — `keepAliveTimeout`/`headersTimeout` set above
  the ALB idle timeout to avoid intermittent 502s (`code/api/src/server.ts`, config).
- [x] **CORS** — allowlisted origins for the MSAL SPA; preflight short-circuits
  before auth (`code/api/src/app.ts`, `CORS_ORIGINS`).
- [x] **Input validation (zod)** — `validate({ body, params, query })` middleware;
  `items` route migrated off hand-rolled checks; `ZodError` → 400 with details.
- [ ] **Auth happy-path test** — sign a token against an in-memory JWKS to cover
  the success path (today only 401 paths are tested).
- [x] **Request body size limit** — `express.json({ limit: JSON_BODY_LIMIT })`
  (default 100kb → 413); central handler now maps body-parser 400/413 too.

## Tier 2 — operational maturity (the deploy story)

- [x] **CI pipeline (GitHub Actions)** — `.github/workflows/ci.yml`: gate
  (typecheck → lint → format → test) on PRs and `main`, commitlint on PRs,
  and semantic-release on `main` (lockstep `vX.Y.Z` tag + GitHub release +
  both images pushed to ECR, where scan-on-push covers image scanning).
  Needs the four repo variables in the workflow header to enable ECR pushes.
- [x] **Infrastructure as Code (Terraform)** — `infrastructure/` provisions ECR,
  ALB, ECS Fargate service, autoscaling, log groups, IAM, and CloudWatch alarms
  via `terraform-aws-modules`, deploying into an existing VPC/subnets (by id).
  (Alarms use ALB metrics; wiring custom EMF-metric alarms is a future tweak.)
- [ ] **`/readyz` readiness probe** — separate from `/healthz` liveness; checks
  dependencies once a DB is added.
- [x] **Hydrator deployment (Terraform)** — ECR repo, task-definition-only ECS
  entry (`create_service = false` — no always-on service), EventBridge
  Scheduler launching one Fargate task per run (daily by default,
  configurable/pausable), `DATABASE_URL` injected from Secrets Manager, and a
  CloudWatch alarm on `HydratorService/HydrationFailureCount`.
- [x] **RDS Postgres + ElastiCache Valkey (Terraform)** — provisioned via
  `terraform-aws-modules/rds` (Postgres 18, encrypted, storage autoscaling,
  multi-AZ by default, IAM auth) and
  `terraform-aws-modules/elasticache` (Valkey 9.1, TLS in transit + at rest,
  multi-AZ automatic failover by default). The stack also builds the `DATABASE_URL`
  Secrets Manager secret and scopes both datastore SGs to the api + hydrator
  task SGs only.
- [x] **IAM database authentication** — no standing DB credential anywhere:
  each service connects as its own passwordless Postgres user (`api`
  DML-only, `hydrator` owns DDL) with 15-minute tokens minted via its task
  role; the RDS-managed master password is used only to run the one-time
  `infrastructure/db-bootstrap.sql` manually via psql.
- [ ] **Image scanning + dependency automation** — Trivy/Grype in CI; Renovate
  or Dependabot.

## Tier 3 — API contract & polish

- [ ] **RFC 9457 Problem Details** error shape (`application/problem+json`).
- [x] **API reference (markdown)** — `docs/api.md`, generated from the routes +
  zod schemas by the `/api-docs` skill. Backstage TechDocs-ready.
- [ ] **OpenAPI spec** — generated from zod schemas; feeds Backstage's API
  catalog entity (the markdown reference above is the human/TechDocs view).
- [ ] **API versioning** (`/api/v1`).
- [ ] **Pre-commit lint-staged + coverage thresholds** — husky is in (the
  `commit-msg` hook runs commitlint); still missing a `pre-commit` hook
  running lint-staged, and Vitest coverage thresholds.

## Tier 4 — when needed (avoid over-engineering)

- [x] **API reads Postgres/Valkey** — the in-memory items store is gone: the
  api serves items from Postgres (drizzle, identity ids) with a read-only
  Valkey read-through (`code/api/src/repo/items.ts`); cache failures degrade
  to Postgres. Terraform injects `DATABASE_URL` (Secrets Manager) and
  `VALKEY_URL` into the api task.
- [ ] **OpenTelemetry tracing** — valuable once there are multiple services.
- [ ] **Rate limiting** — prefer ALB/WAF first; app-level for sensitive routes.
- [ ] **Distroless / arm64 (Graviton)** base image — smaller surface, cheaper
  compute; optimize after it's deployed.
- [ ] **Calibrate autoscaling targets** — load-test a single task to find
  sustainable RPS at the p99 SLO, then set `autoscaling_request_count_target` to
  ~70-80% of it and right-size `cpu`/`memory`. (Policies are in place:
  request-count primary + CPU/memory guardrails.)
