/**
 * Seçici motoru testleri.
 *
 * extension/selectors.js tarayıcı içinde çalışır; burada asgari bir DOM
 * taklidi kurup dosyayı o bağlamda değerlendiriyoruz. Böylece seçici
 * öncelik sırası (spec §4.4) Chrome olmadan doğrulanabiliyor.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'selectors.js'), 'utf8');

/**
 * Çok basit bir DOM taklidi. Gerçek tarayıcı değil; yalnızca
 * buildStrategies'in attribute okuma ve öncelik sırası davranışını sınar.
 */
function fakeElement({ tag = 'BUTTON', attrs = {}, text = '', id = '' } = {}) {
  return {
    nodeType: 1,
    tagName: tag,
    id,
    innerText: text,
    textContent: text,
    getAttribute: (name) => attrs[name] ?? null,
    parentElement: null,
  };
}

/** selectors.js'i sahte bir window/document ile yükler. */
function loadSelectors() {
  const sandbox = {
    window: {},
    document: {
      documentElement: {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout,
    Date,
    CSS: { escape: (v) => String(v) },
  };
  sandbox.window.CSS = sandbox.CSS;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox.window.__desiSelectors;
}

const S = loadSelectors();

test('data-testid en yüksek önceliklidir', () => {
  const el = fakeElement({
    attrs: { 'data-testid': 'objection-button', name: 'x', 'aria-label': 'y' },
    id: 'stableId',
    text: 'İtiraz Et',
  });
  const strategies = S.buildStrategies(el);
  assert.equal(strategies[0].type, 'testAttr');
  assert.equal(strategies[0].attr, 'data-testid');
  assert.equal(strategies[0].value, 'objection-button');
});

test('stratejiler öncelik sırasına göre dizilir', () => {
  const el = fakeElement({
    attrs: { 'data-testid': 'a', name: 'b', 'aria-label': 'c' },
    id: 'kararliId',
    text: 'Gönder',
  });
  const types = S.buildStrategies(el).map((s) => s.type);
  assert.deepEqual(types.slice(0, 5), ['testAttr', 'id', 'name', 'text', 'ariaLabel']);
});

test('otomatik üretilmiş idler reddedilir', () => {
  assert.equal(S.isStableId(':r3:'), false, 'React useId');
  assert.equal(S.isStableId('a3f9e10bc4d7'), false, 'hash benzeri');
  assert.equal(S.isStableId('12345'), false, 'salt sayı');
  assert.equal(S.isStableId('mui-4821'), false, 'kütüphane + sayı');
  assert.equal(S.isStableId('x'.repeat(50)), false, 'aşırı uzun');

  assert.equal(S.isStableId('submit-objection'), true);
  assert.equal(S.isStableId('siparisNo'), true);
});

test('gömülü React auto-id reddedilir', () => {
  // Trendyol panelinde gerçekten görülen biçim; sayfa her yenilendiğinde
  // r87 sayısı değişir, bu yüzden seçici olarak kullanılamaz.
  assert.equal(S.isStableId('tabs::r87::trigger-ALL'), false);
  assert.equal(S.isStableId('radix-:r1a:-content'), false);

  // Benzer görünen ama kararlı olanlar kabul edilmeli.
  assert.equal(S.isStableId('tabs-trigger-ALL'), true);
  assert.equal(S.isStableId('order-row'), true);
});

test('otomatik id strateji listesine girmez', () => {
  const el = fakeElement({ id: ':r7:', text: 'Kaydet' });
  const types = S.buildStrategies(el).map((s) => s.type);
  assert.ok(!types.includes('id'), 'React auto id kullanılmamalı');
});

test('metin stratejisi butonlar için üretilir', () => {
  const el = fakeElement({ tag: 'BUTTON', text: '  İtiraz   Et  ' });
  const text = S.buildStrategies(el).find((s) => s.type === 'text');
  assert.equal(text.value, 'İtiraz Et', 'boşluklar sadeleşmeli');
});

test('çok uzun metin stratejiye dönüşmez', () => {
  const el = fakeElement({ tag: 'BUTTON', text: 'x'.repeat(120) });
  const types = S.buildStrategies(el).map((s) => s.type);
  assert.ok(!types.includes('text'));
});

test('hiçbir strateji koordinat içermez', () => {
  const el = fakeElement({
    attrs: { 'data-testid': 'a', name: 'b', 'aria-label': 'c' },
    id: 'kararli',
    text: 'Gönder',
  });
  const serialized = JSON.stringify(S.buildStrategies(el));
  for (const banned of ['clientX', 'clientY', 'pageX', 'pageY', '"x"', '"y"']) {
    assert.ok(!serialized.includes(banned), `koordinat sızmış: ${banned}`);
  }
});

test('boş/geçersiz eleman güvenle boş liste döner', () => {
  assert.deepEqual(S.buildStrategies(null), []);
  assert.deepEqual(S.buildStrategies({ nodeType: 3 }), []);
});

// ---------- Adres karşılaştırması ----------
// content.js'deki isSameLocation ile aynı mantık; navigate adımının gereksiz
// yeniden yükleme yapmaması ve gerekliyi atlamaması için kritik.

function isSameLocation(current, target) {
  try {
    const a = new URL(current);
    const b = new URL(target, current);
    const norm = (p) => p.replace(/\/+$/, '').toLowerCase();
    return a.host === b.host && norm(a.pathname) === norm(b.pathname);
  } catch {
    return current === target;
  }
}

test('aynı sayfa farklı sorgu parametresiyle aynı sayılır', () => {
  assert.equal(
    isSameLocation(
      'https://partner.trendyol.com/orders?page=2',
      'https://partner.trendyol.com/orders'
    ),
    true,
    'panel kendi parametresini eklemiş olabilir'
  );
});

test('sondaki eğik çizgi fark yaratmaz', () => {
  assert.equal(
    isSameLocation('https://partner.trendyol.com/orders/', 'https://partner.trendyol.com/orders'),
    true
  );
});

test('farklı sayfa farklı sayılır', () => {
  assert.equal(
    isSameLocation(
      'https://partner.trendyol.com/orders',
      'https://partner.trendyol.com/shipments'
    ),
    false,
    'gerçekten gidilmesi gereken adres atlanmamalı'
  );
});

test('farklı alan adı farklı sayılır', () => {
  assert.equal(
    isSameLocation('https://baska.com/orders', 'https://partner.trendyol.com/orders'),
    false
  );
});
