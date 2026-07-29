/**
 * {{degisken}} yer tutucularının çözümlenmesi.
 *
 * Kayıt adımlarındaki her metin alanı ({{siparisNo}} gibi) çalışma anında
 * o satırın değerleriyle değiştirilir. Panel'e özgü hiçbir şey bilinmez —
 * değişken adları Kayıt verisinden gelir.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Faz 1'de her Kayıtta bulunan sistem değişkenleri.
 * Kolon sözleşmesi: templates/desi_itiraz_sablonu.xlsx > "Açıklama" sayfası.
 *
 * Yalnızca siparisNo ve dogruDesi zorunludur — itiraz için gereken asgari veri.
 *
 * itirazSebebi opsiyoneldir: tek bir itiraz kaydıyla çalışırken sebep zaten
 * kaydın içinde sabittir, Excel'de tekrar yazmaya gerek yoktur. Yalnızca
 * birden fazla itiraz kaydı arasında otomatik eşleştirme yapılacaksa doldurulur.
 *
 * aciklama opsiyoneldir: form bazı itirazlarda açıklama istiyor, bazılarında
 * istemiyor. Boş hücre satırı hataya düşürmemeli.
 */
const SYSTEM_VARIABLES = [
  { key: 'siparisNo', label: 'Sipariş No', required: true, system: true },
  { key: 'dogruDesi', label: 'Doğru Desi', required: true, system: true },
  { key: 'itirazSebebi', label: 'İtiraz Sebebi', required: false, system: true },
  { key: 'aciklama', label: 'Açıklama', required: false, system: true },
];

/** Bir metindeki tüm değişken adlarını döndürür. */
function extractVariables(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const match of text.matchAll(PLACEHOLDER_RE)) found.add(match[1]);
  return [...found];
}

/**
 * Bir nesnenin (adım, adım dizisi, seçici) içindeki tüm metinlerde geçen
 * değişken adlarını toplar.
 */
function collectVariables(node, acc = new Set()) {
  if (typeof node === 'string') {
    for (const name of extractVariables(node)) acc.add(name);
  } else if (Array.isArray(node)) {
    for (const item of node) collectVariables(item, acc);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectVariables(value, acc);
  }
  return acc;
}

/**
 * Bir metindeki yer tutucuları values ile değiştirir.
 * Karşılığı olmayan yer tutucu hata fırlatır — sessizce boş string bırakmak,
 * yanlış siparişe itiraz göndermek gibi sonuçlar doğurabilir.
 */
function substituteText(text, values) {
  if (typeof text !== 'string') return text;
  return text.replace(PLACEHOLDER_RE, (_full, name) => {
    if (!(name in values) || values[name] === null || values[name] === undefined) {
      throw new Error(`Değişkenin karşılığı yok: {{${name}}}`);
    }
    return String(values[name]);
  });
}

/** substituteText'i bir nesne ağacının tamamına derinlemesine uygular. */
function substituteDeep(node, values) {
  if (typeof node === 'string') return substituteText(node, values);
  if (Array.isArray(node)) return node.map((item) => substituteDeep(item, values));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = substituteDeep(value, values);
    }
    return out;
  }
  return node;
}

/**
 * Kayıtta {{siparisNo}}'ya bağlanmamış, sabit yazılmış sipariş numarası arar.
 *
 * Kayıt alınırken forma yazılan numara bir değişkene bağlanmazsa kaydın içine
 * sabitlenir ve çalıştırmada HER satır aynı siparişe itiraz gönderir. Belirti
 * sinsidir: desi satırdan satıra doğru değişir, sipariş no sabit kalır.
 *
 * @returns {string|null} sabit yazılmış numara, yoksa null
 */
function findHardcodedOrderNo(steps) {
  if (collectVariables(steps ?? []).has('siparisNo')) return null;

  for (const step of steps ?? []) {
    const value = String(step?.value ?? step?.text ?? '').trim();
    // Sipariş numarası uzun bir rakam dizisidir.
    if (/^\d{8,}$/.test(value)) return value;
  }
  return null;
}

module.exports = {
  PLACEHOLDER_RE,
  SYSTEM_VARIABLES,
  findHardcodedOrderNo,
  extractVariables,
  collectVariables,
  substituteText,
  substituteDeep,
};
