/**
 * Çekirdek mantık testleri — Chrome/Electron olmadan çalışır.
 * Köprü sahte (fake) bir nesneyle değiştirilir.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { substituteDeep, substituteText, collectVariables } = require('../src/shared/variables');
const { RecordingLibrary } = require('../src/core/recordings');
const { Player } = require('../src/core/player');
const { RowStatus, StepStatus, Action } = require('../src/shared/protocol');
const excel = require('../src/core/excel');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'desi-test-'));
}

/** İstenen adımlarda başarısız olan sahte köprü. */
function fakeBridge({ failOn = [] } = {}) {
  const seen = [];
  return {
    seen,
    async executeStep(step) {
      seen.push(step);
      if (failOn.includes(step.stepId)) {
        return { status: StepStatus.FAILED, detail: 'element bulunamadı' };
      }
      return { status: StepStatus.OK };
    },
  };
}

// ---------- Değişkenler ----------

test('substituteText yer tutucuyu değiştirir', () => {
  assert.equal(substituteText('no={{siparisNo}}', { siparisNo: '123' }), 'no=123');
});

test('substituteText karşılığı olmayan değişkende hata verir', () => {
  assert.throws(() => substituteText('{{yok}}', {}), /karşılığı yok/);
});

test('substituteDeep iç içe nesnelerde çalışır', () => {
  const step = {
    action: 'click',
    selector: { strategies: [{ type: 'text', value: 'Sipariş {{siparisNo}}' }] },
  };
  const out = substituteDeep(step, { siparisNo: '999' });
  assert.equal(out.selector.strategies[0].value, 'Sipariş 999');
});

test('collectVariables kullanılan tüm değişkenleri bulur', () => {
  const found = collectVariables([{ a: '{{x}}' }, { b: ['{{y}}', '{{x}}'] }]);
  assert.deepEqual([...found].sort(), ['x', 'y']);
});

// ---------- Kayıt Kitaplığı ----------

test('sıralı ad artar ve silme sonrası tekrar kullanılmaz', () => {
  const library = new RecordingLibrary(tempDir());
  const first = library.create('trendyol');
  const second = library.create('trendyol');
  assert.equal(first.sequentialName, 'Kayıt 1');
  assert.equal(second.sequentialName, 'Kayıt 2');

  library.delete(second.recordingId);
  const third = library.create('trendyol');
  assert.equal(third.sequentialName, 'Kayıt 3', 'silinen numara tekrar kullanılmamalı');
});

test('sıralı ad panel başına ayrı sayar', () => {
  const library = new RecordingLibrary(tempDir());
  library.create('trendyol');
  const other = library.create('hepsiburada');
  assert.equal(other.sequentialName, 'Kayıt 1');
});

test('yeniden adlandırma sıralı adı bozmaz', () => {
  const library = new RecordingLibrary(tempDir());
  const rec = library.create('trendyol');
  const renamed = library.rename(rec.recordingId, 'Kayıt 1 - Yanlış desi');
  assert.equal(renamed.sequentialName, 'Kayıt 1');
  assert.equal(renamed.customLabel, 'Kayıt 1 - Yanlış desi');
});

test('eşleşme: Kayıt Adı kolonu önceliklidir', () => {
  const library = new RecordingLibrary(tempDir());
  const rec = library.create('trendyol');
  library.rename(rec.recordingId, 'Desi İtirazı');

  const matched = library.match(
    { recordingName: 'Desi İtirazı', values: {} },
    'trendyol'
  );
  assert.equal(matched.recordingId, rec.recordingId);
});

test('eski kayıttaki eskimiş required değeri okunurken düzeltilir', () => {
  const dir = tempDir();
  const library = new RecordingLibrary(dir);
  const rec = library.create('trendyol');

  // itirazSebebi zorunlu olmaktan çıkmadan ÖNCE kaydedilmiş bir dosyayı taklit et.
  const file = path.join(dir, 'recordings', `${rec.recordingId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.variables = raw.variables.map((v) =>
    v.key === 'itirazSebebi' ? { ...v, required: true } : v
  );
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

  const loaded = library.get(rec.recordingId);
  const reason = loaded.variables.find((v) => v.key === 'itirazSebebi');
  assert.equal(reason.required, false, 'kod tanımı diskteki eski değeri ezmeli');
});

test('eski kayıt Player tarafından Eksik veri sayılmaz', async () => {
  const dir = tempDir();
  const library = new RecordingLibrary(dir);
  const rec = buildRecording(library, OK_STEPS);

  // Diski eski hâle çevir.
  const file = path.join(dir, 'recordings', `${rec.recordingId}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.variables = raw.variables.map((v) =>
    v.key === 'itirazSebebi' ? { ...v, required: true } : v
  );
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

  const player = new Player({ bridge: fakeBridge(), library });
  const queue = [queueRow({ siparisNo: '123', dogruDesi: '3', itirazSebebi: '' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS, 'boş sebep satırı düşürmemeli');
});

test('eşleşme: sebep boş ve tek kayıt varsa o kayıt kullanılır', () => {
  const library = new RecordingLibrary(tempDir());
  const rec = library.create('trendyol');
  library.save(rec);

  const matched = library.match(
    { recordingName: '', values: { itirazSebebi: '' } },
    'trendyol'
  );
  assert.equal(matched?.recordingId, rec.recordingId, 'sebep zorunlu olmamalı');
});

test('eşleşme: sebep boş ve birden fazla kayıt varsa tahmin yapmaz', () => {
  const library = new RecordingLibrary(tempDir());
  library.save(library.create('trendyol'));
  library.save(library.create('trendyol'));

  const matched = library.match(
    { recordingName: '', values: { itirazSebebi: '' } },
    'trendyol'
  );
  assert.equal(matched, null, 'iki aday varken hangisi olduğu belirsiz');
});

test('eşleşme: hiç kayıt yoksa null döner', () => {
  const library = new RecordingLibrary(tempDir());
  const matched = library.match({ recordingName: '', values: {} }, 'trendyol');
  assert.equal(matched, null);
});

test('eşleşme: sebep yazılmış ama karşılığı yoksa tek kayda düşer', () => {
  const library = new RecordingLibrary(tempDir());
  const rec = library.create('trendyol');
  library.save(rec); // itirazSebebi ataması yapılmamış

  const matched = library.match(
    { recordingName: '', values: { itirazSebebi: 'Bilinmeyen sebep' } },
    'trendyol'
  );
  assert.equal(matched?.recordingId, rec.recordingId);
});

test('eşleşme: sebep belirsizse tahmin yapmaz', () => {
  const library = new RecordingLibrary(tempDir());
  for (const _ of [1, 2]) {
    const rec = library.create('trendyol');
    rec.itirazSebebi = 'Yanlış desi bilgisi';
    library.save(rec);
  }
  const matched = library.match(
    { recordingName: '', values: { itirazSebebi: 'Yanlış desi bilgisi' } },
    'trendyol'
  );
  assert.equal(matched, null, 'iki aday varken tahmin edilmemeli');
});

// ---------- Excel ----------

test('parseDecimal virgül ve nokta kabul eder', () => {
  assert.equal(excel.parseDecimal('1,5'), 1.5);
  assert.equal(excel.parseDecimal('1.5'), 1.5);
  assert.equal(excel.parseDecimal(3), 3);
  assert.equal(excel.parseDecimal('abc'), null);
  assert.equal(excel.parseDecimal(''), null);
});

test('parseOrderNo bilimsel gösterimi düz sayıya çevirir', () => {
  assert.equal(excel.parseOrderNo(123456789012), '123456789012');
  assert.equal(excel.parseOrderNo('  987654321 '), '987654321');
});

test('buildQueue eksik zorunlu alanı Eksik veri işaretler', () => {
  const variables = [
    { key: 'siparisNo', label: 'Sipariş No', required: true },
    { key: 'dogruDesi', label: 'Doğru Desi', required: true },
  ];
  const rows = [
    ['123456789', '3'],
    ['', '5'],
    ['555666777', 'abc'],
  ];
  const { entries } = excel.buildQueue(rows, { siparisNo: 0, dogruDesi: 1 }, variables);

  assert.equal(entries[0].status, RowStatus.PENDING);
  assert.equal(entries[1].status, RowStatus.MISSING_DATA);
  assert.equal(entries[2].status, RowStatus.MISSING_DATA, 'sayıya çevrilemeyen desi');
});

test('buildQueue tekrar eden sipariş no için uyarı üretir ama engellemez', () => {
  const variables = [{ key: 'siparisNo', label: 'Sipariş No', required: true }];
  const rows = [['111'], ['111']];
  const { entries, warnings } = excel.buildQueue(rows, { siparisNo: 0 }, variables);
  assert.equal(warnings.length, 1);
  assert.equal(entries[1].status, RowStatus.PENDING, 'uyarı satırı engellememeli');
});

test('boş İtiraz Sebebi satırı Eksik veri yapmaz', () => {
  const variables = require('../src/shared/variables').SYSTEM_VARIABLES;
  const rows = [['123456789', '3', '', '']];
  const { entries } = excel.buildQueue(
    rows,
    { siparisNo: 0, dogruDesi: 1, itirazSebebi: 2, aciklama: 3 },
    variables
  );
  assert.equal(entries[0].status, RowStatus.PENDING, 'sebep opsiyonel olmalı');
});

test('sadece zorunlu iki kolon doluysa satır çalışabilir', () => {
  const variables = require('../src/shared/variables').SYSTEM_VARIABLES;
  const rows = [['123456789', '3']];
  const { entries } = excel.buildQueue(rows, { siparisNo: 0, dogruDesi: 1 }, variables);
  assert.equal(entries[0].status, RowStatus.PENDING);
});

test('sipariş no veya desi boşsa hâlâ Eksik veri', () => {
  const variables = require('../src/shared/variables').SYSTEM_VARIABLES;
  const rows = [['', '3'], ['123', '']];
  const { entries } = excel.buildQueue(rows, { siparisNo: 0, dogruDesi: 1 }, variables);
  assert.equal(entries[0].status, RowStatus.MISSING_DATA);
  assert.equal(entries[1].status, RowStatus.MISSING_DATA);
});

test('suggestMapping başlıkları tanır', () => {
  const mapping = excel.suggestMapping(['Sipariş No', 'İtiraz Sebebi', 'Doğru Desi']);
  assert.deepEqual(mapping, { siparisNo: 0, itirazSebebi: 1, dogruDesi: 2 });
});

test('suggestMapping Türkçe harf varyasyonlarına dayanıklıdır', () => {
  // 'İ'.toLowerCase() birleşen nokta üretir; kullanıcı ayrıca aksansız yazabilir.
  const mapping = excel.suggestMapping(['SIPARIS NO', 'itiraz sebebi', 'DOGRU DESI']);
  assert.deepEqual(mapping, { siparisNo: 0, itirazSebebi: 1, dogruDesi: 2 });
});

// ---------- Player ----------

function buildRecording(library, steps) {
  const rec = library.create('trendyol');
  rec.itirazSebebi = 'Yanlış desi bilgisi';
  rec.steps = steps;
  return library.save(rec);
}

const OK_STEPS = [
  { stepId: 1, action: Action.NAVIGATE, url: 'https://example.test/?q={{siparisNo}}' },
  { stepId: 2, action: Action.CLICK, selector: { strategies: [{ type: 'text', value: 'İtiraz Et' }] } },
  {
    stepId: 3,
    action: Action.WAIT_FOR_ELEMENT,
    selector: { strategies: [{ type: 'text', value: 'alındı' }] },
    onSuccess: 'markRowSuccess',
  },
];

function queueRow(values, overrides = {}) {
  return {
    rowNumber: 2,
    values,
    recordingName: '',
    recordingId: null,
    status: RowStatus.PENDING,
    detail: '',
    ...overrides,
  };
}

/** Sipariş no {{siparisNo}}'ya bağlanmamış, sabit yazılmış kayıt. */
const UNBOUND_STEPS = [
  {
    stepId: 1,
    action: Action.TYPE,
    selector: { strategies: [{ type: 'id', value: 'orderNumber' }] },
    value: '11368046310',
  },
  {
    stepId: 2,
    action: Action.TYPE,
    selector: { strategies: [{ type: 'id', value: 'desi' }] },
    value: '{{dogruDesi}}',
  },
];

test('sabit sipariş no yazan kayıt satırı düşürür (yanlış siparişe itiraz)', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, UNBOUND_STEPS);
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [queueRow({ siparisNo: '11424950386', dogruDesi: '2', itirazSebebi: '' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.match(queue[0].detail, /11368046310/);
  assert.match(queue[0].detail, /siparisNo/);
  assert.equal(bridge.seen.length, 0, 'hiçbir adım çalıştırılmamalı');
});

test('sabit değer satırın kendi numarasıyla aynıysa engellenmez', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, UNBOUND_STEPS);
  const player = new Player({ bridge: fakeBridge(), library });

  const queue = [queueRow({ siparisNo: '11368046310', dogruDesi: '2', itirazSebebi: '' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
});

test('{{siparisNo}} bağlıysa kontrol engel olmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, [
    { ...UNBOUND_STEPS[0], value: '{{siparisNo}}' },
    UNBOUND_STEPS[1],
  ]);
  const player = new Player({ bridge: fakeBridge(), library });

  const queue = [queueRow({ siparisNo: '11424950386', dogruDesi: '2', itirazSebebi: '' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
});

test('durdurma adımın ortasında beklemeden devreye girer', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);

  // Asla çözülmeyen adım: durdurma çalışmazsa test zaman aşımına uğrar.
  let started;
  const hung = new Promise((resolve) => {
    started = resolve;
  });
  const bridge = {
    seen: [],
    executeStep(step) {
      bridge.seen.push(step);
      started();
      return new Promise(() => {});
    },
  };

  const player = new Player({ bridge, library });
  const queue = [queueRow({ siparisNo: '123', dogruDesi: '3', itirazSebebi: '' })];
  const run = player.run(queue, { panel: 'trendyol' });

  await hung; // ilk adım köprüde asılı kaldı
  player.stop();
  await run; // adımın zaman aşımı beklenmeden dönmeli

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.match(queue[0].detail, /durduruldu/);
});

test('başarılı satır Başarılı işaretlenir', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const player = new Player({ bridge: fakeBridge(), library });

  const queue = [queueRow({ siparisNo: '123', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
});

test('zorunlu adım başarısız olursa satır düşer, batch devam eder', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const player = new Player({ bridge: fakeBridge({ failOn: [2] }), library });

  const values = { siparisNo: '123', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' };
  const queue = [
    queueRow(values),
    queueRow({ ...values, siparisNo: '456' }, { rowNumber: 3 }),
  ];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.equal(queue[1].status, RowStatus.FAILED);
  assert.match(queue[0].detail, /Adım 2/);
});

test('opsiyonel adım bulunamazsa satır düşmez', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, [
    OK_STEPS[0],
    { ...OK_STEPS[1], stepId: 2, optional: true },
    { ...OK_STEPS[2], stepId: 3 },
  ]);
  const player = new Player({ bridge: fakeBridge({ failOn: [2] }), library });

  const queue = [queueRow({ siparisNo: '123', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS, 'opsiyonel adım satırı düşürmemeli');
});

test('sebep boşken satır tek kayıtla çalışır', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const player = new Player({ bridge: fakeBridge(), library });

  const queue = [queueRow({ siparisNo: '123', dogruDesi: '3', itirazSebebi: '' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
});

test('eşleşmeyen satır Eşleşme bulunamadı olur, çalıştırılmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [queueRow({ siparisNo: '123', itirazSebebi: 'Bilinmeyen sebep', dogruDesi: '3' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.NO_MATCH);
  assert.equal(bridge.seen.length, 0, 'hiçbir adım gönderilmemeli');
});

test('Eksik veri satırı için tarayıcıya adım gönderilmez', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [queueRow({}, { status: RowStatus.MISSING_DATA, detail: 'Boş zorunlu alan' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(bridge.seen.length, 0);
});

test('değişken adımlara doğru yerleştirilir', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [queueRow({ siparisNo: '777', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '2' })];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(bridge.seen[0].url, 'https://example.test/?q=777');
});

test('ilk hatada dur seçeneği batch\'i durdurur', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const player = new Player({ bridge: fakeBridge({ failOn: [2] }), library });

  const values = { siparisNo: '123', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' };
  const queue = [queueRow(values), queueRow(values, { rowNumber: 3 })];
  await player.run(queue, { panel: 'trendyol', stopOnFirstError: true });

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.equal(queue[1].status, RowStatus.PENDING, 'ikinci satır hiç çalışmamalı');
});

test('boş açıklama satırı düşürmez (opsiyonel değişken)', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, [
    OK_STEPS[0],
    {
      stepId: 2,
      action: Action.TYPE,
      selector: { strategies: [{ type: 'name', value: 'note' }] },
      value: '{{aciklama}}',
    },
    { ...OK_STEPS[2], stepId: 3 },
  ]);
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [
    queueRow({
      siparisNo: '123',
      itirazSebebi: 'Yanlış desi bilgisi',
      dogruDesi: '3',
      aciklama: '',
    }),
  ];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
  assert.equal(bridge.seen[1].value, '', 'boş açıklama boş string olarak geçmeli');
});

test('açıklama kolonu hiç eşlenmemişse de satır çalışır', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, [
    OK_STEPS[0],
    {
      stepId: 2,
      action: Action.TYPE,
      selector: { strategies: [{ type: 'name', value: 'note' }] },
      value: '{{aciklama}}',
    },
    { ...OK_STEPS[2], stepId: 3 },
  ]);
  const player = new Player({ bridge: fakeBridge(), library });

  // aciklama anahtarı hiç yok — kolon eşlenmemiş senaryosu
  const queue = [
    queueRow({ siparisNo: '123', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' }),
  ];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
});

test('zorunlu değişken eksikse satır yine de düşer', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [
    queueRow({ siparisNo: '', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' }),
  ];
  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.MISSING_DATA);
  assert.equal(bridge.seen.length, 0);
});

// ---------- İki ayrı Kayıt: hazırlık + itiraz ----------

const { RecordingKind } = require('../src/shared/protocol');
const { kindOf } = require('../src/core/recordings');

const PHASE_VALUES = { siparisNo: '1', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' };

/** İtiraz sayfasına kadar gelen, 2 adımlık hazırlık Kaydı. */
function buildSetupRecording(library) {
  const rec = library.create('trendyol', RecordingKind.SETUP);
  rec.customLabel = 'Sayfaya git';
  rec.steps = [
    { stepId: 1, action: Action.CLICK,
      selector: { strategies: [{ type: 'text', value: 'Kargo Faturaları' }] } },
    { stepId: 2, action: Action.CLICK,
      selector: { strategies: [{ type: 'text', value: 'Desi İtirazları' }] } },
  ];
  return library.save(rec);
}

test('hazırlık kaydı sipariş değişkeni taşımaz', () => {
  const library = new RecordingLibrary(tempDir());
  const rec = buildSetupRecording(library);
  assert.equal(kindOf(rec), RecordingKind.SETUP);
  assert.equal(rec.variables.length, 0, 'hazırlık kaydına sistem değişkeni eklenmemeli');
});

test('kind alanı olmayan eski kayıtlar itiraz kaydı sayılır', () => {
  assert.equal(kindOf({ steps: [] }), RecordingKind.ITIRAZ, 'geriye dönük uyumluluk');
});

test('listByKind türe göre ayırır', () => {
  const library = new RecordingLibrary(tempDir());
  buildSetupRecording(library);
  buildRecording(library, OK_STEPS);

  assert.equal(library.listByKind(RecordingKind.SETUP).length, 1);
  assert.equal(library.listByKind(RecordingKind.ITIRAZ).length, 1);
});

test('hazırlık kaydı satırlara eşlenmez', () => {
  const library = new RecordingLibrary(tempDir());
  const setup = buildSetupRecording(library);
  setup.itirazSebebi = 'Yanlış desi bilgisi'; // yanlışlıkla atanmış olsa bile
  library.save(setup);

  const matched = library.match(
    { recordingName: '', values: { itirazSebebi: 'Yanlış desi bilgisi' } },
    'trendyol'
  );
  assert.equal(matched, null, 'hazırlık kaydı itiraz satırına atanmamalı');
});

test('hazırlık kaydı batch başında YALNIZCA BİR KEZ çalışır', async () => {
  const library = new RecordingLibrary(tempDir());
  const setup = buildSetupRecording(library);
  buildRecording(library, OK_STEPS);

  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [
    queueRow(PHASE_VALUES),
    queueRow({ ...PHASE_VALUES, siparisNo: '2' }, { rowNumber: 3 }),
  ];
  await player.run(queue, { panel: 'trendyol', setupRecordingId: setup.recordingId });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
  assert.equal(queue[1].status, RowStatus.SUCCESS);
  // 2 hazırlık + (3 itiraz adımı × 2 satır) = 8
  assert.equal(bridge.seen.length, 8);
  // İlk iki çağrı hazırlığa ait olmalı.
  assert.equal(bridge.seen[0].selector.strategies[0].value, 'Kargo Faturaları');
  assert.equal(bridge.seen[1].selector.strategies[0].value, 'Desi İtirazları');
});

test('hazırlık kaydı seçilmezse hiç çalışmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  buildSetupRecording(library);
  buildRecording(library, OK_STEPS);

  const bridge = fakeBridge();
  const player = new Player({ bridge, library });

  const queue = [queueRow(PHASE_VALUES)];
  await player.run(queue, { panel: 'trendyol' }); // setupRecordingId yok

  assert.equal(queue[0].status, RowStatus.SUCCESS);
  assert.equal(bridge.seen.length, 3, 'yalnızca itiraz adımları');
});

test('hazırlık başarısızsa hiçbir satır çalışmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  const setup = buildSetupRecording(library);
  buildRecording(library, OK_STEPS);

  const bridge = fakeBridge({ failOn: [1] }); // hazırlığın ilk adımı
  const player = new Player({ bridge, library });

  const queue = [
    queueRow(PHASE_VALUES),
    queueRow({ ...PHASE_VALUES, siparisNo: '2' }, { rowNumber: 3 }),
  ];
  await player.run(queue, { panel: 'trendyol', setupRecordingId: setup.recordingId });

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.equal(queue[1].status, RowStatus.FAILED);
  assert.match(queue[0].detail, /Hazırlık kaydı başarısız/);
  assert.equal(bridge.seen.length, 1, 'ilk hazırlık adımından sonra durmalı');
});

test('eksik veri satırı hazırlık başarısızlığında da korunur', async () => {
  const library = new RecordingLibrary(tempDir());
  const setup = buildSetupRecording(library);
  buildRecording(library, OK_STEPS);

  const player = new Player({ bridge: fakeBridge({ failOn: [1] }), library });
  const queue = [queueRow({}, { status: RowStatus.MISSING_DATA, detail: 'Boş zorunlu alan' })];
  await player.run(queue, { panel: 'trendyol', setupRecordingId: setup.recordingId });

  assert.equal(queue[0].status, RowStatus.MISSING_DATA, 'durumu değişmemeli');
});

test('silinmiş hazırlık kaydı seçiliyse anlaşılır hata verir', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);

  const player = new Player({ bridge: fakeBridge(), library });
  const queue = [queueRow(PHASE_VALUES)];
  await player.run(queue, { panel: 'trendyol', setupRecordingId: 'yok-boyle-bir-id' });

  assert.equal(queue[0].status, RowStatus.FAILED);
});

// ---------- Kaydedici dayanıklılığı ----------

const { Recorder } = require('../src/core/recorder');

/** Kayıt başlatma isteği hata veren köprü. */
function failingBridge(message = 'Chrome eklentisi bağlı değil.') {
  const listeners = new Map();
  return {
    on(event, fn) { listeners.set(event, fn); },
    off(event) { listeners.delete(event); },
    async startRecording() { throw new Error(message); },
    async stopRecording() { return { ok: true }; },
  };
}

function okBridge() {
  const listeners = new Map();
  return {
    listeners,
    on(event, fn) { listeners.set(event, fn); },
    off(event) { listeners.delete(event); },
    async startRecording() { return { ok: true }; },
    async stopRecording() { return { ok: true }; },
  };
}

test('köprü hatası kaydediciyi kilitli bırakmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: failingBridge(), library });

  await assert.rejects(() => recorder.start('trendyol'), /bağlı değil/i);
  assert.equal(recorder.active, false, 'başarısız başlatma active bırakmamalı');

  // İkinci deneme "Zaten süren bir kayıt var" DEMEMELİ.
  const working = new Recorder({ bridge: okBridge(), library });
  const rec = await working.start('trendyol');
  assert.ok(rec.recordingId);
  assert.equal(working.active, true);
});

test('başarısız başlatma çöp Kayıt bırakmaz', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: failingBridge(), library });

  await assert.rejects(() => recorder.start('trendyol'));
  assert.equal(library.list().length, 0, 'yarım Kayıt oluşturulmamalı');
});

test('prependNavigate adımı başa ekler ve numaraları düzeltir', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: okBridge(), library });

  await recorder.start('trendyol');
  recorder.recording.steps.push(
    { stepId: 1, action: Action.CLICK, selector: { strategies: [] } },
    { stepId: 2, action: Action.CLICK, selector: { strategies: [] } }
  );
  library.save(recorder.recording);

  recorder.prependNavigate('https://partner.trendyol.com/orders');

  const steps = recorder.recording.steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[0].action, Action.NAVIGATE);
  assert.equal(steps[0].url, 'https://partner.trendyol.com/orders');
  assert.deepEqual(steps.map((s) => s.stepId), [1, 2, 3], 'numaralar sırayla olmalı');
});

test('prependNavigate boş adresi reddeder', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: okBridge(), library });
  await recorder.start('trendyol');

  assert.equal(recorder.prependNavigate('   '), null);
  assert.equal(recorder.recording.steps.length, 0);
});

test('reset takılı kalmış oturumu temizler', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: okBridge(), library });

  await recorder.start('trendyol');
  assert.equal(recorder.active, true);

  await recorder.reset();
  assert.equal(recorder.active, false);
  assert.equal(library.list().length, 0, 'boş kayıt silinmeli');

  // Yeniden başlatılabilmeli.
  const rec = await recorder.start('trendyol');
  assert.ok(rec.recordingId);
});

test('reset adım içeren kaydı silmez', async () => {
  const library = new RecordingLibrary(tempDir());
  const recorder = new Recorder({ bridge: okBridge(), library });

  await recorder.start('trendyol');
  recorder.recording.steps.push({ stepId: 1, action: Action.CLICK });
  library.save(recorder.recording);

  await recorder.reset();
  assert.equal(library.list().length, 1, 'içinde adım olan kayıt korunmalı');
});

test('özet durumları sayar', async () => {
  const library = new RecordingLibrary(tempDir());
  buildRecording(library, OK_STEPS);
  const player = new Player({ bridge: fakeBridge(), library });

  const values = { siparisNo: '1', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' };
  const queue = [queueRow(values), queueRow({ ...values, siparisNo: '2' }, { rowNumber: 3 })];
  const summary = await player.run(queue, { panel: 'trendyol' });

  assert.equal(summary.total, 2);
  assert.equal(summary.counts[RowStatus.SUCCESS], 2);
});
