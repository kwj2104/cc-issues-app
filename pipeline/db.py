"""Database access layer — Postgres (Supabase) via psycopg.

Owns the DSN, connection helper, batched upserts, and `sync_state` get/set.
Every write is an upsert (idempotence is law): any run can be safely re-run and a
failed run leaves the DB consistent. The sync cursor advances only after a successful
batch (see ingest.delta_sync).

Connection: set DATABASE_URL to the Supabase Postgres connection string
(Supabase dashboard → Project Settings → Database → Connection string → URI, using the
session or transaction pooler). The SUPABASE_SERVICE_ROLE_KEY is a PostgREST JWT and is
NOT a Postgres password — it cannot be used to open a psycopg connection.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import psycopg
import yaml
from psycopg.rows import dict_row

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "pipeline" / "config.yaml"

# Columns the issues upsert overwrites on conflict; first_seen_at is insert-only (never reset).
ISSUE_UPDATE_COLS = [
    "title", "body_lead", "state", "state_reason", "labels", "created_at",
    "updated_at", "closed_at", "comments", "reactions_total", "reactions_plus1",
    "author_association", "maintainer_authored", "locked", "active_lock_reason",
    "html_url", "last_seen_at",
]


@lru_cache(maxsize=1)
def load_config() -> dict[str, Any]:
    """Parse pipeline/config.yaml once. All tunables live here — never hardcode."""
    with CONFIG_PATH.open() as fh:
        return yaml.safe_load(fh)


def _load_dotenv() -> None:
    """Best-effort load of a local .env (CI injects real env vars instead)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(REPO_ROOT / ".env")


def dsn() -> str:
    """Resolve the Postgres DSN — DATABASE_URL only.

    DATABASE_URL is the Supabase Session-pooler connection string (Project Settings →
    Database → Connection string → URI). The service-role key is a PostgREST JWT, not a
    DB password, and is used only by the web triage route — never here.
    """
    _load_dotenv()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL not set. Use the Supabase Session-pooler connection string "
            "(Project Settings → Database → Connection string → URI)."
        )
    return url


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    """Yield a committed connection; rolls back on exception.

    A single logical batch should run inside one `with connect() as conn:` block so
    that a mid-batch failure rolls the whole thing back and leaves the DB consistent.

    We connect via the Supabase Session pooler (port 5432), which supports prepared
    statements — no special psycopg handling needed. If we ever switch to the
    Transaction pooler (port 6543), add prepare_threshold=None to this connect() call,
    since that pooler does not support server-side prepared statements.
    """
    conn = psycopg.connect(dsn(), row_factory=dict_row, autocommit=False)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Generic batched upsert
# ---------------------------------------------------------------------------

def upsert(
    conn: psycopg.Connection,
    table: str,
    rows: Sequence[dict[str, Any]],
    *,
    conflict_key: str = "number",
    update_cols: Iterable[str] | None = None,
    page_size: int = 500,
) -> int:
    """Batched `INSERT ... ON CONFLICT (conflict_key) DO UPDATE`.

    All dict rows must share the same keys (column set). `update_cols` restricts which
    columns are overwritten on conflict; by default every non-key column is updated.
    Returns the number of rows sent. Uses executemany over chunked VALUES for
    execute_values-style batching without server-side surprises.
    """
    rows = list(rows)
    if not rows:
        return 0

    cols = list(rows[0].keys())
    for r in rows:
        if list(r.keys()) != cols:
            raise ValueError("all rows passed to upsert() must share the same columns")

    if update_cols is None:
        update_cols = [c for c in cols if c != conflict_key]
    update_cols = list(update_cols)

    col_sql = ", ".join(cols)
    placeholders = "(" + ", ".join(["%s"] * len(cols)) + ")"
    if update_cols:
        set_sql = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
        conflict_sql = f"on conflict ({conflict_key}) do update set {set_sql}"
    else:
        conflict_sql = f"on conflict ({conflict_key}) do nothing"

    sql = f"insert into {table} ({col_sql}) values {placeholders} {conflict_sql}"

    sent = 0
    with conn.cursor() as cur:
        for start in range(0, len(rows), page_size):
            chunk = rows[start : start + page_size]
            cur.executemany(sql, [tuple(r[c] for c in cols) for r in chunk])
            sent += len(chunk)
    return sent


# ---------------------------------------------------------------------------
# sync_state key/value helpers
# ---------------------------------------------------------------------------

def get_state(conn: psycopg.Connection, key: str, default: str | None = None) -> str | None:
    with conn.cursor() as cur:
        cur.execute("select value from sync_state where key = %s", (key,))
        row = cur.fetchone()
    return row["value"] if row else default


def set_state(conn: psycopg.Connection, key: str, value: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into sync_state(key, value) values (%s, %s) "
            "on conflict (key) do update set value = excluded.value",
            (key, value),
        )


# ---------------------------------------------------------------------------
# Batch bookkeeping
# ---------------------------------------------------------------------------

def start_batch(conn: psycopg.Connection, kind: str, gha_run_url: str | None = None) -> int:
    # clock_timestamp() (real wall-clock), NOT now() — the whole batch runs in one transaction,
    # where now() is constant, which would make every duration read 0.
    with conn.cursor() as cur:
        cur.execute(
            "insert into batches(kind, status, gha_run_url, started_at) "
            "values (%s, 'running', %s, clock_timestamp()) returning id",
            (kind, gha_run_url),
        )
        return cur.fetchone()["id"]


def finish_batch(conn: psycopg.Connection, batch_id: int, *, status: str = "ok",
                 error: str | None = None, **counts: int) -> None:
    fields = ["finished_at = clock_timestamp()", "status = %s", "error = %s"]
    params: list[Any] = [status, error]
    for col, val in counts.items():
        fields.append(f"{col} = %s")
        params.append(val)
    params.append(batch_id)
    with conn.cursor() as cur:
        cur.execute(f"update batches set {', '.join(fields)} where id = %s", params)
