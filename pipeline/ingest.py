"""GitHub ingestion — census crawl + continuous delta sync.

Census (backfill): full `state=open` pagination until an empty page.
Delta (every sync): `state=all&sort=updated&direction=asc&since=<cursor>`, catching new,
edited, labeled, closed, and reopened issues in one stream. The caller advances the cursor
(max fully-processed updated_at) only after a successful upsert, which makes reruns
idempotent and crash-safe.

All GitHub data here is public. PR rows are skipped; transferred/deleted stub rows are
skipped and counted.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterator

import requests

from . import features as feat

API_ROOT = "https://api.github.com"
_MAINTAINER_ASSOCS = {"OWNER", "MEMBER", "COLLABORATOR"}
_ACCEPT = "application/vnd.github+json"
_API_VERSION = "2022-11-28"


@dataclass
class IngestStats:
    seen: int = 0          # rows returned by the API
    issues: int = 0        # real issues yielded
    prs_skipped: int = 0   # pull_request rows skipped
    stubs_skipped: int = 0 # malformed / transferred / deleted rows skipped
    pages: int = 0


def _token() -> str:
    feat_env = os.environ.get("GITHUB_TOKEN")
    if not feat_env:
        # Fall back to loading .env for local runs.
        from .db import _load_dotenv
        _load_dotenv()
        feat_env = os.environ.get("GITHUB_TOKEN")
    if not feat_env:
        raise RuntimeError("GITHUB_TOKEN not set (public-repo read PAT required).")
    return feat_env


def _session(token: str | None = None) -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "Authorization": f"Bearer {token or _token()}",
        "Accept": _ACCEPT,
        "X-GitHub-Api-Version": _API_VERSION,
    })
    return s


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _get(session: requests.Session, url: str, params: dict[str, Any],
         max_retries: int = 5, sleep=time.sleep) -> requests.Response:
    """GET with rate-limit awareness and bounded retries (spec §Ingest rate limits)."""
    backoff = 5
    for attempt in range(max_retries + 1):
        resp = session.get(url, params=params, timeout=60)

        # Pre-emptive throttle: sleep until reset if we're about to exhaust the window.
        remaining = resp.headers.get("X-RateLimit-Remaining")
        reset = resp.headers.get("X-RateLimit-Reset")
        if remaining is not None and reset is not None and int(remaining) <= 1:
            wait = max(0, int(reset) - int(time.time())) + 1
            sleep(min(wait, 3600))

        if resp.status_code in (403, 429):
            if attempt >= max_retries:
                resp.raise_for_status()
            sleep(60)
            continue
        if resp.status_code >= 500:
            if attempt >= max_retries:
                resp.raise_for_status()
            sleep(min(backoff, 80))
            backoff *= 2
            continue
        resp.raise_for_status()
        return resp
    resp.raise_for_status()
    return resp  # unreachable


def normalize_issue(raw: dict[str, Any], as_of: datetime, cfg: dict[str, Any]) -> dict[str, Any] | None:
    """Map a raw GitHub issue payload to a normalized `issues`-table row.

    Returns None for PR rows and malformed stubs (missing number/title/timestamps).
    """
    if "pull_request" in raw:
        return None
    number = raw.get("number")
    created = _parse_dt(raw.get("created_at"))
    updated = _parse_dt(raw.get("updated_at"))
    if number is None or created is None or updated is None or raw.get("title") is None:
        return None

    reactions = raw.get("reactions") or {}
    labels = [(lbl.get("name") or "").lower() for lbl in (raw.get("labels") or [])]
    body_lead_chars = cfg["clustering"]["body_lead_chars"]

    return {
        "number": number,
        "title": raw["title"],
        "body_lead": feat.body_lead(raw.get("body"), body_lead_chars),
        "state": raw.get("state", "open"),
        "state_reason": raw.get("state_reason"),
        "labels": labels,
        "created_at": created,
        "updated_at": updated,
        "closed_at": _parse_dt(raw.get("closed_at")),
        "comments": raw.get("comments", 0) or 0,
        "reactions_total": reactions.get("total_count", 0) or 0,
        "reactions_plus1": reactions.get("+1", 0) or 0,
        "author_association": raw.get("author_association"),
        "maintainer_authored": raw.get("author_association") in _MAINTAINER_ASSOCS,
        "locked": bool(raw.get("locked", False)),
        "active_lock_reason": raw.get("active_lock_reason"),
        "html_url": raw.get("html_url", ""),
        "last_seen_at": as_of,
    }


# GitHub rejects deep pagination on list endpoints (~10k-item ceiling → 422 around
# page 100). With ~12k open issues we can't page straight through, so we always sort by
# `updated` ascending and, when a window fills, jump the `since` cursor past it and resume
# from page 1. Overlap at the window boundary is deduped by issue number.
_PAGE_CAP = 95
# `since` far enough back to precede the repo, but NOT the Unix epoch: GitHub returns an
# empty result for since=1970-01-01, while any real pre-repo date works.
_EPOCH = "2015-01-01T00:00:00Z"


def _crawl_since(session: requests.Session, url: str, base_params: dict[str, Any],
                 since: str, as_of: datetime, cfg: dict[str, Any],
                 stats: IngestStats, sleep) -> Iterator[dict[str, Any]]:
    """Since-chunked, updated-asc pagination shared by census and delta.

    Yields normalized rows. Rows come out in roughly ascending updated_at order (exactly
    ascending within a window), so a caller can advance its durable cursor to the max
    updated_at it has successfully upserted.
    """
    seen: set[int] = set()
    while True:
        page = 1
        window_last = since
        window_new = 0
        exhausted = False
        while page <= _PAGE_CAP:
            resp = _get(session, url, {
                **base_params, "sort": "updated", "direction": "asc",
                "since": since, "per_page": 100, "page": page,
            }, sleep=sleep)
            rows = resp.json()
            if not rows:
                exhausted = True
                break
            stats.pages += 1
            for raw in rows:
                updated = raw.get("updated_at")
                if updated:
                    window_last = updated
                stats.seen += 1
                norm = normalize_issue(raw, as_of, cfg)
                if norm is None:
                    if "pull_request" in raw:
                        stats.prs_skipped += 1
                    else:
                        stats.stubs_skipped += 1
                    continue
                if norm["number"] in seen:  # boundary overlap between windows
                    continue
                seen.add(norm["number"])
                stats.issues += 1
                window_new += 1
                yield norm
            page += 1
        # Advance to the next window unless we hit an empty page, found nothing new, or
        # the cursor can't move (guards against looping on a single-timestamp pileup).
        if exhausted or window_new == 0 or window_last == since:
            break
        since = window_last


def fetch_latest_release(cfg: dict[str, Any], *, token: str | None = None,
                         sleep=time.sleep) -> dict[str, str | None]:
    """Latest published release tag + date (for staleness judging). One call per sync.

    Returns {"tag": ..., "date": ...}; both None if the repo has no releases.
    """
    session = _session(token)
    url = f"{API_ROOT}/repos/{cfg['repo']}/releases/latest"
    resp = session.get(url, timeout=60)
    if resp.status_code == 404:
        return {"tag": None, "date": None}
    resp.raise_for_status()
    data = resp.json()
    return {"tag": data.get("tag_name"), "date": data.get("published_at")}


def crawl_census(cfg: dict[str, Any], as_of: datetime, *, token: str | None = None,
                 stats: IngestStats | None = None, sleep=time.sleep) -> Iterator[dict[str, Any]]:
    """Full open-issue census (state=open), since-chunked to clear the pagination ceiling."""
    stats = stats if stats is not None else IngestStats()
    session = _session(token)
    url = f"{API_ROOT}/repos/{cfg['repo']}/issues"
    yield from _crawl_since(session, url, {"state": "open"}, _EPOCH, as_of, cfg, stats, sleep)


def crawl_delta(cfg: dict[str, Any], since_cursor: str, as_of: datetime, *,
                token: str | None = None, stats: IngestStats | None = None,
                sleep=time.sleep) -> Iterator[dict[str, Any]]:
    """Delta sync (state=all) since the cursor — catches new, edited, closed, reopened."""
    stats = stats if stats is not None else IngestStats()
    session = _session(token)
    url = f"{API_ROOT}/repos/{cfg['repo']}/issues"
    yield from _crawl_since(session, url, {"state": "all"}, since_cursor, as_of, cfg, stats, sleep)
