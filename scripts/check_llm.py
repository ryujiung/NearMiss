"""실제 LLM 엔드포인트가 우리 프롬프트로 쓸 만한 속보를 돌려주는지 확인한다.

LLM을 붙일 때 가장 먼저 깨지는 것은 "연결이 되는가"가 아니라 "우리가 요구한
모양으로 돌려주는가"다. 그래서 핑을 보내는 대신 **실제 프롬프트를 그대로** 던지고
파서를 통과시켜 본다.

실행:
    python -m scripts.check_llm                      # .env 설정 그대로
    python -m scripts.check_llm --model gemini-2.0-flash
    python -m scripts.check_llm --try-models         # 후보 모델을 차례로 시도

키는 환경변수(NEARMISS_API_KEY)에서만 읽는다 — 인자로 받지 않는다.
"""
import argparse
import asyncio
import os
import sys
from dataclasses import replace
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.config import get_settings  # noqa: E402
from server.llm import LLMError, LiveProvider  # noqa: E402
from server.prompt import DraftParseError, build_draft_prompt, parse_draft_response  # noqa: E402
from server.risk import RISK_LEVELS  # noqa: E402

# 과제정의서 5장의 예시 입력. 현장 작업자가 말하듯 쓴 한 문장.
SAMPLE = "3층 계단 난간 헐거움, 넘어질 뻔함"

# Gemini 후보들. 모델 이름은 생각보다 자주 사라진다 — gemini-2.0-flash는 이미
# "no longer available"이다. 그래서 차례로 시도하고, 쓸 이름을 알려준다.
#
# `-latest` 계열은 일부러 넣지 않는다. 데모 전날 모델이 바뀌면 손쓸 수 없으므로
# 버전을 명시한 이름을 고정해서 쓴다.
CANDIDATES = [
    "gemini-2.5-flash",
    "gemini-3.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
]

_CAUSE_KEYS = ("physical", "process", "organizational")


def _report(draft: dict) -> list[str]:
    """돌아온 초안을 사람이 읽을 수 있게 펼친다."""
    lines = [
        f"  제목     : {draft['title'] or '(빈칸)'}",
        f"  위험도   : {draft['risk'] or '(정규화 실패)'}",
        f"  근거     : {draft['risk_reason'] or '(빈칸)'}",
        f"  유형     : {draft['category'] or '(빈칸)'}",
        f"  일시     : {draft['occurred_at'] or '(빈칸)'}",
        f"  장소     : {draft['location'] or '(빈칸)'}",
        "  발생개요 :",
    ]
    lines += [f"    - {line}" for line in draft["overview"]] or ["    (빈칸)"]
    lines.append("  발생원인 :")
    for key in _CAUSE_KEYS:
        lines.append(f"    [{key}] {draft['causes'][key] or '(빈칸)'}")
    lines.append("  재발방지 :")
    lines += [f"    · {line}" for line in draft["countermeasures"]] or ["    (빈칸)"]
    lines.append(f"  확인질문 : {draft['questions'] or '(없음)'}")
    return lines


def _grade(draft: dict) -> list[str]:
    """데모에 쓸 수 있는 품질인지 따진다 — 빈 칸이 있으면 빈 속보가 나간다."""
    problems = []
    if draft["risk"] not in RISK_LEVELS:
        problems.append("위험도가 상/중/하로 정규화되지 않았다")
    for name in ("title", "risk_reason", "category", "location"):
        if not draft[name]:
            problems.append(f"{name} 칸이 비었다")
    if not draft["overview"]:
        problems.append("발생개요가 비었다")
    if not draft["countermeasures"]:
        problems.append("재발방지 대책이 비었다")
    missing = [k for k in _CAUSE_KEYS if not draft["causes"][k]]
    if missing:
        problems.append(f"발생원인 {', '.join(missing)} 가 비었다")
    if len(draft["questions"]) > 2:
        problems.append("확인 질문이 2개를 넘었다")
    return problems


async def _try(settings, model: str) -> bool:
    print(f"\n── {model} ──")
    provider = LiveProvider(replace(settings, model=model))
    messages = build_draft_prompt(SAMPLE, now=datetime.now(timezone.utc))

    started = datetime.now(timezone.utc)
    try:
        text = await provider.complete(messages)
    except LLMError as exc:
        print(f"  호출 실패: {exc}")
        return False
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()

    try:
        draft = parse_draft_response(text)
    except DraftParseError as exc:
        print(f"  파싱 실패: {exc}")
        print(f"  돌아온 원문(앞 400자):\n{text[:400]}")
        return False

    print(f"  응답 {elapsed:.1f}초")
    print("\n".join(_report(draft)))

    problems = _grade(draft)
    if problems:
        print("  → 쓸 수 있으나 빈 칸이 있다:")
        for p in problems:
            print(f"     · {p}")
    else:
        print("  → 모든 칸이 채워졌다. 데모에 쓸 수 있다.")
    return True


async def main() -> int:
    parser = argparse.ArgumentParser(description="LLM 엔드포인트 실전 확인")
    parser.add_argument("--model", help="이 모델만 시도")
    parser.add_argument(
        "--try-models", action="store_true", help="후보 모델을 차례로 시도"
    )
    args = parser.parse_args()

    settings = get_settings()
    if not settings.api_key:
        print("NEARMISS_API_KEY가 비어 있습니다. .env에 키를 넣고 다시 실행해 주세요.")
        return 2
    if not settings.api_base_url:
        print("NEARMISS_API_BASE_URL이 비어 있습니다.")
        return 2

    print(f"base URL : {settings.api_base_url}")
    print(f"경로     : {settings.chat_path}")
    print(f"키       : 설정됨 ({len(settings.api_key)}자)")

    if args.model:
        models = [args.model]
    elif args.try_models:
        models = CANDIDATES
    else:
        if not settings.model:
            print("NEARMISS_MODEL이 비어 있습니다. --try-models 로 후보를 시도해 보세요.")
            return 2
        models = [settings.model]

    for model in models:
        if await _try(settings, model):
            print(f"\n이 모델을 쓰려면 .env에 NEARMISS_MODEL={model}")
            return 0

    print("\n시도한 모델이 모두 실패했습니다.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
