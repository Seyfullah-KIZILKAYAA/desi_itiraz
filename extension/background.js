/**
 * Background service worker.
 *
 * Masaüstü uygulamasına WebSocket ile bağlanır ve iki yönlü köprü kurar:
 *   uygulama -> içerik : executeStep, startRecording, stopRecording
 *   içerik -> uygulama : recordedEvent, stepResult
 *
 * Yeni sekme/pencere AÇMAZ. Kullanıcının zaten açık, giriş yapmış sekmesinde
 * çalışır (spec §9.2).
 */

const WS_URL = 'ws://127.0.0.1:17321';
const RECONNECT_MS = 3000;
/**
 * MV3 service worker'ı ~30sn boşta uyur. chrome.alarms minimum periyodu 1
 * dakika olduğu için alarm tek başına worker'ı ayakta tutamaz; her zaman geç
 * kalır ve bağlantı kopar. Bu yüzden soket üzerinden 20sn'de bir ping atıyoruz:
 * gelen/giden WebSocket trafiği worker'ın uyku sayacını sıfırlar. Alarm yalnızca
 * worker yine de sonlandırılırsa devreye giren yedek yol olarak kalır.
 */
const KEEPALIVE_MS = 20000;
let keepaliveTimer = null;

let socket = null;

/**
 * Kayıt durumu.
 *
 * MV3 service worker'ı ~30sn boşta kalınca sonlandırılır ve tüm modül
 * değişkenleri sıfırlanır. Kullanıcı menüde gezerken bu olursa kayıt sessizce
 * durur ve tıklamalar kaybolur. Bu yüzden durum chrome.storage.session'da
 * tutulur ve worker her uyandığında geri yüklenir.
 */
let recording = false;
/** Kaydın/oynatmanın yürütüldüğü sekme. Kayıt başlarken sabitlenir. */
let targetTabId = null;

/** Bellekteki durumu kalıcı hale getirir. */
async function persistState() {
  try {
    await chrome.storage.session.set({ recording, targetTabId });
  } catch {
    /* storage yoksa kayıt yine de bellekte sürer */
  }
}

/** Worker uyandığında durumu geri yükler. */
async function restoreState() {
  try {
    const saved = await chrome.storage.session.get(['recording', 'targetTabId']);
    recording = !!saved.recording;
    targetTabId = saved.targetTabId ?? null;
  } catch {
    /* varsayılanlar kalır */
  }
}

/**
 * Worker yeniden başlamış olabilir; durum okunmadan iş yapılmamalı.
 *
 * ANCAK bu söz asla askıda kalmamalı: storage.session çağrısı worker yeni
 * uyanmışken bazen çözülmüyor ve handleAppMessage'ın ilk satırındaki await
 * sonsuza dek asılı kalıyor. O zaman executeStep hiç işlenmez, uygulama 25 sn
 * bekleyip "Eklenti yanıt vermedi" der. Kısa bir zaman aşımıyla yarıştır:
 * durum okunamazsa varsayılanlarla devam etmek, hiç çalışmamaktan iyidir.
 */
const stateReady = Promise.race([
  restoreState(),
  new Promise((resolve) => setTimeout(resolve, 1000)),
]);

// ---------------- WebSocket ----------------

/**
 * Yeniden bağlanma zamanlayıcısı. Aynı anda yalnızca bir tane olmalı; yoksa
 * her tetikleyici (alarm, onStartup, recordedEvent, onclose) kendi zincirini
 * başlatır ve paralel connect() çağrıları birbirinin soketini düşürür.
 */
let reconnectTimer = null;

function connect() {
  // CLOSING de "meşgul" sayılmalı. Aksi halde kapanmakta olan bir soket varken
  // koruma delinir, ikinci soket açılır ve uygulama (tek bağlantı kabul ettiği
  // için) öncekini kapatır — bu da sonsuz bağlan/kop döngüsü yaratır.
  if (socket && socket.readyState !== WebSocket.CLOSED) return;

  // Bekleyen bir deneme varsa onu iptal et; tek zincir kalsın.
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let pending;
  try {
    pending = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = pending;

  pending.onopen = () => {
    if (socket !== pending) return; // eskimiş soket
    setBadge('ON', '#1f9254');
    send('hello', { version: chrome.runtime.getManifest().version });
    startKeepalive();
  };

  pending.onmessage = (event) => handleAppMessage(event.data);

  pending.onclose = () => {
    if (socket !== pending) return; // yerini yeni soket almış; döngüyü besleme
    setBadge('OFF', '#c0392b');
    stopKeepalive();
    socket = null;
    scheduleReconnect();
  };

  pending.onerror = () => {
    // onclose zaten tetiklenecek; burada sessiz kal.
  };
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return; // zaten planlı
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

/** Soket trafiğiyle worker'ın uyku sayacını sürekli sıfırla. */
function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) send('pong', { keepalive: true });
    else stopKeepalive();
  }, KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function send(type, payload = {}, requestId = null) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type, requestId, payload }));
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------- Uygulamadan gelen mesajlar ----------------

async function handleAppMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  const { type, requestId, payload } = message;

  // executeStep ve ping kayıt durumuna hiç bakmaz. Bunları stateReady
  // bariyerinin ARKASINDA beklemek, oynatmanın tamamen durmasına yol açıyordu:
  // storage okuması askıda kalırsa hiçbir adım çalışmıyor.
  if (type === 'ping') return reply(requestId, { pong: true });
  if (type === 'executeStep') {
    const step = payload?.step;
    if (!step) return replyError(requestId, 'Adım yok.');
    openKeepalivePort(); // uzun oynatmada worker'ı ayakta tut
    const result = await runStep(step);
    return reply(requestId, result);
  }

  // Kalanlar (kayıt başlat/bitir) gerçekten duruma bağlı.
  await stateReady;

  switch (type) {
    case 'startRecording': {
      const tab = await resolveTab();
      if (!tab) {
        return replyError(requestId, 'Aktif sekme bulunamadı.');
      }
      if (isPrivilegedUrl(tab.url)) {
        return replyError(
          requestId,
          'Bu sayfada eklenti çalışamaz. Chrome\'da Trendyol sekmesine geçip tekrar deneyin.'
        );
      }
      targetTabId = tab.id;
      recording = true;
      await persistState();

      const ok = await setRecordingInTab(tab.id, true);
      if (!ok) {
        recording = false;
        targetTabId = null;
        await persistState();
        return replyError(
          requestId,
          'Sekmeye bağlanılamadı. Trendyol sekmesini yenileyip tekrar deneyin.'
        );
      }
      setBadge('REC', '#f27a1a');
      return reply(requestId, { tabId: tab.id, url: tab.url });
    }

    case 'stopRecording': {
      recording = false;
      if (targetTabId !== null) await setRecordingInTab(targetTabId, false);
      await persistState();
      setBadge('ON', '#1f9254');
      return reply(requestId, { stopped: true });
    }

    default:
      return replyError(requestId, `Bilinmeyen mesaj: ${type}`);
  }
}

function reply(requestId, payload) {
  if (requestId) send('stepResult', payload, requestId);
}

function replyError(requestId, messageText) {
  if (!requestId) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'error', requestId, message: messageText }));
}

// ---------------- Sekme yardımcıları ----------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** Eklentinin çalışamayacağı ayrıcalıklı sayfa mı? */
function isPrivilegedUrl(url = '') {
  return (
    /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/i.test(url)
  );
}

/**
 * Hedef sekme. Sıra: kaydedilmiş sekme → aktif sekme → açık Trendyol sekmesi.
 *
 * Aktif sekmeye körlemesine düşmek yetmiyor: kullanıcı "Çalıştır"a masaüstü
 * uygulamasından basar, o sırada Chrome'un aktif sekmesi chrome://extensions
 * gibi ayrıcalıklı bir sayfa olabilir ve orada hiçbir eklenti çalışamaz.
 */
async function resolveTab() {
  if (targetTabId !== null) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab && !isPrivilegedUrl(tab.url)) return tab;
    } catch {
      targetTabId = null;
    }
  }

  const active = await activeTab();
  if (active && !isPrivilegedUrl(active.url)) {
    targetTabId = active.id;
    return active;
  }

  // Son çare: açık bir Trendyol sekmesi ara.
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.trendyol.com/*'] });
    const usable = tabs.find((t) => !isPrivilegedUrl(t.url));
    if (usable) {
      targetTabId = usable.id;
      return usable;
    }
  } catch {
    /* sorgu başarısızsa aşağıdaki dönüşe düş */
  }

  return active ?? null;
}

/**
 * Content script yoksa enjekte eder; chrome:// sayfalarında başarısız olur.
 * Başarısızlık sebebini `lastContentError`e yazar — sebebi yutmak, kullanıcıya
 * "content script yok" dışında hiçbir ipucu bırakmıyordu.
 */
let lastContentError = null;

async function ensureContent(tabId) {
  lastContentError = null;
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'ping' });
    return true;
  } catch {
    // Ping başarısız — betik henüz yok. Enjekte etmeyi dene.
  }

  let url = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    url = tab?.url ?? '';
  } catch {
    lastContentError = 'Sekme bulunamadı (kapanmış olabilir).';
    return false;
  }

  // Ayrıcalıklı sayfalarda hiçbir eklenti çalışamaz; bunu net söyle.
  if (/^(chrome|edge|about|devtools|chrome-extension):/i.test(url) ||
      /^https:\/\/chromewebstore\.google\.com/i.test(url)) {
    lastContentError =
      `Bu sayfada eklenti çalışamaz (${url.split('/')[0]}//…). ` +
      'Chrome\'da Trendyol sekmesine geçip tekrar deneyin.';
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['selectors.js', 'content.js'],
    });
    return true;
  } catch (err) {
    lastContentError = `Enjeksiyon başarısız: ${err.message} (sayfa: ${url})`;
    return false;
  }
}

async function setRecordingInTab(tabId, value) {
  if (!(await ensureContent(tabId))) return false;
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'setRecording', value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Adımı hedef sekmede çalıştırır.
 * navigate adımı sonrası sayfanın yüklenmesini bekler — sabit süre değil,
 * tab.status === 'complete' koşuluyla.
 */
async function runStep(step) {
  const tab = await resolveTab();
  if (!tab) return { status: 'failed', detail: 'Sekme bulunamadı.' };

  if (!(await ensureContent(tab.id))) {
    return {
      status: 'failed',
      detail: lastContentError ?? 'Sayfaya erişilemedi (content script yok).',
    };
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { kind: 'executeStep', step });

    if (step.action === 'navigate' && result?.status === 'ok') {
      const loaded = await waitForTabComplete(tab.id, step.timeoutMs ?? 15000);
      if (!loaded) return { status: 'failed', detail: 'Sayfa yüklenmedi (zaman aşımı).' };
      await ensureContent(tab.id); // yeni sayfaya yeniden enjekte
      if (recording) await setRecordingInTab(tab.id, true);
    }

    return result ?? { status: 'failed', detail: 'Yanıt yok.' };
  } catch (err) {
    return { status: 'failed', detail: err.message };
  }
}

/** Sekme yüklenene kadar bekler; DOM koşuluna bağlı, sabit sleep değil. */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };

    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);

    // Zaten yüklenmiş olabilir.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === 'complete') finish(true);
    }).catch(() => finish(false));
  });
}

// ---------------- Content script'ten gelenler ----------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.kind === 'recordedEvent') {
    // Worker uyanmış olabilir: durumu yükleyip öyle karar ver, yoksa
    // kullanıcının tıklamaları sessizce kaybolur.
    (async () => {
      await stateReady;
      if (recording && sender.tab?.id === targetTabId) {
        // Uygulama bağlantısı koptuysa yeniden kur; olay kaybolmasın.
        if (!socket || socket.readyState !== WebSocket.OPEN) connect();
        send('recordedEvent', message.payload);
      }
      sendResponse({ ok: true });
    })();
    return true; // async yanıt
  }

  if (message.kind === 'contentReady') {
    // Sayfa yenilendi; kayıt sürüyorsa modu geri ver.
    (async () => {
      await stateReady;
      if (recording && sender.tab?.id === targetTabId) {
        chrome.tabs
          .sendMessage(sender.tab.id, { kind: 'setRecording', value: true })
          .catch(() => {});
        setBadge('REC', '#f27a1a');
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.kind === 'getStatus') {
    // Worker yeni uyanmışsa soket henüz CONNECTING olabilir. Hemen "bağlı değil"
    // demek yerine el sıkışmanın bitmesini kısa süre bekle.
    if (!socket || socket.readyState === WebSocket.CLOSED) connect();

    if (socket && socket.readyState === WebSocket.CONNECTING) {
      const pending = socket;
      const settle = () => {
        pending.removeEventListener('open', settle);
        pending.removeEventListener('close', settle);
        clearTimeout(timer);
        sendResponse({
          connected: pending.readyState === WebSocket.OPEN,
          recording,
          targetTabId,
        });
      };
      const timer = setTimeout(settle, 1500);
      pending.addEventListener('open', settle);
      pending.addEventListener('close', settle);
      return true; // async yanıt
    }

    sendResponse({
      connected: socket?.readyState === WebSocket.OPEN,
      recording,
      targetTabId,
    });
    return false;
  }

  return false;
});

// ---------------- Yaşam döngüsü ----------------

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Worker yeniden başladıysa rozeti gerçek duruma göre tazele.
stateReady.then(() => {
  if (recording) setBadge('REC', '#f27a1a');
});

/**
 * İçerik betiğiyle kalıcı bir port açık tutar. Chrome, bağlı portu olan bir
 * service worker'ı canlı tutar; bu, setInterval ping'inden belirgin şekilde
 * dayanıklıdır (uzun oynatmalarda worker yine de uyuyup executeStep'i
 * yanıtsız bırakıyordu). Port koparsa yeniden kurulur.
 */
let keepalivePort = null;

async function openKeepalivePort() {
  if (keepalivePort) return;
  try {
    const tab = await resolveTab();
    if (!tab || isPrivilegedUrl(tab.url)) return;
    if (!(await ensureContent(tab.id))) return;

    keepalivePort = chrome.tabs.connect(tab.id, { name: 'desi-keepalive' });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
    });
  } catch {
    keepalivePort = null;
  }
}

// Yedek yol: ping'e rağmen worker sonlandırılırsa alarm onu uyandırıp yeniden
// bağlar. Chrome minimum periyodu 1 dakikadır; altındaki değerler yok sayılır.
chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  else send('pong', { keepalive: true });
  openKeepalivePort();
});

connect();
