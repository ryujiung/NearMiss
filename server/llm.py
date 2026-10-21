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


class MockProvider:
    """고정 픽스처를 돌려주는 프로바이더 — 네트워크를 쓰지 않는다."""

    async def complete(self, messages: list[dict]) -> str:
        return _MOCK_FIXTURE.read_text(encoding="utf-8")


def get_provider(settings: Settings) -> LLMProvider:
    """설정에 따라 프로바이더를 고른다."""
    if settings.llm_mode == "mock":
        return MockProvider()
    return LiveProvider(settings)
