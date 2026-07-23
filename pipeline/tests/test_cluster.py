"""Union-find clustering: near-duplicates group, distinct docs stay singletons."""

from __future__ import annotations

import copy

from pipeline import cluster as clust
from pipeline.db import load_config

# Permissive vectorizer params so the test exercises union-find + thresholding, not the
# max_df cutoff (which, on a tiny corpus, would drop the very tokens duplicates share).
CFG = copy.deepcopy(load_config())
CFG["clustering"].update({"min_df": 2, "max_df": 1.0, "similarity_threshold": 0.6})


def test_near_duplicates_cluster_and_singletons_stay_singletons():
    docs = {
        10: "permission dialog keeps popping up on every bash command run",
        11: "permission dialog keeps popping up on every bash command execution",
        12: "permission prompt popping up repeatedly for bash command run",
        20: "dark mode theme color contrast too low in the sidebar",
        21: "installer fails with node version mismatch on windows",
    }
    numbers = list(docs)
    result = clust.recluster(numbers, [docs[n] for n in numbers], CFG)

    # 10/11/12 share heavy vocabulary → one component, size 3, id = min number.
    assert result[10] == result[11] == result[12]
    assert result[10] == (10, 3)
    # distinct docs → their own singleton clusters
    assert result[20] == (20, 1)
    assert result[21] == (21, 1)


def test_empty_and_single():
    assert clust.recluster([], [], CFG) == {}
    assert clust.recluster([5], ["only one doc here"], CFG) == {5: (5, 1)}


def test_degenerate_corpus_all_singletons():
    # all-stopword docs → empty vocabulary → everything a singleton (no raise)
    res = clust.recluster([1, 2], ["the and of", "to a an"], CFG)
    assert res == {1: (1, 1), 2: (2, 1)}


def test_provisional_attaches_to_nearest_cluster():
    # min_df=1 here: the fixture corpus is only 2 docs (real corpus is ~12k); the point is
    # to exercise nearest-cluster attachment, not the min_df cutoff.
    cfg = copy.deepcopy(CFG)
    cfg["clustering"]["min_df"] = 1
    existing_numbers = [10, 20]
    existing_docs = [
        "permission dialog keeps popping up on every bash command run",
        "dark mode theme color contrast too low in the sidebar",
    ]
    existing_cluster = {10: (10, 3), 20: (20, 1)}
    new = clust.assign_provisional(
        existing_numbers, existing_docs, existing_cluster,
        [99], ["permission dialog popping up again for bash command run"], cfg,
    )
    cid, size = new[99]
    assert cid == 10          # attached to the permission-dialog cluster
    assert size == 4          # provisional bump over the existing size of 3
