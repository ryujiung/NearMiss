"""확인 질문 재생성과 제출 테스트.

핵심은 하나다: 작업자가 손으로 고친 칸이 재생성 결과로 덮이면, 같은 입력을 두
번 하게 되어 "입력이 다시 양식이 되는 것" 안티목표를 정면으로 깬다.
"""
from tests.conftest import current_draft


def test_user_edited_field_is_not_overwritten_by_regeneration(client, ready_report):
    client.patch(
        f"/api/reports/{ready_report}/draft", json={"fields": {"location": "2공장 3라인"}}
    )
    client.patch(
        f"/api/reports/{ready_report}/draft",
        json={"answers": {"장소가 어디인가요?": "본관"}},
    )
    draft = current_draft(client, ready_report)
    assert draft["location"] == "2공장 3라인"
    assert draft["sources"]["location"] == "user"


def test_ai_field_is_refreshed_by_regeneration(client, ready_report, varying_provider):
    before = current_draft(client, ready_report)["overview"]
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"q": "a"}})
    assert current_draft(client, ready_report)["overview"] != before


def test_regenerated_ai_field_is_marked_ai(client, ready_report, varying_provider):
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"q": "a"}})
    assert current_draft(client, ready_report)["sources"]["overview"] == "ai"


def test_locked_fields_are_sent_to_prompt_as_facts(
    client, ready_report, capture_provider
):
    client.patch(
        f"/api/reports/{ready_report}/draft", json={"fields": {"location": "2공장 3라인"}}
    )
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"q": "a"}})
    assert "2공장 3라인" in capture_provider.last_prompt_text


def test_answers_are_sent_to_prompt_as_facts(client, ready_report, capture_provider):
    client.patch(
        f"/api/reports/{ready_report}/draft",
        json={"answers": {"장소가 어디인가요?": "2공장 3라인"}},
    )
    assert "2공장 3라인" in capture_provider.last_prompt_text


def test_editing_field_alone_does_not_trigger_llm_call(
    client, ready_report, capture_provider
):
    calls = capture_provider.call_count
    resp = client.patch(
        f"/api/reports/{ready_report}/draft", json={"fields": {"location": "x"}}
    )
    # 요청이 실제로 받아들여졌는지도 함께 확인한다 — 엔드포인트가 404/405여도
    # "LLM이 안 불렸다"는 공허하게 참이 된다.
    assert resp.status_code == 202
    assert current_draft(client, ready_report)["location"] == "x"
    assert capture_provider.call_count == calls


def test_editing_field_marks_only_that_field_as_user(client, ready_report):
    client.patch(f"/api/reports/{ready_report}/draft", json={"fields": {"location": "x"}})
    sources = current_draft(client, ready_report)["sources"]
    assert sources["location"] == "user"
    assert sources["overview"] == "ai"


def test_patch_returns_202(client, ready_report):
    resp = client.patch(
        f"/api/reports/{ready_report}/draft", json={"fields": {"location": "x"}}
    )
    assert resp.status_code == 202


def test_skipped_questions_do_not_block_submission(client, ready_report):
    assert client.post(f"/api/reports/{ready_report}/submit").status_code == 200


def test_empty_draft_fields_do_not_block_submission(client, report_id, broken_provider):
    # 초안 생성이 실패해 칸이 전부 비어 있어도 제출은 막지 않는다.
    client.post(f"/api/reports/{report_id}/draft")
    assert client.post(f"/api/reports/{report_id}/submit").status_code == 200


def test_submit_sets_status_submitted(client, ready_report):
    client.post(f"/api/reports/{ready_report}/submit")
    assert current_draft(client, ready_report) is not None
    mine = client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert mine[0]["status"] == "submitted"


def test_submit_on_unknown_report_is_404(client, ready_report):
    # ready_report를 함께 받아 라우트가 살아 있음을 먼저 확인한다 — 라우트가
    # 아예 없어도 404가 나므로, 그것만으로는 아무것도 증명하지 못한다.
    assert client.post(f"/api/reports/{ready_report}/submit").status_code == 200
    assert client.post("/api/reports/없는-id/submit").status_code == 404


def test_patch_on_unknown_report_is_404(client):
    resp = client.patch("/api/reports/없는-id/draft", json={"fields": {"location": "x"}})
    assert resp.status_code == 404


def test_patch_with_empty_body_is_accepted_and_changes_nothing(
    client, ready_report, capture_provider
):
    before = current_draft(client, ready_report)
    resp = client.patch(f"/api/reports/{ready_report}/draft", json={})
    assert resp.status_code == 202
    assert capture_provider.call_count == 0
    assert current_draft(client, ready_report) == before
