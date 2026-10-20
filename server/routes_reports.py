"""신고 제출/조회 API.

원문 저장이 LLM 호출보다 먼저 — 이 라우터는 저장만 담당하고(멱등),
LLM 초안 생성은 이후 태스크(6)에서 붙는다.
"""
import json
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Response

from . import db as db_module
from .models import ReportCreate, ReportOut

router = APIRouter(prefix="/api/reports", tags=["reports"])


def get_db_conn():
    conn = db_module.get_conn()
    try:
        yield conn
    finally:
        conn.close()


def _row_to_out(row: dict) -> ReportOut:
    draft = json.loads(row["draft_json"]) if row.get("draft_json") else None
    return ReportOut(
        id=row["id"],
        status=row["status"],
        risk=row.get("risk"),
        category=row.get("category"),
        created_at=row["created_at"],
        draft=draft,
        content=row["content"],
    )


@router.post("", status_code=201)
def create_report(
    payload: ReportCreate, response: Response, conn=Depends(get_db_conn)
) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    new_id = str(uuid.uuid4())
    report = {
        "id": new_id,
        "client_uuid": payload.client_uuid,
        "reporter_id": payload.reporter_id,
        "content": payload.content,
        "reporter_json": payload.reporter.model_dump_json() if payload.reporter else None,
        "draft_json": None,
        "risk": None,
        "risk_reason": None,
        "category": None,
        "status": "draft",
        "acknowledged": False,
        "created_at": payload.created_at or now,
        "updated_at": now,
    }
    saved_id = db_module.insert_report(conn, report)

    if saved_id != new_id:
        # 같은 client_uuid로 이미 저장된 신고 — 새로 만들지 않고 기존 상태를 돌려준다.
        existing = db_module.get_report(conn, saved_id)
        response.status_code = 200
        return {"id": existing["id"], "status": existing["status"]}

    return {"id": new_id, "status": "draft"}


@router.get("/mine", response_model=list[ReportOut])
def get_my_reports(reporter_id: str, conn=Depends(get_db_conn)) -> list[ReportOut]:
    rows = db_module.list_reports(conn, reporter_id=reporter_id)
    return [_row_to_out(row) for row in rows]
