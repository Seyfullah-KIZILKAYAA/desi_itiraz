/**
 * Desi itiraz hesaplama — PLAN-desi-hesaplama.md
 *
 * Trendyol "Siparişleriniz" Excel'ini okur, siparişleri gruplar, ürün adından
 * kategori tespit eder ve hangi siparişlerin desi itirazına uygun olduğunu
 * hesaplar.
 *
 * Electron'a bağımlı değildir — saf fonksiyonlar, doğrudan test edilebilir.
 */

const XLSX = require('xlsx');

/**
 * Trendyol dosyasında 1. satır yasal uyarı metnidir, gerçek başlık 2. satırdadır.
 * Bu yüzden core/excel.js'in readWorkbook'u burada kullanılamaz.
 */
const HEADER_ROW_INDEX = 1;

/** Fiyat kuralı eşiği — bu değer ve altı itiraza girmez (eşiğin kendisi hariç). */
const DEFAULT_PRICE_THRESHOLD = 110.39;

/**
 * Kargo fiyatı 13.07.2026'dan sonraki siparişler için güncellendi.
 * Bu tarihten sonraki siparişlerde eşik olarak yeni tutar kullanılır.
 */
const DEFAULT_PRICE_CHANGE_DATE = '2026-07-13';
const DEFAULT_PRICE_THRESHOLD_NEW = 115.67;

/**
 * İade kargoları farklı tarifeye tabi (dosyadaki en yaygın tutar 93,05),
 * bu yüzden iade dosyasına kendi eşiği uygulanır.
 */
const DEFAULT_RETURN_PRICE_THRESHOLD = 93.05;

/**
 * Panel, mevcut desi ile girilen desi arasında en az bu kadar fark ister.
 * 1 farklı itirazları (2 -> 1 gibi) kabul etmiyor.
 */
const MIN_DESI_GAP = 2;

/**
 * Hesap 1 desi çıksa bile, mevcut desi bu değerin ÜSTÜNDEYSE (3 dahil değil,
 * yani 4 ve üzeri) itirazda 1 yerine 2 desi girilir.
 */
const RAISE_TO_TWO_ABOVE = 3;

/** Kategorisi tespit edilemeyen ürünler için kullanılan ad. */
const FALLBACK_CATEGORY = 'Diğer';

/**
 * Kategori -> ortalama desi varsayılanları.
 *
 * DİKKAT: Bu değerler başlangıç tahminidir. Kategori listesi kullanıcının
 * verdiği iki görselden alınmıştır; ortalama desiler görsellerde yoktu.
 * T-Shirt kullanıcının verdiği 0.20 ile sabitlenmiş, diğerleri ona göre
 * ölçeklenmiştir. Uygulamadaki "Desi Bilgileri" ekranından düzeltilir ve
 * kaydedilen değerler bunların üzerine yazılır.
 */
const DEFAULT_CATEGORY_DESI = {
  'T-Shirt': 0.2,
  'Polo Yaka T-shirt': 0.25,
  Atlet: 0.15,
  'Spor Atlet': 0.15,
  Body: 0.15,
  Büstiyer: 0.15,
  Bluz: 0.25,
  Gömlek: 0.35,
  Elbise: 0.45,
  Tunik: 0.35,
  Etek: 0.3,
  'Şort & Bermuda': 0.3,
  Pantolon: 0.5,
  Tayt: 0.25,
  Hırka: 0.5,
  Kazak: 0.5,
  Sweatshirt: 0.6,
  Ceket: 0.8,
  'Kimono & Kaftan': 0.4,
  Çorap: 0.05,
  'Pijama Üstü': 0.25,
  'Eşofman Altı': 0.45,
  'Spor Eşofman Altı': 0.45,
  'Eşofman Takımı': 0.9,
  'Alt - Üst Takım': 0.8,
  'Spor Tulum': 0.6,
  Parfüm: 0.5,
  'Büyük Beden T-Shirt': 0.3,
  'Büyük Beden Atlet': 0.2,
  'Büyük Beden Bluz': 0.35,
  'Büyük Beden Body': 0.2,
  'Büyük Beden Büstiyer': 0.2,
  'Büyük Beden Gömlek': 0.45,
  'Büyük Beden Elbise': 0.6,
  'Büyük Beden Tunik': 0.45,
  'Büyük Beden Etek': 0.4,
  'Büyük Beden Pantolon': 0.65,
  'Büyük Beden Tayt': 0.35,
  'Büyük Beden Sweatshirt': 0.75,
  'Büyük Beden Ceket': 1.0,
  'Büyük Beden Eşofman Altı': 0.6,
  'Büyük Beden Alt - Üst Takım': 1.0,
  [FALLBACK_CATEGORY]: 0.3,
};

/**
 * Desteklenen dosya biçimleri.
 *
 * Trendyol iki ayrı rapor veriyor ve yapıları farklı:
 *  - "Siparişleriniz": 1. satır yasal uyarı, başlık 2. satırda, desi kolonu
 *    "Kargodan alınan desi".
 *  - "İadeleriniz": başlık 1. satırda, desi kolonu "İade Desi", paket no yok.
 *
 * Okuma katmanı hangisi olduğunu başlıklara bakarak kendisi anlar; hesaplama
 * çekirdeği (groupByOrder / computeClaims) ikisinde de aynı şekilde çalışır.
 */
const FILE_KIND = {
  ORDERS: 'siparis',
  RETURNS: 'iade',
};

/** Okunması gereken kolon başlıkları — dosyadaki birebir adlar. */
const COLUMNS = {
  siparisNo: 'Sipariş Numarası',
  paketNo: 'Paket No',
  urunAdi: 'Ürün Adı',
  adet: 'Adet',
  siparisTarihi: 'Sipariş Tarihi',
  mevcutDesi: 'Kargodan alınan desi',
  kargoTutari: 'Faturalanan Kargo Tutarı',
  statu: 'Sipariş Statüsü',
  birimFiyat: 'Birim Fiyatı',
  marka: 'Marka',
  stokKodu: 'Stok Kodu',
};

/**
 * "İadeleriniz" dosyasının kolonları. Sipariş dosyasında olup burada
 * bulunmayanlar (Paket No, Marka) opsiyoneldir; yokluğunda boş geçilir.
 */
const RETURN_COLUMNS = {
  siparisNo: 'Sipariş Numarası',
  urunAdi: 'Ürün Adı',
  adet: 'Adet',
  siparisTarihi: 'Sipariş Tarihi',
  mevcutDesi: 'İade Desi',
  kargoTutari: 'Faturalanan Kargo Tutarı',
  statu: 'Durum',
  birimFiyat: 'Birim Fiyatı',
  stokKodu: 'Tedarikçi Stok Kodu',
};

/**
 * Biçim tanımları. `headerRow` başlığın kaçıncı satırda olduğu, `required`
 * bulunması ZORUNLU kolonlar (biçim tespiti bunlara bakar), `optional`
 * bulunursa okunacak ama yoksa sorun olmayanlar.
 */
const FILE_FORMATS = [
  {
    kind: FILE_KIND.ORDERS,
    label: 'Siparişleriniz',
    headerRow: 1, // 1. satır yasal uyarı metni
    columns: COLUMNS,
    required: Object.keys(COLUMNS),
    optional: [],
  },
  {
    kind: FILE_KIND.RETURNS,
    label: 'İadeleriniz',
    headerRow: 0,
    columns: RETURN_COLUMNS,
    required: Object.keys(RETURN_COLUMNS),
    // İade dosyasında paket no ve marka yok; claim'lerde boş kalırlar.
    optional: ['paketNo', 'marka'],
  },
];

/**
 * Türkçe metni karşılaştırma için sadeleştirir.
 *
 * 'İ'.toLowerCase() 'i' + U+0307 üretir ve düz 'i' ile eşleşmez; ayrıca
 * ürün adlarında 'Şort' yerine 'Sort' yazılmış olabiliyor. Bu yüzden
 * aksanları soyup Türkçe'ye özgü harfleri düz karşılıklarına indiriyoruz.
 * (core/excel.js'teki normalizeHeader ile aynı mantık.)
 */
function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ç/g, 'c')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * "1,5" / "1.5" / 1.5 -> 1.5 ; sayıya çevrilemezse null.
 * "Henüz fatura kesilmemiştir." gibi metinler null döner ve fiyat kuralında
 * "faturalanmamış" olarak değerlendirilir.
 */
function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * "28.06.2026 00:00" -> "2026-06-28" (karşılaştırılabilir ISO tarihi).
 *
 * Sıralanabilir metin döndürülür; Date nesnesi kullanmıyoruz çünkü saat
 * dilimi kaymaları gün sınırındaki siparişleri yanlış tarafa atabilir.
 * Ayrıştırılamazsa null.
 */
function parseOrderDate(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;

  const dotted = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotted) {
    const [, day, month, year] = dotted;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Excel tarihi metin yerine ISO olarak saklamışsa
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/** Sipariş no'yu metne çevirir; Excel sayı sakladıysa bilimsel gösterimi açar. */
function parseOrderNo(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  }
  return String(value ?? '').trim();
}

/**
 * Kategori adlarını eşleştirme için önceden hazırlar.
 *
 * Uzun adlar önce denenir: "Büyük Beden T-Shirt" ve "Polo Yaka T-shirt",
 * "T-Shirt"ten önce sınanmalı ki daha genel olana düşmesin.
 */
function buildCategoryMatchers(categoryDesi) {
  const matchers = [];
  const seen = new Set();

  for (const name of Object.keys(categoryDesi)) {
    if (name === FALLBACK_CATEGORY) continue;

    // "Şort & Bermuda" gibi birleşik adlar ürün başlıklarında bütün olarak
    // geçmez; ürün yalnızca "Şort" der. Bu yüzden birleşik adın parçaları da
    // ayrı birer arama terimi olur, ikisi de aynı kategoriye işaret eder.
    const variants = [name, ...name.split(/\s*&\s*/)];

    for (const variant of variants) {
      const needle = normalizeText(variant);
      if (needle === '') continue;
      const key = `${name} ${needle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matchers.push({ name, needle });
    }
  }

  // Uzun terimler önce: "buyuk beden t shirt" ve "polo yaka t shirt",
  // "t shirt"ten önce sınanmalı ki daha genel olana düşmesin.
  return matchers.sort((a, b) => b.needle.length - a.needle.length);
}

/**
 * Ürün adından kategoriyi bulur. Bulunamazsa null döner (çağıran taraf
 * FALLBACK_CATEGORY'ye düşürür ve satırı "kategori bulunamadı" işaretler).
 *
 * @param {string} urunAdi
 * @param {Array<{name:string,needle:string}>} matchers  buildCategoryMatchers çıktısı
 */
function detectCategory(urunAdi, matchers, cache) {
  if (cache) {
    const hit = cache.get(urunAdi);
    if (hit !== undefined) return hit;
  }

  const haystack = normalizeText(urunAdi);
  let found = null;
  if (haystack !== '') {
    // Matchers uzunluğa göre sıralı olduğu için ilk eşleşme en spesifik olandır.
    for (const { name, needle } of matchers) {
      if (haystack.includes(needle)) {
        found = name;
        break;
      }
    }
  }

  if (cache) cache.set(urunAdi, found);
  return found;
}

/** Bir başlık satırından "normalize başlık -> kolon indeksi" haritası üretir. */
function indexHeaders(headerRow) {
  const headers = (headerRow || []).map((h) => String(h ?? '').trim());
  const index = {};
  headers.forEach((header, i) => {
    const key = normalizeText(header);
    if (key !== '' && index[key] === undefined) index[key] = i;
  });
  return { headers, index };
}

/**
 * Bir biçim tanımının bu başlık satırına uyup uymadığını sınar.
 * @returns {{columnIndex:object, missing:string[]}}
 */
function matchFormat(format, index) {
  const columnIndex = {};
  const missing = [];

  for (const [key, header] of Object.entries(format.columns)) {
    const i = index[normalizeText(header)];
    if (i !== undefined) columnIndex[key] = i;
    else if (format.required.includes(key)) missing.push(header);
  }
  return { columnIndex, missing };
}

/**
 * Excel'i okur, hangi Trendyol raporu olduğunu başlıklara bakarak anlar ve
 * kolon haritasını çıkarır.
 *
 * "Siparişleriniz" ve "İadeleriniz" farklı satırlarda başlıyor ve desi kolonu
 * farklı adlanıyor; bu fonksiyon ikisini de tanır. Dönen yapı her iki biçimde
 * de aynıdır, böylece groupByOrder / computeClaims değişmeden çalışır.
 */
function readOrderWorkbook(filePath) {
  const book = XLSX.readFile(filePath, { cellDates: false });
  const sheetName = book.SheetNames[0];
  if (!sheetName) throw new Error('Excel dosyasında sayfa bulunamadı.');

  const matrix = XLSX.utils.sheet_to_json(book.Sheets[sheetName], {
    header: 1,
    defval: '',
    raw: true,
  });
  if (matrix.length === 0) throw new Error('Excel dosyası boş.');

  const attempts = [];
  for (const format of FILE_FORMATS) {
    if (matrix.length <= format.headerRow) continue;

    const { headers, index } = indexHeaders(matrix[format.headerRow]);
    const { columnIndex, missing } = matchFormat(format, index);

    if (missing.length === 0) {
      const rows = matrix
        .slice(format.headerRow + 1)
        .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));

      return { sheetName, headers, columnIndex, rows, kind: format.kind, label: format.label };
    }
    attempts.push({ format, missing });
  }

  // Hiçbiri tutmadı: en az eksiği olan biçimi baz alıp anlamlı hata ver.
  attempts.sort((a, b) => a.missing.length - b.missing.length);
  const best = attempts[0];
  if (!best) throw new Error('Excel dosyası boş.');

  throw new Error(
    `Excel'de beklenen kolonlar bulunamadı: ${best.missing.join(', ')}. ` +
      'Trendyol "Siparişleriniz" veya "İadeleriniz" dosyasını olduğu gibi yükleyin.'
  );
}

/**
 * Satırları Sipariş Numarası'na göre gruplar.
 *
 * Bir sipariş tek kargo poşetiyle gider; siparişte 3 ürün varsa 3 ayrı kargo
 * değil tek kargo vardır. Bu yüzden desi sipariş bazında toplanır.
 *
 * mevcutDesi ve kargoTutari sipariş içinde sabittir (147.921 satırlık örnek
 * dosyada 0 istisna), bu yüzden ilk satırdan alınır.
 */
function groupByOrder({ rows, columnIndex, kind = FILE_KIND.ORDERS }) {
  // İade dosyasında Paket No / Marka kolonları yok; indeks tanımsız olunca
  // undefined dönsün, çağıran taraf boş stringe çevirsin.
  const at = (row, key) => (columnIndex[key] === undefined ? '' : row[columnIndex[key]]);
  const orders = new Map();

  for (const row of rows) {
    const siparisNo = parseOrderNo(at(row, 'siparisNo'));
    if (siparisNo === '') continue;

    let order = orders.get(siparisNo);
    if (!order) {
      order = {
        siparisNo,
        paketNo: String(at(row, 'paketNo') ?? '').trim(),
        siparisTarihi: parseOrderDate(at(row, 'siparisTarihi')),
        siparisTarihiRaw: String(at(row, 'siparisTarihi') ?? '').trim(),
        mevcutDesi: parseNumber(at(row, 'mevcutDesi')),
        kargoTutariRaw: String(at(row, 'kargoTutari') ?? '').trim(),
        kargoTutari: parseNumber(at(row, 'kargoTutari')),
        statu: String(at(row, 'statu') ?? '').trim(),
        marka: String(at(row, 'marka') ?? '').trim(),
        kind,
        items: [],
      };
      orders.set(siparisNo, order);
    }

    const adet = parseNumber(at(row, 'adet'));
    order.items.push({
      urunAdi: String(at(row, 'urunAdi') ?? '').trim(),
      stokKodu: String(at(row, 'stokKodu') ?? '').trim(),
      birimFiyat: parseNumber(at(row, 'birimFiyat')),
      // Adet okunamazsa 1 kabul edilir; ürünü tamamen düşürmek desiyi
      // olduğundan küçük gösterip hatalı itiraz üretirdi.
      adet: adet === null || adet <= 0 ? 1 : adet,
    });
  }

  return [...orders.values()];
}

/**
 * Bir siparişin hesaplanan desisini bulur.
 *
 * hamDesi   = Σ (adet × kategori ortalama desi)
 * hesapDesi = max(1, ceil(hamDesi))
 *
 * ceil: kargo firması yukarı yuvarlar (0.8 -> 1, 2.4 -> 3).
 * max(1): panel 1 desinin altını kabul etmiyor.
 */
function computeOrderDesi(order, categoryDesi, matchers, cache) {
  let hamDesi = 0;
  let unknownCategory = false;
  const breakdown = [];

  for (const item of order.items) {
    const matched = detectCategory(item.urunAdi, matchers, cache);
    const category = matched ?? FALLBACK_CATEGORY;
    if (matched === null) unknownCategory = true;

    const birimDesi = Number(categoryDesi[category]) || 0;
    hamDesi += item.adet * birimDesi;
    breakdown.push({ ...item, category, birimDesi, matched: matched !== null });
  }

  const hesapDesi = Math.max(1, Math.ceil(Number(hamDesi.toFixed(6))));
  return { hamDesi, hesapDesi, breakdown, unknownCategory };
}

/**
 * Filtre kurallarını uygulayıp itiraz edilecek siparişleri döndürür.
 *
 * Kurallar (PLAN §3 Adım 4) — hepsi geçilmeli:
 *  1. Fiyat: kargo tutarı sayısal ve <= eşik ise elenir. Faturalanmamış
 *     ("Henüz fatura kesilmemiştir.") olanlar dahil edilir. 13.07.2026'dan
 *     sonraki siparişlerde güncel eşik (115.67) uygulanır.
 *  2. Küçültme: yalnızca girilecek desi < mevcutDesi olanlar. Desi büyütme yok.
 *  3. Taban: mevcutDesi <= 1 olanlar elenir (indirilecek yer yok).
 *  4. Statü: iade edilenler varsayılan olarak elenir.
 *  5. Yükseltme: mevcutDesi 3'ün üstündeyken hesap 1 çıkarsa 2 girilir.
 *  6. Fark: mevcut ile girilecek arasında en az 2 fark olmalı; panel
 *     1 farklı itirazı (2 -> 1 gibi) kabul etmiyor.
 *
 * @param {object[]} orders  groupByOrder çıktısı
 * @param {object} options
 * @param {Record<string,number>} [options.categoryDesi]
 * @param {number} [options.priceThreshold]      13.07.2026 ve öncesi eşiği
 * @param {number} [options.priceThresholdNew]   13.07.2026 sonrası eşiği
 * @param {string} [options.priceChangeDate]     ISO tarih, varsayılan 2026-07-13
 * @param {number} [options.returnPriceThreshold] iade dosyası eşiği (93.05)
 * @param {boolean} [options.includeReturned]
 */
function computeClaims(orders, options = {}) {
  const categoryDesi = { ...DEFAULT_CATEGORY_DESI, ...(options.categoryDesi || {}) };
  const priceThreshold =
    options.priceThreshold === undefined || options.priceThreshold === null
      ? DEFAULT_PRICE_THRESHOLD
      : Number(options.priceThreshold);
  const includeReturned = options.includeReturned === true;

  // 13.07.2026 sonrası siparişlerde kargo fiyatı güncellendiği için
  // eşik de o tarihten sonrası için ayrı tutulur.
  const priceThresholdNew =
    options.priceThresholdNew === undefined || options.priceThresholdNew === null
      ? DEFAULT_PRICE_THRESHOLD_NEW
      : Number(options.priceThresholdNew);
  const priceChangeDate = options.priceChangeDate || DEFAULT_PRICE_CHANGE_DATE;

  // İade kargoları ayrı tarifeye tabi; tarih ayrımı yok, tek eşik.
  const returnPriceThreshold =
    options.returnPriceThreshold === undefined || options.returnPriceThreshold === null
      ? DEFAULT_RETURN_PRICE_THRESHOLD
      : Number(options.returnPriceThreshold);

  const matchers = buildCategoryMatchers(categoryDesi);
  // Aynı ürün adı on binlerce satırda tekrar ediyor; normalize + arama
  // maliyetini ürün adı başına bir kez ödemek için önbellek.
  const categoryCache = new Map();
  const claims = [];
  const stats = {
    toplamSiparis: orders.length,
    elenenFiyat: 0,
    elenenIade: 0,
    elenenTaban: 0,
    elenenKucultmeYok: 0,
    elenenYetersizFark: 0,
    yukseltilenIkiDesi: 0,
    kategoriBulunamayan: 0,
    itirazEdilecek: 0,
  };

  for (const order of orders) {
    // Kural 4 — statü. Yalnızca SİPARİŞ dosyasında anlamlı: orada "İade edildi"
    // satırı iade olmuş bir siparişi gösterir. İade dosyasında "Durum" iade
    // sürecinin aşamasıdır (Onaylandı/Kargolandı/...), zaten hepsi iadedir;
    // orada bu kuralı uygulamak dosyanın tamamını elerdi.
    if (
      order.kind !== FILE_KIND.RETURNS &&
      !includeReturned &&
      normalizeText(order.statu).includes('iade')
    ) {
      stats.elenenIade += 1;
      continue;
    }

    // Kural 1 — fiyat. null (faturalanmamış) dahil edilir.
    // 13.07.2026'dan SONRAKİ siparişlerde kargo fiyatı güncellendiği için
    // o siparişlere yeni eşik uygulanır.
    let esik;
    if (order.kind === FILE_KIND.RETURNS) {
      // İade kargoları ayrı tarifeye tabi; 13.07 fiyat güncellemesi onları
      // kapsamıyor, o yüzden tarih ayrımı yapılmaz.
      esik = returnPriceThreshold;
    } else {
      esik =
        order.siparisTarihi && order.siparisTarihi > priceChangeDate
          ? priceThresholdNew
          : priceThreshold;
    }
    if (order.kargoTutari !== null && order.kargoTutari <= esik) {
      stats.elenenFiyat += 1;
      continue;
    }

    // Kural 3 — taban. mevcutDesi okunamadıysa da karşılaştırma yapılamaz.
    if (order.mevcutDesi === null || order.mevcutDesi <= 1) {
      stats.elenenTaban += 1;
      continue;
    }

    const { hamDesi, hesapDesi, breakdown, unknownCategory } = computeOrderDesi(
      order,
      categoryDesi,
      matchers,
      categoryCache
    );

    // Kural 5 — mevcut desi 3'ün ÜSTÜNDEYSE (4 ve üzeri) ve hesap 1 çıktıysa,
    // itirazda 1 yerine 2 desi girilir. Yükseltme fark kontrolünden ÖNCE
    // yapılmalı, çünkü girilecek değer artık 2'dir.
    let girilecekDesi = hesapDesi;
    const ikiyeYukseltildi = hesapDesi === 1 && order.mevcutDesi > RAISE_TO_TWO_ABOVE;
    if (ikiyeYukseltildi) girilecekDesi = 2;

    // Kural 2 — yalnızca küçültme
    if (girilecekDesi >= order.mevcutDesi) {
      stats.elenenKucultmeYok += 1;
      continue;
    }

    // Kural 6 — panel 1 fark kabul etmiyor; en az 2 desi düşürebilmeliyiz.
    if (order.mevcutDesi - girilecekDesi < MIN_DESI_GAP) {
      stats.elenenYetersizFark += 1;
      continue;
    }

    if (unknownCategory) stats.kategoriBulunamayan += 1;
    if (ikiyeYukseltildi) stats.yukseltilenIkiDesi += 1;

    claims.push({
      siparisNo: order.siparisNo,
      paketNo: order.paketNo,
      marka: order.marka,
      statu: order.statu,
      siparisTarihi: order.siparisTarihi,
      siparisTarihiRaw: order.siparisTarihiRaw,
      mevcutDesi: order.mevcutDesi,
      // Panele girilecek değer. Kural 5 uygulandıysa ham hesaptan farklıdır.
      hesapDesi: girilecekDesi,
      hesaplananDesi: hesapDesi,
      ikiyeYukseltildi,
      hamDesi: Number(hamDesi.toFixed(2)),
      kargoTutari: order.kargoTutari,
      kargoTutariRaw: order.kargoTutariRaw,
      faturalanmamis: order.kargoTutari === null,
      unknownCategory,
      toplamAdet: breakdown.reduce((sum, item) => sum + item.adet, 0),
      items: breakdown,
    });
  }

  stats.itirazEdilecek = claims.length;
  // Büyük fark önce: en çok kazandıracak itirazlar listenin başında olsun.
  claims.sort((a, b) => b.mevcutDesi - b.hesapDesi - (a.mevcutDesi - a.hesapDesi));

  return { claims, stats };
}

/** Excel yolundan itiraz listesine kadar olan akışın tamamı. */
function analyzeFile(filePath, options = {}) {
  const workbook = readOrderWorkbook(filePath);
  const orders = groupByOrder(workbook);
  const { claims, stats } = computeClaims(orders, options);
  return {
    sheetName: workbook.sheetName,
    satirSayisi: workbook.rows.length,
    orders,
    claims,
    stats,
  };
}

/**
 * Ürünleri kategori bazında toplar: "Atlet x8".
 *
 * Aynı kategoriden farklı renk/beden ayrı satır olarak gelir; ham liste
 * "Atlet x2, Atlet x1, Atlet x1..." biçiminde okunur ve adetlerin toplandığı
 * görünmez. Hesap zaten toplam üzerinden yapılır, bu yalnızca gösterimdir.
 */
function summarizeItems(items) {
  const byCategory = new Map();
  for (const item of items ?? []) {
    byCategory.set(item.category, (byCategory.get(item.category) || 0) + item.adet);
  }
  return [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, adet]) => `${category} x${adet}`)
    .join(', ');
}

/** İtiraz listesini Excel'e yazar — kontrol/arşiv amaçlı. */
function exportClaims(filePath, claims) {
  const headers = [
    'Sipariş No',
    'Paket No',
    'Marka',
    'Statü',
    'Sipariş Tarihi',
    'Ürünler',
    'Toplam Adet',
    'Mevcut Desi',
    'Girilecek Desi',
    'Ham Hesap',
    'Fark',
    'Kargo Tutarı',
    'Kategori Bulunamadı',
  ];

  const body = claims.map((claim) => [
    claim.siparisNo,
    claim.paketNo,
    claim.marka,
    claim.statu,
    claim.siparisTarihiRaw || '',
    summarizeItems(claim.items),
    claim.toplamAdet,
    claim.mevcutDesi,
    claim.hesapDesi,
    claim.hesaplananDesi,
    claim.mevcutDesi - claim.hesapDesi,
    claim.faturalanmamis ? 'Henüz fatura kesilmemiştir.' : claim.kargoTutari,
    claim.unknownCategory ? 'Evet' : '',
  ]);

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...body]);
  sheet['!cols'] = headers.map((h) => ({ wch: h === 'Ürünler' ? 40 : 16 }));

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'İtirazlar');
  XLSX.writeFile(book, filePath);
  return filePath;
}

module.exports = {
  COLUMNS,
  RETURN_COLUMNS,
  FILE_FORMATS,
  FILE_KIND,
  DEFAULT_CATEGORY_DESI,
  DEFAULT_PRICE_THRESHOLD,
  DEFAULT_PRICE_THRESHOLD_NEW,
  DEFAULT_PRICE_CHANGE_DATE,
  DEFAULT_RETURN_PRICE_THRESHOLD,
  MIN_DESI_GAP,
  RAISE_TO_TWO_ABOVE,
  FALLBACK_CATEGORY,
  HEADER_ROW_INDEX,
  analyzeFile,
  buildCategoryMatchers,
  computeClaims,
  computeOrderDesi,
  detectCategory,
  exportClaims,
  groupByOrder,
  normalizeText,
  parseNumber,
  parseOrderDate,
  parseOrderNo,
  readOrderWorkbook,
  summarizeItems,
};
