/**
 * 신고 원문에서 사고 유형을 추정 (키워드 기반 임시 분류)
 *
 * 서버에서 AI로 항목을 뽑아 report.category를 채우게 되면 그 값을 우선 사용합니다.
 * 키워드가 가장 많이 맞은 유형을 고르고, 같으면 목록에서 앞에 있는 유형을 고릅니다.
 */
(function (global) {
  'use strict';

  const OTHER = '기타';

  const CATEGORIES = [
    ['추락/넘어짐', ['미끄러', '넘어', '걸려', '헛디', '추락', '사다리', '비계', '계단', '떨어질']],
    ['끼임/협착', ['끼일', '끼임', '끼어', '끼었', '협착', '말려', '감길', '감겨', '롤러']],
    ['충돌/부딪힘', ['부딪', '충돌', '지게차', '차량', '치일', '받힐']],
    ['낙하/비래', ['낙하', '떨어져', '떨어졌', '떨어지는', '날아', '튀어', '비래']],
    ['감전', ['감전', '전기', '누전', '전선', '스파크', '합선']],
    ['화재/폭발', ['화재', '폭발', '불이', '불꽃', '불티', '연기', '타는 냄새']],
    ['화학물질 노출', ['화학', '약품', '가스', '유해', '독성', '증기']],
  ];

  function classify(report) {
    if (report.category) return report.category;
    const text = report.content || report.description || '';
    let best = OTHER;
    let bestScore = 0;
    for (const [name, keywords] of CATEGORIES) {
      const score = keywords.filter((k) => text.includes(k)).length;
      if (score > bestScore) {
        best = name;
        bestScore = score;
      }
    }
    return best;
  }

  global.NearMissClassify = {
    classify,
    names: CATEGORIES.map(([name]) => name).concat(OTHER),
  };
})(window);
