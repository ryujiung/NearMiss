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

// js/profile.js와 js/store.js를 node에서 실제 서버에 붙여 돌린다.
// 브라우저 확장이 연결되지 않아 UI를 몰 수 없으므로, 적어도 오프라인 큐와
// 멱등 재전송(Review Focus 4)은 여기서 검증한다.
import fs from 'node:fs';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';

// --- 브라우저 흉내 ---
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let offline = false;
const realFetch = globalThis.fetch;
const win = {
  crypto: globalThis.crypto,
  localStorage,
  addEventListener() {},
  console,
  fetch: (url, opts) => {
    if (offline) return Promise.reject(new Error('offline'));
    return realFetch(BASE + url, opts);
  },
};
win.window = win;

function load(path) {
  const src = fs.readFileSync(path, 'utf8');
  // IIFE가 window를 인자로 받으므로 그 자리에 흉내 객체를 넣는다.
  const fn = new Function('window', 'localStorage', 'fetch', 'console', 'Profile', 'crypto', src + '\n;return window;');
  return fn(win, localStorage, win.fetch, console, win.Profile, globalThis.crypto);
}

load(`${REPO}/js/profile.js`);
load(`${REPO}/js/store.js`);

const { Profile, ReportStore } = win;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

// 1. 기기 ID는 한 번 만들어지고 유지된다
const id1 = Profile.reporterId();
const id2 = Profile.reporterId();
check('reporterId는 재호출해도 같다', id1 === id2, id1);

// 2. 프로필 저장/복원
Profile.save({ org: ' 두원기업 ', name: '박민수', role: '축로공' });
const p = Profile.get();
check('프로필이 저장되고 공백이 다듬어진다', p.org === '두원기업' && p.name === '박민수');
check('빈 프로필은 null', (() => { store.delete('nearmiss-profile'); const r = Profile.get() === null; Profile.save(p); return r; })());

// 3. 관리자 토큰
Profile.saveAdminToken('demo-admin');
check('관리자 헤더가 만들어진다', Profile.adminHeaders().Authorization === 'Bearer demo-admin');

// 4. 온라인 제출
const r1 = await ReportStore.submit({ content: 'node 검증 신고 1' });
check('온라인 제출은 queued=false, id를 받는다', r1.queued === false && !!r1.id, JSON.stringify(r1));

// 5. 오프라인 제출 → 큐
offline = true;
const r2 = await ReportStore.submit({ content: 'node 검증 오프라인 신고' });
check('오프라인 제출은 queued=true', r2.queued === true);
check('pendingCount가 1', ReportStore.pendingCount() === 1);

// 6. 오프라인에서도 내역이 보인다 (캐시 + 대기 건)
const offlineList = await ReportStore.myReports();
check('오프라인 내역에 대기 건이 보인다',
  offlineList.some((r) => r.status === 'pending' && r.content === 'node 검증 오프라인 신고'));

// 7. 온라인 복구 → 큐 비움
offline = false;
const sent = await ReportStore.flushQueue();
check('flushQueue가 1건 보냈다', sent === 1, `sent=${sent}`);
check('큐가 비었다', ReportStore.pendingCount() === 0);

// 8. 멱등성 — 같은 client_uuid를 두 번 보내도 한 건 (Review Focus 4)
const before = (await ReportStore.myReports()).length;
offline = true;
await ReportStore.submit({ content: 'node 검증 멱등 신고' });
offline = false;
const q = JSON.parse(localStorage.getItem('nearmiss-queue'));
await ReportStore.flushQueue();
// 같은 payload를 손으로 한 번 더 — 재전송 중 응답을 못 받은 상황 재현
localStorage.setItem('nearmiss-queue', JSON.stringify(q));
await ReportStore.flushQueue();
const after = (await ReportStore.myReports()).length;
check('같은 client_uuid 재전송은 중복을 만들지 않는다', after === before + 1,
  `before=${before} after=${after}`);

// 9. 서버가 reporter를 받아 마스킹한다
const mine = await ReportStore.myReports();
check('내역에 원문이 들어 있다', mine.every((r) => typeof r.content === 'string'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
