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

    // Yalnızca loopback dinle — dışarıdan erişilebilir olmasın. Ancak yalnızca
    // IPv4'e bağlanmak yetmiyor: Chrome, ws://127.0.0.1 isteğini de ::1'e
    // çözebiliyor ve bu durumda bağlantı ECONNREFUSED ile reddediliyor
    // (sunucu dinliyor görünür ama hiçbir bağlantı ulaşmaz). Bu yüzden hem
    // IPv4 hem IPv6 loopback'te dinliyoruz.
    // ÖNEMLİ: 'error' dinleyicisi sunucu oluşturulur oluşturulmaz bağlanmalı.
    // EADDRINUSE asenkron gelir; try/catch onu yakalayamaz ve dinleyici yoksa
    // Node işlenmemiş istisna sayıp tüm uygulamayı düşürür.
    this.server = new WebSocketServer({ port: this.port, host: '127.0.0.1' });
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this._onPortInUse();
        return;
      }
      this.emit('bridgeError', err);
    });
    this.server.on('connection', (socket) => this._onConnection(socket));

    // IPv6'yı ancak IPv4 dinlemeye başladıktan sonra ekle. Aynı anda kurmak,
    // port doluyken iki ayrı EADDRINUSE üretip yeniden deneme mantığını
    // karıştırıyor.
    this._server6 = null;
    this.server.on('listening', () => this._startIpv6());
  }

  /**
   * Chrome, ws://127.0.0.1 isteğini ::1'e çözebiliyor; sunucu yalnızca IPv4
   * dinlerse bağlantı ECONNREFUSED alır ve eklenti hiç ulaşamaz.
   */
  _startIpv6() {
    if (this._server6) return;

    const server6 = new WebSocketServer({ port: this.port, host: '::1' });
    this._server6 = server6;

    server6.on('error', (err) => {
      // IPv6 yoksa ya da ayrı bir yığında dolu ise IPv4 dinleyici yeterli —
      // uygulamayı düşürme, sessizce IPv4 ile devam et.
      this._server6 = null;
      try {
        server6.close();
      } catch {
        /* zaten ölü */
      }
      if (
        err.code !== 'EADDRINUSE' &&
        err.code !== 'EAFNOSUPPORT' &&
        err.code !== 'EADDRNOTAVAIL'
      ) {
        this.emit('bridgeError', err);
      }
    });
    server6.on('connection', (socket) => this._onConnection(socket));
  }

  /**
   * Port başka bir örnekte. O örnek kapanınca port boşalır; kendiliğinden
   * toparlanabilmek için düzenli aralıkla yeniden dene. Aksi halde kullanıcı
   * hayalet süreci kapatsa bile bu pencere kalıcı olarak sağır kalır.
   */
  _onPortInUse() {
    this.emit('portInUse', { port: this.port });
    if (this._retryTimer) return;

    // Başarısız dinleyicileri bırak ki start() yeniden çalışabilsin.
    try {
      this.server?.close();
    } catch {
      /* zaten ölü */
    }
    try {
      this._server6?.close();
    } catch {
      /* zaten ölü */
    }
    this.server = null;
    this._server6 = null;

    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.start();
    }, 2000);
  }

  _onConnection(socket) {
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
  }

  stop() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this._rejectAll(new Error('Köprü kapatıldı.'));

    // close() nazik kapanıştır: karşı taraftan onay bekler. Eklenti yanıt
    // vermezse soket açık kalır, server.close() hiç tamamlanmaz ve süreç
    // penceresiz hayalet olarak yaşamaya devam edip portu tutar.
    // terminate() bağlantıyı anında koparır.
    try {
      this.socket?.terminate();
    } catch {
      /* zaten kapalı */
    }
    this.socket = null;

    // Sunucuya bağlı BÜTÜN istemcileri kopar; yoksa close() askıda kalır.
    for (const server of [this.server, this._server6]) {
      if (!server) continue;
      for (const client of server.clients ?? []) {
        try {
          client.terminate();
        } catch {
          /* zaten kapalı */
        }
      }
      try {
        server.close();
      } catch {
        /* zaten kapalı */
      }
    }
    this.server = null;
    this._server6 = null;
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
