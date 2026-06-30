---
name: sync-docs
description: Audit and update this repo's documentation so it matches the current state of the code and Terraform. Use when finishing a change, before a release, or whenever the docs may have drifted. Covers README.md, CLAUDE.md, ROADMAP.md, code/.env.example, and infrastructure/README.md.
---

# Sync docs to code

Bring the documentation back in line with what the code and infrastructure
actually do. The **code is the source of truth** — never document aspirational or
planned behavior as if it exists. Work through each check, fix mismatches in the
same pass, then verify nothing broke.

## Scope — the docs to keep in sync

- `README.md` — features ("What's inside"), repo/project layout, scripts, env
  vars, endpoints, deploy flow
- `CLAUDE.md` — architecture, conventions, commands, gotchas, repo layout
- `ROADMAP.md` — checkbox state vs what's actually implemented
- `code/.env.example` — every env var the app reads
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

1. **Env vars** — every `process.env.*` read in `code/src/config.ts` (and
   anywhere else) is present in `code/.env.example` and any README/CLAUDE env
   tables, with no stale entries. Defaults documented should match the code.
2. **Routes/endpoints** — routers mounted in `code/src/app.ts` and the files in
   `code/src/routes/` match the endpoints described in `README.md` (paths, auth
   requirements, public vs protected).
3. **Scripts** — `code/package.json` `scripts` match the README "Scripts" table.
4. **Dependencies / features** — notable deps in `code/package.json` are
   reflected in the README "What's inside" list (and removed deps aren't).
5. **Middleware order & conventions** — the middleware pipeline and conventions
   in `CLAUDE.md` match `code/src/app.ts` and the middleware files.
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
# from code/
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