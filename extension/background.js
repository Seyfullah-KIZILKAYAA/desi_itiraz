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
/** MV3 service worker'ı boşta uyur; bağlantıyı canlı tutmak için ping. */
const KEEPALIVE_MS = 20000;

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

/** Worker yeniden başlamış olabilir; durum okunmadan iş yapılmamalı. */
const stateReady = restoreState();

// ---------------- WebSocket ----------------

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    setBadge('ON', '#1f9254');
    send('hello', { version: chrome.runtime.getManifest().version });
  };

  socket.onmessage = (event) => handleAppMessage(event.data);

  socket.onclose = () => {
    setBadge('OFF', '#c0392b');
    socket = null;
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose zaten tetiklenecek; burada sessiz kal.
  };
}

function scheduleReconnect() {
  setTimeout(connect, RECONNECT_MS);
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
  // Worker yeni uyanmış olabilir; kayıt durumu okunmadan karar verme.
  await stateReady;

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }

  const { type, requestId, payload } = message;

  switch (type) {
    case 'startRecording': {
      const tab = await activeTab();
      if (!tab) {
        return replyError(requestId, 'Aktif sekme bulunamadı.');
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

    case 'executeStep': {
      const step = payload?.step;
      if (!step) return replyError(requestId, 'Adım yok.');
      const result = await runStep(step);
      return reply(requestId, result);
    }

    case 'ping':
      return reply(requestId, { pong: true });

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

/** Hedef sekme; kapanmışsa aktif sekmeye düşer. */
async function resolveTab() {
  if (targetTabId !== null) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab) return tab;
    } catch {
      targetTabId = null;
    }
  }
  const tab = await activeTab();
  if (tab) targetTabId = tab.id;
  return tab;
}

/** Content script yoksa enjekte eder; chrome:// sayfalarında başarısız olur. */
async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'ping' });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['selectors.js', 'content.js'],
      });
      return true;
    } catch {
      return false;
    }
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
    return { status: 'failed', detail: 'Sayfaya erişilemedi (content script yok).' };
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

// MV3 service worker uykuya dalarsa WebSocket kopar; alarm ile uyanık tut.
chrome.alarms.create('keepalive', { periodInMinutes: KEEPALIVE_MS / 60000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (!socket || socket.readyState !== WebSocket.OPEN) connect();
  else send('pong', { keepalive: true });
});

connect();
