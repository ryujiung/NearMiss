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

// js/stats.js를 실제 서버 집계로 jsdom에 그려 검증한다.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: `${BASE}/` });
const { window } = dom;
global.document = window.document;

const src = fs.readFileSync(`${REPO}/js/stats.js`, 'utf8');
new Function('window', 'document', src)(window, window.document);
const { NearMissStats } = window;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

const root = window.document.getElementById('root');
const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());

NearMissStats.render(root, stats);

const titles = [...root.querySelectorAll('.card-title')].map((n) => n.textContent);
check('카드 네 종류가 나온다',
  JSON.stringify(titles) === JSON.stringify(['일별 신고 건수', '위험도 분포', '유형별 신고', '시간대별 신고']),
  titles.join(' / '));

const tileValues = [...root.querySelectorAll('.tile-value')].map((n) => n.textContent);
check('요약 타일 4개가 서버 수치를 쓴다',
  tileValues.length === 4 && tileValues[0] === `${stats.total}건`,
  tileValues.join(' '));

const cols = root.querySelectorAll('.col-chart');
check('세로 막대 차트가 둘 (일별, 시간대별)', cols.length === 2, `${cols.length}개`);
const dailyCols = cols[0].querySelectorAll('.col');
check('일별이 14칸', dailyCols.length === 14, `${dailyCols.length}칸`);
const hourCols = cols[1].querySelectorAll('.col');
check('시간대별이 8칸', hourCols.length === 8, `${hourCols.length}칸`);

const hourLabels = [...cols[1].querySelectorAll('.col-labels span')].map((n) => n.textContent);
check('시간대 레이블이 0·3·6…21시', hourLabels[0] === '0시' && hourLabels[7] === '21시',
  hourLabels.join(' '));

const riskRows = [...root.querySelectorAll('.hbar-row')]
  .map((r) => r.querySelector('.hbar-label').textContent);
check('위험도 세 등급이 모두 보인다',
  ['상', '중', '하'].every((l) => riskRows.includes(l)), riskRows.join(' '));

check('"이 기기 기준" 안내가 사라졌다', !root.textContent.includes('이 기기'));
check('표로 보기가 유지된다', root.querySelectorAll('details.table-view').length === 4,
  `${root.querySelectorAll('details.table-view').length}개`);
check('막대에 aria-label이 붙어 있다',
  [...dailyCols].every((c) => c.getAttribute('aria-label')?.includes('건')));
check('키보드로 막대에 갈 수 있다', [...dailyCols].every((c) => c.tabIndex === 0));

// 원문·이름이 화면에 섞이지 않는다 (집계만 받으므로 구조적으로 불가능해야 한다)
check('화면에 원문·이름이 없다',
  !root.textContent.includes('박') && !root.textContent.includes('난간'),
  '');

// 빈 데이터
NearMissStats.render(root, { total: 0, today: 0, week: 0, month: 0, daily: [], category: [], hourly: [], risk: [] });
check('데이터가 없으면 안내만 보인다',
  root.textContent.includes('아직 신고된 내역이 없습니다'));

// period 주석
NearMissStats.render(root, stats, { period: 'week' });
check('period를 주면 기준 안내가 붙는다', root.textContent.includes('최근 7일 기준'));
NearMissStats.render(root, stats, { period: 'month' });
check('month면 30일 기준', root.textContent.includes('최근 30일 기준'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
