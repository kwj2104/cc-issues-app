"""LLM classification layer — digest builder + headless `claude -p` call.

Builds a compact digest per issue (number, title, body_lead ≤1200, labels, engagement,
age, provisional cluster + up to 2 exemplar titles), batches them, and shells out to
headless Claude Code with the FROZEN rubric as an appended system prompt and the output
schema forcing structured JSON. The classifier judges each issue independently against the
rubric; the returned object validates against pipeline/prompts/output_schema.json.

Auth: CLAUDE_CODE_OAUTH_TOKEN (CI) or a logged-in session (local). Model + batch size +
rubric/schema paths come from config.yaml (classifier.*). The `--json-schema` flag takes
inline JSON (the schema *content*), not a path.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Sequence

from . import db

BODY_LEAD_MAX = 1200  # digest body cap (tighter than the stored 1500 to keep batches lean)


def build_digest(issue: dict[str, Any], features: dict[str, Any],
                 exemplar_titles: Sequence[str]) -> dict[str, Any]:
    """One compact digest. `issue` is an issues row, `features` a features row."""
    return {
        "number": issue["number"],
        "title": issue["title"],
        "body_lead": (issue.get("body_lead") or "")[:BODY_LEAD_MAX],
        "labels": issue.get("labels") or [],
        "reactions_total": issue.get("reactions_total", 0),
        "reactions_plus1": issue.get("reactions_plus1", 0),
        "comments": issue.get("comments", 0),
        "age_days": round(features["age_days"], 1) if features.get("age_days") is not None else None,
        "cluster_id": features.get("cluster_id"),
        "cluster_size": features.get("cluster_size", 1),
        "cluster_exemplars": list(exemplar_titles),  # up to 2 other titles in the cluster
    }


def digests_for(conn, numbers: Sequence[int]) -> list[dict[str, Any]]:
    """Assemble digests for the given issue numbers (joins issues ⋈ features, adds exemplars)."""
    if not numbers:
        return []
    with conn.cursor() as cur:
        cur.execute(
            """select i.number, i.title, i.body_lead, i.labels, i.reactions_total,
                      i.reactions_plus1, i.comments,
                      f.age_days, f.cluster_id, f.cluster_size
               from issues i join features f using (number)
               where i.number = any(%s)""",
            (list(numbers),),
        )
        rows = {r["number"]: dict(r) for r in cur.fetchall()}

        # Up to 2 exemplar titles per cluster (other members, most-reacted first).
        cluster_ids = {r["cluster_id"] for r in rows.values() if r.get("cluster_id") is not None}
        exemplars: dict[int, list[tuple[int, str]]] = {}
        if cluster_ids:
            cur.execute(
                """select f.cluster_id, i.number, i.title, i.reactions_total
                   from features f join issues i using (number)
                   where f.cluster_id = any(%s)
                   order by f.cluster_id, i.reactions_total desc""",
                (list(cluster_ids),),
            )
            for r in cur.fetchall():
                exemplars.setdefault(r["cluster_id"], []).append((r["number"], r["title"]))

    digests = []
    for num in numbers:
        row = rows.get(num)
        if row is None:
            continue
        cid = row.get("cluster_id")
        ex = [t for (n, t) in exemplars.get(cid, []) if n != num][:2] if cid is not None else []
        digests.append(build_digest(row, row, ex))
    return digests


def run_structured(system_prompt: str, user_prompt: str, schema_obj: dict[str, Any], *,
                   model: str, timeout: int = 300) -> tuple[dict, dict]:
    """Shared headless `claude -p` structured-output call (classify + verify both use this).

    We pass the prompt via `--system-prompt` (full REPLACE, rubric/verify text only — not
    appended to Claude Code's ~34k-token default agent prompt), disable all built-in tools
    with `--tools ""` (these calls need none), and force JSON with `--json-schema`. The
    schema is passed inline as JSON content (NOT a path), with the draft-2020-12 `$schema`
    meta-ref and cosmetic `title` stripped (the CLI can't resolve the meta-ref).

    Returns (parsed_object, envelope). The envelope carries cost/usage/error metadata.
    """
    db._load_dotenv()  # ensure CLAUDE_CODE_OAUTH_TOKEN is in env for the subprocess
    schema_obj = dict(schema_obj)
    schema_obj.pop("$schema", None)
    schema_obj.pop("title", None)

    cmd = [
        "claude", "-p", user_prompt,
        "--model", model,
        "--output-format", "json",
        "--tools", "",                       # no built-in tools; classify/verify need none
        "--system-prompt", system_prompt,     # full replace: rubric/verify text only
        "--json-schema", json.dumps(schema_obj),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          cwd=db.REPO_ROOT)
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p exited {proc.returncode}: {proc.stderr[:800]}")

    env = json.loads(proc.stdout)
    if env.get("is_error"):
        raise RuntimeError(f"claude reported error: {env.get('result')}")

    out = env.get("structured_output")
    if out is None:
        out = json.loads(env["result"])
    return out, env


def classify_batch(digests: Sequence[dict[str, Any]], cfg: dict[str, Any], *,
                   model: str | None = None, timeout: int = 300) -> tuple[list[dict], dict]:
    """Run one headless classification call over a batch of digests.

    Returns (classifications, envelope) where classifications validates against the frozen
    output schema.
    """
    clf = cfg["classifier"]
    rubric = (db.REPO_ROOT / clf["rubric"]).read_text()
    schema_obj = json.loads((db.REPO_ROOT / clf["output_schema"]).read_text())
    user_prompt = (
        "Classify every issue in this JSON array of digests. Return only JSON matching "
        "the schema.\n\n" + json.dumps(list(digests), ensure_ascii=False)
    )
    out, env = run_structured(rubric, user_prompt, schema_obj,
                              model=model or clf["model"], timeout=timeout)
    return out.get("classifications", []), env
