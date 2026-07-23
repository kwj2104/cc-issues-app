"""Deterministic feature layer — text prep, feature formulas, eligibility, junk filter.

Every formula here is the exact math from docs/retrieval-spec.md. Determinism is law:
feature math takes an explicit `as_of` timestamp (no wall-clock reads) and no randomness.
All tunables come from config.yaml — nothing is hardcoded.

Text prep is shared by the severity regex path and the clustering corpus, so it is
unit-tested against fixtures (see pipeline/tests).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from math import log2
from typing import Any, Sequence

# ---------------------------------------------------------------------------
# Text prep (retrieval-spec §"Text prep")
# ---------------------------------------------------------------------------

# Fenced code blocks (``` or ~~~), matched to their own fence.
_FENCE_RE = re.compile(r"(```|~~~).*?\1", re.DOTALL)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_IMAGE_MD_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_URL_RE = re.compile(r"https?://\S+")
_HEADER_LINE_RE = re.compile(r"^\s*#{1,6}\s*(.+?)\s*$")
_WS_RE = re.compile(r"\s+")

# Issue-template section headers to drop (compared lowercased, trailing ':' stripped).
_TEMPLATE_HEADERS = frozenset({
    "environment",
    "what happened",
    "steps to reproduce",
    "expected behavior",
    "preflight checklist",
    "version",
    "platform",
})


def _strip_template_headers(text: str) -> str:
    kept: list[str] = []
    for line in text.split("\n"):
        m = _HEADER_LINE_RE.match(line)
        if m and m.group(1).strip().rstrip(":").strip().lower() in _TEMPLATE_HEADERS:
            continue
        kept.append(line)
    return "\n".join(kept)


def clean_body(body: str | None) -> str:
    """Clean a raw issue body into the corpus text (before length truncation).

    Removes fenced code blocks, HTML comments, image markdown, and URLs; drops
    issue-template section headers; collapses whitespace. Null/empty → ''.
    """
    if not body:
        return ""
    t = _FENCE_RE.sub(" ", body)
    t = _HTML_COMMENT_RE.sub(" ", t)
    t = _IMAGE_MD_RE.sub(" ", t)
    t = _URL_RE.sub(" ", t)
    t = _strip_template_headers(t)
    return _WS_RE.sub(" ", t).strip()


def body_lead(body: str | None, body_lead_chars: int = 1500) -> str:
    """Cleaned body truncated to `body_lead_chars` — what we store and cluster on."""
    return clean_body(body)[:body_lead_chars]


def clean_text(title: str, lead: str) -> str:
    """Corpus for the severity regex: title + ' ' + body_lead (spec §Features)."""
    return f"{title} {lead}".strip()


def cluster_document(title: str, lead: str) -> str:
    """Clustering doc: title doubled to up-weight it, then body_lead (spec §Text prep)."""
    return f"{title} {title} {lead}".strip()


# ---------------------------------------------------------------------------
# Feature formulas (retrieval-spec §Features)
# ---------------------------------------------------------------------------

def age_days(created_at: datetime, as_of: datetime) -> float:
    """max(1.0, (as_of − created_at) / 86400) — age floor of 1 day for zero-age issues."""
    delta = (_utc(as_of) - _utc(created_at)).total_seconds()
    return max(1.0, delta / 86400.0)


def _utc(dt: datetime) -> datetime:
    """Normalize to aware UTC (naive datetimes are assumed already UTC)."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _severity_regex(cfg: dict[str, Any]) -> re.Pattern:
    return re.compile(cfg["severity"]["regex_bank"], re.IGNORECASE)


def f_severity(title: str, lead: str, labels: Sequence[str], cfg: dict[str, Any]) -> float:
    """min(cap, Σ label_weights[matched] + regex_bonus·(any regex match))."""
    sev = cfg["severity"]
    label_set = set(labels)
    weight = sum(w for lbl, w in sev["label_weights"].items() if lbl in label_set)
    if _severity_regex(cfg).search(clean_text(title, lead)):
        weight += sev["regex_bonus"]  # bonus added at most once
    return min(sev["cap"], weight)


def f_demand(labels: Sequence[str], reactions_total: int, cfg: dict[str, Any]) -> float:
    """log2(reactions_total) if any demand label AND reactions ≥ min, else 0."""
    dem = cfg["demand"]
    label_set = set(labels)
    if any(lbl in label_set for lbl in dem["labels"]) and reactions_total >= dem["min_reactions"]:
        return log2(reactions_total)
    return 0.0


def is_junk(clean_body_len: int, reactions_total: int, comments: int, age: float,
            cfg: dict[str, Any]) -> bool:
    """Abandoned template noise: tiny body AND no engagement AND aged past the window."""
    jf = cfg["eligibility"]["junk_filter"]
    return (
        clean_body_len <= jf["max_clean_body_chars"]
        and reactions_total <= jf["max_reactions"]
        and comments <= jf["max_comments"]
        and age >= jf["min_age_days"]
    )


def is_eligible(state: str, labels: Sequence[str], active_lock_reason: str | None,
                reactions_total: int, junk: bool, cfg: dict[str, Any]) -> bool:
    """Lifecycle eligibility with the stale-rescue (spec §Eligibility).

    open ∧ no excluding label ∧ lock reason ok ∧ not junk — except when the ONLY
    excluding label is `stale` and reactions ≥ stale_rescue_min_reactions.
    """
    elig = cfg["eligibility"]
    if state != "open" or junk:
        return False
    excluding = set(labels) & set(elig["exclude_labels"])
    if excluding == {"stale"} and reactions_total >= elig["stale_rescue_min_reactions"]:
        excluding = set()  # upvote exemption mirrors the repo's own sweep
    if excluding:
        return False
    if active_lock_reason in set(elig["exclude_lock_reasons"]):
        return False
    return True


def compute_features(issue: dict[str, Any], cluster_size: int, as_of: datetime,
                     cfg: dict[str, Any]) -> dict[str, Any]:
    """Compute the full features row for one issue.

    `issue` is a normalized dict (ingest output / issues-table row) with at least:
    number, title, body_lead, labels, state, created_at, comments, reactions_total,
    active_lock_reason. `cluster_size` comes from the clustering pass (≥1). Returns a
    dict matching the `features` table columns (minus run_id/computed_at, set by caller).
    """
    title = issue["title"]
    lead = issue["body_lead"]
    labels = issue.get("labels") or []
    reactions_total = issue.get("reactions_total", 0)
    comments = issue.get("comments", 0)

    age = age_days(issue["created_at"], as_of)
    csize = max(cluster_size, 1)
    log_cluster = log2(csize)

    f_react = log2(1 + reactions_total)
    f_comm = log2(1 + comments)
    f_vel = log2(1 + 30 * (reactions_total + comments) / age)
    f_sev = f_severity(title, lead, labels, cfg)
    f_dem = f_demand(labels, reactions_total, cfg)

    rate = (
        3 * log2(1 + 30 * reactions_total / age)
        + 1 * log2(1 + 30 * comments / age)
        + 2 * f_sev
        + 2 * log_cluster
    )

    w = cfg["weights"]
    retrieval = (
        w["reactions"] * f_react
        + w["comments"] * f_comm
        + w["velocity"] * f_vel
        + w["severity"] * f_sev
        + w["demand"] * f_dem
        + w["cluster"] * log_cluster
    )

    junk = is_junk(len(lead), reactions_total, comments, age, cfg)
    eligible = is_eligible(
        issue["state"], labels, issue.get("active_lock_reason"), reactions_total, junk, cfg
    )

    return {
        "number": issue["number"],
        "age_days": age,
        "f_reactions": f_react,
        "f_comments": f_comm,
        "f_velocity": f_vel,
        "f_severity": f_sev,
        "f_demand": f_dem,
        "rate_score": rate,
        "retrieval_score": retrieval,
        "is_junk": junk,
        "eligible": eligible,
        "cluster_size": csize,
    }
