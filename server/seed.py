"""데모 시드 스크립트.

통계와 관리자 목록이 비어 있으면 데모에서 보여줄 게 없다. 이 스크립트는 미리
만들어둔 속보 초안을 그대로 넣는다 — **AI를 호출하지 않는다.** 데모 직전에
사내 API 비용·시간을 쓰지 않기 위해서다.

날짜는 실행 시점 기준 상대 일수로 계산한다. 고정 날짜를 박으면 다음 주에 열었을
때 차트가 전부 비어 보인다.

실행:
    python -m server.seed            # 넣기(멱등 — 두 번 돌려도 중복되지 않음)
    python -m server.seed --reset    # 기존 신고를 지우고 새로 넣기
"""
import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from . import db as db_module
from .config import get_settings

_FIXTURE = Path(__file__).parent / "fixtures" / "seed_reports.json"

_CAUSE_KEYS = ("physical", "process", "organizational")


def load_fixture() -> list[dict]:
    """시드 원본을 읽는다."""
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _occurred_at(row: dict, now: datetime, site_tz: ZoneInfo) -> datetime:
    """상대 일수·시각을 실제 시각으로 바꾼다.

    픽스처의 hour는 현장 시간대의 시각이다("10시 20분에 일어났다"). 그 시각을
    현장 시간대로 만든 뒤 UTC로 바꿔 저장한다 — UTC로 그대로 만들면 데모에서
    시간대별 차트가 9시간 어긋난다.
    """
    day = (now.astimezone(site_tz) - timedelta(days=row["days_ago"])).date()
    local = datetime(
        day.year,
        day.month,
        day.day,
        row["hour"],
        row.get("minute", 0),
        tzinfo=site_tz,
    )
    return local.astimezone(timezone.utc)


def _build_draft(row: dict, at: datetime, site_tz: ZoneInfo) -> dict:
    """시드 행에서 속보 초안을 만든다.

    title과 sources는 여기서 유도한다 — 픽스처에 반복해 쓸 이유가 없고,
    유도 규칙이 한 곳에 있으면 모양이 어긋나지 않는다.
    """
    draft = {
        "title": f"{row['location']} 니어미스 속보",
        "risk": row["risk"],
        "risk_reason": row["risk_reason"],
        "category": row["category"],
        "occurred_at": at.astimezone(site_tz).strftime("%Y-%m-%d %H:%M"),
        "location": row["location"],
        "overview": row["overview"],
        "causes": {key: row["causes"][key] for key in _CAUSE_KEYS},
        "countermeasures": row["countermeasures"],
        "questions": [],
    }
    # 시드는 모두 AI가 채운 초안을 가정한다(작업자 수정 전 상태).
    draft["sources"] = {field: "ai" for field in draft}
    return draft


def _reporter_json(row: dict) -> str | None:
    if "name" in row or "org" in row:
        return json.dumps(
            {
                "org": row.get("org", ""),
                "name": row.get("name", ""),
                "role": row.get("role", ""),
                "count": row.get("count", 1),
            },
            ensure_ascii=False,
        )
    return None


def reset_reports(conn: sqlite3.Connection) -> None:
    """신고와 사진 기록을 모두 지운다 — 데모를 깨끗하게 다시 시작할 때."""
    conn.execute("DELETE FROM photos")
    conn.execute("DELETE FROM reports")
    conn.commit()


def seed_reports(
    conn: sqlite3.Connection, rows: list[dict], timezone_name: str = "Asia/Seoul"
) -> int:
    """시드 행들을 DB에 넣고 넣은(또는 이미 있던) 건수를 돌려준다.

    client_uuid를 `seed-<n>`으로 고정해 Task 1의 UNIQUE 제약이 중복 삽입을
    막는다 — 두 번 돌려도 건수가 늘지 않는다.
    """
    site_tz = ZoneInfo(timezone_name)
    now = datetime.now(timezone.utc)
    for index, row in enumerate(rows, start=1):
        at = _occurred_at(row, now, site_tz)
        draft = _build_draft(row, at, site_tz)
        db_module.insert_report(
            conn,
            {
                "id": f"seed-{index:03d}",
                "client_uuid": f"seed-{index:03d}",
                "reporter_id": "seed-device",
                "content": row["content"],
                "reporter_json": _reporter_json(row),
                "draft_json": json.dumps(draft, ensure_ascii=False),
                "risk": row["risk"],
                "risk_reason": row["risk_reason"],
                "category": row["category"],
                "status": "submitted",
                "acknowledged": False,
                "created_at": at.isoformat(),
                "updated_at": at.isoformat(),
            },
        )
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="데모용 니어미스 신고 시드")
    parser.add_argument(
        "--reset", action="store_true", help="기존 신고를 모두 지우고 새로 넣는다"
    )
    args = parser.parse_args()

    settings = get_settings()
    db_module.init_db(settings.db_path)
    conn = db_module.get_conn(settings.db_path)
    try:
        if args.reset:
            reset_reports(conn)
        count = seed_reports(conn, load_fixture(), settings.timezone_name)
    finally:
        conn.close()
    print(f"시드 {count}건 완료 → {settings.db_path}")


if __name__ == "__main__":
    main()
