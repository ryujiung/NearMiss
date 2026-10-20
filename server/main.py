"""FastAPI 앱 조립.

기존 정적 프런트엔드(index.html, css/, js/)를 그대로 서빙하면서 API를 얹는다.
정적 마운트가 /api 라우트를 가리지 않도록 API 라우터를 먼저 등록한다.
"""
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, get_settings
from . import db as db_module
from .routes_photos import router as photos_router
from .routes_reports import router as reports_router

BASE_DIR = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # 서버가 실제로 기동할 때만 DB 스키마를 준비한다 — create_app()을 단순히
    # import/호출하는 것만으로 디스크에 파일이 생기지 않도록 한다.
    db_module.init_db(app.state.settings.db_path)
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(title="니어미스 신고 서버", lifespan=_lifespan)
    app.state.settings = settings

    # API 라우터를 먼저 등록 — 이후 등록되는 정적 마운트가 /api를 가리지 않도록 한다.
    app.include_router(reports_router)
    app.include_router(photos_router)

    app.mount("/css", StaticFiles(directory=str(BASE_DIR / "css")), name="css")
    app.mount("/js", StaticFiles(directory=str(BASE_DIR / "js")), name="js")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(str(BASE_DIR / "index.html"))

    return app


app = create_app()
