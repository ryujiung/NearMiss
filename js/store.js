/**
 * ReportStore: 신고 데이터 저장/조회
 *
 * 서버(FastAPI)와 통신한다. 관리자 화면이 남이 신고한 건을 봐야 하므로
 * localStorage만으로는 성립하지 않는다.
 *
 * 오프라인 대응(사양 3.7): 전송이 실패하면 localStorage 큐에 넣고 "전송 대기 중"
 * 으로 표시한다. online 이벤트와 앱 시작 시 큐를 비운다. 큐 항목은 처음 만든
 * client_uuid를 그대로 들고 가므로, 재전송 중 응답을 못 받아 두 번 보내더라도
 * 서버가 멱등으로 거른다.
 *
 * 사진은 큐에 넣지 않는다 — 휴대폰 사진 2장을 base64로 넣으면 localStorage
 * 할당량(약 5MB)을 바로 넘긴다. 사진 첨부는 온라인 초안 화면에서만 제공한다.
 *
 * API는 상대 경로로만 부른다. 호스트·포트를 하드코딩하면 나중에 실기기나 터널로
 * 열 때 깨진다.
 */
(function (global) {
  'use strict';

  const QUEUE_KEY = 'nearmiss-queue';
  const CACHE_KEY = 'nearmiss-cache';

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 저장 실패해도 진행 자체를 막지는 않는다 */
    }
  }

  function queue() {
    return readJson(QUEUE_KEY, []);
  }

  function setQueue(list) {
    writeJson(QUEUE_KEY, list);
  }

  function newUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `q-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  /** 서버로 한 건 전송. 성공하면 서버가 준 id를 돌려준다. */
  async function postReport(payload) {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`신고 전송 실패: ${res.status}`);
    return res.json();
  }

  global.ReportStore = {
    /**
     * 신고 전송. 실패하면 큐에 넣고 {queued: true}를 돌려준다.
     * 어떤 경우에도 원문을 잃지 않는다 — 신고 유실이 가장 나쁜 결과다.
     */
    async submit(report) {
      const profile = Profile.get();
      const payload = {
        client_uuid: newUuid(),
        content: report.content,
        reporter_id: Profile.reporterId(),
        created_at: report.createdAt || new Date().toISOString(),
      };
      if (profile) payload.reporter = { ...profile, count: 1 };

      try {
        const saved = await postReport(payload);
        return { id: saved.id, queued: false };
      } catch (err) {
        console.warn('[니어미스] 전송 실패 — 큐에 보관합니다', err);
        setQueue(queue().concat([payload]));
        return { id: null, queued: true };
      }
    },

    /** 이 기기에서 보낸 신고. 서버가 안 되면 마지막으로 받아둔 캐시를 돌려준다. */
    async myReports() {
      const params = new URLSearchParams({ reporter_id: Profile.reporterId() });
      try {
        const res = await fetch(`/api/reports/mine?${params}`);
        if (!res.ok) throw new Error(`내역 조회 실패: ${res.status}`);
        const list = await res.json();
        writeJson(CACHE_KEY, list);
        return list.concat(this.pendingReports());
      } catch (err) {
        console.warn('[니어미스] 내역 조회 실패 — 캐시를 씁니다', err);
        return readJson(CACHE_KEY, []).concat(this.pendingReports());
      }
    },

    /** 아직 전송되지 않은 건 — 내역에 "전송 대기 중"으로 함께 보여준다 */
    pendingReports() {
      return queue().map((payload) => ({
        id: null,
        status: 'pending',
        content: payload.content,
        created_at: payload.created_at,
        risk: null,
        category: null,
        draft: null,
      }));
    },

    pendingCount() {
      return queue().length;
    },

    /** 큐를 순서대로 비운다. 보낸 건수를 돌려준다. */
    async flushQueue() {
      const pending = queue();
      if (!pending.length) return 0;

      let sent = 0;
      const remaining = [];
      for (const payload of pending) {
        if (remaining.length) {
          // 한 건이 실패하면 뒤 건들은 그대로 둔다 — 순서를 지킨다.
          remaining.push(payload);
          continue;
        }
        try {
          await postReport(payload);
          sent += 1;
        } catch (err) {
          console.warn('[니어미스] 재전송 실패 — 큐에 남깁니다', err);
          remaining.push(payload);
        }
      }
      setQueue(remaining);
      return sent;
    },
  };
})(window);
