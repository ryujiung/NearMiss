"""속보 초안 프롬프트 조립과 GPT 응답 파싱.

사내 API의 JSON mode·function calling 지원 여부가 불확실하므로, 가장 보수적인
방법을 쓴다: 프롬프트로 JSON 출력을 지시하고(build_draft_prompt), 돌아온 텍스트를
파싱한다(parse_draft_response). 둘 다 순수 함수다 — I/O·HTTP·DB·환경변수를
건드리지 않는다.
"""
import json
import re
from datetime import datetime

from server.risk import RISK_CRITERIA, normalize_risk

# GPT 프롬프트에는 실명·사번을 넣지 않는다. 인적사항은 이 자리표시자로 치환해서
# 보내고, 응답을 받은 뒤 서버가 실명을 다시 끼워 넣는다(사양 3.4).
IDENTITY_PLACEHOLDER = "[당사자]"

# 원문에는 작업자가 말한 이름이 섞여 있을 수 있다(사양 3.4는 원문을 분석의 근거로
# 보아 치환하지 않기로 했다). 모델이 그 이름을 생성 칸에 옮겨 적으면 저장·렌더까지
# 흘러가 단일 마스킹 경로를 우회하므로, 프롬프트에서 명시적으로 금지한다.
# 상수로 둔 이유: 문구는 다듬을 수 있어도 규칙이 프롬프트에서 사라지지는 않도록
# 테스트가 이 상수의 존재를 고정한다.
NAME_REDACTION_RULE = (
    "- 신고 원문에 사람 이름이 섞여 있어도, 생성하는 어떤 칸에도 그 이름을 옮겨\n"
    f"  적지 마세요. 사람을 가리켜야 할 때는 {IDENTITY_PLACEHOLDER}로 쓰세요."
)

# 사고 유형은 js/classify.js의 7종 + 기타를 그대로 쓴다. 프론트엔드가 같은
# 어휘로 통계를 집계하므로, 한 글자라도 다르면 통계가 갈라진다.
CATEGORIES = (
    "추락/넘어짐",
    "끼임/협착",
    "충돌/부딪힘",
    "낙하/비래",
    "감전",
    "화재/폭발",
    "화학물질 노출",
    "기타",
)

_CAUSE_KEYS = ("physical", "process", "organizational")

# JSON 예시 자체에 중괄호가 들어 있어 str.format()을 쓸 수 없으므로, 치환은
# str.replace()로 한다. __NOW__만 build_draft_prompt 호출 시점에 채워진다.
_SYSTEM_TEMPLATE = """\
당신은 한국 제조 현장의 산업안전 담당자를 돕는 보조자입니다. 작업자가 현장에서
남긴 한 줄 신고를 읽고, 니어미스(아차사고) 속보 문서의 각 칸을 채웁니다.

반드시 아래 키를 모두 포함한 JSON 객체 하나만 출력하세요. 코드펜스나 다른 설명
문장을 덧붙이지 마세요.

{
  "title": "{장소} 니어미스 속보 형태의 제목",
  "risk": "상|중|하",
  "risk_reason": "위험도 분류의 한 줄 근거",
  "category": "사고 유형 7종 중 하나 또는 기타",
  "occurred_at": "발생 시각 (ISO 형식 또는 자연어)",
  "location": "발생 장소",
  "overview": ["HH:MM 무슨 일", "..."],
  "causes": {"physical": "물리적/환경적 원인", "process": "시스템/프로세스 원인", "organizational": "조직적 원인"},
  "countermeasures": ["대책 (즉시)", "대책 (~MM.DD.)"],
  "questions": ["빈 칸을 메우기 위한 확인 질문", "..."]
}

세부 지시:
- 위험도(risk)는 아래 기준을 따르세요. 이 기준 밖에서 임의로 판단하지 마세요.
__CRITERIA__
- category는 다음 중 정확히 하나를 그대로 쓰세요: __CATEGORIES__.
- occurred_at은 입력 시각을 기본값으로 삼되, 문장에 "어제 오후 2시"처럼 상대적인
  시간 표현이 있으면 그것을 기준으로 보정하세요. 현재 시각은 __NOW__입니다.
- overview는 시각별 서술입니다. 각 항목은 "HH:MM 무슨 일" 형태로 쓰고, 시각을 알
  수 없으면 추측한 시각을 붙이지 말고 시각 없이 서술하세요.
- countermeasures의 각 항목 끝에는 기한 표기를 붙이세요: 즉시 가능한 조치는
  "(즉시)", 날짜가 필요한 조치는 "(~MM.DD.)".
- 인적사항은 이미 __PLACEHOLDER__로 치환되어 있습니다. 실명이나 사번을 추측해서
  채우지 마세요.
__NAME_RULE__
- questions는 최대 2개입니다. 0개도 정상입니다. 질문은 장소·설비처럼 양식의 빈
  칸을 메우는 데에만 한정하세요. "더 자세히 말씀해주세요" 같은 열린 질문은
  금지합니다.
"""

_SYSTEM_MESSAGE_BASE = (
    _SYSTEM_TEMPLATE
    .replace("__CRITERIA__", RISK_CRITERIA)
    .replace("__CATEGORIES__", ", ".join(CATEGORIES))
    .replace("__PLACEHOLDER__", IDENTITY_PLACEHOLDER)
    .replace("__NAME_RULE__", NAME_REDACTION_RULE)
)


def build_draft_prompt(
    content: str,
    now: datetime,
    answers: dict[str, str] | None = None,
    locked: dict[str, str] | None = None,
) -> list[dict]:
    """속보 초안 생성을 위한 chat 메시지 목록을 만든다.

    - content: 작업자가 남긴 신고 원문. 실명이 섞여 있어도 이 함수는 치환하지
      않는다 — 원문은 분석의 근거이므로 과도한 치환이 품질을 해칠 수 있다는
      판단이다(사양 3.4). 인적사항을 별도로 넣을 때만 IDENTITY_PLACEHOLDER로
      치환해서 넣는다.
    - now: 호출 시각. 함수가 직접 시계를 읽지 않도록 인자로 받는다.
    - answers: 확인 질문과 그 답변. 재생성 요청일 때 "확정된 사실"로 주입한다.
    - locked: 작업자가 이미 손으로 고친 칸. 재생성 결과가 이 값을 덮지 않도록
      "확정된 사실"로 주입한다(사양 3.5).
    """
    system_content = _SYSTEM_MESSAGE_BASE.replace("__NOW__", now.isoformat())

    user_lines = [
        f"신고 원문: {content}",
        f"입력 시각: {now.isoformat()}",
        f"당사자: {IDENTITY_PLACEHOLDER}",
    ]

    if answers:
        user_lines.append("확인 질문에 대한 답변(확정된 사실):")
        for question, answer in answers.items():
            user_lines.append(f"- {question} → {answer}")

    if locked:
        user_lines.append("작업자가 이미 확정한 칸(재생성 결과로 덮지 말 것):")
        for field, value in locked.items():
            user_lines.append(f"- {field}: {value}")

    return [
        {"role": "system", "content": system_content},
        {"role": "user", "content": "\n".join(user_lines)},
    ]


class DraftParseError(Exception):
    """응답에서 복원 가능한 JSON을 찾지 못했을 때 던진다."""


def _extract_json_text(text: str) -> str:
    """응답 텍스트에서 JSON 객체로 보이는 부분을 뽑아낸다.

    처리하는 포장 형태:
    - 순수 JSON 객체 그대로
    - ```json ... ``` / ``` ... ``` 코드펜스로 감싸인 경우
    - 앞뒤에 설명 문장이 붙은 경우 (첫 '{'부터 마지막 '}'까지를 취한다)

    이 세 가지 외의 입력(JSON 자체가 없는 문장 등)은 복원하지 않는다 — 문자를
    더 벗겨내는 식의 "똑똑한" 복구는 그럴듯하지만 틀린 보고서를 만들 위험이
    있으므로 여기서 멈춘다.
    """
    fence_match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1)

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise DraftParseError("응답에서 JSON 객체를 찾을 수 없습니다.")

    return text[start:end + 1]


def _strip_trailing_commas(json_text: str) -> str:
    """`,}` / `,]` 형태의 후행 쉼표를 제거한다."""
    return re.sub(r",\s*([}\]])", r"\1", json_text)


def _as_str(value) -> str:
    """문자열이 아닌 값(None, 숫자 등)은 빈 문자열로 취급한다."""
    return value if isinstance(value, str) else ""


def _as_list(value) -> list:
    """리스트가 아닌 값은 빈 리스트로 취급한다.

    예: questions가 문자열로 와버리면 list("질문")이 글자 단위로 쪼개져
    엉뚱한 결과가 되므로, 타입이 리스트일 때만 그대로 받는다.
    """
    return list(value) if isinstance(value, list) else []


def _as_dict(value) -> dict:
    """딕셔너리가 아닌 값은 빈 딕셔너리로 취급한다."""
    return value if isinstance(value, dict) else {}


def parse_draft_response(text: str) -> dict:
    """GPT 응답 텍스트를 속보 초안 dict로 파싱한다.

    키가 누락된 것과 JSON 자체를 복원할 수 없는 것은 서로 다른 실패다 — 전자는
    해당 칸을 빈 값으로 채우고, 후자만 DraftParseError를 던진다. 키가 있어도
    타입이 기대와 다르면(예: questions가 문자열) 같은 "빈 값" 취급을 한다 —
    모델이 보낸 값을 억지로 꿰맞추지 않는다.
    """
    json_text = _extract_json_text(text)
    json_text = _strip_trailing_commas(json_text)

    try:
        raw = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise DraftParseError(f"JSON 파싱에 실패했습니다: {exc}") from exc

    if not isinstance(raw, dict):
        raise DraftParseError("JSON 객체가 아닙니다.")

    causes_raw = _as_dict(raw.get("causes"))
    causes = {key: _as_str(causes_raw.get(key)) for key in _CAUSE_KEYS}

    return {
        "title": _as_str(raw.get("title")),
        "risk": normalize_risk(raw.get("risk")),
        "risk_reason": _as_str(raw.get("risk_reason")),
        "category": _as_str(raw.get("category")),
        "occurred_at": _as_str(raw.get("occurred_at")),
        "location": _as_str(raw.get("location")),
        "overview": _as_list(raw.get("overview")),
        "causes": causes,
        "countermeasures": _as_list(raw.get("countermeasures")),
        "questions": _as_list(raw.get("questions"))[:2],
    }
