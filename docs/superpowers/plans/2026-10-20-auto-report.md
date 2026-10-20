# 자동 보고서 작성 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 작업자가 남긴 한 줄을 사내 GPT API가 니어미스 속보 양식(일시·장소·인적사항·발생개요·발생원인 3분류·재발방지 대책)과 위험도 상/중/하로 자동 작성하고, 작업자 확인 후 제출된 건을 관리자가 목록·속보 상세·주간/월간 집계로 받아보게 한다.

**Architecture:** FastAPI 한 프로세스가 기존 정적 파일(`index.html`, `css/`, `js/`)을 서빙하면서 `/api/*`를 제공한다. 신고 원문은 LLM 호출 전에 SQLite에 먼저 저장되고, 초안 생성은 비동기 잡으로 돌며 프론트엔드가 폴링한다. 실명은 DB에만 두고 응답 단계에서 마스킹하며, LLM 프롬프트에는 자리표시자로 치환해 보낸다. 프론트엔드는 기존 관례대로 빌드 도구 없이 전역 IIFE 모듈을 추가한다.

**Tech Stack:** Python 3.13 / FastAPI / uvicorn / SQLite(`sqlite3` 표준 라이브러리) / httpx / pytest. 프론트엔드는 바닐라 JS·CSS, 라이브러리 없음.

**Spec:** `docs/superpowers/specs/2026-10-20-auto-report-design.md`

## Global Constraints

- **원문 저장이 LLM 호출보다 먼저.** 어떤 실패 경로에서도 신고 원문이 유실되지 않는다. (spec 3.1)
- **초안 화면에 필수 입력 칸을 만들지 않는다.** 빈 칸이 있어도, 확인 질문에 답하지 않아도 제출된다. (spec 2 안티목표)
- **실명은 `GET /api/reports/{id}/identity` 로만 내려간다.** 목록·상세 등 다른 모든 응답의 인적사항은 마스킹된 값이다. (spec 3.4)
- **LLM 프롬프트에 실명·사번을 넣지 않는다.** 인적사항은 `[당사자]` 자리표시자로 치환해 보내고, 응답을 받은 뒤 되돌린다. (spec 3.4)
- **원문(`content`)은 관리자 토큰 없이 내려가지 않는다.** 예외는 `GET /api/reports/mine`(자기 기기 건만). (spec 3.11)
- **위험도 값은 `상` / `중` / `하` 세 개뿐**이고, 미분류 상태는 값이 아니라 `status`로 표현한다. (spec 3.3, 3.8)
- **위험도 기준 문면은 `server/risk.py` 상수 한 곳**에만 둔다. 프롬프트가 거기서 읽어간다. (spec 3.3)
- **위험도를 색만으로 구분하지 않는다.** 배지에 `상`/`중`/`하` 글자를 함께 넣는다. (spec 4 접근성)
- **프론트엔드는 빌드 도구·프레임워크·차트 라이브러리를 쓰지 않는다.** `js/` 아래 전역 IIFE 모듈, `css/style.css`의 기존 토큰을 따른다. (spec 4)
- **API는 상대 경로로만 호출한다.** 호스트·포트를 하드코딩하지 않는다. (spec 4)
- **환경변수:** `NEARMISS_API_BASE_URL`, `NEARMISS_API_KEY`, `NEARMISS_MODEL`, `NEARMISS_ADMIN_TOKEN`, `NEARMISS_WEBHOOK_URL`(선택), `NEARMISS_LLM_MODE`(선택, `mock`). 키를 코드에 하드코딩하지 않는다. (spec 4)
- **AI가 채운 칸은 화면에서 시각적으로 표시**하고, 사용자가 고친 칸은 표시가 사라진다. (spec 3.2)
- **한국어만.** UI 문자열·프롬프트·보고서 모두.
- 사내 API의 JSON mode·function calling 지원 여부가 불확실하므로 **프롬프트로 JSON을 지시하고 응답을 파싱**한다. (spec 4)

## Review Focus

사양이 함축하지만 어느 태스크의 테스트도 저절로 커버하지 않는 입력들. 각 줄의 테스트를 해당 태스크에 넣어 두었다.

1. **마스킹 경계 입력** — 2글자 이름(`김민`), 외자 성, 복성(`남궁현수`), 영문 이름, 빈 문자열. 성만 남기는 규칙이 깨지면 이름이 그대로 노출되거나 마스킹이 과해져 누군지 알 수 없게 된다. → Task 2
2. **LLM이 돌려준 비정규 위험도 값** — `"높음"`, `"High"`, `"상/중"`, `null`, 누락. 그대로 저장되면 배지·필터·집계가 전부 어긋난다. 정규화하거나 실패로 처리해야 한다. → Task 4
3. **JSON이 아닌 응답 포장** — 마크다운 코드펜스로 감싼 JSON, 앞뒤에 설명 문장이 붙은 JSON, 후행 쉼표. 사내 API가 JSON mode를 지원하지 않으면 흔하게 일어난다. → Task 4
4. **같은 신고의 중복 전송** — 오프라인 큐가 응답을 못 받고 재시도하면 동일 신고가 두 번 들어간다. 클라이언트 UUID로 멱등해야 한다. → Task 1
5. **초안 생성 중 새로고침·탭 이탈 후 재진입** — 잡 상태가 메모리에만 있으면 폴링이 영원히 돌거나 `draft`가 영구 미분류로 남는다. 상태는 DB에 있어야 한다. → Task 6

---

## File Structure

**백엔드 (신규)**

| 파일 | 책임 |
|---|---|
| `server/main.py` | FastAPI 앱 조립, 라우터 등록, 정적 파일 서빙 |
| `server/config.py` | 환경변수 로딩 (6개), 기본값 |
| `server/db.py` | SQLite 연결·스키마·CRUD |
| `server/models.py` | Pydantic 요청/응답 모델 |
| `server/masking.py` | 이름 마스킹 (순수 함수) |
| `server/risk.py` | 위험도 기준 상수 + 값 정규화 |
| `server/prompt.py` | 프롬프트 조립, PII 치환/복원, 응답 JSON 파싱 |
| `server/llm.py` | 프로바이더 인터페이스 + 사내 API 호출 + mock |
| `server/drafts.py` | 초안 생성 잡 실행·상태 전이 |
| `server/auth.py` | 관리자 토큰 의존성 |
| `server/webhook.py` | 고위험 건 웹훅 발송 |
| `server/routes_reports.py` | `/api/reports*` |
| `server/routes_stats.py` | `/api/stats` |
| `server/seed.py` | 데모 시드 스크립트 |
| `tests/` | pytest |

**프론트엔드**

| 파일 | 책임 |
|---|---|
| `js/profile.js` | 신규 — `reporterId`, 신고자 프로필, 관리자 토큰 보관 |
| `js/brief-doc.js` | 신규 — 속보 문서 렌더러 (초안 화면·관리자 상세 공용) |
| `js/draft-view.js` | 신규 — 초안 화면: 폴링·칸 편집·확인 질문·사진·제출 |
| `js/admin.js` | 신규 — 관리자 탭: 배너·목록·필터·상세·실명 토글·집계 |
| `js/store.js` | 수정 — 서버 연동, 오프라인 큐, `reporterId` 부착 |
| `js/stats.js` | 수정 — 레코드 배열 대신 집계 결과를 받아 그림 |
| `js/app.js` | 수정 — 탭 3개, 초안 화면 흐름 연결 |
| `index.html` | 수정 — 관리자 탭, 초안 화면 컨테이너, 설정 화면, 새 스크립트 |
| `css/style.css` | 수정 — 초안·속보·관리자 스타일 + 인쇄용 CSS |

---

## Task 1: 서버 스캐폴드 — SQLite 저장, 멱등 제출, 정적 서빙

**Files:**
- Create: `server/__init__.py`, `server/config.py`, `server/db.py`, `server/models.py`, `server/routes_reports.py`, `server/main.py`
- Create: `requirements.txt`, `.env.example`, `README.md`
- Test: `tests/conftest.py`, `tests/test_reports_create.py`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `server/config.py`: `Settings` 데이터클래스 — 필드 `api_base_url: str`, `api_key: str`, `model: str`, `admin_token: str`, `webhook_url: str | None`, `llm_mode: str`(기본 `"live"`), `db_path: str`. `get_settings() -> Settings`
  - `server/db.py`: `init_db(path: str) -> None`, `get_conn() -> sqlite3.Connection`, `insert_report(conn, report: dict) -> str`(반환: id), `get_report(conn, report_id: str) -> dict | None`, `list_reports(conn, *, reporter_id: str | None = None, risk: str | None = None, status: str | None = None, since: str | None = None) -> list[dict]`, `update_report(conn, report_id: str, fields: dict) -> None`
  - `server/models.py`: `ReportCreate`(필드 `client_uuid: str`, `content: str`, `reporter_id: str`, `reporter: ReporterProfile | None`, `created_at: str | None`), `ReporterProfile`(`org: str`, `name: str`, `role: str`), `ReportOut`(`id`, `status`, `risk`, `category`, `created_at`, `draft`)
  - `POST /api/reports` → `201 {"id": str, "status": "draft"}`
  - `GET /api/reports/mine?reporter_id=<id>` → `200 [ReportOut...]` (원문 포함)

스키마 설계는 빌더 재량이되 최소 컬럼: `id`, `client_uuid`(UNIQUE), `reporter_id`, `content`, `reporter_json`, `draft_json`, `risk`, `risk_reason`, `category`, `status`, `acknowledged`, `created_at`, `updated_at`. `status` 값은 `draft` | `analyzing` | `ready` | `submitted` | `failed`.

- [ ] **Step 1: `requirements.txt`, `.env.example`, `README.md` 작성**

`requirements.txt`: `fastapi`, `uvicorn[standard]`, `httpx`, `pytest`, `pytest-asyncio`.
`.env.example`: Global Constraints의 환경변수 6개를 주석과 함께. 값은 모두 비워 둔다.
`README.md`: 가상환경 생성 → `pip install -r requirements.txt` → `.env` 작성 → `uvicorn server.main:app --reload` → `http://localhost:8000`. **데모는 노트북 브라우저의 모바일 뷰로 한다**는 점과 그 이유(실기기 `http://192.168.x.x`는 음성·카메라가 차단됨)를 한 줄로 적는다.

- [ ] **Step 2: 실패하는 테스트 작성**

`tests/conftest.py`에 임시 DB를 쓰는 `client` 픽스처(FastAPI `TestClient`)를 둔다.

```python
def test_create_report_stores_content_and_returns_draft_status(client):
    r = client.post("/api/reports", json={
        "client_uuid": "u-1", "content": "3층 계단 난간 헐거움, 넘어질 뻔함",
        "reporter_id": "dev-1",
    })
    assert r.status_code == 201
    assert r.json()["status"] == "draft"

def test_duplicate_client_uuid_does_not_create_second_report(client):
    body = {"client_uuid": "u-1", "content": "같은 신고", "reporter_id": "dev-1"}
    first = client.post("/api/reports", json=body)
    second = client.post("/api/reports", json=body)
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert len(client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()) == 1

def test_mine_returns_only_own_device_reports(client):
    client.post("/api/reports", json={"client_uuid": "a", "content": "내 것", "reporter_id": "dev-1"})
    client.post("/api/reports", json={"client_uuid": "b", "content": "남의 것", "reporter_id": "dev-2"})
    mine = client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()
    assert [r["content"] for r in mine] == ["내 것"]

def test_index_html_is_served_at_root(client):
    assert client.get("/").status_code == 200
```

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_reports_create.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server'`

- [ ] **Step 4: `server/config.py`, `server/db.py`, `server/models.py` 구현**

Produces 블록의 시그니처대로. `insert_report`는 `client_uuid` UNIQUE 제약으로 멱등성을 보장하고, 충돌 시 기존 레코드의 id를 돌려준다(새로 만들지 않는다). 날짜는 ISO 8601 문자열로 저장한다.

- [ ] **Step 5: `server/routes_reports.py`, `server/main.py` 구현**

`main.py`는 라우터 등록 후 `index.html`·`css/`·`js/`를 서빙한다. **정적 마운트가 `/api` 라우트를 가리지 않도록** API 라우터를 먼저 등록한다. 신규 생성은 201, 멱등 재전송은 200으로 구분한다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `python -m pytest tests/test_reports_create.py -v`
Expected: 4 passed

- [ ] **Step 7: 커밋**

```bash
git add requirements.txt .env.example README.md server tests
git commit -m "feat: FastAPI 서버 스캐폴드 — SQLite 저장, 멱등 제출, 정적 서빙"
```

---

## Task 2: 이름 마스킹

**Files:**
- Create: `server/masking.py`
- Test: `tests/test_masking.py`

**Interfaces:**
- Consumes: 없음
- Produces: `mask_name(name: str) -> str`, `format_identity(reporter: dict, count: int) -> str`

두 함수의 역할이 다르다. `mask_name`은 **이름 한 개**를 가린다(응답 직렬화에서 `reporter.name`에 적용). `format_identity`는 **속보 문서의 `성명` 줄 문자열**을 만든다 — `count > 1`이면 `"박 ○○ 등 3명"`, 아니면 `"박 ○○"`.

- [ ] **Step 1: 실패하는 테스트 작성**

사양이 고정한 것은 "성만 남기고 나머지 글자를 `○`" 하나다. 아래가 그 규칙의 경계들이다 (Review Focus 1).

```python
import pytest
from server.masking import mask_name, format_identity

@pytest.mark.parametrize("name,expected", [
    ("박민수", "박 ○○"),
    ("김민", "김 ○"),
    ("남궁현수", "남궁 ○○"),
    ("황보영", "황보 ○"),
    ("박", "박"),
    ("", ""),
    ("   ", ""),
    ("Kim Minsu", "K○○ ○○○○○"),
])
def test_mask_name_keeps_surname_only(name, expected):
    assert mask_name(name) == expected

def test_format_identity_appends_count_when_multiple():
    assert format_identity({"name": "박민수"}, 3) == "박 ○○ 등 3명"

def test_format_identity_omits_count_when_single():
    assert format_identity({"name": "박민수"}, 1) == "박 ○○"

def test_format_identity_without_name_falls_back_to_count():
    assert format_identity({"name": ""}, 3) == "외 3명"
```

복성 목록은 `server/masking.py` 안의 상수로 둔다 (`남궁`, `황보`, `제갈`, `선우`, `서문`, `독고`). 한글이 아닌 이름은 공백으로 토큰을 나눠 각 토큰의 첫 글자만 남긴다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_masking.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.masking'`

- [ ] **Step 3: `mask_name`, `format_identity` 구현**

- [ ] **Step 4: 테스트 통과 확인**

Run: `python -m pytest tests/test_masking.py -v`
Expected: 12 passed

- [ ] **Step 5: 커밋**

```bash
git add server/masking.py tests/test_masking.py
git commit -m "feat: 이름 마스킹 — 성만 남기고 나머지는 ○"
```

---

## Task 3: 접근 제어 — 관리자 토큰과 엔드포인트별 노출 범위

**Files:**
- Create: `server/auth.py`
- Modify: `server/routes_reports.py`
- Test: `tests/test_access_control.py`

**Interfaces:**
- Consumes: Task 1의 `list_reports`/`get_report`, Task 2의 `format_identity`
- Produces:
  - `server/auth.py`: `require_admin(authorization: str = Header(None)) -> None` — FastAPI 의존성. `Authorization: Bearer <NEARMISS_ADMIN_TOKEN>` 불일치 시 `401`
  - `GET /api/reports` (관리자) → 원문 포함, `reporter: {"org": str, "name": str(마스킹), "role": str, "count": int}`, `identity_line: str`(`format_identity` 결과)
  - `GET /api/reports/{id}` (관리자) → 속보 상세, 같은 `reporter`·`identity_line` 모양
  - `GET /api/reports/{id}/identity` (관리자) → `{"org": str, "name": str(실명), "role": str, "count": int}`
  - Task 1의 `ReportOut`에 `reporter`·`identity_line` 두 필드가 추가된다

- [ ] **Step 1: 실패하는 테스트 작성**

```python
ADMIN = {"Authorization": "Bearer test-admin-token"}

def test_admin_list_requires_token(client):
    assert client.get("/api/reports").status_code == 401

def test_admin_list_returns_masked_name(client, seeded_report):
    rows = client.get("/api/reports", headers=ADMIN).json()
    assert rows[0]["reporter"]["name"] == "박 ○○"

def test_admin_list_identity_line_includes_count(client, seeded_report):
    rows = client.get("/api/reports", headers=ADMIN).json()
    assert rows[0]["identity_line"] == "박 ○○ 등 3명"

def test_identity_endpoint_returns_real_name(client, seeded_report):
    body = client.get(f"/api/reports/{seeded_report}/identity", headers=ADMIN).json()
    assert body["name"] == "박민수"

def test_identity_endpoint_requires_token(client, seeded_report):
    assert client.get(f"/api/reports/{seeded_report}/identity").status_code == 401

def test_detail_response_never_contains_real_name(client, seeded_report):
    body = client.get(f"/api/reports/{seeded_report}", headers=ADMIN).text
    assert "박민수" not in body

def test_mine_does_not_leak_other_devices(client, seeded_report):
    rows = client.get("/api/reports/mine", params={"reporter_id": "other-device"}).json()
    assert rows == []
```

`tests/conftest.py`에 `seeded_report` 픽스처를 추가한다 — `reporter={"org": "두원기업", "name": "박민수", "role": "축로공"}`, `count=3`인 신고 하나를 넣고 그 id를 돌려준다. 관리자 토큰은 픽스처에서 `test-admin-token`으로 설정한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_access_control.py -v`
Expected: FAIL — `/api/reports`가 404 (아직 없음)

- [ ] **Step 3: `server/auth.py` 구현**

토큰 비교는 `secrets.compare_digest`로 한다. 사양의 비목표대로 SSO·권한 테이블은 만들지 않되, **"실제 배포 시 SSO·권한 테이블로 교체하는 자리"임을 모듈 상단 주석에 남긴다.**

- [ ] **Step 4: `routes_reports.py`에 관리자 엔드포인트 3개 추가**

응답 직렬화 지점에서 `format_identity`를 적용한다 — 마스킹은 저장이 아니라 출력 단계다. `/identity`만 실명을 담고, 나머지 응답에 실명이 섞이지 않는 경로로 만든다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `python -m pytest tests/ -v`
Expected: all passed

- [ ] **Step 6: 커밋**

```bash
git add server/auth.py server/routes_reports.py tests
git commit -m "feat: 관리자 토큰 가드와 엔드포인트별 인적사항 노출 범위"
```

---

## Task 4: 위험도 기준·프롬프트 조립·응답 파싱

**Files:**
- Create: `server/risk.py`, `server/prompt.py`
- Test: `tests/test_risk.py`, `tests/test_prompt.py`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces:
  - `server/risk.py`: `RISK_LEVELS = ("상", "중", "하")`, `RISK_CRITERIA: str`(사양 3.3의 세 줄 기준 문면 — 이 상수가 유일한 출처), `normalize_risk(value) -> str | None`
  - `server/prompt.py`: `build_draft_prompt(content: str, now: datetime, answers: dict[str, str] | None = None, locked: dict[str, str] | None = None) -> list[dict]`(chat messages), `IDENTITY_PLACEHOLDER = "[당사자]"`, `parse_draft_response(text: str) -> dict`(파싱 실패 시 `DraftParseError`), `DraftParseError`

`parse_draft_response`가 돌려주는 dict 키: `title`, `risk`, `risk_reason`, `category`, `occurred_at`, `location`, `overview`(list[str]), `causes`(dict with keys `physical`, `process`, `organizational`), `countermeasures`(list[str]), `questions`(list[str], 최대 2개).

- [ ] **Step 1: 실패하는 테스트 작성 — 위험도 정규화 (Review Focus 2)**

```python
import pytest
from server.risk import normalize_risk, RISK_LEVELS, RISK_CRITERIA

@pytest.mark.parametrize("raw,expected", [
    ("상", "상"), ("중", "중"), ("하", "하"),
    (" 상 ", "상"), ("높음", "상"), ("보통", "중"), ("낮음", "하"),
    ("High", "상"), ("MEDIUM", "중"), ("low", "하"),
])
def test_normalize_risk_maps_known_variants(raw, expected):
    assert normalize_risk(raw) == expected

@pytest.mark.parametrize("raw", ["상/중", "매우 높음", "", None, 3, "unknown"])
def test_normalize_risk_returns_none_for_unrecognized(raw):
    assert normalize_risk(raw) is None

def test_risk_criteria_mentions_all_three_levels():
    for level in RISK_LEVELS:
        assert level in RISK_CRITERIA
```

- [ ] **Step 2: 실패하는 테스트 작성 — 프롬프트와 파싱 (Review Focus 3)**

```python
import pytest
from server.prompt import build_draft_prompt, parse_draft_response, DraftParseError, IDENTITY_PLACEHOLDER
from server.risk import RISK_CRITERIA

def test_prompt_embeds_risk_criteria_from_single_source():
    msgs = build_draft_prompt("3층 계단 난간 헐거움", now=NOW)
    assert RISK_CRITERIA in "".join(m["content"] for m in msgs)

def test_prompt_never_contains_real_name():
    msgs = build_draft_prompt("박민수가 미끄러질 뻔함", now=NOW)
    joined = "".join(m["content"] for m in msgs)
    assert IDENTITY_PLACEHOLDER in joined

def test_prompt_includes_answers_and_locked_fields_as_facts():
    msgs = build_draft_prompt("난간 헐거움", now=NOW,
                              answers={"장소가 어디인가요?": "2공장 3층"},
                              locked={"location": "본관 3층"})
    joined = "".join(m["content"] for m in msgs)
    assert "2공장 3층" in joined and "본관 3층" in joined

@pytest.mark.parametrize("wrapped", [
    '{"risk": "상"}',
    '```json\n{"risk": "상"}\n```',
    '```\n{"risk": "상"}\n```',
    '다음과 같이 분석했습니다.\n{"risk": "상"}\n이상입니다.',
    '{"risk": "상",}',
])
def test_parse_draft_response_unwraps_common_packagings(wrapped):
    assert parse_draft_response(wrapped)["risk"] == "상"

def test_parse_draft_response_normalizes_risk():
    assert parse_draft_response('{"risk": "높음"}')["risk"] == "상"

def test_parse_draft_response_drops_unrecognized_risk():
    assert parse_draft_response('{"risk": "상/중"}')["risk"] is None

def test_parse_draft_response_caps_questions_at_two():
    out = parse_draft_response('{"questions": ["a", "b", "c"]}')
    assert len(out["questions"]) == 2

def test_parse_draft_response_raises_when_no_json_present():
    with pytest.raises(DraftParseError):
        parse_draft_response("죄송합니다, 분석할 수 없습니다.")

def test_parse_draft_response_fills_missing_keys_with_empty_values():
    out = parse_draft_response('{"risk": "중"}')
    assert out["overview"] == [] and out["causes"]["physical"] == ""
```

`NOW`는 테스트 모듈 상단에 고정 `datetime`으로 둔다.

- [ ] **Step 3: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_risk.py tests/test_prompt.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.risk'`

- [ ] **Step 4: `server/risk.py` 구현**

`RISK_CRITERIA`는 사양 3.3의 상·중·하 세 줄과 "판단이 갈리면 높은 쪽으로" 규칙을 담는다. 이 문면을 다른 파일에 복사하지 않는다.

- [ ] **Step 5: `server/prompt.py` 구현**

프롬프트는 사양 3.2 표의 칸 전부와 3.5의 확인 질문 규칙(최대 2개, 양식의 빈 칸을 메우는 것에 한정, 열린 질문 금지)을 지시한다. 파싱은 코드펜스·전후 설명문·후행 쉼표를 벗겨내고, 누락 키는 빈 값으로 채우며, `risk`는 `normalize_risk`를 통과시킨다. **누락과 파싱 불가를 구분한다** — 키가 없는 것은 빈 값이고, JSON 자체가 없는 것만 `DraftParseError`다.

- [ ] **Step 6: 테스트 통과 확인**

Run: `python -m pytest tests/test_risk.py tests/test_prompt.py -v`
Expected: all passed

- [ ] **Step 7: 커밋**

```bash
git add server/risk.py server/prompt.py tests/test_risk.py tests/test_prompt.py
git commit -m "feat: 위험도 기준 상수, 프롬프트 조립, 응답 JSON 파싱"
```

---

## Task 5: LLM 프로바이더 — 사내 API와 mock

**Files:**
- Create: `server/llm.py`, `server/fixtures/mock_draft.json`
- Test: `tests/test_llm.py`

**Interfaces:**
- Consumes: Task 1의 `Settings`
- Produces:
  - `class LLMProvider(Protocol)`: `async def complete(self, messages: list[dict]) -> str`
  - `class LiveProvider` — `POST {api_base_url}/v1/chat/completions`, 헤더 `Authorization: Bearer {api_key}`, 바디 `{"model": ..., "messages": ...}`. 응답에서 `choices[0].message.content` 추출
  - `class MockProvider` — `server/fixtures/mock_draft.json`의 내용을 문자열로 돌려줌
  - `get_provider(settings: Settings) -> LLMProvider` — `settings.llm_mode == "mock"`이면 `MockProvider`
  - `class LLMError(Exception)`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_get_provider_returns_mock_when_mode_is_mock():
    assert isinstance(get_provider(settings(llm_mode="mock")), MockProvider)

@pytest.mark.asyncio
async def test_mock_provider_returns_parseable_draft():
    text = await MockProvider().complete([])
    assert parse_draft_response(text)["risk"] in RISK_LEVELS

@pytest.mark.asyncio
async def test_live_provider_sends_bearer_auth_and_model(httpx_mock):
    httpx_mock.add_response(json={"choices": [{"message": {"content": "{}"}}]})
    await LiveProvider(settings(api_key="k", model="m")).complete([{"role": "user", "content": "x"}])
    req = httpx_mock.get_request()
    assert req.headers["authorization"] == "Bearer k"
    assert json.loads(req.content)["model"] == "m"

@pytest.mark.asyncio
async def test_live_provider_raises_llm_error_on_http_error(httpx_mock):
    httpx_mock.add_response(status_code=500)
    with pytest.raises(LLMError):
        await LiveProvider(settings()).complete([])

@pytest.mark.asyncio
async def test_live_provider_raises_llm_error_on_timeout(httpx_mock):
    httpx_mock.add_exception(httpx.ReadTimeout("slow"))
    with pytest.raises(LLMError):
        await LiveProvider(settings()).complete([])
```

`pytest-httpx`를 `requirements.txt`에 추가한다. `settings(**kw)`는 `tests/conftest.py`의 헬퍼로, 기본값 위에 덮어쓴 `Settings`를 돌려준다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_llm.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.llm'`

- [ ] **Step 3: `server/fixtures/mock_draft.json` 작성**

사양 3.2의 모든 칸을 채운 현실적인 한 건. 과제정의서 5장의 예시 입력(`"3층 계단 난간 헐거움, 넘어질 뻔함"`)에 대응하는 내용으로 쓰고, `questions`에 1개를 넣어 확인 질문 경로도 mock에서 재현되게 한다.

- [ ] **Step 4: `server/llm.py` 구현**

타임아웃은 넉넉히(기본 120초) 두고 `Settings`에서 조정 가능하게 한다 — 사양이 응답 지연을 모르는 전제이기 때문이다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `python -m pytest tests/test_llm.py -v`
Expected: 5 passed

- [ ] **Step 6: 커밋**

```bash
git add server/llm.py server/fixtures requirements.txt tests/test_llm.py
git commit -m "feat: LLM 프로바이더 — 사내 API 호출과 mock 모드"
```

---

## Task 6: 초안 생성 비동기 잡과 폴링

**Files:**
- Create: `server/drafts.py`
- Modify: `server/routes_reports.py`
- Test: `tests/test_draft_job.py`

**Interfaces:**
- Consumes: Task 1의 `db`, Task 4의 `build_draft_prompt`/`parse_draft_response`, Task 5의 `get_provider`
- Produces:
  - `async def run_draft_job(report_id: str, *, answers: dict | None = None) -> None` — 상태를 `analyzing`으로 올리고, LLM 호출·파싱 후 `draft_json`·`risk`·`risk_reason`·`category`를 채우고 `ready`로, 실패 시 `failed`로 전이
  - `POST /api/reports/{id}/draft` → `202 {"status": "analyzing"}` (백그라운드 태스크로 `run_draft_job` 실행)
  - `GET /api/reports/{id}/draft?reporter_id=<id>` → `200 {"status": ..., "draft": {...} | None, "risk": ..., "error": str | None}`

폴링 엔드포인트는 **자기 기기 건이면 토큰 없이** 접근한다(작업자가 자기 초안을 봐야 한다). `reporter_id` 불일치이고 관리자 토큰도 없으면 `403`.

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_draft_endpoint_returns_202_immediately(client, report_id):
    r = client.post(f"/api/reports/{report_id}/draft")
    assert r.status_code == 202

def test_job_fills_draft_and_sets_ready(client, report_id):  # mock 프로바이더
    client.post(f"/api/reports/{report_id}/draft")
    body = client.get(f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}).json()
    assert body["status"] == "ready"
    assert body["risk"] in RISK_LEVELS
    assert body["draft"]["causes"]["physical"]

def test_job_failure_keeps_content_and_sets_failed(client, report_id, broken_provider):
    client.post(f"/api/reports/{report_id}/draft")
    body = client.get(f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}).json()
    assert body["status"] == "failed"
    assert client.get("/api/reports/mine", params={"reporter_id": "dev-1"}).json()[0]["content"]

def test_failed_job_can_be_retried(client, report_id, broken_then_working_provider):
    client.post(f"/api/reports/{report_id}/draft")
    client.post(f"/api/reports/{report_id}/draft")
    body = client.get(f"/api/reports/{report_id}/draft", params={"reporter_id": "dev-1"}).json()
    assert body["status"] == "ready"

def test_draft_status_survives_new_client_session(client, report_id):
    # Review Focus 5 — 상태가 메모리가 아니라 DB에 있어야 한다
    client.post(f"/api/reports/{report_id}/draft")
    fresh = make_client(same_db=True)
    assert fresh.get(f"/api/reports/{report_id}/draft",
                     params={"reporter_id": "dev-1"}).json()["status"] == "ready"

def test_draft_polling_forbidden_for_other_device_without_token(client, report_id):
    assert client.get(f"/api/reports/{report_id}/draft",
                      params={"reporter_id": "other"}).status_code == 403

def test_prompt_receives_placeholder_not_real_name(client, report_id_with_name, capture_provider):
    client.post(f"/api/reports/{report_id_with_name}/draft")
    assert "박민수" not in capture_provider.last_prompt_text
```

`broken_provider`, `broken_then_working_provider`, `capture_provider`는 `conftest.py`의 픽스처로 `get_provider`를 대체한다. 파싱 실패 시 1회 재시도(사양 4)는 `broken_then_working_provider`가 아니라 `run_draft_job` 내부에서 일어나므로, 재시도 횟수를 세는 테스트를 하나 더 둔다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_draft_job.py -v`
Expected: FAIL — `/api/reports/{id}/draft`가 404

- [ ] **Step 3: `server/drafts.py` 구현**

`DraftParseError`가 나면 **1회 재시도**하고, 그래도 실패하면 `failed`로 전이하며 `content`는 건드리지 않는다. 잡 상태는 전부 DB의 `status` 컬럼에 쓴다 — 메모리 딕셔너리에 들고 있으면 Review Focus 5가 깨진다.

- [ ] **Step 4: 폴링·트리거 엔드포인트 추가**

FastAPI `BackgroundTasks`로 잡을 띄운다. 이미 `analyzing`인 건에 또 `POST`가 오면 새 잡을 띄우지 않고 `202`만 돌려준다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `python -m pytest tests/ -v`
Expected: all passed

- [ ] **Step 6: 커밋**

```bash
git add server/drafts.py server/routes_reports.py tests
git commit -m "feat: 초안 생성 비동기 잡과 폴링 엔드포인트"
```

---

## Task 7: 확인 질문 재생성 — 사용자가 고친 칸 보존

**Files:**
- Modify: `server/drafts.py`, `server/routes_reports.py`, `server/models.py`
- Test: `tests/test_draft_regenerate.py`

**Interfaces:**
- Consumes: Task 6의 `run_draft_job`
- Produces:
  - `PATCH /api/reports/{id}/draft` → 바디 `{"answers": {질문: 답변}, "fields": {칸: 값}}`. `fields`에 담긴 칸은 출처가 `user`로 기록되고 이후 재생성에서 덮이지 않는다. `202`
  - `draft_json`에 칸별 출처를 담는 `sources: dict[str, "ai" | "user"]`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_user_edited_field_is_not_overwritten_by_regeneration(client, ready_report):
    client.patch(f"/api/reports/{ready_report}/draft", json={"fields": {"location": "2공장 3라인"}})
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"장소가 어디인가요?": "본관"}})
    draft = client.get(f"/api/reports/{ready_report}/draft", params={"reporter_id": "dev-1"}).json()["draft"]
    assert draft["location"] == "2공장 3라인"
    assert draft["sources"]["location"] == "user"

def test_ai_field_is_refreshed_by_regeneration(client, ready_report, varying_provider):
    before = current_draft(client, ready_report)["overview"]
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"q": "a"}})
    assert current_draft(client, ready_report)["overview"] != before

def test_locked_fields_are_sent_to_prompt_as_facts(client, ready_report, capture_provider):
    client.patch(f"/api/reports/{ready_report}/draft", json={"fields": {"location": "2공장 3라인"}})
    client.patch(f"/api/reports/{ready_report}/draft", json={"answers": {"q": "a"}})
    assert "2공장 3라인" in capture_provider.last_prompt_text

def test_editing_field_alone_does_not_trigger_llm_call(client, ready_report, capture_provider):
    calls = capture_provider.call_count
    client.patch(f"/api/reports/{ready_report}/draft", json={"fields": {"location": "x"}})
    assert capture_provider.call_count == calls

def test_skipped_questions_do_not_block_submission(client, ready_report):
    assert client.post(f"/api/reports/{ready_report}/submit").status_code == 200

def test_empty_draft_fields_do_not_block_submission(client, report_id, broken_provider):
    client.post(f"/api/reports/{report_id}/draft")
    assert client.post(f"/api/reports/{report_id}/submit").status_code == 200
```

`POST /api/reports/{id}/submit`도 이 태스크에서 만든다 — `status`를 `submitted`로 올리고, 빈 칸·미응답 질문을 사유로 거절하지 않는다 (Global Constraints 2번).

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_draft_regenerate.py -v`
Expected: FAIL — `PATCH`가 405

- [ ] **Step 3: `sources` 추적과 `PATCH`·`submit` 구현**

`fields`만 온 요청은 LLM을 부르지 않고 저장만 한다. `answers`가 오면 `locked`(출처가 `user`인 칸)를 `build_draft_prompt`에 넘겨 재생성하고, 돌아온 값에서 `locked` 칸은 버린다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `python -m pytest tests/ -v`
Expected: all passed

- [ ] **Step 5: 커밋**

```bash
git add server tests/test_draft_regenerate.py
git commit -m "feat: 확인 질문 재생성 시 사용자가 고친 칸 보존, 제출 엔드포인트"
```

---

## Task 8: 사진 업로드

**Files:**
- Create: `server/routes_photos.py`
- Modify: `server/main.py`, `server/db.py`
- Test: `tests/test_photos.py`

**Interfaces:**
- Consumes: Task 1의 `db`
- Produces:
  - `POST /api/reports/{id}/photos` (multipart, 필드명 `file`) → `201 {"photo_id": str, "url": str}`
  - `GET /api/photos/{photo_id}` → 이미지 바이트
  - 신고당 최대 2장 (사양 3.2). 3번째는 `409`

파일은 `server/data/photos/` 아래 파일시스템에 저장하고 DB에는 경로만 둔다. 디렉터리는 `.gitignore`에 넣는다. 허용 타입은 `image/jpeg`, `image/png`, `image/webp`. 장당 상한 10MB.

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_upload_returns_url_and_persists(client, report_id, png_bytes):
    r = client.post(f"/api/reports/{report_id}/photos",
                    files={"file": ("a.png", png_bytes, "image/png")})
    assert r.status_code == 201
    assert client.get(r.json()["url"]).content == png_bytes

def test_third_photo_is_rejected(client, report_id, png_bytes):
    for _ in range(2):
        client.post(f"/api/reports/{report_id}/photos", files={"file": ("a.png", png_bytes, "image/png")})
    r = client.post(f"/api/reports/{report_id}/photos", files={"file": ("a.png", png_bytes, "image/png")})
    assert r.status_code == 409

def test_non_image_is_rejected(client, report_id):
    r = client.post(f"/api/reports/{report_id}/photos",
                    files={"file": ("a.txt", b"hello", "text/plain")})
    assert r.status_code == 415

def test_oversized_photo_is_rejected(client, report_id):
    r = client.post(f"/api/reports/{report_id}/photos",
                    files={"file": ("big.png", b"\x89PNG" + b"0" * (10 * 1024 * 1024), "image/png")})
    assert r.status_code == 413
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_photos.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `server/routes_photos.py` 구현 및 `.gitignore` 갱신**

- [ ] **Step 4: 테스트 통과 확인**

Run: `python -m pytest tests/test_photos.py -v`
Expected: 4 passed

- [ ] **Step 5: 커밋**

```bash
git add server/routes_photos.py server/main.py server/db.py .gitignore tests/test_photos.py
git commit -m "feat: 사진 업로드 (신고당 최대 2장)"
```

---

## Task 9: 집계 API

**Files:**
- Create: `server/routes_stats.py`
- Test: `tests/test_stats_api.py`

**Interfaces:**
- Consumes: Task 1의 `db`
- Produces:
  - `GET /api/stats?period=week|month` → 토큰 불필요. 응답:

```python
{
  "total": int, "today": int, "week": int, "month": int,
  "daily":    [{"date": "2026-10-20", "value": int}, ...],   # 최근 14일
  "category": [{"label": "추락/넘어짐", "value": int}, ...],
  "hourly":   [{"from": 0, "to": 3, "value": int}, ...],     # 3시간 구간 8개
  "risk":     [{"label": "상", "value": int}, ...],
}
```

`daily`·`hourly` 구간 규칙은 기존 `js/stats.js`(최근 14일, `HOUR_BIN = 3`)와 같아야 한다. `submitted` 상태만 집계한다 (사양 3.8).

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_stats_requires_no_token(client):
    assert client.get("/api/stats").status_code == 200

def test_stats_response_contains_no_content_or_identity(client, submitted_reports):
    text = client.get("/api/stats").text
    assert "박민수" not in text and "난간" not in text and "location" not in text

def test_stats_counts_only_submitted(client, submitted_reports, draft_report):
    assert client.get("/api/stats").json()["total"] == len(submitted_reports)

def test_daily_has_fourteen_buckets_ending_today(client, submitted_reports):
    daily = client.get("/api/stats").json()["daily"]
    assert len(daily) == 14
    assert daily[-1]["date"] == date.today().isoformat()

def test_hourly_has_eight_three_hour_buckets(client, submitted_reports):
    hourly = client.get("/api/stats").json()["hourly"]
    assert [h["from"] for h in hourly] == [0, 3, 6, 9, 12, 15, 18, 21]

def test_risk_distribution_covers_three_levels(client, submitted_reports):
    assert {r["label"] for r in client.get("/api/stats").json()["risk"]} == {"상", "중", "하"}

def test_period_month_widens_the_window(client, old_submitted_report):
    assert client.get("/api/stats", params={"period": "month"}).json()["total"] \
         > client.get("/api/stats", params={"period": "week"}).json()["total"]
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_stats_api.py -v`
Expected: FAIL — 404

- [ ] **Step 3: `server/routes_stats.py` 구현**

집계는 SQL로 한다. 응답에 원문·장소·인적사항을 담지 않는 것이 이 엔드포인트의 요점이다 (Global Constraints 5번).

- [ ] **Step 4: 테스트 통과 확인**

Run: `python -m pytest tests/test_stats_api.py -v`
Expected: 7 passed

- [ ] **Step 5: 커밋**

```bash
git add server/routes_stats.py server/main.py tests/test_stats_api.py
git commit -m "feat: 집계 API — 수치만 내려주는 /api/stats"
```

---

## Task 10: 고위험 웹훅과 미확인 큐

**Files:**
- Create: `server/webhook.py`
- Modify: `server/routes_reports.py`
- Test: `tests/test_webhook.py`

**Interfaces:**
- Consumes: Task 7의 `submit`, Task 1의 `Settings`
- Produces:
  - `async def notify_high_risk(report: dict, settings: Settings) -> None` — `webhook_url`이 있으면 POST, 없으면 `logging.info`
  - `GET /api/reports/unacknowledged` (관리자) → 위험도 `상` + `acknowledged=false` 목록
  - `POST /api/reports/{id}/acknowledge` (관리자) → `200`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
@pytest.mark.asyncio
async def test_webhook_posts_when_url_configured(httpx_mock):
    httpx_mock.add_response()
    await notify_high_risk({"id": "r1", "risk": "상"}, settings(webhook_url="https://hook"))
    assert httpx_mock.get_request() is not None

@pytest.mark.asyncio
async def test_webhook_logs_when_url_absent(caplog, httpx_mock):
    await notify_high_risk({"id": "r1", "risk": "상"}, settings(webhook_url=None))
    assert httpx_mock.get_requests() == []
    assert "r1" in caplog.text

@pytest.mark.asyncio
async def test_webhook_failure_does_not_raise(httpx_mock):
    httpx_mock.add_response(status_code=500)
    await notify_high_risk({"id": "r1", "risk": "상"}, settings(webhook_url="https://hook"))

def test_submit_high_risk_enters_unacknowledged_queue(client, high_risk_ready):
    client.post(f"/api/reports/{high_risk_ready}/submit")
    rows = client.get("/api/reports/unacknowledged", headers=ADMIN).json()
    assert [r["id"] for r in rows] == [high_risk_ready]

def test_submit_mid_risk_does_not_enter_queue(client, mid_risk_ready):
    client.post(f"/api/reports/{mid_risk_ready}/submit")
    assert client.get("/api/reports/unacknowledged", headers=ADMIN).json() == []

def test_acknowledge_removes_from_queue(client, high_risk_ready):
    client.post(f"/api/reports/{high_risk_ready}/submit")
    client.post(f"/api/reports/{high_risk_ready}/acknowledge", headers=ADMIN)
    assert client.get("/api/reports/unacknowledged", headers=ADMIN).json() == []
```

웹훅 실패가 제출을 깨뜨리면 안 된다 — 세 번째 테스트가 그것을 고정한다.

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_webhook.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.webhook'`

- [ ] **Step 3: `server/webhook.py`와 두 엔드포인트 구현**

모듈 상단에 **"실제 사내 메신저를 붙이는 자리"** 주석을 남긴다 (사양 3.6).

- [ ] **Step 4: 테스트 통과 확인**

Run: `python -m pytest tests/ -v`
Expected: all passed

- [ ] **Step 5: 커밋**

```bash
git add server/webhook.py server/routes_reports.py tests/test_webhook.py
git commit -m "feat: 고위험 건 웹훅 훅 포인트와 관리자 미확인 큐"
```

---

## Task 11: 데모 시드 스크립트

**Files:**
- Create: `server/seed.py`, `server/fixtures/seed_reports.json`
- Test: `tests/test_seed.py`

**Interfaces:**
- Consumes: Task 1의 `db`
- Produces: `python -m server.seed [--reset]` — `seed_reports.json`을 DB에 넣는다. `seed_reports(conn, rows: list[dict]) -> int`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
def test_seed_inserts_all_rows(tmp_db):
    assert seed_reports(tmp_db, load_fixture()) == len(load_fixture())

def test_seed_never_calls_llm(tmp_db, capture_provider):
    seed_reports(tmp_db, load_fixture())
    assert capture_provider.call_count == 0

def test_seeded_rows_are_submitted_and_classified(tmp_db):
    seed_reports(tmp_db, load_fixture())
    rows = list_reports(tmp_db)
    assert all(r["status"] == "submitted" for r in rows)
    assert all(r["risk"] in RISK_LEVELS for r in rows)

def test_seed_covers_all_three_risk_levels_and_recent_14_days(tmp_db):
    seed_reports(tmp_db, load_fixture())
    rows = list_reports(tmp_db)
    assert {r["risk"] for r in rows} == {"상", "중", "하"}
    assert len({r["created_at"][:10] for r in rows}) >= 7

def test_seed_is_idempotent(tmp_db):
    seed_reports(tmp_db, load_fixture())
    seed_reports(tmp_db, load_fixture())
    assert len(list_reports(tmp_db)) == len(load_fixture())
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `python -m pytest tests/test_seed.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'server.seed'`

- [ ] **Step 3: `server/fixtures/seed_reports.json` 작성**

20~30건. **과제정의서 6장의 광양 #1 전기로 Settling Chamber 출입문 전도 사례를 위험도 `상`으로 포함한다** — 심사위원이 정의서의 예시를 화면에서 알아볼 수 있어야 한다. 나머지는 상/중/하와 7개 사고 유형, 최근 14일에 걸쳐 분포시키고, 시간대도 주간 작업시간에 몰리게 현실적으로 둔다. `created_at`은 시드 실행 시점을 기준으로 상대 일수로 계산한다(고정 날짜를 박으면 다음 주에 차트가 비어 보인다).

- [ ] **Step 4: `server/seed.py` 구현**

`client_uuid`를 `seed-<n>`으로 고정해 Task 1의 멱등 제약으로 중복 삽입을 막는다. `README.md`에 실행 한 줄을 추가한다.

- [ ] **Step 5: 테스트 통과 확인**

Run: `python -m pytest tests/test_seed.py -v`
Expected: 5 passed

- [ ] **Step 6: 커밋**

```bash
git add server/seed.py server/fixtures/seed_reports.json README.md tests/test_seed.py
git commit -m "feat: 데모 시드 스크립트 (정의서 광양 사례 포함)"
```

---

## Task 12: 프론트 — 프로필·reporterId·서버 연동·오프라인 큐

**Files:**
- Create: `js/profile.js`
- Modify: `js/store.js`, `js/app.js`, `index.html`, `css/style.css`
- Test: 수동 (프론트엔드 테스트 인프라 없음 — 사양 4가 테스트 범위를 서버로 한정)

**Interfaces:**
- Consumes: Task 1의 `POST /api/reports`, `GET /api/reports/mine`
- Produces:
  - `window.Profile`: `reporterId()`(없으면 `crypto.randomUUID()`로 생성해 보관), `get()` → `{org, name, role} | null`, `save(profile)`, `adminToken()`, `saveAdminToken(token)`
  - `window.ReportStore`: `submit(report) -> Promise<{id, queued: boolean}>`, `myReports() -> Promise<list>`, `flushQueue() -> Promise<number>`, `pendingCount() -> number`. `isLocalOnly`는 제거

- [ ] **Step 1: `js/profile.js` 작성**

`reporterId`는 인증이 아니라 기기 식별자다 (사양 3.11). localStorage 키는 기존 `nearmiss-` 접두사 관례를 따른다.

- [ ] **Step 2: `index.html`에 설정 화면 추가**

신고 탭 안의 접이식 섹션(`<details>`)으로 소속·성명·직무 + 관리자 토큰 입력을 둔다. 기존 `.notice`·`.card` 클래스를 재사용한다. **별도 탭을 만들지 않는다** — 탭은 신고/통계/관리자 3개다.

- [ ] **Step 3: `js/store.js`를 서버 연동으로 교체**

`submit()`은 `client_uuid`(`crypto.randomUUID()`)와 `reporter_id`를 붙여 `POST /api/reports`를 부른다. 실패하면 localStorage 큐(`nearmiss-queue`)에 **같은 `client_uuid`로** 넣고 `{queued: true}`를 돌려준다 — 재전송 시 서버가 멱등으로 거른다 (Review Focus 4). 사진은 큐에 넣지 않는다 (사양 3.7).
`myReports()`는 `GET /api/reports/mine`을 부르고, 실패 시 로컬 캐시를 돌려준다.
`flushQueue()`는 `online` 이벤트와 앱 시작 시 호출한다.
API는 상대 경로로만 부른다 (Global Constraints).

- [ ] **Step 4: `js/app.js`의 `renderHistory()`를 async로 전환**

`myReports()`가 Promise를 돌려주게 바뀌므로 `renderHistory()`(`js/app.js:131`)와 그 호출부 세 곳이 `await`해야 한다. 각 항목에 `status` 배지(`대기 중` / `분석 중` / `분석 실패` / `제출됨`)를 붙인다. 이전 버전 레코드도 표시하는 기존 폴백(`r.content || r.description`)은 유지한다.

- [ ] **Step 5: 수동 검증**

```bash
python -m server.seed && uvicorn server.main:app --reload
```

`http://localhost:8000` 에서 확인:
1. 설정에 소속·성명·직무를 넣고 새로고침 → 값이 남아 있다
2. 한 줄 신고 제출 → "내 신고 내역"에 보인다
3. DevTools Network를 Offline으로 전환 → 신고 제출 시 "전송 대기 중" 표시, 내역은 여전히 보인다
4. Online 복구 → 대기 건이 서버로 올라가고 대기 표시가 사라진다
5. 3·4를 반복해도 같은 신고가 두 번 생기지 않는다
6. 내역 각 항목에 상태 배지가 보인다

- [ ] **Step 6: 커밋**

```bash
git add js/profile.js js/store.js index.html css/style.css
git commit -m "feat: 신고자 프로필·기기 ID, 서버 연동 스토어, 오프라인 큐"
```

---

## Task 13: 프론트 — 속보 문서 렌더러와 인쇄 CSS

**Files:**
- Create: `js/brief-doc.js`
- Modify: `css/style.css`, `index.html`
- Test: 수동

**Interfaces:**
- Consumes: Task 6의 `draft` 응답 모양
- Produces: `window.BriefDoc`: `render(container, report, { editable = false, onFieldEdit = null, showRealName = false }) -> void`, `riskBadge(risk) -> HTMLElement`

초안 화면(Task 14)과 관리자 상세(Task 16)가 같은 렌더러를 쓴다 — 작업자가 확인한 문서와 관리자가 받는 문서가 같아야 하기 때문이다.

- [ ] **Step 1: `js/brief-doc.js` 작성**

사양 3.2의 칸 순서를 그대로 그린다: 제목 → 위험도 배지 + 근거 → 사진 → 일시 → 장소 → 인적사항 → 발생개요 → 발생원인(물리적/환경적, 시스템/프로세스, 조직적) → 재발방지 대책.
- `riskBadge`는 **글자(`상`/`중`/`하`)와 색을 함께** 쓴다 (Global Constraints).
- `draft.sources[field] === "ai"`인 칸에 `AI` 표시를 붙이고, `"user"`면 붙이지 않는다.
- 발생원인·재발방지 대책 블록에는 **AI 추정임을 문서에도 남긴다** (사양 3.2).
- `editable`이면 각 칸을 `contenteditable` 또는 입력 요소로 만들고 변경 시 `onFieldEdit(field, value)`를 부른다. **필수 입력 표시를 하지 않는다** (Global Constraints 2번).
- 빈 칸은 숨기지 않고 `미기재`로 표시한다 — 관리자가 무엇이 비었는지 알아야 한다.

- [ ] **Step 2: `css/style.css`에 속보 문서 스타일과 인쇄 CSS 추가**

기존 CSS 변수·`.card` 토큰을 재사용한다. `@media print`에서 탭·버튼·마이크를 숨기고 문서만 A4 한 장에 맞춘다 (사양 3.9).

- [ ] **Step 3: 수동 검증**

시드된 건 하나를 임시로 `BriefDoc.render`에 넘겨 (브라우저 콘솔에서) 확인:
1. 아홉 칸이 사양 순서대로 나온다
2. 위험도 배지에 글자가 보인다 — 색만으로 구분하지 않는다
3. AI가 채운 칸에 표시가 있고, `editable`로 고치면 표시가 사라진다
4. `Cmd+P` 미리보기에서 탭·버튼이 사라지고 문서가 한 장에 들어간다
5. 창 너비 375px에서 가로 스크롤이 생기지 않는다

- [ ] **Step 4: 커밋**

```bash
git add js/brief-doc.js css/style.css index.html
git commit -m "feat: 속보 문서 렌더러와 인쇄용 CSS"
```

---

## Task 14: 프론트 — 초안 화면

**Files:**
- Create: `js/draft-view.js`
- Modify: `js/app.js`, `index.html`, `css/style.css`
- Test: 수동

**Interfaces:**
- Consumes: Task 6의 `POST/GET /api/reports/{id}/draft`, Task 7의 `PATCH`·`submit`, Task 8의 사진 업로드, Task 13의 `BriefDoc`
- Produces: `window.DraftView`: `open(reportId) -> void`, `close() -> void`

- [ ] **Step 1: `js/draft-view.js` 작성**

- 제출 직후 **초안 화면을 먼저 열고** 폴링한다 (사양 3.1). 일시·인적사항은 이미 채워져 있고, AI 칸은 스켈레톤이다.
- 화면 순서: 확인 질문 → 위험도 → 나머지 속보 문서 (사양 3.2). 제출 버튼은 **하단 고정**.
- 확인 질문마다 `건너뛰기`가 있고, 답하면 `PATCH`로 재생성을 요청한 뒤 다시 폴링한다 (사양 3.5).
- 칸을 고치면 `PATCH`의 `fields`로 보낸다 (LLM 호출 없음).
- 사진 버튼은 `<input type="file" accept="image/*" capture="environment">`. 2장을 넘기면 버튼을 비활성화한다.
- `failed` 상태면 `분석 실패 · 다시 시도` 버튼을 띄우고, **그 상태에서도 제출이 가능**하게 둔다 (사양 3.8, Global Constraints 2번).
- 오프라인이면 폴링하지 않고 "연결되면 자동 분석됩니다"를 표시한다 (사양 3.7).
- 폴링은 화면을 닫으면 멈춘다. 재진입 시 서버 상태에서 이어받는다 (Review Focus 5).

- [ ] **Step 2: `js/app.js`의 제출 흐름 연결**

기존 `form.addEventListener('submit', ...)`(`js/app.js:89`)에서 `toast('신고가 접수되었습니다')` 대신 `DraftView.open(id)`로 넘긴다. 음성 입력은 초안 화면으로 넘어갈 때 `voice.abort()`한다 (기존 코드가 이미 제출 직전에 부른다).

- [ ] **Step 3: 수동 검증**

```bash
NEARMISS_LLM_MODE=mock uvicorn server.main:app --reload
```

1. `"3층 계단 난간 헐거움, 넘어질 뻔함"` 제출 → 초안 화면이 **즉시** 열리고 일시가 이미 채워져 있다
2. 잠시 후 AI 칸이 채워진다. 위험도 배지와 근거가 보인다
3. 확인 질문에 답 → 칸이 갱신된다. `건너뛰기` → 아무 일도 일어나지 않고 제출 가능하다
4. `장소`를 손으로 고친 뒤 확인 질문에 답 → **고친 값이 남아 있다**
5. 사진 2장 첨부 → 문서에 보인다. 3장째 버튼이 비활성
6. 제출 → 내역에 `제출됨`으로 보인다
7. 초안 화면에서 새로고침 → 같은 상태로 돌아온다
8. 서버를 끄고 제출 → "연결되면 자동 분석됩니다"가 보이고 입력이 유실되지 않는다
9. 실제 사내 API로도 1~6을 한 번 돌린다 (`NEARMISS_LLM_MODE` 미설정)

- [ ] **Step 4: 커밋**

```bash
git add js/draft-view.js js/app.js index.html css/style.css
git commit -m "feat: 속보 초안 화면 — 폴링, 칸 편집, 확인 질문, 사진, 제출"
```

---

## Task 15: 프론트 — 통계 탭을 집계 API로 전환

**Files:**
- Modify: `js/stats.js`, `js/app.js`
- Test: 수동

**Interfaces:**
- Consumes: Task 9의 `GET /api/stats`
- Produces: `window.NearMissStats.render(container, stats, { period = "week" }) -> void` — 두 번째 인자가 **레코드 배열에서 집계 객체로 바뀐다**

- [ ] **Step 1: `js/stats.js`에서 클라이언트 집계 제거**

`dailyItems`·`categoryItems`·`hourlyItems`(`js/stats.js:159-204`)를 지우고, `stats.daily`·`stats.category`·`stats.hourly`를 차트 아이템 모양으로 변환하는 얇은 매퍼로 바꾼다. `columnChart`·`barChart`·`tableView`·`tiles`는 그대로 쓴다.
`tiles`는 `stats.total`·`today`·`week`·`month`를 받는다.
**위험도 분포 차트를 추가한다** (`stats.risk`, `barChart` 재사용).
`localOnly` 안내문을 제거한다 — 더 이상 이 기기 기준이 아니다 (사양 3.10).
`NearMissClassify`는 더 이상 통계에서 쓰지 않는다. `js/classify.js`는 서버가 유형을 못 준 경우의 폴백으로 남긴다.

- [ ] **Step 2: `js/app.js`의 `renderStats()` 수정**

`ReportStore.fetchAll()` 대신 `GET /api/stats`를 부른다.

- [ ] **Step 3: 수동 검증**

```bash
python -m server.seed && uvicorn server.main:app --reload
```

1. 통계 탭 → 요약 타일 4개, 일별 14칸, 유형별, 시간대별 8칸, **위험도 분포**가 보인다
2. "이 기기 기준" 안내가 사라졌다
3. 다른 브라우저(또는 시크릿 창)에서 열어도 같은 수치가 보인다 — 서버 집계이므로
4. DevTools Network에서 `/api/stats` 응답을 확인: **원문·장소·이름이 없다**
5. `표로 보기`와 키보드 탭 이동이 기존대로 동작한다
6. 새 신고를 제출하면 `오늘` 타일이 1 늘어난다

- [ ] **Step 4: 커밋**

```bash
git add js/stats.js js/app.js
git commit -m "feat: 통계 탭을 서버 집계 API로 전환, 위험도 분포 추가"
```

---

## Task 16: 프론트 — 관리자 탭과 전체 흐름 검증

**Files:**
- Create: `js/admin.js`
- Modify: `index.html`, `js/app.js`, `css/style.css`
- Test: 수동

**Interfaces:**
- Consumes: Task 3의 관리자 엔드포인트, Task 9의 `/api/stats`, Task 10의 미확인 큐, Task 13의 `BriefDoc`
- Produces: `window.AdminView`: `render(container) -> void`

- [ ] **Step 1: `index.html`에 세 번째 탭 추가**

기존 `.tabs [role="tab"]` 패턴을 그대로 따른다 (`aria-controls`, `aria-selected`). 탭 레이블은 `관리자`.

- [ ] **Step 2: `js/admin.js` 작성**

- 토큰이 없으면 "관리자 토큰을 설정에서 입력해 주세요" 안내와 설정으로 가는 링크만 띄운다.
- **미확인 고위험 배너** — `GET /api/reports/unacknowledged`. 건수를 보여주고, 상세를 열면 `POST .../acknowledge` (사양 3.6).
- **목록** — `GET /api/reports`. 각 행에 위험도 배지·유형·일시·장소·원문 앞부분. 필터: 위험도(상/중/하), 기간(주/월), **상태(전체/제출됨/미분류)** (사양 3.8).
- **속보 상세** — `BriefDoc.render(..., { editable: false })`. `실명 보기` 토글이 `GET .../identity`를 부른다. 인쇄 버튼.
- **미분류(`failed`) 건** — 위험도 자리에 `미분류` 배지, `다시 분석` 버튼으로 `POST .../draft` 재시도 (사양 3.8).
- **주간·월간 집계** — `GET /api/stats?period=` 를 `NearMissStats.render`에 넘기고 기간 토글을 둔다 (사양 3.9).

- [ ] **Step 3: 전체 흐름 수동 검증 (데모 리허설)**

```bash
python -m server.seed && uvicorn server.main:app --reload
```

노트북 브라우저의 모바일 뷰(375px)에서, **사내 API를 실제로 붙여서** 처음부터 끝까지:

1. 설정에 프로필·관리자 토큰 입력
2. 마이크로 `"2공장 3라인 컨베이어 옆 바닥에 기름이 새어 미끄러질 뻔했어요"`를 말하고 제출
3. 초안 화면이 즉시 열리고, AI 칸이 채워진다. 위험도와 근거가 보인다
4. 확인 질문에 답하거나 건너뛴다. 사진 1장 첨부
5. 제출 → 내역에 보인다
6. 통계 탭 → `오늘`이 늘어났고 위험도 분포에 반영됐다
7. 관리자 탭 → 목록 최상단에 방금 건이 있다. 위험도 필터·상태 필터가 동작한다
8. 상세 열기 → 속보 문서 전체. `실명 보기` 토글로 실명이 보인다. 토글 끄면 `박 ○○`
9. `Cmd+P` → 속보 한 장이 깔끔하게 나온다
10. 위험도 `상` 건을 하나 제출 → 관리자 탭 배너에 미확인 건수가 뜨고, 열어보면 사라진다
11. **DevTools Network에서 `/api/stats`와 `/api/reports/mine`을 다시 확인** — 토큰 없이 남의 원문이 내려오지 않는다
12. 전체 테스트: `python -m pytest tests/ -v` → all passed

- [ ] **Step 4: 커밋**

```bash
git add js/admin.js index.html js/app.js css/style.css
git commit -m "feat: 관리자 탭 — 미확인 배너, 목록·필터, 속보 상세, 실명 토글, 주간/월간 집계"
```

---

## 사양 커버리지

| 사양 | 태스크 |
|---|---|
| 3.1 전체 흐름 / 원문 선저장 | 1, 6 |
| 3.1 비동기 초안 생성 + 폴링 | 6, 14 |
| 3.2 속보 양식 9칸 + AI 표시 | 4, 13 |
| 3.2 작업자 화면 = 속보 양식 전체 | 14 |
| 3.3 위험도 기준 상수 + 근거 | 4, 13 |
| 3.4 신고자/당사자 분리, 마스킹, PII 치환 | 2, 3, 4, 12 |
| 3.5 확인 질문 + 건너뛰기 + user 칸 보존 | 7, 14 |
| 3.6 웹훅 + 미확인 큐 | 10, 16 |
| 3.7 오프라인 큐 + 멱등 재전송 | 1, 12 |
| 3.8 실패 건 재시도 + 상태 축 | 6, 14, 16 |
| 3.9 관리자 화면 + 인쇄 | 13, 16 |
| 3.10 SQLite + 시드 | 1, 11 |
| 3.11 엔드포인트별 노출 범위 | 3, 9 |
| 4 mock 프로바이더 | 5 |
| 4 환경변수·README | 1 |
| 4 접근성 (색만으로 구분 금지) | 13 |
