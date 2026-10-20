"""서버 설정.

모든 비밀 값(API 키 등)은 환경변수로만 주입한다. 코드에 하드코딩하지 않는다.
"""
import os
from dataclasses import dataclass


@dataclass
class Settings:
    api_base_url: str
    api_key: str
    model: str
    admin_token: str
    webhook_url: str | None = None
    llm_mode: str = "live"
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
    """환경변수에서 설정값을 읽어온다."""
    return Settings(
        api_base_url=os.environ.get("NEARMISS_API_BASE_URL", ""),
        api_key=os.environ.get("NEARMISS_API_KEY", ""),
        model=os.environ.get("NEARMISS_MODEL", ""),
        admin_token=os.environ.get("NEARMISS_ADMIN_TOKEN", ""),
        webhook_url=os.environ.get("NEARMISS_WEBHOOK_URL") or None,
        llm_mode=os.environ.get("NEARMISS_LLM_MODE", "live"),
        db_path=os.environ.get("NEARMISS_DB_PATH", "nearmiss.db"),
        request_timeout=float(os.environ.get("NEARMISS_REQUEST_TIMEOUT", "120")),
        photo_dir=os.environ.get("NEARMISS_PHOTO_DIR", "server/data/photos"),
        timezone_name=os.environ.get("NEARMISS_TIMEZONE", "Asia/Seoul"),
    )
