# Deterministic retrieval layer — implementation spec

Adapted for the tracker from the Stage-1 spec (`retrieval-plan.md`, July 2026 issue review).
Same formulas, same text prep, same clustering, same eligibility logic — with these deltas:

| Stage 1 (review) | Tracker (this repo) |
|---|---|
| SQLite working layer | Postgres (Supabase) via `psycopg`, service-role DSN from env |
| One-shot `state=open` crawl | One-time census + continuous delta sync (`state=all&sort=updated&since=<cursor>`) |
| Top-1,000 lane selection | No selection — every issue gets features + `retrieval_score`; ranking is continuous |
| Diagnostics reports (M4) | Replaced by the QA guardrails in `config.yaml` and the Batches/Ops page |
| No LLM anywhere | Deterministic layer stays LLM-free; classification is a separate stage (`pipeline/sync.py`) |

Determinism still matters: given the same rows and config, features and scores must be
reproducible — no wall-clock reads inside feature math (pass a fixed `as_of` timestamp per batch),
no unseeded randomness (QA sampling seeds from batch id).

## Ingest

**Census (backfill mode).** `GET /repos/anthropics/claude-code/issues?state=open&per_page=100&page=N`,
headers `Authorization: Bearer $GITHUB_TOKEN`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Paginate until an empty page. **Skip any row containing a
`pull_request` key** (the endpoint interleaves PRs). ~120 requests for ~12k open issues.

**Delta (every sync).** `GET /repos/{repo}/issues?state=all&sort=updated&direction=asc&since=<cursor>&per_page=100`.
Catches new, edited, labeled, closed, reopened. Cursor = max fully-processed `updated_at`,
persisted to `sync_state.since_cursor` **only after a successful upsert** (crash-safe; reruns
idempotent). Capture `state_reason` on closes. Reopens flip `state` and re-enter the classify queue.

Rate limits: read `X-RateLimit-Remaining`/`Reset`; sleep before exhaustion. 403/429 → sleep 60s,
retry ≤5. 5xx → exponential backoff 5s→80s. Malformed/stub rows (transferred/deleted issues) →
skip and count.

Normalization: timestamps as UTC; null `body` → `''`; lowercase all label names;
`reactions_total` = `reactions.total_count`, `reactions_plus1` = `reactions["+1"]`;
`maintainer_authored` = `author_association ∈ {OWNER, MEMBER, COLLABORATOR}` (flag only — never
excludes). Store cleaned `body_lead` (below), not the full body.

## Text prep (shared by severity regex and clustering — unit-test it)

1. `title + "\n" + body`.
2. Remove fenced code blocks, HTML comments (issue-template boilerplate lives there), URLs,
   image markdown.
3. Remove template headers: `###` lines whose text ∈ {Environment, What happened, Steps to
   reproduce, Expected behavior, Preflight checklist, Version, Platform}.
4. Collapse whitespace; truncate body part to `body_lead_chars` (1500) → `clean_text` / `body_lead`.
5. Clustering document: `title + " " + title + " " + body_lead` (title doubled to up-weight it).

## Features (exact formulas; `age_days = max(1.0, (as_of − created_at)/86400)`)

- `f_reactions = log2(1 + reactions_total)`
- `f_comments  = log2(1 + comments)`
- `f_velocity  = log2(1 + 30·(reactions_total + comments)/age_days)`
- `f_severity  = min(cap, Σ label_weights[matched labels] + regex_bonus·(regex matches))` —
  regex case-insensitive over `title + " " + body_lead`, bonus added **at most once**; weights in
  `config.yaml`.
- `f_demand    = log2(reactions_total)` if any demand label AND `reactions_total ≥ min_reactions`, else 0.
- `rate_score  = 3·log2(1 + 30·reactions_total/age_days) + 1·log2(1 + 30·comments/age_days)
  + 2·f_severity + 2·log2(cluster_size or 1)` — the age-corrected momentum score.
- `retrieval_score = w.reactions·f_reactions + w.comments·f_comments + w.velocity·f_velocity
  + w.severity·f_severity + w.demand·f_demand + w.cluster·log2(cluster_size or 1)`.
- `is_junk = 1` iff ALL: `len(clean_body) ≤ 40` AND `reactions_total = 0` AND `comments = 0`
  AND `age_days ≥ 7` (abandoned template noise).

Age-dependent terms (`age_days`, `f_velocity`, `rate_score`) drift daily → the nightly job
recomputes them for all open issues. Interval syncs recompute only touched rows.

## Eligibility (mirrors the repo's own lifecycle policy)

`eligible = state='open' AND no label ∈ {duplicate, invalid, stale, autoclose, question}
AND active_lock_reason ∉ {spam, resolved} AND NOT is_junk` — with the **stale-rescue**: if the
only excluding label is `stale` and `reactions_total ≥ 10`, the issue stays eligible (mirrors the
repo sweep's own upvote exemption). The repo runs a continuous lifecycle sweep (stale at 14d
inactivity unless ≥10 👍, autoclose 14d later; invalid 3d; needs-repro/needs-info 7d; duplicates
3d) — "open and not lifecycle-labeled" is the maintainers' own definition of a live issue, so the
tracker imposes no calendar window. `v_master.is_active` derives from this flag.

## Duplicate clustering

Over **all open issues** (ineligible rows still credit their clusters):
`TfidfVectorizer(ngram_range=(1,2), min_df=2, max_df=0.5, stop_words='english', lowercase=True)`
on the clustering documents → chunked pairwise cosine (1,000-row blocks, ≤2 GB RAM) → pairs
≥ 0.6 → union-find connected components → `cluster_id`, `cluster_size` (singletons included).
~12k docs clusters in seconds.

Nightly: full re-cluster (cluster ids may shift — they are not stable identifiers; treat as
current-state grouping). Interval syncs: provisional assignment — vectorize the new/changed docs
against the existing vocabulary, attach to the nearest cluster over threshold, else singleton;
exact membership settles nightly.

## Context (facts as of 2026-07-22, ±10% sanity bands)

Open ≈ 12k; intake ≈ 322/day; ~96 labels; the triage bot labels with ~1-day lag (fresh issues
are label-sparse — the regex severity path and velocity term compensate); 1,274 open issues have
>10 reactions; engagement skews hard with age (median reactions 0 at ≤30d, 19 at >90d) — which is
why ranking blends rates and severity, never raw engagement alone.

## Edge cases (all must be handled)

Null/non-UTF8 body → `''` / `errors="replace"` · zero-age issues → age floor 1.0 · labels with
spaces/colons (`has repro`, `area:security`) → lowercase exact match · 404 stubs mid-pagination →
skip + count · pagination ends on empty page (not Link header) · missing reactions object → zeros ·
duplicate numbers across pages (state changed mid-crawl) → last write wins via upsert · a cluster
whose best member is ineligible → ineligible members still count in `cluster_size`.
