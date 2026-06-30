# express-fargate-service

A small, production-minded Express.js (v5) JSON API in TypeScript, built to be
containerized and deployed to **ECR / ECS Fargate**. KISS by design — minimal
dependencies, one clear pattern per concern.

## Repository layout

```
.                     # shared docs live at the root (README, CLAUDE, ROADMAP)
├── code/             # the Express app (run npm commands from here)
└── infrastructure/   # Terraform for the AWS deployment (see its own README)
```

Run app commands from `code/` (e.g. `cd code && npm run dev`); run Terraform from
`infrastructure/`.

## What's inside

- **Express 5** — native async error forwarding (route handlers can just `throw`).
- **zod input validation** — schema-validated body/params/query; failures return a 400 with field detail. Request bodies are size-capped.
- **Entra ID (Azure AD) JWT auth** — `/api/*` requires a valid MSAL access token, verified against Microsoft's JWKS with `jose`.
- **helmet + CORS** — sensible security headers; allowlisted cross-origin access for the SPA.
- **ALB-safe timeouts** — keep-alive tuned above the load balancer's idle timeout to avoid 502s.
- **pino / pino-http** — structured JSON logs that drop straight into CloudWatch.
- **Graceful shutdown** — handles `SIGTERM` from ECS so deploys drain cleanly.
- **Multi-stage Docker build** — small runtime image, runs as non-root `node`.
- **ESLint + Prettier + Vitest** — lint, format, and an example test suite.

## Project layout

```
code/
  src/
  app.ts                 # buildApp() — no listen(), so it's testable
  server.ts              # entrypoint: listen + graceful shutdown
  config.ts              # env-driven config (12-factor)
  logger.ts              # pino logger
  middleware/
    auth.ts              # requireAuth — Entra ID JWT validation
    validate.ts          # validate({ body, params, query }) — zod
    errorHandler.ts      # HttpError, ZodError→400, 404, central handler
  routes/
    health.ts            # GET /healthz (public)
    me.ts                # GET /api/me (returns the caller's claims)
    items.ts             # example REST resource (in-memory)
test/
  app.test.ts            # supertest integration tests
```

## Authentication (Microsoft Entra ID / MSAL)

The frontend signs users in with MSAL and calls this API with the resulting
**access token** in `Authorization: Bearer <token>`. Every `/api/*` route runs
`requireAuth`, which verifies the token's signature (via the tenant JWKS),
issuer, audience, and expiry before the handler runs. `/healthz` stays public.

### One-time Entra ID setup

1. **Register the API** — create an App Registration for this service. Note the
   **Directory (tenant) ID** and **Application (client) ID**.
2. **Expose an API** — under _Expose an API_, set the Application ID URI
   (e.g. `api://<client-id>`) and add a scope (e.g. `access_as_user`).
3. **Frontend app** — its MSAL config requests that scope; the access token it
   receives is what this API validates.

### Configure the service

Set these (locally in `.env`, on Fargate in the task definition / Secrets):

| Variable             | Required | Notes                                                  |
| -------------------- | -------- | ------------------------------------------------------ |
| `AZURE_TENANT_ID`    | yes      | Directory (tenant) ID                                  |
| `AZURE_CLIENT_ID`    | yes      | This API's Application (client) ID                     |
| `AZURE_AD_AUDIENCE`  | yes      | Expected `aud` — client id or `api://<client-id>`      |
| `AZURE_AD_INSTANCE`  | no       | Override for sovereign clouds                          |
| `AZURE_AD_ISSUER`    | no       | Override (see token-version note below)                |
| `AZURE_AD_JWKS_URI`  | no       | Override; defaults to the tenant v2.0 keys endpoint    |

The server **fails fast on boot in production** if the three required values are
missing; in dev it logs a warning and protected routes return 401.

> **Token version gotcha:** the defaults assume **v2.0** access tokens. If your
> app registration still issues v1.0 tokens (`accessTokenAcceptedVersion` is not
> `2` in the manifest), the issuer is `https://sts.windows.net/<tenant-id>/` —
> set `AZURE_AD_ISSUER` accordingly, or flip the manifest to v2.0.

### Calling a protected route

```bash
curl localhost:3000/api/me -H "Authorization: Bearer <access-token>"
```

`req.auth` holds the verified claims (`oid`, `name`, `roles`, …). The `roles`
claim is already captured for the planned admin/role-based access — enforcement
will layer on top of `requireAuth` later.

## Validation & errors

Request input is validated with [zod](https://zod.dev) via the
`validate({ body, params, query })` middleware (`src/middleware/validate.ts`).
Schemas live next to their route and are the single source of truth for shape and
validation; the sanitized body (trimmed/coerced) is written back to `req.body`.

A failed validation returns **400** with field-level detail:

```http
POST /api/items   { }
→ 400
{ "error": "Validation failed", "details": [{ "path": "name", "message": "..." }] }
```

The central error handler (`src/middleware/errorHandler.ts`) also reads
`status`/`statusCode` off library errors, so a malformed JSON body returns 400 and
an oversized body (over `JSON_BODY_LIMIT`, default `100kb`) returns 413 — not a 500.

> Express 5 note: `req.query` is a **read-only getter**, so the middleware
> validates query params in place rather than reassigning them.

## Local development

```bash
cd code
npm install
cp .env.example .env
npm run dev          # hot-reload via tsx
```

Then:

```bash
curl localhost:3000/healthz
curl localhost:3000/api/items
curl -X POST localhost:3000/api/items -H 'content-type: application/json' -d '{"name":"hello"}'
```

Full endpoint reference: [`docs/api.md`](docs/api.md) (generated from the routes
and zod schemas by the `/api-docs` skill).

## Scripts

| Command              | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `npm run dev`        | Hot-reloading dev server                 |
| `npm run build`      | Compile TypeScript to `dist/`            |
| `npm start`          | Run the compiled server                  |
| `npm test`           | Run the test suite (Vitest + supertest)  |
| `npm run lint`       | ESLint                                   |
| `npm run format`     | Prettier write                           |
| `npm run typecheck`  | Type-check without emitting              |

## Logging & redaction

Logs are structured JSON via [pino](https://getpino.io) (`src/logger.ts`) and
HTTP request logging via `pino-http`, tuned for AWS CloudWatch:

- **Stable dimensions** — every line carries `service` and `env`, so you can
  filter/group cleanly in Logs Insights and dashboard widgets. `service`
  defaults to `express-fargate-service` and is overridable via `SERVICE_NAME`.
- **Readable levels** — emitted as labels (`"level":"info"`) rather than pino's
  numeric codes, so queries read `level="error"` not `level=50`.
- **ISO timestamps** — `"time":"2026-06-30T..."` instead of epoch millis.
- **Health-check noise dropped** — `GET /healthz` is excluded from request
  logging (the ALB polls it constantly; logging it would dominate volume/cost
  and skew request-count metrics).
- **Pretty in dev only** — production emits raw JSON straight to stdout (which
  the ECS `awslogs` driver ships to CloudWatch); local dev pipes through
  `pino-pretty` for readability.

### CloudWatch metrics (EMF)

Beyond queryable logs, the app emits true CloudWatch **Metrics** via the
[Embedded Metric Format](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html)
(`src/middleware/metrics.ts`). One EMF line is written per completed request
(health checks excluded); CloudWatch auto-extracts the metrics from the log
stream — **no `PutMetricData`, no extra IAM**, it rides the existing awslogs
pipeline.

Namespace `ExpressFargateService`, dimensioned by `service` / `env` and
additionally `route` / `statusClass`:

| Metric | Unit | Use |
| ------ | ---- | --- |
| `RequestCount` | Count | throughput, request rate |
| `RequestLatency` | Milliseconds | p50/p90/p99 latency (CloudWatch computes percentiles) |
| `HttpServerErrorCount` | Count | 5xx rate, error alarms |

> **Cardinality matters.** Dimensions use the matched **route template**
> (`GET /api/items/:id`) and a coarse **status class** (`2xx`/`4xx`/`5xx`) — never
> the raw URL, an id, or a user — so the number of metric streams stays bounded.
> When adding business metrics later (e.g. admin actions for RBAC), keep
> dimensions low-cardinality the same way.

### Redaction of sensitive data

A pino `redact` config scrubs secrets from every log line (in both dev and
prod) before it's written, replacing them with `[REDACTED]`. The primary risk
is that `pino-http` logs request headers — which include the bearer token. The
redacted paths (see `redactPaths` in `src/logger.ts`):

| Path | Why |
| ---- | --- |
| `req.headers.authorization` | the Entra ID bearer (access) token |
| `req.headers.cookie` / `res.headers["set-cookie"]` | session cookies |
| `req.headers["x-api-key"]` | API keys |
| `password`, `token`, `accessToken`, `refreshToken`, `clientSecret`, `authorization` (top level and one level deep) | common secret-bearing fields |

To scrub a new sensitive field, add its path to `redactPaths` in
`src/logger.ts`. Note: pino's redaction matches the top level and **one** level
deep (e.g. `body.password`), not arbitrarily nested paths — this app doesn't log
request bodies by default, so header redaction is the part that matters in
practice.

### Request identity & auditing

For debugging and auditing without leaking PII:

- After auth, `requireAuth` attaches the **pseudonymous** actor to the request
  logger (`userId` = Entra `oid`, `tenantId` = `tid`), so every log line for an
  authenticated request says who it belongs to. Name/email are deliberately
  **not** logged — the immutable `oid` is the stable key, and keeping PII out of
  logs avoids retention/erasure (GDPR) headaches.
- Each request gets a **correlation id** (`reqId`) from the ALB's
  `X-Amzn-Trace-Id` header (or `X-Request-Id`), so a request can be followed
  across services. A Logs Insights query like `filter userId = "<oid>"` returns
  a user's full footprint, stitched by `reqId`.
- **Audit events** (security-relevant actions) go through `recordAudit()` in
  `src/audit.ts` — a separate stream tagged `log_type:"audit"`, pinned to `info`
  so it's never suppressed by `LOG_LEVEL`. Route those to their own log
  group/retention via a CloudWatch subscription filter. This is the seam for the
  planned admin/RBAC features.

## Docker

The build context is `code/` (run from the repo root):

```bash
docker build -t express-fargate-service code/
docker run --rm -p 3000:3000 \
  -e AZURE_TENANT_ID=... -e AZURE_CLIENT_ID=... -e AZURE_AD_AUDIENCE=... \
  express-fargate-service
```

## Deploying to ECR / ECS Fargate

The AWS stack (ECR, ALB, ECS Fargate service, autoscaling, alarms) is
provisioned with **Terraform in [`infrastructure/`](infrastructure/)** using the
`terraform-aws-modules`. It deploys into an **existing VPC/subnets** (referenced
by id). See [`infrastructure/README.md`](infrastructure/README.md) for the full
flow; in short:

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars   # set vpc_id, subnets, azure_*, image_tag
terraform init && terraform apply

# build & push the image with the immutable tag you set (context is ../code)
ECR_URL=$(terraform output -raw ecr_repository_url)
docker build --platform linux/amd64 -t "$ECR_URL:$TAG" ../code
docker push "$ECR_URL:$TAG"
```

The Terraform sets the container `environment` (`NODE_ENV`, `PORT`, `LOG_LEVEL`,
`CORS_ORIGINS`, `AZURE_*`), wires the ALB health check to `/healthz`, and keeps
the ALB idle timeout (60s) below the app's keep-alive (65s) to avoid 502s. ECS
sends `SIGTERM` on deploy/scale-in and the app drains in-flight requests (up to
`SHUTDOWN_TIMEOUT_MS`) before exiting.

> For real secrets (not the Azure identifiers, which are public), use Secrets
> Manager / SSM via the task definition's `secrets` field — never bake them in.

## Adding a database later

Replace the in-memory store in `code/src/routes/items.ts` with a repository
module and add the client (e.g. `pg`/Prisma) to `dependencies`. Keep the
`/healthz` endpoint dependency-free so a slow DB doesn't cause health-check
restart loops; add a separate `/readyz` if you need readiness gating.
