/**
 * DraftView: 속보 초안 확인 화면
 *
 * 제출 직후 **먼저 열리고** 그 다음 폴링한다(사양 3.1). 사내 API의 응답 지연을
 * 모르는 전제이므로, 화면이 응답을 기다리며 비어 있으면 안 된다 — 일시·인적사항은
 * 이미 채워진 상태로 보여주고 AI 칸만 "분석 중"으로 둔다.
 *
 * 작업자가 읽어야 할 것이 위에 온다: 확인 질문 → 위험도 → 나머지 문서. 제출
 * 버튼은 하단 고정이라 스크롤 어디에서든 한 번의 터치로 끝낼 수 있다.
 *
 * 어떤 상태에서도 제출을 막지 않는다. 분석이 실패했든 칸이 비었든 확인 질문에
 * 답하지 않았든 제출된다 — 제출을 막으면 기록이 아예 남지 않고, 그게 이 제품이
 * 없애려는 원래 문제다.
 */
(function (global) {
  'use strict';

  const POLL_INTERVAL_MS = 1200;
  const POLL_TIMEOUT_MS = 180000; // 3분 — 그 전에 포기하면 느린 API에서 깨진다
  const MAX_PHOTOS = 2;

  let state = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function root() {
    return document.getElementById('draft-root');
  }

  async function fetchDraft(reportId) {
    const params = new URLSearchParams({ reporter_id: Profile.reporterId() });
    const res = await fetch(`/api/reports/${reportId}/draft?${params}`);
    if (!res.ok) throw new Error(`초안 조회 실패: ${res.status}`);
    return res.json();
  }

  // ---------- 확인 질문 ----------

  function questionsBlock(questions) {
    const wrap = el('section', 'confirm-questions');
    questions.forEach((question, index) => {
      const box = el('div', 'question');
      box.append(
        el('div', 'question-head', `확인 질문 ${index + 1}/${questions.length}`)
      );
      box.append(el('p', 'question-text', question));

      const row = el('div', 'question-row');
      const input = el('input', 'question-input');
      input.type = 'text';
      input.placeholder = '답을 적어주세요 (건너뛰어도 됩니다)';
      input.setAttribute('aria-label', question);

      const answer = el('button', 'btn-answer', '답하기');
      answer.type = 'button';
      const skip = el('button', 'btn-skip', '건너뛰기');
      skip.type = 'button';

      answer.addEventListener('click', () => {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        submitAnswer(question, value);
      });
      skip.addEventListener('click', () => box.remove());

      row.append(input, answer, skip);
      box.append(row);
      wrap.append(box);
    });
    return wrap;
  }

  async function submitAnswer(question, value) {
    const id = state.reportId;
    setBanner('답변을 반영해 다시 분석하고 있습니다…', 'working');
    try {
      await fetch(`/api/reports/${id}/draft`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: { [question]: value } }),
      });
      startPolling();
    } catch (err) {
      console.error(err);
      setBanner('답변을 보내지 못했습니다. 이대로 제출해도 됩니다.', 'failed');
    }
  }

  // ---------- 칸 수정 ----------

  async function saveField(name, value) {
    try {
      await fetch(`/api/reports/${state.reportId}/draft`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { [name]: value } }),
      });
      // 서버가 기억한 값을 화면 상태에도 반영해 둔다 — 재생성 때 잠길 칸이다.
      state.report.draft[name] = value;
      state.report.draft.sources = state.report.draft.sources || {};
      state.report.draft.sources[name] = 'user';
    } catch (err) {
      console.error(err);
      setBanner('수정 내용을 저장하지 못했습니다.', 'failed');
    }
  }

  // ---------- 사진 ----------

  function photoBlock() {
    const wrap = el('div', 'photo-attach');
    const count = (state.report.photos || []).length;

    const label = el('label', 'btn-photo');
    label.textContent =
      count >= MAX_PHOTOS ? `사진 ${count}/${MAX_PHOTOS} (최대)` : `사진 첨부 ${count}/${MAX_PHOTOS}`;

    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.className = 'photo-input';
    if (count >= MAX_PHOTOS) {
      input.disabled = true;
      label.classList.add('disabled');
    }

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      label.textContent = '올리는 중…';
      const body = new FormData();
      body.append('file', file);
      try {
        const res = await fetch(`/api/reports/${state.reportId}/photos`, {
          method: 'POST',
          body,
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.detail || `사진 업로드 실패: ${res.status}`);
        }
        const saved = await res.json();
        state.report.photos = (state.report.photos || []).concat([saved]);
        paint();
      } catch (err) {
        console.error(err);
        setBanner(err.message, 'failed');
        label.textContent = `사진 첨부 ${count}/${MAX_PHOTOS}`;
      }
    });

    label.append(input);
    wrap.append(label);
    return wrap;
  }

  // ---------- 상단 안내 배너 ----------

  function setBanner(text, kind) {
    const node = document.getElementById('draft-banner');
    if (!node) return;
    node.textContent = text || '';
    node.className = `draft-banner ${kind || ''}`.trim();
    node.hidden = !text;
  }

  function bannerForStatus(status) {
    if (!navigator.onLine) {
      return ['연결되면 자동으로 분석합니다. 이대로 제출해도 기록은 남습니다.', 'offline'];
    }
    if (status === 'draft' || status === 'analyzing') {
      return ['AI가 속보를 작성하고 있습니다…', 'working'];
    }
    if (status === 'failed') {
      return ['AI 분석에 실패했습니다. 다시 시도하거나 직접 채워 제출할 수 있습니다.', 'failed'];
    }
    return ['', ''];
  }

  // ---------- 화면 그리기 ----------

  function paint() {
    const container = root();
    if (!container) return;
    container.innerHTML = '';

    const [text, kind] = bannerForStatus(state.status);
    const banner = el('div', 'draft-banner');
    banner.id = 'draft-banner';
    container.append(banner);
    setBanner(text, kind);

    const draft = state.report.draft || {};
    const questions = Array.isArray(draft.questions) ? draft.questions : [];
    if (questions.length) container.append(questionsBlock(questions));

    if (state.status === 'failed') {
      const retry = el('button', 'btn-retry', '다시 분석');
      retry.type = 'button';
      retry.addEventListener('click', requestDraft);
      container.append(retry);
    }

    const docHost = el('div', 'draft-doc');
    container.append(docHost);
    BriefDoc.render(docHost, state.report, {
      editable: true,
      onFieldEdit: saveField,
    });

    container.append(photoBlock());

    // 아직 분석 중이면 AI 칸이 비어 있다는 걸 알려준다
    if (state.status === 'draft' || state.status === 'analyzing') {
      docHost.classList.add('is-analyzing');
    }

    const actions = el('div', 'draft-actions');
    const submit = el('button', 'btn-submit', '이대로 제출');
    submit.type = 'button';
    submit.addEventListener('click', finalSubmit);
    const back = el('button', 'btn-text', '나중에 하기');
    back.type = 'button';
    back.addEventListener('click', () => DraftView.close());
    actions.append(submit, back);
    container.append(actions);
  }

  // ---------- 폴링 ----------

  function stopPolling() {
    if (state && state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!state) return;
    state.pollStartedAt = Date.now();
    poll();
  }

  async function poll() {
    if (!state) return;
    if (!navigator.onLine) {
      // 오프라인에서는 폴링하지 않는다 — 실패 로그만 쌓인다.
      setBanner(...bannerForStatus(state.status));
      return;
    }
    try {
      const body = await fetchDraft(state.reportId);
      state.status = body.status;
      state.report.draft = body.draft || state.report.draft || {};
      state.report.draft.risk = body.risk ?? state.report.draft.risk;
      if (body.photos) state.report.photos = body.photos;
      paint();

      const settled = body.status === 'ready' || body.status === 'failed' ||
        body.status === 'submitted';
      if (settled) return;

      if (Date.now() - state.pollStartedAt > POLL_TIMEOUT_MS) {
        setBanner('분석이 오래 걸리고 있습니다. 이대로 제출해도 됩니다.', 'failed');
        return;
      }
      state.timer = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (err) {
      console.error(err);
      setBanner('상태를 확인하지 못했습니다. 이대로 제출해도 됩니다.', 'failed');
    }
  }

  async function requestDraft() {
    try {
      await fetch(`/api/reports/${state.reportId}/draft`, { method: 'POST' });
      startPolling();
    } catch (err) {
      console.error(err);
      setBanner('분석을 요청하지 못했습니다. 이대로 제출해도 됩니다.', 'failed');
    }
  }

  // ---------- 제출 ----------

  async function finalSubmit() {
    const id = state.reportId;
    try {
      const res = await fetch(`/api/reports/${id}/submit`, { method: 'POST' });
      if (!res.ok) throw new Error(`제출 실패: ${res.status}`);
      DraftView.close({ submitted: true });
    } catch (err) {
      console.error(err);
      setBanner('제출하지 못했습니다. 잠시 후 다시 눌러 주세요.', 'failed');
    }
  }

  // ---------- 공개 API ----------

  const DraftView = {
    /** 초안 화면을 열고 분석을 의뢰한다. 화면이 먼저, 분석이 나중이다. */
    async open(reportId, options) {
      const opts = options || {};
      state = {
        reportId,
        status: 'draft',
        report: { draft: {}, photos: [], reporter: null },
        timer: null,
        pollStartedAt: Date.now(),
        onClose: opts.onClose || null,
      };

      document.body.classList.add('draft-open');
      const panel = document.getElementById('draft-panel');
      if (panel) panel.hidden = false;
      window.scrollTo(0, 0);

      // 서버가 이미 아는 것부터 그린다(일시·인적사항) — 빈 화면을 보지 않게.
      if (navigator.onLine) {
        try {
          const body = await fetchDraft(reportId);
          state.status = body.status;
          state.report.draft = body.draft || {};
          if (body.risk) state.report.draft.risk = body.risk;
          // 재진입했을 때 자기가 첨부한 사진이 보여야 한다 — 안 보이면 이미
          // 2장인 줄 모르고 또 올리려 한다.
          if (body.photos) state.report.photos = body.photos;
        } catch (err) {
          console.warn('[니어미스] 초안 상태를 못 읽었습니다', err);
        }
      }
      paint();

      // 오프라인이면 분석을 요청하지 않는다 — 실패 메시지가 오프라인 안내를
      // 덮어써서 작업자가 무엇을 해야 하는지 알 수 없게 된다.
      if (!navigator.onLine) return;

      // 이미 분석이 끝난 건(재진입)이면 다시 의뢰하지 않는다 — Review Focus 5
      if (state.status === 'draft') {
        await requestDraft();
      } else if (state.status === 'analyzing') {
        startPolling();
      }
    },

    close(result) {
      stopPolling();
      const panel = document.getElementById('draft-panel');
      if (panel) panel.hidden = true;
      document.body.classList.remove('draft-open');
      const onClose = state && state.onClose;
      state = null;
      if (onClose) onClose(result || {});
    },

    /** 테스트·디버깅용 — 현재 상태를 들여다본다 */
    _state() {
      return state;
    },
  };

  global.DraftView = DraftView;
})(window);
