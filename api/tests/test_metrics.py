"""Tests for retrieval metrics — straightforward but worth pinning down
because off-by-one errors here distort every eval report.
"""

from __future__ import annotations

from eval.metrics import mean_reciprocal_rank, precision_at_k, recall_at_k


def test_precision_at_k_perfect():
    retrieved = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    expected = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    assert precision_at_k(retrieved, expected, k=2) == 1.0


def test_precision_at_k_partial():
    retrieved = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/x"]
    expected = ["https://docs.anthropic.com/a"]
    assert precision_at_k(retrieved, expected, k=2) == 0.5


def test_recall_at_k_full():
    retrieved = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    expected = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    assert recall_at_k(retrieved, expected, k=5) == 1.0


def test_recall_at_k_partial():
    retrieved = ["https://docs.anthropic.com/a"]
    expected = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    assert recall_at_k(retrieved, expected, k=5) == 0.5


def test_mrr_first_position():
    retrieved = ["https://docs.anthropic.com/a", "https://docs.anthropic.com/b"]
    expected = ["https://docs.anthropic.com/a"]
    assert mean_reciprocal_rank(retrieved, expected) == 1.0


def test_mrr_third_position():
    retrieved = [
        "https://docs.anthropic.com/x",
        "https://docs.anthropic.com/y",
        "https://docs.anthropic.com/target",
    ]
    expected = ["https://docs.anthropic.com/target"]
    assert mean_reciprocal_rank(retrieved, expected) == 1.0 / 3


def test_mrr_no_match():
    retrieved = ["https://docs.anthropic.com/x"]
    expected = ["https://docs.anthropic.com/y"]
    assert mean_reciprocal_rank(retrieved, expected) == 0.0


def test_url_normalization_ignores_anchors_and_trailing_slash():
    retrieved = ["https://docs.anthropic.com/a/#section"]
    expected = ["https://docs.anthropic.com/a"]
    assert precision_at_k(retrieved, expected, k=1) == 1.0
