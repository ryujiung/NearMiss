/**
 * BriefDoc: 니어미스 속보 문서 렌더러
 *
 * 초안 화면(작업자)과 관리자 상세가 **같은 렌더러**를 쓴다. 작업자가 확인하고
 * 제출한 문서와 관리자가 받아보는 문서가 달라지면, 작업자는 자기가 무엇을 보냈는지
 * 모르게 된다.
 *
 * 칸 순서는 과제정의서 6장 속보 양식을 따른다. 위험도와 확인 질문이 위에 오도록
 * 배치해, 작업자가 그 둘만 보고 바로 제출 버튼을 누를 수 있게 한다(사양 3.2).
 *
 * AI가 채운 칸에는 표시를 붙인다. 원인 추정과 권장 조치는 AI의 가설이고, 사람이
 * 쓴 사실과 구분되지 않으면 안전 문서로서 위험하다.
 */
(function (global) {
  'use strict';

  const RISK_ORDER = { 상: 'high', 중: 'mid', 하: 'low' };

  const CAUSE_LABELS = [
    ['physical', '물리적/환경적'],
    ['process', '시스템/프로세스'],
    ['organizational', '조직적'],
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** 위험도 배지 — 색만으로 구분하지 않도록 글자를 함께 넣는다 */
  function riskBadge(risk) {
    const level = RISK_ORDER[risk];
    const badge = el('span', `risk-badge risk-${level || 'none'}`);
    badge.textContent = level ? `위험도 ${risk}` : '미분류';
    return badge;
  }

  /** AI가 채운 칸임을 알리는 표시 */
  function aiMark() {
    const mark = el('span', 'ai-mark', 'AI');
    mark.title = 'AI가 채운 칸입니다. 확인하고 고칠 수 있습니다.';
    return mark;
  }

  function sourceOf(draft, field) {
    return (draft.sources && draft.sources[field]) || null;
  }

  /**
   * 한 칸을 그린다.
   * editable이면 contenteditable로 만들고, 고치는 순간 AI 표시를 떼고
   * onFieldEdit을 부른다 — 화면 표시와 저장된 출처가 어긋나지 않게 한다.
   */
  function field(draft, name, label, value, opts) {
    const row = el('div', 'doc-field');
    const head = el('div', 'doc-label');
    head.append(document.createTextNode(label));
    if (sourceOf(draft, name) === 'ai') head.append(aiMark());
    row.append(head);

    const body = el('div', 'doc-value');
    const text = value == null || value === '' ? '' : String(value);
    // 빈 칸을 숨기지 않는다 — 관리자가 무엇이 비었는지 알아야 한다.
    body.textContent = text || '미기재';
    if (!text) body.classList.add('doc-empty');

    if (opts.editable) {
      body.setAttribute('contenteditable', 'true');
      body.setAttribute('role', 'textbox');
      body.setAttribute('aria-label', label);
      body.classList.add('doc-editable');
      body.addEventListener('focus', () => {
        if (!text && body.textContent === '미기재') body.textContent = '';
        body.classList.remove('doc-empty');
      });
      body.addEventListener('blur', () => {
        const next = body.textContent.trim();
        if (next === (text || '')) return;
        head.querySelectorAll('.ai-mark').forEach((m) => m.remove());
        if (opts.onFieldEdit) opts.onFieldEdit(name, next);
      });
    }

    row.append(body);
    return row;
  }

  /** 목록형 칸 (발생개요, 재발방지 대책) */
  function listField(draft, name, label, items, opts, note) {
    const row = el('div', 'doc-field');
    const head = el('div', 'doc-label');
    head.append(document.createTextNode(label));
    if (sourceOf(draft, name) === 'ai') head.append(aiMark());
    row.append(head);
    if (note) row.append(el('p', 'doc-note', note));

    const lines = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!lines.length) {
      const empty = el('div', 'doc-value doc-empty', '미기재');
      row.append(empty);
      return row;
    }

    const list = el('ul', 'doc-list');
    lines.forEach((line) => list.append(el('li', null, line)));
    row.append(list);

    if (opts.editable) {
      // 목록은 줄 단위로 고치게 한다 — 한 줄에 여러 항목을 쓰면 양식이 깨진다.
      list.setAttribute('contenteditable', 'true');
      list.classList.add('doc-editable');
      list.setAttribute('aria-label', label);
      list.addEventListener('blur', () => {
        const next = [...list.querySelectorAll('li')]
          .map((li) => li.textContent.trim())
          .filter(Boolean);
        if (next.join('\n') === lines.join('\n')) return;
        head.querySelectorAll('.ai-mark').forEach((m) => m.remove());
        if (opts.onFieldEdit) opts.onFieldEdit(name, next);
      });
    }

    return row;
  }

  function causesBlock(draft, opts) {
    const row = el('div', 'doc-field');
    const head = el('div', 'doc-label');
    head.append(document.createTextNode('발생원인'));
    if (sourceOf(draft, 'causes') === 'ai') head.append(aiMark());
    row.append(head);
    row.append(el('p', 'doc-note', 'AI가 추정한 내용입니다. 확인 후 고쳐 주세요.'));

    const causes = draft.causes || {};
    CAUSE_LABELS.forEach(([key, label]) => {
      const line = el('div', 'cause-line');
      line.append(el('span', 'cause-tag', `[${label}]`));
      const value = el('span', 'cause-text');
      const text = causes[key] || '';
      value.textContent = text || '미기재';
      if (!text) value.classList.add('doc-empty');
      if (opts.editable) {
        value.setAttribute('contenteditable', 'true');
        value.classList.add('doc-editable');
        value.setAttribute('aria-label', `발생원인 ${label}`);
        value.addEventListener('blur', () => {
          const next = value.textContent.trim();
          if (next === text) return;
          head.querySelectorAll('.ai-mark').forEach((m) => m.remove());
          if (opts.onFieldEdit) {
            opts.onFieldEdit('causes', { ...causes, [key]: next });
          }
        });
      }
      line.append(value);
      row.append(line);
    });

    return row;
  }

  function photosBlock(report) {
    const photos = report.photos || [];
    if (!photos.length) return null;
    const row = el('div', 'doc-field');
    row.append(el('div', 'doc-label', '사진'));
    const grid = el('div', 'doc-photos');
    photos.forEach((photo, index) => {
      const img = el('img');
      img.src = photo.url;
      img.alt = `첨부 사진 ${index + 1}`;
      img.loading = 'lazy';
      grid.append(img);
    });
    row.append(grid);
    return row;
  }

  /**
   * 인적사항 — 서버가 만든 identity_line을 그대로 쓴다.
   * 마스킹 구현을 JS에 또 두면 서버와 어긋난다(사양 3.4).
   */
  function identityText(report, showRealName) {
    if (showRealName && report.realName) {
      const r = report.realName;
      const count = r.count > 1 ? ` 등 ${r.count}명` : '';
      return `${r.name}${count}`;
    }
    if (report.identity_line) return report.identity_line;
    const reporter = report.reporter;
    if (!reporter) return '';
    const count = reporter.count > 1 ? ` 등 ${reporter.count}명` : '';
    return `${reporter.name || ''}${count}`.trim();
  }

  function render(container, report, options) {
    const opts = Object.assign(
      { editable: false, onFieldEdit: null, showRealName: false },
      options || {}
    );
    const draft = report.draft || {};

    container.innerHTML = '';
    const doc = el('article', 'brief-doc');

    // 제목
    const title = el('h2', 'doc-title', draft.title || '니어미스 속보');
    doc.append(title);

    // 위험도 + 근거 — 작업자가 이것만 보고 제출할 수 있어야 한다
    const riskRow = el('div', 'doc-risk');
    riskRow.append(riskBadge(draft.risk));
    if (draft.category) riskRow.append(el('span', 'doc-category', draft.category));
    doc.append(riskRow);
    if (draft.risk_reason) {
      const reason = el('p', 'doc-risk-reason', draft.risk_reason);
      if (sourceOf(draft, 'risk') === 'ai') reason.append(aiMark());
      doc.append(reason);
    }

    const photos = photosBlock(report);
    if (photos) doc.append(photos);

    doc.append(field(draft, 'occurred_at', '일시', draft.occurred_at, opts));
    doc.append(field(draft, 'location', '장소', draft.location, opts));

    // 인적사항
    const identity = el('div', 'doc-field');
    identity.append(el('div', 'doc-label', '인적사항'));
    const idBody = el('div', 'doc-value');
    const reporter = report.reporter || {};
    const parts = [
      reporter.org ? `소속 ${reporter.org}` : '',
      identityText(report, opts.showRealName) ? `성명 ${identityText(report, opts.showRealName)}` : '',
      reporter.role ? `직무 ${reporter.role}` : '',
      '재해 정도 無',
    ].filter(Boolean);
    idBody.textContent = parts.length > 1 ? parts.join(' · ') : '미기재';
    if (parts.length <= 1) idBody.classList.add('doc-empty');
    identity.append(idBody);
    doc.append(identity);

    doc.append(
      listField(draft, 'overview', '발생개요', draft.overview, opts)
    );
    doc.append(causesBlock(draft, opts));
    doc.append(
      listField(
        draft,
        'countermeasures',
        '재발방지 대책 및 대응계획',
        draft.countermeasures,
        opts,
        'AI가 제안한 내용입니다. 확인 후 고쳐 주세요.'
      )
    );

    container.append(doc);
  }

  /**
   * 속보 양식 그대로의 읽기 전용 문서 (보고서 미리보기·PDF용).
   *
   * 상단 바 → 제목 → 사진 2칸 → 일시·장소 → 인적사항 → 발생개요 → 발생원인 →
   * 재발방지 대책 순서. 빈 칸은 숨기지 않고 '입력 필요'로 둔다 — 무엇을 채워야
   * 하는지 보여야 한다. opts.mark는 자동으로 채운 칸에 붙일 표시 글자다.
   */
  function renderSheet(container, report, options) {
    const opts = Object.assign({ mark: 'AI', profile: null }, options || {});
    const draft = report.draft || {};
    const NEED = '입력 필요';

    const mark = () => {
      const node = el('span', 'sheet-mark', opts.mark);
      node.title = '자동으로 채운 칸입니다. 확인 후 고쳐 주세요.';
      return node;
    };
    const line = (label, value) => {
      const p = el('p', 'sheet-line');
      p.append(el('b', null, `${label} : `));
      const v = el('span', value ? null : 'sheet-need', value || NEED);
      p.append(v);
      return p;
    };
    const section = (title, withMark) => {
      const sec = el('section', 'sheet-section');
      const h = el('h4', 'sheet-heading', title);
      if (withMark) h.append(mark());
      sec.append(h);
      return sec;
    };

    container.innerHTML = '';
    const sheet = el('article', 'brief-sheet');
    sheet.append(el('div', 'sheet-bar', '니어미스 속보 초안'));
    const body = el('div', 'sheet-body');

    body.append(el('h3', 'sheet-title', draft.title || '○○공장 니어미스 속보'));

    const photos = report.photos || [];
    const grid = el('div', 'sheet-photos');
    [0, 1].forEach((i) => {
      if (photos[i]) {
        const img = el('img');
        img.src = photos[i].url;
        img.alt = `첨부 사진 ${i + 1}`;
        grid.append(img);
      } else {
        grid.append(el('div', 'sheet-photo-empty', `사진 ${i + 1}`));
      }
    });
    body.append(grid);

    const when = global.AutoDraft ? AutoDraft.formatOccurred(draft.occurred_at) : draft.occurred_at;
    const head = el('div', 'sheet-head');
    head.append(line('일시', when), line('장소', draft.location));
    body.append(head);

    // 인적사항: 서버가 준 값(마스킹됨) → 이 기기의 프로필 순으로 쓴다
    const reporter = report.reporter || opts.profile || {};
    const name = identityText(report, false) || reporter.name || '';
    const person = section('인적사항', false);
    person.append(
      line('소속', reporter.org),
      line('성명', name),
      line('직무', reporter.role),
      line('재해 정도', '無')
    );
    body.append(person);

    const overview = section('발생개요', sourceOf(draft, 'overview') !== 'user');
    const lines = (draft.overview || []).filter(Boolean);
    if (lines.length) lines.forEach((t) => overview.append(el('p', 'sheet-text', t)));
    else overview.append(el('p', 'sheet-need', NEED));
    body.append(overview);

    const causes = section('발생원인', sourceOf(draft, 'causes') !== 'user');
    const c = draft.causes || {};
    CAUSE_LABELS.forEach(([key, label]) => {
      const p = el('p', 'sheet-text');
      p.append(el('span', 'sheet-tag', `[${label}]`));
      p.append(document.createTextNode(` ${c[key] || NEED}`));
      causes.append(p);
    });
    body.append(causes);

    const measures = section('재발방지 대책', sourceOf(draft, 'countermeasures') !== 'user');
    const items = (draft.countermeasures || []).filter(Boolean);
    if (items.length) {
      const ul = el('ul', 'sheet-list');
      items.forEach((t) => ul.append(el('li', null, t)));
      measures.append(ul);
    } else {
      measures.append(el('p', 'sheet-need', NEED));
    }
    body.append(measures);

    sheet.append(body);
    container.append(sheet);
  }

  global.BriefDoc = { render, renderSheet, riskBadge };
})(window);
