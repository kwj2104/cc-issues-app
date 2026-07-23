# Claude Code Issue Tracker — setup runbook

Internal tracker for the `anthropics/claude-code` backlog: deterministic retrieval + Claude
classification every 2 hours (billed to your Max subscription, running on GitHub's cloud) +
a claude.ai-styled dashboard on Vercel. Infra cost: **$0/month** on free tiers.

You do the ~30 minutes of one-time account wiring below; Claude Code builds the rest
(`PLAN.md` Phases 1–5, roughly 4–5 sessions).

## One-time setup (~30 min)

**1. Create the repo** (private is fine — the cron budget fits free minutes):

```bash
gh repo create claude-issue-tracker --private --clone
# copy this kit's contents into it, then:
git add -A && git commit -m "scaffold: schema, workflows, prompts, specs, design" && git push
```

**2. Supabase** (you have the account): create a project (any region) →
SQL Editor → paste all of `db/schema.sql` → Run. Then Project Settings → API: copy the
**Project URL**, **anon** key, and **service_role** key. Also Project Settings → Database →
**Connection string → URI** (Session pooler): this is `DATABASE_URL`, the direct Postgres DSN
the pipeline uses via `psycopg` (the service_role key is a PostgREST JWT, not a DB password).

**3. GitHub PAT** for reading the claude-code repo: github.com → Settings → Developer settings →
Fine-grained tokens → new token, Public repositories (read-only), 90-day expiry is fine.

**4. Claude Max token** (the classifier's auth — one command, on your machine):

```bash
claude setup-token     # log in with your Max account; copy the long-lived token it prints
```

**5. Repo secrets:**

```bash
gh secret set SYNC_GITHUB_PAT             # paste the PAT
gh secret set CLAUDE_CODE_OAUTH_TOKEN     # paste the setup-token output
gh secret set SUPABASE_URL                # https://YOURPROJECT.supabase.co
gh secret set SUPABASE_SERVICE_ROLE_KEY   # the service_role key
gh secret set DATABASE_URL                # Postgres DSN (Database → Connection string → URI)
```

**6. Seed data:** drop `claude_code_issue_log.csv` (from the July review workbook) into
`data/seed/`. It's gitignored — it only needs to exist where backfill runs, so either commit it
deliberately or run the seed-import from a machine that has it (see `data/seed/README.md`).

**7. Local env for development:** `cp .env.example .env` and fill it in.

## Build it with Claude Code

```bash
cd claude-issue-tracker && claude
```

> Read CLAUDE.md and PLAN.md, then start Phase 1. Work through the acceptance criteria and
> stop for my review at the end of each phase.

That's the whole prompt. Everything Claude Code needs is in the repo: `docs/build-plan.md`
(architecture + decisions), `docs/retrieval-spec.md` (exact pipeline math), `design/mockup.html` +
`design/design-spec.md` (the frontend, fully designed), and the frozen classifier prompts.

## First data (after Phase 1–2)

Actions tab → **backfill** → run with mode `census` (minutes) → then `seed-import` → then
`catchup` a few times (≤150 classifications each) until the queue is empty — or just let the
2-hourly sync drain it over a day or two. The **sync** workflow is live from the moment Phase 2
merges; it self-heals gaps, so missed or failed runs cost nothing.

## Deploy the app (after Phase 3)

Vercel dashboard → Add New Project → import the repo → **Root Directory: `web`** → set env vars
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `EDIT_SECRET` → Deploy. Every push
to main redeploys.

## Costs & limits

| Thing | Cost / limit |
|---|---|
| Supabase free | $0 — 500 MB (we use <100 MB); 2h writes prevent the 7-day pause |
| Vercel Hobby | $0 — nominally non-commercial; Pro $20 or Cloudflare if you want strictness |
| GitHub Actions | $0 — ~1,650/2,000 free private minutes at 2h cadence (public repo = unlimited) |
| Claude classification | $0 extra — Max subscription via OAuth token; interval load is light; catch-up is capped per run |
| Fallback | `classifier.api_fallback` + `ANTHROPIC_API_KEY` ≈ $5–15/mo if ever needed |

## Ops in one paragraph

Pause everything: disable the workflows in the Actions tab. A missed day heals itself (cursor).
Token rotation: rerun `claude setup-token` yearly; PAT per its expiry. Schema changes: edit
`db/schema.sql`, paste the delta in the SQL Editor. Watch quality on the app's **Batches & ops**
page — area agreement ≥ 85% and High share inside 15–25% are the health bars.
