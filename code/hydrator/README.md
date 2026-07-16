# hydrator

A run-to-completion TypeScript job — not a server — that hydrates the data
stores: it applies schema migrations, upserts reference data into RDS
Postgres, and write-throughs the `items:<id>` keys into ElastiCache Valkey. In
AWS, EventBridge Scheduler launches it as a one-off ECS Fargate task on a
schedule (daily by default) and it exits when done, so nothing runs or bills
between runs.

For repo-wide setup (workspace install, docker compose, day-to-day commands),
see the [root README](../../README.md); for the AWS wiring (schedule, IAM,
alarms), see [`infrastructure/README.md`](../../infrastructure/README.md).

## Layout

```
drizzle/               # generated SQL migrations (drizzle-kit — never hand-edit)
drizzle.config.ts      # drizzle-kit config (the schema lives in @app/shared)
src/
  main.ts              # entrypoint: config check → connect → migrate → hydrate → exit
  migrate.ts           # standalone migration runner (npm run db:migrate)

  config.ts            # env-driven config (the only process.env reader)
  logger.ts            # pino logger (via the shared factory)
  metrics.ts           # per-run EMF metrics (HydratorService namespace)
  db.ts                # pg client + drizzle handle + migrations folder path
  cache.ts             # iovalkey client + the Cache surface the steps use
  hydrate.ts           # runHydration() — orchestrates the steps
  steps/
    postgres.ts        # upsert reference data (idempotent; resets the id sequence)
    valkey.ts          # warm Valkey from Postgres (TTL'd keys)
test/                  # vitest against in-memory Postgres (PGlite)
```

## The run lifecycle

Each invocation: config check → connect to both stores → apply pending drizzle
migrations → hydrate Postgres (upserts) → warm Valkey from what was just
written → emit one EMF metrics line → exit. **The exit code is the contract**:
0 success, 1 failure — there is no port, no health check, no retry loop.

Defensive by design:

- **Fails fast** — missing config or an unreachable store kills the run
  immediately; the Valkey client never enters a reconnect loop
  (`retryStrategy: () => null`). The next scheduled run is the retry.
- **Every write is idempotent** (upserts, TTL'd `SET`s), so a rerun after any
  partial failure is always safe.
- **`JOB_TIMEOUT_MS`** (default 5 min) hard-caps a run so a hung task can't
  pile up behind the next scheduled invocation. `SIGTERM` (ECS stopping the
  task) likewise aborts with exit 1.
- **Identity sequence** — the seed upserts explicit ids, then bumps the
  `items` identity sequence past `MAX(id)` so the api's generated inserts
  never collide.

`src/steps/` is the seam for real data sources: one step per upstream source /
target store, keeping each one idempotent.

## Schema & migrations (drizzle)

Drizzle is deliberately split between this service and `@app/shared` along a
**definition vs. execution** line:

- **`shared` owns the schema definition.** The `items` `pgTable` in
  `code/shared/src/items.ts` is the single source of truth for what the
  database looks like. It lives there because the schema is a _contract_:
  both services import the same table object for typed queries, and the zod
  `Item` schema next to it keeps the domain shape in lockstep. Shared knows
  nothing about migrations.
- **This service owns everything that turns the declaration into a real
  database**: `drizzle.config.ts` (the drizzle-kit tooling config, whose
  `schema` points across the workspace at `../shared/src/items.ts`), the
  generated + committed migration history in `drizzle/`, and the application
  of migrations — at the start of every run (`main.ts`) or on demand
  (`npm run db:migrate`). **The hydrator is the only migrator in the system**;
  the api never migrates, it just assumes the schema.

That gives two distinct read paths into shared: **tooling-time** (drizzle-kit
reads the raw TS source via the relative path — no build needed) and
**runtime** (both services import `items` from `@app/shared`'s compiled
`dist/` purely for query building).

Why this split: migrations in `shared` would ship the SQL history to every
consumer and make each one _look like_ it could migrate — inviting two
services to race on `ALTER TABLE`; one migrator is a correctness property,
and putting the history here makes that ownership structural. The schema in
the hydrator would force the api to import table definitions from a sibling
service, or duplicate them. If the api ever grows tables of its own, promote
the whole arrangement to a dedicated `@app/db` package with a standalone
migration task.

### Changing the schema

```
edit shared/src/items.ts (the pgTable)
        │  npm run build -w shared            ← services see the new types
        ▼
npm run db:generate -w hydrator               ← drizzle-kit diffs the shared
        │                                        schema against its snapshots
        ▼
hydrator/drizzle/000N_*.sql (generated — never hand-edit, do commit)
        │
        ▼
next hydrator run (or db:migrate) applies it
```

Migrations apply at the start of the next run — locally via
`npm run dev -w hydrator`, in AWS on the next scheduled task; there's no
separate migration deploy step. The `drizzle/` folder ships inside the Docker
image (resolved relative to `dist/`), so the task always carries the history
it needs.

One deliberate boundary crossing: **both services' tests** apply this
service's `drizzle/` folder to in-memory Postgres (PGlite), so tests run
against the exact schema production has — the migration history is the only
truthful source of that.

## Configuration

Copy `.env.example` to `.env` locally (defaults match `code/compose.yaml`);
on Fargate these come from the scheduled task definition.

| Variable                                                  | Required      | Notes                                                                                                |
| --------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                            | password mode | Postgres connection string (local dev / compose)                                                     |
| `DB_AUTH` / `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | iam mode      | AWS: `DB_AUTH=iam` + endpoint/user — per-connection RDS auth tokens via the task role, no credential |
| `VALKEY_URL`                                              | yes           | ElastiCache Valkey; `rediss://` with in-transit encryption                                           |
| `CACHE_TTL_SECONDS`                                       | no            | TTL on hydrated keys (default 3600) — keep above the schedule interval                               |
| `JOB_TIMEOUT_MS`                                          | no            | Hard cap per run (default 300000)                                                                    |
| `LOG_LEVEL` / `SERVICE_NAME` / `NODE_ENV`                 | no            | Standard service knobs (see `.env.example`)                                                          |
| `DB_CONNECT_TIMEOUT_MS` / `CACHE_CONNECT_TIMEOUT_MS`      | no            | Connection timeouts (default 10000)                                                                  |

## Observability

Structured JSON logs via the shared `createLogger()` factory; on top of the
shared redaction base list this service scrubs `connectionString`/`url` fields
(they embed the database password).

One EMF metrics line per run (`src/metrics.ts`) — CloudWatch extracts real
metrics from the log stream, no extra IAM. Namespace `HydratorService`,
dimensioned by `service`/`env`:

| Metric                        | Unit         | Use                                         |
| ----------------------------- | ------------ | ------------------------------------------- |
| `HydrationRunCount`           | Count        | did the schedule fire?                      |
| `HydrationFailureCount`       | Count        | alarm when > 0 (Terraform wires this alarm) |
| `HydrationDuration`           | Milliseconds | run duration trend                          |
| `RowsWritten` / `KeysWritten` | Count        | hydration volume sanity check               |

## Running & testing

```bash
# from code/ (see the root README for full local-dev setup)
docker compose up -d --wait       # local Postgres + Valkey
npm run dev -w hydrator           # one full run: migrate → hydrate → exit
npm run db:migrate -w hydrator    # migrations only
npm test -w hydrator              # PGlite: real migrations + real SQL, no Docker
```
