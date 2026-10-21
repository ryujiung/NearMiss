/**
 * Profile: 신고자 프로필과 기기 식별자
 *
 * 정의서 6장 속보 양식의 인적사항(소속·성명·직무)을 한 번만 저장해 두고, 이후
 * 신고마다 입력 0회로 쓴다 — "현장에서 1분 이내"를 지키려면 매번 칸을 채우게 할
 * 수 없다.
 *
 * reporterId는 인증이 아니라 '이 기기' 식별자다. "내 신고 내역"을 서버에서
 * 골라오는 데에만 쓰고, 이것으로 권한을 판단하지 않는다 — 남의 건을 보려면
 * 관리자 토큰이 필요하다.
 */
(function (global) {
  'use strict';

  const KEY_DEVICE = 'nearmiss-device-id';
  const KEY_PROFILE = 'nearmiss-profile';
  const KEY_ADMIN = 'nearmiss-admin-token';

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 사생활 보호 모드 등으로 저장이 막혀도 앱 자체는 계속 동작해야 한다 */
    }
  }

  function newId() {
    // crypto.randomUUID는 보안 컨텍스트에서만 제공된다. 데모는 localhost라
    // 문제가 없지만, 없을 때도 앱이 멈추지 않도록 대체 경로를 둔다.
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return `dev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  global.Profile = {
    /** 이 기기의 식별자 (없으면 만들어 보관) */
    reporterId() {
      let id = read(KEY_DEVICE);
      if (!id) {
        id = newId();
        write(KEY_DEVICE, id);
      }
      return id;
    },

    /** 저장된 신고자 프로필 — 아직 입력 전이면 null */
    get() {
      try {
        const raw = read(KEY_PROFILE);
        if (!raw) return null;
        const profile = JSON.parse(raw);
        // 하나라도 채워져 있으면 쓸 수 있는 프로필로 본다 — 세 칸을 모두
        // 강요하면 설정 화면이 또 하나의 양식이 된다.
        return profile.org || profile.name || profile.role ? profile : null;
      } catch {
        return null;
      }
    },

    save(profile) {
      write(
        KEY_PROFILE,
        JSON.stringify({
          org: (profile.org || '').trim(),
          name: (profile.name || '').trim(),
          role: (profile.role || '').trim(),
        })
      );
    },

    /** 관리자 탭 진입용 토큰 (설정에서 한 번 입력해 보관) */
    adminToken() {
      return read(KEY_ADMIN) || '';
    },

    saveAdminToken(token) {
      write(KEY_ADMIN, (token || '').trim());
    },

    /** 모든 요청에 붙일 기기 식별 헤더.

     * 인증이 아니라 "누구 건인가"를 가리는 값이다. 서버가 자기 건이 아닌 신고의
     * 수정·제출·사진 업로드를 막는 데 쓴다.
     */
    ownerHeaders() {
      return { 'X-Reporter-Id': this.reporterId() };
    },

    /** 관리자 요청에 붙일 헤더 — 토큰이 없으면 빈 객체 */
    adminHeaders() {
      const token = this.adminToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  };
})(window);
