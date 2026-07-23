# Claude Code Issue Tracker

Internal web app for PMs/prod-ops to track, triage, and prioritize the live
`anthropics/claude-code` issue backlog. Deterministic retrieval pipeline (ported from the
July 2026 issue review) + LLM classification on a 2-hour batch cadence + Next.js dashboard.

**Read before building: `PLAN.md` (phases + acceptance criteria) · `docs/build-plan.md`
(architecture) · `docs/retrieval-spec.md` (pipeline formulas) · `design/design-spec.md` +
`design/mockup.html` (the frontend is a port of this mockup — open it in a browser; it is
the source of truth for look, feel, and behavior).**

## Architecture (one breath)

GitHub Actions cron (every 2h) → `pipeline/sync.py`: delta-pull changed issues from the GitHub
API → upsert `issues` → recompute deterministic `features` → headless `claude -p` classifies
new/changed issues against the frozen rubric → adversarial verify pass gates `verified_high` →
blended `final_rank_score` → `batches` row. Supabase Postgres is the store (public read via RLS,
writes via service role). Next.js app on Vercel reads Supabase directly; triage writes go through
one API route gated by `EDIT_SECRET`.

## Stack & conventions

- **Pipeline**: Python 3.12, `psycopg`, pandas/scikit-learn for features/clustering. Modules:
  `pipeline/sync.py`, `pipeline/nightly.py`, `pipeline/backfill.py`, plus `db.py`, `ingest.py`,
  `features.py`, `cluster.py`, `classify.py` as internals. All tunables live in
  `pipeline/config.yaml` — never hardcode weights/thresholds. DB access is via `psycopg`
  using `DATABASE_URL` only (Supabase Session pooler, port 5432); the
  `SUPABASE_SERVICE_ROLE_KEY` is a PostgREST JWT for the web triage route, **not** the
  pipeline. (Switching to the Transaction pooler on 6543 requires `prepare_threshold=None`.)
- **Classifier**: shell out to `claude -p --model sonnet --output-format json --json-schema
  pipeline/prompts/output_schema.json` with the rubric as system prompt (`--append-system-prompt-file`
  or prepended). Auth: `CLAUDE_CODE_OAUTH_TOKEN` env (CI) or logged-in session (local). Batch
  ~20 digests per call. Include 4–6 few-shot exemplars drawn from seed-review rows, stratified by
  area. Verify pass per `prompts/verify_v1.md` for first-pass High / score ≥ 70.
- **Idempotence is law**: every write is an upsert; the sync cursor advances only after a
  successful batch; any run can be safely re-run. A failed run must leave the DB consistent.
- **Determinism**: feature math takes an explicit `as_of` timestamp; no unseeded randomness.
- **Web**: Next.js App Router + TypeScript + Tailwind (tokens as CSS variables per
  `design/design-spec.md`) + TanStack Table/Query. Reads via `NEXT_PUBLIC_SUPABASE_*` anon key
  against `v_master`/`v_new_high`. Never import the service key into `web/`.
- **Secrets**: only via env / GH secrets / Vercel env. Never in code, never in git.

## Commands

- Pipeline locally: `cp .env.example .env` (fill it) → `pip install -r pipeline/requirements.txt`
  → `python -m pipeline.sync` (or `backfill --mode census|seed-import|catchup`, `nightly`).
- DB: schema lives in `db/schema.sql` (idempotent; paste into Supabase SQL Editor to apply).
  Schema changes: edit that file AND note the migration in its header comment.
- Web: `cd web && npm run dev`. Deploy: Vercel Git integration, root directory `web`.
- Tests: `pytest pipeline/tests` — text prep, feature formulas, eligibility (incl. stale-rescue
  boundary 9 vs 10 reactions), cursor semantics, junk filter. Run before declaring a phase done.
- CI: `.github/workflows/{sync,nightly,backfill}.yml` — already written; don't rename the
  entrypoints they call.

## Guardrails

- The rubric (`pipeline/prompts/rubric_v2.md`) is FROZEN — behavior changes go through a new
  `rubric_version`, never silent edits.
- Respect Max-subscription limits: classification is batched, catch-up is capped
  (`classifier.catchup_per_run`); on rate-limit, log, skip, let the next run absorb (cursor makes
  this free). `classifier.api_fallback` + `ANTHROPIC_API_KEY` is the deliberate escape hatch.
- All GitHub data here is public; the DB holds nothing sensitive. The only secret-adjacent
  surface is triage writes (`EDIT_SECRET`) and the service key.
- Don't fetch full issue bodies into the DB — `body_lead` (1500 chars) only; the issue drawer
  fetches the live body client-side from the public GitHub API.
