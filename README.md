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

4. 서버 실행

   ```bash
   uvicorn server.main:app --reload
   ```

5. 브라우저에서 `http://localhost:8000` 접속

> **데모는 노트북 브라우저의 모바일 뷰(개발자 도구 반응형 모드)로 진행합니다.** 실기기에서 `http://192.168.x.x`로 접속하면 브라우저가 비보안(non-HTTPS) origin으로 판단해 음성 입력·카메라 권한이 차단되기 때문입니다.
