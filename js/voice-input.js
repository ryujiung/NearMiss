/**
 * VoiceInput: 버튼 하나로 textarea에 음성을 받아쓰는 모듈 (Web Speech API 사용)
 *
 * - 기존에 입력한 내용 뒤에 이어서 붙음 (키보드 입력과 섞어서 사용 가능)
 * - 사용자가 '완료'를 누를 때까지 계속 들음
 *   (말을 잠깐 멈춰서 브라우저가 인식을 끝내도 자동으로 다시 시작)
 */
(function (global) {
  'use strict';

  const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;
  const isAndroid = /Android/i.test(navigator.userAgent);

  // 아무 말 없이 자동 재시작이 이 횟수만큼 반복되면 멈춤 (마이크가 계속 켜져 있는 것 방지)
  const MAX_SILENT_RESTARTS = 3;

  const ERROR_MESSAGES = {
    'not-allowed': '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용해 주세요.',
    'service-not-allowed': '이 브라우저에서 음성 인식을 사용할 수 없습니다.',
    'audio-capture': '마이크를 찾을 수 없습니다.',
    'network': '네트워크 오류로 음성 인식에 실패했습니다.',
  };
  // 이 에러가 나면 자동 재시작하지 않음
  const FATAL_ERRORS = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network'];

  // 녹음을 듣고 받아쓰는 것처럼 보이게 하는 속도 설정.
  //
  // 글자를 일정한 간격으로 쏟아내면 "와다다다" 타이핑처럼 보인다. 사람이 말하는
  // 리듬은 (1) 어절 단위로 끊기고 (2) 쉼표·마침표에서 쉬고 (3) 속도가 조금씩
  // 흔들린다. 그 셋을 흉내 낸다.
  const SCRIPT_CHARS_PER_SEC = 6.5;   // rec_mock 음원(26.8초 / 174자)에 맞춘 값
  const SCRIPT_JITTER = 0.35;         // 간격을 ±35% 흔들어 기계적인 느낌을 없앤다
  const SCRIPT_PAUSE_COMMA = 420;     // 쉼표에서 쉬는 시간(ms)
  const SCRIPT_PAUSE_PERIOD = 900;    // 마침표에서 쉬는 시간(ms)

  /** mock 모드용: 정해진 문장을 녹음을 듣고 받아쓰는 것처럼 흘려보내는 가짜 인식기 */
  function createScriptedRecognition(owner) {
    return class {
      start() {
        const from = owner.scriptPos;
        const script = owner.script;

        // 어절(공백) 단위로 끊어 내보낸다 — 글자 단위로 흘리면 사람이 말하는
        // 리듬이 아니라 타이핑처럼 보인다.
        const emit = () => {
          if (!this.running) return;
          if (owner.scriptPos >= script.length) return; // 다 말했으면 '완료'를 누를 때까지 대기

          const nextSpace = script.indexOf(' ', owner.scriptPos + 1);
          const chunkEnd = nextSpace === -1 ? script.length : nextSpace;
          const chunk = script.slice(owner.scriptPos, chunkEnd);
          owner.scriptPos = chunkEnd;

          const spoken = script.slice(from, owner.scriptPos);
          this.onresult && this.onresult({
            results: [Object.assign([{ transcript: spoken }], { isFinal: true })],
          });

          // 이 어절을 "말하는 데" 걸릴 시간 + 문장 부호에서의 쉼
          let delay = (chunk.length / SCRIPT_CHARS_PER_SEC) * 1000;
          delay *= 1 + (Math.random() * 2 - 1) * SCRIPT_JITTER;
          const tail = chunk.trim().slice(-1);
          if (tail === ',') delay += SCRIPT_PAUSE_COMMA;
          else if (tail === '.' || tail === '?' || tail === '!') delay += SCRIPT_PAUSE_PERIOD;

          this.timer = setTimeout(emit, Math.max(120, delay));
        };

        this.running = true;
        // 녹음을 재생하고 인식이 붙기까지의 짧은 공백
        this.timer = setTimeout(emit, 600);
      }
      stop() {
        this.running = false;
        clearTimeout(this.timer);
        setTimeout(() => this.onend && this.onend(), 50);
      }
      abort() {
        this.running = false;
        clearTimeout(this.timer);
      }
    };
  }

  // 음성 인식이 '목업'을 비슷한 소리로 적는 경우까지 허용
  const KEYWORD_RE = /목\s*업|목\s*엎|목\s*어|목\s*업|모\s*겁|모\s*컵|먹\s*업|mock\s*-?\s*up|mockup|mock/i;

  class VoiceInput {
    constructor(options = {}) {
      this.script = options.script || null; // 있으면 '목업' 키워드(또는 마이크 미지원 시)에 이 문장을 말하는 것처럼 보여줌
      this.keyword = options.keyword || '목업';
      this.scripted = false;
      this.scriptPos = 0;
      this.lang = options.lang || 'ko-KR';
      this.onStatusChange = options.onStatusChange || function () {};
      this.onError = options.onError || function () {};

      this.field = null;
      this.recognition = null;
      this.listening = false;   // 사용자가 '듣기' 상태를 원하는지
      this.baseText = '';
      this.finalText = '';
      this.heardSomething = false;
      this.silentRestarts = 0;
    }

    /** 지원 여부와 사용 불가 사유를 반환 */
    static checkAvailability() {
      if (!SpeechRecognition) {
        return { ok: false, reason: '이 브라우저는 음성 입력을 지원하지 않습니다. 키보드의 마이크 버튼을 이용하거나 Chrome·Safari·삼성 인터넷으로 열어 주세요.' };
      }
      if (!global.isSecureContext) {
        return { ok: false, reason: '음성 입력은 HTTPS 환경에서만 동작합니다.' };
      }
      return { ok: true };
    }

    /** 버튼을 누르면 field에 받아쓰기 시작/중지 */
    bind(field, button) {
      this.field = field;
      button.addEventListener('click', () => (this.listening ? this.stop() : this.start()));
    }

    start() {
      if (this.listening) return;
      if (SpeechRecognition) {
        // 마이크를 쓸 수 없는 환경(비보안 주소 등)에서는 키워드를 들을 수 없으니 바로 녹음본 재생
        this.scripted = !!this.script && !VoiceInput.checkAvailability().ok;
        this.scriptPos = 0;
      }
      this.listening = true;
      this.silentRestarts = 0;
      this.onStatusChange({ listening: true });
      this.field.classList.add('voice-active');
      try {
        this._startSession();
      } catch (e) {
        this.listening = false;
        this.onError('음성 인식을 시작할 수 없습니다.');
        this._finish();
      }
    }

    stop() {
      if (!this.listening) return;
      this.listening = false;
      if (this.recognition) this.recognition.stop(); // onend에서 정리됨
      else this._finish();
    }

    /** 즉시 중단 — 이후 필드에 아무것도 쓰지 않음 (제출 직전 등) */
    abort() {
      this.listening = false;
      if (this.recognition) {
        this.recognition.onresult = this.recognition.onend = this.recognition.onerror = null;
        this.recognition.abort();
        this.recognition = null;
      }
      this._finish();
    }

    /** 인식 세션 하나 시작 (자동 재시작 시에도 호출됨) */
    _startSession() {
      const useScript = this.script && (this.scripted || !SpeechRecognition);
      const rec = useScript ? new (createScriptedRecognition(this))() : new SpeechRecognition();
      rec.lang = this.lang;
      rec.interimResults = true;      // 말하는 도중에도 글자를 보여줌
      rec.maxAlternatives = 1;
      // 안드로이드 Chrome은 continuous 모드에서 결과가 중복되는 버그가 있어 끄고 자동 재시작으로 대신함
      rec.continuous = !isAndroid;

      this.recognition = rec;
      this.baseText = this.field.value; // 키보드로 고친 내용도 반영
      this.finalText = '';
      this.heardSomething = false;

      rec.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = 0; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        this.finalText = final;
        this.heardSomething = true;

        if (this.script && !this.scripted && KEYWORD_RE.test(final + interim)) {
          // 키워드를 말하면 실제 인식을 끊고 녹음본 재생으로 전환
          this.scripted = true;
          this.scriptPos = 0;
          rec.onresult = rec.onend = rec.onerror = null;
          rec.abort();
          this.recognition = null;
          this._render('');
          this._startSession();
          return;
        }
        this._render(final + interim);
      };

      rec.onerror = (event) => {
        if (FATAL_ERRORS.includes(event.error)) {
          this.listening = false;
          this.onError(ERROR_MESSAGES[event.error] || `음성 인식 오류: ${event.error}`);
        }
        // 'no-speech', 'aborted' 등은 onend에서 재시작 여부 판단
      };

      rec.onend = () => {
        this._render(this.finalText); // 확정된 텍스트만 남김
        this.recognition = null;

        if (!this.listening) {
          this._finish();
          return;
        }

        this.silentRestarts = this.heardSomething ? 0 : this.silentRestarts + 1;
        if (this.silentRestarts >= MAX_SILENT_RESTARTS) {
          this.listening = false;
          this.onError('음성이 감지되지 않아 듣기를 멈췄습니다.');
          this._finish();
          return;
        }

        try {
          this._startSession();
        } catch (e) {
          this.listening = false;
          this._finish();
        }
      };

      rec.start();
    }

    /** 기존 텍스트 + 인식된 텍스트를 필드에 반영 */
    _render(spoken) {
      const text = spoken.trim();
      const sep = this.baseText && text && !/\s$/.test(this.baseText) ? ' ' : '';
      this.field.value = this.baseText + sep + text;
      this.field.dispatchEvent(new Event('input', { bubbles: true }));
      this.field.scrollTop = this.field.scrollHeight;
    }

    _finish() {
      this.field.classList.remove('voice-active');
      this.onStatusChange({ listening: false });
    }
  }

  global.VoiceInput = VoiceInput;
})(window);
