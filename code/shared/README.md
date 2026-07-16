# @app/shared

The internal package holding everything the `api` and `hydrator` services must
agree on. It's an npm **workspace** dependency: `npm install` symlinks it into
each service's `node_modules`, each Docker build compiles it and ships its
`dist/` inside the image. It is **never published** to a registry.

## What lives here (and what doesn't)

All cross-service **contracts**:

| Module           | Exports                     | Role                                                                                                                |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/items.ts`   | `items` (drizzle `pgTable`) | **The** Postgres schema — drizzle-kit generates migrations from it                                                  |
|                  | `ItemSchema` (zod), `Item`  | Edge validation + the domain type; kept in lockstep with the table                                                  |
|                  | `itemCacheKey(id)`          | The `items:<id>` Valkey key format — the cache contract between hydrator (bulk write-through) and api (cache-aside) |
| `src/config.ts`  | `toInt`                     | Env parsing that fails loudly on garbage instead of defaulting                                                      |
| `src/logging.ts` | `createLogger`              | CloudWatch-tuned pino factory with the base redact list; services add `extraRedactPaths`                            |

Deliberately **not** here: migration history (`code/hydrator/drizzle/` — the
hydrator owns and applies it), service config, HTTP/middleware code, anything
only one service uses. Shared is pure contracts.

## Consuming it

Import as a bare specifier (no `.js` suffix): `import { items, ItemSchema } from '@app/shared'`.

The package resolves to its **compiled `dist/`** (see `exports` in
`package.json`), which drives the one rule:

> **Build `shared` before the services can typecheck, test, or run** — and
> rebuild it after every edit (`npm run build -w shared`). The workspace root
> scripts (`npm run build`/`typecheck`/`test` from `code/`) do this
> automatically; the per-service `dev` servers don't.

In Docker, each service's image build compiles `shared` first and ships
`shared/dist` alongside the service's own `dist` — baked in, nothing pulled
from a registry.

## Adding shared code

1. Add the module under `src/` and re-export it from `src/index.ts`.
2. `npm run build -w shared`.
3. If you changed a drizzle table, generate the migration:
   `npm run db:generate -w hydrator` (see the
   [hydrator README](../hydrator/README.md#schema--migrations-drizzle)).

Keep the bar high: something belongs here only if **both** services must agree
on it. Duplication in one service is cheaper than a false contract.
