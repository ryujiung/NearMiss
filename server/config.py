"""서버 설정.

모든 비밀 값(API 키 등)은 환경변수로만 주입한다. 코드에 하드코딩하지 않는다.
"""
import os
from dataclasses import dataclass
from pathlib import Path


def load_dotenv(path: str | Path = ".env") -> None:
    """`.env` 파일의 값을 환경변수로 올린다.

    README가 `.env`에 값을 쓰라고 안내하므로 그 파일이 실제로 읽혀야 한다.
    읽지 않으면 사용자는 키를 넣었는데 적용되지 않는 상황을 디버깅하게 된다.

    **이미 환경에 있는 값은 덮지 않는다** — 명령줄에서 한 번만 다르게 돌려보는
    경로(`NEARMISS_LLM_MODE=mock uvicorn ...`)를 파일이 가로채면 안 된다.

    빈 값은 "설정하지 않음"으로 둔다. `.env.example`이 전부 빈 값이라, 복사해서
    쓰는 사람이 일부만 채웠을 때 나머지가 빈 문자열로 덮이면 기본값을 잃는다.

    python-dotenv를 쓰지 않는 이유: 이만큼은 표준 라이브러리로 충분하고,
    데모 환경에 설치할 의존성을 하나라도 줄이는 편이 낫다.
    """
    env_path = Path(path)
    if not env_path.is_file():
        return

    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key or not value or key in os.environ:
            continue
        os.environ[key] = value


@dataclass
class Settings:
    api_base_url: str
    api_key: str
    model: str
    admin_token: str
    webhook_url: str | None = None
    llm_mode: str = "live"
    # mock 모드에서 쓸 초안: 비우면 고정 픽스처, "auto"면 신고 원문에서 만든다.
    mock_fixture: str = ""
    # OpenAI 호환이라도 경로 배치가 제각각이다. 예를 들어 Gemini의 호환
    # 엔드포인트는 /v1beta/openai/chat/completions 로 /v1 조각이 없다.
    # base URL만으로는 맞출 수 없으므로 경로도 설정값으로 둔다.
    chat_path: str = "/v1/chat/completions"
    db_path: str = "nearmiss.db"
    # 사내 API의 응답 지연을 모르는 전제이므로 넉넉히 두고, 데모 중 조정할 수 있게
    # 환경변수로도 노출한다.
    request_timeout: float = 120.0
    # 사진 저장 디렉터리. 고정 경로로 두면 테스트가 레포 안에 파일을 쓴다.
    photo_dir: str = "server/data/photos"
    # 시각은 UTC로 저장하되, 집계의 '오늘'·'시간대' 구간은 현장 시간대로 나눈다.
    # UTC로 나누면 KST 오전 9시 신고가 시간대별 차트의 0~3시 칸에 들어간다.
    timezone_name: str = "Asia/Seoul"


def get_settings() -> Settings:
    """환경변수에서 설정값을 읽어온다. `.env`가 있으면 먼저 올린다."""
    load_dotenv()
    # 키가 없으면 live는 어차피 실패하므로, 설정 없이 띄운 서버는 mock으로 시작한다.
    has_live_config = bool(os.environ.get("NEARMISS_API_BASE_URL") and os.environ.get("NEARMISS_API_KEY"))
    return Settings(
        api_base_url=os.environ.get("NEARMISS_API_BASE_URL", ""),
        api_key=os.environ.get("NEARMISS_API_KEY", ""),
        model=os.environ.get("NEARMISS_MODEL", ""),
        admin_token=os.environ.get("NEARMISS_ADMIN_TOKEN", ""),
        webhook_url=os.environ.get("NEARMISS_WEBHOOK_URL") or None,
        llm_mode=os.environ.get("NEARMISS_LLM_MODE", "live" if has_live_config else "mock"),
        mock_fixture=os.environ.get("NEARMISS_MOCK_FIXTURE", "auto"),
        chat_path=os.environ.get("NEARMISS_CHAT_PATH", "/v1/chat/completions"),
        db_path=os.environ.get("NEARMISS_DB_PATH", "nearmiss.db"),
        request_timeout=float(os.environ.get("NEARMISS_REQUEST_TIMEOUT", "120")),
        photo_dir=os.environ.get("NEARMISS_PHOTO_DIR", "server/data/photos"),
        timezone_name=os.environ.get("NEARMISS_TIMEZONE", "Asia/Seoul"),
    )
