"""API 요청/응답 스키마.

원문(content)은 관리자 토큰 없이 내려가지 않는다 — 단, `/api/reports/mine`은
요청 기기 자신의 신고만 돌려주므로 예외로 content를 포함한다.
"""
from pydantic import BaseModel


class ReporterProfile(BaseModel):
    org: str
    name: str
    role: str


class ReportCreate(BaseModel):
    client_uuid: str
    content: str
    reporter_id: str
    reporter: ReporterProfile | None = None
    created_at: str | None = None


class ReportOut(BaseModel):
    id: str
    status: str
    risk: str | None = None
    category: str | None = None
    created_at: str
    draft: dict | None = None
    # /api/reports/mine은 신고자 본인 기기 응답이므로 원문을 포함한다.
    content: str
