"""신고 제출/조회 API.

원문 저장이 LLM 호출보다 먼저 — 이 라우터는 저장만 담당하고(멱등),
LLM 초안 생성은 이후 태스크(6)에서 붙는다.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
)

from . import db as db_module
from .auth import is_admin, require_admin
from .drafts import run_draft_job
from .masking import format_identity, mask_name
from .models import DraftPatch, ReportCreate, ReporterOut, ReportOut
from .webhook import notify_high_risk

router = APIRouter(prefix="/api/reports", tags=["reports"])

# 작업자가 초안 화면에서 손으로 고칠 수 있는 칸. risk·category·sources는
# 여기에 없다 — 분류는 AI가 일관된 기준으로 하는 것이 이 제품의 요점이고,
# 출처 표시를 클라이언트가 쓰면 그 표시가 거짓이 된다.
EDITABLE_FIELDS = frozenset(
    {"title", "occurred_at", "location", "overview", "causes", "countermeasures"}
)


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


def _row_to_admin_out(row: dict, conn=None) -> ReportOut:
    """관리자 목록·상세 응답 직렬화. 원문은 포함하고 실명은 마스킹한다."""
    out = _row_to_out(row)
    out.reporter, out.identity_line = _masked_reporter_and_identity(row)
    if conn is not None:
        out.photos = [
            {"photo_id": p["id"], "url": f"/api/photos/{p['id']}"}
            for p in db_module.list_photos(conn, row["id"])
        ]
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
        # 들어온 시각은 UTC ISO로 정규화해서 저장한다 — 집계가 읽는 형식을
        # 클라이언트가 정하게 두지 않는다.
        "created_at": payload.created_at.astimezone(timezone.utc).isoformat()
        if payload.created_at
        else now,
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
    return [_row_to_admin_out(row, conn) for row in rows]


@router.get(
    "/unacknowledged",
    response_model=list[ReportOut],
    dependencies=[Depends(require_admin)],
)
def list_unacknowledged(conn=Depends(get_db_conn)) -> list[ReportOut]:
    """위험도 '상'이면서 아직 관리자가 열어보지 않은 건.

    이 라우트는 `/{report_id}`보다 **먼저** 선언돼야 한다 — 뒤에 두면 FastAPI가
    "unacknowledged"를 report_id로 받아 404를 돌려준다.
    """
    rows = db_module.list_reports(conn, risk="상", status="submitted")
    pending = [row for row in rows if not row.get("acknowledged")]
    return [_row_to_admin_out(row, conn) for row in pending]


def _is_own_or_admin(row: dict, reporter_id: str | None, authorization: str | None,
                     settings) -> bool:
    """자기 기기 건이면 토큰 없이, 남의 건이면 관리자 토큰으로만 접근한다.

    작업자는 자기 초안을 확인·수정·제출해야 하므로 토큰을 요구할 수 없고,
    관리자는 미분류 건을 들여다봐야 하므로 막을 수 없다.
    """
    if reporter_id is not None and row["reporter_id"] == reporter_id:
        return True
    return is_admin(authorization, settings)


def _require_own_or_admin(row, reporter_id, authorization, request) -> None:
    """소유자도 관리자도 아니면 403.

    신고 id는 보통 UUID지만 시드 id는 seed-001처럼 추측 가능하다. 가드가 없으면
    인증 없는 요청이 결재용 속보의 칸을 고치거나 상태를 바꾸거나, PATCH answers로
    LLM 호출을 유발할 수 있다.

    기기 식별은 `X-Reporter-Id` 헤더로 받는다 — 쿼리 파라미터로 두면 submit·
    draft·photos 모든 호출에 붙여야 해서 비즈니스 인자와 섞인다. 이것은 인증이
    아니라 "누구 건인가"를 가리는 값이고, 남의 건을 보려면 관리자 토큰이 필요하다.
    """
    if not _is_own_or_admin(row, reporter_id, authorization, request.app.state.settings):
        raise HTTPException(status_code=403, detail="이 신고에 접근할 수 없습니다")


@router.post("/{report_id}/draft", status_code=202)
def request_draft(
    report_id: str,
    background: BackgroundTasks,
    request: Request,
    x_reporter_id: str | None = Header(None),
    authorization: str | None = Header(None),
    conn=Depends(get_db_conn),
) -> dict:
    """초안 생성을 의뢰한다. 즉시 202로 돌아가고 생성은 백그라운드에서 돈다."""
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    _require_own_or_admin(row, x_reporter_id, authorization, request)

    if row["status"] == "analyzing":
        # 이미 돌고 있는 잡이 있으면 새로 띄우지 않는다.
        return {"status": "analyzing"}

    settings = request.app.state.settings
    background.add_task(run_draft_job, report_id, settings)
    return {"status": "analyzing"}


@router.patch("/{report_id}/draft", status_code=202)
def patch_draft(
    report_id: str,
    payload: DraftPatch,
    background: BackgroundTasks,
    request: Request,
    x_reporter_id: str | None = Header(None),
    authorization: str | None = Header(None),
    conn=Depends(get_db_conn),
) -> dict:
    """초안을 고치거나, 확인 질문 답변으로 재생성을 요청한다.

    `fields`만 오면 LLM을 부르지 않고 저장만 한다 — 칸 하나 고칠 때마다 사내
    API를 호출할 이유가 없다. `answers`가 오면 재생성 잡을 띄운다.
    """
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    _require_own_or_admin(row, x_reporter_id, authorization, request)

    # 작업자가 고칠 수 있는 칸만 받는다. risk나 sources를 임의로 주입하면
    # 배지·통계가 저장값과 어긋나고, 출처 표시가 거짓이 된다.
    edits = {k: v for k, v in payload.fields.items() if k in EDITABLE_FIELDS}

    if edits:
        draft = json.loads(row["draft_json"]) if row.get("draft_json") else {}
        draft.update(edits)
        # 고친 칸은 출처를 user로 바꾼다. 나머지 칸의 출처는 그대로 둔다.
        sources = draft.get("sources") or {}
        sources.update({field: "user" for field in edits})
        draft["sources"] = sources
        db_module.update_report(
            conn, report_id, {"draft_json": json.dumps(draft, ensure_ascii=False)}
        )

    if payload.answers:
        settings = request.app.state.settings
        background.add_task(
            run_draft_job, report_id, settings, answers=payload.answers
        )

    return {"status": "accepted"}


@router.post("/{report_id}/submit")
def submit_report(
    report_id: str,
    background: BackgroundTasks,
    request: Request,
    x_reporter_id: str | None = Header(None),
    authorization: str | None = Header(None),
    conn=Depends(get_db_conn),
) -> dict:
    """최종 제출 — 한 번의 터치로 끝난다.

    빈 칸이나 미응답 확인 질문을 사유로 거절하지 않는다. 제출을 막으면 기록이
    아예 남지 않고, 그것이 이 제품이 없애려는 원래 문제다(사양 2 안티목표).

    위험도 '상'이면 알림을 띄운다 — 백그라운드로 보내므로 알림이 느려도 작업자의
    제출은 기다리지 않는다.
    """
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    _require_own_or_admin(row, x_reporter_id, authorization, request)

    db_module.update_report(conn, report_id, {"status": "submitted"})

    if row.get("risk") == "상":
        background.add_task(
            notify_high_risk, dict(row), request.app.state.settings
        )

    return {"id": report_id, "status": "submitted"}


@router.post("/{report_id}/acknowledge", dependencies=[Depends(require_admin)])
def acknowledge_report(report_id: str, conn=Depends(get_db_conn)) -> dict:
    """관리자가 고위험 건을 확인했다고 표시한다 — 미확인 큐에서 빠진다."""
    if db_module.get_report(conn, report_id) is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    db_module.update_report(conn, report_id, {"acknowledged": True})
    return {"id": report_id, "acknowledged": True}


@router.get("/{report_id}/draft")
def get_draft(
    report_id: str,
    reporter_id: str,
    request: Request,
    authorization: str | None = Header(None),
    conn=Depends(get_db_conn),
) -> dict:
    """초안 폴링 — 상태와 (있으면) 초안을 돌려준다."""
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")

    if not _is_own_or_admin(row, reporter_id, authorization, request.app.state.settings):
        raise HTTPException(status_code=403, detail="이 신고의 초안을 볼 수 없습니다")

    return {
        "status": row["status"],
        "draft": json.loads(row["draft_json"]) if row.get("draft_json") else None,
        "risk": row.get("risk"),
        "error": row.get("draft_error"),
        # 사진을 함께 내려준다 — 작업자가 초안 화면에 다시 들어왔을 때 자기가
        # 첨부한 사진이 안 보이면, 이미 2장인 줄 모르고 또 올리려 한다.
        "photos": [
            {"photo_id": p["id"], "url": f"/api/photos/{p['id']}"}
            for p in db_module.list_photos(conn, report_id)
        ],
    }


@router.get(
    "/{report_id}", response_model=ReportOut, dependencies=[Depends(require_admin)]
)
def get_report_detail(report_id: str, conn=Depends(get_db_conn)) -> ReportOut:
    """관리자 속보 상세 — 목록과 같은 reporter·identity_line 모양."""
    row = db_module.get_report(conn, report_id)
    if row is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")
    return _row_to_admin_out(row, conn)


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
