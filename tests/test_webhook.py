"""고위험 건 웹훅과 관리자 미확인 큐 테스트.

사양 5장은 "위험도가 높게 분류된 건은 관리자에게 즉시 알림"을 요구하지만 해커톤
범위에서 사내 메신저를 붙일 수는 없다. 그래서 훅 포인트 하나와 화면에서 보이는
미확인 큐로 대신한다(사양 3.6).
"""
from datetime import datetime, timezone

import httpx
import pytest

from server.webhook import notify_high_risk
from tests.conftest import settings

ADMIN = {"Authorization": "Bearer test-admin-token"}
NOW = datetime.now(timezone.utc)


@pytest.mark.asyncio
async def test_webhook_posts_when_url_configured(httpx_mock):
    httpx_mock.add_response()
    await notify_high_risk(
        {"id": "r1", "risk": "상"}, settings(webhook_url="https://hook.invalid")
    )
    assert httpx_mock.get_request() is not None


@pytest.mark.asyncio
async def test_webhook_body_carries_id_and_risk(httpx_mock):
    httpx_mock.add_response()
    await notify_high_risk(
        {"id": "r1", "risk": "상"}, settings(webhook_url="https://hook.invalid")
    )
    body = httpx_mock.get_request().read().decode()
    assert "r1" in body and "상" in body


@pytest.mark.asyncio
async def test_webhook_body_carries_no_real_name(httpx_mock):
    # 웹훅은 사내 메신저로 나가는 외부 경로다 — 실명이 섞이면 단일 마스킹
    # 경로를 우회한다.
    httpx_mock.add_response()
    await notify_high_risk(
        {"id": "r1", "risk": "상", "reporter": {"name": "박민수"}, "content": "박민수가 넘어질 뻔함"},
        settings(webhook_url="https://hook.invalid"),
    )
    assert "박민수" not in httpx_mock.get_request().read().decode()


@pytest.mark.asyncio
async def test_webhook_logs_when_url_absent(caplog, httpx_mock):
    with caplog.at_level("INFO"):
        await notify_high_risk({"id": "r1", "risk": "상"}, settings(webhook_url=None))
    assert httpx_mock.get_requests() == []
    assert "r1" in caplog.text


@pytest.mark.asyncio
async def test_webhook_failure_does_not_raise(httpx_mock):
    httpx_mock.add_response(status_code=500)
    await notify_high_risk(
        {"id": "r1", "risk": "상"}, settings(webhook_url="https://hook.invalid")
    )


@pytest.mark.asyncio
async def test_webhook_timeout_does_not_raise(httpx_mock):
    httpx_mock.add_exception(httpx.ReadTimeout("slow"))
    await notify_high_risk(
        {"id": "r1", "risk": "상"}, settings(webhook_url="https://hook.invalid")
    )


def test_submit_high_risk_enters_unacknowledged_queue(client, insert_report):
    report_id = insert_report(created_at=NOW, status="ready", risk="상")
    client.post(f"/api/reports/{report_id}/submit")
    rows = client.get("/api/reports/unacknowledged", headers=ADMIN).json()
    assert [r["id"] for r in rows] == [report_id]


def test_submit_mid_risk_does_not_enter_queue(client, insert_report):
    report_id = insert_report(created_at=NOW, status="ready", risk="중")
    client.post(f"/api/reports/{report_id}/submit")
    assert client.get("/api/reports/unacknowledged", headers=ADMIN).json() == []


def test_acknowledge_removes_from_queue(client, insert_report):
    report_id = insert_report(created_at=NOW, status="ready", risk="상")
    client.post(f"/api/reports/{report_id}/submit")
    assert client.post(f"/api/reports/{report_id}/acknowledge", headers=ADMIN).status_code == 200
    assert client.get("/api/reports/unacknowledged", headers=ADMIN).json() == []


def test_unacknowledged_requires_admin_token(client):
    assert client.get("/api/reports/unacknowledged").status_code == 401


def test_acknowledge_requires_admin_token(client, insert_report):
    report_id = insert_report(created_at=NOW, status="ready", risk="상")
    assert client.post(f"/api/reports/{report_id}/acknowledge").status_code == 401


def test_unacknowledged_route_is_not_shadowed_by_report_id(client, insert_report):
    # /api/reports/{report_id}가 먼저 선언되면 "unacknowledged"를 id로 받아
    # 404가 난다. 라우트 선언 순서를 고정한다.
    insert_report(created_at=NOW, status="ready", risk="상")
    assert client.get("/api/reports/unacknowledged", headers=ADMIN).status_code == 200


def test_unacknowledged_hides_real_name(client, insert_report):
    report_id = insert_report(
        created_at=NOW,
        status="ready",
        risk="상",
        reporter={"org": "두원기업", "name": "박민수", "role": "축로공", "count": 3},
    )
    client.post(f"/api/reports/{report_id}/submit")
    text = client.get("/api/reports/unacknowledged", headers=ADMIN).text
    assert "박민수" not in text
    assert "박 ○○" in text


def test_acknowledge_on_unknown_report_is_404(client, insert_report):
    report_id = insert_report(created_at=NOW, status="ready", risk="상")
    assert client.post(f"/api/reports/{report_id}/acknowledge", headers=ADMIN).status_code == 200
    assert client.post("/api/reports/없는-id/acknowledge", headers=ADMIN).status_code == 404


def test_webhook_failure_does_not_break_submit(make_client, insert_report, httpx_mock):
    # 웹훅이 설정된 클라이언트여야 실제로 호출이 일어난다 — 기본 클라이언트는
    # webhook_url이 None이라 호출 자체가 없어 아무것도 증명하지 못한다.
    httpx_mock.add_response(status_code=500)
    hooked = make_client(
        admin_token="test-admin-token", webhook_url="https://hook.invalid"
    )
    report_id = insert_report(created_at=NOW, status="ready", risk="상")
    resp = hooked.post(f"/api/reports/{report_id}/submit")
    assert resp.status_code == 200
    assert resp.json()["status"] == "submitted"
    assert httpx_mock.get_request() is not None
