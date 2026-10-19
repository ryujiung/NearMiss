/**
 * VoiceInput: [data-voice]가 달린 input/textarea 옆에 마이크 버튼을 붙여
 * 말한 내용을 텍스트로 넣어주는 모듈 (Web Speech API 사용)
 *
 * - 기존에 입력한 내용 뒤에 이어서 붙음 (키보드 입력과 섞어서 사용 가능)
 * - 한 번에 하나의 필드만 녹음
 * - 지원하지 않는 브라우저에서는 마이크 버튼을 숨기고 안내 문구 표시
 */
(function (global) {
  'use strict';

  const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;
  const isAndroid = /Android/i.test(navigator.userAgent);

  const MIC_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>' +
    '</svg>';

  const ERROR_MESSAGES = {
    'not-allowed': '마이크 권한이 거부되었습니다. 브라우저 설정에서 마이크를 허용해 주세요.',
    'service-not-allowed': '이 브라우저에서 음성 인식을 사용할 수 없습니다.',
    'no-speech': '음성이 감지되지 않았습니다. 다시 시도해 주세요.',
    'audio-capture': '마이크를 찾을 수 없습니다.',
    'network': '네트워크 오류로 음성 인식에 실패했습니다.',
  };

  class VoiceInput {
    constructor(options = {}) {
      this.lang = options.lang || 'ko-KR';
      this.onStatusChange = options.onStatusChange || function () {};
      this.onError = options.onError || function () {};

      this.recognition = null;
      this.activeField = null;
      this.activeButton = null;
      this.baseText = '';
      this.finalText = '';
    }

    static isSupported() {
      return !!SpeechRecognition;
    }

    /** 지원 여부와 사용 불가 사유를 반환 */
    static checkAvailability() {
      if (!SpeechRecognition) {
        return { ok: false, reason: '이 브라우저는 음성 입력을 지원하지 않습니다. 키보드의 마이크 버튼을 이용하거나 Chrome·Safari·삼성 인터넷을 사용해 주세요.' };
      }
      if (!global.isSecureContext) {
        return { ok: false, reason: '음성 입력은 HTTPS 환경에서만 동작합니다.' };
      }
      return { ok: true };
    }

    /** selector에 해당하는 필드 모두에 마이크 버튼 부착 */
    attachAll(selector = '[data-voice]') {
      document.querySelectorAll(selector).forEach((field) => this.attach(field));
    }

    attach(field) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mic-btn';
      btn.innerHTML = MIC_ICON;
      btn.setAttribute('aria-label', '음성으로 입력');
      btn.addEventListener('click', () => {
        if (this.activeField === field) {
          this.stop();
        } else {
          this.start(field, btn);
        }
      });
      field.insertAdjacentElement('afterend', btn);
    }

    start(field, button) {
      // 다른 필드에서 녹음 중이면 먼저 정리
      if (this.recognition) this._abortCurrent();

      const rec = new SpeechRecognition();
      rec.lang = this.lang;
      rec.interimResults = true;      // 말하는 도중에도 글자를 보여줌
      rec.maxAlternatives = 1;
      // 안드로이드 Chrome은 continuous 모드에서 결과가 중복되는 버그가 있어 끔
      rec.continuous = !isAndroid;

      this.recognition = rec;
      this.activeField = field;
      this.activeButton = button;
      this.baseText = field.value;
      this.finalText = '';

      rec.onstart = () => {
        button.classList.add('listening');
        button.setAttribute('aria-label', '음성 입력 중지');
        field.classList.add('voice-active');
        this.onStatusChange({ listening: true, field });
      };

      rec.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = 0; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += transcript;
          else interim += transcript;
        }
        this.finalText = final;
        this._render(final + interim);
      };

      rec.onerror = (event) => {
        // 사용자가 직접 중지한 경우는 에러로 보지 않음
        if (event.error === 'aborted') return;
        this.onError(ERROR_MESSAGES[event.error] || `음성 인식 오류: ${event.error}`);
      };

      rec.onend = () => {
        // 확정된 텍스트만 남김
        if (this.activeField === field) {
          this._render(this.finalText);
          this._cleanup();
        }
      };

      try {
        rec.start();
      } catch (e) {
        this.onError('음성 인식을 시작할 수 없습니다.');
        this._cleanup();
      }
    }

    stop() {
      if (this.recognition) this.recognition.stop(); // onend에서 정리됨
    }

    _abortCurrent() {
      const field = this.activeField;
      this.recognition.onend = null;
      this.recognition.abort();
      if (field) this._render(this.finalText);
      this._cleanup();
    }

    /** 기존 텍스트 + 인식된 텍스트를 필드에 반영 */
    _render(spoken) {
      const field = this.activeField;
      if (!field) return;
      const text = spoken.trim();
      const sep = this.baseText && text && !/\s$/.test(this.baseText) ? ' ' : '';
      field.value = this.baseText + sep + text;
      // 프레임워크/유효성 검사 등이 변경을 감지할 수 있도록 이벤트 발생
      field.dispatchEvent(new Event('input', { bubbles: true }));
      if (field.tagName === 'TEXTAREA') field.scrollTop = field.scrollHeight;
    }

    _cleanup() {
      const { activeField: field, activeButton: button } = this;
      if (button) {
        button.classList.remove('listening');
        button.setAttribute('aria-label', '음성으로 입력');
      }
      if (field) field.classList.remove('voice-active');
      this.recognition = null;
      this.activeField = null;
      this.activeButton = null;
      this.onStatusChange({ listening: false, field });
    }
  }

  global.VoiceInput = VoiceInput;
})(window);
