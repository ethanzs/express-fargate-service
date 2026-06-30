# Production-readiness roadmap

Tracking the maturity/best-practice improvements for this service. Checked items
are implemented; update this file as work lands (see the docs-in-sync rule in
`CLAUDE.md`).

## Tier 1 — high impact, low effort

- [x] **ALB keep-alive timeouts** — `keepAliveTimeout`/`headersTimeout` set above
  the ALB idle timeout to avoid intermittent 502s (`src/server.ts`, config).
- [x] **CORS** — allowlisted origins for the MSAL SPA; preflight short-circuits
  before auth (`src/app.ts`, `CORS_ORIGINS`).
- [x] **Input validation (zod)** — `validate({ body, params, query })` middleware;
  `items` route migrated off hand-rolled checks; `ZodError` → 400 with details.
- [ ] **Auth happy-path test** — sign a token against an in-memory JWKS to cover
  the success path (today only 401 paths are tested).
- [x] **Request body size limit** — `express.json({ limit: JSON_BODY_LIMIT })`
  (default 100kb → 413); central handler now maps body-parser 400/413 too.

## Tier 2 — operational maturity (the deploy story)

- [ ] **CI pipeline (GitHub Actions)** — lint → typecheck → test → build →
  image scan → push to ECR.
- [x] **Infrastructure as Code (Terraform)** — `infrastructure/` provisions ECR,
  ALB, ECS Fargate service, autoscaling, log groups, IAM, and CloudWatch alarms
  via `terraform-aws-modules`, deploying into an existing VPC/subnets (by id).
  (Alarms use ALB metrics; wiring custom EMF-metric alarms is a future tweak.)
- [ ] **`/readyz` readiness probe** — separate from `/healthz` liveness; checks
  dependencies once a DB is added.
- [ ] **Image scanning + dependency automation** — Trivy/Grype in CI; Renovate
  or Dependabot.

## Tier 3 — API contract & polish

- [ ] **RFC 9457 Problem Details** error shape (`application/problem+json`).
- [x] **API reference (markdown)** — `docs/api.md`, generated from the routes +
  zod schemas by the `/api-docs` skill. Backstage TechDocs-ready.
- [ ] **OpenAPI spec** — generated from zod schemas; feeds Backstage's API
  catalog entity (the markdown reference above is the human/TechDocs view).
- [ ] **API versioning** (`/api/v1`).
- [ ] **Pre-commit hooks** (husky + lint-staged) and **coverage thresholds**.

## Tier 4 — when needed (avoid over-engineering)

- [ ] **Database + migrations** — replace the in-memory store when persistence
  is required.
- [ ] **OpenTelemetry tracing** — valuable once there are multiple services.
- [ ] **Rate limiting** — prefer ALB/WAF first; app-level for sensitive routes.
- [ ] **Distroless / arm64 (Graviton)** base image — smaller surface, cheaper
  compute; optimize after it's deployed.
- [ ] **Calibrate autoscaling targets** — load-test a single task to find
  sustainable RPS at the p99 SLO, then set `autoscaling_request_count_target` to
  ~70-80% of it and right-size `cpu`/`memory`. (Policies are in place:
  request-count primary + CPU/memory guardrails.)
