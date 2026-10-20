"""FastAPI 앱 조립.

기존 정적 프런트엔드(index.html, css/, js/)를 그대로 서빙하면서 API를 얹는다.
정적 마운트가 /api 라우트를 가리지 않도록 API 라우터를 먼저 등록한다.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import Settings, get_settings
from . import db as db_module
from .routes_reports import router as reports_router

BASE_DIR = Path(__file__).resolve().parent.parent


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    db_module.init_db(settings.db_path)

    app = FastAPI(title="니어미스 신고 서버")
    app.state.settings = settings

    # API 라우터를 먼저 등록 — 이후 등록되는 정적 마운트가 /api를 가리지 않도록 한다.
    app.include_router(reports_router)

    app.mount("/css", StaticFiles(directory=str(BASE_DIR / "css")), name="css")
    app.mount("/js", StaticFiles(directory=str(BASE_DIR / "js")), name="js")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(str(BASE_DIR / "index.html"))

    return app


app = create_app()
