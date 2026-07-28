/**
 * Tanı aracı — Chrome konsoluna yapıştırılarak çalıştırılır.
 *
 * Kayıtta saklanan bir metni sayfada arar ve neden bulunamadığını söyler.
 * Otomasyonun parçası DEĞİLDİR; yalnızca hata ayıklama içindir.
 *
 * Kullanım: Trendyol sekmesinde F12 → Console → bu dosyayı yapıştır → Enter
 *           sonra:  desiAra('Kargo Aşamasındakiler')
 */

window.desiAra = function desiAra(aranan) {
  const hedef = String(aranan).replace(/\s+/g, ' ').trim();
  const hepsi = [...document.querySelectorAll('*')];

  const gorunur = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const metin = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

  const birebir = [];
  const iceren = [];

  for (const el of hepsi) {
    const m = metin(el);
    if (!m) continue;
    if (m === hedef) birebir.push(el);
    else if (m.includes(hedef) && m.length < hedef.length + 60) iceren.push(el);
  }

  console.log(`%c"${hedef}" araniyor…`, 'font-weight:bold;font-size:14px');
  console.log(`Birebir eslesme: ${birebir.length}, Iceren: ${iceren.length}`);

  if (birebir.length === 0 && iceren.length === 0) {
    console.log(
      '%cHIC BULUNAMADI — bu metin su anda sayfada yok.',
      'color:#c0392b;font-weight:bold'
    );
    console.log('Menu kapali olabilir. Once menuyu acip tekrar deneyin.');
    return;
  }

  // En derindeki (en kisa metinli) adaylar once.
  const sirala = (liste) => liste.sort((a, b) => metin(a).length - metin(b).length).slice(0, 5);

  for (const [baslik, liste] of [['BIREBIR', birebir], ['ICEREN', iceren]]) {
    if (liste.length === 0) continue;
    console.log(`%c--- ${baslik} ---`, 'font-weight:bold');

    for (const el of sirala(liste)) {
      const g = gorunur(el);
      console.log(
        `%c${g ? 'GORUNUR' : 'GIZLI  '}%c <${el.tagName.toLowerCase()}> ` +
          `id="${el.id || '-'}" testid="${el.getAttribute('data-testid') || '-'}"`,
        `color:${g ? '#1f9254' : '#c0392b'};font-weight:bold`,
        'color:inherit'
      );
      console.log('   ', el);
    }
  }

  console.log(
    '%cIpucu: GIZLI cikanlar menu kapali demektir. GORUNUR bir aday varsa ' +
      'kayit calismali.',
    'color:#6b7684'
  );
};

console.log(
  '%cdesiAra() hazir. Ornek:  desiAra("Kargo Asamasindakiler")',
  'color:#f27a1a;font-weight:bold'
);
