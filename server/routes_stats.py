"""집계 API.

이 엔드포인트의 요점은 **수치만 내려준다**는 것이다. 통계 탭은 토큰 없이 열리고
남이 신고한 건까지 집계하는데, 원문에는 작업자가 말로 흘린 이름·소속이 섞여 있을
수 있다. 그래서 원문·장소·인적사항은 응답에 담지 않는다(사양 3.11).

구간 규칙은 기존 `js/stats.js`와 같아야 한다 — 최근 14일, 3시간 단위 8구간.
프론트엔드가 같은 모양을 그려 왔고, 여기서 바꾸면 화면이 어긋난다.

`submitted` 상태만 집계한다. 아직 확인 전인 초안이나 분석 실패 건이 통계에
들어가면 "제출된 신고 건수"라는 수치의 뜻이 흐려진다(사양 3.8).
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request

from .risk import RISK_LEVELS
from .routes_reports import get_db_conn

router = APIRouter(prefix="/api", tags=["stats"])

DAILY_DAYS = 14
HOUR_BIN = 3  # js/stats.js의 HOUR_BIN과 같아야 한다

_PERIOD_DAYS = {"week": 7, "month": 30}


def _parse(value: str) -> datetime:
    """저장된 ISO 문자열을 aware datetime으로 읽는다."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@router.get("/stats")
def get_stats(
    request: Request, period: str | None = None, conn=Depends(get_db_conn)
) -> dict:
    """집계 수치를 돌려준다. 토큰이 필요 없다.

    `period`는 관리자 화면의 주간·월간 토글이 쓴다(사양 3.9). 전체 데이터셋을
    그 창으로 좁히고 `total`이 그 안의 건수가 된다. `today`·`week`·`month`
    타일은 달력 기준 고정 창이라 `period`와 무관하다 — 타일은 "데이터가 얼마나
    최근인가"를 답하는 자리고, 토글과 함께 움직이면 뜻이 흐려진다.
    """
    # 시각은 UTC로 저장되지만 '오늘'과 '시간대' 구간은 현장 시간대로 나눈다 —
    # UTC로 나누면 KST 오전 9시 신고가 0~3시 칸에 들어간다.
    site_tz = ZoneInfo(request.app.state.settings.timezone_name)
    now = datetime.now(timezone.utc)
    today = now.astimezone(site_tz).date()

    rows = conn.execute(
        "SELECT created_at, risk, category FROM reports WHERE status = 'submitted'"
    ).fetchall()
    records = [
        {
            "at": _parse(row["created_at"]),
            "local": _parse(row["created_at"]).astimezone(site_tz),
            "risk": row["risk"],
            "category": row["category"],
        }
        for row in rows
    ]

    window_days = _PERIOD_DAYS.get(period or "")
    if window_days is not None:
        since = now - timedelta(days=window_days)
        scoped = [r for r in records if r["at"] >= since]
    else:
        scoped = records

    def count_since(days: int) -> int:
        since = now - timedelta(days=days)
        return sum(1 for r in records if r["at"] >= since)

    daily_counts: dict[str, int] = {}
    for record in scoped:
        key = record["local"].date().isoformat()
        daily_counts[key] = daily_counts.get(key, 0) + 1

    daily = [
        {
            "date": (today - timedelta(days=offset)).isoformat(),
            "value": daily_counts.get((today - timedelta(days=offset)).isoformat(), 0),
        }
        for offset in range(DAILY_DAYS - 1, -1, -1)
    ]

    bins = [0] * (24 // HOUR_BIN)
    for record in scoped:
        bins[record["local"].hour // HOUR_BIN] += 1
    hourly = [
        {"from": i * HOUR_BIN, "to": (i + 1) * HOUR_BIN, "value": value}
        for i, value in enumerate(bins)
    ]

    category_counts: dict[str, int] = {}
    for record in scoped:
        label = record["category"] or "기타"
        category_counts[label] = category_counts.get(label, 0) + 1
    category = sorted(
        ({"label": label, "value": value} for label, value in category_counts.items()),
        key=lambda item: item["value"],
        reverse=True,
    )

    # 위험도는 세 등급을 항상 다 내려준다 — 0건인 등급이 차트에서 사라지면
    # "아직 안 들어왔다"와 "집계에서 빠졌다"를 구분할 수 없다.
    risk_counts = {level: 0 for level in RISK_LEVELS}
    for record in scoped:
        if record["risk"] in risk_counts:
            risk_counts[record["risk"]] += 1
    risk = [{"label": level, "value": risk_counts[level]} for level in RISK_LEVELS]

    return {
        "total": len(scoped),
        "today": sum(1 for r in records if r["local"].date() == today),
        "week": count_since(7),
        "month": count_since(30),
        "daily": daily,
        "category": category,
        "hourly": hourly,
        "risk": risk,
    }
