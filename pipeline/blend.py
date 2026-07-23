"""Blended final ranking — final_rank_score = Σ w · norm(component) (config.blend).

LLM judgment never ranks alone: the blend keeps the list stable against LLM variance while
the LLM keeps it smarter than metadata alone. Components are normalized to [0,1]:
  - priority_score : fixed 0–100 scale  → /100
  - f_severity     : fixed cap scale     → /cap
  - cluster_mass   : log2(cluster_size) / log2(max cluster size in population)
  - rate_score     : min–max over the current population
Every raw component is stored per row (auditable in the issue drawer); weights live in config.
"""

from __future__ import annotations

from math import log2
from typing import Any


def population_norms(conn) -> dict[str, float]:
    """Population extrema needed for the min–max / log normalizations."""
    with conn.cursor() as cur:
        cur.execute("select min(rate_score) rmin, max(rate_score) rmax, "
                    "max(cluster_size) cmax from features")
        r = cur.fetchone()
    return {
        "rate_min": r["rmin"] if r["rmin"] is not None else 0.0,
        "rate_max": r["rmax"] if r["rmax"] is not None else 0.0,
        "cluster_max": r["cmax"] or 1,
    }


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def final_rank_score(priority_score: float | None, rate_score: float, f_severity: float,
                     cluster_size: int, cfg: dict[str, Any], norms: dict[str, float]) -> float:
    """Blended 0–100 rank score (weights sum to 1; components in [0,1]; ×100 for UI)."""
    w = cfg["blend"]
    n_pri = _clamp01((priority_score or 0) / 100.0)
    rmin, rmax = norms["rate_min"], norms["rate_max"]
    n_rate = _clamp01((rate_score - rmin) / (rmax - rmin)) if rmax > rmin else 0.0
    n_sev = _clamp01((f_severity or 0) / cfg["severity"]["cap"])
    cmax = max(norms["cluster_max"], 1)
    n_clu = log2(max(cluster_size, 1)) / log2(cmax) if cmax > 1 else 0.0
    blended = (
        w["llm_priority"] * n_pri
        + w["rate_score"] * n_rate
        + w["severity"] * n_sev
        + w["cluster_mass"] * n_clu
    )
    return round(blended * 100.0, 2)
