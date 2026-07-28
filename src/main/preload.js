/**
 * Preload — arayüze yalnızca açıkça izin verilen IPC yüzeyini açar.
 * contextIsolation açık, nodeIntegration kapalı.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Ana süreçten gelen olaylar için abonelik; temizleyici fonksiyon döner. */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  bridge: {
    status: () => ipcRenderer.invoke('bridge:status'),
    onStatus: (handler) => on('bridge:status', handler),
    onError: (handler) => on('bridge:error', handler),
    onTab: (handler) => on('bridge:tab', handler),
  },

  library: {
    list: () => ipcRenderer.invoke('library:list'),
    listByKind: (kind, panel) => ipcRenderer.invoke('library:listByKind', { kind, panel }),
    get: (id) => ipcRenderer.invoke('library:get', id),
    rename: (id, label) => ipcRenderer.invoke('library:rename', { id, label }),
    remove: (id) => ipcRenderer.invoke('library:delete', id),
    duplicate: (id) => ipcRenderer.invoke('library:duplicate', id),
    save: (recording) => ipcRenderer.invoke('library:save', recording),
    setReason: (id, itirazSebebi) => ipcRenderer.invoke('library:setReason', { id, itirazSebebi }),
    setStepOptional: (id, stepId, optional) =>
      ipcRenderer.invoke('library:setStepOptional', { id, stepId, optional }),
    prependNavigate: (id, url, replaceAll) =>
      ipcRenderer.invoke('library:prependNavigate', { id, url, replaceAll }),
    appendWaitFor: (id, text) => ipcRenderer.invoke('library:appendWaitFor', { id, text }),
    deleteStep: (id, stepId) => ipcRenderer.invoke('library:deleteStep', { id, stepId }),
  },

  recorder: {
    start: (panel, kind) => ipcRenderer.invoke('recorder:start', { panel, kind }),
    stop: () => ipcRenderer.invoke('recorder:stop'),
    cancel: () => ipcRenderer.invoke('recorder:cancel'),
    bind: (stepId, variableKey) => ipcRenderer.invoke('recorder:bind', { stepId, variableKey }),
    reset: () => ipcRenderer.invoke('recorder:reset'),
    isActive: () => ipcRenderer.invoke('recorder:isActive'),
    onStep: (handler) => on('recorder:step', handler),
    onStepUpdated: (handler) => on('recorder:stepUpdated', handler),
    onVariable: (handler) => on('recorder:variable', handler),
  },

  excel: {
    pick: () => ipcRenderer.invoke('excel:pick'),
    buildQueue: (filePath, mapping, variables) =>
      ipcRenderer.invoke('excel:buildQueue', { filePath, mapping, variables }),
    exportResults: (entries, variables) =>
      ipcRenderer.invoke('excel:export', { entries, variables }),
  },

  player: {
    run: (queue, panel, setupRecordingId, stopOnFirstError) =>
      ipcRenderer.invoke('player:run', { queue, panel, setupRecordingId, stopOnFirstError }),
    pause: () => ipcRenderer.invoke('player:pause'),
    resume: () => ipcRenderer.invoke('player:resume'),
    stop: () => ipcRenderer.invoke('player:stop'),
    onRunStarted: (handler) => on('player:runStarted', handler),
    onRowStarted: (handler) => on('player:rowStarted', handler),
    onRowFinished: (handler) => on('player:rowFinished', handler),
    onStep: (handler) => on('player:step', handler),
    onStepSkipped: (handler) => on('player:stepSkipped', handler),
    onSetupStarted: (handler) => on('player:setupStarted', handler),
    onSetupFinished: (handler) => on('player:setupFinished', handler),
    onSetupFailed: (handler) => on('player:setupFailed', handler),
    onState: (handler) => on('player:state', handler),
    onRunFinished: (handler) => on('player:runFinished', handler),
  },
});
