# express-fargate-services

Two small, production-minded TypeScript services, containerized and deployed
to **ECR / ECS Fargate**. KISS by design — minimal dependencies, one clear
pattern per concern.

The flow: the **hydrator** runs on a schedule (EventBridge → one-off Fargate
task), migrates the Postgres schema, ingests reference data, and
write-throughs it into RDS Postgres and ElastiCache Valkey. The **api** (an
Express 5 app behind an ALB, authenticated with Microsoft Entra ID) serves
that data cache-first, falling back to Postgres and re-populating expired
keys. A small internal package, **`@app/shared`**, holds the contracts both
sides must agree on.

## Table of contents

- [Repository layout](#repository-layout)
- [Highlights](#highlights)
- [Local development](#local-development)
  - [Prerequisites](#prerequisites)
  - [First-time setup](#first-time-setup)
  - [Day-to-day commands](#day-to-day-commands)
  - [The datastores](#the-datastores)
  - [Troubleshooting](#troubleshooting)
- [Workspace scripts](#workspace-scripts)
- [Docker](#docker)
- [Releases & versioning](#releases--versioning)
- [Deploying to AWS](#deploying-to-aws)

Per-project detail lives in each project's README:
[api](code/api/README.md) · [hydrator](code/hydrator/README.md) ·
[shared](code/shared/README.md) · [infrastructure](infrastructure/README.md) ·
[API endpoint reference](docs/api.md)

## Repository layout

```
.                     # shared docs live at the root (README, CLAUDE, ROADMAP)
├── code/             # npm workspace (run npm commands from here)
│   ├── api/          # Express 5 JSON API — auth, validation, cache-aside reads
│   ├── hydrator/     # scheduled run-to-completion job — migrations + hydration
│   └── shared/       # @app/shared — schemas/types/helpers both services use
└── infrastructure/   # Terraform for the AWS deployment
```

Each part has its own README with the full detail:

- [`code/api/README.md`](code/api/README.md) — endpoints, Entra ID auth,
  validation & errors, data access, observability, env vars
- [`code/hydrator/README.md`](code/hydrator/README.md) — run lifecycle,
  drizzle schema & migrations, metrics, env vars
- [`code/shared/README.md`](code/shared/README.md) — what belongs in the
  shared package and how it's consumed
- [`infrastructure/README.md`](infrastructure/README.md) — the AWS stack
  (ECR, ALB, ECS, EventBridge schedule, alarms) and deploy flow
- [`docs/api.md`](docs/api.md) — generated endpoint reference

Run app commands from the workspace root `code/` (e.g. `cd code && npm run build`)
or target one package with `-w` (e.g. `npm run dev -w api`); run Terraform from
`infrastructure/`.

## Highlights

- **Express 5 + strict TypeScript + zod** — async error forwarding, validated
  input, no `any`.
- **Entra ID (Azure AD) JWT auth** on `/api/*`, verified against the tenant
  JWKS.
- **Postgres (drizzle ORM + generated migrations) with a Valkey cache-aside** —
  the hydrator bulk-writes both stores; the api reads cache-first and
  re-populates expired keys.
- **CloudWatch-native observability** — structured pino logs with secret
  redaction, plus real metrics via EMF (no extra IAM).
- **Cost-aware deployment** — the api autoscales behind an ALB; the hydrator
  only exists while a scheduled run is executing.
- **Workspace-scoped Docker images** — each multi-stage build ships only that
  service's dependency closure, as non-root `node`.
- **Tests without infrastructure** — Vitest + supertest + in-memory Postgres
  (PGlite) running the real migrations and SQL.

## Local development

The model: **only the datastores run in Docker** (Postgres 18 + Valkey 9 via
`code/compose.yaml`, standing in for RDS / ElastiCache); the services run on
the host with hot reload. Compose is **local development only** — production
images know nothing about it: locally the services read
`DATABASE_URL`/`VALKEY_URL` pointing at compose; on AWS, Terraform injects the
datastore config and Postgres auth is **IAM** (short-lived tokens via each
task role — no database password exists in any task).

### Prerequisites

- **Node.js ≥ 22** and npm ≥ 10 (workspaces + `--env-file` support)
- **Docker** with Compose v2 (`docker compose version`)

### First-time setup

All commands run from `code/` (the npm workspace root):

```bash
cd code

# 1. Install all workspaces (one root lockfile, hoisted node_modules)
npm install

# 2. Build the shared package — api and hydrator resolve @app/shared from its dist/
npm run build -w shared

# 3. Start the local datastores and wait for their healthchecks
docker compose up -d --wait

# 4. Create per-service env files — the defaults already point at the compose
#    stack (same throwaway credentials), so the copies work unedited
cp api/.env.example api/.env
cp hydrator/.env.example hydrator/.env

# 5. Create the schema and seed the stores (migrates, upserts rows, warms Valkey)
npm run dev -w hydrator

# 6. Run the api with hot reload → http://localhost:3000
npm run dev -w api
```

Smoke-test from another terminal:

```bash
curl localhost:3000/healthz          # 200 — public, no auth
curl localhost:3000/api/items        # 401 — protected; needs an Entra ID token
docker compose exec postgres psql -U postgres -d app -c 'TABLE items'
docker compose exec valkey valkey-cli get items:1
```

> **Auth in dev:** the Entra ID vars in `api/.env` are placeholders. Without
> real values the server boots with a warning and every `/api/*` route returns
> 401 — `/healthz` and the error paths still work, which is what the test
> suite covers. To exercise protected routes locally, fill in a real tenant's
> `AZURE_*` values and call with a bearer token from that tenant (see the
> [api README](code/api/README.md)).

### Day-to-day commands

| Command                                           | What it does                                                 |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `npm run dev -w api`                              | api with hot reload (`tsx`, loads `api/.env`)                |
| `npm run dev -w hydrator`                         | one full hydration run: migrate → upsert → warm cache → exit |
| `npm run db:migrate -w hydrator`                  | apply pending drizzle migrations only (no hydration)         |
| `npm run db:generate -w hydrator`                 | generate a SQL migration after a schema change in `shared`   |
| `npm test` / `npm run lint` / `npm run typecheck` | the full gate, across all workspaces                         |
| `docker compose up -d --wait` / `down`            | start / stop the datastores (`down` keeps Postgres data)     |
| `docker compose down -v`                          | stop **and reset** Postgres data                             |

Two things worth internalizing:

- **After editing `code/shared`, run `npm run build -w shared`.** The services
  (and their tests) resolve `@app/shared` from its compiled `dist/` — stale
  builds show up as type errors or old behavior. The root `build`/`test`/
  `typecheck` scripts do this automatically; the per-service `dev` servers
  don't.
- **Tests never need Docker.** The hydrator's tests run the real migrations
  and SQL against in-memory Postgres (PGlite); the api's tests use supertest
  with no network. `npm test` works on a fresh clone with no compose stack.

### The datastores

`code/compose.yaml` pins `postgres:18-alpine` and `valkey/valkey:9-alpine`
(match the majors you'll run in AWS), adds healthchecks (`--wait` blocks until
ready), and binds both ports to `127.0.0.1` only — nothing is exposed to the
LAN. Credentials are throwaway local-dev values (`postgres`/`postgres`, db
`app`) and must never be real ones.

- **Postgres** persists in the `postgres-data` named volume across
  `up`/`down`; `docker compose down -v` deletes it for a clean slate (rerun
  the hydrator to rebuild).
- **Valkey** is deliberately ephemeral — it's a cache. Losing it is the normal
  case the system already handles: hydration rebuilds it, and every key
  carries a TTL.

To change the database schema, see the
[hydrator README](code/hydrator/README.md#schema--migrations-drizzle).

### Troubleshooting

- **`Bind for 127.0.0.1:5432 failed: port is already allocated`** — another
  local Postgres (or project stack) owns the port. Find it with `docker ps`
  (or `lsof -i :5432`) and stop it; the compose file intentionally keeps the
  standard ports.
- **`Cannot find module '@app/shared'` / stale shared types** — run
  `npm run build -w shared` (fresh clones haven't built it yet).
- **`ENOENT: .env`** on `npm run dev` — copy the example first
  (`cp <svc>/.env.example <svc>/.env`); `tsx --env-file` requires the file to
  exist.
- **Hydrator exits 1 with `connection refused`** — the compose stack isn't up
  (or ports are shadowed by another stack): `docker compose up -d --wait`.
- **Weird DB state after schema experiments** — `docker compose down -v`,
  then `npm run dev -w hydrator` to migrate + reseed from scratch.

## Workspace scripts

From `code/` — each runs across the right workspaces in the right order
(`shared` is always built first):

| Command             | Purpose                                      |
| ------------------- | -------------------------------------------- |
| `npm run build`     | Build `shared`, then compile both services   |
| `npm test`          | Build `shared`, then Vitest in every package |
| `npm run lint`      | ESLint in every package                      |
| `npm run format`    | Prettier write in every package              |
| `npm run typecheck` | Build `shared`, then type-check the services |

Target a single package with `-w`: `npm run dev -w api`, `npm run build -w
shared`. Each service also keeps its own `dev`/`start`/`test` scripts.

## Docker

Each service has its own Dockerfile, but the build context is always the
workspace root `code/` so the `shared` package is in context (run from the
repo root):

```bash
docker build -f code/api/Dockerfile -t express-fargate-service code/
docker build -f code/hydrator/Dockerfile -t hydrator-service code/
```

Each image compiles `shared` and the service inside the build and ships
`shared/dist` alongside the service's `dist` — the internal package is baked
in, nothing is pulled from a registry. Runtime dependencies are scoped per
workspace (`npm ci --omit=dev -w <service>`), so each image carries only that
service's dependency closure — the api ships no `pg` driver it doesn't use,
the hydrator no `express`.

## Releases & versioning

Versioning is **lockstep**: one semver for the whole repo, computed by
[semantic-release](https://semantic-release.gitbook.io) from
[Conventional Commits](https://www.conventionalcommits.org) and applied to
every artifact. On each push to `main` (after the CI gate passes), a
release-worthy commit produces:

- a git tag `vX.Y.Z` + GitHub release notes,
- both Docker images, built and pushed to ECR as `vX.Y.Z` (immutable), with
  the version baked in as `SERVICE_VERSION` — so every log line says which
  release wrote it.

Commit messages drive the bump: `fix:` → patch, `feat:` → minor,
`feat!:`/`BREAKING CHANGE:` → major; `docs:`/`chore:`/`refactor:` → **no
release, no images**. Suggested scopes: `api`, `hydrator`, `shared`, `infra`.
A husky `commit-msg` hook (installed by `npm install`) and a CI job lint the
messages.

Because versions are lockstep, api `v1.4.0` and hydrator `v1.4.0` were built
from the same commit — the deploy rule for schema changes is simply "run the
hydrator at ≥ the api's version". A hydrator-only fix still bumps the api
image; that's intentional (fleet versions stay comparable), and images for
unchanged services are byte-for-byte rebuilds.

Pieces: `code/.releaserc.json` (config), `code/scripts/release-images.sh`
(image fan-out), `code/commitlint.config.mjs` (message rules),
`.github/workflows/ci.yml` (gate + release; see its header for the four
repository variables that enable ECR pushes — until they're set, releases
tag + publish notes and skip images).

## Deploying to AWS

The stack (two ECR repos, ALB, ECS Fargate cluster, the api service with
autoscaling, the hydrator's EventBridge schedule, **RDS Postgres +
ElastiCache Valkey** with IAM database auth and locked-down security groups,
CloudWatch alarms) is provisioned with **Terraform in
[`infrastructure/`](infrastructure/)**, deploying into an existing VPC. After
the first apply, run the one-time `infrastructure/db-bootstrap.sql` via psql
(as the master user) to create the per-service IAM database users (see the
infrastructure README).

See [`infrastructure/README.md`](infrastructure/README.md) for the full flow:
`terraform apply`, then set `image_tag`/`hydrator_image_tag` to a release
version (e.g. `v1.4.0` — CI already pushed those images) and apply again.

The production-readiness backlog lives in [`ROADMAP.md`](ROADMAP.md).
