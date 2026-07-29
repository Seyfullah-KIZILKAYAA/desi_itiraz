/**
 * Desi itiraz hesaplama testleri — PLAN-desi-hesaplama.md §5.5
 */

const test = require('node:test');
const assert = require('node:assert');

const desi = require('../src/core/desi');

const { DEFAULT_CATEGORY_DESI, FALLBACK_CATEGORY } = desi;
const matchers = desi.buildCategoryMatchers(DEFAULT_CATEGORY_DESI);

/** Test siparişi kurar; alanların hepsi tek tek yazılmasın diye. */
function order(overrides = {}) {
  return {
    siparisNo: '1',
    paketNo: 'P1',
    marka: 'GRIMELANGE',
    statu: 'Teslim Edildi',
    mevcutDesi: 3,
    siparisTarihi: '2026-06-28',
    siparisTarihiRaw: '28.06.2026 00:00',
    kargoTutari: 122.39,
    kargoTutariRaw: '122.39',
    items: [{ urunAdi: 'Erkek Bisiklet Yaka T-Shirt', adet: 1, stokKodu: '', birimFiyat: 100 }],
    ...overrides,
  };
}

/** Tek üründen oluşan sipariş kısayolu. */
function withItems(items, overrides = {}) {
  return order({ items: items.map((i) => ({ birimFiyat: 100, stokKodu: '', ...i })), ...overrides });
}

// ---------------------------------------------------------------- kategori

test('kategori: en spesifik eşleşme kazanır — Polo Yaka T-shirt, T-Shirt değil', () => {
  assert.equal(
    desi.detectCategory('GRIMELANGE Erkek Polo Yaka T-shirt Lacivert', matchers),
    'Polo Yaka T-shirt'
  );
});

test('kategori: Büyük Beden T-Shirt kendi kategorisine düşer', () => {
  assert.equal(
    desi.detectCategory('Kadın Büyük Beden T-Shirt Siyah', matchers),
    'Büyük Beden T-Shirt'
  );
});

test('kategori: düz T-Shirt genel kategoriye düşer', () => {
  assert.equal(desi.detectCategory('JETT Erkek Oversize Fit T-Shirt XL', matchers), 'T-Shirt');
});

test('kategori: Türkçe karakterler ve yazım farkları tolere edilir', () => {
  assert.equal(desi.detectCategory('Kadın Sort & Bermuda Bej', matchers), 'Şort & Bermuda');
  assert.equal(desi.detectCategory('Erkek ESOFMAN ALTI Gri', matchers), 'Eşofman Altı');
});

test('kategori: tanınmayan ürün null döner', () => {
  assert.equal(desi.detectCategory('Bilinmeyen Aksesuar Kolye', matchers), null);
});

// ------------------------------------------------------------ desi hesabı

test('kullanıcının örneği: 4 tişört = 0.8 desi -> yukarı yuvarlanır, 1 desi', () => {
  const result = desi.computeOrderDesi(
    withItems([{ urunAdi: 'Erkek T-Shirt Siyah', adet: 4 }]),
    DEFAULT_CATEGORY_DESI,
    matchers
  );
  assert.equal(result.hamDesi.toFixed(2), '0.80');
  assert.equal(result.hesapDesi, 1);
});

test('1 desi taban: tek çorap 0.05 desi olsa da 1 desiye yuvarlanır', () => {
  const result = desi.computeOrderDesi(
    withItems([{ urunAdi: 'Erkek Çorap', adet: 1 }]),
    DEFAULT_CATEGORY_DESI,
    matchers
  );
  assert.equal(result.hesapDesi, 1);
});

test('karışık sipariş: 2 tişört + 1 pantolon = 0.9 -> 1 desi', () => {
  const result = desi.computeOrderDesi(
    withItems([
      { urunAdi: 'Erkek T-Shirt', adet: 2 },
      { urunAdi: 'Erkek Pantolon', adet: 1 },
    ]),
    DEFAULT_CATEGORY_DESI,
    matchers
  );
  assert.equal(result.hamDesi.toFixed(2), '0.90');
  assert.equal(result.hesapDesi, 1);
});

test('yukarı yuvarlama: 2.4 desi -> 3 desi', () => {
  // 8 pantolon x 0.5 = 4.0 ; 1 tişört x 0.2 = 0.2 -> 4.2 -> 5
  const result = desi.computeOrderDesi(
    withItems([
      { urunAdi: 'Erkek Pantolon', adet: 8 },
      { urunAdi: 'Erkek T-Shirt', adet: 1 },
    ]),
    DEFAULT_CATEGORY_DESI,
    matchers
  );
  assert.equal(result.hamDesi.toFixed(2), '4.20');
  assert.equal(result.hesapDesi, 5);
});

test('kategori bulunamayınca Diğer varsayılanı kullanılır ve işaretlenir', () => {
  const result = desi.computeOrderDesi(
    withItems([{ urunAdi: 'Bilinmeyen Aksesuar', adet: 1 }]),
    DEFAULT_CATEGORY_DESI,
    matchers
  );
  assert.equal(result.unknownCategory, true);
  assert.equal(result.breakdown[0].category, FALLBACK_CATEGORY);
});

// --------------------------------------------------------- fiyat kuralı

test('fiyat: 110.39 dahil edilmez (eşik ve altı elenir)', () => {
  const { claims, stats } = desi.computeClaims([order({ kargoTutari: 110.39 })]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenFiyat, 1);
});

test('fiyat: 105.49 elenir', () => {
  const { claims } = desi.computeClaims([order({ kargoTutari: 105.49 })]);
  assert.equal(claims.length, 0);
});

test('fiyat: 122.39 eşiğin üstünde, kalır', () => {
  const { claims } = desi.computeClaims([order({ kargoTutari: 122.39 })]);
  assert.equal(claims.length, 1);
});

test('fiyat: faturalanmamış siparişler dahil edilir', () => {
  const { claims } = desi.computeClaims([
    order({ kargoTutari: null, kargoTutariRaw: 'Henüz fatura kesilmemiştir.' }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].faturalanmamis, true);
});

test('fiyat: eşik ayardan değiştirilebilir', () => {
  const { claims } = desi.computeClaims([order({ kargoTutari: 105.49 })], {
    priceThreshold: 100,
  });
  assert.equal(claims.length, 1);
});

// ----------------------------------------------------- küçültme kuralı

test('küçültme yok: hesaplanan desi mevcuda eşitse elenir', () => {
  // 4 pantolon x 0.5 = 2.0 -> 2 desi, mevcut da 2
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek Pantolon', adet: 4 }], { mevcutDesi: 2 }),
  ]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenKucultmeYok, 1);
});

test('küçültme yok: hesaplanan desi mevcuttan büyükse elenir (desi büyütme yok)', () => {
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek Pantolon', adet: 10 }], { mevcutDesi: 2 }),
  ]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenKucultmeYok, 1);
});

test('küçültme var: 3 desi yazılmış, 1 desi hesaplanmış -> itiraz', () => {
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 3 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].mevcutDesi, 3);
  assert.equal(claims[0].hesapDesi, 1);
});

// --------------------------- kural 5: 1 desi -> 2 desiye yükseltme

test('yükseltme: mevcut 4, hesap 1 -> itirazda 2 desi girilir', () => {
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 4 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].hesaplananDesi, 1, 'ham hesap 1 olmalı');
  assert.equal(claims[0].hesapDesi, 2, 'girilecek değer 2 olmalı');
  assert.equal(claims[0].ikiyeYukseltildi, true);
  assert.equal(stats.yukseltilenIkiDesi, 1);
});

test('yükseltme: mevcut 3 sınıra dahil değil, 1 olarak kalır', () => {
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 3 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].hesapDesi, 1);
  assert.equal(claims[0].ikiyeYukseltildi, false);
});

test('yükseltme: hesap zaten 2 ise dokunulmaz', () => {
  // 4 pantolon x 0.5 = 2.0 -> 2 desi, mevcut 5
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek Pantolon', adet: 4 }], { mevcutDesi: 5 }),
  ]);
  assert.equal(claims[0].hesapDesi, 2);
  assert.equal(claims[0].ikiyeYukseltildi, false);
});

// ------------------------- kural 6: en az 2 desi fark olmalı

test('fark: 2 -> 1 itirazı yapılamaz, elenir', () => {
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 2 }),
  ]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenYetersizFark, 1);
});

test('fark: 3 -> 2 itirazı yapılamaz, elenir', () => {
  // 4 pantolon x 0.5 = 2.0 -> 2 desi, mevcut 3 -> fark 1
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek Pantolon', adet: 4 }], { mevcutDesi: 3 }),
  ]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenYetersizFark, 1);
});

test('fark: 3 -> 1 iki fark var, itiraz edilir', () => {
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 3 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].mevcutDesi - claims[0].hesapDesi, 2);
});

test('fark: yükseltme sonrası fark yetersiz kalırsa elenir', () => {
  // mevcut 4, hesap 1 -> yükseltme ile 2 -> fark 2, tam sınırda geçer
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { mevcutDesi: 4 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].hesapDesi, 2);
});

// ------------------- kural 1b: 13.07.2026 sonrası güncel fiyat

test('tarih: 13.07.2026 sonrası sipariş için yeni eşik (115.67) uygulanır', () => {
  const { claims, stats } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], {
      mevcutDesi: 3,
      siparisTarihi: '2026-07-20',
      kargoTutari: 115.67,
    }),
  ]);
  assert.equal(claims.length, 0, '115.67 yeni eşiğe eşit, elenmeli');
  assert.equal(stats.elenenFiyat, 1);
});

test('tarih: 13.07.2026 sonrası 115.67 üstü kalır', () => {
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], {
      mevcutDesi: 3,
      siparisTarihi: '2026-07-20',
      kargoTutari: 122.39,
    }),
  ]);
  assert.equal(claims.length, 1);
});

test('tarih: 13.07.2026 ve öncesi eski eşiğe (110.39) tabidir', () => {
  // 13.07 tam sınır — "sonrası" dendiği için 13'ü eski eşikte kalır.
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], {
      mevcutDesi: 3,
      siparisTarihi: '2026-07-13',
      kargoTutari: 112.0,
    }),
  ]);
  assert.equal(claims.length, 1, '112 eski eşiğin üstünde, kalmalı');
});

test('tarih: eski tarihli sipariş 115.67 ile itiraza girer', () => {
  const { claims } = desi.computeClaims([
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], {
      mevcutDesi: 3,
      siparisTarihi: '2026-06-28',
      kargoTutari: 115.67,
    }),
  ]);
  assert.equal(claims.length, 1, 'eski eşik 110.39, 115.67 üstünde');
});

test('parseOrderDate: nokta ayraçlı Trendyol biçimi', () => {
  assert.equal(desi.parseOrderDate('28.06.2026 00:00'), '2026-06-28');
  assert.equal(desi.parseOrderDate('5.7.2026'), '2026-07-05');
  assert.equal(desi.parseOrderDate('2026-07-13 10:00'), '2026-07-13');
  assert.equal(desi.parseOrderDate(''), null);
});

// -------------------------------------------------------- taban kuralı

test('taban: mevcut desi 1 ise elenir (indirilecek yer yok)', () => {
  const { claims, stats } = desi.computeClaims([order({ mevcutDesi: 1 })]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenTaban, 1);
});

test('taban: mevcut desi okunamazsa elenir', () => {
  const { claims, stats } = desi.computeClaims([order({ mevcutDesi: null })]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenTaban, 1);
});

// -------------------------------------------------------- statü kuralı

test('statü: iade edilen siparişler varsayılan olarak elenir', () => {
  const { claims, stats } = desi.computeClaims([order({ statu: 'İade edildi' })]);
  assert.equal(claims.length, 0);
  assert.equal(stats.elenenIade, 1);
});

test('statü: includeReturned ile iade edilenler dahil edilir', () => {
  const { claims } = desi.computeClaims([order({ statu: 'İade edildi' })], {
    includeReturned: true,
  });
  assert.equal(claims.length, 1);
});

// ------------------------------------------------------------ gruplama

test('gruplama: çok satırlı sipariş tek itiraz olur, desiler toplanır', () => {
  const columnIndex = {
    siparisNo: 0,
    paketNo: 1,
    urunAdi: 2,
    adet: 3,
    mevcutDesi: 4,
    kargoTutari: 5,
    statu: 6,
    birimFiyat: 7,
    marka: 8,
    stokKodu: 9,
  };
  const rows = [
    ['11363394944', '395', 'Erkek T-Shirt', '2', '3.0', '122.39', 'Teslim Edildi', '100', 'M', 'S1'],
    ['11363394944', '395', 'Erkek Pantolon', '1', '3.0', '122.39', 'Teslim Edildi', '200', 'M', 'S2'],
    ['11363394944', '395', 'Erkek Çorap', '1', '3.0', '122.39', 'Teslim Edildi', '30', 'M', 'S3'],
    ['99999999999', '396', 'Kadın Elbise', '1', '2.0', '122.39', 'Teslim Edildi', '300', 'M', 'S4'],
  ];

  const orders = desi.groupByOrder({ rows, columnIndex });
  assert.equal(orders.length, 2);

  const multi = orders.find((o) => o.siparisNo === '11363394944');
  assert.equal(multi.items.length, 3);
  assert.equal(multi.mevcutDesi, 3);

  // 2x0.2 + 1x0.5 + 1x0.05 = 0.95 -> 1 desi
  const result = desi.computeOrderDesi(multi, DEFAULT_CATEGORY_DESI, matchers);
  assert.equal(result.hamDesi.toFixed(2), '0.95');
  assert.equal(result.hesapDesi, 1);

  // Çok satırlı sipariş tek itiraz olur (3 -> 1, fark 2 yeterli).
  // İkinci sipariş 2 -> 1 olduğu için fark kuralında elenir.
  const { claims } = desi.computeClaims(orders);
  assert.equal(claims.length, 1);
  const claim = claims[0];
  assert.equal(claim.siparisNo, '11363394944');
  assert.equal(claim.toplamAdet, 4);
  assert.equal(claim.hesapDesi, 1);
  assert.equal(claim.mevcutDesi, 3);
});

test('gruplama: adet okunamazsa 1 kabul edilir', () => {
  const columnIndex = {
    siparisNo: 0,
    paketNo: 1,
    urunAdi: 2,
    adet: 3,
    mevcutDesi: 4,
    kargoTutari: 5,
    statu: 6,
    birimFiyat: 7,
    marka: 8,
    stokKodu: 9,
  };
  const rows = [['1', 'P', 'Erkek T-Shirt', '', '3.0', '122.39', 'Teslim Edildi', '', '', '']];
  const orders = desi.groupByOrder({ rows, columnIndex });
  assert.equal(orders[0].items[0].adet, 1);
});

// ------------------------------------------------------------ yardımcı

test('parseNumber: virgüllü ondalık ve faturalanmamış metni', () => {
  assert.equal(desi.parseNumber('110,39'), 110.39);
  assert.equal(desi.parseNumber('110.39'), 110.39);
  assert.equal(desi.parseNumber('Henüz fatura kesilmemiştir.'), null);
  assert.equal(desi.parseNumber(''), null);
});

test('parseOrderNo: bilimsel gösterime düşmüş numarayı düzeltir', () => {
  assert.equal(desi.parseOrderNo(11363394944), '11363394944');
  assert.equal(desi.parseOrderNo(' 11363394944 '), '11363394944');
});

test('istatistikler her elenen siparişi sayar', () => {
  const { stats } = desi.computeClaims([
    order({ siparisNo: 'a', kargoTutari: 100 }),
    order({ siparisNo: 'b', statu: 'İade edildi' }),
    order({ siparisNo: 'c', mevcutDesi: 1 }),
    withItems([{ urunAdi: 'Erkek Pantolon', adet: 10 }], { siparisNo: 'd', mevcutDesi: 2 }),
    withItems([{ urunAdi: 'Erkek T-Shirt', adet: 4 }], { siparisNo: 'e', mevcutDesi: 3 }),
  ]);
  assert.deepEqual(stats, {
    toplamSiparis: 5,
    elenenFiyat: 1,
    elenenIade: 1,
    elenenTaban: 1,
    elenenKucultmeYok: 1,
    elenenYetersizFark: 0,
    yukseltilenIkiDesi: 0,
    kategoriBulunamayan: 0,
    itirazEdilecek: 1,
  });
});
