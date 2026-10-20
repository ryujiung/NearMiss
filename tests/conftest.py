"""pytest 공통 픽스처.

`client`는 임시 SQLite DB를 사용하는 FastAPI TestClient를 제공합니다.
이후 태스크(관리자 토큰, LLM 모드 등)가 설정값을 오버라이드해 재사용할 수 있도록
`make_client` 팩토리 픽스처로 구성했습니다.

`make_client`로 만든 TestClient는 반드시 `with` 블록(또는 ExitStack)으로 열어야
lifespan 훅이 실행되어 DB 스키마가 준비된다 — 그래서 이 픽스처가 ExitStack으로
각 클라이언트의 생명주기를 관리하고, 테스트가 끝나면 한꺼번에 정리한다.
"""
import itertools
import json
from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient

import server.drafts
from server import db as db_module
from server.config import Settings
from server.llm import LLMError, MockProvider
from server.main import create_app


@pytest.fixture
def make_client(tmp_path):
    """오버라이드 가능한 설정으로 TestClient를 만드는 팩토리.

    기본적으로(`same_db=True`) 같은 테스트 안에서 만든 클라이언트들은 하나의 DB 파일을
    공유한다 — 기기를 바꿔도(새 TestClient = 새 앱 인스턴스) 신고 상태가 유지되는지
    확인하려는 테스트(예: 세션이 바뀌어도 초안 상태가 살아남는지)를 위한 것이다.
    `same_db=False`를 주면 완전히 새 DB 파일을 쓰고, `db_path`를 직접 넘기면 그 값이
    항상 우선한다.

    예) make_client(admin_token="secret")
        make_client(same_db=True)   # 다른 "기기"에서 같은 서버 DB를 바라보는 상황 재현
    """
    stack = ExitStack()
    shared_db_path = str(tmp_path / "test.db")
    fresh_db_counter = itertools.count(1)

    def _make(*, same_db: bool = True, **overrides):
        if "db_path" in overrides:
            db_path = overrides.pop("db_path")
        elif same_db:
            db_path = shared_db_path
        else:
            db_path = str(tmp_path / f"test-{next(fresh_db_counter)}.db")

        defaults = dict(
            api_base_url="",
            api_key="",
            model="",
            admin_token="",
            webhook_url=None,
            llm_mode="mock",
        )
        defaults.update(overrides)
        settings = Settings(db_path=db_path, **defaults)
        app = create_app(settings)
        return stack.enter_context(TestClient(app))

    with stack:
        yield _make


@pytest.fixture
def client(make_client):
    # admin_token을 고정값으로 둬서 관리자 엔드포인트 테스트(test_access_control.py)가
    # 매번 다른 토큰을 오버라이드하지 않고 바로 ADMIN 헤더를 쓸 수 있게 한다.
    return make_client(admin_token="test-admin-token")


@pytest.fixture
def seeded_report(client):
    """관리자 접근 제어 테스트용으로 신고 하나를 미리 넣고 그 id를 돌려준다.

    신고자 두원기업 소속 박민수(축로공), 당사자 3명(count=3) — 마스킹/실명 분리
    테스트가 기대하는 "박 ○○ 등 3명" / "박민수" 쌍의 원본이다.
    """
    resp = client.post(
        "/api/reports",
        json={
            "client_uuid": "seed-1",
            "content": "축로 작업 중 지지대가 흔들려 넘어질 뻔함",
            "reporter_id": "dev-seed",
            "reporter": {
                "org": "두원기업",
                "name": "박민수",
                "role": "축로공",
                "count": 3,
            },
        },
    )
    return resp.json()["id"]


def settings(**overrides) -> Settings:
    """테스트용 Settings — 기본값 위에 필요한 값만 덮어쓴다.

    LLM 프로바이더처럼 앱/DB가 필요 없는 단위 테스트가 Settings만 받아 쓰는 경로다.
    픽스처가 아니라 평범한 헬퍼라서 `settings(api_key="k")`처럼 바로 호출한다.
    """
    defaults = dict(
        api_base_url="https://api.example.invalid",
        api_key="",
        model="",
        admin_token="",
        webhook_url=None,
        llm_mode="live",
        db_path=":memory:",
    )
    defaults.update(overrides)
    return Settings(**defaults)


# ---------- 초안 생성 잡 테스트용 ----------


def _create_report(client, *, content, reporter=None, reporter_id="dev-1", uuid="u-draft"):
    payload = {"client_uuid": uuid, "content": content, "reporter_id": reporter_id}
    if reporter is not None:
        payload["reporter"] = reporter
    return client.post("/api/reports", json=payload).json()["id"]


@pytest.fixture
def report_id(client):
    """초안이 아직 없는 신고 하나."""
    return _create_report(client, content="3층 계단 난간 헐거움, 넘어질 뻔함")


@pytest.fixture
def report_id_with_name(client):
    """실명이 구조화된 인적사항에만 들어 있는 신고.

    원문에는 이름을 넣지 않는다 — 사양 3.4는 원문을 분석의 근거로 보아 치환하지
    않기로 했으므로, 원문에 이름을 넣으면 "프롬프트에 실명이 없다"는 검증이
    사양과 모순된다. 여기서 고정해야 하는 것은 구조화된 인적사항이 프롬프트로
    새지 않는다는 것이다.
    """
    return _create_report(
        client,
        content="2공장 3라인에서 미끄러질 뻔함",
        reporter={"org": "두원기업", "name": "박민수", "role": "축로공", "count": 3},
        uuid="u-draft-name",
    )


class _RecordingProvider:
    """호출된 메시지를 기록하는 프로바이더. 응답은 mock 픽스처를 쓴다."""

    def __init__(self):
        self.calls: list[list[dict]] = []

    @property
    def call_count(self) -> int:
        return len(self.calls)

    @property
    def last_prompt_text(self) -> str:
        return "".join(m["content"] for m in self.calls[-1]) if self.calls else ""

    async def complete(self, messages: list[dict]) -> str:
        self.calls.append(messages)
        return await MockProvider().complete(messages)


class _UnparseableProvider(_RecordingProvider):
    """JSON이 없는 응답을 돌려준다 — DraftParseError 경로를 재현한다."""

    async def complete(self, messages: list[dict]) -> str:
        self.calls.append(messages)
        return "죄송합니다, 분석할 수 없습니다."


class _FailThenWorkProvider(_RecordingProvider):
    """첫 호출만 전송 실패, 이후는 정상 — 재시도 버튼 경로를 재현한다."""

    async def complete(self, messages: list[dict]) -> str:
        self.calls.append(messages)
        if self.call_count == 1:
            raise LLMError("일시적 장애")
        return await MockProvider().complete(messages)


def _patch_provider(monkeypatch, provider):
    """run_draft_job이 쓰는 get_provider를 테스트 프로바이더로 바꾼다."""
    monkeypatch.setattr(server.drafts, "get_provider", lambda settings: provider)
    return provider


@pytest.fixture
def capture_provider(monkeypatch):
    return _patch_provider(monkeypatch, _RecordingProvider())


@pytest.fixture
def broken_provider(monkeypatch):
    return _patch_provider(monkeypatch, _UnparseableProvider())


@pytest.fixture
def broken_then_working_provider(monkeypatch):
    return _patch_provider(monkeypatch, _FailThenWorkProvider())


class _VaryingProvider(_RecordingProvider):
    """호출마다 overview가 달라지는 프로바이더.

    재생성이 AI 칸을 실제로 새로 채우는지 확인하려면 응답이 같으면 안 된다 —
    같은 값이 돌아오면 "덮어쓰지 않았다"와 "덮어썼는데 같다"를 구분할 수 없다.
    """

    async def complete(self, messages: list[dict]) -> str:
        self.calls.append(messages)
        draft = json.loads(await MockProvider().complete(messages))
        draft["overview"] = [f"{self.call_count}회차 서술"]
        return json.dumps(draft, ensure_ascii=False)


@pytest.fixture
def varying_provider(monkeypatch):
    return _patch_provider(monkeypatch, _VaryingProvider())


@pytest.fixture
def ready_report(client, report_id):
    """초안 생성이 끝난(status=ready) 신고.

    프로바이더 픽스처에 의존하지 않는다 — make_client가 llm_mode="mock"을 기본값으로
    두므로 패치 없이도 MockProvider가 쓰인다. 여기서 capture_provider를 끌어오면
    varying_provider를 쓰려는 테스트에서 패치가 서로 겹친다.
    """
    client.post(f"/api/reports/{report_id}/draft")
    return report_id


def current_draft(client, report_id, reporter_id="dev-1"):
    """폴링 엔드포인트에서 현재 초안을 꺼내는 테스트 헬퍼."""
    return client.get(
        f"/api/reports/{report_id}/draft", params={"reporter_id": reporter_id}
    ).json()["draft"]


@pytest.fixture
def set_status(client):
    """신고의 status를 직접 바꾼다.

    TestClient는 백그라운드 잡을 응답 반환 전에 끝내므로 `analyzing` 같은 중간
    상태를 요청만으로는 만들 수 없다. 상태 가드를 겨냥하는 테스트가 그 상태를
    직접 만들기 위한 통로다.
    """
    def _set(report_id: str, status: str) -> None:
        conn = db_module.get_conn(client.app.state.settings.db_path)
        try:
            db_module.update_report(conn, report_id, {"status": status})
        finally:
            conn.close()

    return _set
