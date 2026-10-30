/**
 * Electron ana süreç — modülleri birbirine bağlar ve arayüze IPC açar.
 */

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const { Bridge } = require('../core/bridge');
const { RecordingLibrary } = require('../core/recordings');
const { Recorder } = require('../core/recorder');
const { Player } = require('../core/player');
const excel = require('../core/excel');
const desi = require('../core/desi');
const { DesiSettings } = require('../core/desi-settings');
const { DEFAULT_PORT, ToApp } = require('../shared/protocol');

let window = null;
let bridge = null;
let library = null;
let recorder = null;
let player = null;
let settings = null;

/** Yüklenen Excel'in gruplanmış hali — her hesaplamada yeniden okunmasın diye. */
let loadedOrders = null;
let loadedFilePath = null;

/** Arayüze olay gönderir (pencere kapalıysa sessizce yutar). */
function emit(channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 820,
    title: 'Desi İtiraz Otomasyonu',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function wireEvents() {
  bridge.on('connected', () => emit('bridge:status', { connected: true, port: bridge.port }));
  bridge.on('disconnected', () => emit('bridge:status', { connected: false, port: bridge.port }));
  bridge.on('bridgeError', (err) => emit('bridge:error', { message: err.message }));
  bridge.on('portInUse', ({ port }) =>
    emit('bridge:error', {
      fatal: true,
      message: `Uygulamanın başka bir örneği açık (port ${port}) — bu pencereyi kapatın`,
    })
  );
  bridge.on(ToApp.TAB_INFO, (payload) => emit('bridge:tab', payload));

  recorder.on('stepAdded', ({ recording, step, merged }) =>
    emit('recorder:step', { recording, step, merged })
  );
  recorder.on('stepUpdated', ({ recording, step }) =>
    emit('recorder:stepUpdated', { recording, step })
  );
  recorder.on('variableSuggestion', (payload) => emit('recorder:variable', payload));
  player.on('setupStarted', ({ recording, count }) =>
    emit('player:setupStarted', { name: recording.customLabel || recording.sequentialName, count })
  );
  player.on('setupFinished', ({ recording }) =>
    emit('player:setupFinished', {
      name: recording.customLabel || recording.sequentialName,
    })
  );
  player.on('setupFailed', ({ detail }) => emit('player:setupFailed', { detail }));

  player.on('runStarted', (payload) => emit('player:runStarted', payload));
  player.on('rowStarted', ({ entry, index }) => emit('player:rowStarted', { entry, index }));
  player.on('rowFinished', ({ entry, index }) => emit('player:rowFinished', { entry, index }));
  player.on('stepFinished', ({ index, step, result }) =>
    emit('player:step', { index, action: step.action, stepId: step.stepId, result })
  );
  player.on('stepSkipped', ({ index, step }) =>
    emit('player:stepSkipped', { index, stepId: step.stepId })
  );
  player.on('paused', () => emit('player:state', { state: 'paused' }));
  player.on('resumed', () => emit('player:state', { state: 'running' }));
  player.on('stopped', () => emit('player:state', { state: 'stopped' }));
  player.on('runFinished', (payload) => emit('player:runFinished', payload));
}

function registerIpc() {
  // --- Köprü ---
  ipcMain.handle('bridge:status', () => ({ connected: bridge.isConnected, port: bridge.port }));

  // --- Kayıt Kitaplığı ---
  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:listByKind', (_e, { kind, panel }) =>
    library.listByKind(kind, panel ?? null)
  );
  ipcMain.handle('library:get', (_e, id) => library.get(id));
  ipcMain.handle('library:rename', (_e, { id, label }) => library.rename(id, label));
  ipcMain.handle('library:delete', (_e, id) => library.delete(id));
  ipcMain.handle('library:duplicate', (_e, id) => library.duplicate(id));
  ipcMain.handle('library:save', (_e, recording) => library.save(recording));

  ipcMain.handle('library:setReason', (_e, { id, itirazSebebi }) => {
    const recording = library.get(id);
    if (!recording) return null;
    recording.itirazSebebi = String(itirazSebebi ?? '').trim();
    return library.save(recording);
  });

  /**
   * Kaydın başına doğrudan adrese gitme adımı ekler. Menüyle gezinmek yerine
   * hedef sayfaya doğrudan gitmek çok daha sağlamdır.
   */
  ipcMain.handle('library:prependNavigate', (_e, { id, url, replaceAll }) => {
    const recording = library.get(id);
    if (!recording) return null;

    const clean = String(url ?? '').trim();
    if (!clean) return null;

    // replaceAll: menüyle gezinme adımlarının yerine tek bir adres adımı.
    // Menü tıklamaları hover/animasyona bağlı olduğu için kırılgandır.
    if (replaceAll) recording.steps = [];

    recording.steps.unshift({ action: 'navigate', url: clean, optional: false, stepId: 0 });
    recording.steps.forEach((s, i) => {
      s.stepId = i + 1;
    });
    return library.save(recording);
  });

  /**
   * Kaydın sonuna "şu metin görünene kadar bekle" adımı ekler.
   * Sayfanın gerçekten açıldığını doğrular.
   */
  ipcMain.handle('library:appendWaitFor', (_e, { id, text }) => {
    const recording = library.get(id);
    if (!recording) return null;

    const clean = String(text ?? '').trim();
    if (!clean) return null;

    recording.steps.push({
      stepId: recording.steps.length + 1,
      action: 'waitForElement',
      selector: { strategies: [{ type: 'text', value: clean }] },
      timeoutMs: 15000,
      optional: false,
    });
    return library.save(recording);
  });

  /** Bir adımı opsiyonel işaretler/kaldırır — spec §4.5 */
  ipcMain.handle('library:setStepOptional', (_e, { id, stepId, optional }) => {
    const recording = library.get(id);
    if (!recording) return null;
    const step = recording.steps.find((s) => s.stepId === stepId);
    if (!step) return null;
    step.optional = !!optional;
    return library.save(recording);
  });

  ipcMain.handle('library:deleteStep', (_e, { id, stepId }) => {
    const recording = library.get(id);
    if (!recording) return null;
    recording.steps = recording.steps
      .filter((s) => s.stepId !== stepId)
      .map((s, i) => ({ ...s, stepId: i + 1 }));
    return library.save(recording);
  });

  // --- Kaydedici ---
  ipcMain.handle('recorder:start', (_e, { panel, kind }) => recorder.start(panel, kind));
  ipcMain.handle('recorder:stop', () => recorder.stop());
  ipcMain.handle('recorder:cancel', () => recorder.cancel());
  ipcMain.handle('recorder:bind', (_e, { stepId, variableKey }) =>
    recorder.bindVariable(stepId, variableKey)
  );
  ipcMain.handle('recorder:reset', () => recorder.reset());
  ipcMain.handle('recorder:isActive', () => recorder.active);

  // --- Excel ---
  ipcMain.handle('excel:pick', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Excel dosyası seç',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const { sheetName, headers, rows } = excel.readWorkbook(filePath);
    return {
      filePath,
      sheetName,
      headers,
      mapping: excel.suggestMapping(headers),
      preview: rows.slice(0, 20),
      rowCount: rows.length,
    };
  });

  ipcMain.handle('excel:buildQueue', (_e, { filePath, mapping, variables }) => {
    const { rows } = excel.readWorkbook(filePath);
    return excel.buildQueue(rows, mapping, variables);
  });

  ipcMain.handle('excel:export', async (_e, { entries, variables }) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Sonuçları kaydet',
      defaultPath: 'itiraz_sonuclari.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return excel.exportResults(result.filePath, entries, variables);
  });

  // --- Desi itiraz hesaplama ---
  ipcMain.handle('desi:pick', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Trendyol "Siparişleriniz" Excel dosyasını seç',
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    // 147 bin satırlık dosyanın okunması ~1 dk sürüyor; her hesaplamada
    // yeniden okumamak için gruplanmış hali bellekte tutulur.
    const workbook = desi.readOrderWorkbook(filePath);
    loadedOrders = desi.groupByOrder(workbook);
    loadedFilePath = filePath;

    return {
      filePath,
      fileName: path.basename(filePath),
      sheetName: workbook.sheetName,
      kind: workbook.kind,
      label: workbook.label,
      satirSayisi: workbook.rows.length,
      siparisSayisi: loadedOrders.length,
    };
  });

  ipcMain.handle('desi:getSettings', () => settings.read());
  ipcMain.handle('desi:saveSettings', (_e, next) => settings.write(next));
  ipcMain.handle('desi:resetSettings', () => settings.reset());
  ipcMain.handle('desi:defaultCategories', () => ({ ...desi.DEFAULT_CATEGORY_DESI }));

  ipcMain.handle('desi:compute', () => {
    if (!loadedOrders) throw new Error('Önce bir Excel dosyası yükleyin.');
    const current = settings.read();
    const { claims, all, stats } = desi.computeClaims(loadedOrders, current);
    return { claims, all, stats, filePath: loadedFilePath, settings: current };
  });

  ipcMain.handle('desi:exportClaims', async (_e, { claims }) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'İtiraz listesini kaydet',
      defaultPath: 'desi_itirazlari.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return desi.exportClaims(result.filePath, claims);
  });

  ipcMain.handle('desi:exportAll', async (_e, { all }) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Tüm sonuçları kaydet',
      defaultPath: 'desi_tum_sonuclar.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return desi.exportAllResults(result.filePath, all);
  });

  // --- Player ---
  ipcMain.handle('player:run', (_e, { queue, panel, setupRecordingId, stopOnFirstError }) =>
    player.run(queue, { panel, setupRecordingId, stopOnFirstError })
  );
  ipcMain.handle('player:pause', () => player.pause());
  ipcMain.handle('player:resume', () => player.resume());
  ipcMain.handle('player:stop', () => player.stop());
}

// Tek örnek kilidi. İkinci bir örnek açılırsa port çakışır, eklenti yanlış
// örneğe bağlanır ve kullanıcı "bağlı değil" sanır. İkinciyi hemen kapat,
// var olan pencereyi öne getir.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  const dataDir = path.join(app.getPath('userData'), 'data');

  library = new RecordingLibrary(dataDir);
  settings = new DesiSettings(dataDir);
  bridge = new Bridge({ port: DEFAULT_PORT });
  recorder = new Recorder({ bridge, library });
  player = new Player({ bridge, library });

  // Dinleyiciler köprüden ÖNCE bağlanmalı. Aksi halde eklenti tam bu aralıkta
  // bağlanırsa 'connected' olayı dinleyicisiz yayılıp kaybolur ve arayüz
  // kalıcı olarak "bağlı değil" durumunda takılı kalır.
  wireEvents();
  registerIpc();
  createWindow();
  bridge.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  bridge?.stop();
  if (process.platform !== 'darwin') app.quit();
});

// Köprü kapanmazsa (açık soket/zamanlayıcı) süreç penceresiz hayalet olarak
// yaşamaya devam eder ve portu tutar; sonraki açılış "başka örnek açık"
// hatası verir. Çıkışta kapanışı garantiye al.
app.on('before-quit', () => {
  bridge?.stop();
});

app.on('will-quit', () => {
  bridge?.stop();
});
