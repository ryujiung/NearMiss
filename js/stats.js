/**
 * 통계 화면 렌더링 (외부 차트 라이브러리 없이 HTML/CSS로 그림)
 *
 * 집계는 서버(`GET /api/stats`)가 한다. 이 모듈은 받은 수치를 그리기만 한다.
 *
 * 왜 클라이언트에서 집계하지 않는가: 통계 탭은 토큰 없이 열리고 남이 신고한
 * 건까지 집계한다. 집계를 여기서 하려면 전체 레코드를 받아야 하는데, 원문에는
 * 작업자가 말로 흘린 이름·소속이 섞여 있을 수 있다 — 아무에게나 전원의 신고
 * 내용이 내려가는 구조가 된다(사양 3.11).
 */
(function (global) {
  'use strict';

  const HOUR_BIN = 3; // 서버의 집계 구간과 같아야 한다

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
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

  function tiles(stats) {
    const wrap = el('div', 'tiles');

    const hero = el('div', 'card tile tile-hero');
    hero.append(
      el('div', 'tile-label', '전체 신고'),
      el('div', 'tile-value', `${fmt(stats.total)}건`)
    );
    wrap.append(hero);

    const row = el('div', 'tile-row');
    [
      ['오늘', stats.today],
      ['이번 주', stats.week],
      ['이번 달', stats.month],
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

  // ---------- 서버 집계를 차트 아이템 모양으로 ----------
  // 차트가 기대하는 모양은 { label, fullLabel?, value } 다. 서버가 주는 모양을
  // 그대로 쓰지 않는 이유는 축 레이블이 화면마다 다르기 때문이다.

  function dailyItems(daily) {
    return daily.map((d) => {
      const [, month, day] = d.date.split('-');
      return {
        label: String(Number(day)),
        fullLabel: `${Number(month)}/${Number(day)}`,
        value: d.value,
      };
    });
  }

  function categoryItems(category) {
    return category.map((c) => ({ label: c.label, value: c.value }));
  }

  function hourlyItems(hourly) {
    return hourly.map((h) => ({
      label: `${h.from}시`,
      fullLabel: `${h.from}~${h.to}시`,
      value: h.value,
    }));
  }

  function riskItems(risk) {
    return risk.map((r) => ({ label: r.label, value: r.value }));
  }

  // ---------- 화면 ----------

  function render(container, stats, options) {
    const opts = options || {};
    container.innerHTML = '';

    if (!stats || !stats.total) {
      container.append(el('p', 'empty-state', '아직 신고된 내역이 없습니다.'));
      return;
    }

    // 서버 없이 배포된 화면에서는 데모 데이터로 그린다. 실시간 집계로
    // 오해하지 않도록 밝혀 둔다.
    if (opts.demo) {
      container.append(
        el('p', 'stats-demo-note', '시연용 샘플 데이터입니다. 서버에 연결하면 실제 집계가 표시됩니다.')
      );
    }

    container.append(tiles(stats));

    const daily = dailyItems(stats.daily);
    const c1 = card(
      '일별 신고 건수',
      `최근 ${daily.length}일 (${daily[0].fullLabel} ~ ${daily[daily.length - 1].fullLabel})`
    );
    c1.append(columnChart(daily), tableView(daily));
    container.append(c1);

    // 위험도 분포 — 0건인 등급도 서버가 내려주므로 세 칸이 항상 보인다.
    // 사라지면 "아직 안 들어왔다"와 "집계에서 빠졌다"를 구분할 수 없다.
    const risk = riskItems(stats.risk);
    const c2 = card('위험도 분포', 'AI가 일관된 기준으로 1차 분류한 결과');
    c2.append(barChart(risk), tableView(risk));
    container.append(c2);

    const cats = categoryItems(stats.category);
    if (cats.length) {
      const c3 = card('유형별 신고', '신고 내용에서 추정한 사고 유형');
      c3.append(barChart(cats), tableView(cats));
      container.append(c3);
    }

    const hourly = hourlyItems(stats.hourly);
    const c4 = card('시간대별 신고', `신고 시각 기준, ${HOUR_BIN}시간 단위`);
    c4.append(columnChart(hourly), tableView(hourly));
    container.append(c4);

    if (opts.period) {
      container.append(
        el('p', 'stats-period-note', opts.period === 'week' ? '최근 7일 기준' : '최근 30일 기준')
      );
    }
  }

  // 차트 밖을 누르면 툴팁 닫기 (모바일)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.col')) return;
    document.querySelectorAll('.chart-tip').forEach((t) => (t.hidden = true));
    document.querySelectorAll('.col.active').forEach((c) => c.classList.remove('active'));
  });

  global.NearMissStats = { render };
})(window);
