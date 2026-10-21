"""초안 생성 비동기 잡과 폴링 엔드포인트 테스트.

TestClient는 BackgroundTasks를 응답 반환 직후 동기로 실행하므로, POST가
돌아온 뒤 바로 GET하면 잡이 끝난 상태를 볼 수 있다.
"""
from server.risk import RISK_LEVELS

ADMIN = {"Authorization": "Bearer test-admin-token"}


def _poll(client, report_id, reporter_id="dev-1"):
    return client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": reporter_id}
    )


def test_draft_endpoint_returns_202_immediately(client, report_id, capture_provider):
    assert client.post(f"/api/reports/{report_id}/draft").status_code == 202


def test_job_fills_draft_and_sets_ready(client, report_id, capture_provider):
    client.post(f"/api/reports/{report_id}/draft")
    body = _poll(client, report_id).json()
    assert body["status"] == "ready"
    assert body["risk"] in RISK_LEVELS
    assert body["draft"]["causes"]["physical"]


def test_job_stores_every_bulletin_field(client, report_id, capture_provider):
    client.post(f"/api/reports/{report_id}/draft")
    draft = _poll(client, report_id).json()["draft"]
    assert draft["title"] and draft["location"] and draft["overview"]
    assert draft["countermeasures"] and draft["risk_reason"]


def test_job_failure_keeps_content_and_sets_failed(client, report_id, broken_provider):
    client.post(f"/api/reports/{report_id}/draft")
    body = _poll(client, report_id).json()
    assert body["status"] == "failed"
    assert body["error"]
    mine = client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert mine[0]["content"]


def test_parse_failure_retries_exactly_once(client, report_id, broken_provider):
    # 사양 4: 파싱 실패 시 1회 재시도 후 실패 처리.
    client.post(f"/api/reports/{report_id}/draft")
    assert broken_provider.call_count == 2


def test_transport_failure_does_not_retry(client, report_id, broken_then_working_provider):
    # 전송 실패는 즉시 재시도해도 나아지지 않는다 — 재시도는 사용자 버튼이다(3.8).
    client.post(f"/api/reports/{report_id}/draft")
    assert broken_then_working_provider.call_count == 1
    assert _poll(client, report_id).json()["status"] == "failed"


def test_failed_job_can_be_retried(client, report_id, broken_then_working_provider):
    client.post(f"/api/reports/{report_id}/draft")
    client.post(f"/api/reports/{report_id}/draft")
    assert _poll(client, report_id).json()["status"] == "ready"


def test_draft_status_survives_new_client_session(
    client, make_client, report_id, capture_provider
):
    # Review Focus 5 — 상태가 메모리가 아니라 DB에 있어야 한다. 작업자가 초안
    # 화면에서 새로고침하면 새 세션이 같은 상태를 이어받아야 한다.
    client.post(f"/api/reports/{report_id}/draft")
    fresh = make_client(same_db=True, admin_token="test-admin-token")
    body = fresh.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()
    assert body["status"] == "ready"
    assert body["draft"]["causes"]["physical"]


def test_draft_polling_forbidden_for_other_device_without_token(
    client, report_id, capture_provider
):
    assert _poll(client, report_id, reporter_id="other").status_code == 403


def test_draft_polling_allowed_for_other_device_with_admin_token(
    client, report_id, capture_provider
):
    # 관리자는 미분류 건을 들여다봐야 한다(3.8).
    resp = client.get(
        f"/api/reports/{report_id}/draft",
        params={"reporter_id": "other"},
        headers=ADMIN,
    )
    assert resp.status_code == 200


def test_prompt_receives_placeholder_not_real_name(
    client, report_id_with_name, capture_provider
):
    client.post(f"/api/reports/{report_id_with_name}/draft")
    assert "박민수" not in capture_provider.last_prompt_text


def test_post_on_analyzing_report_does_not_start_another_job(
    client, report_id, capture_provider, set_status
):
    # TestClient는 백그라운드 잡을 POST 반환 전에 끝내므로 경합을 그대로 재현할 수
    # 없다. 가드가 보는 것은 DB의 status이므로 그 상태를 직접 만들어 겨냥한다.
    set_status(report_id, "analyzing")
    assert client.post(f"/api/reports/{report_id}/draft").status_code == 202
    assert capture_provider.call_count == 0


def test_post_on_ready_report_regenerates(client, report_id, capture_provider):
    # ready 건에 다시 POST하면 재생성이 일어난다 — '다시 분석' 버튼 경로다.
    client.post(f"/api/reports/{report_id}/draft")
    client.post(f"/api/reports/{report_id}/draft")
    assert capture_provider.call_count == 2


def test_draft_polling_returns_attached_photos(client, report_id, capture_provider, png_bytes):
    # 재진입한 작업자가 자기 사진을 못 보면 이미 2장인 줄 모르고 또 올리려 한다.
    client.post(f"/api/reports/{report_id}/draft")
    up = client.post(
        f"/api/reports/{report_id}/photos",
        files={"file": ("a.png", png_bytes, "image/png")},
    ).json()
    photos = _poll(client, report_id).json()["photos"]
    assert [p["photo_id"] for p in photos] == [up["photo_id"]]


def test_draft_polling_404_for_unknown_report(client, capture_provider):
    assert _poll(client, "없는-id").status_code == 404
