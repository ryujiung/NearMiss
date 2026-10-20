"""위험도 등급과 분류 기준.

위험도 값은 '상' / '중' / '하' 세 개뿐이다. 미분류 상태는 값이 아니라 status로
표현하므로, 인식하지 못한 입력은 네 번째 값이 아니라 None을 돌려준다(추측하지 않는다).

RISK_CRITERIA는 사양 3.3의 기준 문면이 유일하게 존재하는 곳이다. 현장 담당자
인터뷰로 기준이 보정될 때 고칠 자리가 하나이도록, 이 문면을 다른 파일(특히
server/prompt.py)에 복사하지 않는다 — 프롬프트는 이 상수를 그대로 읽어간다.
"""

RISK_LEVELS = ("상", "중", "하")

RISK_CRITERIA = """\
- 상 — 그 상황이 조금만 달랐으면 사망·중상으로 이어질 수 있었던 건. 중량물 낙하·전도, 추락, 감전, 폭발·화재, 밀폐공간, 중장비 협착.
- 중 — 부상 가능성은 분명하지만 사망·중상까지 이어지기 어려운 건. 미끄러짐, 경량물 낙하, 베임, 화학물질 소량 접촉.
- 하 — 즉각적 부상 위험은 낮으나 방치하면 위험이 커지는 상태. 정리정돈 불량, 표지 훼손, 통로 적치.
판단이 갈리는 경우는 높은 쪽으로 분류한다(안전 보수성).\
"""

# 각 등급으로 정규화되는 표현들. 공백 제거·대소문자 무시 후 이 집합과 비교한다.
_ALIASES = {
    "상": {"상", "높음", "high"},
    "중": {"중", "보통", "medium"},
    "하": {"하", "낮음", "low"},
}


def normalize_risk(value) -> str | None:
    """위험도 원시값을 '상'/'중'/'하' 중 하나로 정규화한다.

    인식하지 못한 값(복수 등급 표기, 숫자, None, 빈 문자열, 알 수 없는 단어 등)은
    모두 None이다 — 추측해서 세 값 중 하나로 끼워 맞추지 않는다. 예외를 던지지 않는다.
    """
    if not isinstance(value, str):
        return None

    normalized = value.strip().lower()
    if not normalized:
        return None

    for level, aliases in _ALIASES.items():
        if normalized in aliases:
            return level
    return None
