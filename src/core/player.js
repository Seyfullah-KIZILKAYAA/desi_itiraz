/**
 * Player / Yürütme Motoru — spec §7
 *
 * Satırları TEK TEK, sırayla işler. Sabit sleep YOKTUR; her bekleme eklenti
 * tarafında DOM koşuluna bağlıdır, buradaki timeout yalnızca emniyet ağıdır.
 * Panel'e özgü hiçbir bilgi bu dosyada bulunamaz — hepsi Kayıt verisinden gelir.
 */

const { EventEmitter } = require('events');
const {
  RowStatus,
  StepStatus,
  DEFAULT_STEP_TIMEOUT_MS,
} = require('../shared/protocol');
const { substituteDeep } = require('../shared/variables');

const RunState = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  DONE: 'done',
};

class Player extends EventEmitter {
  constructor({ bridge, library }) {
    super();
    this.bridge = bridge;
    this.library = library;
    this.state = RunState.IDLE;
    this.queue = [];
    this.currentIndex = -1;
    this.stopOnFirstError = false;
    this._resumeWaiters = [];
  }

  /**
   * @param {object[]} queue   buildQueue çıktısı
   * @param {object}   options
   *   panel            hangi pazaryeri
   *   setupRecordingId batch başında BİR KEZ çalışacak Kayıt (itiraz sayfasına
   *                    kadar gelen yol). Yoksa atlanır.
   *   stopOnFirstError ilk hatada dur
   */
  async run(queue, { panel, setupRecordingId = null, stopOnFirstError = false } = {}) {
    if (this.state === RunState.RUNNING || this.state === RunState.PAUSED) {
      throw new Error('Zaten çalışan bir görev var.');
    }

    this.queue = queue;
    this.stopOnFirstError = stopOnFirstError;
    this.state = RunState.RUNNING;
    this.emit('runStarted', { total: queue.length });

    // Hazırlık Kaydı: yalnızca bir kez, batch'in en başında.
    if (setupRecordingId) {
      const ok = await this._runSetupRecording(setupRecordingId);
      if (!ok) {
        // Sayfaya ulaşılamadıysa hiçbir satır çalışamaz; hepsini işaretle.
        for (const entry of queue) {
          if (entry.status === RowStatus.PENDING) {
            entry.status = RowStatus.FAILED;
            entry.detail = 'Hazırlık kaydı başarısız — itiraz sayfasına ulaşılamadı.';
          }
        }
        this.state = RunState.DONE;
        this.emit('runFinished', { queue, stopped: false, summary: this.summary() });
        return this.summary();
      }
    }

    for (let i = 0; i < queue.length; i++) {
      if (this.state === RunState.STOPPED) break;

      this.currentIndex = i;
      const entry = queue[i];

      // İçe aktarmada zaten elenmiş satırlar (Eksik veri) tekrar denenmez.
      if (entry.status === RowStatus.MISSING_DATA) {
        this.emit('rowFinished', { entry, index: i });
        continue;
      }

      // Duraklatma noktası: adımın ORTASINDA değil, satırlar arasında.
      await this._waitIfPaused();
      if (this.state === RunState.STOPPED) break;

      await this._runRow(entry, i, panel);

      if (entry.status === RowStatus.FAILED && this.stopOnFirstError) {
        this.state = RunState.STOPPED;
        this.emit('stoppedOnError', { entry, index: i });
        break;
      }
    }

    const wasStopped = this.state === RunState.STOPPED;
    this.state = wasStopped ? RunState.STOPPED : RunState.DONE;
    this.currentIndex = -1;
    this.emit('runFinished', { queue: this.queue, stopped: wasStopped, summary: this.summary() });
    return this.summary();
  }

  /**
   * Hazırlık Kaydını çalıştırır — batch başında bir kez.
   * Bu Kayıt sipariş bilgisi kullanmaz; sadece "itiraz sayfasına kadar gel".
   */
  async _runSetupRecording(recordingId) {
    const recording = this.library.get(recordingId);
    if (!recording) {
      this.emit('setupFailed', { detail: 'Hazırlık kaydı bulunamadı.' });
      return false;
    }

    this.emit('setupStarted', {
      recording,
      count: (recording.steps ?? []).length,
    });

    // Sipariş değişkeni yok; yer tutucu varsa boş geçilir ki hata vermesin.
    const values = {};
    for (const variable of recording.variables ?? []) values[variable.key] = '';

    const outcome = await this._runSteps(recording.steps ?? [], values, null, -1);

    if (!outcome.ok) {
      this.emit('setupFailed', { recording, detail: outcome.detail });
      return false;
    }

    this.emit('setupFinished', { recording });
    return true;
  }

  async _runRow(entry, index, panel) {
    const recording = entry.recordingId
      ? this.library.get(entry.recordingId)
      : this.library.match(entry, panel);

    if (!recording) {
      entry.status = RowStatus.NO_MATCH;
      entry.detail = 'Bu satır için uygun Kayıt bulunamadı.';
      this.emit('rowFinished', { entry, index });
      return;
    }

    entry.recordingId = recording.recordingId;
    entry.recordingName = recording.customLabel || recording.sequentialName;

    // Kaydın zorunlu değişkenlerinden biri bu satırda boşsa çalıştırma.
    const missing = (recording.variables ?? [])
      .filter((v) => v.required)
      .filter((v) => {
        const value = entry.values[v.key];
        return value === undefined || value === null || String(value).trim() === '';
      })
      .map((v) => v.label);

    if (missing.length > 0) {
      entry.status = RowStatus.MISSING_DATA;
      entry.detail = `Boş zorunlu alan: ${missing.join(', ')}`;
      this.emit('rowFinished', { entry, index });
      return;
    }

    // Opsiyonel değişkenler için eksik anahtarları boş stringe tamamla; aksi
    // halde {{aciklama}} gibi bir yer tutucu "karşılığı yok" hatası verir ve
    // sırf açıklama boş diye satır düşerdi.
    const values = { ...entry.values };
    for (const variable of recording.variables ?? []) {
      if (!variable.required && values[variable.key] === undefined) {
        values[variable.key] = '';
      }
    }

    entry.status = RowStatus.RUNNING;
    entry.detail = '';
    this.emit('rowStarted', { entry, index, recording });

    // Kayıt tek parçadır: bu satır için tüm adımlar sırayla çalışır.
    // "Oraya nasıl gidilir" ayrı bir Kayıttır ve batch başında bir kez çalışmıştır.
    const steps = recording.steps ?? [];
    const outcome = await this._runSteps(steps, values, entry, index);
    if (outcome.stopped) return;

    if (!outcome.ok) {
      entry.status = RowStatus.FAILED;
      entry.detail = outcome.detail;
      entry.screenshot = outcome.screenshot ?? null;
      this.emit('rowFinished', { entry, index });
      return;
    }

    // Kayıtta onSuccess işaretli adım yoksa, tüm adımların geçmesi başarı sayılır.
    const hasSuccessMarker = steps.some((s) => s.onSuccess === 'markRowSuccess');
    entry.status = !hasSuccessMarker || outcome.succeeded ? RowStatus.SUCCESS : RowStatus.FAILED;
    if (entry.status === RowStatus.FAILED) {
      entry.detail = 'Onay adımına ulaşılamadı.';
    }
    this.emit('rowFinished', { entry, index });
  }

  /**
   * Bir adım dizisini sırayla çalıştırır.
   * @returns {{ok:boolean, stopped:boolean, succeeded:boolean, detail?:string}}
   */
  async _runSteps(steps, values, entry, index) {
    let succeeded = false;

    for (const step of steps) {
      if (this.state === RunState.STOPPED) {
        // entry null olabilir: hazırlık kaydı bir satıra ait değildir.
        if (entry) {
          entry.status = RowStatus.FAILED;
          entry.detail = 'Kullanıcı tarafından durduruldu.';
          this.emit('rowFinished', { entry, index });
        }
        return { ok: false, stopped: true, succeeded };
      }

      let resolved;
      try {
        resolved = substituteDeep(step, values);
      } catch (err) {
        // Yer tutucunun karşılığı yok — yanlış veriyle tıklamaktansa satırı düşür.
        return {
          ok: false,
          stopped: false,
          succeeded,
          detail: `Adım ${step.stepId}: ${err.message}`,
        };
      }

      const timeoutMs = resolved.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      let result;
      try {
        result = await this.bridge.executeStep(resolved, timeoutMs);
      } catch (err) {
        result = { status: StepStatus.FAILED, detail: err.message };
      }

      this.emit('stepFinished', { entry, index, step: resolved, result });

      if (result.status === StepStatus.OK) {
        if (step.onSuccess === 'markRowSuccess') succeeded = true;
        continue;
      }

      // Opsiyonel adım bulunamadı -> atla, satırı düşürme (spec §4.5)
      if (step.optional) {
        this.emit('stepSkipped', { entry, index, step: resolved });
        continue;
      }

      return {
        ok: false,
        stopped: false,
        succeeded,
        detail: `Adım ${step.stepId} (${step.action}) başarısız: ${result.detail ?? 'element bulunamadı'}`,
        screenshot: result.screenshot ?? null,
      };
    }

    return { ok: true, stopped: false, succeeded };
  }

  _waitIfPaused() {
    if (this.state !== RunState.PAUSED) return Promise.resolve();
    return new Promise((resolve) => this._resumeWaiters.push(resolve));
  }

  pause() {
    if (this.state !== RunState.RUNNING) return;
    // Mevcut adım temiz biter; duraklama satır sınırında etkinleşir (spec §7.4).
    this.state = RunState.PAUSED;
    this.emit('paused');
  }

  resume() {
    if (this.state !== RunState.PAUSED) return;
    this.state = RunState.RUNNING;
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const resolve of waiters) resolve();
    this.emit('resumed');
  }

  stop() {
    if (this.state !== RunState.RUNNING && this.state !== RunState.PAUSED) return;
    this.state = RunState.STOPPED;
    // Duraklatılmışsa döngüyü serbest bırak ki durma fark edilsin.
    const waiters = this._resumeWaiters;
    this._resumeWaiters = [];
    for (const resolve of waiters) resolve();
    this.emit('stopped');
  }

  summary() {
    const counts = {};
    for (const entry of this.queue) {
      counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    }
    return { total: this.queue.length, counts };
  }
}

module.exports = { Player, RunState };
