"""NUL-byte scrubbing on the write path.

Regression for the 2026-07-29 wedge: every scheduled catchup run failed with
`psycopg.DataError: PostgreSQL text fields cannot contain NUL (0x00) bytes` raised from
`db.upsert(conn, "analysis", rows)`. The classifier had produced a summary containing a
real NUL (a "\\u0000" escape in the `claude -p` JSON becomes one after parsing), and
Postgres text cannot hold that byte.

Two properties made it a permanent wedge rather than one bad run:
  * the DataError killed the whole transaction, so the ~20 issues classified before it
    were rolled back and never persisted (the classifier calls were spent regardless);
  * the catchup queue is `order by retrieval_score desc`, which is deterministic — so the
    next run rebuilt the identical chunk, re-classified it, and died in the same place.
16 consecutive runs failed that way. Scrubbing at the upsert boundary breaks the loop.
"""

from __future__ import annotations

from pipeline import db


class _FakeCursor:
    """Records params, and mimics Postgres by rejecting NUL in any text parameter."""

    def __init__(self):
        self.seen: list[tuple] = []

    def executemany(self, sql, params):
        for row in params:
            for v in row:
                vals = v if isinstance(v, list) else [v]
                for item in vals:
                    if isinstance(item, str) and "\x00" in item:
                        raise AssertionError("NUL byte reached the database")
            self.seen.append(row)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self):
        self.cur = _FakeCursor()

    def cursor(self):
        return self.cur


def test_scrub_nul_handles_text_lists_and_passthrough():
    assert db.scrub_nul("clean") == "clean"
    assert db.scrub_nul("a\x00b") == "ab"
    # tags is a text[] column — the NUL can hide one level down.
    assert db.scrub_nul(["x\x00", "y"]) == ["x", "y"]
    # Non-text values must be handed through untouched, not stringified.
    for v in (None, 7, 1.5, True):
        assert db.scrub_nul(v) is v


def test_upsert_strips_nul_instead_of_raising():
    conn = _FakeConn()
    rows = [
        {"number": 1, "summary": "fine", "tags": ["ok"]},
        {"number": 2, "summary": "mojibake U+\x000000 report", "tags": ["a\x00b"]},
    ]
    sent = db.upsert(conn, "analysis", rows)  # used to raise DataError here

    assert sent == 2
    assert conn.cur.seen[1][1] == "mojibake U+0000 report"
    assert conn.cur.seen[1][2] == ["ab"]


def test_clean_rows_are_written_byte_for_byte():
    """Scrubbing must not perturb ordinary rows — no normalising, no coercion."""
    conn = _FakeConn()
    row = {"number": 3, "summary": "emoji ✅ and ünicode — kept", "tags": ["a", "b"]}
    db.upsert(conn, "analysis", [row])

    assert conn.cur.seen[0] == (3, "emoji ✅ and ünicode — kept", ["a", "b"])
