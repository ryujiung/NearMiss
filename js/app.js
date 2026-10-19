(function () {
  'use strict';

  const STORAGE_KEY = 'nearmiss-reports';

  const form = document.getElementById('nearmiss-form');
  const content = document.getElementById('content');
  const micBtn = document.getElementById('mic-btn');
  const micLabel = micBtn.querySelector('.mic-label');
  const notice = document.getElementById('voice-support-notice');
  const toastEl = document.getElementById('toast');
  const historyList = document.getElementById('history-list');

  // ---------- 공통 UI ----------
  let toastTimer;
  function toast(message, ms = 3000) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
  }

  // ---------- 음성 입력 ----------
  const availability = VoiceInput.checkAvailability();
  let voice = null;

  if (availability.ok) {
    voice = new VoiceInput({
      lang: 'ko-KR',
      onStatusChange: ({ listening }) => {
        micBtn.classList.toggle('listening', listening);
        micBtn.setAttribute('aria-pressed', String(listening));
        micLabel.textContent = listening ? '듣는 중… 눌러서 완료' : '눌러서 말하기';
      },
      onError: (msg) => toast(msg),
    });
    voice.bind(content, micBtn);
  } else {
    micBtn.hidden = true;
    notice.textContent = availability.reason;
    notice.hidden = false;
  }

  // ---------- 폼 ----------
  content.addEventListener('input', () => content.classList.remove('invalid'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // 말하는 도중 텍스트까지 포함해 현재 화면에 보이는 내용 그대로 제출
    const text = content.value.trim();
    if (voice) voice.abort();

    if (!text) {
      content.classList.add('invalid');
      content.focus();
      toast('내용을 입력하거나 말씀해 주세요.');
      return;
    }

    // 원문 그대로 저장 — 장소·유형·원인 등은 이후 서버에서 추출
    const report = {
      content: text,
      createdAt: new Date().toISOString(),
    };

    try {
      await submitReport(report);
      saveLocal(report);
      renderHistory();
      form.reset();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast('신고가 접수되었습니다. 감사합니다!');
    } catch (err) {
      console.error(err);
      toast('전송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });

  /**
   * 서버 전송 — 백엔드 API가 준비되면 여기만 바꾸면 됩니다.
   * 예) return fetch('/api/near-miss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })
   *       .then((r) => { if (!r.ok) throw new Error(r.status); });
   */
  async function submitReport(report) {
    console.log('[니어미스 신고]', report);
  }

  // ---------- 내 신고 내역 (기기 로컬 저장) ----------
  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveLocal(report) {
    try {
      const list = loadLocal();
      list.unshift(report);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 50)));
    } catch {
      /* 저장 실패해도 신고 자체에는 영향 없음 */
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHistory() {
    const list = loadLocal();
    historyList.innerHTML = '';
    if (!list.length) {
      historyList.innerHTML = '<li class="empty">아직 신고 내역이 없습니다.</li>';
      return;
    }
    list.forEach((r) => {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatDate(r.createdAt);
      const body = document.createElement('div');
      // 이전 버전(여러 칸 입력)으로 저장된 내역도 표시
      body.textContent = r.content || r.description || '';
      li.append(meta, body);
      historyList.appendChild(li);
    });
  }

  renderHistory();
})();
