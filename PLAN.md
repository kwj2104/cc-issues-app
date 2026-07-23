# PLAN.md — phased build

Work phase by phase. A phase is done only when every acceptance criterion passes. Mark
checkboxes as you go; commit per completed task with a message referencing the phase.
Context: `CLAUDE.md` first, then `docs/`, then `design/` for Phase 3+.

## Phase 0 — Setup (human + scaffold) ✅ mostly done by kit

- [x] Kevin: accounts, secrets, schema applied (see `README.md` — ~30 min, one-time)
- [x] Repo scaffold, schema, workflows, prompts, config, design assets (this kit)
- [x] Sanity: `workflow_dispatch` proven — sync/backfill/nightly all run green on live data

## Phase 1 — Data layer (pipeline foundation)

Implement per `docs/retrieval-spec.md`, storing to Supabase (`db.py` owns the DSN + upsert
helpers; `psycopg` with `execute_values`-style batching).

- [x] `pipeline/db.py` — connection from env, upsert helpers, `sync_state` get/set
- [x] `pipeline/ingest.py` — census crawl + delta sync (cursor semantics, PR-skip, rate-limit
      handling, `state_reason` capture)
- [x] `pipeline/features.py` — text prep + all feature formulas (exact spec math)
- [x] `pipeline/cluster.py` — TF-IDF + union-find full recluster; provisional nearest-cluster assign
- [x] `pipeline/backfill.py --mode census` — full crawl → issues + features + clusters + scores
- [x] `pipeline/backfill.py --mode seed-import` — map `data/seed/claude_code_issue_log.csv` →
      `analysis` rows (`source='seed-review'`)
- [x] `pipeline/tests/` — text prep fixtures, formula hand-checks, stale-rescue boundary (9 vs 10),
      junk filter, cursor advance-only-on-success

**Acceptance:** census run completes against the live repo; row count within ±1% of the
search-API `total_count`; `select count(*) from issues` ≈ 12k; features/scores populated for all;
seed import lands ~1,000 `analysis` rows; a second census run changes nothing (idempotent);
`pytest` green.

## Phase 2 — Classifier + scheduled sync

- [x] `pipeline/classify.py` — digest builder (number, title, body_lead ≤1200, labels, engagement,
      age, cluster + 2 exemplar titles) → batches of ~20 → headless `claude -p` with
      `prompts/rubric_v2.md` + `output_schema.json` → parse/validate
- [ ] Few-shot exemplars: 4–6 seed-review rows stratified by area, embedded in the prompt
      — DEFERRED: v1.2 calibration validated rubric-only; add as a precision pass later (would
      change classify behavior, so re-run the verify acceptance after)
- [x] Verify pass (`prompts/verify_v1.2.md`) for first-pass H / score ≥ 70 → `verified_high`
      (v1.0 starved → v1.1 overcorrected → v1.2 veto + class-solo credibility; `verify_basis` stored)
- [x] Blended `final_rank_score` per `config.blend` (normalize components; store all)
- [x] `pipeline/sync.py` — orchestrate: delta → features → classify changed/new → verify → upsert →
      `batches` row (counts, `GHA_RUN_URL`, status), incl. triage interplay
      (open triage + issue closed upstream → status `resolved-upstream-confirm`)
- [x] `pipeline/backfill.py --mode catchup` — classify pending eligible set, ≤ `catchup_per_run`
      (retrieval_score-desc order; scheduled 6×/day to auto-drain)
- [x] `pipeline/nightly.py` — age-term recompute, full recluster, Sunday QA sample → results into
      `sync_state` (`qa_area_agreement`, `qa_high_share`) — QA path first fires this Sunday

**Acceptance:** a `workflow_dispatch` sync run on live data completes green in <8 min; new issues
since the cursor appear in `analysis` with sane classifications; a verified-High requires two
model passes (check batch logs); re-running the same sync is a no-op; catchup drains ≥150/run.

## Phase 3 — Web app core

Port `design/mockup.html` faithfully (open it in a browser first; `design/design-spec.md` has the
tokens). Next.js App Router in `web/`, Supabase anon reads against `v_master` / `v_new_high`.

- [ ] Design system: CSS variables (light/dark per spec), serif/sans stacks, sidebar shell,
      topbar with live "last sync" from `batches`
- [ ] Master list: server-driven filters (state Active/Closed/All, type, area, theme, priority,
      triage), sortable columns, score bars, compact pills, dimmed closed rows with close-reason
      tags, pagination past the demo-slice size
- [ ] Issue drawer: summary/rationale/confidence, score decomposition, signals grid, cluster
      members, live body fetch from GitHub API, close info
- [ ] Dashboard: KPI tiles (live queries), intake-vs-closes line (last 14d from `issues`
      created/closed dates), priority mix, theme bars, latest batches
- [ ] Deploy to Vercel (root dir `web`, env vars set)

**Acceptance:** public URL renders live data in both modes; filters/sorts hit the DB (not
client-side slices); closed filter shows closed issues with reasons; drawer matches mockup;
Lighthouse a11y ≥ 90.

## Phase 4 — Workflow features

- [ ] New & Notable: batch-grouped verified-High + "resolved upstream — confirm" flags +
      acknowledge action; closed verified-High get the resolved ribbon
- [ ] Triage writes: `/api/triage` route validating `EDIT_SECRET` (httpOnly cookie via an unlock
      endpoint), service-role write, `updated_by` attribution; UI lock/unlock states per mockup
- [ ] Themes view (7 cards, live counts + top issues) and Batches & Ops (QA meters from
      `sync_state`, run history with GHA log links, pipeline config panel)
- [ ] CSV export of the current master-list filter set

**Acceptance:** the full PM loop works end-to-end on the deployed app: see a new verified-High →
open drawer → acknowledge → status persists (and survives refresh); wrong edit key cleanly refused.

## Phase 5 — Hardening & polish

- [ ] QA drift surfacing: Ops page warns when area agreement < 0.85 or High share leaves 15–25%
- [ ] Empty/error states, loading (hold-previous-render, no skeleton flash), keyboard nav in tables
- [ ] README ops runbook section: how to pause the cron, rotate tokens, re-run backfill, restore
      after a missed day (answer: nothing — cursor self-heals)
- [ ] Optional: Slack webhook on `new_high_count > 0` (stub exists in config)

**Acceptance:** a cold-start reader can operate the system from README alone; a full simulated
day (12 syncs + nightly) stays green and under GHA free minutes budget.
