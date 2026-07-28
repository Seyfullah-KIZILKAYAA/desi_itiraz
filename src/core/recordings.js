/**
 * Kayıt Kitaplığı — spec §4.1, §4.3
 *
 * Her Kayıt ayrı bir JSON dosyasıdır; birini silmek/düzenlemek diğerlerini
 * etkilemez. Sıralı ad (`Kayıt N`) panel başına artar ve silme sonrası
 * TEKRAR KULLANILMAZ — bu yüzden sayaç ayrı bir dosyada tutulur.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { SYSTEM_VARIABLES, collectVariables } = require('../shared/variables');
const { FRAGILE_SELECTOR_TYPES, RecordingKind } = require('../shared/protocol');

class RecordingLibrary {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.recordingsDir = path.join(baseDir, 'recordings');
    this.counterFile = path.join(baseDir, 'counters.json');
    fs.mkdirSync(this.recordingsDir, { recursive: true });
  }

  _readCounters() {
    try {
      return JSON.parse(fs.readFileSync(this.counterFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Panel başına bir sonraki sıra numarasını verir ve kalıcı olarak artırır. */
  _nextSequence(panel) {
    const counters = this._readCounters();
    const next = (counters[panel] ?? 0) + 1;
    counters[panel] = next;
    fs.writeFileSync(this.counterFile, JSON.stringify(counters, null, 2), 'utf8');
    return next;
  }

  _fileFor(recordingId) {
    return path.join(this.recordingsDir, `${recordingId}.json`);
  }

  list() {
    return fs
      .readdirSync(this.recordingsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.recordingsDir, name), 'utf8'));
          return this._migrate(raw);
        } catch {
          return null; // bozuk dosya listeyi çökertmesin
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(recordingId) {
    try {
      const raw = JSON.parse(fs.readFileSync(this._fileFor(recordingId), 'utf8'));
      return this._migrate(raw);
    } catch {
      return null;
    }
  }

  /**
   * Diskteki eski kayıtları güncel tanıma uyarlar.
   *
   * Sistem değişkenlerinin tanımı KODDA yaşar; kayıt dosyası yalnızca o anki
   * kopyayı saklar. Tanım değişince (örn. itirazSebebi zorunlu olmaktan
   * çıktı) eski dosyalar da güncel davranışı almalı — aksi halde kullanıcı
   * kaydı yeniden almadıkça eski kural uygulanır.
   */
  _migrate(recording) {
    if (!recording) return recording;
    recording.variables = this._reconcileVariables(recording);
    return recording;
  }

  /**
   * Yeni, boş bir Kayıt oluşturur (kayıt oturumu başlarken).
   * @param {string} panel
   * @param {string} kind  RecordingKind.SETUP | RecordingKind.ITIRAZ
   */
  create(panel, kind = RecordingKind.ITIRAZ) {
    const sequence = this._nextSequence(panel);
    const now = new Date().toISOString();
    const recording = {
      recordingId: randomUUID(),
      sequentialName: `Kayıt ${sequence}`,
      customLabel: '',
      panel,
      kind,
      itirazSebebi: '', // otomatik eşleme için, spec §6.1
      createdAt: now,
      updatedAt: now,
      // Hazırlık kaydı sipariş verisi kullanmaz; değişken listesi boştur.
      variables:
        kind === RecordingKind.SETUP ? [] : SYSTEM_VARIABLES.map((v) => ({ ...v })),
      steps: [],
    };
    this.save(recording);
    return recording;
  }

  /** Belirli türdeki Kayıtlar (Çalıştır ekranındaki açılır menüler için). */
  listByKind(kind, panel = null) {
    return this.list().filter(
      (r) => kindOf(r) === kind && (panel === null || r.panel === panel)
    );
  }

  save(recording) {
    recording.updatedAt = new Date().toISOString();
    recording.variables = this._reconcileVariables(recording);
    fs.writeFileSync(
      this._fileFor(recording.recordingId),
      JSON.stringify(recording, null, 2),
      'utf8'
    );
    return recording;
  }

  /**
   * Adımlarda gerçekten kullanılan değişkenleri, tanımlı listeyle birleştirir.
   * Sistem değişkenleri adımlarda kullanılmasa bile listede kalır.
   */
  _reconcileVariables(recording) {
    const used = collectVariables(recording.steps ?? []);
    const known = new Map((recording.variables ?? []).map((v) => [v.key, v]));

    // Hazırlık kaydı sipariş verisi almaz; sistem değişkenleri eklenmez.
    if (kindOf(recording) !== RecordingKind.SETUP) {
      for (const variable of SYSTEM_VARIABLES) {
        const existing = known.get(variable.key);
        if (!existing) {
          known.set(variable.key, { ...variable });
        } else {
          // Sistem değişkenlerinin tanımı KODDA yaşar. Daha önce kaydedilmiş
          // dosyalar eski required/label değerlerini taşıyabilir; tanım
          // değiştiğinde (örn. itirazSebebi zorunlu olmaktan çıktı) eski
          // kayıtlar da güncel davranışı almalı.
          known.set(variable.key, {
            ...existing,
            label: variable.label,
            required: variable.required,
            system: true,
          });
        }
      }
    }
    for (const key of used) {
      if (!known.has(key)) {
        known.set(key, { key, label: key, required: true, system: false });
      }
    }
    return [...known.values()];
  }

  delete(recordingId) {
    try {
      fs.unlinkSync(this._fileFor(recordingId));
      return true;
    } catch {
      return false;
    }
  }

  rename(recordingId, customLabel) {
    const recording = this.get(recordingId);
    if (!recording) return null;
    // sequentialName'e dokunulmaz — spec §9.8
    recording.customLabel = String(customLabel ?? '').trim();
    return this.save(recording);
  }

  /** Bir Kaydı yeni sıralı adla kopyalar (spec §11 Faz 2). */
  duplicate(recordingId) {
    const source = this.get(recordingId);
    if (!source) return null;
    const copy = this.create(source.panel, kindOf(source));
    copy.customLabel = source.customLabel ? `${source.customLabel} (kopya)` : '';
    copy.itirazSebebi = source.itirazSebebi;
    copy.steps = JSON.parse(JSON.stringify(source.steps));
    copy.variables = JSON.parse(JSON.stringify(source.variables));
    return this.save(copy);
  }

  /** UI'da gösterilecek ad. */
  static displayName(recording) {
    return recording.customLabel || recording.sequentialName;
  }

  /**
   * Bir satırı Kayda eşler — spec §6.1.
   *
   * Sıra:
   *   1. `Kayıt Adı` kolonu (sıralı ad veya özel etikete birebir)
   *   2. Satırın İtiraz Sebebi ile Kaydın bildirdiği sebep
   *   3. Sebep boşsa ve ortada TEK bir itiraz kaydı varsa o kayıt
   *
   * 3. adım, sebep sütunu opsiyonel olduğu için gerekli: tek kayıtla
   * çalışırken sebep yazmaya gerek kalmaz. Birden fazla kayıt varsa
   * hangisi olduğu belirsizdir — TAHMİN YAPILMAZ, null döner (spec §9.6).
   */
  match(entry, panel) {
    // Yalnızca itiraz kayıtları satırlara eşlenir; hazırlık kayıtları değil.
    const candidates = this.listByKind(RecordingKind.ITIRAZ, panel);

    const requested = (entry.recordingName ?? '').trim().toLowerCase();
    if (requested) {
      return (
        candidates.find(
          (r) =>
            r.sequentialName.toLowerCase() === requested ||
            (r.customLabel ?? '').trim().toLowerCase() === requested
        ) ?? null
      );
    }

    const reason = (entry.values.itirazSebebi ?? '').trim().toLowerCase();

    if (!reason) {
      // Sebep yazılmamış: tek aday varsa kesin, birden fazlaysa belirsiz.
      return candidates.length === 1 ? candidates[0] : null;
    }

    const matches = candidates.filter(
      (r) => (r.itirazSebebi ?? '').trim().toLowerCase() === reason
    );
    if (matches.length === 1) return matches[0];

    // Sebep yazılmış ama hiçbir Kayıt onu iddia etmiyor: tek aday varsa
    // kullanılabilir (kayıt sebep ataması yapılmamış olabilir).
    if (matches.length === 0 && candidates.length === 1) return candidates[0];

    // Birden fazla Kayıt aynı sebebi iddia ediyorsa hangisi olduğu belirsizdir.
    return null;
  }
}

/** Bir adımın kırılgan (yalnızca yapısal CSS) seçiciye dayanıp dayanmadığı. */
function isFragileStep(step) {
  const strategies = step?.selector?.strategies ?? [];
  return strategies.length > 0 && strategies.every((s) => FRAGILE_SELECTOR_TYPES.has(s.type));
}

/**
 * Bir Kaydın türü. `kind` alanı olmayan eski Kayıtlar itiraz kaydı sayılır
 * (geriye dönük uyumluluk).
 */
function kindOf(recording) {
  return recording?.kind === RecordingKind.SETUP
    ? RecordingKind.SETUP
    : RecordingKind.ITIRAZ;
}

/** Türün Türkçe etiketi. */
function kindLabel(recording) {
  return kindOf(recording) === RecordingKind.SETUP
    ? 'Hazırlık (bir kez)'
    : 'İtiraz (her sipariş)';
}

module.exports = {
  RecordingLibrary,
  isFragileStep,
  kindOf,
  kindLabel,
};
