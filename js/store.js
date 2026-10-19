/**
 * ReportStore: 신고 데이터 저장/조회
 *
 * 지금은 서버가 없어서 이 기기(localStorage)에만 저장합니다.
 * 백엔드 API가 준비되면 submit()과 fetchAll()만 바꾸면 신고 화면과 통계 화면이 그대로 동작합니다.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'nearmiss-reports';

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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 500)));
    } catch {
      /* 저장 실패해도 신고 자체에는 영향 없음 */
    }
  }

  global.ReportStore = {
    /**
     * 신고 전송
     * 예) await fetch('/api/near-miss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })
     */
    async submit(report) {
      console.log('[니어미스 신고]', report);
      saveLocal(report);
    },

    /** 이 기기에서 보낸 신고 (내 신고 내역) */
    myReports() {
      return loadLocal();
    },

    /**
     * 통계용 전체 신고
     * 예) return (await fetch('/api/near-miss')).json();
     */
    async fetchAll() {
      return loadLocal();
    },

    /** 서버 연동 전까지 true — 통계 화면에 '이 기기 기준' 안내를 띄움 */
    isLocalOnly: true,
  };
})(window);
