/**
 * Orchestrator <-> Chrome eklentisi mesaj sözleşmesi.
 *
 * Bu dosya her iki tarafça da paylaşılır. Panel'e (Trendyol vb.) özgü HİÇBİR
 * bilgi burada bulunamaz — spec §9.5.
 */

/** Uygulamadan eklentiye giden mesajlar */
const ToExtension = {
  START_RECORDING: 'startRecording',
  STOP_RECORDING: 'stopRecording',
  EXECUTE_STEP: 'executeStep',
  HIGHLIGHT: 'highlight',
  PING: 'ping',
};

/** Eklentiden uygulamaya gelen mesajlar */
const ToApp = {
  HELLO: 'hello',
  RECORDED_EVENT: 'recordedEvent',
  STEP_RESULT: 'stepResult',
  TAB_INFO: 'tabInfo',
  PONG: 'pong',
  ERROR: 'error',
};

/** Bir adımın yapabileceği eylemler */
const Action = {
  NAVIGATE: 'navigate',
  CLICK: 'click',
  TYPE: 'type',
  SELECT_OPTION: 'selectOption',
  WAIT_FOR_ELEMENT: 'waitForElement',
};

/**
 * Seçici stratejileri — spec §4.4'teki öncelik sırası.
 * Dizideki sıra, denenme sırasıdır.
 */
const SelectorType = {
  TEST_ATTR: 'testAttr',
  ID: 'id',
  NAME: 'name',
  TEXT: 'text',
  ARIA_LABEL: 'ariaLabel',
  CSS_PATH: 'cssPath',
};

const SELECTOR_PRIORITY = [
  SelectorType.TEST_ATTR,
  SelectorType.ID,
  SelectorType.NAME,
  SelectorType.TEXT,
  SelectorType.ARIA_LABEL,
  SelectorType.CSS_PATH,
];

/** Son çare olan ve kullanıcıya "kırılgan" diye gösterilmesi gereken stratejiler */
const FRAGILE_SELECTOR_TYPES = new Set([SelectorType.CSS_PATH]);

/**
 * Bir Kaydın türü.
 *
 * SETUP : "itiraz sayfasına kadar gel" — menüye tıklama, sekme değiştirme.
 *         Batch'in en başında YALNIZCA BİR KEZ çalışır. Sipariş bilgisi
 *         kullanmaz.
 * ITIRAZ: her sipariş için tekrarlanan asıl iş. {{siparisNo}} gibi
 *         değişkenleri kullanır.
 *
 * İkisi ayrı Kayıtlardır; kullanıcı Çalıştır ekranında hangisinin hangi rolde
 * olduğunu seçer.
 */
const RecordingKind = {
  SETUP: 'setup',
  ITIRAZ: 'itiraz',
};

/** Bir adımın çalışma sonucu */
const StepStatus = {
  OK: 'ok',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** Bir Excel satırının sonucu — spec §7 + docs/excel-sablonu.md */
const RowStatus = {
  PENDING: 'Bekliyor',
  RUNNING: 'Çalışıyor',
  SUCCESS: 'Başarılı',
  FAILED: 'Başarısız',
  NO_MATCH: 'Eşleşme bulunamadı',
  MISSING_DATA: 'Eksik veri',
};

const DEFAULT_PORT = 17321;
const DEFAULT_STEP_TIMEOUT_MS = 15000;
const PER_STRATEGY_TIMEOUT_MS = 2500;

module.exports = {
  ToExtension,
  ToApp,
  Action,
  RecordingKind,
  SelectorType,
  SELECTOR_PRIORITY,
  FRAGILE_SELECTOR_TYPES,
  StepStatus,
  RowStatus,
  DEFAULT_PORT,
  DEFAULT_STEP_TIMEOUT_MS,
  PER_STRATEGY_TIMEOUT_MS,
};
