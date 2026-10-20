"""사진 업로드·조회 API.

정의서 6장 속보 양식에 사진 칸이 2개라서 신고당 2장까지 받는다.

파일은 파일시스템(`Settings.photo_dir`)에 두고 DB에는 경로만 남긴다. 저장 파일명은
서버가 만든 UUID를 쓴다 — 업로드한 파일명을 그대로 쓰면 경로 조작(`../../etc/passwd`)과
다른 신고의 사진 덮어쓰기에 노출된다.
"""
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from . import db as db_module
from .routes_reports import get_db_conn

router = APIRouter(prefix="/api", tags=["photos"])

MAX_PHOTOS_PER_REPORT = 2
MAX_BYTES = 10 * 1024 * 1024

# 현장에서 휴대폰 카메라로 찍은 사진을 받는 것이 목적이다. 그 외 타입은 거절한다.
ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


@router.post("/reports/{report_id}/photos", status_code=201)
def upload_photo(
    report_id: str,
    request: Request,
    file: UploadFile = File(...),
    conn=Depends(get_db_conn),
) -> dict:
    """사진 한 장을 받는다.

    동기 핸들러인 이유: SQLite 연결은 스레드에 묶여 있고, 동기 의존성
    (get_db_conn)은 스레드풀에서 돈다. 핸들러를 async로 두면 이벤트 루프
    스레드에서 실행되어 다른 스레드가 만든 연결을 쓰게 되고 바로 터진다.
    다른 라우트들과 같은 방식이다.
    """
    if db_module.get_report(conn, report_id) is None:
        raise HTTPException(status_code=404, detail="신고를 찾을 수 없습니다")

    suffix = ALLOWED_TYPES.get(file.content_type or "")
    if suffix is None:
        raise HTTPException(
            status_code=415,
            detail="이미지 파일(jpeg, png, webp)만 올릴 수 있습니다",
        )

    # 장수 제한은 거절 검사를 모두 통과한 뒤에 센다 — 거절된 업로드가 자리를
    # 차지하면 작업자가 사진을 한 장도 붙일 수 없게 된다.
    if len(db_module.list_photos(conn, report_id)) >= MAX_PHOTOS_PER_REPORT:
        raise HTTPException(
            status_code=409,
            detail=f"사진은 신고당 {MAX_PHOTOS_PER_REPORT}장까지 올릴 수 있습니다",
        )

    # 크기는 읽기 전에 본다 — 거대한 업로드를 전부 메모리로 올린 뒤 거절하면
    # 거절 자체가 공격 수단이 된다.
    if file.size is not None and file.size > MAX_BYTES:
        raise HTTPException(
            status_code=413, detail="사진은 장당 10MB를 넘을 수 없습니다"
        )

    data = file.file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=413, detail="사진은 장당 10MB를 넘을 수 없습니다"
        )

    photo_id = uuid.uuid4().hex
    photo_dir = Path(request.app.state.settings.photo_dir)
    photo_dir.mkdir(parents=True, exist_ok=True)
    path = photo_dir / f"{photo_id}{suffix}"
    path.write_bytes(data)

    db_module.insert_photo(
        conn,
        {
            "id": photo_id,
            "report_id": report_id,
            "path": str(path),
            "content_type": file.content_type,
            "created_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return {"photo_id": photo_id, "url": f"/api/photos/{photo_id}"}


@router.get("/photos/{photo_id}")
def get_photo_file(photo_id: str, conn=Depends(get_db_conn)) -> FileResponse:
    photo = db_module.get_photo(conn, photo_id)
    if photo is None:
        raise HTTPException(status_code=404, detail="사진을 찾을 수 없습니다")
    path = Path(photo["path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="사진 파일이 없습니다")
    return FileResponse(path, media_type=photo["content_type"])
