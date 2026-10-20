"""관리자 엔드포인트 접근 가드.

해커톤 범위에서는 사내 SSO·권한 테이블을 연동하지 않는다(설계 비목표). 관리자
구분은 환경변수 토큰(`NEARMISS_ADMIN_TOKEN`) 하나로만 가드한다 — 실제 배포 시
이 자리를 SSO 인증과 역할 기반 권한 테이블로 교체해야 한다. 이 파일이 그 교체 지점이다.
"""
import secrets

from fastapi import Header, HTTPException, Request


def require_admin(request: Request, authorization: str = Header(None)) -> None:
    """`Authorization: Bearer <토큰>` 헤더가 설정된 관리자 토큰과 일치하는지 확인한다.

    토큰이 설정되지 않은 경우(빈 문자열)에도 통과시키지 않는다 — 그렇지 않으면
    헤더 없는 요청(빈 문자열)과 빈 토큰이 `compare_digest`에서 서로 같다고 판정되어
    관리자 토큰을 아예 설정하지 않은 배포가 누구에게나 열리게 된다.
    """
    expected = request.app.state.settings.admin_token
    provided = ""
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):]

    if not expected or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="관리자 토큰이 유효하지 않습니다")
