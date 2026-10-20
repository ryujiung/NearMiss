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
