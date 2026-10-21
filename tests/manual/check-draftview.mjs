// 프론트엔드 검증 하네스 — jsdom + 실제 서버.
//
// 이 프로젝트는 사양 4의 결정에 따라 서버에만 자동 테스트를 둔다. 프론트엔드는
// 이 하네스들로 확인한다. 레포에 두는 이유: 밖에 있으면 다음 사람이 프론트엔드
// 회귀를 한 줄도 재현할 수 없다.
//
// 실행 (다른 창에서 서버를 먼저 띄운다):
//   python -m server.seed && uvicorn server.main:app --port 8000
//   npm install jsdom && node tests/manual/<파일>.mjs
//
// 중요: 이 하네스는 NEARMISS_LLM_MODE=mock 으로 띄운 서버에 대고 돌린다.
// 실제 LLM로 돌리면 응답이 10~15초이고, 연달아 돌릴 때 무료 등급 분당 한도
// (429)에 걸려 거짓 실패가 난다. 하네스가 보려는 것은 앱이 올바른 순서로
// 올바른 요청을 보내는가이지 모델의 가용성이 아니다.
//
//   NEARMISS_LLM_MODE=mock uvicorn server.main:app --port 8000

// js/draft-view.js를 jsdom + 실제 서버로 끝까지 돌린다.
// brief Step 3의 1~8번을 기계로 대체 검증한다.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';

const html = fs.readFileSync(`${REPO}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/`, runScripts: 'outside-only' });
const { window } = dom;
global.document = window.document;

// jsdom이 localStorage를 이미 제공한다. fetch와 navigator.onLine만 흉내 낸다.
let online = true;
const fakeNavigator = { get onLine() { return online; }, userAgent: 'node' };
const realFetch = globalThis.fetch;
const fakeFetch = (url, opts) => {
  if (!online) return Promise.reject(new Error('offline'));
  const target = String(url).startsWith('http') ? String(url) : BASE + url;
  return realFetch(target, opts);
};

function load(path) {
  const src = fs.readFileSync(`${REPO}/${path}`, 'utf8');
  // 모듈이 수식 없이 쓰는 이름을 인자로 섀도잉한다 — window를 건드리지 않는다.
  new Function('window', 'document', 'localStorage', 'fetch', 'navigator', 'Profile', 'BriefDoc', 'FormData', 'console', src)(
    window, window.document, window.localStorage, fakeFetch, fakeNavigator,
    window.Profile, window.BriefDoc, globalThis.FormData, console
  );
}
load('js/profile.js');
load('js/brief-doc.js');
load('js/draft-view.js');

const { Profile, DraftView } = window;

const OWNER = { get 'X-Reporter-Id'() { return Profile.reporterId(); } };

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 초안이 정착(ready/failed/submitted)할 때까지 기다린다.
 *
 * 고정 sleep을 쓰면 mock(즉시)에서는 통과하고 실제 LLM(10~15초)에서는 거짓
 * 실패한다. 하네스가 모델 속도에 의존해서는 안 된다.
 */
async function waitSettled(timeoutMs = 60000) {
  const started = Date.now();
  const settled = ['ready', 'failed', 'submitted'];
  while (Date.now() - started < timeoutMs) {
    const st = window.DraftView._state();
    if (st && settled.includes(st.status)) return st.status;
    await sleep(300);
  }
  return window.DraftView._state() && window.DraftView._state().status;
}

const root = () => window.document.getElementById('draft-root');
const banner = () => window.document.getElementById('draft-banner');

async function newReport(uuid, content = '컨베이어 옆 바닥에 기름이 새어 미끄러질 뻔했어요') {
  const res = await realFetch(`${BASE}/api/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...OWNER },
    body: JSON.stringify({
      client_uuid: uuid,
      content,
      reporter_id: Profile.reporterId(),
      reporter: { org: '현대안전', name: '김영수', role: '설비보전', count: 1 },
    }),
  });
  return (await res.json()).id;
}

// ---------- 1. 화면이 먼저 열리고, 분석 결과가 채워진다 ----------
const id1 = await newReport(`dv-${Date.now()}-1`);
await DraftView.open(id1);
check('패널이 열린다', !window.document.getElementById('draft-panel').hidden);
check('열릴 때 제출 버튼이 이미 있다 (분석 전에도 제출 가능)',
  !!root().querySelector('.draft-actions .btn-submit'));
check('body에 draft-open이 붙어 배경 스크롤이 잠긴다',
  window.document.body.classList.contains('draft-open'));

// 폴링이 끝나길 기다린다
await waitSettled();
check('폴링이 ready까지 간다', DraftView._state().status === 'ready',
  DraftView._state().status);
check('위험도 배지가 글자와 함께 나온다',
  root().querySelector('.risk-badge')?.textContent.includes('상'),
  root().querySelector('.risk-badge')?.textContent);
check('확인 질문이 화면 위쪽에 나온다', !!root().querySelector('.confirm-questions'));
const qIndex = [...root().children].findIndex((n) => n.classList.contains('confirm-questions'));
const docIndex = [...root().children].findIndex((n) => n.classList.contains('draft-doc'));
check('확인 질문이 문서보다 앞에 온다', qIndex >= 0 && qIndex < docIndex, `q=${qIndex} doc=${docIndex}`);
check('문서가 편집 가능하게 그려진다',
  root().querySelectorAll('[contenteditable="true"]').length >= 5);
check('ready면 배너가 비어 있다', banner().hidden);

// ---------- 2. 확인 질문: 건너뛰기 ----------
const qCount = root().querySelectorAll('.question').length;
root().querySelector('.btn-skip').dispatchEvent(new window.Event('click'));
check('건너뛰기가 질문을 치운다', root().querySelectorAll('.question').length === qCount - 1);
check('건너뛴 뒤에도 제출 버튼이 살아 있다',
  !!root().querySelector('.draft-actions .btn-submit'));

// ---------- 3. 칸 수정 → PATCH, 재생성 후에도 보존 ----------
const locField = [...root().querySelectorAll('.doc-field')]
  .find((f) => f.querySelector('.doc-label').textContent.startsWith('장소'));
const locBody = locField.querySelector('.doc-value');
locBody.textContent = '2공장 3라인 컨베이어 옆';
locBody.dispatchEvent(new window.Event('blur'));
await sleep(400);
const afterEdit = await realFetch(`${BASE}/api/reports/${id1}/draft?reporter_id=${Profile.reporterId()}`, { headers: OWNER }).then((r) => r.json());
check('칸 수정이 서버에 저장된다', afterEdit.draft.location === '2공장 3라인 컨베이어 옆',
  afterEdit.draft.location);
check('수정한 칸의 출처가 user가 된다', afterEdit.draft.sources.location === 'user');

// ---------- 4. 사진 첨부 ----------
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/0E6+hcAAAAASUVORK5CYII=', 'base64');
for (const n of [1, 2]) {
  const fd = new FormData();
  fd.append('file', new File([png], `p${n}.png`, { type: 'image/png' }));
  const r = await realFetch(`${BASE}/api/reports/${id1}/photos`, { method: 'POST', headers: OWNER, body: fd });
  check(`사진 ${n}장째 업로드`, r.status === 201, `HTTP ${r.status}`);
}
const third = new FormData();
third.append('file', new File([png], 'p3.png', { type: 'image/png' }));
const thirdRes = await realFetch(`${BASE}/api/reports/${id1}/photos`, { method: 'POST', headers: OWNER, body: third });
check('3장째는 409', thirdRes.status === 409, `HTTP ${thirdRes.status}`);

// ---------- 5. 재진입: 상태를 이어받고 다시 의뢰하지 않는다 (Review Focus 5) ----------
DraftView.close();
check('닫으면 패널이 숨는다', window.document.getElementById('draft-panel').hidden);
check('닫으면 draft-open이 떨어진다', !window.document.body.classList.contains('draft-open'));

await DraftView.open(id1);
await sleep(300);
check('재진입 시 ready 상태를 그대로 이어받는다', DraftView._state().status === 'ready',
  DraftView._state().status);
const reentry = [...root().querySelectorAll('.doc-field')]
  .find((f) => f.querySelector('.doc-label').textContent.startsWith('장소'))
  .querySelector('.doc-value').textContent;
check('재진입 화면에 고친 장소가 남아 있다', reentry === '2공장 3라인 컨베이어 옆', reentry);
check('재진입 시 사진이 보인다', root().querySelectorAll('.doc-photos img').length === 2);
check('사진 2장이면 첨부 버튼이 비활성', !!root().querySelector('.btn-photo.disabled'));

// ---------- 6. 제출 ----------
let closed = null;
await DraftView.open(id1, { onClose: (r) => { closed = r; } });
await sleep(300);
root().querySelector('.draft-actions .btn-submit').dispatchEvent(new window.Event('click'));
await sleep(400);
check('제출하면 onClose가 submitted로 불린다', closed && closed.submitted === true,
  JSON.stringify(closed));
const submitted = await realFetch(`${BASE}/api/reports/mine?reporter_id=${Profile.reporterId()}`, { headers: OWNER }).then((r) => r.json());
check('서버 상태가 submitted', submitted.find((r) => r.id === id1)?.status === 'submitted');

// ---------- 7. 분석 실패에서도 제출 가능 ----------
// mock 프로바이더는 실패하지 않으므로, 실패 상태를 직접 만들 수는 없다.
// 대신 오프라인 경로를 확인한다.
const id2 = await newReport(`dv-${Date.now()}-2`);
online = false;
await DraftView.open(id2);
check('오프라인이면 안내 배너가 뜬다',
  !banner().hidden && banner().className.includes('offline'), banner().textContent);
check('오프라인에서도 제출 버튼이 있다',
  !!root().querySelector('.draft-actions .btn-submit'));
check('오프라인에서 폴링 타이머를 돌리지 않는다', DraftView._state().timer === null);
online = true;
DraftView.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
