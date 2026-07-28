/**
 * Excel içe/dışa aktarma — spec §6, docs/excel-sablonu.md
 *
 * Kolon adları HARDCODE EDİLMEZ. Varsayılan şablon adları yalnızca otomatik
 * eşleme önerisi üretmek için kullanılır; kullanıcı eşlemeyi değiştirebilir.
 */

const XLSX = require('xlsx');
const { RowStatus } = require('../shared/protocol');

/** Varsayılan şablonun kolon adları -> değişken anahtarı önerisi */
const DEFAULT_COLUMN_HINTS = {
  siparisNo: ['sipariş no', 'siparis no', 'paket no', 'sipariş numarası', 'order no'],
  itirazSebebi: ['itiraz sebebi', 'itiraz nedeni', 'sebep'],
  dogruDesi: ['doğru desi', 'dogru desi', 'desi', 'gerçek desi'],
  aciklama: ['açıklama', 'aciklama', 'not'],
  recordingName: ['kayıt adı', 'kayit adi', 'kayıt'],
};

/**
 * Başlıkları karşılaştırma için normalize eder.
 *
 * Türkçe'de 'İ'.toLowerCase() -> 'i' + U+0307 (birleşen nokta) üretir; bu da
 * düz 'i' ile eşleşmez. Ayrıca kullanıcı 'İtiraz' yerine 'Itiraz' yazmış
 * olabilir. Bu yüzden aksanları soyup Türkçe'ye özgü harfleri sadeleştiriyoruz.
 */
function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // birleşen aksan işaretleri
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ç/g, 'c')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/\s+/g, ' ');
}

/** Excel dosyasını okur; başlıkları ve ham satırları döndürür. */
function readWorkbook(filePath) {
  const book = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw new Error('Excel dosyasında sayfa bulunamadı.');

  const sheet = book.Sheets[sheetName];
  // defval: '' -> boş hücreler atlanmasın, hizalama bozulmasın
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (matrix.length === 0) throw new Error('Excel dosyası boş.');

  const headers = matrix[0].map((h) => String(h ?? '').trim());
  const rows = matrix.slice(1).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));

  return { sheetName, headers, rows };
}

/**
 * Başlıklara bakarak kolon -> değişken eşlemesi önerir.
 * Dönen nesne: { [variableKey]: columnIndex }
 */
function suggestMapping(headers) {
  const mapping = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    for (const [key, hints] of Object.entries(DEFAULT_COLUMN_HINTS)) {
      if (mapping[key] !== undefined) continue;
      // İpuçları da aynı normalizasyondan geçer ki 'Doğru Desi' ~ 'dogru desi'.
      if (hints.some((hint) => normalizeHeader(hint) === normalized)) mapping[key] = index;
    }
  });
  return mapping;
}

/**
 * "1,5" / "1.5" / 1.5 -> 1.5 ; çevrilemezse null.
 * Türkçe Excel'de ondalık ayırıcı virgül olduğu için ikisi de kabul edilir.
 */
function parseDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (text === '') return null;
  // Binlik ayırıcı yok varsayımı: tek bir ayırıcı karakteri ondalık kabul edilir.
  const normalized = text.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sipariş no metne çevrilir. Excel sayı formatında saklamışsa bilimsel
 * gösterime dönmüş olabilir; bunu düz tam sayıya geri çeviririz.
 */
function parseOrderNo(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // Number.toFixed(0) yerine BigInt: çok uzun numaralarda hassasiyet kaybı olmasın
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  return String(value ?? '').trim();
}

/**
 * Ham satırları Work Queue girdilerine çevirir.
 *
 * @param {string[][]} rows
 * @param {Record<string, number>} mapping  değişken anahtarı -> kolon indeksi
 * @param {Array<{key:string,label:string,required:boolean}>} variables  beklenen değişkenler
 */
function buildQueue(rows, mapping, variables) {
  const entries = rows.map((row, i) => {
    const rowNumber = i + 2; // 1. satır başlık
    const values = {};
    const missing = [];

    for (const variable of variables) {
      const columnIndex = mapping[variable.key];
      const raw = columnIndex === undefined ? '' : row[columnIndex];

      let parsed;
      if (variable.key === 'siparisNo') parsed = parseOrderNo(raw);
      else if (variable.key === 'dogruDesi') {
        const number = parseDecimal(raw);
        parsed = number === null ? '' : String(number);
      } else parsed = String(raw ?? '').trim();

      if (variable.required && parsed === '') missing.push(variable.label);
      // Opsiyonel değişkenler boş string olarak kalır — substitute sırasında
      // "karşılığı yok" hatası vermesinler diye anahtar her zaman tanımlıdır.
      values[variable.key] = parsed;
    }

    const recordingColumn = mapping.recordingName;
    const recordingName =
      recordingColumn === undefined ? '' : String(row[recordingColumn] ?? '').trim();

    return {
      rowNumber,
      values,
      recordingName,
      recordingId: null,
      status: missing.length > 0 ? RowStatus.MISSING_DATA : RowStatus.PENDING,
      detail: missing.length > 0 ? `Boş zorunlu alan: ${missing.join(', ')}` : '',
    };
  });

  return { entries, warnings: findDuplicates(entries) };
}

/** Aynı sipariş no'nun tekrarı — uyarı üretir, engellemez (spec §6.2). */
function findDuplicates(entries) {
  const seen = new Map();
  const warnings = [];
  for (const entry of entries) {
    const orderNo = entry.values.siparisNo;
    if (!orderNo) continue;
    if (seen.has(orderNo)) {
      warnings.push(
        `Sipariş no ${orderNo} birden fazla satırda var (satır ${seen.get(orderNo)} ve ${entry.rowNumber}).`
      );
    } else {
      seen.set(orderNo, entry.rowNumber);
    }
  }
  return warnings;
}

/** Sonuçları yeni bir Excel dosyasına yazar (spec §10). */
function exportResults(filePath, entries, variables) {
  const headers = [
    'Satır',
    ...variables.map((v) => v.label),
    'Kayıt',
    'Durum',
    'Detay',
  ];

  const body = entries.map((entry) => [
    entry.rowNumber,
    ...variables.map((v) => entry.values[v.key] ?? ''),
    entry.recordingName || '',
    entry.status,
    entry.detail || '',
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...body]);
  sheet['!cols'] = headers.map(() => ({ wch: 18 }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sonuçlar');
  XLSX.writeFile(book, filePath);
  return filePath;
}

module.exports = {
  DEFAULT_COLUMN_HINTS,
  readWorkbook,
  suggestMapping,
  parseDecimal,
  parseOrderNo,
  buildQueue,
  exportResults,
};
