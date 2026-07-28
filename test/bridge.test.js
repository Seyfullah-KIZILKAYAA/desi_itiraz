/**
 * Köprü entegrasyon testleri.
 *
 * Gerçek WebSocket sunucusu ile, eklentinin protokol davranışını taklit eden
 * sahte bir istemci konuşturulur. Chrome gerekmez.
 */

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bridge } = require('../src/core/bridge');
const { Player } = require('../src/core/player');
const { RecordingLibrary } = require('../src/core/recordings');
const { RowStatus, ToApp } = require('../src/shared/protocol');

/**
 * Her test kendi portunu kullanır. Test dosyaları ayrı süreçlerde paralel
 * koştuğu için taban port PID'den türetilir; aksi halde iki dosya aynı portu
 * seçip birbirinin sunucusunu bloke eder.
 */
let nextPort = 18000 + (process.pid % 900) * 10;
const takePort = () => nextPort++;

/**
 * Eklenti taklidi: background.js'in yaptığı gibi requestId'yi geri yansıtır.
 * @param {(step:object)=>object} onStep adım sonucunu üretir
 */
/** Testler bittiğinde kapatılacak kaynaklar (süreç asılı kalmasın). */
const openSockets = [];
const openBridges = [];

test.after(() => {
  for (const socket of openSockets) {
    try { socket.close(); } catch { /* yoksay */ }
  }
  for (const bridge of openBridges) {
    try { bridge.stop(); } catch { /* yoksay */ }
  }
});

function fakeExtension(port, onStep, { onOpen } = {}) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  openSockets.push(client);

  client.on('open', () => {
    client.send(JSON.stringify({ type: 'hello', payload: { version: 'test' } }));
    onOpen?.(client);
  });

  client.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'executeStep') {
      const result = onStep(message.payload.step);
      client.send(
        JSON.stringify({ type: 'stepResult', requestId: message.requestId, payload: result })
      );
    } else if (message.type === 'startRecording' || message.type === 'stopRecording') {
      client.send(
        JSON.stringify({ type: 'stepResult', requestId: message.requestId, payload: { ok: true } })
      );
    }
  });

  return client;
}

function waitFor(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`'${event}' beklenirken zaman aşımı`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * Bağlantının kurulmasını bekler. 'connected' olayı, dinleyici kurulmadan önce
 * tetiklenmiş olabileceğinden olaya değil duruma bakar.
 */
async function waitConnected(bridge, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bridge.isConnected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Köprü bağlantısı kurulamadı (zaman aşımı).');
}

/** Sunucu dinlemeye başlayana kadar bekler; istemci erken bağlanıp reddedilmesin. */
function startBridge(port) {
  const bridge = new Bridge({ port });
  bridge.start();
  openBridges.push(bridge);
  return new Promise((resolve, reject) => {
    bridge.server.once('listening', () => resolve(bridge));
    bridge.server.once('error', reject);
  });
}

test('köprü bağlantıyı kabul eder ve istek/yanıt döngüsü çalışır', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const client = fakeExtension(port, () => ({ status: 'ok' }));
  await waitConnected(bridge);

  const result = await bridge.executeStep({ stepId: 1, action: 'click' }, 5000);
  assert.equal(result.status, 'ok');

  client.close();
  bridge.stop();
});

test('eklenti hata mesajı istekte reddedilir', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    client.send(
      JSON.stringify({ type: 'error', requestId: message.requestId, message: 'Sekme yok' })
    );
  });

  await waitConnected(bridge);
  await assert.rejects(() => bridge.executeStep({ stepId: 1 }, 5000), /Sekme yok/);

  client.close();
  bridge.stop();
});

test('bağlantı kopunca bekleyen istekler reddedilir', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const client = new WebSocket(`ws://127.0.0.1:${port}`); // hiç yanıt vermez
  openSockets.push(client);
  await waitConnected(bridge);

  const pending = bridge.executeStep({ stepId: 1 }, 5000);
  client.close();

  await assert.rejects(() => pending, /bağlantısı kesildi/i);
  bridge.stop();
});

test('eklenti bağlı değilken istek reddedilir', async () => {
  const bridge = await startBridge(takePort());
  await assert.rejects(() => bridge.executeStep({ stepId: 1 }), /bağlı değil/i);
  bridge.stop();
});

test('kaydedilen olaylar uygulamaya iletilir', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const client = fakeExtension(port, () => ({ status: 'ok' }), {
    onOpen: (socket) => {
      socket.send(
        JSON.stringify({
          type: 'recordedEvent',
          payload: {
            action: 'click',
            selector: { strategies: [{ type: 'text', value: 'İtiraz Et' }] },
          },
        })
      );
    },
  });

  const event = await waitFor(bridge, ToApp.RECORDED_EVENT);
  assert.equal(event.action, 'click');
  assert.equal(event.selector.strategies[0].value, 'İtiraz Et');

  client.close();
  bridge.stop();
});

test('Player gerçek köprü üzerinden uçtan uca satır işler', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const library = new RecordingLibrary(fs.mkdtempSync(path.join(os.tmpdir(), 'desi-br-')));
  const recording = library.create('trendyol');
  recording.itirazSebebi = 'Yanlış desi bilgisi';
  recording.steps = [
    { stepId: 1, action: 'navigate', url: 'https://example.test/?q={{siparisNo}}' },
    {
      stepId: 2,
      action: 'type',
      selector: { strategies: [{ type: 'name', value: 'desi' }] },
      value: '{{dogruDesi}}',
    },
    {
      stepId: 3,
      action: 'waitForElement',
      selector: { strategies: [{ type: 'text', value: 'alındı' }] },
      onSuccess: 'markRowSuccess',
    },
  ];
  library.save(recording);

  const seen = [];
  const client = fakeExtension(port, (step) => {
    seen.push(step);
    return { status: 'ok' };
  });
  await waitConnected(bridge);

  const player = new Player({ bridge, library });
  const queue = [
    {
      rowNumber: 2,
      values: { siparisNo: '123456789', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' },
      recordingName: '',
      recordingId: null,
      status: RowStatus.PENDING,
      detail: '',
    },
  ];

  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.SUCCESS);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].url, 'https://example.test/?q=123456789', 'değişken yerleşmeli');
  assert.equal(seen[1].value, '3');

  client.close();
  bridge.stop();
});

test('eklentideki başarısız adım satırı düşürür', async () => {
  const port = takePort();
  const bridge = await startBridge(port);

  const library = new RecordingLibrary(fs.mkdtempSync(path.join(os.tmpdir(), 'desi-br-')));
  const recording = library.create('trendyol');
  recording.itirazSebebi = 'Yanlış desi bilgisi';
  recording.steps = [
    {
      stepId: 1,
      action: 'click',
      selector: { strategies: [{ type: 'text', value: 'İtiraz Et' }] },
    },
  ];
  library.save(recording);

  const client = fakeExtension(port, () => ({ status: 'failed', detail: 'Element bulunamadı' }));
  await waitConnected(bridge);

  const player = new Player({ bridge, library });
  const queue = [
    {
      rowNumber: 2,
      values: { siparisNo: '1', itirazSebebi: 'Yanlış desi bilgisi', dogruDesi: '3' },
      recordingName: '',
      recordingId: null,
      status: RowStatus.PENDING,
      detail: '',
    },
  ];

  await player.run(queue, { panel: 'trendyol' });

  assert.equal(queue[0].status, RowStatus.FAILED);
  assert.match(queue[0].detail, /Element bulunamadı/);

  client.close();
  bridge.stop();
});
