"""관리자 토큰 가드와 엔드포인트별 인적사항 노출 범위 테스트.

실명은 GET /api/reports/{id}/identity 로만 내려간다. 그 외 모든 응답(목록·상세)은
마스킹된 값만 담아야 한다 — test_detail_response_never_contains_real_name은 파싱된
필드가 아니라 raw 응답 본문 문자열에서 실명이 아예 등장하지 않는지를 확인한다.
"""
ADMIN = {"Authorization": "Bearer test-admin-token"}


def test_admin_list_requires_token(client):
    assert client.get("/api/reports").status_code == 401


def test_admin_list_returns_masked_name(client, seeded_report):
    rows = client.get("/api/reports", headers=ADMIN).json()
    assert rows[0]["reporter"]["name"] == "박 ○○"


def test_admin_list_identity_line_includes_count(client, seeded_report):
    rows = client.get("/api/reports", headers=ADMIN).json()
    assert rows[0]["identity_line"] == "박 ○○ 등 3명"


def test_identity_endpoint_returns_real_name(client, seeded_report):
    body = client.get(f"/api/reports/{seeded_report}/identity", headers=ADMIN).json()
    assert body["name"] == "박민수"


def test_identity_endpoint_requires_token(client, seeded_report):
    assert client.get(f"/api/reports/{seeded_report}/identity").status_code == 401


def test_detail_response_never_contains_real_name(client, seeded_report):
    body = client.get(f"/api/reports/{seeded_report}", headers=ADMIN).text
    assert "박민수" not in body


def test_detail_requires_token(client, seeded_report):
    assert client.get(f"/api/reports/{seeded_report}").status_code == 401


def test_mine_does_not_leak_other_devices(client, seeded_report):
    rows = client.get("/api/reports/mine", params={"reporter_id": "other-device"}).json()
    assert rows == []


def test_unconfigured_admin_token_rejects_empty_bearer_credential(make_client):
    """admin_token이 설정되지 않은(빈 문자열) 배포에서 빈 Bearer 자격증명을 보내면
    통과해 버리는 회귀를 막는 테스트.

    `require_admin`의 `if not expected or not secrets.compare_digest(provided, expected)`
    에서 `not expected or` 부분이 빠지면, 헤더 없는 요청의 provided=""가 미설정
    expected=""와 `compare_digest`에서 "같다"고 판정돼(빈 문자열끼리는 항상 True)
    토큰을 설정하지 않은 배포가 누구에게나 관리자 권한을 열어주게 된다. 이 테스트는
    그 가드 라인을 고정해, 나중에 조건을 "단순화"하려는 시도가 있으면 바로 깨지게 한다.
    """
    unconfigured_client = make_client(admin_token="")
    assert (
        unconfigured_client.get(
            "/api/reports", headers={"Authorization": "Bearer "}
        ).status_code
        == 401
    )
    assert unconfigured_client.get("/api/reports").status_code == 401
