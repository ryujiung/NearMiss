(function () {
  'use strict';

  const form = document.getElementById('nearmiss-form');
  const content = document.getElementById('content');
  const micBtn = document.getElementById('mic-btn');
  const micLabel = micBtn.querySelector('.mic-label');
  const notice = document.getElementById('voice-support-notice');
  const toastEl = document.getElementById('toast');
  const historyList = document.getElementById('history-list');
  const statsRoot = document.getElementById('stats-root');

  // ---------- 공통 UI ----------
  let toastTimer;
  function toast(message, ms = 3000) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
  }

  // ---------- 탭 ----------
  const tabButtons = document.querySelectorAll('.tabs [role="tab"]');

  function showTab(name) {
    tabButtons.forEach((btn) => {
      const selected = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', String(selected));
      document.getElementById(btn.getAttribute('aria-controls')).hidden = !selected;
    });
    if (name === 'stats') {
      if (voice) voice.stop();
      renderStats();
    }
    window.scrollTo(0, 0);
  }

  tabButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      // 주소에 탭을 남겨서 새로고침해도 같은 탭 유지
      history.replaceState(null, '', `#${btn.dataset.tab}`);
      showTab(btn.dataset.tab);
    })
  );

  async function renderStats() {
    try {
      const reports = await ReportStore.fetchAll();
      NearMissStats.render(statsRoot, reports, { localOnly: ReportStore.isLocalOnly });
    } catch (err) {
      console.error(err);
      statsRoot.textContent = '통계를 불러오지 못했습니다.';
    }
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
      const result = await ReportStore.submit(report);
      form.reset();
      await renderHistory();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast(
        result.queued
          ? '지금은 연결이 안 되어 저장해 두었습니다. 연결되면 자동으로 전송됩니다.'
          : '신고가 접수되었습니다. 감사합니다!'
      );
    } catch (err) {
      console.error(err);
      toast('전송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });

  // ---------- 내 신고 내역 ----------
  function formatDate(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 상태별 표시 — 색만으로 구분하지 않고 글자를 함께 둔다
  const STATUS_LABEL = {
    pending: '전송 대기 중',
    draft: '분석 대기',
    analyzing: '분석 중',
    ready: '확인 필요',
    failed: '분석 실패',
    submitted: '제출됨',
  };

  async function renderHistory() {
    const list = await ReportStore.myReports();
    historyList.innerHTML = '';
    if (!list.length) {
      historyList.innerHTML = '<li class="empty">아직 신고 내역이 없습니다.</li>';
      return;
    }
    list.forEach((r) => {
      const li = document.createElement('li');

      const meta = document.createElement('div');
      meta.className = 'meta';
      // 서버 레코드는 created_at, 이전 버전 로컬 레코드는 createdAt
      meta.textContent = formatDate(r.created_at || r.createdAt);

      const status = r.status || 'submitted';
      const badge = document.createElement('span');
      badge.className = `status-badge status-${status}`;
      badge.textContent = STATUS_LABEL[status] || status;
      meta.append(badge);

      const body = document.createElement('div');
      // 이전 버전(여러 칸 입력)으로 저장된 내역도 표시
      body.textContent = r.content || r.description || '';

      li.append(meta, body);
      historyList.appendChild(li);
    });
  }

  // ---------- 설정 (내 정보 · 관리자 토큰) ----------
  const settingsFields = {
    org: document.getElementById('profile-org'),
    name: document.getElementById('profile-name'),
    role: document.getElementById('profile-role'),
  };
  const adminTokenField = document.getElementById('admin-token');

  function loadSettings() {
    const profile = Profile.get() || {};
    Object.entries(settingsFields).forEach(([key, field]) => {
      field.value = profile[key] || '';
    });
    adminTokenField.value = Profile.adminToken();
  }

  document.getElementById('save-settings').addEventListener('click', () => {
    Profile.save({
      org: settingsFields.org.value,
      name: settingsFields.name.value,
      role: settingsFields.role.value,
    });
    Profile.saveAdminToken(adminTokenField.value);
    toast('저장했습니다.');
  });

  // ---------- 오프라인 큐 ----------
  async function flushPending() {
    if (!ReportStore.pendingCount()) return;
    const sent = await ReportStore.flushQueue();
    if (sent > 0) {
      toast(`전송 대기 중이던 신고 ${sent}건을 보냈습니다.`);
      renderHistory();
    }
  }

  window.addEventListener('online', flushPending);

  loadSettings();
  renderHistory();
  flushPending();
  showTab(location.hash === '#stats' ? 'stats' : 'report');
})();
