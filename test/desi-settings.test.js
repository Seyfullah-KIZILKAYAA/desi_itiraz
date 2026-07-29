/**
 * Desi ayarlarının kalıcılığı — PLAN-desi-hesaplama.md §5.2
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DesiSettings, defaultSettings } = require('../src/core/desi-settings');
const { DEFAULT_PRICE_THRESHOLD } = require('../src/core/desi');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'desi-settings-'));
}

test('dosya yokken varsayılanlar döner', () => {
  const settings = new DesiSettings(tempDir());
  const read = settings.read();
  assert.equal(read.priceThreshold, DEFAULT_PRICE_THRESHOLD);
  assert.equal(read.includeReturned, false);
  assert.equal(read.categoryDesi['T-Shirt'], 0.2);
});

test('yazılan değerler geri okunur', () => {
  const settings = new DesiSettings(tempDir());
  settings.write({
    categoryDesi: { 'T-Shirt': 0.25 },
    priceThreshold: 120,
    includeReturned: true,
  });

  const read = settings.read();
  assert.equal(read.categoryDesi['T-Shirt'], 0.25);
  assert.equal(read.priceThreshold, 120);
  assert.equal(read.includeReturned, true);
});

test('kaydedilen ayar diğer kategorileri silmez', () => {
  const settings = new DesiSettings(tempDir());
  settings.write({ categoryDesi: { 'T-Shirt': 0.25 } });

  const read = settings.read();
  // Yalnızca T-Shirt gönderildi ama Pantolon varsayılanı durmalı.
  assert.equal(read.categoryDesi['T-Shirt'], 0.25);
  assert.equal(read.categoryDesi.Pantolon, 0.5);
});

test('virgüllü ondalık kabul edilir', () => {
  const settings = new DesiSettings(tempDir());
  const written = settings.write({ categoryDesi: { 'T-Shirt': '0,35' }, priceThreshold: '115,50' });
  assert.equal(written.categoryDesi['T-Shirt'], 0.35);
  assert.equal(written.priceThreshold, 115.5);
});

test('geçersiz desi değerleri varsayılana düşer', () => {
  const settings = new DesiSettings(tempDir());
  const written = settings.write({
    categoryDesi: { 'T-Shirt': 0, Pantolon: -1, Bluz: 'abc' },
  });
  // 0 desi siparişi olduğundan hafif gösterip hatalı itiraz üretirdi.
  assert.equal(written.categoryDesi['T-Shirt'], 0.2);
  assert.equal(written.categoryDesi.Pantolon, 0.5);
  assert.equal(written.categoryDesi.Bluz, 0.25);
});

test('bozuk dosya uygulamayı çökertmez, varsayılana döner', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'desi-settings.json'), '{ bozuk json', 'utf8');
  const read = new DesiSettings(dir).read();
  assert.deepEqual(read, defaultSettings());
});

test('güncel fiyat eşiği ve tarihi kaydedilir', () => {
  const settings = new DesiSettings(tempDir());
  const written = settings.write({ priceThresholdNew: '118,50', priceChangeDate: '20.07.2026' });
  assert.equal(written.priceThresholdNew, 118.5);
  // Nokta ayraçlı tarih ISO'ya çevrilir.
  assert.equal(written.priceChangeDate, '2026-07-20');
});

test('geçersiz tarih varsayılana döner', () => {
  const settings = new DesiSettings(tempDir());
  const written = settings.write({ priceChangeDate: 'abc' });
  assert.equal(written.priceChangeDate, '2026-07-13');
});

test('varsayılan güncel eşik 115.67', () => {
  const read = new DesiSettings(tempDir()).read();
  assert.equal(read.priceThresholdNew, 115.67);
  assert.equal(read.priceChangeDate, '2026-07-13');
});

test('reset kayıtlı ayarları siler', () => {
  const settings = new DesiSettings(tempDir());
  settings.write({ priceThreshold: 200 });
  assert.equal(settings.read().priceThreshold, 200);

  settings.reset();
  assert.equal(settings.read().priceThreshold, DEFAULT_PRICE_THRESHOLD);
});
