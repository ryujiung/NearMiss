"""SQLite 저장소.

원문 저장이 LLM 호출보다 먼저 이뤄져야 한다 — insert_report는 어떤 실패 경로에서도
content를 잃지 않는다. client_uuid UNIQUE 제약으로 재전송(멱등 제출)을 보장한다.
"""
import sqlite3
from datetime import datetime, timezone


def init_db(path: str) -> None:
    """주어진 경로에 스키마를 준비한다(이미 있으면 그대로 둠)."""
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


def get_conn(path: str) -> sqlite3.Connection:
    """새 커넥션을 연다. 경로는 필수다.

    전역 폴백을 두지 않는다 — "마지막에 init_db가 설정한 경로"에 의존하면 같은
    프로세스에 앱이 여러 개 떠 있을 때 서로의 DB를 덮어쓴다. 그 결함을 한 번
    고쳤으므로, 인자를 필수로 만들어 다시 생길 수 없게 한다.

    `check_same_thread=False`가 필요한 이유: FastAPI는 동기 의존성
    (get_db_conn)과 동기 핸들러를 **서로 다른 스레드풀 스레드**에서 돌릴 수 있다.
    그러면 의존성이 만든 연결을 핸들러가 다른 스레드에서 쓰게 되고 sqlite3가
    ProgrammingError를 던진다 — 스레드 배정에 따라 간헐적으로 터지므로 한 스레드에
    머무는 TestClient로는 잡히지 않는다.

    이 플래그를 켜도 안전한 이유는 **연결이 동시에 쓰이지 않기** 때문이다. 연결은
    요청 하나가 열고(get_db_conn), 그 요청만 순차적으로 쓰고, 끝나면 닫는다.
    공유되는 것은 "어느 스레드에서 쓰이는가"뿐이고 동시 접근은 없다. 이 전제가
    깨지면(연결을 캐싱하거나 여러 요청이 공유하면) 플래그를 켠 채로는 데이터가
    깨질 수 있으니, 연결을 보관하지 말 것.
    """
    conn = sqlite3.connect(path, check_same_thread=False)
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
