"""One-time backfill entrypoints.

  python -m pipeline.backfill --mode census       # full open-issue crawl → issues + features + clusters + scores
  python -m pipeline.backfill --mode seed-import   # data/seed CSV → analysis rows (source='seed-review')
  python -m pipeline.backfill --mode catchup       # (Phase 2) LLM catch-up classification

Idempotence is law: every write is an upsert, so any mode can be safely re-run. A census
re-run changes no data (only bookkeeping timestamps); seed-import re-run is a no-op on the
analysis rows.
"""

from __future__ import annotations

import argparse
import csv
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import cluster as clust
from . import db
from . import features as feat
from . import ingest

SEED_CSV = db.REPO_ROOT / "data" / "seed" / "claude_code_issue_log.csv"

# Columns the issues upsert overwrites on conflict (first_seen_at is insert-only).
_ISSUE_UPDATE_COLS = [
    "title", "body_lead", "state", "state_reason", "labels", "created_at",
    "updated_at", "closed_at", "comments", "reactions_total", "reactions_plus1",
    "author_association", "maintainer_authored", "locked", "active_lock_reason",
    "html_url", "last_seen_at",
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# census
# ---------------------------------------------------------------------------

def run_census(gha_run_url: str | None = None) -> dict[str, int]:
    """Full census: crawl open issues → upsert issues → recluster → features + scores."""
    cfg = db.load_config()
    as_of = _now()
    stats = ingest.IngestStats()

    print(f"[census] crawling open issues for {cfg['repo']} …")
    issues = list(ingest.crawl_census(cfg, as_of, stats=stats))
    print(f"[census] {stats.issues} issues over {stats.pages} pages "
          f"({stats.prs_skipped} PRs, {stats.stubs_skipped} stubs skipped)")

    print("[census] clustering …")
    numbers = [i["number"] for i in issues]
    docs = [feat.cluster_document(i["title"], i["body_lead"]) for i in issues]
    clusters = clust.recluster(numbers, docs, cfg)

    with db.connect() as conn:
        batch_id = db.start_batch(conn, "backfill", gha_run_url)
        run_id = f"batch-{batch_id}"

        db.upsert(conn, "issues", issues, update_cols=_ISSUE_UPDATE_COLS)

        feature_rows = []
        for issue in issues:
            cid, size = clusters.get(issue["number"], (issue["number"], 1))
            row = feat.compute_features(issue, size, as_of, cfg)
            row["cluster_id"] = cid
            row["run_id"] = run_id
            row["computed_at"] = as_of
            feature_rows.append(row)
        db.upsert(conn, "features", feature_rows)

        eligible = sum(1 for r in feature_rows if r["eligible"])
        db.finish_batch(conn, batch_id, status="ok",
                        issues_seen=stats.seen, new_count=stats.issues)

    print(f"[census] done: {len(issues)} issues, {eligible} eligible, "
          f"{len(set(c for c, _ in clusters.values()))} clusters. batch {batch_id}.")
    return {"issues": len(issues), "eligible": eligible, "batch_id": batch_id}


# ---------------------------------------------------------------------------
# seed-import
# ---------------------------------------------------------------------------

_PRIORITY_MAP = {"high": "H", "medium": "M", "low": "L", "h": "H", "m": "M", "l": "L"}
# Letter confidence grade → numeric (transparent monotonic encoding of the review's H/M/L conf).
_CONF_MAP = {"h": 0.9, "m": 0.7, "l": 0.5}


def _split_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t.strip() for t in raw.split(";") if t.strip()]


def _seed_row_to_analysis(row: dict[str, str]) -> dict[str, Any] | None:
    """Map one CSV row to an `analysis` dict, or None if it lacks an issue number."""
    num_raw = (row.get("issue #") or "").strip()
    if not num_raw:
        return None
    priority = _PRIORITY_MAP.get((row.get("priority") or "").strip().lower())
    conf = _CONF_MAP.get((row.get("conf") or "").strip().lower())
    return {
        "number": int(num_raw),
        "type": (row.get("type") or "").strip() or None,
        "area": (row.get("area") or "").strip() or None,
        "tags": _split_tags(row.get("tags")),
        "theme": None,  # the seed log predates the 7-theme attachment; left for the classifier
        "priority": priority,
        "priority_score": None,   # no 0–100 LLM score in the seed; blend happens in Phase 2
        "final_rank_score": None,
        "summary": (row.get("summary") or "").strip() or None,
        "rationale": (row.get("impact rationale") or "").strip() or None,
        "confidence": conf,
        "duplicate_of": None,
        "verification_status": (row.get("verification status") or "").strip() or None,
        "verification_evidence": (row.get("verification evidence") or "").strip() or None,
        "verified_high": priority == "H",  # seed rows are adjudicated ground truth
        "source": "seed-review",
        "model": None,
        "rubric_version": "v2.0",
        "batch_id": None,
    }


def run_seed_import(csv_path: Path = SEED_CSV) -> dict[str, int]:
    """Map the adjudicated review log into `analysis` rows (source='seed-review')."""
    if not csv_path.exists():
        raise FileNotFoundError(
            f"Seed CSV not found at {csv_path}. Drop claude_code_issue_log.csv in "
            "data/seed/ (see data/seed/README.md). Nothing else breaks without it — "
            "the Phase 2 catchup stage classifies those issues fresh."
        )

    with csv_path.open(newline="", encoding="utf-8", errors="replace") as fh:
        rows = [r for r in (_seed_row_to_analysis(row) for row in csv.DictReader(fh)) if r]
    print(f"[seed-import] parsed {len(rows)} rows from {csv_path.name}")

    with db.connect() as conn:
        batch_id = db.start_batch(conn, "seed")
        # analysis FKs issues(number); import only rows whose issue we've already ingested.
        with conn.cursor() as cur:
            cur.execute("select number from issues")
            known = {r["number"] for r in cur.fetchall()}
        importable = [r for r in rows if r["number"] in known]
        skipped = len(rows) - len(importable)
        db.upsert(conn, "analysis", importable)
        db.finish_batch(conn, batch_id, status="ok",
                        classified_count=len(importable), issues_seen=len(rows))

    print(f"[seed-import] imported {len(importable)} analysis rows "
          f"({skipped} skipped — issue not in census, likely closed since the review). "
          f"batch {batch_id}.")
    return {"imported": len(importable), "skipped": skipped, "batch_id": batch_id}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(prog="pipeline.backfill")
    ap.add_argument("--mode", required=True, choices=["census", "seed-import", "catchup"])
    args = ap.parse_args()

    gha = os.environ.get("GHA_RUN_URL")
    if args.mode == "census":
        run_census(gha_run_url=gha)
    elif args.mode == "seed-import":
        run_seed_import()
    elif args.mode == "catchup":
        raise SystemExit("catchup is Phase 2 (LLM classification). Not yet implemented.")


if __name__ == "__main__":
    main()
