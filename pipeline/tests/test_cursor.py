"""Cursor semantics: sync_state advances only on a successful (committed) batch.

Uses an in-memory fake connection that models transactional commit/rollback, so the
invariant is tested without a live database. db.connect() must commit on clean exit and
roll back on exception — which is exactly what makes the delta cursor crash-safe.
"""

from __future__ import annotations

import pytest

from pipeline import db

# Shared "durable" store across fake connections (survives commit, discards staged on rollback).
_DURABLE: dict[str, str] = {}


class _FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=()):
        s = sql.strip().lower()
        if s.startswith("insert into sync_state"):
            key, value = params
            self.conn.staged[key] = value
        elif s.startswith("select value from sync_state"):
            (key,) = params
            view = {**self.conn.durable, **self.conn.staged}
            self._result = {"value": view[key]} if key in view else None
        else:
            raise AssertionError(f"unexpected SQL in fake: {sql!r}")

    def fetchone(self):
        return self._result


class _FakeConn:
    def __init__(self, durable):
        self.durable = durable
        self.staged: dict[str, str] = {}

    def cursor(self):
        return _FakeCursor(self)

    def commit(self):
        self.durable.update(self.staged)
        self.staged.clear()

    def rollback(self):
        self.staged.clear()

    def close(self):
        pass


@pytest.fixture(autouse=True)
def _patch_connect(monkeypatch):
    _DURABLE.clear()
    monkeypatch.setattr(db, "dsn", lambda: "fake://")
    monkeypatch.setattr(db.psycopg, "connect", lambda *a, **k: _FakeConn(_DURABLE))
    yield


def test_cursor_persists_on_success():
    with db.connect() as conn:
        db.set_state(conn, "since_cursor", "2026-07-20T00:00:00Z")
    with db.connect() as conn:
        assert db.get_state(conn, "since_cursor") == "2026-07-20T00:00:00Z"


def test_cursor_not_advanced_on_failure():
    with db.connect() as conn:
        db.set_state(conn, "since_cursor", "GOOD")

    with pytest.raises(RuntimeError):
        with db.connect() as conn:
            db.set_state(conn, "since_cursor", "SHOULD_ROLL_BACK")
            raise RuntimeError("upsert blew up mid-batch")

    with db.connect() as conn:
        assert db.get_state(conn, "since_cursor") == "GOOD"   # unchanged
