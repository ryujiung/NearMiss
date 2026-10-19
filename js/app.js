(function () {
  'use strict';

  const STORAGE_KEY = 'nearmiss-reports';

  const form = document.getElementById('nearmiss-form');
  const notice = document.getElementById('voice-support-notice');
  const statusBar = document.getElementById('voice-status');
  const stopBtn = document.getElementById('voice-stop');
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
        statusBar.hidden = !listening;
      },
      onError: (msg) => toast(msg),
    });
    voice.attachAll('[data-voice]');
    stopBtn.addEventListener('click', () => voice.stop());
  } else {
    notice.textContent = availability.reason;
    notice.hidden = false;
  }

  // ---------- 폼 ----------
  // 발생 일시 기본값: 현재 시각
  const occurredAt = document.getElementById('occurredAt');
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  occurredAt.value = now.toISOString().slice(0, 16);

  form.addEventListener('input', (e) => e.target.classList.remove('invalid'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (voice) voice.stop();

    // 필수값 검사
    let firstInvalid = null;
    form.querySelectorAll('[required]').forEach((el) => {
      const empty = !el.value.trim();
      el.classList.toggle('invalid', empty);
      if (empty && !firstInvalid) firstInvalid = el;
    });
    if (firstInvalid) {
      firstInvalid.focus();
      toast('필수 항목을 입력해 주세요.');
      return;
    }

    const report = Object.fromEntries(new FormData(form).entries());
    report.createdAt = new Date().toISOString();

    try {
      await submitReport(report);
      saveLocal(report);
      renderHistory();
      form.reset();
      occurredAt.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
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
      meta.textContent = `${r.occurredAt.replace('T', ' ')} · ${r.category} · ${r.location}`;
      const desc = document.createElement('div');
      desc.textContent = r.description;
      li.append(meta, desc);
      historyList.appendChild(li);
    });
  }

  renderHistory();
})();
