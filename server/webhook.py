"""고위험 건 알림 훅 포인트.

사양 5장은 "위험도가 높게 분류된 건은 관리자에게 즉시 알림"을 요구하지만,
해커톤 범위에서 사내 메신저·푸시 인프라를 붙일 수는 없다(설계 비목표).

**이 파일이 그 교체 지점이다.** 실제 배포에서는 여기를 사내 메신저 API 호출로
바꾼다. 환경변수 `NEARMISS_WEBHOOK_URL`이 주어지면 그 주소로 POST하고, 없으면
로그만 남긴다 — 데모에서는 로그로 "알림이 나갔다"를 보여주면 된다.

알림 실패가 제출을 깨뜨리면 안 된다. 신고가 유실되는 것이 알림이 안 가는 것보다
훨씬 나쁘므로 모든 예외를 여기서 삼킨다.
"""
import logging

import httpx

from .config import Settings

logger = logging.getLogger(__name__)

_TIMEOUT = 5.0


def _payload(report: dict) -> dict:
    """알림 본문 — 관리자가 건을 찾아갈 최소 정보만 담는다.

    실명·원문은 넣지 않는다. 웹훅은 외부로 나가는 경로이고, 여기에 실명을 실으면
    단일 마스킹 경로(사양 3.4)를 우회해 버린다. 받는 쪽은 id로 들어와서 보면 된다.
    """
    return {
        "report_id": report.get("id"),
        "risk": report.get("risk"),
        "category": report.get("category"),
        "occurred_at": report.get("created_at"),
    }


async def notify_high_risk(report: dict, settings: Settings) -> None:
    """고위험 건 알림을 보낸다. 실패해도 예외를 올리지 않는다."""
    payload = _payload(report)

    if not settings.webhook_url:
        logger.info("고위험 신고 알림(웹훅 미설정): %s", payload)
        return

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(settings.webhook_url, json=payload)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        # 알림 실패를 제출 실패로 올리지 않는다.
        logger.warning("고위험 신고 알림 전송 실패: %s (%s)", payload, exc)
