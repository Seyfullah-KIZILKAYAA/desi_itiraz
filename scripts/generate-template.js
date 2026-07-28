#!/usr/bin/env node
/**
 * Desi itirazı Excel şablonunu üretir.
 *
 * Çıktı iki sayfalıdır:
 *   "İtirazlar" — kullanıcının veri gireceği asıl sayfa
 *   "Açıklama"  — kolon kuralları ve durum listesi (ayrı doküman gerekmesin diye)
 *
 * Kullanım: node scripts/generate-template.js
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_SHEET = 'İtirazlar';
const INFO_SHEET = 'Açıklama';

// Zorunlu kolonlar önce; opsiyoneller sonra.
const HEADERS = ['Sipariş No', 'Doğru Desi', 'İtiraz Sebebi', 'Açıklama'];

// Örnek satırlar — kullanıcı bunları silip kendi verisini girer.
// Sadece ilk iki kolon zorunludur; son iki kolon boş bırakılabilir.
const SAMPLE_ROWS = [
  ['123456789', 3, '', ''],
  ['987654321', 1.5, '', ''],
  ['555666777', 5, '', ''],
];

/** Açıklama sayfası: [başlık, ...satırlar] blokları */
const INFO_BLOCKS = [
  ['DESİ İTİRAZ ŞABLONU', ''],
  ['', ''],
  ['Veri girişi "İtirazlar" sayfasına yapılır. Bu sayfa yalnızca açıklamadır.', ''],
  ['Başlık satırına dokunmayın; veri 2. satırdan başlar.', ''],
  ['', ''],

  ['ZORUNLU KOLONLAR', ''],
  ['Kolon', 'Kural'],
  [
    'Sipariş No',
    'Sipariş veya paket numarası. Hücre METİN formatında olmalı — ' +
      'sayı formatında uzun numaralar 1,23457E+11 gibi görünür ve baştaki sıfırlar kaybolur. ' +
      'Bu şablonda kolon zaten metin formatlıdır.',
  ],
  [
    'Doğru Desi',
    'Sayı. Ondalık ayırıcı olarak hem virgül (1,5) hem nokta (1.5) kabul edilir.',
  ],
  ['', ''],

  ['OPSİYONEL KOLONLAR', ''],
  ['Kolon', 'Kural'],
  [
    'İtiraz Sebebi',
    'Boş bırakılabilir. Tek bir itiraz kaydıyla çalışıyorsanız sebep zaten ' +
      'kaydın içinde sabittir, burada tekrar yazmaya gerek yoktur. ' +
      'Yalnızca BİRDEN FAZLA itiraz kaydınız varsa ve hangi satırın hangi ' +
      'kaydı kullanacağını belirtmek istiyorsanız doldurun. O durumda ' +
      'Trendyol panelindeki seçenek metniyle birebir aynı yazılmalıdır.',
  ],
  [
    'Açıklama',
    'Boş bırakılabilir. Form bazı itirazlarda açıklama istiyor, bazılarında ' +
      'istemiyor. Boş olması satırı hataya düşürmez. Form o sipariş için ' +
      'açıklama isterse ve hücre boşsa, ilgili adım kayıtta "opsiyonel" ' +
      'işaretlendiği sürece atlanır.',
  ],
  ['', ''],

  ['HANGİ KAYIT KULLANILIR?', ''],
  ['Durum', 'Sonuç'],
  ['Tek itiraz kaydı var', 'Sebep boş olsa da o kayıt kullanılır.'],
  [
    'Birden fazla itiraz kaydı var',
    'Çalıştır ekranından hangisinin kullanılacağını seçin, ya da ' +
      'İtiraz Sebebi kolonunu doldurup her kayda "Sebep Ata" yapın.',
  ],
  ['', ''],

  ['KAPSAM DIŞI KOLONLAR', ''],
  ['Kayıt Adı', 'Tek Kayıt varken gereksiz. İkinci bir Kayıt oluşturulunca eklenecek.'],
  ['', ''],

  ['İÇE AKTARMA DOĞRULAMASI', ''],
  ['Durum', 'Ne zaman oluşur'],
  ['Eksik veri', 'Zorunlu bir hücre boş, veya Doğru Desi sayıya çevrilemiyor. Satır çalıştırılmaz.'],
  ['Eşleşme bulunamadı', 'Satır için uygun bir Kayıt yok. Satır çalıştırılmaz, tahmin edilmez.'],
  ['Başarılı', 'İtiraz gönderildi ve onay ekranına ulaşıldı.'],
  ['Başarısız', 'Zorunlu bir adım başarısız oldu. Diğer satırlar çalışmaya devam eder.'],
  ['', ''],

  ['NOT', ''],
  ['Aynı sipariş numarası birden fazla satırda varsa uyarı verilir, ancak engellenmez.', ''],
];

const outDir = path.join(__dirname, '..', 'templates');
const outFile = path.join(outDir, 'desi_itiraz_sablonu.xlsx');

// --- Veri sayfası ---

const dataSheet = XLSX.utils.aoa_to_sheet([HEADERS, ...SAMPLE_ROWS]);

// Sipariş No kolonu metin olmalı (yukarıdaki gerekçe).
for (let r = 1; r <= SAMPLE_ROWS.length; r++) {
  const cell = dataSheet[XLSX.utils.encode_cell({ r, c: 0 })];
  if (cell) {
    cell.t = 's';
    cell.z = '@';
  }
}

dataSheet['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 26 }, { wch: 34 }];

// --- Açıklama sayfası ---

const infoSheet = XLSX.utils.aoa_to_sheet(INFO_BLOCKS);
infoSheet['!cols'] = [{ wch: 24 }, { wch: 95 }];

// Uzun açıklama metinleri hücrede kaydırılsın, tek satırda taşmasın.
for (let r = 0; r < INFO_BLOCKS.length; r++) {
  const cell = infoSheet[XLSX.utils.encode_cell({ r, c: 1 })];
  if (cell) cell.s = { alignment: { wrapText: true, vertical: 'top' } };
}

// --- Yazma ---

const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, dataSheet, DATA_SHEET);
XLSX.utils.book_append_sheet(book, infoSheet, INFO_SHEET);

fs.mkdirSync(outDir, { recursive: true });
XLSX.writeFile(book, outFile);

console.log(`Şablon oluşturuldu: ${outFile}`);
console.log(`  Sayfa 1: ${DATA_SHEET} (veri girişi)`);
console.log(`  Sayfa 2: ${INFO_SHEET} (kurallar)`);
