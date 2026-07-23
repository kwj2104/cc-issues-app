"""Text prep, feature formula hand-checks, junk filter, eligibility + stale-rescue."""

from __future__ import annotations

from datetime import datetime, timezone
from math import log2

import pytest

from pipeline import features as feat
from pipeline.db import load_config

CFG = load_config()
UTC = timezone.utc


def dt(y, m, d):
    return datetime(y, m, d, tzinfo=UTC)


# ------------------------------- text prep -------------------------------

def test_clean_body_strips_fences_comments_urls_images():
    body = (
        "Real text here.\n"
        "```python\nprint('secret code')\n```\n"
        "<!-- template boilerplate -->\n"
        "![screenshot](https://example.com/a.png)\n"
        "See https://example.com/page for details."
    )
    out = feat.clean_body(body)
    assert "secret code" not in out
    assert "boilerplate" not in out
    assert "screenshot" not in out
    assert "example.com" not in out
    assert "Real text here." in out
    assert "for details." in out


def test_clean_body_drops_template_headers_keeps_content():
    body = "### Environment\nmacOS 15\n### What happened\nit crashed"
    out = feat.clean_body(body)
    assert "Environment" not in out
    assert "What happened" not in out
    assert "macOS 15" in out
    assert "it crashed" in out


def test_clean_body_collapses_whitespace_and_handles_null():
    assert feat.clean_body(None) == ""
    assert feat.clean_body("") == ""
    assert feat.clean_body("a\n\n\n   b\t\tc") == "a b c"


def test_body_lead_truncates():
    body = "x " * 2000  # 4000 chars pre-clean → collapses but stays long
    lead = feat.body_lead(body, body_lead_chars=1500)
    assert len(lead) <= 1500


def test_cluster_document_doubles_title():
    doc = feat.cluster_document("Title", "lead body")
    assert doc == "Title Title lead body"


# ----------------------------- feature math ------------------------------

def _issue(**over):
    base = dict(
        number=1, title="benign title", body_lead="benign description of behavior",
        labels=[], state="open", created_at=dt(2026, 7, 1), comments=1,
        reactions_total=3, reactions_plus1=2, active_lock_reason=None,
    )
    base.update(over)
    return base


def test_feature_formulas_hand_check():
    # created 2026-07-01, as_of 2026-07-31 → exactly 30 days.
    f = feat.compute_features(_issue(), cluster_size=1, as_of=dt(2026, 7, 31), cfg=CFG)
    assert f["age_days"] == pytest.approx(30.0)
    assert f["f_reactions"] == pytest.approx(log2(4))       # log2(1+3)=2
    assert f["f_comments"] == pytest.approx(log2(2))        # log2(1+1)=1
    assert f["f_velocity"] == pytest.approx(log2(5))        # log2(1+30*4/30)
    assert f["f_severity"] == pytest.approx(0.0)
    assert f["f_demand"] == pytest.approx(0.0)
    # rate = 3*log2(4) + 1*log2(2) + 2*0 + 2*log2(1) = 7
    assert f["rate_score"] == pytest.approx(7.0)
    # retrieval = 3*2 + 1*1 + 2*log2(5) + 2*0 + 1*0 + 2*0
    assert f["retrieval_score"] == pytest.approx(6 + 1 + 2 * log2(5))


def test_severity_label_weights_and_regex_bonus():
    # data-loss(3.0) + one regex bonus (1.0) for "crash" in title = 4.0
    f = feat.compute_features(
        _issue(title="app crash on launch", labels=["data-loss"]),
        cluster_size=1, as_of=dt(2026, 7, 31), cfg=CFG,
    )
    assert f["f_severity"] == pytest.approx(4.0)


def test_severity_caps():
    # data-loss(3)+area:security(2)+regression(2)=7 → capped at 5.0
    f = feat.compute_features(
        _issue(labels=["data-loss", "area:security", "regression"]),
        cluster_size=1, as_of=dt(2026, 7, 31), cfg=CFG,
    )
    assert f["f_severity"] == pytest.approx(5.0)


def test_regex_bonus_added_at_most_once():
    # two regex hits ("crash", "hang") still add the bonus a single time
    one = feat.f_severity("crash", "", [], CFG)
    two = feat.f_severity("crash and hang", "", [], CFG)
    assert one == two == pytest.approx(CFG["severity"]["regex_bonus"])


def test_demand_requires_label_and_min_reactions():
    assert feat.f_demand(["enhancement"], 10, CFG) == pytest.approx(log2(10))
    assert feat.f_demand(["enhancement"], 4, CFG) == 0.0   # below min_reactions
    assert feat.f_demand(["bug"], 100, CFG) == 0.0         # no demand label


def test_cluster_size_feeds_rate_and_retrieval():
    f = feat.compute_features(_issue(), cluster_size=8, as_of=dt(2026, 7, 31), cfg=CFG)
    # +2*log2(8)=+6 to rate vs the size-1 baseline (7.0)
    assert f["rate_score"] == pytest.approx(7.0 + 2 * log2(8))


# ------------------------------- junk filter -----------------------------

def test_junk_filter_all_conditions():
    assert feat.is_junk(40, 0, 0, 7.0, CFG) is True
    assert feat.is_junk(41, 0, 0, 7.0, CFG) is False   # body too long
    assert feat.is_junk(40, 1, 0, 7.0, CFG) is False   # has a reaction
    assert feat.is_junk(40, 0, 1, 7.0, CFG) is False   # has a comment
    assert feat.is_junk(40, 0, 0, 6.9, CFG) is False   # too young


# ------------------ eligibility + stale-rescue boundary ------------------

def test_stale_rescue_boundary_9_vs_10():
    # only excluding label is 'stale': ≥10 reactions rescues, 9 does not
    assert feat.is_eligible("open", ["stale"], None, 10, False, CFG) is True
    assert feat.is_eligible("open", ["stale"], None, 9, False, CFG) is False


def test_stale_rescue_only_when_stale_is_sole_excluder():
    # stale + another excluding label → no rescue even with high engagement
    assert feat.is_eligible("open", ["stale", "duplicate"], None, 100, False, CFG) is False


def test_eligibility_excluders():
    assert feat.is_eligible("open", [], None, 0, False, CFG) is True
    assert feat.is_eligible("closed", [], None, 0, False, CFG) is False
    assert feat.is_eligible("open", ["question"], None, 0, False, CFG) is False
    assert feat.is_eligible("open", [], "spam", 0, False, CFG) is False
    assert feat.is_eligible("open", [], None, 0, True, CFG) is False   # junk
