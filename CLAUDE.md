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
- **Classifier**: shell out to `claude -p --model sonnet --output-format json` via
  `pipeline/classify.py:run_structured` (classify + verify share it). Auth:
  `CLAUDE_CODE_OAUTH_TOKEN` env (CI) or logged-in session (local). Batch ~20 digests per call.
  Include 4–6 few-shot exemplars drawn from seed-review rows, stratified by area. Verify pass per
  `prompts/verify_v1.md` for first-pass High / score ≥ 70, one call per candidate.
  Headless-CLI facts (learned Phase 2 — do not regress):
  - **`--system-prompt` FULL REPLACE**, not `--append-system-prompt`: the rubric (classify) or
    verify prompt is the *entire* system prompt. Appending stacks it on Claude Code's ~34k-token
    default agent prompt; replacing cuts per-call overhead ~13× (cache_creation 34k→2.6k) — real
    rate-limit headroom across ~12 batches/day. These calls are pure text-in/JSON-out.
  - **`--tools ""`** disables all built-in tools; classify/verify need none, and structured
    output still works with tools off.
  - **`--json-schema` takes inline JSON *content*, not a path**, AND the CLI cannot resolve a
    draft-2020-12 `$schema` meta-ref — so strip top-level `$schema` (and cosmetic `title`) before
    passing. `run_structured` does both. The schema-conforming object comes back in the envelope's
    `structured_output` field (fallback: `json.loads(result)`).
- **Verify calibration (frozen story — `verify_version` v1.2; the prompt is FROZEN, changes go
  through a new version).** The adversarial pass is fed DETERMINISTIC evidence (`pipeline/evidence.py`):
  in-band engagement/velocity percentiles (≤7d/8–30d/31–90d/>90d), `related_mass_0p4` (TF-IDF
  neighbors at 0.4 — catches uniquely-worded issues the 0.6 duplicate clustering leaves singleton),
  last-activity recency, latest release tag+date (in `sync_state`, judged not guessed), and the seed
  review's prior. Getting here took three passes, DO NOT regress:
  - **v1.0 starved** — pure "default to refute" confirmed ~nothing, even a 722-react billing issue and
    seed-adjudicated Highs → empty `verified_high`.
  - **v1.1 overcorrected** — two-sided lanes with no veto confirmed 90%, incl. cosmetic issues on
    breadth alone.
  - **v1.2 = veto + credibility + uncertainty-confirms**: (1) a VETO lane — cosmetic/polish, viable
    workaround, or staleness-vs-current-release REFUTES regardless of engagement percentile; (2) a
    class-based-solo lane — data-loss/security/consent-fail-open/billing CONFIRMS even solo IFF the
    report clears a *deterministic-mechanism* credibility bar (concrete mechanism + repro/logs/version;
    intermittent-without-repro fails); (3) the class-solo boundary is LLM-nondeterministic, so by
    POLICY uncertainty there resolves to CONFIRM with `verify_basis='class-solo'` (a wrong confirm
    costs a PM 30s behind a "solo report" marker; a wrong refute buries silent data-loss). The
    empirical backstop — not pre-emptive censoring — is the Sunday QA monitor tracking how often
    class-solo confirms later close `not_planned`/`invalid`; if that precision decays, revisit the bar.
    `engagement_is_sparse` (reactions+comments < 10) gates the breadth percentile so fresh-band zeros
    don't read as breadth.
- **Idempotence is law**: every write is an upsert; the sync cursor advances only after a
  successful batch; any run can be safely re-run. A failed run must leave the DB consistent.
- **Determinism**: feature math takes an explicit `as_of` timestamp; no unseeded randomness.
- **Web**: Next.js App Router + TypeScript + Tailwind (tokens as CSS variables per
  `design/design-spec.md`) + TanStack Table/Query. Reads via `NEXT_PUBLIC_SUPABASE_*` anon key
  against `v_master`/`v_new_high`. Never import the service key into `web/`.
  - **Live refresh**: `web/lib/refresh.tsx` polls the newest `batches` row (id + status) every
    60s, plus on tab focus, and bumps a `version` counter when it changes. Every view takes
    `useDataVersion()` as an effect dependency, so a landing batch refreshes the whole app in
    place — an open tab is never stale. Add that dep to any new view that reads Supabase.
  - Layout rule learned the hard way: grid tracks are `minmax(0,1fr)` and nowrap flex children
    carry `min-width:0`. A bare `1fr` is `minmax(auto,1fr)`, so one long issue title pushes the
    whole page sideways (this is what sent Themes off-screen). Mobile is a real target: the
    sidebar becomes an off-canvas drawer under 900px.
- **Secrets**: only via env / GH secrets / Vercel env. Never in code, never in git.

## Commands

- Pipeline locally: `cp .env.example .env` (fill it) → `pip install -r pipeline/requirements.txt`
  → `python -m pipeline.sync` (or `backfill --mode census|seed-import|catchup|closed-history`,
  `nightly`). `closed-history` is a repair job: the census is `state=open`, so issues closed
  before the first delta sync never landed and the dashboard's closes line read flat for those
  days. It crawls `state=closed --since` (default 2026-07-11), upserts, and adds features only
  for rows that have none — always as singletons, since clustering's universe is the *open*
  backlog. It never touches `since_cursor`.
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
