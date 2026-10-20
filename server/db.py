"""SQLite 저장소.

원문 저장이 LLM 호출보다 먼저 이뤄져야 한다 — insert_report는 어떤 실패 경로에서도
content를 잃지 않는다. client_uuid UNIQUE 제약으로 재전송(멱등 제출)을 보장한다.
"""
import sqlite3
from datetime import datetime, timezone

_db_path: str | None = None


def init_db(path: str) -> None:
    """주어진 경로에 스키마를 준비한다(이미 있으면 그대로 둠).

    전역 상태는 이 경로를 기억해 두는 용도로만 쓴다(인자 없이 get_conn()을 호출하는
    단순한 단일 프로세스 사용을 위한 기본값). 앱 단위 격리가 필요한 호출(API 라우트 등)은
    항상 명시적으로 경로를 넘겨 get_conn(path)를 써야 한다 — 전역에 의존하면 같은
    프로세스에 여러 앱(예: 테스트의 여러 TestClient)이 떠 있을 때 서로의 DB를 덮어써 버린다.
    """
    global _db_path
    _db_path = path
    conn = get_conn(path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                client_uuid TEXT UNIQUE NOT NULL,
                reporter_id TEXT NOT NULL,
                content TEXT NOT NULL,
                reporter_json TEXT,
                draft_json TEXT,
                risk TEXT,
                risk_reason TEXT,
                category TEXT,
                status TEXT NOT NULL,
                draft_error TEXT,
                acknowledged INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY,
                report_id TEXT NOT NULL,
                path TEXT NOT NULL,
                content_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        _add_missing_columns(conn)
        conn.commit()
    finally:
        conn.close()


def insert_photo(conn: sqlite3.Connection, photo: dict) -> None:
    conn.execute(
        """
        INSERT INTO photos (id, report_id, path, content_type, created_at)
        VALUES (:id, :report_id, :path, :content_type, :created_at)
        """,
        photo,
    )
    conn.commit()


def get_photo(conn: sqlite3.Connection, photo_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
    return dict(row) if row else None


def list_photos(conn: sqlite3.Connection, report_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM photos WHERE report_id = ? ORDER BY created_at",
        (report_id,),
    ).fetchall()
    return [dict(row) for row in rows]


# CREATE TABLE IF NOT EXISTS는 이미 있는 표에 새 칸을 더해주지 않는다. 개발 중에
# 만들어 둔 DB가 있어도 깨지지 않도록, 나중에 추가된 칸은 여기서 메운다.
_LATER_COLUMNS = (("draft_error", "TEXT"),)


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(reports)")}
    for name, coltype in _LATER_COLUMNS:
        if name not in existing:
            conn.execute(f"ALTER TABLE reports ADD COLUMN {name} {coltype}")


def get_conn(path: str | None = None) -> sqlite3.Connection:
    """새 커넥션을 연다.

    path를 명시하면 그 경로로 연결한다(앱/요청마다 독립된 DB를 보장하려면 항상 이렇게 쓴다).
    생략하면 가장 마지막에 init_db가 설정한 경로로 연결한다 — 앱이 하나뿐인 단순한
    상황(스크립트 등)을 위한 편의 기본값일 뿐, 여러 앱이 공존하는 경우엔 쓰지 않는다.
    """
    resolved = path if path is not None else _db_path
    if resolved is None:
        raise RuntimeError("init_db를 먼저 호출해야 합니다")
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    return conn


def insert_report(conn: sqlite3.Connection, report: dict) -> str:
    """신고를 저장한다. client_uuid가 이미 있으면 기존 레코드의 id를 그대로 돌려준다(멱등)."""
    try:
        conn.execute(
            """
            INSERT INTO reports (
                id, client_uuid, reporter_id, content, reporter_json, draft_json,
                risk, risk_reason, category, status, acknowledged, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                report["id"],
                report["client_uuid"],
                report["reporter_id"],
                report["content"],
                report.get("reporter_json"),
                report.get("draft_json"),
                report.get("risk"),
                report.get("risk_reason"),
                report.get("category"),
                report["status"],
                int(report.get("acknowledged", False)),
                report["created_at"],
                report["updated_at"],
            ),
        )
        conn.commit()
        return report["id"]
    except sqlite3.IntegrityError:
        # client_uuid UNIQUE 충돌 — 같은 신고가 재전송된 것이므로 새로 만들지 않는다.
        existing = conn.execute(
            "SELECT id FROM reports WHERE client_uuid = ?", (report["client_uuid"],)
        ).fetchone()
        return existing["id"]


def get_report(conn: sqlite3.Connection, report_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    return dict(row) if row else None


def list_reports(
    conn: sqlite3.Connection,
    *,
    reporter_id: str | None = None,
    risk: str | None = None,
    status: str | None = None,
    since: str | None = None,
) -> list[dict]:
    query = "SELECT * FROM reports WHERE 1=1"
    params: list = []
    if reporter_id is not None:
        query += " AND reporter_id = ?"
        params.append(reporter_id)
    if risk is not None:
        query += " AND risk = ?"
        params.append(risk)
    if status is not None:
        query += " AND status = ?"
        params.append(status)
    if since is not None:
        query += " AND created_at >= ?"
        params.append(since)
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    return [dict(row) for row in rows]


def update_report(conn: sqlite3.Connection, report_id: str, fields: dict) -> None:
    if not fields:
        return
    fields = dict(fields)
    fields["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{key} = ?" for key in fields)
    params = list(fields.values()) + [report_id]
    conn.execute(f"UPDATE reports SET {set_clause} WHERE id = ?", params)
    conn.commit()
