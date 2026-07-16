---
name: sync-docs
description: Audit and update this repo's documentation so it matches the current state of the code and Terraform. Use when finishing a change, before a release, or whenever the docs may have drifted. Covers README.md, CLAUDE.md, ROADMAP.md, code/api/.env.example and code/hydrator/.env.example, and infrastructure/README.md.
---

# Sync docs to code

Bring the documentation back in line with what the code and infrastructure
actually do. The **code is the source of truth** — never document aspirational or
planned behavior as if it exists. Work through each check, fix mismatches in the
same pass, then verify nothing broke.

## Scope — the docs to keep in sync

- `README.md` (root) — overview, repo layout, local dev, workspace scripts,
  Docker/deploy pointers. Generic only — low-level detail belongs in the
  project READMEs.
- `code/api/README.md` / `code/hydrator/README.md` / `code/shared/README.md` —
  per-project detail: endpoints/auth/validation/data access (api), run
  lifecycle/migrations/metrics (hydrator), exports/consumption rules (shared)
- `CLAUDE.md` — architecture, conventions, commands, gotchas, repo layout
- `ROADMAP.md` — checkbox state vs what's actually implemented
- `code/api/.env.example` / `code/hydrator/.env.example` — every env var each
  service reads
- `infrastructure/README.md` — variables, resources, file layout, autoscaling

## Step 1 — find what changed

If this is a git repo, scope the work to recent changes first:

```bash
git diff --stat HEAD        # uncommitted
git log --oneline -10       # recent history
git diff HEAD~5 --stat      # last few commits
```

Use that to target the audit, but still run the checks below — drift can predate
the latest change. If git is unavailable, read the source files directly.

## Step 2 — checks (source of truth → doc)

1. **Env vars** — every `process.env.*` read in `code/api/src/config.ts` and
   `code/hydrator/src/config.ts` (and anywhere else) is present in that
   service's `.env.example` and any README/CLAUDE env tables, with no stale
   entries. Defaults documented should match the code.
2. **Routes/endpoints** — routers mounted in `code/api/src/app.ts` and the files in
   `code/api/src/routes/` match the endpoints described in `README.md` (paths, auth
   requirements, public vs protected).
3. **Scripts** — the workspace scripts in `code/package.json` match the README
   "Scripts" table (per-service scripts live in `code/*/package.json`).
4. **Dependencies / features** — notable deps in `code/api/package.json`,
   `code/hydrator/package.json`, and `code/shared/package.json` are reflected in
   the README "What's inside" list (and removed deps aren't).
5. **Middleware order & conventions** — the middleware pipeline and conventions
   in `CLAUDE.md` match `code/api/src/app.ts` and the middleware files; the
   hydrator run flow in `CLAUDE.md` matches `code/hydrator/src/main.ts`; the
   `@app/shared` exports described match `code/shared/src/index.ts`.
6. **Terraform** — variables in `infrastructure/variables.tf`, resources/modules
   in `infrastructure/main.tf` + `infrastructure/data.tf`, and the file list
   match `infrastructure/README.md` (incl. the Layout table and Autoscaling
   section). `terraform.tfvars.example` reflects current variables.
7. **ROADMAP** — items implemented in code/infra are checked off; newly
   discovered gaps are added. Don't check off anything not actually done.

## Step 3 — fix

Edit each doc to match the code. Match the existing tone, structure, and
formatting of the file you're editing. Keep changes minimal and surgical — don't
rewrite sections that are already correct.

## Step 4 — verify

```bash
# from code/ (the workspace root — covers shared, api, and hydrator)
cd code && npm run typecheck && npm run lint && npm test

# from infrastructure/ (if any infra docs/files were touched)
cd ../infrastructure && terraform fmt -check && terraform validate
```

## Step 5 — summarize

Report what was updated and what was already in sync. Be specific (file + what
changed). If a doc references something that no longer exists in the code, fix or
remove it and call that out.

## Notes

- This operationalizes the "Docs stay in sync" rule in `CLAUDE.md`.
- App commands run from `code/`; Terraform runs from `infrastructure/`.
- **`docs/api.md` is generated** by the `/api-docs` skill — don't hand-edit it.
  If routes or zod schemas changed, run `/api-docs` to refresh it instead.
- Never invent behavior to make a doc look complete — if the code doesn't do it,
  the doc shouldn't claim it.