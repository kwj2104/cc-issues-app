# Seed data

Drop the adjudicated review log here before running the `seed-import` backfill stage:

- `claude_code_issue_log.csv` — the 1,000-row log from the July 2026 issue review
  (columns: issue #, title, type, area, tags, priority, summary, verification_status,
  verification_method/evidence, impact rating, …).

`python -m pipeline.backfill --mode seed-import` maps it into the `analysis` table with
`source='seed-review'`, `rubric_version='v2.0'` — those 1,000 rows arrive pre-classified
and also serve as few-shot exemplars for the live classifier.

If the CSV ever goes missing, nothing breaks: the `catchup` stage will classify those issues
fresh like any others (at the cost of extra classify calls). CSVs here are gitignored.
