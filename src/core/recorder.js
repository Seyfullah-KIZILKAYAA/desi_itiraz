/**
 * Step Recorder ("öğret" modu) — spec §5
 *
 * Eklentiden gelen ham DOM olaylarını temiz, parametrelenmiş adımlara çevirir.
 * Panel'e özgü bilgi İÇERMEZ: "bu bir sipariş no mu" tahmini yalnızca genel
 * biçim sezgilerine dayanır ve nihai kararı kullanıcı verir (spec §5.5).
 */

const { EventEmitter } = require('events');
const { Action, ToApp, RecordingKind } = require('../shared/protocol');

/** Ardışık yazma olaylarının aynı alana ait sayılacağı süre */
const TYPING_COALESCE_MS = 1200;

class Recorder extends EventEmitter {
  constructor({ bridge, library }) {
    super();
    this.bridge = bridge;
    this.library = library;
    this.recording = null;
    this.active = false;
    this._onEvent = (payload) => this._handleEvent(payload);
  }

  /**
   * @param {string} panel  pazaryeri
   * @param {string} kind   RecordingKind.SETUP | RecordingKind.ITIRAZ
   */
  async start(panel, kind = RecordingKind.ITIRAZ) {
    if (this.active) throw new Error('Zaten süren bir kayıt var.');

    // Eklentiyi ÖNCE hazırla. Bu başarısız olursa (eklenti bağlı değil, sekmeye
    // erişilemiyor) hiçbir durum değiştirilmemiş olur; aksi halde `active`
    // true'da takılır ve sonraki denemeler "Zaten süren bir kayıt var" der.
    await this.bridge.startRecording();

    this.recording = this.library.create(panel, kind);
    this.active = true;
    this.bridge.on(ToApp.RECORDED_EVENT, this._onEvent);

    this.emit('started', this.recording);
    return this.recording;
  }

  /**
   * Takılı kalmış bir kayıt durumunu temizler.
   * Kayıt oturumu yarıda kalmışsa (uygulama hata verdi, eklenti koptu)
   * kullanıcının yeniden başlayabilmesi için gerekir.
   */
  async reset() {
    this.active = false;
    this.bridge.off(ToApp.RECORDED_EVENT, this._onEvent);
    try {
      await this.bridge.stopRecording();
    } catch {
      /* eklenti zaten kopmuş olabilir */
    }
    // Yarıda kalan kayıt boşsa sil; içinde adım varsa kullanıcıya bırak.
    if (this.recording && (this.recording.steps ?? []).length === 0) {
      this.library.delete(this.recording.recordingId);
    }
    const abandoned = this.recording;
    this.recording = null;
    this.emit('reset', abandoned);
    return abandoned;
  }

  async stop() {
    if (!this.active) return this.recording;
    this.active = false;
    this.bridge.off(ToApp.RECORDED_EVENT, this._onEvent);
    try {
      await this.bridge.stopRecording();
    } catch {
      // Eklenti kopmuş olabilir; yine de o ana kadarki adımları kaydet.
    }
    const saved = this.library.save(this.recording);
    this.emit('stopped', saved);
    return saved;
  }

  /** Kaydı iptal eder ve oluşturulan boş Kaydı siler. */
  async cancel() {
    const id = this.recording?.recordingId;
    this.active = false;
    this.bridge.off(ToApp.RECORDED_EVENT, this._onEvent);
    try {
      await this.bridge.stopRecording();
    } catch {
      /* yoksay */
    }
    if (id) this.library.delete(id);
    this.recording = null;
    this.emit('cancelled');
  }

  _handleEvent(payload) {
    if (!this.active || !this.recording) return;

    const step = this._toStep(payload);
    if (!step) return;

    const merged = this._tryMergeTyping(step, payload);
    if (!merged) {
      step.stepId = this.recording.steps.length + 1;
      this.recording.steps.push(step);
    }

    this.library.save(this.recording);
    this.emit('stepAdded', { recording: this.recording, step: merged ?? step, merged: !!merged });

    // Yazılan/seçilen bir değer varsa kullanıcıya değişken önerisi sun.
    const value = payload.value;
    if (value && this._looksParameterizable(payload)) {
      this.emit('variableSuggestion', {
        stepId: (merged ?? step).stepId,
        value,
        guess: this._guessVariable(payload),
      });
    }
  }

  /** Ham olayı adıma çevirir; ilgisiz olaylarda null döner. */
  _toStep(payload) {
    const { action, selector, value, url } = payload;

    switch (action) {
      case Action.NAVIGATE:
        return url ? { action: Action.NAVIGATE, url } : null;
      case Action.CLICK:
        return selector ? { action: Action.CLICK, selector, optional: false } : null;
      case Action.TYPE:
        return selector ? { action: Action.TYPE, selector, value: value ?? '', optional: false } : null;
      case Action.SELECT_OPTION:
        return selector
          ? { action: Action.SELECT_OPTION, selector, value: value ?? '', optional: false }
          : null;
      default:
        return null;
    }
  }

  /**
   * Aynı alana peş peşe yazma olaylarını tek adımda toplar; yoksa her tuş
   * ayrı bir adım olurdu.
   */
  _tryMergeTyping(step, payload) {
    if (step.action !== Action.TYPE) return null;
    const last = this.recording.steps[this.recording.steps.length - 1];
    if (!last || last.action !== Action.TYPE) return null;
    if (!sameTarget(last.selector, step.selector)) return null;
    if (payload.timestamp && last._lastTypedAt) {
      if (payload.timestamp - last._lastTypedAt > TYPING_COALESCE_MS) return null;
    }
    last.value = step.value;
    last._lastTypedAt = payload.timestamp ?? last._lastTypedAt;
    return last;
  }

  /** Kullanıcıya değişken sorulmaya değer mi? */
  _looksParameterizable(payload) {
    return payload.action === Action.TYPE || payload.action === Action.SELECT_OPTION;
  }

  /**
   * Hangi değişken olabileceğine dair ÖNERİ. Bağlayıcı değildir; kullanıcı
   * onaylar (spec §5.5). Panel metnine değil, genel biçime bakar.
   */
  _guessVariable(payload) {
    const value = String(payload.value ?? '').trim();
    if (payload.action === Action.SELECT_OPTION) return 'itirazSebebi';
    if (/^\d{6,}$/.test(value)) return 'siparisNo';
    if (/^\d{1,3}([.,]\d{1,2})?$/.test(value)) return 'dogruDesi';
    return null;
  }

  /** Bir adımın değerini {{degisken}} ile değiştirir (kullanıcı onayı sonrası). */
  bindVariable(stepId, variableKey) {
    const step = this.recording?.steps.find((s) => s.stepId === stepId);
    if (!step) return null;
    step.value = `{{${variableKey}}}`;
    this.library.save(this.recording);
    this.emit('stepUpdated', { recording: this.recording, step });
    return step;
  }

  /**
   * Kaydın BAŞINA doğrudan adrese gitme adımı ekler.
   *
   * Menü tıklayarak gezinmek kırılgandır (menü hover ile açılabilir, animasyonlu
   * olabilir, yapısı değişebilir). Hedef sayfanın adresi biliniyorsa oraya
   * doğrudan gitmek çok daha sağlamdır.
   */
  prependNavigate(url) {
    if (!this.recording) return null;
    const clean = String(url ?? '').trim();
    if (!clean) return null;

    const step = { stepId: 0, action: Action.NAVIGATE, url: clean, optional: false };
    this.recording.steps.unshift(step);
    // stepId'leri yeniden numaralandır.
    this.recording.steps.forEach((s, i) => {
      s.stepId = i + 1;
    });

    this.library.save(this.recording);
    this.emit('stepAdded', { recording: this.recording, step });
    return this.recording;
  }

  /**
   * Kaydın sonuna onay adımını ekler — Player'ın başarıyı anlaması için
   * zorunludur (spec §5.6).
   */
  appendSuccessStep(selector, timeoutMs = 10000) {
    if (!this.recording) return null;
    const step = {
      stepId: this.recording.steps.length + 1,
      action: Action.WAIT_FOR_ELEMENT,
      selector,
      timeoutMs,
      optional: false,
      onSuccess: 'markRowSuccess',
      onTimeout: 'markRowFailed',
    };
    this.recording.steps.push(step);
    this.library.save(this.recording);
    this.emit('stepAdded', { recording: this.recording, step });
    return step;
  }
}

/** İki seçicinin aynı elemana işaret edip etmediği (birincil stratejiye göre). */
function sameTarget(a, b) {
  const first = (sel) => sel?.strategies?.[0];
  const x = first(a);
  const y = first(b);
  if (!x || !y) return false;
  return x.type === y.type && x.attr === y.attr && x.value === y.value;
}

module.exports = { Recorder };
