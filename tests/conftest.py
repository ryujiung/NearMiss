"""pytest 공통 픽스처.

`client`는 임시 SQLite DB를 사용하는 FastAPI TestClient를 제공합니다.
이후 태스크(관리자 토큰, LLM 모드 등)가 설정값을 오버라이드해 재사용할 수 있도록
`make_client` 팩토리 픽스처로 구성했습니다.

`make_client`로 만든 TestClient는 반드시 `with` 블록(또는 ExitStack)으로 열어야
lifespan 훅이 실행되어 DB 스키마가 준비된다 — 그래서 이 픽스처가 ExitStack으로
각 클라이언트의 생명주기를 관리하고, 테스트가 끝나면 한꺼번에 정리한다.
"""
import itertools
from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient

from server.config import Settings
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
