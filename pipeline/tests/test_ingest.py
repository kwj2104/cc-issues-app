"""Normalization + delta ordering (PR-skip, stub-skip, label lowercasing, reactions)."""

from __future__ import annotations

from datetime import datetime, timezone

from pipeline import ingest
from pipeline.db import load_config

CFG = load_config()
AS_OF = datetime(2026, 7, 23, tzinfo=timezone.utc)


def _raw(**over):
    base = {
        "number": 100,
        "title": "Something broke",
        "body": "a description",
        "state": "open",
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "labels": [{"name": "Bug"}, {"name": "Area:Security"}],
        "comments": 5,
        "reactions": {"total_count": 12, "+1": 9},
        "author_association": "NONE",
        "html_url": "https://github.com/anthropics/claude-code/issues/100",
    }
    base.update(over)
    return base


def test_normalize_basic_fields():
    n = ingest.normalize_issue(_raw(), AS_OF, CFG)
    assert n["number"] == 100
    assert n["state"] == "open"
    assert n["comments"] == 5
    assert n["reactions_total"] == 12
    assert n["reactions_plus1"] == 9
    assert n["last_seen_at"] == AS_OF


def test_labels_lowercased():
    n = ingest.normalize_issue(_raw(), AS_OF, CFG)
    assert n["labels"] == ["bug", "area:security"]


def test_maintainer_flag_from_association():
    assert ingest.normalize_issue(_raw(author_association="MEMBER"), AS_OF, CFG)["maintainer_authored"] is True
    assert ingest.normalize_issue(_raw(author_association="NONE"), AS_OF, CFG)["maintainer_authored"] is False


def test_pull_requests_skipped():
    pr = _raw(pull_request={"url": "..."})
    assert ingest.normalize_issue(pr, AS_OF, CFG) is None


def test_stub_rows_skipped():
    # transferred/deleted stubs lack a title or timestamps
    assert ingest.normalize_issue({"number": 1}, AS_OF, CFG) is None
    assert ingest.normalize_issue(_raw(title=None), AS_OF, CFG) is None
    assert ingest.normalize_issue(_raw(created_at=None), AS_OF, CFG) is None


def test_missing_reactions_object_zeros():
    n = ingest.normalize_issue(_raw(reactions=None), AS_OF, CFG)
    assert n["reactions_total"] == 0 and n["reactions_plus1"] == 0


def test_null_body_becomes_empty_lead():
    n = ingest.normalize_issue(_raw(body=None), AS_OF, CFG)
    assert n["body_lead"] == ""


def test_state_reason_captured_on_close():
    n = ingest.normalize_issue(_raw(state="closed", state_reason="not_planned",
                                    closed_at="2026-07-21T00:00:00Z"), AS_OF, CFG)
    assert n["state"] == "closed"
    assert n["state_reason"] == "not_planned"
    assert n["closed_at"] is not None


# ------------------------ delta ordering & skip counts ------------------------

class _FakeResp:
    def __init__(self, rows):
        self._rows = rows
        self.headers = {"X-RateLimit-Remaining": "5000", "X-RateLimit-Reset": "0"}
        self.status_code = 200

    def json(self):
        return self._rows

    def raise_for_status(self):
        pass


class _FakeSession:
    """Serves fixed pages by page number, empty page terminates."""
    def __init__(self, pages):
        self.pages = pages

    def get(self, url, params=None, timeout=None):
        page = params.get("page", 1)
        return _FakeResp(self.pages.get(page, []))


def test_delta_yields_ascending_and_counts(monkeypatch):
    pages = {
        1: [
            _raw(number=1, updated_at="2026-07-01T00:00:00Z"),
            {"number": 2, "pull_request": {}},                  # PR → skipped
            _raw(number=3, updated_at="2026-07-05T00:00:00Z"),
            {"number": 4},                                      # stub → skipped
        ],
        2: [],
    }
    monkeypatch.setattr(ingest, "_session", lambda token=None: _FakeSession(pages))
    stats = ingest.IngestStats()
    got = list(ingest.crawl_delta(CFG, "2026-06-30T00:00:00Z", AS_OF, stats=stats,
                                  token="x", sleep=lambda *_: None))
    assert [g["number"] for g in got] == [1, 3]
    updates = [g["updated_at"] for g in got]
    assert updates == sorted(updates)          # ascending updated order for safe cursor advance
    assert stats.prs_skipped == 1
    assert stats.stubs_skipped == 1
    assert stats.issues == 2
