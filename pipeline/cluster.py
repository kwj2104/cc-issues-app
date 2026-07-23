"""Duplicate clustering — TF-IDF + chunked cosine + union-find connected components.

Over all open issues (ineligible rows still credit their clusters). Cluster ids are NOT
stable identifiers — they are current-state grouping, recomputed nightly. Interval syncs
attach new/changed docs to the nearest existing cluster provisionally; exact membership
settles on the next full recluster.

Determinism: no randomness; given the same docs + config, the grouping is reproducible.
Cluster id for a component is the smallest issue number in it (deterministic, meaningful).
"""

from __future__ import annotations

from typing import Any, Sequence

from sklearn.feature_extraction.text import TfidfVectorizer

_BLOCK = 1000  # rows per cosine block (≤2 GB RAM per spec)


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:  # path compression
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def _vectorizer(cfg: dict[str, Any]) -> TfidfVectorizer:
    cl = cfg["clustering"]
    return TfidfVectorizer(
        ngram_range=tuple(cl["ngram_range"]),
        min_df=cl["min_df"],
        max_df=cl["max_df"],
        stop_words="english",
        lowercase=True,
    )


def recluster(numbers: Sequence[int], docs: Sequence[str],
              cfg: dict[str, Any]) -> dict[int, tuple[int, int]]:
    """Full recluster. Returns {issue_number: (cluster_id, cluster_size)}.

    Singletons included (their own id, size 1). Empty/degenerate corpora degrade to all
    singletons rather than raising.
    """
    n = len(numbers)
    if n == 0:
        return {}
    if n == 1:
        return {numbers[0]: (numbers[0], 1)}

    threshold = cfg["clustering"]["similarity_threshold"]
    try:
        X = _vectorizer(cfg).fit_transform(docs)  # csr, L2-normalized rows
    except ValueError:
        # Empty vocabulary (e.g. all-stopword docs) → everything is a singleton.
        return {num: (num, 1) for num in numbers}

    uf = _UnionFind(n)
    Xt = X.T
    for start in range(0, n, _BLOCK):
        block = X[start : start + _BLOCK] @ Xt  # (b × n) cosine sims, sparse
        block = block.tocoo()
        for local_i, j, v in zip(block.row, block.col, block.data):
            gi = start + local_i
            if gi < j and v >= threshold:
                uf.union(gi, j)

    # Component -> members, then id = min issue number in the component.
    comp_members: dict[int, list[int]] = {}
    for idx in range(n):
        comp_members.setdefault(uf.find(idx), []).append(idx)

    out: dict[int, tuple[int, int]] = {}
    for members in comp_members.values():
        member_numbers = [numbers[i] for i in members]
        cid = min(member_numbers)
        size = len(members)
        for num in member_numbers:
            out[num] = (cid, size)
    return out


def assign_provisional(existing_numbers: Sequence[int], existing_docs: Sequence[str],
                       existing_cluster: dict[int, tuple[int, int]],
                       new_numbers: Sequence[int], new_docs: Sequence[str],
                       cfg: dict[str, Any]) -> dict[int, tuple[int, int]]:
    """Provisional nearest-cluster assignment for interval syncs.

    Vectorize new/changed docs against the existing corpus vocabulary; attach each to the
    nearest existing doc's cluster when similarity ≥ threshold, else make it a singleton.
    Exact membership (and cluster_size growth) settles on the next full recluster.
    Returns {new_number: (cluster_id, cluster_size)}.
    """
    if not new_numbers:
        return {}
    if not existing_numbers:
        # No corpus to attach to — everything is its own singleton.
        return {num: (num, 1) for num in new_numbers}

    threshold = cfg["clustering"]["similarity_threshold"]
    vec = _vectorizer(cfg)
    try:
        Xe = vec.fit_transform(existing_docs)
        Xn = vec.transform(new_docs)
    except ValueError:
        return {num: (num, 1) for num in new_numbers}

    sims = Xn @ Xe.T  # (new × existing)
    out: dict[int, tuple[int, int]] = {}
    for row_i, num in enumerate(new_numbers):
        row = sims.getrow(row_i)
        if row.nnz == 0:
            out[num] = (num, 1)
            continue
        best_local = row.indices[row.data.argmax()]
        best_sim = row.data.max()
        if best_sim >= threshold:
            neighbor = existing_numbers[best_local]
            cid, size = existing_cluster.get(neighbor, (neighbor, 1))
            out[num] = (cid, size + 1)  # provisional bump; nightly recluster corrects
        else:
            out[num] = (num, 1)
    return out
