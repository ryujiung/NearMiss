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
    return make_client()
