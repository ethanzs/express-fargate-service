# CLAUDE.md

Guidance for working in this repository.

## What this is

Two small, KISS TypeScript services, containerized and deployed to **ECR / ECS
Fargate** in one cluster:

- **`api`** — an Express 5 JSON API behind an ALB. Validates Microsoft Entra ID
  (Azure AD) access tokens on `/api/*`, serves items from Postgres with a
  Valkey read-through, logs structured JSON, emits CloudWatch metrics.
- **`hydrator`** — a run-to-completion job launched on a schedule by EventBridge
  Scheduler. Hydrates RDS Postgres and ElastiCache Valkey, emits one EMF line
  per run, exits 0/1.

Keep changes minimal and in the existing style — favor clarity over cleverness.

## Repository layout

- **Root** — cross-cutting docs only (`README.md` — overview + local dev,
  `CLAUDE.md`, `ROADMAP.md`, `.gitignore`). **Low-level, project-specific docs
  live in each package's own README** (`code/*/README.md`) — keep detail
  there, keep the root README generic.
- **`code/`** — an npm **workspace** (run all `npm` commands from here):
  - `code/api/` — the Express app (see `code/api/README.md`).
  - `code/hydrator/` — the scheduled hydration job (see
    `code/hydrator/README.md`).
  - `code/shared/` — `@app/shared`, the internal package both services consume
    (domain schemas/types, `toInt`, `createLogger`). Linked by the workspace,
    compiled into each service's image, **never published** to a registry
    (see `code/shared/README.md`).
- **`infrastructure/`** — Terraform for the AWS deployment (ECR/ALB/ECS via
  `terraform-aws-modules`; deploys into an existing VPC referenced by id). Run
  `terraform` from here; see its own README. File split: `settings.tf`
  (terraform/provider/backend), `main.tf` (all resource/module blocks), `data.tf`
  (all data blocks), `variables.tf`, `locals.tf`, `outputs.tf`. Provisions the
  api (ALB-fronted service), the hydrator (ECR repo, task definition via
  `create_service = false`, EventBridge Scheduler that runs one task per
  schedule), and the datastores: RDS Postgres + ElastiCache Valkey via
  `terraform-aws-modules`, with **IAM database auth** (passwordless
  per-service DB users — `api` DML-only, `hydrator` owns DDL — created by
  running `infrastructure/db-bootstrap.sql` manually via psql once; master
  password RDS-managed, used only for that) and SGs scoped to the task SGs.
  Keep module/provider pins on the latest majors.

When a file relates to both app and infra, it belongs at the root; otherwise it
lives in the relevant subdir.

## Commands

> Run app commands from the workspace root `code/` (`cd code`); run Terraform
> from `infrastructure/`.

| Command | Purpose |
| ------- | ------- |
| `docker compose up -d --wait` | Local-dev Postgres + Valkey (`compose.yaml`; dev only, never prod) |
| `npm run dev -w api` | Hot-reloading dev server (`tsx`, loads `api/.env`) |
| `npm run dev -w hydrator` | Run one hydration locally (loads `hydrator/.env`) |
| `npm run db:generate -w hydrator` | Generate a SQL migration after editing the drizzle schema in `shared` |
| `npm run db:migrate -w hydrator` | Apply pending migrations only (`src/migrate.ts`; no hydration) |
| `npm run build` | Build `shared`, then compile both services → `dist/` |
| `npm test` | Build `shared`, then Vitest in every package |
| `npm run lint` | ESLint in every package |
| `npm run typecheck` | Build `shared`, then `tsc --noEmit` in the services |
| `npm run format` | Prettier write in every package |

**`shared` must be built before the services can typecheck/test/run** — the
root scripts handle that; after editing `code/shared`, rebuild it with
`npm run build -w shared`.

Before finishing a change, run `npm run typecheck && npm run lint && npm test`
(from `code/`), and update the docs (`README.md`, `CLAUDE.md`, the service
`.env.example` files, and `infrastructure/README.md` for infra changes) to
match. For Terraform changes, run `terraform fmt` and `terraform validate` in
`infrastructure/`.

## Architecture

### api (`code/api`)

- `src/app.ts` — `createApp()` builds the Express app with **no** `listen()`, so
  it's importable in tests (supertest). Middleware order matters: helmet → request
  logging → EMF metrics → json → routes → 404 → error handler (error handler is
  always last).
- `src/server.ts` — entrypoint: boot-time config check, `listen()`, graceful
  shutdown.
- `src/config.ts` — all env access lives here, exported as a frozen `config`
  object. Don't read `process.env` elsewhere.
- `src/logger.ts` — pino logger via the shared `createLogger` factory, plus
  api-specific redact paths (request headers).
- `src/db.ts` / `src/cache.ts` — pg **pool** + drizzle handle, and the Valkey
  client. Both are lazy singletons: `createApp()` and the tests do no network
  I/O; `server.ts` initiates the cache connection and closes both on shutdown.
  Postgres auth is mode-switched (`DB_AUTH`): `password` = `DATABASE_URL`
  (local dev); `iam` = per-connection RDS tokens via `@aws-sdk/rds-signer`
  (AWS — pg's `password` accepts an async function).
- `src/repo/` — data access, **cache-aside**: reads try Valkey first; a
  Postgres fallback re-populates the key with a fresh TTL (`CACHE_TTL_SECONDS`,
  keep in step with the hydrator's). Writes go to Postgres only. Any cache
  problem — read or write-back — degrades to Postgres, never fails a request.
  The hydrator still does the bulk write-through on its schedule.
- `src/middleware/` — `auth.ts` (Entra ID JWT), `errorHandler.ts` (`HttpError`,
  404, central handler), `metrics.ts` (EMF).
- `src/routes/` — one router per concern; mount in `app.ts`.

### hydrator (`code/hydrator`)

- `src/main.ts` — entrypoint: config check → connect → apply drizzle
  migrations → `runHydration()` → emit the run metric → exit. Exit code is the
  contract (0 success / 1 failure); there is no server, no port, no health
  check. A `JOB_TIMEOUT_MS` hard cap and a SIGTERM handler make sure a run can
  never hang or pile up behind the next scheduled invocation.
- `src/config.ts` / `src/logger.ts` — same pattern as the api (frozen `config`,
  shared logger factory; hydrator redacts connection strings).
- `src/db.ts` / `src/cache.ts` — client factories plus the narrow `Db` (drizzle
  handle) / `Cache` types the steps depend on; tests run against in-memory
  Postgres (PGlite) and a fake cache. The Valkey client never retries
  (`retryStrategy: () => null`) — a failed connection is a failed run; the next
  scheduled run is the retry.
- `src/hydrate.ts` — `runHydration(db, cache)` orchestrates the steps: Postgres
  first, then Valkey is warmed from what was just written.
- `src/steps/` — one file per target store, written as drizzle queries against
  the shared schema. **Every write must be idempotent** (upserts, TTL'd SETs)
  so a rerun after any failure is safe.
- `drizzle/` — SQL migrations **generated** by `npm run db:generate -w
  hydrator` from the shared schema; never hand-edit. Shipped in the image and
  applied by `main.ts` at the start of each run — there is no separate
  migration deploy step.

### shared (`code/shared` → `@app/shared`)

- `src/items.ts` — the drizzle `items` `pgTable` (source of truth for the DB
  schema), the `Item` zod schema/type (edge validation; keep in lockstep with
  the table), and the `items:<id>` cache-key builder. **All db/cache schemas,
  types, and key formats live here** — it's the contract between the services;
  neither service defines its own copy. Schema change flow: edit the table →
  `npm run build -w shared` → `npm run db:generate -w hydrator` → commit the
  generated SQL.
- `src/config.ts` — `toInt` env parsing helper.
- `src/logging.ts` — `createLogger()` (CloudWatch-tuned pino) with the base
  redact list; services pass `extraRedactPaths` for their own exposure.
- Consumed via each service's `exports`-resolved `dist/` — plain `tsc`, no
  bundler. Add new shared code to `src/` and re-export it from `src/index.ts`.

## Conventions

- **ESM + NodeNext.** Relative imports MUST include the `.js` extension
  (`./config.js`), even though the source is `.ts`. `verbatimModuleSyntax` is on,
  so use `import type` for type-only imports.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and
  `noUnusedLocals/Parameters`. No `any` — lint will flag it.
- **Shared code goes in `@app/shared`.** Anything both services must agree on —
  db/cache schemas, types, key formats, config/logging helpers — lives in
  `code/shared`, never duplicated per service. Import it as `@app/shared`
  (bare specifier, no `.js` suffix).
- **Errors:** throw `HttpError(status, message)` from handlers. Express 5 forwards
  rejected promises to the error handler automatically — no try/catch needed for
  the happy path, no `express-async-errors`. The central handler also maps
  `ZodError` → 400 (with field details) and reads `status`/`statusCode` off
  library errors (e.g. body-parser's 413/400).
- **Validation:** validate input with zod via the `validate({ body, params, query })`
  middleware (`api/src/middleware/validate.ts`); request schemas live next to
  their route, but derive them from the domain schemas in `@app/shared`
  (`ItemSchema.pick(…)`/`.omit(…)`) rather than redefining shapes. Note Express
  5's `req.query` is a **read-only getter** — validate it but don't reassign it.
  Body is capped by `JSON_BODY_LIMIT`.
- **Logging:** use the service's `logger` (or `req.log` inside a request). Never
  `console.log`. Anything secret must be covered by the shared base redact list
  (`shared/src/logging.ts`) or the service's `extraRedactPaths` in its
  `logger.ts`.
- **Config:** add new settings to the service's `config.ts` with a sane default,
  and document them in that service's `.env.example`.
- **Docs stay in sync.** Treat docs as part of the change, not an afterthought:
  whenever code changes behavior, update the affected project README
  (`code/*/README.md`), the root `README.md` if the big picture shifted, this
  `CLAUDE.md`, and the service `.env.example` files in the same change. A change isn't done until the docs match the
  code. The `/sync-docs` skill (`.claude/skills/sync-docs/`) runs a full
  audit-and-fix pass across all docs on demand.
- **API reference is generated.** `docs/api.md` is produced from the routes + zod
  schemas by the `/api-docs` skill (`.claude/skills/api-docs/`) — don't hand-edit
  it; re-run `/api-docs` after changing routes or schemas. It's Backstage
  TechDocs-ready.

## Releases & commits

- **Conventional Commits, enforced.** A husky `commit-msg` hook (and a CI job
  on PRs) runs commitlint (`code/commitlint.config.mjs`). `fix:` → patch,
  `feat:` → minor, `feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:` → no
  release. Suggested scopes: `api`, `hydrator`, `shared`, `infra`.
- **Lockstep versioning via semantic-release** (`code/.releaserc.json`), run
  by `.github/workflows/ci.yml` on pushes to `main`: one `vX.Y.Z` tag for the
  whole repo, both images built+pushed to ECR at that tag with
  `SERVICE_VERSION` baked in (`code/scripts/release-images.sh`).
- **The version lives in the git tag**, not `package.json` — the `1.0.0`s in
  the package files are intentionally static; don't bump them.
- Deploys are manual promotion: set `image_tag`/`hydrator_image_tag` to a
  released version and `terraform apply`.

## Auth (Entra ID / MSAL)

- `requireAuth` validates the bearer access token against the tenant JWKS
  (issuer, audience, expiry). `/healthz` is intentionally public; everything
  under `/api` is protected.
- Required env: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_AD_AUDIENCE`. The
  server **exits on boot in production** if these are missing.
- Defaults assume **v2.0** tokens. If the app registration issues v1.0
  (`accessTokenAcceptedVersion != 2`), set `AZURE_AD_ISSUER` to
  `https://sts.windows.net/<tenant-id>/`.
- **Role-based access is not implemented yet** (planned for admins). The `roles`
  claim is already parsed onto `req.auth` — build `requireRole` on top of
  `requireAuth`, don't replace it.

## Observability

- Logs: structured JSON, `service`/`env` on every line, label levels, ISO time,
  `/healthz` excluded, secrets redacted. Tuned for CloudWatch Logs Insights.
  Both services build their logger with `createLogger` from `@app/shared`.
- Metrics: EMF → CloudWatch Metrics, no extra IAM. The api emits per-request
  (`api/src/middleware/metrics.ts`, namespace `ExpressFargateService`); the
  hydrator emits one line per run (`hydrator/src/metrics.ts`, namespace
  `HydratorService`). **Keep dimensions low-cardinality** — templated route +
  status class, never raw URLs/ids/users.

## Request identity & auditing

- **Log who, pseudonymously.** `requireAuth` binds `userId` (oid) and `tenantId`
  (tid) to `req.log`, so every line for an authenticated request carries the
  actor. Use the **immutable `oid`** — never log name/email/`preferred_username`
  (PII; creates GDPR/erasure liability). Returning those to the user from
  `/api/me` is fine; logging them is not.
- **Correlation id.** `req.id` comes from the ALB's `X-Amzn-Trace-Id` (or
  `X-Request-Id`), falling back to a UUID — set via `genReqId` in `app.ts`.
- **Auditing is separate from debug logging.** For security-relevant actions
  (admin mutations, role changes, access denied), call `recordAudit(req, {...})`
  from `src/audit.ts` — a dedicated stream tagged `log_type:"audit"`, pinned to
  `info` so it's never silenced by `LOG_LEVEL`. This is the seam for the RBAC
  work; don't fold audit events into normal request logs.

## Networking

- **CORS:** allowlist the SPA origins via `CORS_ORIGINS` (comma-separated).
  Empty denies all cross-origin. Preflight is handled before `requireAuth`, so
  `OPTIONS` never needs a token. Configured in `app.ts`.
- **ALB keep-alive:** `server.keepAliveTimeout`/`headersTimeout` (config
  `KEEP_ALIVE_TIMEOUT_MS`/`HEADERS_TIMEOUT_MS`, defaults 65s/66s) must exceed the
  ALB idle timeout (default 60s) or you get intermittent 502s. Set in `server.ts`.

## Roadmap

Production-readiness backlog lives in `ROADMAP.md`. Keep it current — check items
off as they land, in the same change.

## Gotchas

- Don't authenticate `/healthz` or log/meter it — the ALB polls it constantly.
- The JWKS set is built lazily so `createApp()` does no network I/O; tests run
  without Azure config (they assert the 401 paths).
- `@app/shared` resolves to its **built** `dist/` — a fresh clone (or any edit
  to `code/shared`) needs `npm run build -w shared` before service
  typecheck/test/dev work; the root scripts do it automatically.
- `iovalkey` is CJS: import the **named** `Redis` export
  (`import { Redis as Valkey } from 'iovalkey'`) — the default import isn't
  constructable under NodeNext.
- Docker builds use the workspace root as context
  (`docker build -f code/<svc>/Dockerfile code/`) so `shared` is in context.
- The hydrator is a job, not a server: no ports, no health check, no reconnect
  loops. All its writes must stay idempotent — reruns are the retry model.
- `compose.yaml` is **local dev only** (Postgres + Valkey on loopback). The
  images never see it — in AWS the same env vars come from the task
  definition/Secrets Manager.
- `code/hydrator/drizzle/` is generated output (like `docs/api.md`): regenerate
  with `npm run db:generate -w hydrator`, don't hand-edit, do commit it.
- `process.hrtime`/`Date.now()` are fine in app code (only workflow scripts ban
  them).
