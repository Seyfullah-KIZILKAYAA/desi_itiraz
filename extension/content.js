/**
 * Content script — sayfanın içinde çalışır.
 *
 * İki iş yapar:
 *   Kayıt modu:   gerçek kullanıcı etkileşimlerini yakalar, aday seçicilerle
 *                 birlikte arka plana bildirir.
 *   Oynatma modu: gelen adımı DOM üzerinde uygular, elemanı vurgular.
 *
 * Koordinat kullanılmaz. Sabit sleep yoktur; beklemeler DOM koşuluna bağlıdır.
 */

(() => {
  if (window.__desiContentReady) return;
  window.__desiContentReady = true;

  let recording = false;

  const S = () => window.__desiSelectors;

  // ---------------- Kayıt modu ----------------

  /** Tıklanan elemanı, gerçek hedefe en yakın anlamlı ataya yükseltir. */
  function meaningfulTarget(el) {
    const clickable = el.closest?.('button, a, [role="button"], input, select, textarea, label');
    return clickable ?? el;
  }

  function report(event) {
    chrome.runtime.sendMessage({ kind: 'recordedEvent', payload: event }).catch(() => {});
  }

  function onClick(event) {
    if (!recording) return;
    const el = meaningfulTarget(event.target);
    if (!el || el.nodeType !== 1) return;

    // Yazma alanlarına tıklama ayrı bir adım değil; asıl adım input olayı.
    if (/^(input|textarea|select)$/i.test(el.tagName)) return;

    report({
      action: 'click',
      selector: { strategies: S().buildStrategies(el) },
      timestamp: Date.now(),
      url: location.href,
    });
  }

  function onInput(event) {
    if (!recording) return;
    const el = event.target;
    if (!el || !/^(input|textarea)$/i.test(el.tagName)) return;
    if (/^(password)$/i.test(el.type)) return; // parola asla kaydedilmez

    report({
      action: 'type',
      selector: { strategies: S().buildStrategies(el) },
      value: el.value,
      timestamp: Date.now(),
      url: location.href,
    });
  }

  function onChange(event) {
    if (!recording) return;
    const el = event.target;
    if (!el) return;

    if (/^select$/i.test(el.tagName)) {
      const option = el.options[el.selectedIndex];
      report({
        action: 'selectOption',
        selector: { strategies: S().buildStrategies(el) },
        value: option ? option.text.trim() : el.value,
        timestamp: Date.now(),
        url: location.href,
      });
    }
  }

  // capture:true — sayfa kendi handler'ında olayı durdursa bile yakalarız.
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);

  // ---------------- Vurgulama ----------------

  /** Etkileşimden önce elemanı görsel olarak işaretler (spec §7.3.e). */
  function highlight(el) {
    if (!el) return;
    const previous = el.style.outline;
    const previousOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #f27a1a';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => {
      el.style.outline = previous;
      el.style.outlineOffset = previousOffset;
    }, 900);
  }

  // ---------------- Oynatma modu ----------------

  /** Framework'lerin (React vb.) fark etmesi için native setter kullanılır. */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Menü/dropdown bileşenleri çoğu zaman pointer ve mouse olaylarını dinler;
   * tek başına element.click() bunları açmaya yetmez. Gerçek bir tıklamanın
   * ürettiği olay dizisini taklit ederiz.
   *
   * Koordinat KULLANILMAZ: olaylar elemana doğrudan gönderilir, ekran
   * konumuna göre değil.
   */
  function dispatchPointerSequence(el) {
    const bubbling = { bubbles: true, cancelable: true, composed: true };
    // enter/leave olayları TANIM GEREĞİ bubble olmaz; her ataya ayrı gönderilir.
    const nonBubbling = { bubbles: false, cancelable: false, composed: true };

    const fire = (target, type, Ctor, options) => {
      try {
        target.dispatchEvent(new Ctor(type, options));
      } catch {
        /* tarayıcı bu olay tipini desteklemiyorsa atla */
      }
    };

    // Hover ile açılan menüler enter olayını kökten hedefe doğru bekler.
    // el.closest zinciri: en dıştaki ata önce.
    const chain = [];
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      chain.unshift(node);
    }
    for (const node of chain) {
      fire(node, 'pointerenter', PointerEvent, nonBubbling);
      fire(node, 'mouseenter', MouseEvent, nonBubbling);
    }

    // Bubble olan olaylar yalnızca hedefe gönderilir; ataya kendiliğinden çıkar.
    fire(el, 'pointerover', PointerEvent, bubbling);
    fire(el, 'mouseover', MouseEvent, bubbling);
    fire(el, 'pointermove', PointerEvent, bubbling);
    fire(el, 'mousemove', MouseEvent, bubbling);
    fire(el, 'pointerdown', PointerEvent, bubbling);
    fire(el, 'mousedown', MouseEvent, bubbling);
    fire(el, 'pointerup', PointerEvent, bubbling);
    fire(el, 'mouseup', MouseEvent, bubbling);
  }

  /**
   * Gizli bir hedefi açığa çıkarmayı dener.
   *
   * Menüler genellikle görünür bir başlığa hover/tıklama ile açılır. Hedef
   * gizliyse, ata zincirinde YUKARI çıkıp ilk görünür ataya hover göndeririz —
   * bu çoğu açılır menüyü açar.
   *
   * Koordinat kullanılmaz; olaylar elemanlara doğrudan gönderilir.
   */
  function revealByHoveringAncestors(hiddenEl) {
    const S_ = S();
    let node = hiddenEl.parentElement;
    let tried = 0;

    while (node && node !== document.body && tried < 6) {
      if (S_.isVisible(node)) {
        dispatchPointerSequence(node);
        // Bazı menüler yalnızca tıklamayla açılır.
        try {
          node.click();
        } catch {
          /* tıklanabilir değilse yoksay */
        }
        tried++;
      }
      node = node.parentElement;
    }
  }

  /**
   * DOM değişiklikleri durana kadar bekler (menü açılması, içerik yüklenmesi).
   * Sabit sleep değil: MutationObserver ile sessizlik ölçülür, hiçbir şey
   * değişmiyorsa hemen döner.
   */
  function waitForDomSettle({ quietMs = 350, maxMs = 3000 } = {}) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let observer = null;

      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(hardStop);
        observer?.disconnect();
        resolve();
      };

      const restartQuietTimer = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      const hardStop = setTimeout(finish, maxMs);

      try {
        observer = new MutationObserver(restartQuietTimer);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'aria-hidden'],
        });
      } catch {
        return finish();
      }

      restartQuietTimer();
    });
  }

  /**
   * İki adresin aynı sayfayı gösterip göstermediği.
   * Sondaki "/" ve sorgu parametreleri yok sayılır: panel çoğu zaman
   * adrese kendi parametrelerini ekler, bu gerçek bir fark değildir.
   */
  function isSameLocation(current, target) {
    try {
      const a = new URL(current);
      const b = new URL(target, current);
      const norm = (p) => p.replace(/\/+$/, '').toLowerCase();
      return a.host === b.host && norm(a.pathname) === norm(b.pathname);
    } catch {
      return current === target;
    }
  }

  /** Seçici teşhislerini okunabilir tek satıra çevirir. */
  function describeFailure(diagnostics) {
    if (!diagnostics || diagnostics.length === 0) return 'Element bulunamadı';
    return `Element bulunamadı — ${diagnostics.join(' | ')}`;
  }

  async function executeStep(step) {
    const perStrategyMs = step.perStrategyMs ?? 2500;
    const timeoutMs = step.timeoutMs ?? 15000;

    try {
      switch (step.action) {
        case 'navigate': {
          if (!step.url) return { status: 'failed', detail: 'URL yok' };

          // Zaten hedefteysek tekrar yüklemeye gerek yok. Karşılaştırma
          // gevşek: sondaki "/" ve sorgu parametreleri fark yaratmasın,
          // yoksa doğru sayfadayken gereksiz yenileme yapılır.
          if (!isSameLocation(location.href, step.url)) {
            location.assign(step.url);
          }
          return { status: 'ok' };
        }

        case 'waitForElement': {
          const { element, diagnostics } = await S().resolveSelector(step.selector, {
            perStrategyMs: Math.min(perStrategyMs, timeoutMs),
          });
          if (!element) return { status: 'failed', detail: describeFailure(diagnostics) };
          highlight(element);
          return { status: 'ok' };
        }

        case 'click': {
          let { element, diagnostics } = await S().resolveSelector(step.selector, {
            perStrategyMs,
          });

          // Eleman DOM'da ama gizliyse, açması gereken menü kapalıdır.
          // Görünür ataya (menü başlığı) hover göndererek açmayı dene.
          if (!element) {
            const hidden = await S().resolveSelector(step.selector, {
              perStrategyMs: 400,
              requireVisible: false,
            });
            if (hidden.element) {
              revealByHoveringAncestors(hidden.element);
              await waitForDomSettle({ quietMs: 250, maxMs: 1500 });
              ({ element, diagnostics } = await S().resolveSelector(step.selector, {
                perStrategyMs,
              }));
            }
          }

          if (!element) return { status: 'failed', detail: describeFailure(diagnostics) };
          if (element.disabled) return { status: 'failed', detail: 'Element pasif' };
          highlight(element);
          // Vurgunun görülebilmesi için kısa bir gecikme — bekleme stratejisi
          // değil, yalnızca kullanıcı görsün diye.
          await new Promise((r) => setTimeout(r, 250));

          // Menüler sıklıkla hover/pointer olaylarıyla açılır; yalnızca
          // .click() göndermek bazı bileşenlerde menüyü açmaz.
          dispatchPointerSequence(element);
          element.click();

          // Tıklamanın DOM'a etkisi (menü açılması, panel yüklenmesi)
          // oturana kadar bekle — sonraki adım erken davranıp elemanı
          // kaçırmasın. Sabit süre değil; DOM sessizleşince biter.
          await waitForDomSettle();
          return { status: 'ok' };
        }

        case 'type': {
          const { element, diagnostics } = await S().resolveSelector(step.selector, { perStrategyMs });
          if (!element) return { status: 'failed', detail: describeFailure(diagnostics) };
          highlight(element);
          element.focus();
          setNativeValue(element, step.value ?? '');
          return { status: 'ok' };
        }

        case 'selectOption': {
          const { element, diagnostics } = await S().resolveSelector(step.selector, { perStrategyMs });
          if (!element) return { status: 'failed', detail: describeFailure(diagnostics) };
          highlight(element);

          const wanted = String(step.value ?? '').trim();
          const options = [...(element.options ?? [])];
          const match =
            options.find((o) => o.text.trim() === wanted) ??
            options.find((o) => o.value === wanted) ??
            options.find((o) => o.text.trim().includes(wanted));

          if (!match) {
            return { status: 'failed', detail: `Seçenek bulunamadı: ${wanted}` };
          }
          element.value = match.value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return { status: 'ok' };
        }

        default:
          return { status: 'failed', detail: `Bilinmeyen eylem: ${step.action}` };
      }
    } catch (err) {
      return { status: 'failed', detail: err.message };
    }
  }

  // ---------------- Arka planla iletişim ----------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.kind) {
      case 'setRecording':
        recording = !!message.value;
        sendResponse({ ok: true, recording });
        return false;

      case 'executeStep':
        executeStep(message.step).then(sendResponse);
        return true; // async yanıt

      case 'ping':
        sendResponse({ ok: true, url: location.href });
        return false;

      default:
        return false;
    }
  });

  // Sayfa yenilendiğinde arka plan kayıt modunu geri yükleyebilsin diye haber ver.
  chrome.runtime.sendMessage({ kind: 'contentReady', payload: { url: location.href } }).catch(() => {});
})();
