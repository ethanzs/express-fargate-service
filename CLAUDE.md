# CLAUDE.md

Guidance for working in this repository.

## What this is

A small, KISS Express 5 + TypeScript JSON API, built to be containerized and
deployed to **ECR / ECS Fargate**. It validates Microsoft Entra ID (Azure AD)
access tokens on `/api/*`, logs structured JSON, and emits CloudWatch metrics.
Keep changes minimal and in the existing style — favor clarity over cleverness.

## Repository layout

- **Root** — shared docs only (`README.md`, `CLAUDE.md`, `ROADMAP.md`,
  `.gitignore`).
- **`code/`** — the Express app. Run all `npm` commands from here. Paths below
  (`src/...`) are relative to `code/`.
- **`infrastructure/`** — Terraform for the AWS deployment (ECR/ALB/ECS via
  `terraform-aws-modules`; deploys into an existing VPC referenced by id). Run
  `terraform` from here; see its own README. File split: `settings.tf`
  (terraform/provider/backend), `main.tf` (all resource/module blocks), `data.tf`
  (all data blocks), `variables.tf`, `locals.tf`, `outputs.tf`.

When a file relates to both app and infra, it belongs at the root; otherwise it
lives in the relevant subdir.

## Commands

> Run app commands from `code/` (`cd code`); run Terraform from `infrastructure/`.

| Command | Purpose |
| ------- | ------- |
| `npm run dev` | Hot-reloading dev server (`tsx`, loads `.env`) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled server (`node dist/server.js`) |
| `npm test` | Vitest (run once) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run format` | Prettier write |

Before finishing a change, run `npm run typecheck && npm run lint && npm test`
(from `code/`), and update the docs (`README.md`, `CLAUDE.md`, `.env.example`,
and `infrastructure/README.md` for infra changes) to match. For Terraform
changes, run `terraform fmt` and `terraform validate` in `infrastructure/`.

## Architecture

- `src/app.ts` — `createApp()` builds the Express app with **no** `listen()`, so
  it's importable in tests (supertest). Middleware order matters: helmet → request
  logging → EMF metrics → json → routes → 404 → error handler (error handler is
  always last).
- `src/server.ts` — entrypoint: boot-time config check, `listen()`, graceful
  shutdown.
- `src/config.ts` — all env access lives here, exported as a frozen `config`
  object. Don't read `process.env` elsewhere.
- `src/logger.ts` — pino logger (structured JSON, redaction, CloudWatch-tuned).
- `src/middleware/` — `auth.ts` (Entra ID JWT), `errorHandler.ts` (`HttpError`,
  404, central handler), `metrics.ts` (EMF).
- `src/routes/` — one router per concern; mount in `app.ts`.

## Conventions

- **ESM + NodeNext.** Relative imports MUST include the `.js` extension
  (`./config.js`), even though the source is `.ts`. `verbatimModuleSyntax` is on,
  so use `import type` for type-only imports.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and
  `noUnusedLocals/Parameters`. No `any` — lint will flag it.
- **Errors:** throw `HttpError(status, message)` from handlers. Express 5 forwards
  rejected promises to the error handler automatically — no try/catch needed for
  the happy path, no `express-async-errors`. The central handler also maps
  `ZodError` → 400 (with field details) and reads `status`/`statusCode` off
  library errors (e.g. body-parser's 413/400).
- **Validation:** validate input with zod via the `validate({ body, params, query })`
  middleware (`src/middleware/validate.ts`); define schemas next to the route as
  the single source of truth. Note Express 5's `req.query` is a **read-only getter**
  — validate it but don't reassign it. Body is capped by `JSON_BODY_LIMIT`.
- **Logging:** use the shared `logger` (or `req.log` inside a request). Never
  `console.log`. Anything secret must be covered by `redactPaths` in `logger.ts`.
- **Config:** add new settings to `config.ts` with a sane default, and document
  them in `.env.example`.
- **Docs stay in sync.** Treat docs as part of the change, not an afterthought:
  whenever code changes behavior, update `README.md`, this `CLAUDE.md`, and
  `.env.example` in the same change. A change isn't done until the docs match the
  code. The `/sync-docs` skill (`.claude/skills/sync-docs/`) runs a full
  audit-and-fix pass across all docs on demand.
- **API reference is generated.** `docs/api.md` is produced from the routes + zod
  schemas by the `/api-docs` skill (`.claude/skills/api-docs/`) — don't hand-edit
  it; re-run `/api-docs` after changing routes or schemas. It's Backstage
  TechDocs-ready.

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
- Metrics: EMF (`src/middleware/metrics.ts`) → CloudWatch Metrics, no extra IAM.
  **Keep dimensions low-cardinality** — templated route + status class, never raw
  URLs/ids/users.

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
- `process.hrtime`/`Date.now()` are fine in app code (only workflow scripts ban
  them).
