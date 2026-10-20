import pytest
from server.masking import mask_name, format_identity


@pytest.mark.parametrize("name,expected", [
    ("박민수", "박 ○○"),
    ("김민", "김 ○"),
    ("남궁현수", "남궁 ○○"),
    ("황보영", "황보 ○"),
    ("박", "박"),
    ("", ""),
    ("   ", ""),
    ("Kim Minsu", "K○○ ○○○○○"),
])
def test_mask_name_keeps_surname_only(name, expected):
    assert mask_name(name) == expected


def test_format_identity_appends_count_when_multiple():
    assert format_identity({"name": "박민수"}, 3) == "박 ○○ 등 3명"


def test_format_identity_omits_count_when_single():
    assert format_identity({"name": "박민수"}, 1) == "박 ○○"


def test_format_identity_without_name_falls_back_to_count():
    assert format_identity({"name": ""}, 3) == "외 3명"
