/**
 * Seçici üretimi ve çözümlemesi — spec §4.4
 *
 * Bu dosya content script'e enjekte edilir. Panel'e özgü HİÇBİR bilgi
 * içermez; yalnızca genel DOM sezgileri kullanır.
 *
 * Koordinat KULLANILMAZ — hiçbir yerde x/y yoktur.
 */

(() => {
  const TEST_ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test'];

  /**
   * Otomatik üretilmiş görünen id'leri eler: React'in :r3: biçimi, uzun
   * hash'ler, salt sayı, ve içinde uzun rakam öbeği geçenler.
   */
  function isStableId(id) {
    if (!id || typeof id !== 'string') return false;
    if (id.length > 40) return false;
    if (/^[0-9]+$/.test(id)) return false;             // salt sayı
    if (/[0-9a-f]{8,}/i.test(id)) return false;        // hash benzeri
    // React useId: ":r3:" tek başına ya da "tabs::r87::trigger-ALL" gibi
    // gömülü olabilir. İkisini de reddet.
    if (/:r[0-9a-z]+:/i.test(id)) return false;
    if (/^(mui|radix|headless|ember|ext)-?/i.test(id) && /\d{3,}/.test(id)) return false;
    return true;
  }

  /** Elemanın kullanıcıya görünen, kırpılmış metni. */
  function visibleText(el) {
    if (!el) return '';
    const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text;
  }

  /** CSS.escape yoksa asgari kaçış. */
  function esc(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/["\\\]\[\(\)#\.:]/g, '\\$&');
  }

  /** Son çare: kök'e kadar nth-child zinciri. */
  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(
        siblings.length > 1
          ? `${node.tagName.toLowerCase()}:nth-of-type(${index})`
          : node.tagName.toLowerCase()
      );
      node = parent;
      if (parts.length > 6) break; // aşırı uzun zincirler zaten kırılgan
    }
    return parts.join(' > ');
  }

  /**
   * Bir eleman için öncelik sırasına göre aday stratejiler üretir.
   * Dönen dizi, playback'te bu sırayla denenir.
   */
  function buildStrategies(el) {
    const strategies = [];
    if (!el || el.nodeType !== 1) return strategies;

    // 1. Kararlı özel attribute
    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) strategies.push({ type: 'testAttr', attr, value });
    }

    // 2. id (otomatik üretilmiş değilse)
    if (isStableId(el.id)) {
      strategies.push({ type: 'id', value: el.id });
    }

    // 3. name (form alanları)
    const name = el.getAttribute('name');
    if (name) strategies.push({ type: 'name', value: name });

    // 4. Görünen metin — buton/link için en dayanıklısı
    const text = visibleText(el);
    if (text && text.length <= 80 && /button|a|label|span|div|li/i.test(el.tagName)) {
      strategies.push({ type: 'text', value: text, tag: el.tagName.toLowerCase() });
    }

    // 5. aria-label
    const aria = el.getAttribute('aria-label');
    if (aria) strategies.push({ type: 'ariaLabel', value: aria });

    // 6. Son çare — kırılgan olarak işaretlenir
    const path = cssPath(el);
    if (path) strategies.push({ type: 'cssPath', value: path });

    return strategies;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Tek bir stratejiyi çözer; bulamazsa null. */
  function resolveStrategy(strategy) {
    try {
      switch (strategy.type) {
        case 'testAttr':
          return document.querySelector(`[${strategy.attr}="${esc(strategy.value)}"]`);

        case 'id':
          return document.getElementById(strategy.value);

        case 'name':
          return document.querySelector(`[name="${esc(strategy.value)}"]`);

        case 'ariaLabel':
          return document.querySelector(`[aria-label="${esc(strategy.value)}"]`);

        case 'text':
          return findByText(strategy.value, strategy.tag);

        case 'cssPath':
          return document.querySelector(strategy.value);

        default:
          return null;
      }
    } catch {
      return null; // geçersiz seçici tüm adımı çökertmesin
    }
  }

  /**
   * Metne göre arama: önce birebir, sonra "içeren".
   * En derindeki (en küçük) eşleşme tercih edilir ki kapsayıcı div yerine
   * asıl butonu bulalım.
   */
  function findByText(text, tag) {
    const target = String(text).replace(/\s+/g, ' ').trim();
    if (!target) return null;

    // Kayıtta etiket saklanmış olsa da yalnızca ona güvenmeyiz: sayfa
    // güncellenince aynı metin farklı bir etikete taşınmış olabilir.
    const scope = new Set([
      ...(tag ? document.querySelectorAll(tag) : []),
      ...document.querySelectorAll('button, a, label, span, div, li, td, th, [role="button"], [role="menuitem"], [role="tab"]'),
    ]);

    const exactVisible = [];
    const exactHidden = [];
    const partialVisible = [];

    for (const el of scope) {
      const own = visibleText(el);
      if (!own) continue;

      if (own === target) {
        (isVisible(el) ? exactVisible : exactHidden).push(el);
      } else if (own.includes(target) && isVisible(el)) {
        partialVisible.push(el);
      }
    }

    // En derindeki (en kısa metinli) eşleşme tercih edilir ki kapsayıcı div
    // yerine asıl butonu bulalım.
    const pick = (list) =>
      list.sort((a, b) => visibleText(a).length - visibleText(b).length)[0] ?? null;

    // Görünür birebir > görünür kısmi > gizli birebir.
    // Gizli olan en sonda: menü henüz açılmamışsa bile eleman döner ve
    // resolveSelector "DOM'da var ama görünmüyor" teşhisi koyabilir.
    return pick(exactVisible) ?? pick(partialVisible) ?? pick(exactHidden);
  }

  /**
   * Stratejileri sırayla dener; her biri için kısa bir alt-timeout boyunca
   * bekler. Sabit sleep değil — 100ms aralıkla DOM koşulu yoklanır.
   */
  async function resolveSelector(selector, { perStrategyMs = 2500, requireVisible = true } = {}) {
    const strategies = selector?.strategies ?? [];
    // Hangi stratejinin neden düştüğünü raporla; "Element bulunamadı" tek
    // başına hata ayıklamak için yetersiz.
    const diagnostics = [];

    for (const strategy of strategies) {
      const deadline = Date.now() + perStrategyMs;
      let foundButHidden = false;

      while (Date.now() < deadline) {
        const el = resolveStrategy(strategy);
        if (el) {
          if (!requireVisible || isVisible(el)) return { element: el, strategy, diagnostics };
          foundButHidden = true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const label = `${strategy.type}${strategy.attr ? `[${strategy.attr}]` : ''}="${strategy.value}"`;
      diagnostics.push(
        foundButHidden
          ? `${label}: DOM'da var ama görünmüyor (menü kapalı olabilir)`
          : `${label}: bulunamadı`
      );
    }

    return { element: null, strategy: null, diagnostics };
  }

  window.__desiSelectors = {
    buildStrategies,
    resolveSelector,
    resolveStrategy,
    isVisible,
    visibleText,
    findByText,
    isStableId,
  };
})();
