/**
 * Desi hesaplama ayarlarının kalıcılığı — PLAN-desi-hesaplama.md §5.2
 *
 * Kategori ortalama desileri, fiyat eşiği ve iade dahil etme tercihi
 * userData altında tek bir JSON dosyasında tutulur.
 */

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_CATEGORY_DESI,
  DEFAULT_PRICE_THRESHOLD,
  DEFAULT_PRICE_THRESHOLD_NEW,
  DEFAULT_PRICE_CHANGE_DATE,
} = require('./desi');

/** Kullanıcı hiç ayar kaydetmemişse geçerli olan değerler. */
function defaultSettings() {
  return {
    categoryDesi: { ...DEFAULT_CATEGORY_DESI },
    priceThreshold: DEFAULT_PRICE_THRESHOLD,
    priceThresholdNew: DEFAULT_PRICE_THRESHOLD_NEW,
    priceChangeDate: DEFAULT_PRICE_CHANGE_DATE,
    includeReturned: false,
  };
}

class DesiSettings {
  constructor(baseDir) {
    this.file = path.join(baseDir, 'desi-settings.json');
  }

  /**
   * Kayıtlı ayarları okur. Dosya yoksa/bozuksa varsayılana döner —
   * bozuk bir dosya yüzünden uygulama açılmaz hale gelmesin.
   *
   * Kayıtlı kategoriler varsayılanların ÜZERİNE yazılır: yeni bir kategori
   * sonradan koda eklenirse, eski ayar dosyası onu silmiş olmaz.
   */
  read() {
    const defaults = defaultSettings();
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return defaults;
    }
    if (!stored || typeof stored !== 'object') return defaults;

    return {
      categoryDesi: sanitizeCategories(stored.categoryDesi, defaults.categoryDesi),
      priceThreshold: sanitizeThreshold(stored.priceThreshold, defaults.priceThreshold),
      priceThresholdNew: sanitizeThreshold(stored.priceThresholdNew, defaults.priceThresholdNew),
      priceChangeDate: sanitizeDate(stored.priceChangeDate, defaults.priceChangeDate),
      includeReturned: stored.includeReturned === true,
    };
  }

  /** Gelen ayarları doğrulayıp yazar; yazılan (temizlenmiş) hali döner. */
  write(settings) {
    const defaults = defaultSettings();
    const clean = {
      categoryDesi: sanitizeCategories(settings?.categoryDesi, defaults.categoryDesi),
      priceThreshold: sanitizeThreshold(settings?.priceThreshold, defaults.priceThreshold),
      priceThresholdNew: sanitizeThreshold(
        settings?.priceThresholdNew,
        defaults.priceThresholdNew
      ),
      priceChangeDate: sanitizeDate(settings?.priceChangeDate, defaults.priceChangeDate),
      includeReturned: settings?.includeReturned === true,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(clean, null, 2), 'utf8');
    return clean;
  }

  /** Varsayılanlara döner — kayıtlı dosyayı siler. */
  reset() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      // dosya zaten yoksa sorun değil
    }
    return defaultSettings();
  }
}

/**
 * Kategori desilerini temizler: yalnızca geçerli pozitif sayılar kabul edilir.
 * Negatif/sıfır/metin değerler varsayılana geri döner, çünkü 0 desi bir
 * siparişi olduğundan hafif gösterip hatalı itiraz üretir.
 */
function sanitizeCategories(input, defaults) {
  const out = { ...defaults };
  if (!input || typeof input !== 'object') return out;

  for (const [name, value] of Object.entries(input)) {
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) out[name] = parsed;
  }
  return out;
}

function sanitizeThreshold(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Tarihi ISO (YYYY-MM-DD) biçiminde tutar. Kullanıcı "13.07.2026" yazmış
 * olabilir; o da kabul edilir. Geçersizse varsayılana döner.
 */
function sanitizeDate(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dotted = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    const [, day, month, year] = dotted;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return fallback;
}

module.exports = {
  DesiSettings,
  defaultSettings,
  sanitizeCategories,
  sanitizeDate,
  sanitizeThreshold,
};
