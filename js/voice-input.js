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

  /** mock 모드용: 정해진 문장을 실제 음성 인식처럼 조금씩 흘려보내는 가짜 인식기 */
  function createScriptedRecognition(owner) {
    return class {
      start() {
        const from = owner.scriptPos;
        this.timer = setInterval(() => {
          if (owner.scriptPos >= owner.script.length) return; // 다 말했으면 '완료'를 누를 때까지 대기
          owner.scriptPos = Math.min(owner.script.length, owner.scriptPos + 1 + Math.floor(Math.random() * 3));
          const spoken = owner.script.slice(from, owner.scriptPos);
          this.onresult && this.onresult({ results: [Object.assign([{ transcript: spoken }], { isFinal: true })] });
        }, 110);
      }
      stop() {
        clearInterval(this.timer);
        setTimeout(() => this.onend && this.onend(), 50);
      }
      abort() { clearInterval(this.timer); }
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
        this.scripted = false;
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
