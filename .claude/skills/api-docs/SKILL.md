---
name: api-docs
description: Generate or update the API reference markdown (docs/api.md) from the Express routes and zod schemas. Documents every endpoint — method, path, auth, params, request/response schemas, status codes, and examples. Output is Backstage TechDocs-ready. Use after adding or changing routes/schemas, or when the API doc may be stale.
---

# Generate / update API docs (markdown)

Produce a single, complete, human-readable API reference at `docs/api.md`,
derived from the code (the **source of truth**). The output is Backstage
TechDocs-ready (rendered via MkDocs).

> Scope: this is the **markdown reference** for humans/TechDocs. The
> machine-readable contract for Backstage's API **catalog** entity is an OpenAPI
> spec (separate roadmap item); the two coexist. Don't try to make this file a
> substitute for OpenAPI.

## Source of truth (read these)

- `code/src/app.ts` — which routers are mounted where, and which are public vs
  behind `requireAuth` (everything under `/api` is protected; `/healthz` is public).
- `code/src/routes/*.ts` — methods, paths, success status codes, response bodies.
- The zod schemas used by `validate({ body, params, query })` — translate their
  constraints (`min`/`max`/`trim`/`coerce`/`int`/`positive`) into the field tables.
- `code/src/middleware/auth.ts` — bearer JWT scheme and 401 messages.
- `code/src/middleware/errorHandler.ts` — shared error shapes (ZodError → 400 with
  `details`, `HttpError`, 404, body-parser 413/400, 500 hidden in prod).
- `code/src/config.ts` — base path, `JSON_BODY_LIMIT`, correlation-id header.

## Steps

1. Enumerate **every** endpoint from `app.ts` + `routes/`. For each capture:
   method, full path (incl. the `/api` mount prefix), auth requirement, summary.
2. Translate each request schema into a **field table**: name, type, required,
   constraints (from zod), description. Document path params and request bodies.
3. Document **responses** per endpoint: status code → meaning + body shape, with a
   realistic JSON example consistent with the in-memory sample data.
4. Document the **shared error responses once** (401, 400 validation with
   `details`, 404, 413, 500) and reference them from endpoints.
5. Write/refresh `docs/api.md` using the structure below. Update **in place** —
   stable section order, no duplicated sections, minimal diffs.
6. Verify: every route in code is documented and every documented route still
   exists. Report any drift fixed.

## docs/api.md structure

The file contains **only the endpoint reference** — no overview, base-URL, auth,
conventions, or error-shape sections, and **no footer/disclaimer**. Start the
file at the `# Endpoints` header.

- `# Endpoints`
- Grouped by resource (Health, then `/api` by resource). Each endpoint:
  `### METHOD /path` + auth badge (🔒 for protected), a one-line description,
  path/query param table, request body table, responses table, and a `curl`
  example.
- Keep endpoints **self-contained** — since there's no Authentication section,
  put the `401` body inline (`{ "error": "Invalid or expired token" }`) rather
  than linking to a section. No cross-links to removed sections.

## Notes

- Reflect zod constraints exactly so the doc matches what the API **validates**
  (e.g. `name`: string, required, trimmed, 1–100 chars).
- Keep examples consistent with the seeded items (`{id:1,name:"first"}`, …).
- If a route exists with no schema (e.g. `GET /api/items`), document it from the
  handler's response shape.
