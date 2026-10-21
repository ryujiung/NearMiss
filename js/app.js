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
  const previewRoot = document.getElementById('report-preview-root');
  const previewEditButton = document.getElementById('preview-edit');
  const previewPdfButton = document.getElementById('preview-pdf');
  const previewGmailLink = document.getElementById('preview-gmail');
  const sendResult = document.getElementById('send-result');
  const recipientInput = document.getElementById('recipient-input');
  const recipientList = document.getElementById('recipient-list');
  const recipientError = document.getElementById('recipient-error');
  const recipients = [];
  let pendingReport = null;
  let voiceRecordingStartedAt = null;

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

  function updateGmailLink() {
    const enabled = Boolean(pendingReport && recipients.length);
    previewGmailLink.setAttribute('aria-disabled', String(!enabled));
    sendResult.hidden = true;
  }

  // 실제 발송 없이 발송된 것처럼 보여 주는 시뮬레이션
  let sending = false;
  function simulateSend() {
    sending = true;
    previewGmailLink.disabled = true;
    previewGmailLink.textContent = '보내는 중…';
    sendResult.hidden = true;
    setTimeout(() => {
      sending = false;
      previewGmailLink.disabled = false;
      previewGmailLink.textContent = '이메일 전송하기';
      sendResult.innerHTML = '';
      const title = document.createElement('strong');
      title.textContent = '✔ 메일을 보냈습니다';
      const to = document.createElement('p');
      to.textContent = `받는 사람: ${recipients.join(', ')}`;
      const when = document.createElement('p');
      when.textContent = `보낸 시각: ${formatDate(new Date().toISOString())}`;
      sendResult.append(title, to, when);
      sendResult.hidden = false;
      toast('메일을 보냈습니다.');
    }, 1200);
  }

  function addRecipient(value) {
    const email = value.trim();
    if (!email) return true;
    const valid = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email);
    if (!valid) {
      recipientError.textContent = '올바른 이메일 주소를 입력해 주세요.';
      recipientError.hidden = false;
      return false;
    }
    if (!recipients.some((recipient) => recipient.toLowerCase() === email.toLowerCase())) {
      recipients.push(email);
      const chip = document.createElement('span');
      chip.className = 'recipient-chip';
      const address = document.createElement('span');
      address.textContent = email;
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'recipient-remove';
      removeButton.setAttribute('aria-label', `${email} 삭제`);
      removeButton.textContent = '×';
      removeButton.addEventListener('click', () => {
        recipients.splice(recipients.indexOf(email), 1);
        chip.remove();
        updateGmailLink();
      });
      chip.append(address, removeButton);
      recipientList.insertBefore(chip, recipientInput);
      updateGmailLink();
    }
    recipientError.hidden = true;
    return true;
  }

  function commitRecipientInput() {
    const values = recipientInput.value.split(/[;,]/);
    if (values.some((value) => value.trim() && !addRecipient(value))) return false;
    recipientInput.value = '';
    return true;
  }

  recipientInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      commitRecipientInput();
    } else if (event.key === 'Backspace' && !recipientInput.value && recipients.length) {
      const lastRecipient = recipients[recipients.length - 1];
      recipientList.querySelector('.recipient-chip:last-of-type .recipient-remove').click();
      recipientInput.value = lastRecipient;
    }
  });
  recipientInput.addEventListener('blur', commitRecipientInput);

  function showTab(name) {
    tabButtons.forEach((btn) => {
      const selected = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', String(selected));
      document.getElementById(btn.getAttribute('aria-controls')).hidden = !selected;
    });
    // 신고 탭을 떠나면 마이크를 끈다 — 다른 탭에서 계속 듣고 있으면 안 된다.
    if (name !== 'report' && voice) voice.stop();
    if (name === 'stats') renderStats();
    if (name === 'admin') AdminView.render();
    window.scrollTo(0, 0);
  }

  tabButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      // 주소에 탭을 남겨서 새로고침해도 같은 탭 유지
      history.replaceState(null, '', `#${btn.dataset.tab}`);
      showTab(btn.dataset.tab);
    })
  );

  async function renderStats(period) {
    try {
      const params = period ? `?period=${encodeURIComponent(period)}` : '';
      const res = await fetch(`/api/stats${params}`);
      if (!res.ok) throw new Error(`통계 조회 실패: ${res.status}`);
      NearMissStats.render(statsRoot, await res.json(), { period });
    } catch (err) {
      console.error(err);
      statsRoot.textContent = '통계를 불러오지 못했습니다.';
    }
  }

  function renderPreview(report) {
    previewRoot.replaceChildren();
    const reportDetails = report.details || null;

    const documentCard = document.createElement('article');
    documentCard.className = 'report-document';

    const title = document.createElement('h3');
    title.textContent = '아차사고 보고서';
    documentCard.appendChild(title);

    const metadata = document.createElement('dl');
    metadata.className = 'report-document-meta';
    [
      ['작성일시', formatDate(report.createdAt)],
      ['녹음일시', report.recordedAt ? formatDate(report.recordedAt) : report.recordedAt === undefined ? '기록 없음' : '음성 녹음 없음 (직접 입력)'],
      ['사고 유형 (참고)', NearMissClassify.classify(report)],
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      item.append(term, description);
      metadata.appendChild(item);
    });
    documentCard.appendChild(metadata);

    // 속보 초안이 있으면 초안 화면·관리자 상세와 같은 전체 속보 문서를 그대로 쓴다.
    if (report.draft) {
      const briefHost = document.createElement('div');
      briefHost.className = 'preview-brief';
      BriefDoc.render(briefHost, report, { editable: false });
      const briefTitle = briefHost.querySelector('.doc-title');
      if (briefTitle) briefTitle.remove();
      documentCard.appendChild(briefHost);
    }

    if (reportDetails) {
      const details = document.createElement('dl');
      details.className = 'report-details';
      reportDetails.forEach(([label, value]) => {
        const item = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = label;
        const description = document.createElement('dd');
        description.textContent = value;
        item.append(term, description);
        details.appendChild(item);
      });
      documentCard.appendChild(details);
    }

    const contentTitle = document.createElement('h4');
    contentTitle.textContent = report.draft || reportDetails ? '신고 원문' : '신고 내용';
    const contentBody = document.createElement('p');
    contentBody.className = 'report-document-content';
    contentBody.textContent = report.content;
    documentCard.append(contentTitle, contentBody);
    previewRoot.appendChild(documentCard);
    previewPdfButton.disabled = false;
    updateGmailLink();
  }

  // ---------- 음성 입력 ----------
  let voice = null;

  // 시동어('목업')를 말하면 이 파일의 문장을 실제 음성처럼 흘려보낸다 (서버 모드와 무관한 정적 파일)
  const MOCK_VOICE_URL = 'rec_mock/' + encodeURIComponent('니어미스사례1.txt');

  async function loadMockScript() {
    try {
      const res = await fetch(MOCK_VOICE_URL);
      return res.ok ? (await res.text()).trim() || null : null;
    } catch (e) {
      return null;
    }
  }

  function setupVoice(script) {
    const availability = VoiceInput.checkAvailability();
    if (availability.ok || script) {
      voice = new VoiceInput({
        lang: 'ko-KR',
        script,
        onStatusChange: ({ listening }) => {
          if (listening && !voiceRecordingStartedAt) {
            voiceRecordingStartedAt = new Date().toISOString();
          }
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
  }

  loadMockScript().then(setupVoice);

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

    // 미리보기·메일 경로가 쓰는 로컬 사본. 서버 저장과 별개로 유지해, 보고서
    // 미리보기 탭과 Gmail 발송이 그대로 동작한다.
    const recordedAt = voiceRecordingStartedAt || null;
    pendingReport = {
      content: text,
      createdAt: new Date().toISOString(),
      recordedAt,
    };
    voiceRecordingStartedAt = null;
    renderPreview(pendingReport);

    const report = { content: text, createdAt: pendingReport.createdAt };

    try {
      const result = await ReportStore.submit(report);
      if (result.id) saveRecordedAt(result.id, recordedAt);
      form.reset();
      await renderHistory();

      if (result.queued) {
        // 전송조차 못 했으면 초안 화면을 열 대상이 없다. 원문은 큐에 안전하게
        // 남아 있고, 연결되면 전송된다. 미리보기·메일은 로컬 사본으로 쓸 수 있다.
        history.replaceState(null, '', '#preview');
        showTab('preview');
        toast('지금은 연결이 안 되어 저장해 두었습니다. 연결되면 자동으로 전송됩니다.');
        return;
      }

      // 초안 화면을 먼저 열고, 분석은 그 안에서 돈다(사양 3.1)
      DraftView.open(result.id, {
        onClose: async (outcome) => {
          await renderHistory();
          // AI가 채운 속보를 미리보기·메일 경로에도 반영한다 — 메일로 나가는
          // 내용이 작업자가 확인한 속보와 같아야 한다.
          await syncPreviewFromServer(result.id);
          if (outcome.submitted) toast('신고가 접수되었습니다. 감사합니다!');
        },
      });
    } catch (err) {
      console.error(err);
      toast('전송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  });

  /** 내 신고 목록에서 서버가 가려 둔 인적사항(reporter, identity_line)을 가져온다. */
  async function ownReportIdentity(reportId) {
    try {
      const mine = (await ReportStore.myReports()).find((item) => item.id === reportId);
      return mine ? { reporter: mine.reporter, identity_line: mine.identity_line } : {};
    } catch (err) {
      return {};
    }
  }

  /** 서버의 최신 초안을 미리보기·메일 경로가 쓰는 사본에 반영한다. */
  async function syncPreviewFromServer(reportId) {
    try {
      const params = new URLSearchParams({ reporter_id: Profile.reporterId() });
      const res = await fetch(`/api/reports/${reportId}/draft?${params}`, {
        headers: Profile.ownerHeaders(),
      });
      if (!res.ok) return;
      const body = await res.json();
      if (!body.draft) return;
      pendingReport = {
        ...(pendingReport || {}),
        draft: body.draft,
        risk: body.risk,
        photos: body.photos || [],
        ...(await ownReportIdentity(reportId)),
      };
      renderPreview(pendingReport);
    } catch (err) {
      console.warn('[니어미스] 미리보기 동기화 실패', err);
    }
  }

  previewEditButton.addEventListener('click', () => {
    history.replaceState(null, '', '#report');
    showTab('report');
    content.focus();
  });

  previewGmailLink.addEventListener('click', (event) => {
    if (previewGmailLink.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      if (!pendingReport) toast('먼저 신고 내용을 입력하고 미리보기를 생성해 주세요.');
      else {
        recipientInput.focus();
        toast('받는 사람 이메일 주소를 입력해 주세요.');
      }
      return;
    }
    if (sending) return;
    if (!commitRecipientInput()) {
      recipientInput.focus();
      return;
    }
    simulateSend();
  });

  previewPdfButton.addEventListener('click', () => {
    if (!pendingReport) {
      toast('먼저 신고 내용을 입력하고 미리보기를 생성해 주세요.');
      return;
    }
    const originalTitle = document.title;
    const date = pendingReport.createdAt.slice(0, 10);
    document.title = `아차사고-보고서-${date}`;
    window.addEventListener('afterprint', () => {
      document.title = originalTitle;
    }, { once: true });
    window.print();
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

  // 녹음 시작 시각은 서버에 저장되지 않으므로 이 브라우저에 신고 id별로 남긴다.
  // 값이 null이면 직접 입력한 신고, 항목이 없으면 기록이 없는 신고다.
  const RECORDED_AT_KEY = 'nearmiss-recorded-at';
  function readRecordedAtMap() {
    try {
      return JSON.parse(localStorage.getItem(RECORDED_AT_KEY)) || {};
    } catch (err) {
      return {};
    }
  }
  function saveRecordedAt(reportId, recordedAt) {
    const map = readRecordedAtMap();
    map[reportId] = recordedAt;
    try {
      localStorage.setItem(RECORDED_AT_KEY, JSON.stringify(map));
    } catch (err) {
      console.warn('[니어미스] 녹음일시 저장 실패', err);
    }
  }

  /** 내 신고 내역의 한 건을 보고서 미리보기 탭에 연다. */
  async function openReportPreview(r) {
    voiceRecordingStartedAt = null;
    const map = readRecordedAtMap();
    pendingReport = {
      content: r.content || r.description || '',
      createdAt: r.created_at || r.createdAt,
      recordedAt: r.id && r.id in map ? map[r.id] : undefined,
    };
    renderPreview(pendingReport);
    history.replaceState(null, '', '#preview');
    showTab('preview');
    if (r.id) await syncPreviewFromServer(r.id);
  }

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

      const main = document.createElement('div');
      main.className = 'history-main';
      main.append(meta, body);

      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn-history-preview';
      previewBtn.textContent = '보고서 미리보기';
      previewBtn.addEventListener('click', () => openReportPreview(r));

      const row = document.createElement('div');
      row.className = 'history-row';
      row.append(main, previewBtn);
      li.append(row);
      // 제출 전 건은 눌러서 초안 화면으로 돌아간다(사양 3.8). 이 경로가 없으면
      // 새로고침하거나 '나중에 하기'를 누른 신고, 오프라인 큐에서 올라온 신고가
      // 영구 미제출로 남아 통계·관리자 큐 어디에도 도달하지 않는다.
      if (r.id && status !== 'submitted' && status !== 'pending') {
        li.classList.add('history-resumable');
        const resume = document.createElement('button');
        resume.type = 'button';
        resume.className = 'btn-resume';
        resume.textContent = status === 'failed' ? '다시 분석하고 제출' : '이어서 제출';
        resume.addEventListener('click', () => {
          DraftView.open(r.id, {
            onClose: async (outcome) => {
              await renderHistory();
              if (outcome.submitted) toast('신고가 접수되었습니다. 감사합니다!');
            },
          });
        });
        li.append(resume);
      }

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
    if (!document.getElementById('tab-admin').hidden) AdminView.render();
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

  // 탭 4개 모두 주소로 복원된다 — 새로고침해도 같은 화면이 뜬다.
  const TABS = ['report', 'preview', 'stats', 'admin'];
  const fromHash = location.hash.replace('#', '');
  showTab(TABS.includes(fromHash) ? fromHash : 'report');
})();
