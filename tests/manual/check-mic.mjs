// 마이크 버튼을 누르는 경로를 재현한다.
// 두 가지를 본다: (1) 음성 인식이 없는 환경(정적 배포·비보안 origin)에서
// 스크립트 모드로 떨어지는가, (2) 실제 인식 중 '목업' 키워드로 전환되는가.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const REPO = new URL('../..', import.meta.url).pathname;

const html = fs.readFileSync(`${REPO}/index.html`, 'utf8');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const script = fs.readFileSync(`${REPO}/rec_mock/니어미스사례1.txt`, 'utf8').trim();

/** 앱을 띄운다. hasSpeech=false면 브라우저가 음성 인식을 제공하지 않는 환경. */
function boot({ hasSpeech, secure = true }) {
  const dom = new JSDOM(html, { url: 'https://example.test/' });
  const { window } = dom;
  global.document = window.document;

  const errors = [];
  const toasts = [];

  if (hasSpeech) {
    // 실제 인식기를 흉내 낸다 — start() 후 결과를 수동으로 밀어넣을 수 있게
    window.webkitSpeechRecognition = class {
      start() { window.__rec = this; }
      stop() { setTimeout(() => this.onend && this.onend(), 10); }
      abort() {}
    };
  }
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });

  const fakeFetch = (url) => {
    const p = String(url);
    if (p.includes('니어미스') || p.includes('rec_mock')) {
      return Promise.resolve({ ok: true, status: 200, text: async () => script });
    }
    if (p.includes('mock/stats.json')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => JSON.parse(fs.readFileSync(`${REPO}/mock/stats.json`, 'utf8')),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  };

  function load(path) {
    const src = fs.readFileSync(`${REPO}/${path}`, 'utf8');
    new Function(
      'window', 'document', 'localStorage', 'fetch', 'navigator', 'console', 'Event',
      'Profile', 'ReportStore', 'BriefDoc', 'DraftView', 'AdminView', 'NearMissStats',
      'NearMissClassify', 'VoiceInput', 'AutoDraft', 'FormData', 'history', 'location',
      src
    )(
      window, window.document, window.localStorage, fakeFetch,
      { onLine: true, userAgent: 'Mozilla/5.0' },
      { log() {}, warn() {}, error(...a) { errors.push(a.join(' ')); } },
      window.Event,
      window.Profile, window.ReportStore, window.BriefDoc, window.DraftView,
      window.AdminView, window.NearMissStats, window.NearMissClassify,
      window.VoiceInput, window.AutoDraft, globalThis.FormData,
      window.history, window.location
    );
  }

  for (const f of fs.readdirSync(`${REPO}/js`).filter((n) => n.endsWith('.js') && n !== 'app.js')) {
    load(`js/${f}`);
  }
  load('js/app.js');

  // toast를 가로채 사용자에게 보이는 메시지를 잡는다
  const toastEl = window.document.getElementById('toast');
  const obs = setInterval(() => {
    if (toastEl && !toastEl.hidden && toastEl.textContent) {
      if (!toasts.includes(toastEl.textContent)) toasts.push(toastEl.textContent);
    }
  }, 30);

  return { window, errors, toasts, stop: () => clearInterval(obs) };
}

// ---------- 1. 음성 인식이 없는 환경 (정적 배포에서 흔한 경우) ----------
console.log('=== 음성 인식 미지원 환경 ===');
{
  const app = boot({ hasSpeech: false });
  const { window } = app;
  await sleep(300);  // loadMockScript
  const mic = window.document.getElementById('mic-btn');
  const content = window.document.getElementById('content');

  check('마이크 버튼이 숨겨지지 않았다 (스크립트 모드로 쓸 수 있어야 한다)', !mic.hidden);
  mic.dispatchEvent(new window.Event('click'));
  await sleep(2500);

  check('눌렀을 때 콘솔 에러가 없다', app.errors.length === 0, app.errors[0]);
  check('토스트 에러가 없다', app.toasts.length === 0, app.toasts.join(' | '));
  check('글자가 흘러들어온다', content.value.length > 5, `${content.value.length}자`);
  console.log('   받아쓴 앞부분:', JSON.stringify(content.value.slice(0, 30)));
  app.stop();
}

// ---------- 2. 실제 인식 중 '목업' 키워드 ----------
console.log('\n=== 음성 인식 지원 + 목업 키워드 ===');
{
  const app = boot({ hasSpeech: true });
  const { window } = app;
  await sleep(300);
  const mic = window.document.getElementById('mic-btn');
  const content = window.document.getElementById('content');

  mic.dispatchEvent(new window.Event('click'));
  await sleep(100);
  check('인식기가 start됐다', !!window.__rec);

  // 사용자가 '목업'이라고 말한 것처럼
  window.__rec.onresult({
    results: [Object.assign([{ transcript: '목업' }], { isFinal: true })],
  });
  await sleep(3000);

  check('키워드 후 콘솔 에러가 없다', app.errors.length === 0, app.errors[0]);
  check('키워드 후 토스트 에러가 없다', app.toasts.length === 0, app.toasts.join(' | '));
  check('스크립트가 흘러들어온다', content.value.length > 5, `${content.value.length}자`);
  check("'목업'이 입력란에 남지 않았다", !content.value.includes('목업'),
    JSON.stringify(content.value.slice(0, 20)));
  console.log('   받아쓴 앞부분:', JSON.stringify(content.value.slice(0, 30)));
  app.stop();
}

// ---------- 3. network 에러 → 녹음본으로 폴백 ----------
// Chrome은 오디오를 Google 서버로 보내 변환하므로 사내망·VPN에서 'network'로
// 실패하는 일이 흔하다. 마이크는 멀쩡하니 "미지원" 경로에 걸리지 않고, 폴백이
// 없으면 시연이 거기서 끊긴다.
console.log('\n=== 음성 인식 network 에러 ===');
{
  const app = boot({ hasSpeech: true });
  const { window } = app;
  await sleep(300);
  const mic = window.document.getElementById('mic-btn');
  const content = window.document.getElementById('content');

  mic.dispatchEvent(new window.Event('click'));
  await sleep(100);
  check('인식기가 start됐다', !!window.__rec);

  window.__rec.onerror({ error: 'network' });
  await sleep(3000);

  check('녹음본으로 전환돼 글자가 흘러들어온다', content.value.length > 5,
    `${content.value.length}자`);
  check('무슨 일인지 알려준다',
    app.toasts.some((t) => t.includes('녹음본으로 진행')), app.toasts.join(' | '));
  check('듣기 상태가 유지된다 (끊기지 않는다)',
    mic.getAttribute('aria-pressed') === 'true', mic.getAttribute('aria-pressed'));
  console.log('   받아쓴 앞부분:', JSON.stringify(content.value.slice(0, 30)));
  app.stop();
}

// ---------- 4. 녹음본이 없으면 그대로 에러 ----------
// 폴백이 실패를 삼켜버리면 안 된다. 쓸 녹음본이 없을 때는 알려줘야 한다.
console.log('\n=== 녹음본 없이 network 에러 ===');
{
  const dom2 = await import('jsdom');
  const d = new dom2.JSDOM(html, { url: 'https://example.test/' });
  const w = d.window;
  global.document = w.document;
  w.webkitSpeechRecognition = class {
    start() { w.__rec = this; } stop() {} abort() {}
  };
  Object.defineProperty(w, 'isSecureContext', { value: true, configurable: true });
  const src = fs.readFileSync(`${REPO}/js/voice-input.js`, 'utf8');
  new Function('window', 'document', 'navigator', 'console', 'Event', src)(
    w, w.document, { userAgent: 'Mozilla/5.0' }, { log() {}, warn() {}, error() {} }, w.Event
  );
  const msgs = [];
  const v = new w.VoiceInput({ onError: (m) => msgs.push(m) });  // script 없음
  v.bind(w.document.getElementById('content'), w.document.getElementById('mic-btn'));
  v.start();
  w.__rec.onerror({ error: 'network' });
  await sleep(200);
  check('녹음본이 없으면 네트워크 오류를 그대로 알린다',
    msgs.some((m) => m.includes('네트워크 오류')), msgs.join(' | '));
  check('듣기가 멈춘다', v.listening === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
