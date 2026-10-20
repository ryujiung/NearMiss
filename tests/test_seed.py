"""데모 시드 스크립트 테스트.

통계와 관리자 목록이 비어 있으면 데모에서 보여줄 게 없다. 시드는 AI를 호출하지
않고 미리 만들어둔 초안을 넣는다 — 데모 직전에 사내 API 비용·시간을 쓰지 않기
위해서다.
"""
from server.db import list_reports
from server.risk import RISK_LEVELS
from server.seed import load_fixture, seed_reports


def test_seed_inserts_all_rows(tmp_db):
    assert seed_reports(tmp_db, load_fixture()) == len(load_fixture())


def test_seed_never_calls_llm(tmp_db, capture_provider):
    seed_reports(tmp_db, load_fixture())
    assert capture_provider.call_count == 0


def test_seeded_rows_are_submitted_and_classified(tmp_db):
    seed_reports(tmp_db, load_fixture())
    rows = list_reports(tmp_db)
    assert all(r["status"] == "submitted" for r in rows)
    assert all(r["risk"] in RISK_LEVELS for r in rows)


def test_seed_covers_all_three_risk_levels_and_recent_14_days(tmp_db):
    seed_reports(tmp_db, load_fixture())
    rows = list_reports(tmp_db)
    assert {r["risk"] for r in rows} == {"상", "중", "하"}
    assert len({r["created_at"][:10] for r in rows}) >= 7


def test_seed_is_idempotent(tmp_db):
    seed_reports(tmp_db, load_fixture())
    seed_reports(tmp_db, load_fixture())
    assert len(list_reports(tmp_db)) == len(load_fixture())


def test_seed_has_between_20_and_30_rows(tmp_db):
    assert 20 <= len(load_fixture()) <= 30


def test_seed_includes_the_task_definition_gwangyang_case(tmp_db):
    # 심사위원이 과제정의서 6장의 예시를 화면에서 알아볼 수 있어야 한다.
    seed_reports(tmp_db, load_fixture())
    rows = list_reports(tmp_db)
    gwangyang = [r for r in rows if "Settling Chamber" in (r["content"] or "")]
    assert len(gwangyang) == 1
    assert gwangyang[0]["risk"] == "상"


def test_seeded_rows_cover_every_accident_category(tmp_db):
    from server.prompt import CATEGORIES

    seed_reports(tmp_db, load_fixture())
    seeded = {r["category"] for r in list_reports(tmp_db)}
    assert seeded <= set(CATEGORIES), f"알 수 없는 유형: {seeded - set(CATEGORIES)}"
    # 유형별 차트가 한두 칸만 차 있으면 데모에서 볼 게 없다.
    assert len(seeded) >= 6


def test_seeded_rows_carry_a_full_bulletin(tmp_db):
    import json

    seed_reports(tmp_db, load_fixture())
    for row in list_reports(tmp_db):
        draft = json.loads(row["draft_json"])
        assert draft["title"] and draft["location"] and draft["risk_reason"]
        assert draft["overview"] and draft["countermeasures"]
        assert all(draft["causes"][k] for k in ("physical", "process", "organizational"))
        assert draft["sources"]["location"] == "ai"


def test_seed_dates_are_relative_to_now(tmp_db):
    # 고정 날짜를 박으면 다음 주에 차트가 비어 보인다.
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    seed_reports(tmp_db, load_fixture())
    site_tz = ZoneInfo("Asia/Seoul")
    newest = max(
        datetime.fromisoformat(r["created_at"]) for r in list_reports(tmp_db)
    )
    today_here = datetime.now(timezone.utc).astimezone(site_tz).date()
    assert newest.astimezone(site_tz).date() == today_here


def test_seed_hours_cluster_in_working_time(tmp_db):
    # created_at은 UTC로 저장되므로 현장 시간대로 바꿔서 본다 — 저장된 시 문자열을
    # 그대로 읽으면 9시간 어긋난 값을 검사하게 된다.
    from datetime import datetime
    from zoneinfo import ZoneInfo

    seed_reports(tmp_db, load_fixture())
    site_tz = ZoneInfo("Asia/Seoul")
    hours = [
        datetime.fromisoformat(r["created_at"]).astimezone(site_tz).hour
        for r in list_reports(tmp_db)
    ]
    daytime = [h for h in hours if 6 <= h < 21]
    assert len(daytime) >= len(hours) * 0.8


def test_reset_clears_existing_rows(tmp_db):
    from server.seed import reset_reports

    seed_reports(tmp_db, load_fixture())
    reset_reports(tmp_db)
    assert list_reports(tmp_db) == []
