"""집계 API 테스트.

이 엔드포인트의 요점은 수치만 내려준다는 것이다 — 통계 탭은 토큰 없이 열리고
남이 신고한 건까지 집계하므로, 원문이나 인적사항이 섞이면 아무에게나 전원의
신고 내용이 내려간다(사양 3.11).
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

NOW = datetime.now(timezone.utc)
# 집계의 날짜 구간은 현장 시간대(기본 Asia/Seoul) 기준이다 — UTC 날짜로 기대하면
# KST 오전에 돌릴 때 하루 어긋난다.
SITE_TZ = ZoneInfo("Asia/Seoul")
TODAY = NOW.astimezone(SITE_TZ).date()


@pytest.fixture
def submitted_reports(insert_report):
    """오늘 2건, 3일 전 1건 — 위험도 상/중/하 각 1건."""
    return [
        insert_report(created_at=NOW, risk="상"),
        insert_report(created_at=NOW, risk="중"),
        insert_report(created_at=NOW - timedelta(days=3), risk="하"),
    ]


@pytest.fixture
def draft_report(insert_report):
    return insert_report(created_at=NOW, status="draft", risk=None)


def test_stats_requires_no_token(client):
    assert client.get("/api/stats").status_code == 200


def test_stats_response_contains_no_content_or_identity(
    client, insert_report
):
    insert_report(
        created_at=NOW,
        content="박민수가 난간에서 넘어질 뻔함",
        reporter={"org": "두원기업", "name": "박민수", "role": "축로공", "count": 3},
    )
    resp = client.get("/api/stats")
    # 응답이 실제로 그 신고를 집계했는지 먼저 확인한다 — 404/500의 본문에는
    # 당연히 이름이 없으므로, 그것만 보면 아무것도 증명하지 못한다.
    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    text = resp.text
    assert "박민수" not in text
    assert "난간" not in text
    assert "location" not in text
    assert "content" not in text


def test_stats_counts_only_submitted(client, submitted_reports, draft_report):
    assert client.get("/api/stats").json()["total"] == len(submitted_reports)


def test_daily_has_fourteen_buckets_ending_today(client, submitted_reports):
    daily = client.get("/api/stats").json()["daily"]
    assert len(daily) == 14
    assert daily[-1]["date"] == TODAY.isoformat()
    assert daily[0]["date"] == (TODAY - timedelta(days=13)).isoformat()


def test_daily_buckets_count_their_own_day(client, submitted_reports):
    daily = {d["date"]: d["value"] for d in client.get("/api/stats").json()["daily"]}
    assert daily[TODAY.isoformat()] == 2
    assert daily[(TODAY - timedelta(days=3)).isoformat()] == 1


def test_hourly_has_eight_three_hour_buckets(client, submitted_reports):
    hourly = client.get("/api/stats").json()["hourly"]
    assert [h["from"] for h in hourly] == [0, 3, 6, 9, 12, 15, 18, 21]
    assert [h["to"] for h in hourly] == [3, 6, 9, 12, 15, 18, 21, 24]


def test_risk_distribution_covers_three_levels(client, submitted_reports):
    risk = {r["label"]: r["value"] for r in client.get("/api/stats").json()["risk"]}
    assert set(risk) == {"상", "중", "하"}
    assert risk["상"] == 1 and risk["중"] == 1 and risk["하"] == 1


def test_category_counts_by_label(client, insert_report):
    insert_report(created_at=NOW, category="추락/넘어짐")
    insert_report(created_at=NOW, category="추락/넘어짐")
    insert_report(created_at=NOW, category="감전")
    category = {c["label"]: c["value"] for c in client.get("/api/stats").json()["category"]}
    assert category["추락/넘어짐"] == 2
    assert category["감전"] == 1


def test_tiles_count_their_windows(client, insert_report):
    insert_report(created_at=NOW)
    insert_report(created_at=NOW - timedelta(days=40))
    body = client.get("/api/stats").json()
    assert body["total"] == 2
    assert body["today"] == 1
    assert body["month"] == 1


def test_period_month_widens_the_window(client, insert_report):
    insert_report(created_at=NOW)
    insert_report(created_at=NOW - timedelta(days=20))
    week = client.get("/api/stats", params={"period": "week"}).json()["total"]
    month = client.get("/api/stats", params={"period": "month"}).json()["total"]
    assert month > week


def test_unknown_period_behaves_as_no_window(client, insert_report):
    insert_report(created_at=NOW - timedelta(days=200))
    assert client.get("/api/stats", params={"period": "foo"}).json()["total"] == 1


def test_empty_database_returns_zeroed_buckets(client):
    body = client.get("/api/stats").json()
    assert body["total"] == 0
    assert len(body["daily"]) == 14
    assert all(d["value"] == 0 for d in body["daily"])
    assert len(body["hourly"]) == 8
    assert {r["label"] for r in body["risk"]} == {"상", "중", "하"}
