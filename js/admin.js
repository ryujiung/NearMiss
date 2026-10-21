/**
 * AdminView: 관리자 탭
 *
 * 작업자 화면과 같은 앱의 세 번째 탭이다 — 별도 앱을 만들지 않는다. 데모에서
 * 화면 전환이 끊기지 않는 편이 낫고, 속보 문서도 같은 렌더러(BriefDoc)를 쓰기
 * 때문에 작업자가 확인한 것과 관리자가 받는 것이 같다.
 *
 * 실명은 `실명 보기` 토글이 `/identity`를 부를 때만 받아온다. 목록과 상세는
 * 마스킹된 값만 담고 있으므로, 토글을 켜지 않으면 실명은 브라우저에 오지도
 * 않는다(사양 3.4).
 */
(function (global) {
  'use strict';

  const STATUS_FILTERS = [
    ['', '전체'],
    ['submitted', '제출됨'],
    ['failed', '미분류'],
  ];
  const RISK_FILTERS = [['', '전체'], ['상', '상'], ['중', '중'], ['하', '하']];
  const PERIOD_FILTERS = [['', '전체 기간'], ['week', '최근 7일'], ['month', '최근 30일']];

  let filters = { risk: '', status: '', period: '' };
  let openDetailId = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function root() {
    return document.getElementById('admin-root');
  }

  async function api(path) {
    const res = await fetch(path, { headers: Profile.adminHeaders() });
    if (res.status === 401) throw new Error('unauthorized');
    if (!res.ok) throw new Error(`요청 실패: ${res.status}`);
    return res.json();
  }

  async function post(path) {
    const res = await fetch(path, { method: 'POST', headers: Profile.adminHeaders() });
    if (!res.ok) throw new Error(`요청 실패: ${res.status}`);
    return res.json().catch(() => ({}));
  }

  function formatWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------- 토큰이 없을 때 ----------

  function tokenPrompt(container) {
    const box = el('div', 'notice');
    box.append(
      el('p', null, '관리자 토큰이 필요합니다. 신고하기 탭의 "내 정보 · 설정"에서 토큰을 입력해 주세요.')
    );
    const go = el('button', 'btn-secondary', '설정으로 이동');
    go.type = 'button';
    go.addEventListener('click', () => {
      document.getElementById('tab-btn-report').click();
      const settings = document.getElementById('settings');
      if (settings) {
        settings.open = true;
        settings.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    box.append(go);
    container.append(box);
  }

  // ---------- 미확인 고위험 배너 ----------

  function ackBanner(pending, onOpen) {
    const banner = el('div', 'ack-banner');
    banner.append(
      el('strong', null, `미확인 고위험 ${pending.length}건`),
      el('span', 'ack-sub', '위험도 상으로 분류되었고 아직 확인하지 않은 신고입니다.')
    );
    const list = el('ul', 'ack-list');
    pending.forEach((report) => {
      const li = el('li');
      const link = el('button', 'ack-link');
      link.type = 'button';
      const where = (report.draft && report.draft.location) || '장소 미기재';
      link.textContent = `${formatWhen(report.created_at)} · ${where}`;
      link.addEventListener('click', () => onOpen(report.id));
      li.append(link);
      list.append(li);
    });
    banner.append(list);
    return banner;
  }

  // ---------- 필터 ----------

  function filterBar(onChange) {
    const bar = el('div', 'admin-toolbar');

    function group(label, options, key) {
      const wrap = el('div', 'filter-group');
      wrap.append(el('span', 'filter-label', label));
      const row = el('div', 'filter-row');
      options.forEach(([value, text]) => {
        const btn = el('button', 'filter-btn', text);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(filters[key] === value));
        if (filters[key] === value) btn.classList.add('active');
        btn.addEventListener('click', () => {
          filters[key] = value;
          onChange();
        });
        row.append(btn);
      });
      wrap.append(row);
      return wrap;
    }

    bar.append(group('위험도', RISK_FILTERS, 'risk'));
    bar.append(group('상태', STATUS_FILTERS, 'status'));
    bar.append(group('기간', PERIOD_FILTERS, 'period'));
    return bar;
  }

  // ---------- 목록 ----------

  function riskCell(report) {
    if (report.status === 'failed' || !report.risk) {
      const badge = el('span', 'risk-badge risk-none', '미분류');
      return badge;
    }
    return BriefDoc.riskBadge(report.risk);
  }

  function listRow(report, onOpen) {
    const row = el('li', 'admin-row');
    const head = el('div', 'admin-row-head');
    head.append(riskCell(report));
    if (report.category) head.append(el('span', 'doc-category', report.category));
    head.append(el('span', 'admin-when', formatWhen(report.created_at)));
    row.append(head);

    const where = (report.draft && report.draft.location) || '장소 미기재';
    row.append(el('div', 'admin-where', where));
    // 원문 앞부분 — 관리자가 목록에서 무슨 일인지 짐작할 수 있어야 한다
    row.append(el('div', 'admin-excerpt', (report.content || '').slice(0, 70)));

    const actions = el('div', 'admin-row-actions');
    const open = el('button', 'btn-row', '속보 보기');
    open.type = 'button';
    open.addEventListener('click', () => onOpen(report.id));
    actions.append(open);

    if (report.status === 'failed') {
      const retry = el('button', 'btn-row btn-row-warn', '다시 분석');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        retry.textContent = '분석 중…';
        try {
          await post(`/api/reports/${report.id}/draft`);
          setTimeout(render, 2500);
        } catch (err) {
          console.error(err);
          retry.disabled = false;
          retry.textContent = '다시 분석';
        }
      });
      actions.append(retry);
    }

    row.append(actions);
    return row;
  }

  // ---------- 속보 상세 ----------

  async function detail(container, reportId) {
    const panel = el('section', 'admin-detail');
    const bar = el('div', 'admin-detail-bar');

    const back = el('button', 'btn-text', '← 목록으로');
    back.type = 'button';
    back.addEventListener('click', () => {
      openDetailId = null;
      render();
    });

    const nameToggle = el('button', 'btn-row', '실명 보기');
    nameToggle.type = 'button';
    nameToggle.setAttribute('aria-pressed', 'false');

    const print = el('button', 'btn-row', '인쇄 / PDF');
    print.type = 'button';
    print.addEventListener('click', () => window.print());

    bar.append(back, nameToggle, print);
    panel.append(bar);

    const docHost = el('div', 'admin-doc');
    panel.append(docHost);
    container.append(panel);

    const report = await api(`/api/reports/${reportId}`);
    let showRealName = false;

    function paint() {
      BriefDoc.render(docHost, report, { editable: false, showRealName });
    }
    paint();

    nameToggle.addEventListener('click', async () => {
      if (!showRealName && !report.realName) {
        // 실명은 토글을 켤 때만 받아온다 — 켜지 않으면 브라우저에 오지도 않는다.
        try {
          report.realName = await api(`/api/reports/${reportId}/identity`);
        } catch (err) {
          console.error(err);
          return;
        }
      }
      showRealName = !showRealName;
      nameToggle.textContent = showRealName ? '실명 가리기' : '실명 보기';
      nameToggle.setAttribute('aria-pressed', String(showRealName));
      paint();
    });

    // 상세를 열어보면 확인 처리한다(사양 3.6) — 미확인 큐에서 빠진다.
    if (report.risk === '상') {
      post(`/api/reports/${reportId}/acknowledge`).catch((err) => console.warn(err));
    }
  }

  // ---------- 주간·월간 집계 ----------

  async function aggregate(container) {
    const card = el('section', 'card stat-card');
    card.append(el('h3', 'card-title', '기간별 집계'));
    const toggle = el('div', 'filter-row');
    const host = el('div');

    async function load(period) {
      const params = period ? `?period=${period}` : '';
      const stats = await fetch(`/api/stats${params}`).then((r) => r.json());
      NearMissStats.render(host, stats, { period });
    }

    [['week', '주간'], ['month', '월간']].forEach(([value, label], index) => {
      const btn = el('button', 'filter-btn', label);
      btn.type = 'button';
      if (index === 0) btn.classList.add('active');
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        load(value);
      });
      toggle.append(btn);
    });

    card.append(toggle, host);
    container.append(card);
    await load('week');
  }

  // ---------- 화면 ----------

  async function render() {
    const container = root();
    if (!container) return;
    container.innerHTML = '';

    if (!Profile.adminToken()) {
      tokenPrompt(container);
      return;
    }

    if (openDetailId) {
      try {
        await detail(container, openDetailId);
      } catch (err) {
        console.error(err);
        container.innerHTML = '';
        if (err.message === 'unauthorized') tokenPrompt(container);
        else container.append(el('p', 'empty-state', '속보를 불러오지 못했습니다.'));
      }
      return;
    }

    const openDetail = (id) => {
      openDetailId = id;
      render();
      window.scrollTo(0, 0);
    };

    try {
      const pending = await api('/api/reports/unacknowledged');
      if (pending.length) container.append(ackBanner(pending, openDetail));

      container.append(filterBar(render));

      const params = new URLSearchParams();
      if (filters.risk) params.set('risk', filters.risk);
      if (filters.status) params.set('status', filters.status);
      if (filters.period) params.set('period', filters.period);
      const query = params.toString() ? `?${params}` : '';
      const reports = await api(`/api/reports${query}`);

      const count = el('p', 'admin-count', `${reports.length}건`);
      container.append(count);

      if (!reports.length) {
        container.append(el('p', 'empty-state', '조건에 맞는 신고가 없습니다.'));
      } else {
        const list = el('ul', 'admin-list');
        reports.forEach((report) => list.append(listRow(report, openDetail)));
        container.append(list);
      }

      await aggregate(container);
    } catch (err) {
      console.error(err);
      container.innerHTML = '';
      if (err.message === 'unauthorized') {
        const box = el('div', 'notice', '관리자 토큰이 올바르지 않습니다. 설정에서 다시 확인해 주세요.');
        container.append(box);
        tokenPrompt(container);
      } else {
        container.append(el('p', 'empty-state', '목록을 불러오지 못했습니다.'));
      }
    }
  }

  global.AdminView = {
    render,
    /** 테스트·디버깅용 */
    _filters: () => filters,
    _reset() {
      filters = { risk: '', status: '', period: '' };
      openDetailId = null;
    },
  };
})(window);
