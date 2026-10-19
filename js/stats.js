/**
 * 통계 화면 렌더링 (외부 차트 라이브러리 없이 HTML/CSS로 그림)
 */
(function (global) {
  'use strict';

  const DAY = 86400000;
  const HOUR_BIN = 3; // 시간대 차트 구간 (시간)

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function fmt(n) {
    return n.toLocaleString('ko-KR');
  }

  // ---------- 조각들 ----------

  function card(title, subtitle) {
    const c = el('section', 'card stat-card');
    c.append(el('h3', 'card-title', title));
    if (subtitle) c.append(el('p', 'card-sub', subtitle));
    return c;
  }

  /** 접어둔 표 보기 (색에 의존하지 않고 값을 확인하는 경로) */
  function tableView(items) {
    const details = el('details', 'table-view');
    details.append(el('summary', null, '표로 보기'));
    const table = el('table');
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, '구분'), el('th', 'num', '건수'));
    thead.append(hr);
    const tbody = el('tbody');
    items.forEach((it) => {
      const tr = el('tr');
      tr.append(el('td', null, it.fullLabel || it.label), el('td', 'num', fmt(it.value)));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    details.append(table);
    return details;
  }

  function tiles(reports, now) {
    const today = startOfDay(now);
    const weekStart = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY); // 월요일 시작
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const count = (from) => reports.filter((r) => new Date(r.createdAt) >= from).length;

    const wrap = el('div', 'tiles');

    const hero = el('div', 'card tile tile-hero');
    hero.append(el('div', 'tile-label', '전체 신고'), el('div', 'tile-value', `${fmt(reports.length)}건`));
    wrap.append(hero);

    const row = el('div', 'tile-row');
    [
      ['오늘', count(today)],
      ['이번 주', count(weekStart)],
      ['이번 달', count(monthStart)],
    ].forEach(([label, value]) => {
      const t = el('div', 'card tile');
      t.append(el('div', 'tile-label', label), el('div', 'tile-value', `${fmt(value)}건`));
      row.append(t);
    });
    wrap.append(row);
    return wrap;
  }

  /** 세로 막대 차트 — 최댓값만 직접 표시, 나머지는 탭/호버 툴팁과 표로 확인 */
  function columnChart(items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const maxIndex = items.findIndex((i) => i.value === max);

    const chart = el('div', 'col-chart');
    const plot = el('div', 'col-plot');
    plot.append(el('div', 'grid-top')); // 최댓값 높이 (값은 가장 높은 막대 위에 표시)

    const labels = el('div', 'col-labels');
    const tip = el('div', 'chart-tip');
    tip.hidden = true;

    items.forEach((it, i) => {
      const col = el('div', 'col');
      col.tabIndex = 0;
      col.setAttribute('role', 'img');
      col.setAttribute('aria-label', `${it.fullLabel || it.label}: ${it.value}건`);

      const bar = el('div', 'bar');
      bar.style.height = `${(it.value / max) * 100}%`;
      col.append(bar);
      if (i === maxIndex && it.value > 0) {
        const v = el('span', 'bar-value', fmt(it.value));
        v.style.bottom = `calc(${(it.value / max) * 100}% + 2px)`;
        col.append(v);
      }

      const show = () => {
        tip.textContent = `${it.fullLabel || it.label} · ${fmt(it.value)}건`;
        tip.hidden = false;
        const center = col.offsetLeft + col.offsetWidth / 2;
        const half = tip.offsetWidth / 2;
        const left = Math.min(Math.max(center, half), chart.offsetWidth - half);
        tip.style.left = `${left}px`;
        chart.querySelectorAll('.col.active').forEach((c) => c.classList.remove('active'));
        col.classList.add('active');
      };
      const hide = () => {
        tip.hidden = true;
        col.classList.remove('active');
      };
      col.addEventListener('pointerenter', show);
      col.addEventListener('focus', show);
      col.addEventListener('click', show);
      col.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide());
      col.addEventListener('blur', hide);

      plot.append(col);
      labels.append(el('span', null, it.label));
    });

    chart.append(tip, plot, labels);
    return chart;
  }

  /** 가로 막대 차트 — 막대 끝에 값 표시 */
  function barChart(items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const list = el('div', 'hbar-chart');
    items.forEach((it) => {
      const row = el('div', 'hbar-row');
      row.append(el('span', 'hbar-label', it.label));
      const track = el('div', 'hbar-track');
      const bar = el('div', 'hbar');
      bar.style.width = `calc((100% - 40px) * ${it.value / max})`;
      track.append(bar, el('span', 'hbar-value', fmt(it.value)));
      row.append(track);
      list.append(row);
    });
    return list;
  }

  // ---------- 차트별 데이터 ----------

  function dailyItems(reports, now) {
    const today = startOfDay(now);
    const counts = new Map();
    reports.forEach((r) => {
      const key = startOfDay(r.createdAt).getTime();
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const items = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY);
      items.push({
        label: String(d.getDate()),
        fullLabel: `${d.getMonth() + 1}/${d.getDate()}`,
        value: counts.get(d.getTime()) || 0,
      });
    }
    return items;
  }

  function categoryItems(reports) {
    const counts = new Map(NearMissClassify.names.map((n) => [n, 0]));
    reports.forEach((r) => {
      const c = NearMissClassify.classify(r);
      counts.set(c, (counts.get(c) || 0) + 1);
    });
    return [...counts.entries()]
      .filter(([, v]) => v > 0)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }

  function hourlyItems(reports) {
    const bins = Array.from({ length: 24 / HOUR_BIN }, () => 0);
    reports.forEach((r) => {
      bins[Math.floor(new Date(r.createdAt).getHours() / HOUR_BIN)]++;
    });
    return bins.map((value, i) => {
      const from = i * HOUR_BIN;
      return { label: `${from}시`, fullLabel: `${from}~${from + HOUR_BIN}시`, value };
    });
  }

  // ---------- 화면 ----------

  function render(container, reports, { localOnly } = {}) {
    container.innerHTML = '';
    const now = new Date();

    if (localOnly) {
      container.append(el('div', 'notice', '아직 서버가 연결되지 않아 이 기기에서 신고한 내역만 집계합니다.'));
    }

    if (!reports.length) {
      container.append(el('p', 'empty-state', '아직 신고된 내역이 없습니다.'));
      return;
    }

    container.append(tiles(reports, now));

    const daily = dailyItems(reports, now);
    const c1 = card('일별 신고 건수', `최근 14일 (${daily[0].fullLabel} ~ ${daily[13].fullLabel})`);
    c1.append(columnChart(daily), tableView(daily));
    container.append(c1);

    const cats = categoryItems(reports);
    const c2 = card('유형별 신고', '신고 내용의 키워드로 추정한 유형');
    c2.append(barChart(cats), tableView(cats));
    container.append(c2);

    const hourly = hourlyItems(reports);
    const c3 = card('시간대별 신고', `신고 시각 기준, ${HOUR_BIN}시간 단위`);
    c3.append(columnChart(hourly), tableView(hourly));
    container.append(c3);
  }

  // 차트 밖을 누르면 툴팁 닫기 (모바일)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.col')) return;
    document.querySelectorAll('.chart-tip').forEach((t) => (t.hidden = true));
    document.querySelectorAll('.col.active').forEach((c) => c.classList.remove('active'));
  });

  global.NearMissStats = { render };
})(window);
