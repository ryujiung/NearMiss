def test_create_report_stores_content_and_returns_draft_status(client):
    r = client.post("/api/reports", json={
        "client_uuid": "u-1", "content": "3층 계단 난간 헐거움, 넘어질 뻔함",
        "reporter_id": "dev-1",
    })
    assert r.status_code == 201
    assert r.json()["status"] == "draft"


def test_duplicate_client_uuid_does_not_create_second_report(client):
    body = {"client_uuid": "u-1", "content": "같은 신고", "reporter_id": "dev-1"}
    first = client.post("/api/reports", json=body)
    second = client.post("/api/reports", json=body)
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert len(client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()) == 1


def test_mine_returns_only_own_device_reports(client):
    client.post("/api/reports", json={"client_uuid": "a", "content": "내 것", "reporter_id": "dev-1"})
    client.post("/api/reports", json={"client_uuid": "b", "content": "남의 것", "reporter_id": "dev-2"})
    mine = client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert [r["content"] for r in mine] == ["내 것"]


def test_index_html_is_served_at_root(client):
    assert client.get("/").status_code == 200


def test_two_clients_on_same_db_share_data(make_client):
    """같은 DB 경로를 공유하는 두 앱 인스턴스(예: 세션이 바뀐 같은 기기)가
    서로의 데이터를 올바르게 봐야 한다 — 모듈 전역에 의존해 경로가 뒤섞이면 깨진다."""
    client_a = make_client()
    client_b = make_client(same_db=True)

    client_a.post("/api/reports", json={
        "client_uuid": "shared-1", "content": "공유 DB 확인", "reporter_id": "dev-1",
    })

    mine = client_b.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert [r["content"] for r in mine] == ["공유 DB 확인"]
