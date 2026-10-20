"""속보 초안 생성 잡.

사내 API의 응답 지연을 모르는 전제이므로 초안 생성은 비동기로 돈다. 요청은
즉시 202로 돌아가고, 프론트엔드는 폴링으로 상태를 본다(사양 3.1).

잡 상태는 전부 DB의 `status` 컬럼에 쓴다. 메모리 딕셔너리에 들고 있으면
작업자가 초안 화면에서 새로고침했을 때 상태를 잃어버려, 폴링이 영원히 돌거나
신고가 영구 미분류로 남는다.

상태 전이:
    draft  → analyzing → ready    (정상)
    draft  → analyzing → failed   (호출·파싱 실패)
    failed → analyzing → ready    (사용자가 다시 시도)
"""
import json
import logging
from datetime import datetime, timezone

from . import db as db_module
from .config import Settings
from .llm import LLMError, get_provider
from .prompt import DraftParseError, build_draft_prompt, parse_draft_response

logger = logging.getLogger(__name__)

# 파싱 실패는 모델이 한 번 어긋난 것일 수 있어 한 번 더 받아본다. 전송 실패
# (HTTP 오류·타임아웃)는 즉시 재시도해도 나아지지 않으므로 재시도하지 않는다 —
# 그 경우의 재시도는 사용자·관리자의 '다시 분석' 버튼이다(사양 3.8).
_PARSE_RETRIES = 1


async def _ask_model(provider, messages) -> dict:
    """모델을 부르고 파싱한다. 파싱 실패만 1회 재시도한다."""
    last_error: DraftParseError | None = None
    for attempt in range(_PARSE_RETRIES + 1):
        text = await provider.complete(messages)
        try:
            return parse_draft_response(text)
        except DraftParseError as exc:
            last_error = exc
            logger.warning("초안 응답 파싱 실패 (%d회차): %s", attempt + 1, exc)
    raise last_error


async def run_draft_job(
    report_id: str, settings: Settings, *, answers: dict | None = None
) -> None:
    """한 건의 속보 초안을 생성해 DB에 쓴다.

    settings를 인자로 받는 이유: DB 경로와 프로바이더 설정이 앱마다 다를 수 있고,
    모듈 전역에서 읽으면 같은 프로세스에 앱이 여러 개 떠 있을 때 서로를 덮어쓴다.

    실패해도 content는 건드리지 않는다 — 신고 자체가 유실되면 "기록 누락 최소화"
    목표와 정면으로 충돌한다.
    """
    conn = db_module.get_conn(settings.db_path)
    try:
        row = db_module.get_report(conn, report_id)
        if row is None:
            logger.warning("초안 생성 대상 신고가 없습니다: %s", report_id)
            return

        db_module.update_report(
            conn, report_id, {"status": "analyzing", "draft_error": None}
        )

        messages = build_draft_prompt(
            row["content"],
            now=datetime.now(timezone.utc),
            answers=answers or None,
        )

        try:
            draft = await _ask_model(get_provider(settings), messages)
        except (LLMError, DraftParseError) as exc:
            db_module.update_report(
                conn, report_id, {"status": "failed", "draft_error": str(exc)}
            )
            return

        db_module.update_report(
            conn,
            report_id,
            {
                "draft_json": json.dumps(draft, ensure_ascii=False),
                "risk": draft.get("risk"),
                "risk_reason": draft.get("risk_reason"),
                "category": draft.get("category"),
                "status": "ready",
                "draft_error": None,
            },
        )
    finally:
        conn.close()
