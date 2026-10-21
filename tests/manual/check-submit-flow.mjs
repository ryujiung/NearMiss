// 프론트엔드 검증 하네스 — 제출 버튼부터 끝까지, app.js를 통과하는 경로.
//
// 다른 하네스들은 모듈 API(DraftView.open 등)를 직접 불렀다. 그래서 "앱에
// 그 호출 경로가 없다"는 결함이 그 틈으로 빠져나갔다. 이 하네스는 폼 submit
// 이벤트를 쏴서 app.js가 실제로 하는 일을 본다.
//
// 실행 (다른 창에서 서버를 먼저 띄운다):
//   python -m server.seed && uvicorn server.main:app --port 8000
//   npm install jsdom && node tests/manual/check-submit-flow.mjs
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';

const html = fs.readFileSync(`${REPO}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/` });
const { window } = dom;
global.document = window.document;

// 서버로 가는 요청을 전부 기록한다 — "무엇을 불렀나"가 이 하네스의 요점이다.
const calls = [];
// 둘을 분리한다. online은 브라우저가 아는 연결 상태, serverDown은 서버가 실제로
// 응답하는지다. 사용자가 겪은 건 "브라우저는 온라인인데 서버가 재시작 중"이었다.
let online = true;
let serverDown = false;
const realFetch = globalThis.fetch;
const fakeFetch = (url, opts = {}) => {
  const path = String(url).replace(BASE, '');
  calls.push(`${opts.method || 'GET'} ${path.split('?')[0]}`);
  if (!online || serverDown) return Promise.reject(new Error('연결 실패'));
  return realFetch(String(url).startsWith('http') ? String(url) : BASE + url, opts);
};
const fakeNavigator = { get onLine() { return online; }, userAgent: 'node' };

function load(path) {
  const src = fs.readFileSync(`${REPO}/${path}`, 'utf8');
  new Function(
    'window', 'document', 'localStorage', 'fetch', 'navigator', 'console',
    'Profile', 'ReportStore', 'BriefDoc', 'DraftView', 'AdminView',
    'NearMissStats', 'NearMissClassify', 'VoiceInput', 'FormData', 'history', 'location',
    src
  )(
    window, window.document, window.localStorage, fakeFetch, fakeNavigator, console,
    window.Profile, window.ReportStore, window.BriefDoc, window.DraftView,
    window.AdminView, window.NearMissStats, window.NearMissClassify,
    window.VoiceInput, globalThis.FormData, window.history, window.location
  );
}

for (const f of [
  'js/profile.js', 'js/store.js', 'js/brief-doc.js', 'js/draft-view.js',
  'js/admin.js', 'js/classify.js', 'js/stats.js', 'js/voice-input.js', 'js/app.js',
]) {
  load(f);
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const draftRoot = () => window.document.getElementById('draft-root');
const banner = () => window.document.getElementById('draft-banner');

// ---------- 제출 버튼을 실제로 누른다 ----------
const form = window.document.getElementById('nearmiss-form');
const content = window.document.getElementById('content');
content.value = '2공장 3라인 컨베이어 옆 바닥에 기름이 새어 미끄러질 뻔했어요';

calls.length = 0;
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 40 && !calls.includes('POST /api/reports'); i++) await sleep(100);
await sleep(1500);

console.log('\n서버로 간 요청:');
calls.forEach((c) => console.log('  ', c));
console.log('');

// 호출이 갔는지만 보면 500이어도 통과한다. 실제로 저장됐는지를 본다.
const mine = await realFetch(
  `${BASE}/api/reports/mine?reporter_id=${window.Profile.reporterId()}`,
  { headers: { 'X-Reporter-Id': window.Profile.reporterId() } }
).then((r) => r.json());
check('신고가 서버에 저장된다',
  calls.includes('POST /api/reports') && mine.length > 0, `${mine.length}건`);
check('초안 생성이 의뢰된다 (POST .../draft)',
  calls.some((c) => c.startsWith('POST /api/reports/') && c.endsWith('/draft')));
check('초안 상태를 폴링한다 (GET .../draft)',
  calls.some((c) => c.startsWith('GET /api/reports/') && c.endsWith('/draft')));
check('초안 패널이 열린다', !window.document.getElementById('draft-panel').hidden);
check('배너에 실패 메시지가 없다',
  banner() === null || banner().hidden || !banner().textContent.includes('못했습니다'),
  banner() && banner().textContent);
check('속보 문서가 그려진다', !!draftRoot().querySelector('.brief-doc'));

// ---------- main에서 온 미리보기 경로도 살아 있는지 ----------
check('미리보기 탭이 채워진다',
  !window.document.getElementById('report-preview-root').textContent.includes('입력하고 미리보기를'),
  window.document.getElementById('report-preview-root').textContent.slice(0, 40));

// ---------- 서버가 죽은 사이 제출하면 되돌릴 수 있는가 ----------
// 일시적인 연결 실패가 영구적인 막힘이 되면 안 된다. 서버 재시작 중에 제출한
// 작업자가 실제로 겪은 상황이다.
window.DraftView.close();
content.value = '배전반 문이 열려 있었습니다';
online = false;  // 진짜 오프라인 — 큐에 보관되는 경로
calls.length = 0;
form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await sleep(600);
check('연결이 끊기면 큐에 보관한다', calls.includes('POST /api/reports'));

// 저장은 됐는데 초안 요청만 실패한 경우 — 재시도 버튼이 나와야 한다
online = true;
const saved = await realFetch(`${BASE}/api/reports`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Reporter-Id': window.Profile.reporterId() },
  body: JSON.stringify({
    client_uuid: `flow-${Date.now()}`,
    content: '배전반 문이 열려 있었습니다',
    reporter_id: window.Profile.reporterId(),
  }),
}).then((r) => r.json());
// 브라우저는 온라인이라고 생각하지만 서버가 죽어 있다 — 재시작 중에 제출한
// 작업자가 실제로 겪은 상황이다. 오프라인 배너가 아니라 재시도 경로여야 한다.
serverDown = true;
await window.DraftView.open(saved.id);
await sleep(400);
check('요청이 실패하면 재시도 버튼이 나온다', !!draftRoot().querySelector('.btn-retry'),
  banner() && banner().textContent.slice(0, 60));
check('그 상태에서도 제출 버튼이 있다', !!draftRoot().querySelector('.draft-actions .btn-submit'));
serverDown = false;
draftRoot().querySelector('.btn-retry').dispatchEvent(new window.Event('click'));
await sleep(1200);
check('재시도하면 분석이 진행된다',
  window.DraftView._state() && window.DraftView._state().status === 'ready',
  window.DraftView._state() && window.DraftView._state().status);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
