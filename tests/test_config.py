"""설정 로딩 테스트.

README가 `.env`에 값을 쓰라고 안내하므로, 그 파일이 실제로 읽혀야 한다.
읽히지 않으면 사용자는 키를 넣었는데 적용되지 않는 상황을 디버깅하게 된다.
"""
import os

from server.config import get_settings, load_dotenv


def test_load_dotenv_sets_values_from_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "NEARMISS_MODEL=gemini-2.0-flash\n"
        "NEARMISS_CHAT_PATH=/chat/completions\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("NEARMISS_MODEL", raising=False)
    monkeypatch.delenv("NEARMISS_CHAT_PATH", raising=False)

    load_dotenv(env)

    assert os.environ["NEARMISS_MODEL"] == "gemini-2.0-flash"
    assert os.environ["NEARMISS_CHAT_PATH"] == "/chat/completions"


def test_real_environment_wins_over_dotenv(tmp_path, monkeypatch):
    # 명령줄에서 준 값이 파일에 덮이면, 한 번만 다르게 돌려보는 게 불가능해진다.
    env = tmp_path / ".env"
    env.write_text("NEARMISS_MODEL=from-file\n", encoding="utf-8")
    monkeypatch.setenv("NEARMISS_MODEL", "from-shell")

    load_dotenv(env)

    assert os.environ["NEARMISS_MODEL"] == "from-shell"


def test_load_dotenv_ignores_comments_blanks_and_quotes(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text(
        "\n# 주석\nNEARMISS_MODEL=\"quoted-value\"\n  \nNEARMISS_CHAT_PATH=\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("NEARMISS_MODEL", raising=False)
    monkeypatch.delenv("NEARMISS_CHAT_PATH", raising=False)

    load_dotenv(env)

    assert os.environ["NEARMISS_MODEL"] == "quoted-value"
    # 빈 값은 "설정하지 않음"으로 둔다 — .env.example이 전부 빈 값이기 때문이다.
    assert "NEARMISS_CHAT_PATH" not in os.environ


def test_load_dotenv_without_file_is_silent(tmp_path):
    load_dotenv(tmp_path / "없는파일")


def test_get_settings_reads_dotenv(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("NEARMISS_MODEL=from-dotenv\n", encoding="utf-8")
    monkeypatch.delenv("NEARMISS_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)

    assert get_settings().model == "from-dotenv"


def test_connection_can_be_used_from_another_thread(tmp_path):
    """FastAPI는 의존성과 핸들러를 서로 다른 스레드풀 스레드에서 돌릴 수 있다.

    get_db_conn이 yield한 연결을 핸들러가 다른 스레드에서 쓰면 sqlite3가
    ProgrammingError를 던진다 — 스레드 배정에 따라 간헐적으로 터지고, TestClient는
    한 스레드에 머물러서 자동 테스트가 못 잡는다. 실제로 브라우저에서
    POST /api/reports가 500으로 터지는 것을 보고 찾았다.
    """
    import threading

    from server import db as db_module

    path = str(tmp_path / "threads.db")
    db_module.init_db(path)
    conn = db_module.get_conn(path)
    errors = []

    def use_it():
        try:
            conn.execute("SELECT COUNT(*) FROM reports").fetchone()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    worker = threading.Thread(target=use_it)
    worker.start()
    worker.join()
    conn.close()

    assert not errors, f"다른 스레드에서 쓸 수 없다: {errors[0]}"
