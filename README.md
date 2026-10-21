# 니어미스 신고

아차사고(니어미스)를 음성 또는 텍스트로 신고하는 모바일 웹 앱입니다.

## 실행 방법

1. 가상환경 생성 및 활성화

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```

2. 의존성 설치

   ```bash
   pip install -r requirements.txt
   ```

3. 환경변수 설정

   ```bash
   cp .env.example .env
   # .env 파일을 열어 필요한 값을 채워 넣습니다
   ```

   `NEARMISS_DB_PATH`를 비워두면 저장소 루트의 `nearmiss.db`를 기본값으로 사용합니다.

   **LLM은 Gemini 무료 등급으로 붙일 수 있습니다** (Google 계정만 있으면 되고 결제수단이
   필요 없습니다). 키는 https://aistudio.google.com/apikey 에서 발급받고, `.env`에 이렇게
   넣습니다:

   ```
   NEARMISS_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
   NEARMISS_CHAT_PATH=/chat/completions
   NEARMISS_MODEL=gemini-2.5-flash
   NEARMISS_API_KEY=<발급받은 키>
   ```

   넣은 뒤 실제로 쓸 만한 속보가 돌아오는지 확인합니다 — 연결만 보는 게 아니라
   **실제 프롬프트를 던져** 파서를 통과하는지까지 봅니다:

   ```bash
   python -m scripts.check_llm                 # .env 설정 그대로
   python -m scripts.check_llm --try-models    # 모델명을 모를 때 후보를 차례로
   ```

   키가 없어도 `NEARMISS_LLM_MODE=mock`으로 전체 흐름이 돌아갑니다. 단 mock은 입력과
   무관하게 고정된 속보를 돌려주므로, 데모에서 "AI가 내 말을 이해한다"는 장면은
   나오지 않습니다.

   > 무료 등급은 보낸 데이터를 모델 개선에 쓸 수 있습니다. 데모용 합성 데이터는
   > 괜찮지만, 실제 현장 신고를 넣기 전에는 다시 판단해야 합니다.

4. 데모 데이터 넣기 (선택, 하지만 권장)

   ```bash
   python -m server.seed            # 22건 (두 번 돌려도 중복되지 않음)
   python -m server.seed --reset    # 기존 신고를 지우고 새로 넣기
   ```

   통계와 관리자 목록이 비어 있으면 보여줄 게 없습니다. 과제정의서 6장의 광양 #1
   전기로 Settling Chamber 출입문 전도 사례가 위험도 `상`으로 들어 있습니다.
   시드는 **AI를 호출하지 않습니다** — 미리 만들어둔 속보 초안을 그대로 넣습니다.

   날짜는 실행 시점 기준 상대 일수로 계산되므로, 언제 돌려도 최근 14일 차트가
   채워집니다.

5. 서버 실행

   ```bash
   uvicorn server.main:app --reload
   ```

6. 브라우저에서 `http://localhost:8000` 접속

> **데모는 노트북 브라우저의 모바일 뷰(개발자 도구 반응형 모드)로 진행합니다.** 실기기에서 `http://192.168.x.x`로 접속하면 브라우저가 비보안(non-HTTPS) origin으로 판단해 음성 입력·카메라 권한이 차단되기 때문입니다.
