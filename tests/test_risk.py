import pytest
from server.risk import normalize_risk, RISK_LEVELS, RISK_CRITERIA


@pytest.mark.parametrize("raw,expected", [
    ("상", "상"), ("중", "중"), ("하", "하"),
    (" 상 ", "상"), ("높음", "상"), ("보통", "중"), ("낮음", "하"),
    ("High", "상"), ("MEDIUM", "중"), ("low", "하"),
])
def test_normalize_risk_maps_known_variants(raw, expected):
    assert normalize_risk(raw) == expected


@pytest.mark.parametrize("raw", ["상/중", "매우 높음", "", None, 3, "unknown"])
def test_normalize_risk_returns_none_for_unrecognized(raw):
    assert normalize_risk(raw) is None


def test_risk_criteria_mentions_all_three_levels():
    for level in RISK_LEVELS:
        assert level in RISK_CRITERIA
