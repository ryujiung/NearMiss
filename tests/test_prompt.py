from datetime import datetime

import pytest

from server.prompt import build_draft_prompt, parse_draft_response, DraftParseError, IDENTITY_PLACEHOLDER
from server.risk import RISK_CRITERIA

NOW = datetime(2026, 10, 20, 14, 30)


def test_prompt_embeds_risk_criteria_from_single_source():
    msgs = build_draft_prompt("3층 계단 난간 헐거움", now=NOW)
    assert RISK_CRITERIA in "".join(m["content"] for m in msgs)


def test_prompt_never_contains_real_name():
    msgs = build_draft_prompt("박민수가 미끄러질 뻔함", now=NOW)
    joined = "".join(m["content"] for m in msgs)
    assert IDENTITY_PLACEHOLDER in joined


def test_prompt_includes_answers_and_locked_fields_as_facts():
    msgs = build_draft_prompt("난간 헐거움", now=NOW,
                              answers={"장소가 어디인가요?": "2공장 3층"},
                              locked={"location": "본관 3층"})
    joined = "".join(m["content"] for m in msgs)
    assert "2공장 3층" in joined and "본관 3층" in joined


@pytest.mark.parametrize("wrapped", [
    '{"risk": "상"}',
    '```json\n{"risk": "상"}\n```',
    '```\n{"risk": "상"}\n```',
    '다음과 같이 분석했습니다.\n{"risk": "상"}\n이상입니다.',
    '{"risk": "상",}',
])
def test_parse_draft_response_unwraps_common_packagings(wrapped):
    assert parse_draft_response(wrapped)["risk"] == "상"


def test_parse_draft_response_normalizes_risk():
    assert parse_draft_response('{"risk": "높음"}')["risk"] == "상"


def test_parse_draft_response_drops_unrecognized_risk():
    assert parse_draft_response('{"risk": "상/중"}')["risk"] is None


def test_parse_draft_response_caps_questions_at_two():
    out = parse_draft_response('{"questions": ["a", "b", "c"]}')
    assert len(out["questions"]) == 2


def test_parse_draft_response_raises_when_no_json_present():
    with pytest.raises(DraftParseError):
        parse_draft_response("죄송합니다, 분석할 수 없습니다.")


def test_parse_draft_response_fills_missing_keys_with_empty_values():
    out = parse_draft_response('{"risk": "중"}')
    assert out["overview"] == [] and out["causes"]["physical"] == ""
