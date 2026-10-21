/**
 * AutoDraft: AI 없이 신고 원문에서 속보 초안을 만드는 규칙 기반 생성기
 *
 * LLM API를 쓸 수 없는 환경(키 없음, 서버 없는 정적 배포)에서도 보고서 미리보기가
 * 속보 양식으로 채워지게 한다. 서버 초안과 같은 모양의 객체를 돌려주므로 렌더러는
 * 출처를 가리지 않는다.
 *
 * 원문에서 직접 읽는 칸: 일시, 장소, 사고 유형, 발생개요.
 * 사고 유형별 템플릿으로 채우는 칸: 발생원인 3종, 재발방지 대책 — 문장 속 대상
 * (예: 출입문, 난간)과 장소만 원문에서 끼워 넣는다. 상황을 이해한 결과가 아니므로
 * 화면에서는 '자동' 표시를 붙여 사람이 확인하게 한다.
 */
(function (global) {
  'use strict';

  const OTHER = '기타';

  // 키워드가 가장 많이 맞은 유형을 고른다. 같으면 앞에 있는 유형.
  const CATEGORY_KEYWORDS = [
    ['추락/넘어짐', ['미끄러', '넘어', '걸려', '헛디', '추락', '사다리', '비계', '계단', '떨어질', '난간', '발을 헛']],
    ['끼임/협착', ['끼일', '끼임', '끼어', '끼었', '끼일', '협착', '말려', '감길', '감겨', '롤러', '금형']],
    ['충돌/부딪힘', ['부딪', '충돌', '지게차', '차량', '치일', '받힐', '접촉']],
    ['낙하/비래', ['낙하', '떨어져', '떨어졌', '떨어지는', '날아', '튀어', '비래', '탈락', '전도', '쓰러', '무너', '붕괴']],
    ['감전', ['감전', '누전', '전선', '스파크', '합선', '충전부', '배전반', '피복']],
    ['화재/폭발', ['화재', '폭발', '불이', '불꽃', '불티', '연기', '타는 냄새', '발화']],
    ['화학물질 노출', ['화학', '약품', '가스', '유해', '독성', '증기', '누출', '흄']],
  ];

  // 원인·대책 문장에 끼워 넣을 대상. 앞에 있을수록 구체적이라 먼저 고른다.
  const OBJECTS = [
    '출입문', '난간', '발판', '사다리', '비계', '프레스', '금형', '롤러', '컨베이어',
    '체인', '벨트', '크레인', '호이스트', '지게차', '차량', '전선', '케이블', '배전반',
    '분전반', '콘센트', '배관', '밸브', '호스', '탱크', '용기', '덮개', '커버', '후드',
    '계단', '문', '설비',
  ];

  const TEMPLATES = {
    '추락/넘어짐': {
      causes: {
        physical: '{obj} 고정 상태 불량 및 통행로 바닥·발판 관리 미흡',
        process: '통행로 안전설비 정기점검 주기 미준수',
        organizational: '통행로·{obj} 점검 책임 부서 불명확',
      },
      countermeasures: [
        '{loc} {obj} 통행 통제 및 재고정·상태 확인 (즉시)',
        '동일 구역 {obj} 및 통행로 일제점검 ({d7})',
        '통행로 안전설비 점검 주기·책임 부서 절차서 명시 ({d21})',
      ],
    },
    '끼임/협착': {
      causes: {
        physical: '{obj} 방호장치(덮개·인터록) 미설치 또는 기능 불량',
        process: '작업 전 전원 차단·잠금(LOTO) 절차 미이행',
        organizational: '비정형 작업에 대한 작업허가·감독 체계 미흡',
      },
      countermeasures: [
        '{obj} 방호장치 작동 확인 전 운전 금지 (즉시)',
        'LOTO 절차 재교육 및 이행 점검 ({d7})',
        '비정형 작업 작업허가 기준 보완 ({d21})',
      ],
    },
    '충돌/부딪힘': {
      causes: {
        physical: '{loc} 내 {obj} 동선 간섭 및 시야 확보 미흡',
        process: '작업 구역·통행로 구분 및 신호수 배치 기준 미준수',
        organizational: '구역 출입 관리 책임 불명확',
      },
      countermeasures: [
        '{loc} 통행로 구획 표시 및 출입 통제 (즉시)',
        '신호수 배치·유도 기준 정비 ({d7})',
        '구역 출입 관리 책임자 지정 ({d21})',
      ],
    },
    '낙하/비래': {
      causes: {
        physical: '{obj} 고정부(힌지·체결부) 탈락 및 체결 불량',
        process: '{obj} 정기점검 주기 및 점검 항목 미흡',
        organizational: '설비 이상 발견 시 보고·조치 책임 체계 불명확',
      },
      countermeasures: [
        '{loc} {obj} 사용 중지 및 주변 접근 통제 (즉시)',
        '{obj} 고정부 재체결 및 동종 설비 일제점검 ({d7})',
        '{obj} 점검 주기·책임 부서 절차서 명시 ({d21})',
      ],
    },
    '감전': {
      causes: {
        physical: '{obj} 피복 손상 및 충전부 노출',
        process: '작업 전 정전·검전 절차 미이행',
        organizational: '전기설비 점검 책임 부서 및 주기 불명확',
      },
      countermeasures: [
        '해당 {obj} 전원 차단 및 접근 통제 (즉시)',
        '손상 {obj} 교체 및 절연 상태 일제점검 ({d7})',
        '전기 작업 정전·검전 절차 재교육 ({d14})',
      ],
    },
    '화재/폭발': {
      causes: {
        physical: '{obj} 주변 가연물 방치 및 점화원 관리 미흡',
        process: '화기작업 허가·화재감시자 배치 절차 미준수',
        organizational: '화기작업 관리 책임 체계 미흡',
      },
      countermeasures: [
        '{loc} 가연물 제거 및 소화설비 비치 확인 (즉시)',
        '화기작업 허가 절차 이행 점검 ({d7})',
        '화재감시자 배치 기준 절차서 보완 ({d21})',
      ],
    },
    '화학물질 노출': {
      causes: {
        physical: '{obj} 연결부 손상으로 인한 누출',
        process: '취급 전 누출 점검 및 보호구 착용 절차 미준수',
        organizational: 'MSDS 교육 및 취급 관리 책임 불명확',
      },
      countermeasures: [
        '{loc} 환기 및 누출부 차단 (즉시)',
        '{obj} 연결부 교체 및 누출 점검 ({d7})',
        'MSDS·보호구 착용 재교육 ({d14})',
      ],
    },
    [OTHER]: {
      causes: {
        physical: '{obj} 상태 불량 또는 작업 환경 미흡',
        process: '작업 전 위험요인 확인 절차 미흡',
        organizational: '설비·구역 점검 책임 불명확',
      },
      countermeasures: [
        '{loc} 위험요인 확인 및 접근 통제 (즉시)',
        '동종 설비·장소 일제점검 ({d7})',
        '점검 주기·책임 부서 절차서 명시 ({d21})',
      ],
    },
  };

  const RISK_HIGH = ['끼임/협착', '낙하/비래', '감전', '화재/폭발', '화학물질 노출'];

  // ---------- 날짜·시각 ----------

  const pad = (n) => String(n).padStart(2, '0');
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  // '시간'(2시간 동안)은 시각이 아니다
  const TIME_RE = /(오전|오후|새벽|아침|저녁|밤)?\s*(\d{1,2})\s*시(?!간)\s*(?:(\d{1,2})\s*분|(반))?/;
  // 문장에서 시각 표현을 떼어낼 때 쓴다 ("오늘 오후 8시 20분쯤에")
  const TIME_PHRASE_RE = /(오늘|어제|그저께|그제|금일|당일)?\s*(오전|오후|새벽|아침|저녁|밤)?\s*\d{1,2}\s*시(?!간)\s*(?:\d{1,2}\s*분|반)?\s*(?:쯤|경|께|무렵)?\s*(?:에)?\s*/g;
  const DAY_WORD_RE = /^(오늘|어제|그저께|그제|금일|당일)\s*/;

  function parseTime(text) {
    const m = text.match(TIME_RE);
    if (!m) return null;
    let hour = Number(m[2]);
    const minute = m[3] ? Number(m[3]) : m[4] ? 30 : 0;
    const meridiem = m[1];
    if (['오후', '저녁', '밤'].includes(meridiem) && hour < 12) hour += 12;
    if (['오전', '새벽', '아침'].includes(meridiem) && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  function baseDate(text, createdAt) {
    const d = createdAt ? new Date(createdAt) : new Date();
    const date = isNaN(d) ? new Date() : d;
    if (/그저께|그제/.test(text)) date.setDate(date.getDate() - 2);
    else if (/어제/.test(text)) date.setDate(date.getDate() - 1);
    const md = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
    if (md) date.setMonth(Number(md[1]) - 1, Number(md[2]));
    return date;
  }

  function stamp(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** "2026-10-20 14:32" → "2026.10.20.(화), 14시 32분" */
  function formatOccurred(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value || '');
    if (!m) return value || '';
    const weekday = WEEKDAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
    const date = `${m[1]}.${m[2]}.${m[3]}.(${weekday})`;
    return m[4] ? `${date}, ${m[4]}시 ${m[5]}분` : date;
  }

  function deadline(from, days) {
    const d = new Date(from);
    d.setDate(d.getDate() + days);
    return `~${pad(d.getMonth() + 1)}.${pad(d.getDate())}.`;
  }

  // ---------- 문장 다듬기 ----------

  function splitSentences(text) {
    return text
      .split(/(?<=[.!?])\s+|\n+|(?<=니다)\s+|(?<=어요)\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 서술형 문장을 보고서용 개조식으로 바꾼다 ("발견했습니다" → "발견함") */
  function concise(sentence) {
    let s = sentence.trim().replace(/[.!?。]+$/, '').trim();
    const rules = [
      [/(하였|했)습니다$/, '함'],
      [/(되었|됐)습니다$/, '됨'],
      [/습니다$/, '음'],
      [/합니다$/, '함'],
      [/됩니다$/, '됨'],
      [/입니다$/, '임'],
      [/(하였|했)어요$/, '함'],
      [/(되었|됐)어요$/, '됨'],
      [/있어요$/, '있음'],
      [/없어요$/, '없음'],
      [/(하였|했)다$/, '함'],
      [/(되었|됐)다$/, '됨'],
      [/있다$/, '있음'],
      [/요$/, ''],
    ];
    for (const [re, rep] of rules) {
      if (re.test(s)) {
        s = s.replace(re, rep);
        break;
      }
    }
    return s.replace(/^(그리고|그런데|그래서|그러다가|그러던 중)\s+/, '').trim();
  }

  // ---------- 장소·대상 ----------

  const LOC_KEY_RE = /(출입구|출입문|계단|통로|복도|라인|공장|챔버|구역|후드|설비|창고|현장|작업장|옥상|지붕|피트|플랫폼|컨베이어|크레인|탱크|변전실|전기실|기계실|사무실|실험실|주차장|도로|야드|건물|본관|별관|호기|\d+층|\d+동)$/;
  const POSITION_RE = /^(앞|옆|뒤|아래|위|근처|부근|안|내부|입구|하부|상부)$/;
  const LOC_PARTICLE_RE = /(에서는|에서|으로|에는|에|로)$/;
  const STOP_WORD_RE = /([이가은는을를의도와과]|중|후|내|때|및|하던|하는|하다가)$|^\d+명|^(오늘|어제|금일)$/;

  function stripParticle(word) {
    return word.replace(/[.,!?]/g, '').replace(LOC_PARTICLE_RE, '').replace(/의$/, '');
  }

  function findLocation(text) {
    const words = text.replace(TIME_PHRASE_RE, ' ').replace(/[.,!?]/g, ' ').split(/\s+/).filter(Boolean);
    let best = null;
    words.forEach((word, index) => {
      const hasParticle = LOC_PARTICLE_RE.test(word);
      const stem = stripParticle(word);
      const isKey = LOC_KEY_RE.test(stem) || /^\d+라인$/.test(stem);
      const isPosition = hasParticle && POSITION_RE.test(stem);
      if (!isKey && !isPosition) return;
      const score = hasParticle ? 3 : 1;
      if (!best || score > best.score) best = { index, score };
    });
    if (!best) return '';

    const picked = [stripParticle(words[best.index])];
    for (let i = best.index - 1; i >= Math.max(0, best.index - 3); i -= 1) {
      if (STOP_WORD_RE.test(words[i])) break;
      picked.unshift(words[i]);
    }
    return picked.join(' ');
  }

  function findObject(text) {
    return OBJECTS.find((name) => text.includes(name)) || '해당 설비';
  }

  function findFactory(text) {
    const m = text.match(/([가-힣A-Za-z0-9#]+공장)/);
    return m ? m[1] : '○○공장';
  }

  function classify(text) {
    let best = OTHER;
    let bestScore = 0;
    for (const [name, keywords] of CATEGORY_KEYWORDS) {
      const score = keywords.filter((k) => text.includes(k)).length;
      if (score > bestScore) {
        best = name;
        bestScore = score;
      }
    }
    return best;
  }

  // ---------- 조립 ----------

  function fill(template, vars) {
    return template
      .replace(/\{(\w+)\}/g, (_, key) => vars[key] || '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * 신고 원문으로 속보 초안을 만든다.
   * @param {string} content 신고 원문
   * @param {string} [createdAt] 입력 시각(ISO). 일시의 날짜 기준이 된다.
   */
  function build(content, createdAt) {
    const text = (content || '').trim();
    const date = baseDate(text, createdAt);
    const time = parseTime(text);
    if (time) date.setHours(time.hour, time.minute, 0, 0);
    const occurredAt = stamp(date);

    const category = classify(text);
    const location = findLocation(text);
    const obj = findObject(text);

    const overview = splitSentences(text).map((sentence) => {
      const t = parseTime(sentence);
      const body = concise(sentence.replace(TIME_PHRASE_RE, ' ').replace(DAY_WORD_RE, '').trim());
      return t ? `${pad(t.hour)}:${pad(t.minute)} ${body}` : body;
    }).filter(Boolean);

    const vars = {
      obj,
      loc: location || '해당 장소',
      d7: deadline(date, 7),
      d14: deadline(date, 14),
      d21: deadline(date, 21),
    };
    const template = TEMPLATES[category] || TEMPLATES[OTHER];
    const causes = {};
    Object.entries(template.causes).forEach(([key, value]) => {
      causes[key] = fill(value, vars);
    });

    let risk = RISK_HIGH.includes(category) ? '상' : '중';
    if (category === '추락/넘어짐' && /추락|떨어질|고소|비계|사다리|지붕|옥상/.test(text)) risk = '상';

    const draft = {
      title: `${findFactory(text)} 니어미스 속보`,
      risk,
      risk_reason: `${category} 유형 — 신고 내용상 인명 피해로 이어질 수 있어 ${risk} 등급으로 자동 분류`,
      category,
      occurred_at: occurredAt,
      location,
      overview: overview.length ? overview : [text],
      causes,
      countermeasures: template.countermeasures.map((line) => fill(line, vars)),
      questions: [],
    };
    draft.sources = {};
    Object.keys(draft).forEach((key) => {
      if (key !== 'sources') draft.sources[key] = 'auto';
    });
    return draft;
  }

  global.AutoDraft = { build, formatOccurred };
})(window);
