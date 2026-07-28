/**
 * Browser Bridge — Chrome eklentisinin bağlandığı yerel WebSocket sunucusu.
 * Spec §3.1.3. Yeni tarayıcı AÇMAZ; yalnızca zaten açık olan Chrome'a bağlanır.
 */

const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { ToApp, ToExtension, DEFAULT_PORT } = require('../shared/protocol');

class Bridge extends EventEmitter {
  constructor({ port = DEFAULT_PORT } = {}) {
    super();
    this.port = port;
    this.server = null;
    this.socket = null;
    /** Yanıt bekleyen istekler: requestId -> {resolve, reject, timer} */
    this.pending = new Map();
  }

  start() {
    if (this.server) return;
    // Yalnızca localhost'a bağlan — dışarıdan erişilebilir olmasın.
    this.server = new WebSocketServer({ port: this.port, host: '127.0.0.1' });

    this.server.on('connection', (socket) => {
      // Tek sekme/tek eklenti modeli: yeni bağlantı eskisinin yerini alır.
      if (this.socket && this.socket.readyState === this.socket.OPEN) {
        this.socket.close();
      }
      this.socket = socket;
      this.emit('connected');

      socket.on('message', (data) => this._onMessage(data));
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this._rejectAll(new Error('Eklenti bağlantısı kesildi.'));
          this.emit('disconnected');
        }
      });
      socket.on('error', (err) => this.emit('bridgeError', err));
    });

    this.server.on('error', (err) => this.emit('bridgeError', err));
  }

  stop() {
    this._rejectAll(new Error('Köprü kapatıldı.'));
    this.socket?.close();
    this.socket = null;
    this.server?.close();
    this.server = null;
  }

  get isConnected() {
    return !!this.socket && this.socket.readyState === this.socket.OPEN;
  }

  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.emit('bridgeError', new Error('Eklentiden geçersiz mesaj geldi.'));
      return;
    }

    // Bekleyen bir isteğin yanıtı mı?
    if (message.requestId && this.pending.has(message.requestId)) {
      const entry = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.type === ToApp.ERROR) {
        entry.reject(new Error(message.message || 'Eklenti hatası'));
      } else {
        entry.resolve(message.payload ?? {});
      }
      return;
    }

    // İstenmemiş mesaj (kayıt olayı, sekme bilgisi, vb.)
    this.emit('message', message);
    if (message.type) this.emit(message.type, message.payload ?? {});
  }

  /** Yanıt beklemeden gönderir. */
  send(type, payload = {}) {
    if (!this.isConnected) throw new Error('Chrome eklentisi bağlı değil.');
    this.socket.send(JSON.stringify({ type, payload }));
  }

  /** Gönderir ve eklentinin yanıtını bekler. */
  request(type, payload = {}, timeoutMs = 30000) {
    if (!this.isConnected) {
      return Promise.reject(new Error('Chrome eklentisi bağlı değil.'));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Eklenti yanıt vermedi (${type}).`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type, requestId, payload }));
    });
  }

  _rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // --- Yüksek seviye yardımcılar ---

  startRecording() {
    return this.request(ToExtension.START_RECORDING);
  }

  stopRecording() {
    return this.request(ToExtension.STOP_RECORDING);
  }

  /** Tek bir adımı çalıştırır; {status, detail} döner. */
  executeStep(step, timeoutMs) {
    // Adım kendi zaman aşımını yönetir; köprü biraz daha uzun bekler ki
    // zaman aşımını adım seviyesinde raporlayabilelim.
    return this.request(ToExtension.EXECUTE_STEP, { step }, (timeoutMs ?? 15000) + 10000);
  }
}

module.exports = { Bridge };
