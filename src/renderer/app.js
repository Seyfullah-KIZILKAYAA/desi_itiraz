/* Arayüz mantığı. Tüm ana süreç erişimi preload'daki window.api üzerinden. */

const $ = (id) => document.getElementById(id);

const state = {
  panel: 'trendyol',
  recordings: [],
  selectedId: null,
  recordingActive: false,
  recordingKind: 'itiraz',
  excel: null, // {filePath, headers, mapping, preview}
  orders: null, // yüklenen sipariş dosyasının özeti
  claims: [], // hesaplanan itiraz listesi
  claimsPage: 0,
  selectedClaims: new Set(),
  queue: [],
  variables: [],
  running: false,
  paused: false,
};

/** Faz 1 sistem değişkenleri — templates/desi_itiraz_sablonu.xlsx > "Açıklama" */
const FALLBACK_VARIABLES = [
  { key: 'siparisNo', label: 'Sipariş No', required: true },
  { key: 'dogruDesi', label: 'Doğru Desi', required: true },
  { key: 'itirazSebebi', label: 'İtiraz Sebebi', required: false },
  { key: 'aciklama', label: 'Açıklama', required: false },
];

// ---------------- Diyalog ----------------
// Electron window.prompt() desteklemez ("prompt() is not supported" fırlatır),
// bu yüzden kendi penceremizi kullanıyoruz. window.confirm ve window.alert
// Electron'da çalışır, onlar olduğu gibi kalır.

/**
 * Metin soran diyalog. İptal edilirse null döner (prompt ile aynı sözleşme).
 * @returns {Promise<string|null>}
 */
function ask(title, { body = '', value = '', okLabel = 'Tamam' } = {}) {
  return new Promise((resolve) => {
    const back = $('modalBack');
    const input = $('modalInput');
    const ok = $('modalOk');
    const cancel = $('modalCancel');

    $('modalTitle').textContent = title;
    $('modalBody').textContent = body;
    ok.textContent = okLabel;
    input.value = value;

    const close = (result) => {
      back.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      back.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    };

    const onOk = () => close(input.value);
    const onCancel = () => close(null);
    const onKey = (event) => {
      if (event.key === 'Enter') onOk();
      else if (event.key === 'Escape') onCancel();
    };
    // Yalnızca karartılmış zemine tıklanınca kapat; pencere içine değil.
    const onBackdrop = (event) => {
      if (event.target === back) onCancel();
    };

    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', onBackdrop);

    back.hidden = false;
    input.focus();
    input.select();
  });
}

// ---------------- Sekmeler ----------------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('is-active'));
  $(`tab-${name}`).classList.add('is-active');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ---------------- Köprü durumu ----------------

/** Port çakışması gibi kalıcı sorunlar durum yazısını ele geçirir. */
let bridgeFault = null;

function paintBridge({ connected, port }) {
  const box = $('bridgeStatus');
  box.classList.toggle('status--on', connected);
  box.classList.toggle('status--off', !connected);

  if (!connected && bridgeFault) {
    $('bridgeText').textContent = bridgeFault;
    return;
  }
  if (connected) bridgeFault = null;

  $('bridgeText').textContent = connected
    ? `Eklenti bağlı (:${port})`
    : `Eklenti bağlı değil (:${port} bekleniyor)`;
}

window.api.bridge.onStatus(paintBridge);
window.api.bridge.onError(({ message, fatal }) => {
  log(`Köprü hatası: ${message}`, 'fail');
  // Günlük yalnızca Çalıştır sekmesinde görünür; kalıcı arızayı üstteki
  // durum çubuğunda da göster ki hangi sekmede olursa olsun fark edilsin.
  if (fatal) {
    bridgeFault = message;
    window.api.bridge.status().then(paintBridge);
  }
});
window.api.bridge.status().then(paintBridge);

// Olay tabanlı güncelleme tek bir kaçan mesajda pencereyi kalıcı olarak yanlış
// durumda bırakabiliyor (ör. bağlantı, pencere hazır olmadan kurulursa).
// Gerçek durumu düzenli aralıkla doğrula.
setInterval(() => {
  window.api.bridge.status().then(paintBridge);
}, 3000);

// ---------------- Kayıt Kitaplığı ----------------

async function refreshLibrary() {
  state.recordings = await window.api.library.list();
  renderRecordings();
  renderSteps();
  renderRunSelectors();
}

/**
 * Çalıştır ekranındaki iki menü: hangi kayıt bir kez, hangisi her sipariş için.
 * Seçimler kayıt listesi değişse de korunur.
 */
function renderRunSelectors() {
  fillSelect(
    $('setupSelect'),
    state.recordings.filter((r) => r.kind === 'setup'),
    '— hazırlık kaydı kullanma —'
  );
  fillSelect(
    $('itirazSelect'),
    state.recordings.filter((r) => r.kind !== 'setup'),
    '— Excel\'deki sebebe göre eşleştir —'
  );
}

function fillSelect(select, recordings, emptyLabel) {
  const previous = select.value;
  select.textContent = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = emptyLabel;
  select.appendChild(none);

  for (const rec of recordings) {
    const option = document.createElement('option');
    option.value = rec.recordingId;
    option.textContent = `${displayName(rec)} (${rec.steps.length} adım)`;
    select.appendChild(option);
  }

  // Önceki seçim hâlâ geçerliyse koru.
  if (previous && recordings.some((r) => r.recordingId === previous)) {
    select.value = previous;
  }
}

function displayName(r) {
  return r.customLabel || r.sequentialName;
}

function renderRecordings() {
  const box = $('recordingList');
  box.textContent = '';

  if (state.recordings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Henüz kayıt yok. "Yeni Kayıt Başlat" ile ilk kaydı oluşturun.';
    box.appendChild(empty);
    return;
  }

  for (const rec of state.recordings) {
    const card = document.createElement('div');
    card.className = 'card' + (rec.recordingId === state.selectedId ? ' is-selected' : '');
    card.addEventListener('click', () => {
      state.selectedId = rec.recordingId;
      renderRecordings();
      renderSteps();
    });

    const title = document.createElement('div');
    title.className = 'card__title';
    title.textContent = displayName(rec);
    card.appendChild(title);

    const kindTag = document.createElement('span');
    kindTag.className = `badge badge--${rec.kind === 'setup' ? 'setup' : 'itiraz'}`;
    kindTag.textContent = rec.kind === 'setup' ? 'Hazırlık' : 'İtiraz';
    title.appendChild(kindTag);

    const meta = document.createElement('div');
    meta.className = 'card__meta';
    const reason = rec.itirazSebebi ? ` · sebep: ${rec.itirazSebebi}` : '';
    meta.textContent = `${rec.sequentialName} · ${rec.panel} · ${rec.steps.length} adım${reason}`;
    card.appendChild(meta);

    // Sabit sipariş no uyarısı — bu kayıt çalıştırılırsa satırlar düşer.
    const hardcoded = hardcodedOrderNoOf(rec);
    if (hardcoded) {
      const warn = document.createElement('div');
      warn.className = 'card__warn';
      warn.textContent =
        `⚠ Sipariş numarası sabit "${hardcoded}" yazılmış. Sipariş no adımını ` +
        '{{siparisNo}} değişkenine bağlayın, yoksa hep aynı siparişe itiraz gider.';
      card.appendChild(warn);
    }

    const actions = document.createElement('div');
    actions.className = 'card__actions';
    actions.appendChild(button('Yeniden Adlandır', () => renameRecording(rec)));
    actions.appendChild(button('Adres Adımı Ekle', () => addNavigateStep(rec)));
    // Sebep eşleştirmesi yalnızca itiraz kayıtları için anlamlı.
    if (rec.kind !== 'setup') {
      actions.appendChild(button('Sebep Ata', () => assignReason(rec)));
    }
    actions.appendChild(button('Kopyala', async () => {
      await window.api.library.duplicate(rec.recordingId);
      refreshLibrary();
    }));
    actions.appendChild(button('Sil', async () => {
      if (!confirm(`"${displayName(rec)}" silinsin mi?`)) return;
      await window.api.library.remove(rec.recordingId);
      if (state.selectedId === rec.recordingId) state.selectedId = null;
      refreshLibrary();
    }));
    card.appendChild(actions);

    box.appendChild(card);
  }
}

function button(label, onClick) {
  const el = document.createElement('button');
  el.className = 'small';
  el.textContent = label;
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return el;
}

async function renameRecording(rec) {
  const label = await ask('Yeni etiket', { value: displayName(rec) });
  if (label === null) return;
  await window.api.library.rename(rec.recordingId, label);
  refreshLibrary();
}

/**
 * Kaydın başına doğrudan adrese gitme adımı ekler.
 * Menüyle gezinmenin kırılganlığına karşı en sağlam çözüm.
 */
async function addNavigateStep(rec) {
  const url = await ask('Gidilecek adres', {
    body:
      "Chrome'da hedef sayfayı açın, adres çubuğundaki adresi kopyalayıp " +
      'buraya yapıştırın.',
    value: 'https://partner.trendyol.com/',
  });
  if (url === null) return;

  const clean = url.trim();
  if (!clean) return;
  if (!/^https?:\/\//i.test(clean)) {
    alert('Adres http:// veya https:// ile başlamalı.');
    return;
  }

  // Mevcut adımlar varsa: menüyle gezinme adımlarını temizlemek çoğu durumda
  // istenen davranıştır, ama kullanıcı karar vermeli.
  let replaceAll = false;
  if (rec.steps.length > 0) {
    replaceAll = confirm(
      `Bu kayıtta ${rec.steps.length} adım var.\n\n` +
        'TAMAM  = Mevcut adımları SİL, sadece adrese gitsin (önerilen)\n' +
        'İPTAL  = Adımları koru, adresi başa ekle'
    );
  }

  await window.api.library.prependNavigate(rec.recordingId, clean, replaceAll);

  // Yalnızca navigate içeren bir kayıt, sayfa gerçekten açıldı mı bilmeden
  // "başarılı" der. Sayfada görünmesi gereken bir metin beklenirse bu
  // belirsizlik kalkar.
  if (replaceAll) {
    const marker = await ask('Sayfanın açıldığını nasıl anlayalım?', {
      body:
        'O sayfada MUTLAKA görünen bir metin yazın (örn. bir başlık veya ' +
        'sütun adı). Boş bırakırsanız sayfa kontrolü yapılmaz.',
      okLabel: 'Ekle',
    });
    const text = (marker ?? '').trim();
    if (text) {
      await window.api.library.appendWaitFor(rec.recordingId, text);
    }
  }

  refreshLibrary();
}

async function assignReason(rec) {
  const reason = await ask('İtiraz Sebebi', {
    body: "Bu Kaydın uygulanacağı sebep — Excel'deki metinle birebir aynı olmalı.",
    value: rec.itirazSebebi || '',
  });
  if (reason === null) return;
  await window.api.library.setReason(rec.recordingId, reason);
  refreshLibrary();
}

// ---------------- Adım listesi ----------------

function isFragile(step) {
  const strategies = step?.selector?.strategies ?? [];
  return strategies.length > 0 && strategies.every((s) => s.type === 'cssPath');
}

function describeSelector(step) {
  const first = step?.selector?.strategies?.[0];
  if (step.action === 'navigate') return step.url ?? '';
  if (!first) return '';
  const attr = first.attr ? `${first.attr}=` : '';
  return `${first.type}: ${attr}${first.value}`;
}

function renderSteps() {
  const box = $('stepList');
  box.textContent = '';

  const rec = state.recordings.find((r) => r.recordingId === state.selectedId);
  if (!rec) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Adımları görmek için soldan bir kayıt seçin.';
    box.appendChild(hint);
    return;
  }

  if (rec.steps.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Bu kayıtta henüz adım yok.';
    box.appendChild(hint);
    return;
  }

  const header = document.createElement('div');
  header.className = 'phase-head';
  header.textContent =
    (rec.kind === 'setup' ? 'HAZIRLIK — bir kez çalışır' : 'İTİRAZ — her sipariş için') +
    ` (${rec.steps.length} adım)`;
  box.appendChild(header);

  for (const step of rec.steps) box.appendChild(stepCard(rec, step));
}

/** Tek bir adım kartı. */
function stepCard(rec, step) {
  const card = document.createElement('div');
  card.className = 'card step';

    const id = document.createElement('div');
    id.className = 'step__id';
    id.textContent = step.stepId;
    card.appendChild(id);

    const body = document.createElement('div');
    body.className = 'step__body';

    const head = document.createElement('div');
    head.textContent = step.action;
    if (step.value !== undefined && step.value !== '') {
      const value = document.createElement('span');
      value.className = 'muted';
      value.textContent = `  → ${step.value}`;
      head.appendChild(value);
    }
    if (step.optional) head.appendChild(badge('opsiyonel', 'optional'));
    if (isFragile(step)) head.appendChild(badge('kırılgan', 'fragile'));
    body.appendChild(head);

    const sel = document.createElement('div');
    sel.className = 'step__sel';
    sel.textContent = describeSelector(step);
    body.appendChild(sel);

    const actions = document.createElement('div');
    actions.className = 'card__actions';
    actions.appendChild(
      button(step.optional ? 'Zorunlu Yap' : 'Opsiyonel Yap', async () => {
        await window.api.library.setStepOptional(rec.recordingId, step.stepId, !step.optional);
        refreshLibrary();
      })
    );
    actions.appendChild(
      button('Sil', async () => {
        await window.api.library.deleteStep(rec.recordingId, step.stepId);
        refreshLibrary();
      })
    );
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

function badge(text, kind) {
  const el = document.createElement('span');
  el.className = `badge badge--${kind}`;
  el.textContent = text;
  return el;
}

// ---------------- Kaydedici ----------------

$('btnStartRec').addEventListener('click', async () => {
  // Köprü kopukken başlatmaya çalışmak anlamsız; net bir mesaj ver.
  const status = await window.api.bridge.status();
  if (!status.connected) {
    alert(
      'Chrome eklentisi bağlı değil.\n\n' +
        '1. Chrome açık mı?\n' +
        '2. Eklenti kurulu mu? (chrome://extensions)\n' +
        '3. Eklenti simgesindeki rozet "ON" (yeşil) mi?\n\n' +
        'Rozet "OFF" ise chrome://extensions sayfasından eklentiyi ' +
        'Yeniden Yükle deyin.'
    );
    return;
  }

  try {
    const kind = $('kindSelect').value;
    const rec = await window.api.recorder.start($('panelSelect').value, kind);
    state.recordingActive = true;
    state.recordingKind = kind;
    state.selectedId = rec.recordingId;
    paintRecBanner(rec);
    toggleRecordingButtons();
    refreshLibrary();
  } catch (err) {
    // Yarıda kalmış bir oturum varsa temizle ki kullanıcı kilitli kalmasın.
    const message = String(err.message ?? err);
    if (/Zaten süren bir kayıt/.test(message)) {
      await window.api.recorder.reset();
      state.recordingActive = false;
      hideBanner();
      toggleRecordingButtons();
      await refreshLibrary();
      alert(
        'Önceki kayıt oturumu yarıda kalmıştı, temizlendi.\n\n' +
          '"Yeni Kayıt Başlat"a tekrar basın.'
      );
      return;
    }
    alert(`Kayıt başlatılamadı: ${message}`);
  }
});

/** Kayıt sırasında ne yapılması gerektiğini ve kaç adım yakalandığını anlatır. */
function paintRecBanner(rec) {
  const name = rec ? displayName(rec) : 'Kayıt';
  const count = rec?.steps?.length ?? 0;
  const counter = `\n\nŞu ana kadar yakalanan adım: ${count}`;

  if (state.recordingKind === 'setup') {
    showBanner(
      `${name} — HAZIRLIK KAYDI\n\n` +
        `Chrome'da desi itiraz sayfasına kadar gidin (menüye tıklayın, ` +
        `sekmeye geçin). Sipariş aramayın, itiraz yapmayın — sadece sayfaya ulaşın.\n\n` +
        `Bu kayıt çalışmanın en başında bir kez çalışacak.\n\n` +
        `İtiraz sayfasına ulaşınca "Kaydı Bitir"e basın.` +
        counter
    );
  } else {
    showBanner(
      `${name} — İTİRAZ KAYDI\n\n` +
        `Zaten itiraz sayfasında olduğunuzu varsayın. Bir siparişin itirazını ` +
        `baştan sona yapın: sipariş no yazın, arayın, itiraz edin, desi girin, gönderin.\n\n` +
        `Bu kayıt Excel'deki her satır için tekrarlanacak.\n\n` +
        `Onay ekranını görünce "Kaydı Bitir"e basın.` +
        counter
    );
  }
}

$('btnStopRec').addEventListener('click', async () => {
  const saved = await window.api.recorder.stop();
  state.recordingActive = false;
  hideBanner();
  toggleRecordingButtons();
  refreshLibrary();
  warnHardcodedOrderNo(saved);
});

/**
 * Kayıtta sipariş numarası {{siparisNo}}'ya bağlanmadıysa uyarır.
 *
 * Bağlanmazsa kayıt sırasında yazılan numara sabitlenir ve çalıştırmada her
 * satır aynı siparişe itiraz gönderir. Player bunu yakalayıp satırları
 * düşürüyor, ama kullanıcı bunu kaydı bitirir bitirmez bilmeli.
 */
function hardcodedOrderNoOf(recording) {
  if (!recording || recording.kind === 'setup') return null;

  const steps = recording.steps ?? [];
  const usesVariable = steps.some((s) =>
    /\{\{\s*siparisNo\s*\}\}/.test(String(s?.value ?? s?.text ?? ''))
  );
  if (usesVariable) return null;

  // Sipariş numarası uzun bir rakam dizisidir.
  return (
    steps
      .map((s) => String(s?.value ?? s?.text ?? '').trim())
      .find((v) => /^\d{8,}$/.test(v)) ?? null
  );
}

function warnHardcodedOrderNo(recording) {
  const hardcoded = hardcodedOrderNoOf(recording);
  if (!hardcoded) return;

  alert(
    `DİKKAT: Bu kayıt sipariş numarasını sabit "${hardcoded}" olarak yazıyor.\n\n` +
      'Böyle bırakılırsa çalıştırmada HER satır bu aynı siparişe itiraz gönderir.\n\n' +
      'Adımlar listesinden sipariş no adımını bulup "Değişkene Bağla" ile ' +
      '{{siparisNo}} seçin.'
  );
}

$('btnCancelRec').addEventListener('click', async () => {
  if (!confirm('Kayıt iptal edilsin ve silinsin mi?')) return;
  await window.api.recorder.cancel();
  state.recordingActive = false;
  state.selectedId = null;
  hideBanner();
  toggleRecordingButtons();
  refreshLibrary();
});

function toggleRecordingButtons() {
  const active = state.recordingActive;
  $('btnStartRec').hidden = active;
  $('btnStopRec').hidden = !active;
  $('btnCancelRec').hidden = !active;
  // Kayıt sürerken tür değiştirilemez.
  $('kindSelect').disabled = active;
  $('panelSelect').disabled = active;
}

function showBanner(text) {
  $('recBanner').textContent = text;
  $('recBanner').hidden = false;
}
function hideBanner() {
  $('recBanner').hidden = true;
}

window.api.recorder.onStep(({ recording, step, merged }) => {
  const index = state.recordings.findIndex((r) => r.recordingId === recording.recordingId);
  if (index >= 0) state.recordings[index] = recording;
  else state.recordings.push(recording);

  // Kayıt sırasında görünür geri bildirim: kullanıcı adımın yakalandığını görsün.
  if (!merged) log(`Adım ${step.stepId} yakalandı: ${step.action}`);

  if (state.recordingActive) paintRecBanner(recording);
  renderRecordings();
  renderSteps();
});

// Değişken önerisi — nihai kararı kullanıcı verir (spec §5.5).
// Kayıt sırasında hızlı olmalı: numara yazdırmak yerine düğme sunulur.
const VARIABLE_CHOICES = [
  { key: 'siparisNo', label: 'Sipariş No' },
  { key: 'dogruDesi', label: 'Doğru Desi' },
  { key: 'itirazSebebi', label: 'İtiraz Sebebi' },
  { key: 'aciklama', label: 'Açıklama' },
];

window.api.recorder.onVariable(async ({ stepId, value, guess }) => {
  const key = await askVariable(value, guess);
  if (key) {
    await window.api.recorder.bind(stepId, key);
    log(`Adım ${stepId}: "${value}" → {{${key}}} değişkenine bağlandı.`, 'ok');
  }
});

/** Değeri hangi değişkene bağlayacağımızı sorar; sabit kalsın derse null. */
function askVariable(value, guess) {
  return new Promise((resolve) => {
    const back = $('modalBack');
    const input = $('modalInput');
    const actions = document.querySelector('.modal__actions');

    $('modalTitle').textContent = 'Bu değeri değişken olarak kaydedeyim mi?';
    $('modalBody').textContent =
      `Yazdığınız değer: "${value}"\n\n` +
      'Her sipariş için değişecekse bir değişkene bağlayın. Hep aynı ' +
      'kalacaksa "Sabit kalsın" deyin.';
    input.hidden = true;

    // Bu diyalog metin değil seçim istiyor; düğmeleri geçici olarak değiştir.
    const originalActions = actions.innerHTML;

    const close = (result) => {
      back.hidden = true;
      input.hidden = false;
      actions.innerHTML = originalActions;
      resolve(result);
    };

    actions.textContent = '';

    for (const choice of VARIABLE_CHOICES) {
      const btn = document.createElement('button');
      btn.textContent = choice.label;
      if (choice.key === guess) {
        btn.className = 'primary';
        btn.textContent += ' ✓';
      }
      btn.addEventListener('click', () => close(choice.key));
      actions.appendChild(btn);
    }

    const fixed = document.createElement('button');
    fixed.textContent = 'Sabit kalsın';
    fixed.addEventListener('click', () => close(null));
    actions.appendChild(fixed);

    back.hidden = false;
  });
}

// ---------------- Desi itiraz hesaplama ----------------

/** 86 bin satır DOM'a basılmasın diye sayfalama. */
const CLAIMS_PAGE_SIZE = 100;

function desiBanner(text, kind = '') {
  const box = $('desiBanner');
  box.hidden = !text;
  box.textContent = text || '';
  box.className = 'banner' + (kind ? ` banner--${kind}` : '');
}

$('btnPickOrders').addEventListener('click', async () => {
  const button = $('btnPickOrders');
  button.disabled = true;
  desiBanner('Excel okunuyor… 150 bin satırlık dosyada bu bir dakikayı bulabilir.');

  try {
    const result = await window.api.desi.pick();
    if (!result) {
      desiBanner('');
      return;
    }

    state.orders = result;
    state.claims = [];
    state.claimsPage = 0;
    state.selectedClaims = new Set();

    $('ordersFile').textContent =
      `${result.label} · ${result.fileName} · ` +
      `${result.satirSayisi.toLocaleString('tr-TR')} satır · ` +
      `${result.siparisSayisi.toLocaleString('tr-TR')} sipariş`;
    $('btnCompute').disabled = false;
    $('claimsBox').hidden = true;
    $('claimStats').hidden = true;
    desiBanner(
      `"${result.label}" dosyası yüklendi. "İtirazları Hesapla" ile devam edin.`,
      'ok'
    );
  } catch (err) {
    desiBanner(`Excel okunamadı: ${err.message}`, 'warn');
  } finally {
    button.disabled = false;
  }
});

$('btnCompute').addEventListener('click', async () => {
  const button = $('btnCompute');
  button.disabled = true;
  desiBanner('Hesaplanıyor…');

  try {
    const { claims, stats } = await window.api.desi.compute();
    state.claims = claims;
    state.claimsPage = 0;
    state.selectedClaims = new Set();

    renderClaimStats(stats);
    renderClaims();
    $('claimsBox').hidden = false;
    desiBanner('');
  } catch (err) {
    desiBanner(`Hesaplanamadı: ${err.message}`, 'warn');
  } finally {
    button.disabled = false;
  }
});

function renderClaimStats(stats) {
  const box = $('claimStats');
  box.hidden = false;
  box.textContent = '';

  const n = (value) => Number(value || 0).toLocaleString('tr-TR');
  const cells = [
    ['Toplam sipariş', n(stats.toplamSiparis)],
    ['İtiraz edilecek', n(stats.itirazEdilecek)],
    ['Kargo tutarı eşiğinde elenen', n(stats.elenenFiyat)],
    ['Desi zaten doğru/düşük', n(stats.elenenKucultmeYok)],
    ['1 desi fark olduğu için elenen', n(stats.elenenYetersizFark)],
    ['1 yerine 2 desi girilecek', n(stats.yukseltilenIkiDesi)],
    ['İade edildiği için elenen', n(stats.elenenIade)],
    ['Mevcut desi 1 olduğu için elenen', n(stats.elenenTaban)],
    ['Kategorisi bulunamayan ürün içeren', n(stats.kategoriBulunamayan)],
  ];

  for (const [label, value] of cells) {
    const item = document.createElement('div');
    item.className = 'summary__item';
    const strong = document.createElement('strong');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    item.append(strong, span);
    box.appendChild(item);
  }
}

function claimPageCount() {
  return Math.max(1, Math.ceil(state.claims.length / CLAIMS_PAGE_SIZE));
}

function currentClaimPage() {
  const start = state.claimsPage * CLAIMS_PAGE_SIZE;
  return state.claims.slice(start, start + CLAIMS_PAGE_SIZE);
}

function renderClaims() {
  const table = $('claimsTable');
  table.textContent = '';

  // Ürünler en sonda: uzun metin diğer sütunları ekrandan itmesin.
  const headers = [
    '',
    'Sipariş No',
    'Adet',
    'Mevcut Desi',
    'Hesaplanan',
    'Fark',
    'Kargo Tutarı',
    '',
    'Ürünler',
  ];
  const head = document.createElement('tr');
  for (const label of headers) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);

  if (state.claims.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = headers.length;
    td.className = 'muted';
    td.textContent = 'İtiraz edilecek sipariş bulunamadı.';
    tr.appendChild(td);
    table.appendChild(tr);
  } else {
    const fragment = document.createDocumentFragment();
    for (const claim of currentClaimPage()) fragment.appendChild(claimRow(claim));
    table.appendChild(fragment);
  }

  paintClaimPager();
  paintClaimSelection();
}

function claimRow(claim) {
  const tr = document.createElement('tr');

  const pick = document.createElement('td');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = state.selectedClaims.has(claim.siparisNo);
  check.addEventListener('change', () => {
    if (check.checked) state.selectedClaims.add(claim.siparisNo);
    else state.selectedClaims.delete(claim.siparisNo);
    paintClaimSelection();
  });
  pick.appendChild(check);
  tr.appendChild(pick);

  tr.appendChild(cell(claim.siparisNo));
  tr.appendChild(cell(claim.toplamAdet));
  tr.appendChild(cell(claim.mevcutDesi));

  const entered = document.createElement('td');
  entered.textContent = String(claim.hesapDesi);
  if (claim.ikiyeYukseltildi) {
    // Ham hesap 1'di; mevcut desi 3'ün üstünde olduğu için 2 girilecek.
    const mark = document.createElement('span');
    mark.className = 'badge badge--warn';
    mark.textContent = '↑';
    mark.title = `Hesap ${claim.hesaplananDesi} desi çıktı, kural gereği 2 desi girilecek.`;
    entered.append(' ', mark);
  }
  tr.appendChild(entered);

  tr.appendChild(cell(`−${claim.mevcutDesi - claim.hesapDesi}`));

  const fee = document.createElement('td');
  if (claim.faturalanmamis) {
    fee.textContent = 'Faturalanmamış';
    fee.className = 'muted';
  } else {
    fee.textContent = String(claim.kargoTutari);
  }
  tr.appendChild(fee);

  const actions = document.createElement('td');
  actions.appendChild(
    button('Sil', () => {
      state.claims = state.claims.filter((c) => c.siparisNo !== claim.siparisNo);
      state.selectedClaims.delete(claim.siparisNo);
      // Son sayfadaki tek satır silinince boş sayfada kalınmasın.
      if (state.claimsPage >= claimPageCount()) state.claimsPage = claimPageCount() - 1;
      renderClaims();
    })
  );
  tr.appendChild(actions);

  // Ürünler en sonda: uzun metin desi/kargo sütunlarını ekrandan itmesin.
  const products = document.createElement('td');
  products.className = 'cell--products';
  products.textContent = summarizeItems(claim.items);
  // Ürün ürün tam döküm üzerine gelince görünür.
  products.title = claim.items
    .map((i) => `${i.category} ×${i.adet} (${(i.birimDesi * i.adet).toFixed(2)} desi) — ${i.urunAdi}`)
    .join('\n');
  if (claim.unknownCategory) {
    // Kategorisi bulunamayan ürün "Diğer" varsayılanıyla hesaplandı;
    // kullanıcı bu satırı gözle kontrol edebilsin.
    products.appendChild(document.createTextNode(' '));
    const mark = document.createElement('span');
    mark.className = 'badge badge--warn';
    mark.textContent = 'kategori?';
    mark.title = 'Bazı ürünlerin kategorisi bulunamadı, "Diğer" varsayılanı kullanıldı.';
    products.appendChild(mark);
  }
  tr.appendChild(products);

  return tr;
}

/**
 * Ürünleri kategori bazında toplar: "Atlet ×8" gibi.
 *
 * Aynı kategoriden farklı renk/beden ayrı satır olarak geliyor; ham liste
 * "Atlet ×2, Atlet ×1, Atlet ×1..." şeklinde okunuyor ve adetlerin toplanıp
 * toplanmadığı görünmüyordu. Hesaplama zaten toplam üzerinden yapılıyor,
 * burada yalnızca gösterim aynı mantığı yansıtıyor.
 */
function summarizeItems(items) {
  const byCategory = new Map();
  for (const item of items) {
    byCategory.set(item.category, (byCategory.get(item.category) || 0) + item.adet);
  }
  return [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, adet]) => `${category} ×${adet}`)
    .join(', ');
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = String(text);
  return td;
}

function paintClaimPager() {
  const pages = claimPageCount();
  $('pageInfo').textContent =
    `${state.claims.length.toLocaleString('tr-TR')} itiraz · sayfa ${state.claimsPage + 1}/${pages}`;
  $('btnPrevPage').disabled = state.claimsPage === 0;
  $('btnNextPage').disabled = state.claimsPage >= pages - 1;
  $('claimsPager').hidden = state.claims.length <= CLAIMS_PAGE_SIZE;
}

function paintClaimSelection() {
  const count = state.selectedClaims.size;
  $('claimSelectionInfo').textContent = count > 0 ? `${count} satır seçili` : '';
  $('btnDeleteSelected').disabled = count === 0;

  const page = currentClaimPage();
  $('claimSelectAll').checked =
    page.length > 0 && page.every((c) => state.selectedClaims.has(c.siparisNo));
}

$('btnPrevPage').addEventListener('click', () => {
  if (state.claimsPage > 0) state.claimsPage -= 1;
  renderClaims();
});

$('btnNextPage').addEventListener('click', () => {
  if (state.claimsPage < claimPageCount() - 1) state.claimsPage += 1;
  renderClaims();
});

$('claimSelectAll').addEventListener('change', (event) => {
  for (const claim of currentClaimPage()) {
    if (event.target.checked) state.selectedClaims.add(claim.siparisNo);
    else state.selectedClaims.delete(claim.siparisNo);
  }
  renderClaims();
});

$('btnDeleteSelected').addEventListener('click', () => {
  const count = state.selectedClaims.size;
  if (count === 0) return;
  if (!confirm(`${count} satır listeden silinecek. Devam edilsin mi?`)) return;

  state.claims = state.claims.filter((c) => !state.selectedClaims.has(c.siparisNo));
  state.selectedClaims = new Set();
  if (state.claimsPage >= claimPageCount()) state.claimsPage = claimPageCount() - 1;
  renderClaims();
});

$('btnExportClaims').addEventListener('click', async () => {
  if (state.claims.length === 0) {
    alert('Aktarılacak itiraz yok.');
    return;
  }
  try {
    const saved = await window.api.desi.exportClaims(state.claims);
    if (saved) desiBanner(`Excel'e aktarıldı: ${saved}`, 'ok');
  } catch (err) {
    desiBanner(`Aktarılamadı: ${err.message}`, 'warn');
  }
});

/**
 * "Mevcut desisi kaç ve üzeri olanlar aktarılsın?" sorusu.
 *
 * Listedeki dağılımı da gösterir ki kullanıcı eşiği körlemesine seçmesin.
 * İptal edilirse null döner.
 */
async function askDesiThreshold() {
  const dagilim = new Map();
  for (const claim of state.claims) {
    dagilim.set(claim.mevcutDesi, (dagilim.get(claim.mevcutDesi) || 0) + 1);
  }

  const desiler = [...dagilim.keys()].sort((a, b) => a - b);
  const enKucuk = desiler[0];

  // "3 ve üzeri: 753 itiraz" biçiminde kümülatif döküm.
  const satirlar = desiler.map((desi) => {
    const kumulatif = state.claims.filter((c) => c.mevcutDesi >= desi).length;
    return `${desi} ve üzeri: ${kumulatif.toLocaleString('tr-TR')} itiraz`;
  });

  const answer = await ask('Hangi siparişler kuyruğa aktarılsın?', {
    body:
      `Mevcut desisi girdiğiniz değer ve üzeri olan itirazlar aktarılır.\n\n${satirlar.join('\n')}`,
    value: String(enKucuk),
    okLabel: 'Kuyruğa Aktar',
  });
  if (answer === null) return null;

  const parsed = Number(String(answer).replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    alert('Geçerli bir desi değeri girin.');
    return null;
  }
  return parsed;
}

$('btnClaimsToQueue').addEventListener('click', async () => {
  if (state.claims.length === 0) {
    alert('Kuyruğa alınacak itiraz yok.');
    return;
  }

  const selected = await askDesiThreshold();
  if (selected === null) return;

  const secilenler = state.claims.filter((c) => c.mevcutDesi >= selected);
  if (secilenler.length === 0) {
    alert(`Mevcut desisi ${selected} ve üzeri olan itiraz yok.`);
    return;
  }

  // Kuyruk tablosu state.variables üzerinden çizilir; desi akışı Excel
  // eşleme ekranından geçmediği için burada sistem değişkenlerine ayarlanır.
  state.variables = FALLBACK_VARIABLES;

  state.queue = secilenler.map((claim, index) => ({
    rowNumber: index + 1,
    values: {
      siparisNo: claim.siparisNo,
      dogruDesi: String(claim.hesapDesi),
      itirazSebebi: '',
      aciklama: '',
    },
    recordingName: '',
    recordingId: null,
    status: 'Bekliyor',
    detail: '',
  }));

  renderQueue();
  updateSummary();

  const atlanan = state.claims.length - secilenler.length;
  desiBanner(
    `Mevcut desisi ${selected} ve üzeri ${secilenler.length.toLocaleString('tr-TR')} itiraz ` +
      `kuyruğa aktarıldı` +
      (atlanan > 0 ? ` (${atlanan.toLocaleString('tr-TR')} itiraz eşiğin altında kaldı).` : '.'),
    'ok'
  );
  switchTab('run');
});

// ---------------- Desi Bilgileri ----------------

$('btnDesiInfo').addEventListener('click', async () => {
  const settings = await window.api.desi.getSettings();
  fillDesiForm(settings);
  $('desiBack').hidden = false;
});

function fillDesiForm(settings) {
  $('priceThreshold').value = String(settings.priceThreshold);
  $('priceThresholdNew').value = String(settings.priceThresholdNew);
  $('priceChangeDate').value = String(settings.priceChangeDate);
  $('returnPriceThreshold').value = String(settings.returnPriceThreshold);
  $('includeReturned').checked = settings.includeReturned === true;

  const table = $('desiTable');
  table.textContent = '';

  const head = document.createElement('tr');
  for (const label of ['Kategori', 'Ortalama Desi']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);

  for (const [name, value] of Object.entries(settings.categoryDesi)) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(name));

    const td = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = String(value);
    input.dataset.category = name;
    td.appendChild(input);
    tr.appendChild(td);

    table.appendChild(tr);
  }
}

function readDesiForm() {
  const categoryDesi = {};
  $('desiTable')
    .querySelectorAll('input[data-category]')
    .forEach((input) => {
      categoryDesi[input.dataset.category] = input.value;
    });

  return {
    categoryDesi,
    priceThreshold: $('priceThreshold').value,
    priceThresholdNew: $('priceThresholdNew').value,
    priceChangeDate: $('priceChangeDate').value,
    returnPriceThreshold: $('returnPriceThreshold').value,
    includeReturned: $('includeReturned').checked,
  };
}

$('desiSave').addEventListener('click', async () => {
  await window.api.desi.saveSettings(readDesiForm());
  $('desiBack').hidden = true;
  desiBanner(
    state.claims.length > 0
      ? 'Desi bilgileri kaydedildi. Yeni değerlerin geçerli olması için "İtirazları Hesapla"ya tekrar basın.'
      : 'Desi bilgileri kaydedildi.',
    'ok'
  );
});

$('desiCancel').addEventListener('click', () => {
  $('desiBack').hidden = true;
});

$('desiReset').addEventListener('click', async () => {
  if (!confirm('Tüm desi bilgileri ve kurallar varsayılana dönecek. Devam edilsin mi?')) return;
  const settings = await window.api.desi.resetSettings();
  fillDesiForm(settings);
});

// ---------------- Excel ----------------

$('btnPickExcel').addEventListener('click', async () => {
  try {
    const result = await window.api.excel.pick();
    if (!result) return;
    state.excel = result;
    $('excelFile').textContent = `${result.filePath} · ${result.rowCount} satır`;
    $('mappingBox').hidden = false;
    renderMapping();
    renderPreview();
  } catch (err) {
    alert(`Excel okunamadı: ${err.message}`);
  }
});

/** Eşleme hedefleri: seçili Kaydın değişkenleri, yoksa sistem değişkenleri. */
function mappingVariables() {
  const rec = state.recordings.find((r) => r.recordingId === state.selectedId);
  const vars = rec?.variables?.length ? rec.variables : FALLBACK_VARIABLES;
  return vars.map((v) => ({ key: v.key, label: v.label, required: v.required !== false }));
}

function renderMapping() {
  const box = $('mappingFields');
  box.textContent = '';
  state.variables = mappingVariables();

  const targets = [
    ...state.variables,
    { key: 'recordingName', label: 'Kayıt Adı', required: false },
  ];

  for (const target of targets) {
    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = target.label + (target.required ? ' *' : ' (opsiyonel)');
    label.appendChild(text);

    const select = document.createElement('select');
    select.dataset.key = target.key;

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— yok —';
    select.appendChild(none);

    state.excel.headers.forEach((header, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = header || `(kolon ${index + 1})`;
      if (state.excel.mapping[target.key] === index) option.selected = true;
      select.appendChild(option);
    });

    label.appendChild(select);
    box.appendChild(label);
  }
}

function currentMapping() {
  const mapping = {};
  $('mappingFields')
    .querySelectorAll('select')
    .forEach((select) => {
      if (select.value !== '') mapping[select.dataset.key] = Number(select.value);
    });
  return mapping;
}

function renderPreview() {
  const table = $('previewTable');
  table.textContent = '';

  const head = document.createElement('tr');
  for (const header of state.excel.headers) {
    const th = document.createElement('th');
    th.textContent = header;
    head.appendChild(th);
  }
  table.appendChild(head);

  for (const row of state.excel.preview) {
    const tr = document.createElement('tr');
    state.excel.headers.forEach((_h, index) => {
      const td = document.createElement('td');
      td.textContent = String(row[index] ?? '');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  }
}

$('btnBuildQueue').addEventListener('click', async () => {
  const mapping = currentMapping();

  const missing = state.variables
    .filter((v) => v.required && mapping[v.key] === undefined)
    .map((v) => v.label);
  if (missing.length > 0) {
    alert(`Şu zorunlu değişkenler bir kolona eşlenmedi:\n\n${missing.join('\n')}`);
    return;
  }

  const { entries, warnings } = await window.api.excel.buildQueue(
    state.excel.filePath,
    mapping,
    state.variables
  );

  state.queue = entries;
  $('queueInfo').textContent = `${entries.length} satır kuyruğa alındı.`;

  const box = $('warnings');
  box.hidden = warnings.length === 0;
  box.textContent = warnings.join('\n');

  renderQueue();
  updateSummary();
});

// ---------------- Kuyruk tablosu ----------------

function statusClass(status) {
  if (status === 'Başarılı') return 'st--ok';
  if (status === 'Başarısız') return 'st--fail';
  if (status === 'Eşleşme bulunamadı' || status === 'Eksik veri') return 'st--warn';
  return 'st--skip';
}

function renderQueue(currentIndex = -1) {
  const table = $('queueTable');
  table.textContent = '';

  if (state.queue.length === 0) {
    const empty = document.createElement('tr');
    const td = document.createElement('td');
    td.className = 'muted';
    td.textContent =
      'Kuyruk boş. Excel sekmesinden itirazları hesaplayıp "Kuyruğa Aktar" ile buraya gönderin.';
    empty.appendChild(td);
    table.appendChild(empty);
    return;
  }

  const headers = ['#', ...state.variables.map((v) => v.label), 'Kayıt', 'Durum', 'Detay', ''];
  const head = document.createElement('tr');
  for (const header of headers) {
    const th = document.createElement('th');
    th.textContent = header;
    head.appendChild(th);
  }
  table.appendChild(head);

  // Binlerce satırı tek tek eklemek her seferinde yeniden yerleşim tetikler;
  // fragment'ta toplayıp bir kerede eklemek bunu tek işleme indirir.
  const fragment = document.createDocumentFragment();

  state.queue.forEach((entry, index) => {
    const tr = document.createElement('tr');
    if (index === currentIndex) tr.className = 'is-current';

    const cells = [
      String(entry.rowNumber),
      ...state.variables.map((v) => entry.values[v.key] ?? ''),
      entry.recordingName || '',
    ];
    for (const value of cells) {
      const td = document.createElement('td');
      td.textContent = value;
      tr.appendChild(td);
    }

    const status = document.createElement('td');
    status.className = `st ${statusClass(entry.status)}`;
    status.textContent = entry.status;
    tr.appendChild(status);

    const detail = document.createElement('td');
    detail.textContent = entry.detail || '';
    tr.appendChild(detail);

    // Satır silme — çalışma sürerken kuyruk değiştirilemez.
    const remove = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = 'Sil';
    btn.title = 'Bu satırı kuyruktan çıkar';
    btn.disabled = state.running;
    btn.addEventListener('click', () => removeQueueRow(index));
    remove.appendChild(btn);
    tr.appendChild(remove);

    fragment.appendChild(tr);
  });

  table.appendChild(fragment);
}

/** Tek bir satırı kuyruktan çıkarır. */
function removeQueueRow(index) {
  if (state.running) return;
  const entry = state.queue[index];
  state.queue.splice(index, 1);
  renderQueue();
  updateSummary();
  log(`Satır ${entry.rowNumber} kuyruktan çıkarıldı.`, 'skip');
}

/** Kuyruğu tamamen boşaltır. */
function clearQueue() {
  if (state.running) return;
  if (state.queue.length === 0) return;
  if (!confirm(`Kuyruktaki ${state.queue.length} satır silinsin mi?`)) return;

  state.queue = [];
  renderQueue();
  $('runSummary').textContent = '';
  $('queueInfo').textContent = '';
  log('Kuyruk temizlendi.', 'skip');
}

/** Özet satırını kuyruğun güncel durumuna göre yeniler. */
function updateSummary() {
  if (state.queue.length === 0) {
    $('runSummary').textContent = '';
    return;
  }
  const counts = {};
  for (const entry of state.queue) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([status, count]) => `${status}: ${count}`);
  $('runSummary').textContent = `Toplam ${state.queue.length} — ${parts.join(' · ')}`;
}

// ---------------- Çalıştırma ----------------

$('btnRun').addEventListener('click', async () => {
  if (state.queue.length === 0) {
    alert('Önce Excel sekmesinden kuyruğu oluşturun.');
    return;
  }
  const status = await window.api.bridge.status();
  if (!status.connected) {
    alert('Chrome eklentisi bağlı değil. Chrome açık ve eklenti kurulu olmalı.');
    return;
  }

  const setupId = $('setupSelect').value || null;
  const forcedItirazId = $('itirazSelect').value || null;

  // Belirli bir itiraz kaydı seçildiyse tüm satırlar onu kullanır; boşsa
  // her satır Excel'deki İtiraz Sebebi'ne göre eşleşir.
  for (const entry of state.queue) {
    entry.recordingId = forcedItirazId;
  }

  state.running = true;
  updateRunButtons();
  log(setupId ? 'Çalıştırma başladı (hazırlık kaydıyla).' : 'Çalıştırma başladı.');

  try {
    await window.api.player.run(
      state.queue,
      state.panel,
      setupId,
      $('stopOnError').checked
    );
  } catch (err) {
    log(`Çalıştırma hatası: ${err.message}`, 'fail');
  } finally {
    state.running = false;
    state.paused = false;
    updateRunButtons();
  }
});

$('btnPause').addEventListener('click', async () => {
  if (state.paused) {
    await window.api.player.resume();
    state.paused = false;
  } else {
    await window.api.player.pause();
    state.paused = true;
  }
  updateRunButtons();
});

$('btnStop').addEventListener('click', () => window.api.player.stop());

$('btnClearQueue').addEventListener('click', clearQueue);

$('btnExport').addEventListener('click', async () => {
  if (state.queue.length === 0) {
    alert('Aktarılacak sonuç yok.');
    return;
  }
  const saved = await window.api.excel.exportResults(state.queue, state.variables);
  if (saved) log(`Sonuçlar kaydedildi: ${saved}`, 'ok');
});

function updateRunButtons() {
  $('btnRun').disabled = state.running;
  $('btnPause').disabled = !state.running;
  $('btnStop').disabled = !state.running;
  $('btnPause').textContent = state.paused ? 'Devam Et' : 'Duraklat';
  // Çalışma sürerken kuyruk değiştirilemez; Player indekslere göre ilerliyor.
  $('btnClearQueue').disabled = state.running;
}

window.api.player.onRowStarted(({ entry, index }) => {
  state.queue[index] = entry;
  renderQueue(index);
  log(`Satır ${entry.rowNumber} · ${entry.values.siparisNo} başladı.`);
});

window.api.player.onRowFinished(({ entry, index }) => {
  state.queue[index] = entry;
  renderQueue();
  const kind =
    entry.status === 'Başarılı' ? 'ok' : entry.status === 'Başarısız' ? 'fail' : 'skip';
  log(`Satır ${entry.rowNumber} · ${entry.status}${entry.detail ? ' — ' + entry.detail : ''}`, kind);
});

window.api.player.onSetupStarted(({ name, count }) =>
  log(`Hazırlık kaydı çalışıyor: ${name} (${count} adım)…`)
);
window.api.player.onSetupFinished(({ name }) =>
  log(`Hazırlık tamamlandı: ${name}. Siparişlere geçiliyor.`, 'ok')
);
window.api.player.onSetupFailed(({ detail }) =>
  log(`Hazırlık başarısız: ${detail}`, 'fail')
);

window.api.player.onStepSkipped(({ stepId }) =>
  log(`  Adım ${stepId}: Atlandı (opsiyonel adım bulunamadı)`, 'skip')
);

window.api.player.onState(({ state: playerState }) => log(`Durum: ${playerState}`));

window.api.player.onRunFinished(({ summary }) => {
  const parts = Object.entries(summary.counts).map(([status, count]) => `${status}: ${count}`);
  $('runSummary').textContent = `Toplam ${summary.total} — ${parts.join(' · ')}`;
  log(`Çalıştırma bitti. ${parts.join(' · ')}`, 'ok');

  // Silme düğmeleri state.running'e bakıyor; tabloyu ondan SONRA çiz.
  state.running = false;
  state.paused = false;
  updateRunButtons();
  renderQueue();
});

// ---------------- Günlük ----------------

function log(message, kind) {
  const box = $('log');
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('tr-TR');
  line.textContent = `[${time}] ${message}`;
  if (kind) line.className = `l--${kind}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ---------------- Başlangıç ----------------

$('panelSelect').addEventListener('change', (event) => {
  state.panel = event.target.value;
});

/**
 * Açılışta ana süreçteki gerçek kayıt durumunu al. Uygulama yeniden
 * yüklendiğinde arayüz "kayıt yok" sanıp butonları yanlış gösterebilir.
 */
async function syncRecorderState() {
  try {
    state.recordingActive = await window.api.recorder.isActive();
  } catch {
    state.recordingActive = false;
  }
  toggleRecordingButtons();
}

refreshLibrary();
syncRecorderState();
