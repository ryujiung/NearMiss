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

// js/brief-doc.js를 jsdom에 실제로 그려 검증한다.
// 브라우저 확장을 못 쓰므로, 사양 3.2가 요구하는 칸 순서·AI 표시·빈 칸 처리·
// 편집 시 표시 제거를 DOM 수준에서 확인한다.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;
const BASE = 'http://127.0.0.1:8000';

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
  url: 'http://localhost:8000/',
});
const { window } = dom;
global.document = window.document;

const src = fs.readFileSync(`${REPO}/js/brief-doc.js`, 'utf8');
new Function('window', 'document', src)(window, window.document);
const { BriefDoc } = window;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

// 실제 서버에서 광양 사례를 가져온다 — 손으로 만든 가짜가 아니라 진짜 모양으로 검증
const report = await fetch(`${BASE}/api/reports/seed-001`, {
  headers: { Authorization: 'Bearer demo-admin' },
}).then((r) => r.json());

const root = window.document.getElementById('root');

// ---------- 1. 읽기 전용 렌더 ----------
BriefDoc.render(root, report);
const labels = [...root.querySelectorAll('.doc-label')].map((n) =>
  n.textContent.replace('AI', '').trim()
);
check(
  '칸이 사양 3.2 순서대로 나온다',
  JSON.stringify(labels) ===
    JSON.stringify(['일시', '장소', '인적사항', '발생개요', '발생원인', '재발방지 대책 및 대응계획']),
  labels.join(' → ')
);

const badge = root.querySelector('.risk-badge');
check('위험도 배지에 글자가 들어 있다 (색만으로 구분하지 않음)',
  badge && badge.textContent.includes('상'), badge && badge.textContent);
check('배지 클래스가 등급을 반영한다', badge.className.includes('risk-high'));

check('제목이 보인다', root.querySelector('.doc-title').textContent.includes('Settling Chamber'));
check('위험도 근거가 보인다', !!root.querySelector('.doc-risk-reason'));
check('유형이 보인다', root.querySelector('.doc-category').textContent === '낙하/비래');

const identity = [...root.querySelectorAll('.doc-field')]
  .find((f) => f.querySelector('.doc-label').textContent.startsWith('인적사항'));
check('인적사항이 서버의 마스킹된 값을 쓴다',
  identity.textContent.includes('박 ○○ 등 3명') && !identity.textContent.includes('박민수'),
  identity.querySelector('.doc-value').textContent);

const causeTags = [...root.querySelectorAll('.cause-tag')].map((n) => n.textContent);
check('발생원인이 3분류로 나온다',
  JSON.stringify(causeTags) === JSON.stringify(['[물리적/환경적]', '[시스템/프로세스]', '[조직적]']),
  causeTags.join(' '));

const notes = [...root.querySelectorAll('.doc-note')].map((n) => n.textContent);
check('원인·대책에 AI 추정임을 문서에 남긴다',
  notes.length === 2 && notes.every((t) => t.includes('AI')), notes.join(' | '));

check('AI 표시가 붙어 있다', root.querySelectorAll('.ai-mark').length > 0,
  `${root.querySelectorAll('.ai-mark').length}개`);
check('읽기 전용에서는 편집 가능 요소가 없다',
  root.querySelectorAll('[contenteditable="true"]').length === 0);

// ---------- 2. 빈 칸 처리 ----------
const sparse = {
  draft: { risk: null, title: '', location: '', overview: [], causes: {}, countermeasures: [], sources: {} },
};
BriefDoc.render(root, sparse);
check('빈 칸을 숨기지 않고 미기재로 표시한다',
  [...root.querySelectorAll('.doc-empty')].length >= 4,
  `${root.querySelectorAll('.doc-empty').length}칸`);
check('위험도가 없으면 미분류 배지',
  root.querySelector('.risk-badge').textContent === '미분류');
check('빈 칸에 필수 입력 표시가 없다',
  !root.textContent.includes('필수') && !root.textContent.includes('*'));

// ---------- 3. 편집 모드 ----------
const edits = [];
BriefDoc.render(root, report, {
  editable: true,
  onFieldEdit: (field, value) => edits.push([field, value]),
});
check('편집 모드에서 칸이 편집 가능해진다',
  root.querySelectorAll('[contenteditable="true"]').length >= 5,
  `${root.querySelectorAll('[contenteditable="true"]').length}개`);

const locField = [...root.querySelectorAll('.doc-field')]
  .find((f) => f.querySelector('.doc-label').textContent.startsWith('장소'));
check('고치기 전에는 장소 칸에 AI 표시가 있다', !!locField.querySelector('.ai-mark'));

const locBody = locField.querySelector('.doc-value');
locBody.textContent = '2공장 3라인';
locBody.dispatchEvent(new window.Event('blur'));
check('고치면 onFieldEdit이 불린다',
  edits.some(([f, v]) => f === 'location' && v === '2공장 3라인'), JSON.stringify(edits));
check('고치면 AI 표시가 사라진다', !locField.querySelector('.ai-mark'));

// 값을 바꾸지 않고 blur하면 호출되지 않아야 한다 — 불필요한 PATCH를 막는다
const before = edits.length;
const timeBody = [...root.querySelectorAll('.doc-field')]
  .find((f) => f.querySelector('.doc-label').textContent.startsWith('일시'))
  .querySelector('.doc-value');
timeBody.dispatchEvent(new window.Event('blur'));
check('값이 그대로면 onFieldEdit을 부르지 않는다', edits.length === before);

// 원인 칸은 dict 전체를 돌려줘야 한다
const causeText = root.querySelector('.cause-text');
causeText.textContent = '용접 미흡 (수정)';
causeText.dispatchEvent(new window.Event('blur'));
const causeEdit = edits.find(([f]) => f === 'causes');
check('원인 수정은 causes dict 전체를 돌려준다',
  causeEdit && typeof causeEdit[1] === 'object' && causeEdit[1].physical === '용접 미흡 (수정)',
  JSON.stringify(causeEdit && causeEdit[1]));

// ---------- 4. 사진 ----------
const withPhotos = { ...report, photos: [{ photo_id: 'a', url: '/api/photos/a' }] };
BriefDoc.render(root, withPhotos);
check('사진이 있으면 그려진다', root.querySelectorAll('.doc-photos img').length === 1);
BriefDoc.render(root, { ...report, photos: [] });
check('사진이 없으면 칸을 만들지 않는다', !root.querySelector('.doc-photos'));

// ---------- 5. 실명 보기 ----------
BriefDoc.render(root, { ...report, realName: { name: '박민수', count: 3 } }, { showRealName: true });
check('showRealName이면 실명이 보인다', root.textContent.includes('박민수'));
BriefDoc.render(root, { ...report, realName: { name: '박민수', count: 3 } });
check('기본값에서는 실명이 보이지 않는다', !root.textContent.includes('박민수'));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
