-- Claude Code Issue Tracker — Supabase schema (v1.3)
-- Migrations: v1.3 (2026-07-24) adds v_master.priority_rank (H=1, M=2, L=3, unclassified=4) so the
--   web master list can sort High→Medium→Low. PostgREST can only order by a column, and ordering on
--   the letter itself reads H, L, M; priority_score is a 0-100 LLM score, so sorting by it
--   interleaves a high-scoring Medium above a low-scoring High. View-only change — re-run this file
--   (or just the v_master/v_new_high `create or replace view` block) to apply; no data migration.
-- Migrations: v1.2 (2026-07-23) adds analysis.verify_basis ('corroborated'|'class-solo'|null),
--   distinguishing verify confirms backed by breadth/corroboration from solo class-based confirms,
--   plus verify_{reactions,cluster_size,band_decile} — the evidence snapshot at verify time that the
--   re-verify triggers compare against (cluster grows ≥2×, reactions cross the next band decile, …).
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → paste → Run).
-- Writes happen only via the service_role key (GitHub Actions + the edit-secret API route);
-- the anon key gets read-only access through RLS policies below.

-- ============ tables ============

create table if not exists issues (
  number            bigint primary key,
  title             text not null,
  body_lead         text not null default '',        -- cleaned, first 1500 chars (storage + clustering corpus)
  state             text not null check (state in ('open','closed')),
  state_reason      text,                            -- completed | not_planned | duplicate | reopened (GitHub's close reason)
  labels            text[] not null default '{}',    -- lowercased
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  closed_at         timestamptz,
  comments          int not null default 0,
  reactions_total   int not null default 0,
  reactions_plus1   int not null default 0,
  author_association text,
  maintainer_authored boolean not null default false,
  locked            boolean not null default false,
  active_lock_reason text,
  html_url          text not null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);
create index if not exists idx_issues_state on issues(state);
create index if not exists idx_issues_updated on issues(updated_at desc);
create index if not exists idx_issues_labels on issues using gin(labels);

create table if not exists features (
  number          bigint primary key references issues(number) on delete cascade,
  age_days        real not null,
  f_reactions     real not null default 0,
  f_comments      real not null default 0,
  f_velocity      real not null default 0,
  f_severity      real not null default 0,
  f_demand        real not null default 0,
  rate_score      real not null default 0,
  retrieval_score real not null default 0,
  is_junk         boolean not null default false,
  eligible        boolean not null default true,     -- encodes lifecycle-label exclusions incl. stale-rescue (spec §7)
  cluster_id      bigint,
  cluster_size    int not null default 1,
  run_id          text,
  computed_at     timestamptz not null default now()
);
create index if not exists idx_features_score on features(retrieval_score desc);
create index if not exists idx_features_cluster on features(cluster_id);

create table if not exists analysis (
  number          bigint primary key references issues(number) on delete cascade,
  type            text,          -- Bug | Feature Request | Question/Support | Docs | Other/Meta
  area            text,          -- 18-area taxonomy (pipeline/prompts/rubric_v2.md)
  tags            text[] not null default '{}',
  theme           text,          -- 7 themes | none
  priority        text check (priority in ('H','M','L')),
  priority_score  real,          -- 0–100, LLM-judged
  final_rank_score real,         -- blended (0.45/0.25/0.20/0.10 — config.yaml)
  summary         text,
  rationale       text,
  confidence      real,
  duplicate_of    bigint,
  verification_status text,      -- confirmed-active | likely-active | ... (seed import carries the review's values)
  verification_evidence text,
  verified_high   boolean not null default false,    -- passed the adversarial second pass
  verify_basis    text,                               -- corroborated | class-solo | null (verify_v1.2+)
  verify_reactions   int,                             -- evidence snapshot at verify time (re-verify triggers)
  verify_cluster_size int,
  verify_band_decile  int,
  source          text not null default 'interval',  -- seed-review | backfill | interval
  model           text,
  rubric_version  text,
  batch_id        bigint,
  analyzed_at     timestamptz not null default now()
);
create index if not exists idx_analysis_priority on analysis(priority);
create index if not exists idx_analysis_rank on analysis(final_rank_score desc);
create index if not exists idx_analysis_theme on analysis(theme);

create table if not exists triage (
  number      bigint primary key references issues(number) on delete cascade,
  status      text not null default 'untriaged'
              check (status in ('untriaged','acknowledged','investigating','escalated','resolved','wontfix','resolved-upstream-confirm')),
  assignee    text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create table if not exists batches (
  id            bigserial primary key,
  kind          text not null default 'interval',    -- interval | backfill | seed | recluster
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  issues_seen   int not null default 0,
  new_count     int not null default 0,
  updated_count int not null default 0,
  closed_count  int not null default 0,
  classified_count int not null default 0,
  new_high_count int not null default 0,
  status        text not null default 'running',     -- running | ok | warn | error
  error         text,
  gha_run_url   text
);
create index if not exists idx_batches_started on batches(started_at desc);

create table if not exists sync_state (
  key   text primary key,
  value text not null
);
-- seeded keys: since_cursor, rubric_version, schema_version
insert into sync_state(key,value) values ('schema_version','1.2'), ('rubric_version','v2.0')
  on conflict (key) do nothing;

-- ============ views ============

create or replace view v_master with (security_invoker = on) as
select
  i.number, i.title, i.state, i.state_reason, i.labels, i.created_at, i.updated_at, i.closed_at,
  i.comments, i.reactions_total, i.reactions_plus1, i.maintainer_authored, i.html_url,
  f.age_days, f.rate_score, f.retrieval_score, f.cluster_id, f.cluster_size, f.is_junk, f.eligible,
  f.f_severity, f.f_velocity, f.f_reactions, f.f_comments, f.f_demand,
  a.type, a.area, a.tags, a.theme, a.priority, a.priority_score, a.final_rank_score,
  a.summary, a.rationale, a.confidence, a.verified_high, a.verify_basis,
  a.verification_status, a.source as analysis_source, a.model, a.rubric_version, a.batch_id,
  t.status as triage_status, t.assignee, t.notes as triage_notes, t.updated_by as triaged_by,
  (i.state = 'open' and coalesce(f.eligible, true)) as is_active,
  -- Sortable priority: ascending gives High → Medium → Low → unclassified.
  case a.priority when 'H' then 1 when 'M' then 2 when 'L' then 3 else 4 end as priority_rank
from issues i
left join features f using (number)
left join analysis a using (number)
left join triage  t using (number);

create or replace view v_new_high with (security_invoker = on) as
select m.*, b.started_at as batch_started_at
from v_master m
join batches b on b.id = m.batch_id
where m.verified_high and m.state = 'open'
order by b.started_at desc, m.final_rank_score desc;

-- ============ RLS: public read, service-role write ============

alter table issues     enable row level security;
alter table features   enable row level security;
alter table analysis   enable row level security;
alter table triage     enable row level security;
alter table batches    enable row level security;
alter table sync_state enable row level security;

create policy "public read" on issues     for select using (true);
create policy "public read" on features   for select using (true);
create policy "public read" on analysis   for select using (true);
create policy "public read" on triage     for select using (true);
create policy "public read" on batches    for select using (true);
create policy "public read" on sync_state for select using (true);
-- No insert/update/delete policies: anon cannot write. service_role bypasses RLS by design.
