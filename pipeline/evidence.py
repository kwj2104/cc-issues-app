"""Deterministic evidence enrichment for the verify pass.

The first-pass classifier judges from a compact digest. The adversarial verifier needs to
CREDIT breadth (not just guess), so we hand it deterministic signals we already compute:

- engagement + velocity percentile within the issue's AGE BAND (≤7d / 8–30d / 31–90d / >90d),
  because engagement skews hard with age — raw reactions mislead across bands;
- cluster_size PLUS a "related mass" count = TF-IDF neighbors at a looser 0.4 threshold, which
  catches uniquely-worded issues with semantic siblings (e.g. #16157) that the 0.6 duplicate
  clustering leaves as singletons;
- last-activity recency (updated_at) and the latest release tag+date (fetched once per sync,
  stored in sync_state) so staleness is JUDGED against the current release line, not assumed;
- when the issue was in the July seed review: its adjudicated priority + verification status as
  prior evidence.

All of this is deterministic — no wall-clock inside the math beyond the batch's as_of.
"""

from __future__ import annotations

import bisect
from typing import Any

from sklearn.feature_extraction.text import TfidfVectorizer

from . import features as feat

RELATED_MASS_THRESHOLD = 0.4  # looser than duplicate clustering's 0.6 — semantic siblings
SPARSE_ENGAGEMENT_FLOOR = 10  # below reactions+comments, in-band percentile is a zero-dominated artifact


def age_band(age_days: float) -> str:
    if age_days <= 7:
        return "≤7d"
    if age_days <= 30:
        return "8–30d"
    if age_days <= 90:
        return "31–90d"
    return ">90d"


def _pct(sorted_vals: list[float], value: float) -> int:
    """Percentile of `value` within a sorted population (fraction ≤ value), 0–100."""
    if not sorted_vals:
        return 0
    n = len(sorted_vals)
    # count of elements ≤ value
    le = bisect.bisect_right(sorted_vals, value)
    return round(100 * le / n)


class EvidenceContext:
    """Population-level context built once per sync (or once per acceptance run)."""

    def __init__(self, conn, cfg: dict[str, Any]) -> None:
        self.cfg = cfg
        with conn.cursor() as cur:
            # Per-issue attributes for ALL issues (a delta can include freshly-closed rows we
            # still classify/verify); the percentile bands + TF-IDF corpus below use the OPEN
            # subset only, since breadth is measured against the live backlog.
            cur.execute(
                """select i.number, i.title, i.body_lead, i.updated_at, i.reactions_total,
                          i.comments, i.state, f.age_days, f.f_velocity, f.cluster_size
                   from issues i join features f using (number)"""
            )
            rows = [dict(r) for r in cur.fetchall()]
            # seed-review priors
            cur.execute(
                """select number, priority, verification_status
                   from analysis where source = 'seed-review'"""
            )
            self.seed_prior = {r["number"]: dict(r) for r in cur.fetchall()}
            from . import db
            self.latest_release = {
                "tag": db.get_state(conn, "latest_release_tag"),
                "date": db.get_state(conn, "latest_release_date"),
            }

        self.updated_at = {r["number"]: r["updated_at"] for r in rows}
        self.cluster_size = {r["number"]: r["cluster_size"] for r in rows}
        self.reactions = {r["number"]: r["reactions_total"] for r in rows}
        self.comments = {r["number"]: r["comments"] for r in rows}
        self.age = {r["number"]: r["age_days"] for r in rows}
        self.velocity = {r["number"]: r["f_velocity"] for r in rows}

        open_rows = [r for r in rows if r["state"] == "open"]  # breadth is vs the live backlog

        # per-band sorted distributions for percentile lookup (open population)
        self._band_react: dict[str, list[float]] = {}
        self._band_vel: dict[str, list[float]] = {}
        for r in open_rows:
            b = age_band(r["age_days"])
            self._band_react.setdefault(b, []).append(r["reactions_total"])
            self._band_vel.setdefault(b, []).append(r["f_velocity"])
        for d in (self._band_react, self._band_vel):
            for b in d:
                d[b].sort()

        # TF-IDF corpus for related-mass (open population, same vectorizer params as clustering)
        self.numbers = [r["number"] for r in open_rows]
        self._idx = {n: i for i, n in enumerate(self.numbers)}
        docs = [feat.cluster_document(r["title"], r["body_lead"]) for r in open_rows]
        cl = cfg["clustering"]
        try:
            self._X = TfidfVectorizer(
                ngram_range=tuple(cl["ngram_range"]), min_df=cl["min_df"],
                max_df=cl["max_df"], stop_words="english", lowercase=True,
            ).fit_transform(docs)
        except ValueError:
            self._X = None

    def related_mass(self, number: int) -> int:
        """Count of TF-IDF neighbors at ≥0.4 (excluding self); 0 if not in corpus."""
        if self._X is None or number not in self._idx:
            return 0
        i = self._idx[number]
        sims = (self._X[i] @ self._X.T).toarray().ravel()
        return int((sims >= RELATED_MASS_THRESHOLD).sum()) - 1  # drop self (sim 1.0)

    def band_decile(self, number: int) -> int:
        """Which reactions decile (0–10) the issue sits in for its age band."""
        b = age_band(self.age[number])
        return _pct(self._band_react.get(b, []), self.reactions[number]) // 10

    def enrich(self, number: int) -> dict[str, Any]:
        """Deterministic evidence bundle for one issue (merged into the verify payload)."""
        b = age_band(self.age[number])
        updated = self.updated_at.get(number)
        seed = self.seed_prior.get(number)
        engagement_volume = self.reactions[number] + self.comments.get(number, 0)
        return {
            "age_band": b,
            "engagement_pctile_in_band": _pct(self._band_react.get(b, []), self.reactions[number]),
            "engagement_is_sparse": engagement_volume < SPARSE_ENGAGEMENT_FLOOR,
            "velocity": round(self.velocity[number], 2),
            "velocity_pctile_in_band": _pct(self._band_vel.get(b, []), self.velocity[number]),
            "cluster_size": self.cluster_size.get(number, 1),
            "related_mass_0p4": self.related_mass(number),
            "last_activity_date": updated.isoformat() if updated else None,
            "latest_release": self.latest_release,
            "seed_prior": (
                {"priority": seed["priority"], "verification_status": seed["verification_status"]}
                if seed else None
            ),
        }
