/** Popup — yalnızca durum gösterir; kayıt/oynatma masaüstü uygulamasından yönetilir. */

const dot = document.getElementById('dot');
const status = document.getElementById('status');
const tabInfo = document.getElementById('tab');
const hint = document.getElementById('hint');

// Yeni kodun gerçekten yüklendiğini gözle doğrulayabilmek için sürümü göster.
document.getElementById('ver').textContent = `Sürüm ${chrome.runtime.getManifest().version}`;

chrome.runtime.sendMessage({ kind: 'getStatus' }, (response) => {
  if (chrome.runtime.lastError || !response) {
    status.textContent = 'Eklenti yanıt vermiyor';
    hint.textContent = 'Chrome eklenti sayfasından eklentiyi yeniden yükleyin.';
    return;
  }

  if (response.recording) {
    dot.className = 'dot rec';
    status.textContent = 'Kayıt sürüyor';
    hint.textContent =
      'İtiraz işlemini bu sekmede baştan sona yapın. Bitince masaüstü uygulamasından ' +
      '"Kaydı Bitir"e basın.';
  } else if (response.connected) {
    dot.className = 'dot on';
    status.textContent = 'Uygulamaya bağlı';
    hint.textContent = 'Masaüstü uygulamasından kayıt başlatabilir veya çalıştırabilirsiniz.';
  } else {
    dot.className = 'dot';
    status.textContent = 'Uygulama bağlı değil';
    hint.textContent =
      'Masaüstü uygulamasını açın. Bağlantı birkaç saniye içinde otomatik kurulur.';
  }

  if (response.targetTabId != null) {
    tabInfo.textContent = `Hedef sekme: #${response.targetTabId}`;
  }
});
