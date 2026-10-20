"""SQLite 저장소.

원문 저장이 LLM 호출보다 먼저 이뤄져야 한다 — insert_report는 어떤 실패 경로에서도
content를 잃지 않는다. client_uuid UNIQUE 제약으로 재전송(멱등 제출)을 보장한다.
"""
import sqlite3
from datetime import datetime, timezone

_db_path: str | None = None


def init_db(path: str) -> None:
    """DB 파일 경로를 설정하고 스키마를 준비한다."""
    global _db_path
    _db_path = path
    conn = get_conn()
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
                acknowledged INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_conn() -> sqlite3.Connection:
    """새 커넥션을 연다. init_db가 먼저 호출되어 있어야 한다."""
    if _db_path is None:
        raise RuntimeError("init_db를 먼저 호출해야 합니다")
    conn = sqlite3.connect(_db_path)
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
