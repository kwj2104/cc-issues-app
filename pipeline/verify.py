"""Adversarial verification pass — gates `verified_high`.

Anything first-pass High or priority_score ≥ classifier.verify_threshold gets an
independent second call whose ONLY job is to try to REFUTE the High rating
(pipeline/prompts/verify_v1.md, run as a full system-prompt replace). Only issues that
survive refutation set verified_high = true; the rest are downgraded. This is the direct
answer to the ~25% High-inflation residual documented in the review.

The frozen verify prompt returns one verdict object per issue, so we call once per
candidate (the candidate set is small — a few per batch).
"""

from __future__ import annotations

import json
from typing import Any

from . import classify, db

# Verdict schema (kept in code, not a frozen prompt file — verify_v1.md defines behavior).
VERIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["number", "verified_high", "reason"],
    "additionalProperties": False,
    "properties": {
        "number": {"type": "integer"},
        "verified_high": {"type": "boolean"},
        "downgrade_to": {"type": ["string", "null"], "enum": ["M", "L", None]},
        "basis": {"type": ["string", "null"], "enum": ["corroborated", "class-solo", None]},
        "reason": {"type": "string", "maxLength": 400},
    },
}


def needs_verification(classification: dict[str, Any], cfg: dict[str, Any]) -> bool:
    """First-pass High OR priority_score ≥ verify_threshold."""
    threshold = cfg["classifier"]["verify_threshold"]
    return classification.get("priority") == "H" or (classification.get("priority_score") or 0) >= threshold


def verify_one(digest: dict[str, Any], first_pass: dict[str, Any], cfg: dict[str, Any], *,
               evidence: dict[str, Any] | None = None,
               model: str | None = None, timeout: int = 300) -> tuple[dict, dict]:
    """Run the adversarial pass on one High candidate. Returns (verdict, envelope).

    `evidence` is the deterministic bundle from evidence.EvidenceContext.enrich() — the
    breadth/recency/seed-prior signals the two-sided prompt needs to CREDIT breadth.
    """
    clf = cfg["classifier"]
    verify_prompt = (db.REPO_ROOT / clf["verify"]).read_text()

    payload = {
        "number": digest["number"],
        "title": digest["title"],
        "body_lead": digest["body_lead"],
        "labels": digest["labels"],
        "reactions_total": digest["reactions_total"],
        "comments": digest["comments"],
        "age_days": digest["age_days"],
        "cluster_exemplars": digest.get("cluster_exemplars", []),
        "evidence": evidence or {},
        "first_pass": {
            "priority": first_pass.get("priority"),
            "priority_score": first_pass.get("priority_score"),
            "type": first_pass.get("type"),
            "area": first_pass.get("area"),
            "rationale": first_pass.get("rationale"),
        },
    }
    user_prompt = (
        "Scrutinize this first-pass High rating and try to refute it. Return only the "
        "verdict JSON.\n\n" + json.dumps(payload, ensure_ascii=False)
    )
    verdict, env = classify.run_structured(
        verify_prompt, user_prompt, VERIFY_SCHEMA,
        model=model or clf["model"], timeout=timeout,
    )
    return verdict, env
