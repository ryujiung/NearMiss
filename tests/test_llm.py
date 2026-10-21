"""LLM 프로바이더 테스트.

사내 GPT API를 실제로 부르지 않고 httpx 수준에서 가로채 검증한다.
mock 모드는 데모 중 API가 죽었을 때의 비상 경로이기도 하므로,
픽스처가 Task 4의 파서를 그대로 통과하는지까지 확인한다.
"""
import json

import httpx
import pytest

from server.llm import LLMError, LiveProvider, MockProvider, get_provider
from server.prompt import parse_draft_response
from server.risk import RISK_LEVELS
from tests.conftest import settings


def test_get_provider_returns_mock_when_mode_is_mock():
    assert isinstance(get_provider(settings(llm_mode="mock")), MockProvider)


def test_get_provider_returns_live_by_default():
    assert isinstance(get_provider(settings()), LiveProvider)


@pytest.mark.asyncio
async def test_mock_provider_returns_parseable_draft():
    text = await MockProvider().complete([])
    assert parse_draft_response(text)["risk"] in RISK_LEVELS


@pytest.mark.asyncio
async def test_mock_provider_fixture_fills_every_bulletin_field():
    # mock은 데모 비상 경로다 — 칸이 비면 그때 빈 속보가 나간다.
    draft = parse_draft_response(await MockProvider().complete([]))
    assert draft["title"] and draft["location"] and draft["occurred_at"]
    assert draft["risk_reason"] and draft["category"]
    assert draft["overview"] and draft["countermeasures"]
    assert all(draft["causes"][k] for k in ("physical", "process", "organizational"))
    assert len(draft["questions"]) == 1


@pytest.mark.asyncio
async def test_live_provider_sends_bearer_auth_and_model(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    await LiveProvider(settings(api_key="k", model="m")).complete(
        [{"role": "user", "content": "x"}]
    )
    req = httpx_mock.get_request()
    assert req.headers["authorization"] == "Bearer k"
    assert json.loads(req.content)["model"] == "m"


@pytest.mark.asyncio
async def test_live_provider_posts_to_chat_completions_under_base_url(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    await LiveProvider(settings(api_base_url="https://gpt.internal/openai")).complete([])
    assert str(httpx_mock.get_request().url) == (
        "https://gpt.internal/openai/v1/chat/completions"
    )


@pytest.mark.asyncio
async def test_live_provider_uses_configurable_chat_path(httpx_mock):
    # OpenAI 호환이라도 경로 배치가 제각각이다. Gemini의 호환 엔드포인트는
    # /v1beta/openai/chat/completions 로 /v1 조각이 없어서, 경로를 박아두면
    # base URL만 바꿔서는 맞출 수 없다.
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    await LiveProvider(
        settings(
            api_base_url="https://generativelanguage.googleapis.com/v1beta/openai",
            chat_path="/chat/completions",
        )
    ).complete([])
    assert str(httpx_mock.get_request().url) == (
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    )


@pytest.mark.asyncio
async def test_live_provider_chat_path_defaults_to_openai_layout(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    await LiveProvider(settings(api_base_url="https://api.example.invalid")).complete([])
    assert str(httpx_mock.get_request().url) == (
        "https://api.example.invalid/v1/chat/completions"
    )


@pytest.mark.asyncio
async def test_live_provider_returns_message_content(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "본문"}}]})
    assert await LiveProvider(settings()).complete([]) == "본문"


@pytest.mark.asyncio
async def test_live_provider_raises_llm_error_on_http_error(httpx_mock):
    httpx_mock.add_response(status_code=500)
    with pytest.raises(LLMError):
        await LiveProvider(settings()).complete([])


@pytest.mark.asyncio
async def test_live_provider_raises_llm_error_on_timeout(httpx_mock):
    httpx_mock.add_exception(httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError):
        await LiveProvider(settings()).complete([])


@pytest.mark.asyncio
async def test_live_provider_raises_llm_error_on_unexpected_response_shape(httpx_mock):
    # 사내 API가 OpenAI 호환이 아닐 수 있다 — KeyError가 새어나가면 원인 파악이 어렵다.
    httpx_mock.add_response(json={"result": "엉뚱한 모양"})
    with pytest.raises(LLMError):
        await LiveProvider(settings()).complete([])


@pytest.mark.asyncio
async def test_live_provider_uses_configured_timeout(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    provider = LiveProvider(settings(request_timeout=7.5))
    await provider.complete([])
    assert provider.timeout == 7.5
