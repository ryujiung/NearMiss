"""pytest 공통 픽스처.

`client`는 임시 SQLite DB를 사용하는 FastAPI TestClient를 제공합니다.
이후 태스크(관리자 토큰, LLM 모드 등)가 설정값을 오버라이드해 재사용할 수 있도록
`make_client` 팩토리 픽스처로 구성했습니다.
"""
import pytest
from fastapi.testclient import TestClient

from server.config import Settings
from server.main import create_app


@pytest.fixture
def make_client(tmp_path):
    """오버라이드 가능한 설정으로 TestClient를 만드는 팩토리.

    예) make_client(admin_token="secret")
    """

    def _make(**overrides):
        defaults = dict(
            api_base_url="",
            api_key="",
            model="",
            admin_token="",
            webhook_url=None,
            llm_mode="mock",
            db_path=str(tmp_path / "test.db"),
        )
        defaults.update(overrides)
        settings = Settings(**defaults)
        app = create_app(settings)
        return TestClient(app)

    return _make


@pytest.fixture
def client(make_client):
    return make_client()
