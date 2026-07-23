# Claude Code Issue Tracker — Web App Build Plan (v1.0)

**Prepared:** 2026-07-23 · **Status:** decisions locked, ready to build
**Builds on:** `retrieval-plan.md` (Stage-1 deterministic pipeline), `issue-review-plan.md` (schema + rubric), `findings-summary.md` / `backlog-memo.md` (seed analysis: 1,000 adjudicated rows, 7 themes)

**Objective:** an internal web app for product managers and prod ops to manage, track, triage, and prioritize the live `anthropics/claude-code` issue backlog. Two core jobs: (1) at a regular batch cadence, surface **new high-priority issues** for review; (2) maintain a **master list of all active issues**, sortable and filterable across priority and every analytical dimension we already compute.

## 0. Decisions locked (2026-07-23)

| Decision | Choice | Notes |
|---|---|---|
| LLM runtime | **GitHub Actions + Claude Max OAuth token** | Fully cloud-hosted on GitHub's runners — nothing runs on Kevin's machine. Billed to the Max subscription via headless Claude Code. The only local step is a one-time `claude setup-token` to mint the token (valid ~1 year), pasted into a repo secret. Note: API "Managed Agents" were ruled out — they bill API-key usage only and cannot use a Max subscription. |
| Hosting | **Vercel (Hobby) + Supabase (free) + GH Actions** — $0/mo | Chosen for lowest friction from Claude Code: official `vercel` and `supabase` plugins exist in the Anthropic plugin marketplace. Railway (~$5–10/mo, one dashboard) is the fallback if Vercel's non-commercial Hobby clause becomes a concern; Vercel Pro ($20/mo) is the strict-compliance option. |
| Backfill depth | **Hybrid** | Day 1: import the finished 1,000-issue adjudicated log + deterministic scores for the full ~12k open census. First ~1–2 days of scheduled runs: LLM catch-up classification of the remaining "genuinely pending" eligible set (~1.5–2k issues). Everything else carries deterministic scores only. |
| Access | **Public read-only** | No login. Triage *writes* (status/assignee/notes) gated behind a single edit secret so the team can still maintain state. All displayed data is already-public GitHub data, so read exposure adds nothing sensitive. |

## 1. Architecture at a glance

```
                        ┌─────────────────────────────────────────────────┐
                        │  GitHub Actions (cloud runners, cron */2 hours) │
                        │                                                 │
  GitHub REST API ────► │  1. delta ingest (since=cursor, state=all)      │
  (anthropics/          │  2. deterministic features + scores             │
   claude-code)         │     (ported Stage-1 modules)                    │
                        │  3. LLM classify new/updated issues             │
                        │     headless `claude -p` ── Max OAuth token     │
                        │  4. verify pass on High candidates              │
                        │  5. upsert results + batch digest row ──────┐   │
                        └─────────────────────────────────────────────┼───┘
                                                                      ▼
                        ┌──────────────────────────────────────────────────┐
                        │  Supabase (free): Postgres + PostgREST + RLS     │
                        │  issues · features · analysis · triage · batches │
                        └──────────────┬───────────────────────▲───────────┘
                            anon key,  │ read-only RLS         │ service role,
                                       ▼                       │ edit-secret route
                        ┌──────────────────────────────────────┴───────────┐
                        │  Next.js app on Vercel (public read-only)        │
                        │  Dashboard · New & Notable · Master list ·       │
                        │  Issue detail · Themes · Batches/Ops             │
                        └──────────────────────────────────────────────────┘
```

Three properties carried over from Stage 1 by design: **auditability** (every score keeps its per-component decomposition all the way into the UI), **idempotence** (cursor-based delta sync + upserts make any run safely repeatable), and **determinism where possible** (LLM judgment is one blended input, never the only ranking signal).

## 2. Data model (Postgres / Supabase)

```sql
-- Raw issue state (delta-synced, open AND closed once seen)
issues (
  number BIGINT PRIMARY KEY,
  title TEXT NOT NULL,
  body_lead TEXT NOT NULL DEFAULT '',      -- cleaned, first 1,500 chars only (storage + clustering corpus)
  state TEXT NOT NULL,                     -- open | closed
  labels TEXT[] NOT NULL DEFAULT '{}',     -- lowercased
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  state_reason TEXT,                       -- completed | not_planned | duplicate | reopened (GitHub's own close reason)
  comments INT NOT NULL DEFAULT 0,
  reactions_total INT NOT NULL DEFAULT 0,
  reactions_plus1 INT NOT NULL DEFAULT 0,
  author_association TEXT,
  maintainer_authored BOOL NOT NULL DEFAULT FALSE,
  locked BOOL NOT NULL DEFAULT FALSE,
  active_lock_reason TEXT,
  html_url TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL
)

-- Deterministic layer (Stage-1 formulas, recomputed nightly since age terms drift)
features (
  number BIGINT PK REFERENCES issues,
  age_days REAL, f_reactions REAL, f_comments REAL, f_velocity REAL,
  f_severity REAL, f_demand REAL, rate_score REAL, retrieval_score REAL,
  is_junk BOOL, eligible BOOL,
  cluster_id BIGINT, cluster_size INT,
  run_id TEXT, computed_at TIMESTAMPTZ
)

-- LLM layer (versioned rubric; seed import + interval batches)
analysis (
  number BIGINT PK REFERENCES issues,
  type TEXT,                               -- Bug | Feature Request | Question/Support | Docs | Other/Meta
  area TEXT,                               -- the 18-area schema from issue-review-plan §5
  tags TEXT[],                             -- cross-cutting tags incl. regression, data-loss, non-cli …
  theme TEXT,                              -- one of the 7 themes | none
  priority TEXT,                           -- H | M | L
  priority_score REAL,                     -- 0–100 LLM-judged
  final_rank_score REAL,                   -- blended (see §4.3)
  summary TEXT, rationale TEXT, confidence REAL,
  duplicate_of BIGINT,
  verification_status TEXT, verification_evidence TEXT,
  source TEXT,                             -- seed-review | backfill | interval
  model TEXT, rubric_version TEXT, batch_id BIGINT, analyzed_at TIMESTAMPTZ,
  verified_high BOOL                       -- passed the adversarial second pass
)

-- Human layer (the only user-writable table)
triage (
  number BIGINT PK REFERENCES issues,
  status TEXT NOT NULL DEFAULT 'untriaged',-- untriaged|acknowledged|investigating|escalated|resolved|wontfix
  assignee TEXT, notes TEXT,
  updated_at TIMESTAMPTZ, updated_by TEXT
)

-- Batch bookkeeping (powers "new this batch" + ops page)
batches (
  id BIGSERIAL PK, kind TEXT,              -- interval | backfill | seed | recluster
  started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  issues_seen INT, new_count INT, updated_count INT, closed_count INT,
  classified_count INT, new_high_count INT,
  status TEXT, error TEXT, gha_run_url TEXT
)

sync_state (key TEXT PK, value TEXT)       -- since_cursor, rubric_version, schema_version
```

Views: `v_master` (issues ⋈ features ⋈ analysis ⋈ triage, with an `is_active` flag = open ∧ not lifecycle-labeled ∧ not junk — the same liveness definition Stage 1 inherited from the repo's own sweep) and `v_new_high` (verified-High or `final_rank_score ≥ threshold`, grouped by batch).

RLS: `anon` gets `SELECT` on everything above; all writes go through the `service_role` key, held only by GH Actions and one Vercel API route gated by the edit secret. Storage check: ~12k open + ~10k closes/month at ~2.5 KB/row ≈ **60–80 MB** — comfortably inside Supabase's 500 MB free tier. We deliberately store only `body_lead`; the detail view fetches the full live body client-side from the public GitHub API.

## 3. Ingestion: from one-shot census to continuous delta sync

The Stage-1 modules (`features.py` text prep + formulas, `cluster.py`, `score.py` weights/lanes) port over nearly unchanged — the pipeline's storage target moves from SQLite to Postgres, and `ingest.py` gains a delta mode.

**Delta sync (every run).** `GET /repos/anthropics/claude-code/issues?state=all&sort=updated&direction=asc&since=<cursor>&per_page=100` — catches new issues, edits, label changes, closes, and reopens in one stream. Cursor = the max `updated_at` fully processed, persisted in `sync_state` only after a successful upsert (crash-safe; reruns are idempotent). Skip `pull_request` rows. At ~322 new issues/day plus updates, a 2-hour window is typically 30–80 rows ≈ 1–2 pages: seconds of API time against a 5,000 req/hr PAT limit.

**Feature recompute.** Touched rows get features recomputed inline. A **nightly job** recomputes age-dependent terms (`age_days`, `f_velocity`, `rate_score`) for the whole active set and runs a **full re-cluster** (TF-IDF + union-find over ~12k stored `body_lead` docs — seconds of compute; interval runs give new issues a provisional nearest-cluster assignment in the meantime, so duplicate floods are visible within one batch, exact membership settles nightly).

**Lifecycle correctness — closed issues are tracked, not dropped.** The same delta stream that delivers new issues delivers closes and reopens (`state=all` + `since` keys on `updated_at`). On close we keep the row forever and record `closed_at` plus `state_reason` (completed / not-planned / duplicate — GitHub's own close reason), so the index holds the full lifecycle history of everything it has ever seen. The app exploits this five ways: (a) the master list defaults to Active but carries a **State filter — Active / Closed / All** — and closed rows stay fully queryable with their final scores, classifications, and a "fixed in vX" tag where known; (b) closes/day powers the intake-vs-closes trend honestly; (c) **triage interplay**: when an issue with a live triage state (investigating/escalated) closes upstream, the next batch flags it "resolved upstream — confirm" in New & Notable instead of silently clearing it; (d) verified-High issues that close get a resolved ribbon in the batch digest — the close-the-loop signal the backlog memo called for; (e) a v2 enrichment hook matches `completed` closes against changelog entries to attach the fixing release. Reopens simply flip `state` back and re-enter the classify queue as materially updated.

**One-time backfill (Phase 1).** Full-census crawl (~120 requests, minutes), features + scores for everything, then import the adjudicated 1,000-row log as `analysis` rows with `source='seed-review'` — its Type/Area/tags/H-M-L/summaries/verification fields map 1:1 to the schema above since the schema *is* the review's schema.

## 4. LLM classification & ranking (the precision upgrade)

Runs as headless Claude Code inside the Actions job: `claude -p` with `--output-format json` + a JSON schema, authenticated by `CLAUDE_CODE_OAUTH_TOKEN` — subscription-billed, officially supported by the claude-code-action mechanism. Sonnet by default.

**4.1 Input & batching.** Each unclassified/materially-updated issue becomes a compact digest (number, title, cleaned body lead ≤1,200 chars, labels, engagement, age, provisional cluster + 2 exemplar titles from that cluster). Issues are classified **15–25 per call** against the frozen rubric: the calibrated schema, tiebreak rules, and H/M/L criteria from `issue-review-plan.md` §5–6, embedded verbatim with `rubric_version` pinned, plus **few-shot exemplars drawn from the adjudicated seed log** (stratified across areas — the 1,000 reviewed rows are now training material, which is exactly the precision edge a v2 should get from v1).

**4.2 Two-pass verification for High.** Anything first-pass High (or `priority_score ≥ 70`) gets an independent adversarial second call — "confirm or downgrade, with evidence" — mirroring the classify-then-adjudicate pattern that held QA at 96–97% in the review. Only confirmed rows set `verified_high = true`, and only those trigger "new high-priority" surfacing. This is the direct answer to the ~25% High-inflation residual documented in the findings.

**4.3 Blended ranking.** LLM judgment never ranks alone:

```
final_rank_score = 0.45·norm(priority_score) + 0.25·norm(rate_score)
                 + 0.20·norm(f_severity) + 0.10·norm(log2(cluster_size))
```

All components stored per row (auditable in the issue-detail view, weights in config). Deterministic signals keep the list stable against LLM variance; the LLM keeps it smarter than metadata alone.

**4.4 Theme attachment & dedup.** The classifier assigns one of the 7 established themes (or `none`), and flags `duplicate_of` when the cluster exemplars make it obvious — feeding the master list's cluster-level view.

**4.5 Drift guardrail.** Weekly, 20 random recent classifications are blind re-classified; area agreement <85% or High-rate drifting outside the 15–25% band raises a flag on the Ops page (same guardrails the manual review used).

**Subscription-limit fit.** Interval load: ~27 new issues per 2-hour batch → 1–2 classify calls + occasional verify calls, ~12 times/day — trivial against Max 5-hour/weekly windows. Backfill catch-up: the pending set (~1.5–2k issues ≈ 80–130 batched calls) is throttled at ≤150 issues per scheduled run, clearing in ~1–2 days without ever spiking a single 5-hour window. If runs ever hit subscription rate limits, the job logs it, skips gracefully, and catches up next run (cursor semantics make this free); the escape hatch is an `ANTHROPIC_API_KEY` env toggle (Haiku, ~$5–15/mo) that we hope never to flip.

## 5. Scheduling (GitHub Actions)

| Workflow | Trigger | Work | Est. runtime |
|---|---|---|---|
| `sync.yml` | cron `17 */2 * * *` (12×/day; odd minute dodges top-of-hour queue delays) | delta ingest → features → classify → verify → upsert → batch row | ~3–4 min |
| `nightly.yml` | cron `47 8 * * *` (~4:47am ET) | age-term recompute, full re-cluster, weekly QA sample (Sundays) | ~5–8 min |
| `backfill.yml` | `workflow_dispatch` | census crawl, seed-log import, chunked catch-up classification | manual, chunked |

Guards: a `concurrency` group prevents overlapping runs (GHA cron can jitter by minutes — harmless here); all writes are upserts; a failed run leaves the cursor untouched and the next run absorbs the gap. Batch rows link to `gha_run_url` so the Ops page deep-links to logs.

**Minutes math:** 12 × 4 min × 30 days ≈ 1,440 + nightly ~200 ≈ **~1,650 min/mo**, inside the 2,000 free minutes for a private repo. If it runs tight, either drop to every 3 hours (~1,150) or make the repo public (unlimited minutes; secrets remain protected — fork PRs never see them).

**Secrets:** `SYNC_GITHUB_PAT` (public-repo read PAT; the default `GITHUB_TOKEN`'s 1,000 req/hr would also work, but the PAT gives 5× headroom) · `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · optional `SLACK_WEBHOOK_URL`.

## 6. Frontend (Next.js on Vercel)

Stack: Next.js App Router + TypeScript, Tailwind + shadcn/ui, TanStack Table/Query, Recharts. Reads Supabase directly with the anon key (RLS read-only). Built in Claude Code with its frontend-design tooling; charts follow the dataviz-skill system (consistent palette, light/dark). Ops-tool aesthetic: dense, fast, keyboard-friendly.

1. **Dashboard** — KPI tiles (active issues, new in 24h, verified-High open, last-sync health), 14-day intake/close trend, priority mix, theme heatmap, latest batch digest.
2. **New & Notable** — the batch review queue this app exists for: issues that entered verified-High / crossed the rank threshold, grouped by batch, newest first, with one-click acknowledge (moves triage → acknowledged). A "since you last looked" divider keyed off a local timestamp.
3. **Master list** — the full indexed set over `v_master`: sortable by final rank, LLM priority, retrieval score, reactions, velocity, age, cluster size; filterable by state (Active default / Closed / All), type, area, theme, priority, triage status, verification status, close reason, label, age bucket, maintainer-authored, junk-excluded; full-text search on title; CSV export. Cluster-collapse toggle (one row per duplicate cluster, expandable). Closed rows render dimmed with their close reason and fixing release inline.
4. **Issue detail** — LLM summary/rationale/confidence, full score decomposition (every `c_*` and blend component — Stage-1 auditability surfaced in UI), cluster members, state timeline, triage panel, live full body fetched from GitHub, deep link out.
5. **Themes** — the 7 themes with live counts, trend since the July snapshot, and top-ranked open issues per theme (continuity with the memo the team already has).
6. **Batches / Ops** — batch history (counts, durations, errors, GHA log links), QA agreement stats, current cursor, classifier rubric version.

**Write path:** an "Unlock editing" control accepts the edit secret → httpOnly cookie → `/api/triage` route verifies it server-side and writes via service role with `updated_by` set to a chosen display name. Everyone else is cleanly read-only.

## 7. Hosting & cost (1 month)

| Component | Tier | Cost | Notes / limits that matter |
|---|---|---|---|
| Supabase | Free | $0 | 500 MB DB (we use <100 MB); REST + RLS included; free projects pause after 7 idle days — our 2-hour writes make that impossible |
| Vercel | Hobby | $0 | Hobby cron is daily-only — irrelevant, GHA is the scheduler; nominal non-commercial clause → personal project OK; $20 Pro or Cloudflare swap if strictness wanted |
| GitHub Actions | Free | $0 | ~1,650/2,000 private minutes; public repo = unlimited |
| LLM analysis | Max subscription | $0 incremental | Headless Claude Code via 1-year OAuth token; interval load is far inside limits |
| GitHub data | PAT | $0 | 5,000 req/hr vs our ~few dozen per run |
| **Total** | | **$0/mo** (worst case $20 if Vercel Pro chosen) | Railway alternative: ~$5–10/mo all-in-one |

## 8. Build plan (Claude Code sessions)

| Phase | Scope | Exit criteria | Est. |
|---|---|---|---|
| 0. Scaffold | Repo (`/pipeline` py, `/web` next, `/.github/workflows`), Supabase project + schema migration, secrets set, `claude setup-token` minted, `vercel` + `supabase` plugins installed | `sync.yml` runs green end-to-end as a no-op | ~½ session |
| 1. Data layer | Port Stage-1 modules to Postgres, delta-sync mode, census backfill, seed-log import | Master data queryable; counts reconcile with live repo ±1% | ~1 session |
| 2. Classifier | Rubric prompt + JSON schema, few-shot from seed, verify pass, blend scoring, wire into `sync.yml`; start catch-up backfill | New live issues classified within one batch cycle; catch-up draining | ~1 session |
| 3. App core | Master list, dashboard, issue detail, deploy to Vercel | Public URL live against real data | ~1–1.5 sessions |
| 4. Workflow | New & Notable, themes, triage writes + edit secret, Batches/Ops, nightly job, polish, runbook README | A PM can run the full triage loop end-to-end | ~1 session |

Total: roughly **4–5 focused Claude Code sessions**. Kevin's one-time manual steps (~15 min): create the GitHub repo + PAT, Supabase and Vercel accounts, run `claude setup-token` locally, paste four secrets.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| OAuth-token-in-CI is supported but scheduled-cron usage isn't explicitly blessed in ToS | Cadence is modest and bursty-small; job degrades gracefully on rate-limit; API-key toggle exists as the compliant fallback. Revisit if Anthropic clarifies policy. |
| GHA cron jitter / skipped runs | Cursor-based delta = every run self-heals the gap; concurrency guard prevents overlap |
| Classifier drift vs the adjudicated seed | Pinned `rubric_version`, few-shot from seed, weekly blind QA sample with agreement floor, High-rate band alarm |
| High-priority inflation (known ~25% residual in v1) | Adversarial verify pass gates `verified_high`; only verified rows alert |
| Supabase free-tier pause or size | 2-hour writes prevent pause; `body_lead`-only storage keeps DB <100 MB |
| Vercel Hobby ToS strictness | Documented swap paths: Pro $20 or Cloudflare static ($0, commercial-friendly) |
| Repo automation changes (sweep labels, ~322/day intake shifts) | Liveness derives from labels dynamically; thresholds in config, not code |
| Public read-only exposure | Data is already public on GitHub; no secrets stored; writes gated server-side by secret |

## 10. Explicitly out of scope (v1)

Slack/email digest push (webhook stub left in place) · GitHub write-backs of any kind (the agentic-comms strategy is a separate, public-facing initiative — this app is internal-only) · multi-repo support (the Codex symmetric audit would reuse this pipeline wholesale) · real user accounts.
