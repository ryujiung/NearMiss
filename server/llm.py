"""LLM 프로바이더 — 사내 GPT API 호출과 mock 모드.

OpenAI 호환 API를 가정하고, 인증은 `Authorization: Bearer`를 쓴다. base URL·
경로·모델명·키는 모두 환경변수에서 온다 — 호환 API라도 경로 배치가 제각각이라
(예: Gemini는 `/v1beta/openai/chat/completions`) 경로를 박아두면 안 된다.

mock 모드(`NEARMISS_LLM_MODE=mock`)는 1급 경로다. 테스트에 필요하고, 사내망
밖에서 화면을 만들 때도 쓰고, 데모 중 API가 죽었을 때의 비상용이기도 하다.
그래서 실제 프로바이더와 완전히 같은 인터페이스를 구현한다.

이 모듈은 호출과 오류 변환만 담당한다. 프롬프트 조립과 응답 파싱은
`server/prompt.py`에 있다.
"""
import json
import os
import re
from pathlib import Path
from typing import Protocol

import httpx

from server.config import Settings

_MOCK_FIXTURE = Path(__file__).parent / "fixtures" / "mock_draft.json"


class LLMError(Exception):
    """LLM 호출이 실패했을 때 던진다.

    HTTP 오류·타임아웃·예상과 다른 응답 모양을 모두 이 하나로 모은다 —
    호출하는 쪽(초안 생성 잡)이 알아야 하는 것은 "응답을 얻지 못했다"는
    사실뿐이고, 어느 쪽이든 처리가 같기 때문이다.
    """


class LLMProvider(Protocol):
    """chat 메시지 목록을 받아 응답 본문 문자열을 돌려준다."""

    async def complete(self, messages: list[dict]) -> str: ...


class LiveProvider:
    """사내 GPT API를 실제로 호출하는 프로바이더."""

    def __init__(self, settings: Settings):
        self.base_url = settings.api_base_url.rstrip("/")
        self.api_key = settings.api_key
        self.model = settings.model
        self.timeout = settings.request_timeout
        self.chat_path = "/" + settings.chat_path.lstrip("/")

    async def complete(self, messages: list[dict]) -> str:
        url = f"{self.base_url}{self.chat_path}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={"model": self.model, "messages": messages},
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPError as exc:
            # 타임아웃·연결 실패·상태 코드 오류가 모두 여기로 들어온다.
            raise LLMError(f"LLM 호출에 실패했습니다: {exc}") from exc

        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            # 사내 API가 OpenAI 호환이 아닐 수 있다. 원시 KeyError가 위로 새어나가면
            # 원인을 짚기 어려우므로 같은 LLMError로 바꿔 던진다.
            raise LLMError(f"응답 모양이 예상과 다릅니다: {payload!r}") from exc


_CATEGORY_KEYWORDS = (
    ("추락/넘어짐", ("미끄", "넘어", "추락", "떨어져", "계단", "발판")),
    ("끼임/협착", ("끼", "협착", "말려")),
    ("충돌/부딪힘", ("부딪", "충돌", "접촉")),
    ("낙하/비래", ("낙하", "탈락", "전도", "쓰러", "떨어질", "비래", "무너")),
    ("감전", ("감전", "전선", "누전")),
    ("화재/폭발", ("화재", "불꽃", "폭발", "연기")),
    ("화학물질 노출", ("화학", "가스", "누출", "유해")),
)
def _derive_draft(messages: list[dict]) -> str:
    """신고 원문에서 규칙으로 초안을 만든다 — LLM 없이 입력 내용을 반영하는 mock."""
    user_text = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    content, now = user_text, ""
    for line in user_text.splitlines():
        if line.startswith("신고 원문:"):
            content = line[len("신고 원문:"):].strip()
        elif line.startswith("입력 시각:"):
            now = line[len("입력 시각:"):].strip()

    category = next((c for c, keys in _CATEGORY_KEYWORDS if any(k in content for k in keys)), "기타")
    sentences = [s.strip() for s in re.split(r"(?<=[.!?다요])\s+", content) if s.strip()]
    time_m = re.search(r"(오전|오후)?\s*(\d{1,2})시\s*(?:(\d{1,2})분)?", content)
    occurred = now
    if time_m and now:
        hour = int(time_m.group(2)) % 12 + (12 if time_m.group(1) == "오후" else 0)
        if not time_m.group(1) and int(time_m.group(2)) > 12:
            hour = int(time_m.group(2))
        occurred = f"{now[:10]} {hour:02d}:{int(time_m.group(3) or 0):02d}"
    loc_text = re.sub(r"(오늘|어제|오전|오후)?\s*\d{1,2}시\s*(\d{1,2}분)?\s*(쯤|경)?", " ", content)
    location = ""
    words = re.sub(r"[.,!?]", " ", loc_text).split()
    for i, w in enumerate(words):
        if re.search(r"(출입구|출입문|계단|라인|공장|챔버|구역|통로|설비|후드)", w) or re.fullmatch(r"\d+[가-힣]*실", w):
            picked = [w]
            for prev in reversed(words[max(0, i - 2):i]):
                if prev in ("오늘", "어제") or re.search(r"[이가은는을를에서]$", prev) and not re.search(r"(공장|라인|챔버|실)$", prev):
                    break
                picked.insert(0, prev)
            location = " ".join(picked)
            break
    location = re.sub(r"(에서|에|의|을|를|으로|로)$", "", location)
    risk = "상" if category in ("감전", "화재/폭발", "화학물질 노출", "낙하/비래", "끼임/협착") else "중"
    draft = {
        "title": f"{location + ' ' if location else ''}{category} 니어미스 속보",
        "risk": risk,
        "risk_reason": f"{category} 유형으로, 신고 내용상 인명 피해로 이어질 수 있어 {risk} 등급으로 분류",
        "category": category,
        "occurred_at": occurred,
        "location": location,
        "overview": sentences or [content],
        "causes": {
            "physical": "신고 내용 기준 설비·환경 상태 불량             가능성 (추정)",
                        "process": "작업 전·후 확인 절차 미흡 가능성 (추정)",
                        "organizational": "점검 주기와 책임 구분 미흡 가능성 (추정)",
        },
        "countermeasures": [
            "해당 위치 통행 통제 및 즉시 조치 (즉시)",
            "유사 설비·장소 일제 점검",
            "점검 주기와 책임 부서를 절차서에 명시",
        ],
        "questions": ["사고 시점에 주변에 있던 작업자는 없었나요?"],
    }
    return json.dumps(draft, ensure_ascii=False)


class MockProvider:
    """네트워크 없이 초안을 돌려주는 프로바이더.

    기본은 고정 픽스처다(테스트용). `NEARMISS_MOCK_FIXTURE=auto`이면 신고 원문을
    읽어 초안을 만들고, 파일명을 주면 fixtures 폴더의 그 파일을 쓴다.
    """

    async def complete(self, messages: list[dict]) -> str:
        name = os.environ.get("NEARMISS_MOCK_FIXTURE")
        if name == "auto":
            return _derive_draft(messages)
        path = _MOCK_FIXTURE.parent / Path(name).name if name else _MOCK_FIXTURE
        return path.read_text(encoding="utf-8")


def get_provider(settings: Settings) -> LLMProvider:
    """설정에 따라 프로바이더를 고른다."""
    if settings.llm_mode == "mock":
        return MockProvider()
    return LiveProvider(settings)
