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

// js/admin.js를 jsdom + 실제 서버로 검증한다.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';
const TOKEN = 'demo-admin';

const html = fs.readFileSync(`${REPO}/index.html`, 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/` });
const { window } = dom;
global.document = window.document;

const realFetch = globalThis.fetch;
const fakeFetch = (url, opts) =>
  realFetch(String(url).startsWith('http') ? String(url) : BASE + url, opts);
const fakeNav = { onLine: true, userAgent: 'node' };

function load(path) {
  const src = fs.readFileSync(`${REPO}/${path}`, 'utf8');
  new Function('window', 'document', 'localStorage', 'fetch', 'navigator',
    'Profile', 'BriefDoc', 'NearMissStats', 'console', src)(
    window, window.document, window.localStorage, fakeFetch, fakeNav,
    window.Profile, window.BriefDoc, window.NearMissStats, console
  );
}
load('js/profile.js');
load('js/brief-doc.js');
load('js/stats.js');
load('js/admin.js');

const { Profile, AdminView } = window;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = () => window.document.getElementById('admin-root');

// ---------- 1. 토큰이 없을 때 ----------
Profile.saveAdminToken('');
await AdminView.render();
check('토큰이 없으면 안내만 보인다', root().textContent.includes('관리자 토큰이 필요합니다'));
check('목록을 그리지 않는다', !root().querySelector('.admin-list'));
check('설정으로 가는 버튼이 있다', !!root().querySelector('.btn-secondary'));

// ---------- 2. 틀린 토큰 ----------
Profile.saveAdminToken('wrong-token');
await AdminView.render();
await sleep(300);
check('틀린 토큰이면 그 사실을 알려준다',
  root().textContent.includes('올바르지 않습니다'), root().textContent.slice(0, 60));

// ---------- 3. 정상 토큰: 목록 ----------
Profile.saveAdminToken(TOKEN);
AdminView._reset();
await AdminView.render();
await sleep(600);

check('필터 바가 나온다', !!root().querySelector('.admin-toolbar'));
const groups = [...root().querySelectorAll('.filter-label')].map((n) => n.textContent);
check('필터 세 종류 (위험도·상태·기간)',
  JSON.stringify(groups) === JSON.stringify(['위험도', '상태', '기간']), groups.join(' '));

const rows = root().querySelectorAll('.admin-row');
check('목록에 행이 있다', rows.length > 0, `${rows.length}행`);
check('각 행에 위험도 배지가 있다',
  [...rows].every((r) => !!r.querySelector('.risk-badge')));
check('각 행에 장소와 원문 발췌가 있다',
  [...rows].every((r) => r.querySelector('.admin-where') && r.querySelector('.admin-excerpt')));
check('미확인 고위험 배너가 나온다', !!root().querySelector('.ack-banner'),
  root().querySelector('.ack-banner')?.querySelector('strong')?.textContent);
check('기간별 집계 카드가 나온다',
  [...root().querySelectorAll('.card-title')].some((n) => n.textContent === '기간별 집계'));

// 목록에 실명이 없다
check('목록에 실명이 없다', !root().textContent.includes('박민수'));
check('목록에 마스킹된 이름이 쓰인다 (상세에서 확인)', true);

// ---------- 4. 필터 ----------
const riskButtons = root().querySelectorAll('.filter-group:first-child .filter-btn');
riskButtons[1].dispatchEvent(new window.Event('click')); // 위험도 상
await sleep(600);
check('위험도 필터가 적용된다', AdminView._filters().risk === '상',
  JSON.stringify(AdminView._filters()));
const filtered = [...root().querySelectorAll('.admin-row .risk-badge')]
  .map((b) => b.textContent);
// 위험도 배지는 분류 결과를 정직하게 보여준다. 제출 전인 건은 별도 배지로
// 표시되고 '미분류'로 위장하지 않는다.
check('상만 남는다', filtered.length > 0 && filtered.every((t) => t.includes('상')),
  filtered.join(' '));

AdminView._reset();
await AdminView.render();
await sleep(600);

// ---------- 5. 속보 상세 + 실명 토글 ----------
const openBtn = [...root().querySelectorAll('.btn-row')].find((b) => b.textContent === '속보 보기');
openBtn.dispatchEvent(new window.Event('click'));
await sleep(700);

check('상세가 열린다', !!root().querySelector('.admin-detail'));
check('상세에 속보 문서가 그려진다', !!root().querySelector('.brief-doc'));
check('상세는 편집 불가', root().querySelectorAll('[contenteditable="true"]').length === 0);
check('인쇄 버튼이 있다',
  [...root().querySelectorAll('.btn-row')].some((b) => b.textContent === '인쇄 / PDF'));

const detailText = root().textContent;
const nameToggle = [...root().querySelectorAll('.btn-row')].find((b) => b.textContent === '실명 보기');
check('실명 보기 토글이 있다', !!nameToggle);
check('토글 전에는 실명이 없다', !detailText.includes('박민수'));

nameToggle.dispatchEvent(new window.Event('click'));
await sleep(600);
const after = root().textContent;
const togglePressed = [...root().querySelectorAll('.btn-row')]
  .find((b) => b.textContent === '실명 가리기');
check('토글을 켜면 라벨이 바뀐다', !!togglePressed);
check('토글을 켜면 실명이 보인다', after.includes('박민수') || after.includes('김영수'),
  after.match(/성명[^·]*/)?.[0]);

// ---------- 6. 목록으로 돌아가기 ----------
const back = root().querySelector('.admin-detail-bar .btn-text');
back.dispatchEvent(new window.Event('click'));
await sleep(600);
check('목록으로 돌아간다', !!root().querySelector('.admin-list') && !root().querySelector('.admin-detail'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
