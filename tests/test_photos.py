"""사진 업로드 테스트.

정의서 6장 속보 양식에 사진 칸이 2개라서 신고당 2장까지만 받는다.
"""
MAX_BYTES = 10 * 1024 * 1024


def _upload(client, report_id, png_bytes, name="a.png", mime="image/png"):
    return client.post(
        f"/api/reports/{report_id}/photos",
        files={"file": (name, png_bytes, mime)},
    )


def test_upload_returns_url_and_persists(client, report_id, png_bytes):
    r = _upload(client, report_id, png_bytes)
    assert r.status_code == 201
    assert client.get(r.json()["url"]).content == png_bytes


def test_upload_returns_photo_id(client, report_id, png_bytes):
    assert _upload(client, report_id, png_bytes).json()["photo_id"]


def test_two_photos_are_allowed(client, report_id, png_bytes):
    assert _upload(client, report_id, png_bytes, name="a.png").status_code == 201
    assert _upload(client, report_id, png_bytes, name="b.png").status_code == 201


def test_third_photo_is_rejected(client, report_id, png_bytes):
    _upload(client, report_id, png_bytes, name="a.png")
    _upload(client, report_id, png_bytes, name="b.png")
    assert _upload(client, report_id, png_bytes, name="c.png").status_code == 409


def test_non_image_is_rejected(client, report_id):
    r = client.post(
        f"/api/reports/{report_id}/photos",
        files={"file": ("a.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415


def test_oversized_photo_is_rejected(client, report_id):
    oversized = b"\x89PNG\r\n\x1a\n" + b"0" * MAX_BYTES
    r = client.post(
        f"/api/reports/{report_id}/photos",
        files={"file": ("big.png", oversized, "image/png")},
    )
    assert r.status_code == 413


def test_upload_to_unknown_report_is_404(client, report_id, png_bytes):
    # 라우트가 아예 없어도 404가 나므로, 먼저 정상 업로드가 되는지 확인한다.
    assert _upload(client, report_id, png_bytes).status_code == 201
    assert _upload(client, "없는-id", png_bytes).status_code == 404


def test_unknown_photo_id_is_404(client, report_id, png_bytes):
    url = _upload(client, report_id, png_bytes).json()["url"]
    assert client.get(url).status_code == 200
    assert client.get("/api/photos/없는-photo").status_code == 404


def test_rejected_photo_does_not_count_toward_the_limit(client, report_id, png_bytes):
    # 거절된 업로드가 자리를 차지하면 작업자가 사진을 한 장도 못 붙이게 된다.
    client.post(
        f"/api/reports/{report_id}/photos",
        files={"file": ("a.txt", b"hello", "text/plain")},
    )
    assert _upload(client, report_id, png_bytes, name="a.png").status_code == 201
    assert _upload(client, report_id, png_bytes, name="b.png").status_code == 201


def test_photo_ids_are_not_guessable_from_filename(client, report_id, png_bytes):
    # 파일명을 그대로 id/경로로 쓰면 경로 조작과 덮어쓰기에 노출된다.
    photo_id = _upload(client, report_id, png_bytes, name="../../etc/passwd").json()[
        "photo_id"
    ]
    assert "/" not in photo_id and ".." not in photo_id


def test_photos_appear_on_admin_detail(client, report_id, png_bytes):
    photo_id = _upload(client, report_id, png_bytes).json()["photo_id"]
    detail = client.get(
        f"/api/reports/{report_id}",
        headers={"Authorization": "Bearer test-admin-token"},
    ).json()
    assert photo_id in [p["photo_id"] for p in detail["photos"]]
