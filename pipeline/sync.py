"""Interval sync orchestrator (GitHub Actions, every 2h).

delta ingest → upsert issues → provisional cluster + features (touched rows) → classify
new/materially-updated → adversarial verify on H/≥70 → blend final_rank_score → upsert
analysis → triage interplay → batch row. Cursor advances only after a successful upsert, so
any run is safely re-runnable and a failed run leaves the cursor untouched (the next run
absorbs the gap).

Re-verify triggers: a refuted-High is re-queued when its evidence materially changes —
cluster grows ≥2× or reactions cross the next age-band decile since the verify snapshot. (A
maintainer relabel bumps the issue's updated_at, so it re-enters via the ordinary
"updated since last analyzed" rule.)
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from . import blend, classify, cluster as clust, db, evidence, features as feat, ingest, verify

# Triage states that mean a human is actively working the issue — a silent upstream close
# should flag for confirmation, not vanish.
_ACTIVE_TRIAGE = ("investigating", "escalated")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _initial_cursor(conn) -> str:
    """Delta cursor: stored value, else the census baseline (max updated_at), else epoch."""
    cur = db.get_state(conn, "since_cursor")
    if cur:
        return cur
    with conn.cursor() as c:
        c.execute("select max(updated_at) m from issues")
        m = c.fetchone()["m"]
    return m.isoformat() if m else ingest._EPOCH


def _reverify_candidates(conn, ctx: evidence.EvidenceContext) -> list[int]:
    """Refuted-Highs whose deterministic evidence materially changed since verify."""
    out: list[int] = []
    with conn.cursor() as cur:
        cur.execute(
            """select a.number, a.verify_cluster_size, a.verify_band_decile, f.cluster_size
               from analysis a join features f using (number)
               join issues i using (number)
               where a.verification_status = 'refuted-high' and i.state = 'open'"""
        )
        for r in cur.fetchall():
            grew = r["verify_cluster_size"] and f_cs_growth(r["cluster_size"], r["verify_cluster_size"])
            crossed = (r["verify_band_decile"] is not None
                       and ctx.band_decile(r["number"]) > r["verify_band_decile"])
            if grew or crossed:
                out.append(r["number"])
    return out


def f_cs_growth(current: int, snapshot: int) -> bool:
    return current >= 2 * snapshot


def _classify_queue(conn, delta_numbers: list[int]) -> list[int]:
    """New/materially-updated delta issues needing (re)classification.

    An issue qualifies if it has no analysis row, or was updated after it was last analyzed
    (covers reopen, title edits, and maintainer relabels — all bump updated_at).
    """
    if not delta_numbers:
        return []
    with conn.cursor() as cur:
        cur.execute(
            """select i.number
               from issues i left join analysis a using (number)
               where i.number = any(%s)
                 and (a.number is null or i.updated_at > a.analyzed_at)""",
            (delta_numbers,),
        )
        return [r["number"] for r in cur.fetchall()]


def _provisional_features(conn, delta: list[dict[str, Any]], as_of: datetime,
                          cfg: dict[str, Any], run_id: str) -> None:
    """Provisional nearest-cluster assignment + feature recompute for touched rows."""
    delta_numbers = {d["number"] for d in delta}
    with conn.cursor() as cur:
        cur.execute(
            """select i.number, i.title, i.body_lead, f.cluster_id, f.cluster_size
               from issues i join features f using (number)
               where i.state = 'open' and i.number <> all(%s)""",
            (list(delta_numbers),),
        )
        existing = [dict(r) for r in cur.fetchall()]

    ex_numbers = [e["number"] for e in existing]
    ex_docs = [feat.cluster_document(e["title"], e["body_lead"]) for e in existing]
    ex_cluster = {e["number"]: (e["cluster_id"] or e["number"], e["cluster_size"]) for e in existing}

    new_numbers = [d["number"] for d in delta]
    new_docs = [feat.cluster_document(d["title"], d["body_lead"]) for d in delta]
    assigned = clust.assign_provisional(ex_numbers, ex_docs, ex_cluster, new_numbers, new_docs, cfg)

    rows = []
    for d in delta:
        cid, size = assigned.get(d["number"], (d["number"], 1))
        row = feat.compute_features(d, size, as_of, cfg)
        row["cluster_id"] = cid
        row["run_id"] = run_id
        row["computed_at"] = as_of
        rows.append(row)
    db.upsert(conn, "features", rows)


def _analysis_row(cls: dict[str, Any], verdict: dict[str, Any] | None, digest: dict[str, Any],
                  ev: dict[str, Any] | None, final_rank: float, cfg: dict[str, Any],
                  batch_id: int, source: str) -> dict[str, Any]:
    """Assemble the analysis upsert row, applying any verify downgrade."""
    priority = cls["priority"]
    verified_high = False
    verify_basis = None
    verification_status = None
    verification_evidence = None
    v_react = v_cs = v_decile = None

    if verdict is not None:
        verification_evidence = verdict.get("reason")
        v_react = ev.get("_reactions") if ev else None
        v_cs = (ev or {}).get("cluster_size")
        v_decile = (ev or {}).get("_band_decile")
        if verdict["verified_high"]:
            verified_high = True
            verify_basis = verdict.get("basis")
            verification_status = "verified-high"
        else:
            verification_status = "refuted-high"
            if verdict.get("downgrade_to"):
                priority = verdict["downgrade_to"]

    return {
        "number": cls["number"],
        "type": cls["type"],
        "area": cls["area"],
        "tags": cls.get("tags") or [],
        "theme": cls.get("theme"),
        "priority": priority,
        "priority_score": cls.get("priority_score"),
        "final_rank_score": final_rank,
        "summary": cls.get("summary"),
        "rationale": cls.get("rationale"),
        "confidence": cls.get("confidence"),
        "duplicate_of": cls.get("duplicate_of"),
        "verification_status": verification_status,
        "verification_evidence": verification_evidence,
        "verified_high": verified_high,
        "verify_basis": verify_basis,
        "verify_reactions": v_react,
        "verify_cluster_size": v_cs,
        "verify_band_decile": v_decile,
        "source": source,
        "model": cfg["classifier"]["model"],
        "rubric_version": cfg["classifier"]["rubric_version"],
        "batch_id": batch_id,
        "analyzed_at": _now(),
    }


def _blend_inputs(conn, numbers: list[int]) -> dict[int, tuple[float, float]]:
    """Bulk-fetch (rate_score, f_severity) for the blend, one query per chunk."""
    if not numbers:
        return {}
    with conn.cursor() as cur:
        cur.execute("select number, rate_score, f_severity from features where number = any(%s)",
                    (numbers,))
        return {r["number"]: (r["rate_score"], r["f_severity"]) for r in cur.fetchall()}


def process_queue(conn, queue: list[int], cfg: dict[str, Any], batch_id: int,
                  ctx: evidence.EvidenceContext, norms: dict[str, float], *,
                  source: str, tag: str = "sync") -> tuple[int, int]:
    """Classify → verify (H/≥70) → blend → upsert analysis, in batches. Shared by sync + catchup.

    Returns (classified_count, verified_high_count).
    """
    batch_size = cfg["classifier"]["batch_size"]
    classified = new_high = 0
    for start in range(0, len(queue), batch_size):
        chunk = queue[start : start + batch_size]
        digests = classify.digests_for(conn, chunk)
        dmap = {d["number"]: d for d in digests}
        blend_in = _blend_inputs(conn, chunk)
        classifications, _ = classify.classify_batch(digests, cfg)

        rows = []
        for cls in classifications:
            num = cls["number"]
            digest = dmap.get(num)
            if digest is None:
                continue
            verdict = None
            ev = None
            if verify.needs_verification(cls, cfg):
                ev = ctx.enrich(num)
                verdict, _ = verify.verify_one(digest, cls, cfg, evidence=ev)
                # snapshot for the re-verify triggers (after verify, so it stays out of the prompt)
                ev["_reactions"] = ctx.reactions.get(num)
                ev["_band_decile"] = ctx.band_decile(num)
            rate, sev = blend_in.get(num, (0.0, 0.0))
            fr = blend.final_rank_score(cls.get("priority_score"), rate, sev,
                                        digest.get("cluster_size", 1), cfg, norms)
            row = _analysis_row(cls, verdict, digest, ev, fr, cfg, batch_id, source)
            new_high += int(row["verified_high"])
            rows.append(row)
        db.upsert(conn, "analysis", rows)
        classified += len(rows)
        print(f"[{tag}] classified {classified}/{len(queue)} (verified_high {new_high})")
    return classified, new_high


def run_sync(gha_run_url: str | None = None) -> dict[str, Any]:
    cfg = db.load_config()
    as_of = _now()
    stats = ingest.IngestStats()

    # Refresh the latest-release marker (staleness evidence) — best-effort.
    try:
        rel = ingest.fetch_latest_release(cfg)
    except Exception:
        rel = None

    with db.connect() as conn:
        batch_id = db.start_batch(conn, "interval", gha_run_url)
        run_id = f"batch-{batch_id}"
        if rel:
            db.set_state(conn, "latest_release_tag", rel.get("tag") or "")
            db.set_state(conn, "latest_release_date", rel.get("date") or "")

        cursor = _initial_cursor(conn)
        print(f"[sync] delta since {cursor}")
        delta = list(ingest.crawl_delta(cfg, cursor, as_of, stats=stats))

        if not delta:
            db.finish_batch(conn, batch_id, status="ok", issues_seen=stats.seen)
            print("[sync] no changes since cursor — no-op.")
            return {"batch_id": batch_id, "delta": 0}

        delta_numbers = [d["number"] for d in delta]
        # states before upsert (to classify new vs updated vs newly-closed)
        with conn.cursor() as cur:
            cur.execute("select number, state from issues where number = any(%s)", (delta_numbers,))
            before = {r["number"]: r["state"] for r in cur.fetchall()}
        new_count = sum(1 for n in delta_numbers if n not in before)
        updated_count = len(delta_numbers) - new_count
        closed_count = sum(1 for d in delta
                           if d["state"] == "closed" and before.get(d["number"]) != "closed")

        db.upsert(conn, "issues", delta, update_cols=db.ISSUE_UPDATE_COLS)
        _provisional_features(conn, delta, as_of, cfg, run_id)

        # ---- classification queue (delta + re-verify triggers) ----
        ctx = evidence.EvidenceContext(conn, cfg)
        queue = _classify_queue(conn, delta_numbers)
        reverify = _reverify_candidates(conn, ctx)
        queue = sorted(set(queue) | set(reverify))
        print(f"[sync] delta={len(delta)} (new {new_count}, upd {updated_count}, closed {closed_count}); "
              f"classify queue={len(queue)} (+{len(reverify)} re-verify)")

        norms = blend.population_norms(conn)
        classified, new_high = process_queue(conn, queue, cfg, batch_id, ctx, norms,
                                             source="interval", tag="sync")

        # ---- triage interplay: active triage + upstream close → confirm ----
        newly_closed = [d["number"] for d in delta
                        if d["state"] == "closed" and before.get(d["number"]) != "closed"]
        if newly_closed:
            with conn.cursor() as cur:
                cur.execute(
                    """update triage set status = 'resolved-upstream-confirm', updated_at = now()
                       where number = any(%s) and status = any(%s)""",
                    (newly_closed, list(_ACTIVE_TRIAGE)),
                )

        # ---- advance cursor (only now, after successful upserts) ----
        max_updated = max(d["updated_at"] for d in delta)
        db.set_state(conn, "since_cursor", max_updated.isoformat())

        db.finish_batch(conn, batch_id, status="ok",
                        issues_seen=stats.seen, new_count=new_count, updated_count=updated_count,
                        closed_count=closed_count, classified_count=classified,
                        new_high_count=new_high)

    print(f"[sync] done: classified {classified}, verified_high {new_high}. batch {batch_id}.")
    return {"batch_id": batch_id, "delta": len(delta), "classified": classified,
            "new_high": new_high, "cursor": max_updated.isoformat()}


def main() -> None:
    run_sync(gha_run_url=os.environ.get("GHA_RUN_URL"))


if __name__ == "__main__":
    main()
