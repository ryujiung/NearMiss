"""최종 브랜치 리뷰에서 나온 결함들의 재현 테스트.

각 테스트는 리뷰어가 실증한 경로를 그대로 재현한다. 고치기 전에 실패하는 것을
확인했고, 이 파일이 그 결함들이 돌아오지 않게 막는다.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from server.prompt import IDENTITY_PLACEHOLDER

ADMIN = {"Authorization": "Bearer test-admin-token"}
OTHER = {"X-Reporter-Id": "other-device"}
OWNER = {"reporter_id": "dev-1"}
SITE_TZ = ZoneInfo("Asia/Seoul")
NOW = datetime.now(timezone.utc)


# ---------- C1: 제출된 신고를 백그라운드 잡이 ready로 되돌린다 ----------


def test_finished_job_does_not_undo_submitted(client, report_id, set_status):
    """작업자가 '분석 중'에 제출하면 잡이 그 제출을 덮어쓴다.

    실제 Gemini 응답이 ~12초이므로 모든 신고에 그만큼의 창이 열린다. 덮어쓰면
    작업자는 '접수되었습니다'를 보지만 관리자 큐·통계·웹훅에는 아무것도 가지 않는다.
    """
    client.post(f"/api/reports/{report_id}/draft")  # ready까지 간다
    client.post(f"/api/reports/{report_id}/submit")
    # 제출 후 또 분석이 돌아도(관리자 '다시 분석', 열린 초안 화면의 재시도)
    # 상태가 submitted에서 내려가서는 안 된다.
    client.post(f"/api/reports/{report_id}/draft")
    mine = client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert mine[0]["status"] == "submitted"


def test_reanalysis_after_submit_still_refreshes_the_draft(client, report_id, varying_provider):
    """상태는 지키되 초안 내용은 갱신돼야 한다 — 관리자 '다시 분석'의 목적이다."""
    client.post(f"/api/reports/{report_id}/draft")
    before = client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()["draft"]["overview"]
    client.post(f"/api/reports/{report_id}/submit")
    client.post(f"/api/reports/{report_id}/draft")
    after = client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()
    assert after["status"] == "submitted"
    assert after["draft"]["overview"] != before


def test_submitted_report_reaches_stats_even_if_job_runs_after(client, report_id):
    client.post(f"/api/reports/{report_id}/draft")
    client.post(f"/api/reports/{report_id}/submit")
    client.post(f"/api/reports/{report_id}/draft")
    assert client.get("/api/stats").json()["total"] == 1


# ---------- I1: 클라이언트가 보낸 created_at 하나가 /api/stats를 영구 500으로 ----------


def test_unparseable_created_at_is_rejected(client):
    resp = client.post(
        "/api/reports",
        json={
            "client_uuid": "bad-date",
            "content": "난간이 흔들림",
            "reporter_id": "dev-1",
            "created_at": "어제 오후 2시",
        },
    )
    assert resp.status_code == 422


def test_stats_survives_an_unparseable_stored_date(client, insert_report):
    # 어떤 경로로든 깨진 값이 들어가도 통계 탭 전체가 죽어서는 안 된다.
    insert_report(created_at=NOW)
    conn_report = insert_report(created_at=NOW)
    import server.db as db_module

    conn = db_module.get_conn(client.app.state.settings.db_path)
    try:
        conn.execute(
            "UPDATE reports SET created_at = '어제 오후 2시' WHERE id = ?",
            (conn_report,),
        )
        conn.commit()
    finally:
        conn.close()

    resp = client.get("/api/stats")
    assert resp.status_code == 200
    assert resp.json()["total"] == 1  # 깨진 행만 빠진다


# ---------- I2: 이번 주/이번 달이 달력이 아니라 롤링 창 ----------


def test_month_tile_uses_calendar_month_not_rolling_30_days(client, insert_report):
    """'이번 달'이 롤링 30일이면 매달 2일에 지난달 건이 포함된다."""
    now_local = NOW.astimezone(SITE_TZ)
    first_of_month = now_local.replace(day=1, hour=0, minute=1)
    before_this_month = first_of_month - timedelta(days=1)

    insert_report(created_at=NOW)
    insert_report(created_at=before_this_month.astimezone(timezone.utc))

    body = client.get("/api/stats").json()
    assert body["total"] == 2
    assert body["month"] == 1, "지난달 건이 '이번 달'에 섞였다"


def test_week_tile_starts_on_monday(client, insert_report):
    now_local = NOW.astimezone(SITE_TZ)
    monday = (now_local - timedelta(days=now_local.weekday())).replace(hour=0, minute=1)
    before_this_week = monday - timedelta(days=1)

    insert_report(created_at=NOW)
    insert_report(created_at=before_this_week.astimezone(timezone.utc))

    body = client.get("/api/stats").json()
    assert body["week"] == 1, "지난주 건이 '이번 주'에 섞였다"


# ---------- I3: 제출·초안 수정·초안 요청·사진에 소유자 검사 없음 ----------


@pytest.mark.parametrize(
    "method,path_suffix,kwargs",
    [
        ("post", "/draft", {}),
        ("patch", "/draft", {"json": {"fields": {"location": "침입"}}}),
        ("post", "/submit", {}),
    ],
)
def test_other_device_cannot_touch_someone_elses_report(
    client, report_id, method, path_suffix, kwargs
):
    # 시드 id는 seed-001처럼 추측 가능하다. 인증 없이 결재용 속보의 칸을 고치거나
    # 상태를 바꿀 수 있으면 접근 모델에 구멍이 난다.
    resp = getattr(client, method)(
        f"/api/reports/{report_id}{path_suffix}", headers=OTHER, **kwargs
    )
    assert resp.status_code == 403


def test_owner_can_still_act_on_their_own_report(client, report_id):
    assert client.post(f"/api/reports/{report_id}/draft").status_code == 202
    assert client.post(f"/api/reports/{report_id}/submit").status_code == 200


def test_admin_can_act_on_any_report(client, report_id):
    assert client.post(
        f"/api/reports/{report_id}/draft", headers={**OTHER, **ADMIN}
    ).status_code == 202


def test_other_device_cannot_upload_a_photo(client, report_id, png_bytes):
    resp = client.post(
        f"/api/reports/{report_id}/photos",
        headers=OTHER,
        files={"file": ("a.png", png_bytes, "image/png")},
    )
    assert resp.status_code == 403


def test_patch_rejects_unknown_draft_fields(client, report_id):
    # risk나 sources를 임의로 주입하면 배지·통계와 저장값이 어긋난다.
    client.post(f"/api/reports/{report_id}/draft")
    client.patch(
        f"/api/reports/{report_id}/draft",
        json={"fields": {"risk": "엄청높음", "sources": {"risk": "user"}}},
    )
    draft = client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()["draft"]
    assert draft["risk"] != "엄청높음"
    assert draft["sources"]["risk"] == "ai"


# ---------- I5: 파싱은 됐지만 빈 응답이 ready로 끝난다 ----------


def test_parsed_but_empty_draft_is_treated_as_failed(client, report_id, empty_provider):
    """실패를 실패로 알리지 않으면 '다시 분석' 버튼이 나오지 않는다."""
    client.post(f"/api/reports/{report_id}/draft")
    body = client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()
    assert body["status"] == "failed"
    assert body["error"]


def test_submission_still_allowed_when_draft_is_empty(client, report_id, empty_provider):
    # 제출을 막지 않는다 — 분석이 비었어도 기록은 남아야 한다.
    client.post(f"/api/reports/{report_id}/draft")
    assert client.post(f"/api/reports/{report_id}/submit").status_code == 200


def test_two_fenced_blocks_do_not_yield_a_plausible_wrong_bulletin():
    from server.prompt import DraftParseError, parse_draft_response

    # 모델이 예시 펜스를 먼저 쓰면 첫 블록을 취하는 구현은 "그럴듯하지만 틀린"
    # 속보를 만든다. 깨끗하게 실패하는 편이 안전 문서에서는 낫다.
    text = '```json\n{"risk": "하"}\n```\n실제 분석:\n```json\n{"risk": "상"}\n```'
    with pytest.raises(DraftParseError):
        parse_draft_response(text)


# ---------- I6: [당사자] 노출 방어가 프롬프트 지시뿐 ----------


def test_placeholder_never_reaches_the_stored_draft(client, report_id, leaky_provider):
    """모델이 지시를 어겨도 자리표시자가 저장·렌더까지 가면 안 된다."""
    client.post(f"/api/reports/{report_id}/draft")
    body = client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}
    ).json()
    import json as _json

    assert IDENTITY_PLACEHOLDER not in _json.dumps(body["draft"], ensure_ascii=False)
    assert "작업자" in _json.dumps(body["draft"], ensure_ascii=False)
