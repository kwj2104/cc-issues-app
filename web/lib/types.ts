// Row shapes from the Supabase views/tables the app reads.

export type Priority = "H" | "M" | "L" | null;

export interface VMaster {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[] | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  reactions_total: number;
  reactions_plus1: number | null;
  maintainer_authored: boolean;
  html_url: string;
  age_days: number | null;
  rate_score: number | null;
  retrieval_score: number | null;
  cluster_id: number | null;
  cluster_size: number | null;
  is_junk: boolean | null;
  eligible: boolean | null;
  f_severity: number | null;
  f_velocity: number | null;
  f_reactions: number | null;
  f_comments: number | null;
  f_demand: number | null;
  type: string | null;
  area: string | null;
  tags: string[] | null;
  theme: string | null;
  priority: Priority;
  priority_score: number | null;
  final_rank_score: number | null;
  summary: string | null;
  rationale: string | null;
  confidence: number | null;
  verified_high: boolean;
  verify_basis: string | null;
  verification_status: string | null;
  analysis_source: string | null;
  model: string | null;
  rubric_version: string | null;
  batch_id: number | null;
  triage_status: string | null;
  assignee: string | null;
  triage_notes: string | null;
  triaged_by: string | null;
  is_active: boolean;
  /** H=1, M=2, L=3, unclassified=4 — sortable priority (see db/schema.sql v1.3). */
  priority_rank: number;
}

export interface Batch {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  issues_seen: number;
  new_count: number;
  updated_count: number;
  closed_count: number;
  classified_count: number;
  new_high_count: number;
  status: string;
  error: string | null;
  gha_run_url: string | null;
}

// The 7 established themes (slug → display name), matching the classifier's theme enum.
export const THEME_NAMES: Record<string, string> = {
  "work-session-integrity": "Work & session integrity",
  "consent-enforcement": "Consent & enforcement",
  "safety-filter-precision": "Safety-filter precision",
  "change-velocity-rollout": "Change velocity & rollout",
  "surface-sprawl": "Surface sprawl",
  "money-correctness": "Money correctness",
  "delegation-frontier": "Delegation frontier",
};
