"""신고 제출/조회 API.

원문 저장이 LLM 호출보다 먼저 — 이 라우터는 저장만 담당하고(멱등),
LLM 초안 생성은 이후 태스크(6)에서 붙는다.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from . import db as db_module
from .auth import require_admin
from .masking import format_identity, mask_name
from .models import ReportCreate, ReporterOut, ReportOut

router = APIRouter(prefix="/api/reports", tags=["reports"])


def get_db_conn(request: Request):
    """요청이 속한 앱의 설정에서 DB 경로를 읽어 연결한다.

    db_module.get_conn()을 인자 없이 쓰면 "마지막에 init_db가 설정한 경로"라는
    전역 상태에 의존하게 되어, 같은 프로세스에 앱이 여러 개 떠 있을 때(테스트에서
    여러 TestClient를 함께 쓰는 경우 등) 서로의 DB를 덮어써 버린다. 그래서 항상
    요청이 속한 앱(request.app.state.settings)의 경로를 명시적으로 넘긴다.
    """
    conn = db_module.get_conn(request.app.state.settings.db_path)
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


def _masked_reporter_and_identity(row: dict) -> tuple[ReporterOut | None, str | None]:
    """DB 행에서 마스킹된 reporter 블록과 identity_line을 만드는 단일 지점.

    실명이 응답에 섞여 들어갈 수 있는 경로를 하나로 좁힌다 — 관리자 목록·상세
    응답은 모두 이 함수를 거쳐야 하고, 이 함수는 절대 실명을 돌려주지 않는다.
    실명이 필요한 유일한 응답(/identity)은 이 함수를 쓰지 않고 reporter_json을
    직접 읽는다.
    """
    if not row.get("reporter_json"):
        return None, None

    reporter = json.loads(row["reporter_json"])
    count = reporter.get("count", 1)
    masked_reporter = ReporterOut(
        org=reporter.get("org", ""),
        name=mask_name(reporter.get("name", "")),
        role=reporter.get("role", ""),
        count=count,
    )
    identity_line = format_identity(reporter, count)
    return masked_reporter, identity_line


def _row_to_admin_out(row: dict) -> ReportOut:
    """관리자 목록·상세 응답 직렬화. 원문은 포함하고 실명은 마스킹한다."""
    out = _row_to_out(row)
    out.reporter, out.identity_line = _masked_reporter_and_identity(row)
    return out


def _period_to_since(period: str | None) -> str | None:
    """`period` 쿼리 파라미터를 `list_reports`의 `since` 하한으로 바꾼다.

    week → 7일 전, month → 30일 전, 그 외(없음 포함)는 하한 없음.
    """
    if period == "week":
        delta = timedelta(days=7)
    elif period == "month":
        delta = timedelta(days=30)
    else:
        return None
    return (datetime.now(timezone.utc) - delta).isoformat()


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


@router.get("", response_model=list[ReportOut], dependencies=[Depends(require_admin)])
def list_all_reports(
    risk: str | None = None,
    status: str | None = None,
    period: str | None = None,
    conn=Depends(get_db_conn),
) -> list[ReportOut]:
    """관리자 목록 — 전체 신고, 원문 포함, 인적사항은 마스킹."""
    since = _period_to_since(period)
    rows = db_module.list_reports(conn, risk=risk, status=status, since=since)
    return [_row_to_admin_out(row) for row in rows]


@router.get(
    "/{report_id}", response_model=ReportOut, dependencies=[Depends(require_admin)]
)
def get_report_detail(report_id: str, conn=Depends(get_db_conn)) -> ReportOut:
    """관리자 속보 상세 — 목록과 같은 reporter·identity_line 모양."""
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    return _row_to_admin_out(row)


@router.get("/{report_id}/identity", dependencies=[Depends(require_admin)])
def get_report_identity(report_id: str, conn=Depends(get_db_conn)) -> dict:
    """실명이 내려가는 유일한 엔드포인트. 그 외 모든 응답은 마스킹된 값만 담는다."""
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    if not row.get("reporter_json"):
        raise HTTPException(status_code=404, detail="신고자 정보가 없습니다")

    reporter = json.loads(row["reporter_json"])
    return {
        "org": reporter.get("org", ""),
        "name": reporter.get("name", ""),
        "role": reporter.get("role", ""),
        "count": reporter.get("count", 1),
    }
