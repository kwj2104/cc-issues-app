"""Nightly maintenance — age-term recompute, full re-cluster, Sunday QA sample.

Age-dependent terms (age_days, f_velocity, rate_score, and thus retrieval_score) drift
daily, so every night we recompute the full feature set for the open backlog against a
fresh `as_of`, using a full TF-IDF + union-find re-cluster (interval syncs only assign new
rows provisionally — exact membership settles here). On Sundays we also blind-re-classify a
deterministic 20-row sample and record area-agreement + High-share into sync_state; the Ops
page raises a flag when agreement < floor or High-share leaves the band.

Determinism: one fixed `as_of` per run; the QA sample is seeded from the batch id.
"""

from __future__ import annotations

import os
import random
from datetime import datetime, timezone
from typing import Any

from . import classify, cluster as clust, db, features as feat, ingest

_OPEN_COLS = ("number", "title", "body_lead", "labels", "state", "created_at",
              "comments", "reactions_total", "active_lock_reason")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _recompute_open_features(conn, cfg: dict[str, Any], as_of: datetime, run_id: str) -> int:
    """Full re-cluster + feature recompute for every open issue."""
    with conn.cursor() as cur:
        cur.execute(f"select {', '.join(_OPEN_COLS)} from issues where state = 'open'")
        issues = [dict(r) for r in cur.fetchall()]
    if not issues:
        return 0

    numbers = [i["number"] for i in issues]
    docs = [feat.cluster_document(i["title"], i["body_lead"]) for i in issues]
    clusters = clust.recluster(numbers, docs, cfg)

    rows = []
    for issue in issues:
        cid, size = clusters.get(issue["number"], (issue["number"], 1))
        row = feat.compute_features(issue, size, as_of, cfg)
        row["cluster_id"] = cid
        row["run_id"] = run_id
        row["computed_at"] = as_of
        rows.append(row)
    db.upsert(conn, "features", rows)
    return len(rows)


def _run_qa_sample(conn, cfg: dict[str, Any], batch_id: int) -> dict[str, float] | None:
    """Blind re-classify a deterministic sample; return area-agreement + High-share."""
    qa = cfg["qa"]
    with conn.cursor() as cur:
        cur.execute(
            """select number, area, priority from analysis
               where source in ('interval', 'backfill') and area is not null
               order by analyzed_at desc limit 200"""
        )
        recent = [dict(r) for r in cur.fetchall()]
    if len(recent) < qa["weekly_sample"]:
        return None

    rng = random.Random(batch_id)  # seeded from batch id — reproducible
    sample = rng.sample(recent, qa["weekly_sample"])
    stored = {r["number"]: r for r in sample}
    nums = list(stored)

    digests = classify.digests_for(conn, nums)
    reclassified, _ = classify.classify_batch(digests, cfg)
    newmap = {c["number"]: c for c in reclassified}
    if not newmap:
        return None

    checked = [n for n in nums if n in newmap]
    area_agreement = sum(1 for n in checked if newmap[n]["area"] == stored[n]["area"]) / len(checked)
    high_share = sum(1 for n in checked if newmap[n]["priority"] == "H") / len(checked)
    return {"area_agreement": round(area_agreement, 3), "high_share": round(high_share, 3),
            "n": len(checked)}


def run_nightly(gha_run_url: str | None = None) -> dict[str, Any]:
    cfg = db.load_config()
    as_of = _now()

    try:
        rel = ingest.fetch_latest_release(cfg)
    except Exception:
        rel = None

    with db.connect() as conn:
        batch_id = db.start_batch(conn, "recluster", gha_run_url)
        run_id = f"batch-{batch_id}"
        if rel:
            db.set_state(conn, "latest_release_tag", rel.get("tag") or "")
            db.set_state(conn, "latest_release_date", rel.get("date") or "")

        n_features = _recompute_open_features(conn, cfg, as_of, run_id)
        print(f"[nightly] recomputed features + reclustered {n_features} open issues")

        status = "ok"
        qa = None
        if as_of.weekday() == 6:  # Sunday
            print("[nightly] Sunday — running blind QA sample …")
            qa = _run_qa_sample(conn, cfg, batch_id)
            if qa:
                db.set_state(conn, "qa_area_agreement", str(qa["area_agreement"]))
                db.set_state(conn, "qa_high_share", str(qa["high_share"]))
                db.set_state(conn, "qa_sample_at", as_of.isoformat())
                lo, hi = cfg["qa"]["high_share_band"]
                breached = (qa["area_agreement"] < cfg["qa"]["area_agreement_floor"]
                            or not (lo <= qa["high_share"] <= hi))
                status = "warn" if breached else "ok"
                print(f"[nightly] QA: area_agreement={qa['area_agreement']} "
                      f"high_share={qa['high_share']} (n={qa['n']}) → {status}")

        db.finish_batch(conn, batch_id, status=status, issues_seen=n_features)

    print(f"[nightly] done. batch {batch_id} ({status}).")
    return {"batch_id": batch_id, "features": n_features, "qa": qa, "status": status}


def main() -> None:
    run_nightly(gha_run_url=os.environ.get("GHA_RUN_URL"))


if __name__ == "__main__":
    main()
