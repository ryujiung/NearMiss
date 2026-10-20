"""API 요청/응답 스키마.

원문(content)은 관리자 토큰 없이 내려가지 않는다 — 단, `/api/reports/mine`은
요청 기기 자신의 신고만 돌려주므로 예외로 content를 포함한다.
"""
from pydantic import BaseModel


class ReporterProfile(BaseModel):
    org: str
    name: str
    role: str
    # 아차사고를 겪은 당사자 인원수. 신고 1건에 여러 명이 연관될 수 있다
    # (예: "박 ○○ 등 3명"). 기본값 1은 당사자가 신고자 본인 1명뿐인 경우다.
    count: int = 1


class ReportCreate(BaseModel):
    client_uuid: str
    content: str
    reporter_id: str
    reporter: ReporterProfile | None = None
    created_at: str | None = None


class ReporterOut(BaseModel):
    """관리자 응답에 실리는 인적사항 블록.

    `/identity`를 제외한 모든 응답에서는 name이 마스킹된 값이어야 한다 — 그 보장은
    이 모델이 아니라 routes_reports.py의 단일 직렬화 지점(_masked_reporter_and_identity)
    에서 한다.
    """

    org: str
    name: str
    role: str
    count: int


class ReportOut(BaseModel):
    id: str
    status: str
    risk: str | None = None
    category: str | None = None
    created_at: str
    draft: dict | None = None
    # /api/reports/mine은 신고자 본인 기기 응답이므로 원문을 포함한다.
    # 관리자 목록·상세 응답도 원문을 포함한다(사양 3.11) — 원문 비노출 엔드포인트는
    # /api/stats 뿐이고 그건 별도 모델을 쓴다.
    content: str
    # 관리자 목록·상세 응답에만 채워진다. /mine 응답에는 없다(None).
    reporter: ReporterOut | None = None
    identity_line: str | None = None
    # 속보 양식의 사진 칸(최대 2장). 관리자 응답에만 채운다.
    photos: list[dict] = []


class DraftPatch(BaseModel):
    """초안 수정/재생성 요청.

    둘 다 선택이다. `fields`만 오면 저장만 하고, `answers`가 오면 재생성한다.
    둘 다 비어 있어도 거절하지 않는다 — 작업자가 확인 질문을 건너뛰고 그대로
    제출하는 경로를 막지 않기 위해서다.
    """

    answers: dict[str, str] = {}
    fields: dict[str, object] = {}
