# Desi İtiraz Otomasyonu

Trendyol satıcı panelinde desi itirazlarını toplu olarak yapan, "kaydet ve tekrar
oynat" mantığıyla çalışan masaüstü uygulaması.

Kullanıcı iş akışını kendi Chrome'unda bir kez gösterir; uygulama bunu adım adım
kaydeder ve Excel'deki her satır için tekrar oynatır. Tıklamalar ekran
koordinatına değil, DOM elemanlarına göre yapılır — bu yüzden farklı ekran
çözünürlüklerinde de aynı şekilde çalışır.

## Durum

| Bileşen | Durum |
|---|---|
| Excel içe/dışa aktarma | ✅ Hazır |
| Kayıt Kitaplığı (JSON depolama, sıralı adlandırma) | ✅ Hazır |
| Kaydedici (adım toplama, değişken bağlama) | ✅ Hazır |
| Player (satır satır yürütme, opsiyonel adım, duraklat/durdur) | ✅ Hazır |
| WebSocket köprüsü | ✅ Hazır |
| Arayüz (Kayıtlar / Excel / Çalıştır) | ✅ Hazır |
| Chrome eklentisi (MV3) | ✅ Hazır |
| **Trendyol'da canlı test** | ⬜ Sıradaki iş |

Çekirdek mantık, köprü protokolü ve seçici motoru testlerle doğrulanmıştır
(41 test). Gerçek Trendyol akışı henüz denenmedi — ilk canlı kayıt yapıldığında
itiraz sebebi metni ve hangi adımların opsiyonel olduğu netleşecek.

## Kurulum

```
npm install
```

## Çalıştırma

```
npm start
```

## Testler

```
npm test
```

Testler Chrome ve Electron olmadan çalışır; köprü sahte bir nesneyle
değiştirilir.

## Excel şablonu

```
npm run template
```

Çıktı: `templates/desi_itiraz_sablonu.xlsx` — iki sayfalı:

- **İtirazlar** — veri girilecek sayfa
- **Açıklama** — kolon kuralları ve durum listesi (ayrı doküman gerekmez)

| Sipariş No | Doğru Desi | İtiraz Sebebi | Açıklama |
|---|---|---|---|
| 123456789 | 3 | | |
| 987654321 | 1,5 | | |

Yalnızca **Sipariş No** ve **Doğru Desi** zorunludur.

`İtiraz Sebebi` opsiyoneldir — tek bir itiraz kaydıyla çalışıyorsanız sebep
zaten kaydın içinde sabittir. Sadece birden fazla itiraz kaydınız varsa ve
hangi satırın hangi kaydı kullanacağını belirtmek isterseniz doldurun.

`Açıklama` opsiyoneldir — form bazı itirazlarda istiyor, bazılarında istemiyor.

## Chrome eklentisini kurma (bir kez)

1. Chrome'da `chrome://extensions` adresine gidin
2. Sağ üstten **Geliştirici modu**'nu açın
3. **Paketlenmemiş öğe yükle** → bu projedeki `extension/` klasörünü seçin
4. Eklenti simgesinde rozet görünür:
   - `OFF` (kırmızı) — masaüstü uygulaması kapalı
   - `ON` (yeşil) — uygulamaya bağlı
   - `REC` (turuncu) — kayıt sürüyor

Uygulamayı açtığınızda rozet birkaç saniye içinde `ON` olur. Olmuyorsa
eklenti sayfasından **Yeniden yükle**'ye basın.

## Kullanım akışı

**İki ayrı kayıt alınır.** Biri sayfaya kadar gelen yol, diğeri her sipariş için
tekrarlanan itiraz işlemi.

### Kayıt 1 — Hazırlık (bir kez çalışır)

1. Chrome'da Trendyol paneline girin, oturumunuz açık olsun
2. **Kayıtlar** sekmesinde türü **"Hazırlık kaydı"** seçin
3. **Yeni Kayıt Başlat**
4. Desi itiraz sayfasına kadar gidin — menüye tıklayın, sekmeye geçin.
   **Sipariş aramayın, itiraz yapmayın.** Sadece sayfaya ulaşın.
5. Sayfaya ulaşınca **Kaydı Bitir**
6. **Yeniden Adlandır** ile anlamlı bir isim verin (örn. "Sayfaya git")

### Kayıt 2 — İtiraz (her sipariş için tekrarlanır)

1. Chrome'da zaten desi itiraz sayfasında olun
2. Türü **"İtiraz kaydı"** seçin → **Yeni Kayıt Başlat**
3. Bir siparişin itirazını baştan sona yapın: sipariş no yazın, arayın,
   itiraz edin, desi girin, gönderin
4. Sipariş no / desi yazarken uygulama "değişken olarak kaydedeyim mi?"
   diye sorar — uygun olanı seçin
5. Onay ekranını görünce **Kaydı Bitir**
6. Adım listesini gözden geçirin; her siparişte çıkmayan adımları
   **Opsiyonel Yap** ile işaretleyin

### Çalıştırma

**Çalıştır** sekmesinde iki menü var:

| Menü | Ne yapar |
|---|---|
| **1. Hazırlık kaydı** | Çalışmanın en başında bir kez çalışır |
| **2. İtiraz kaydı** | Excel'deki her satır için tekrarlanır |

İtiraz kaydını boş bırakırsanız:

- **Tek itiraz kaydınız varsa** → o kayıt kullanılır, Excel'e sebep yazmanıza
  gerek yok
- **Birden fazla varsa** → Excel'deki `İtiraz Sebebi` sütununa göre eşleşir
  (her kayda **Sebep Ata** yapılmış olmalı). Eşleşme belirsizse satır
  `Eşleşme bulunamadı` işaretlenir, tahmin edilmez.

Hazırlık başarısız olursa hiçbir satır çalıştırılmaz — yanlış sayfadayken
sipariş aramak anlamsız olurdu.

**Toplu çalıştırma:**

1. **Excel** sekmesi → dosyayı seçin, kolon eşlemesini kontrol edin
2. **Kuyruğu Oluştur**
3. **Çalıştır** sekmesi → **Başlat**
4. İşlem Chrome'da gözünüzün önünde yürür; her eleman turuncu çerçeveyle vurgulanır
5. Bitince **Sonuçları Excel'e Aktar**

## Klasör yapısı

```
src/
  shared/
    protocol.js     mesaj sözleşmesi, eylem ve durum sabitleri
    variables.js    {{degisken}} çözümleme
  core/
    excel.js        içe/dışa aktarma, kolon eşleme, doğrulama
    recordings.js   Kayıt Kitaplığı, sıralı adlandırma, satır-Kayıt eşleme
    recorder.js     ham DOM olaylarını adımlara çevirir
    player.js       satır satır yürütme motoru
    bridge.js       yerel WebSocket sunucusu (port 17321)
  main/
    main.js         Electron ana süreç, IPC
    preload.js      arayüze açılan güvenli yüzey
  renderer/         arayüz (HTML/CSS/JS)
extension/
  manifest.json     MV3 tanımı
  background.js     WebSocket bağlantısı, sekme yönetimi
  content.js        olay yakalama (kayıt) ve adım uygulama (oynatma)
  selectors.js      seçici üretimi ve çözümlemesi (§4.4 öncelik sırası)
  popup.html/js     bağlantı durumu göstergesi
test/               çekirdek, köprü ve seçici testleri
scripts/            şablon üretici
templates/          üretilmiş Excel şablonu
```

## Mimari kuralları

Bu kurallar spec'ten gelir ve ihlal edilmemelidir:

1. Ekran koordinatıyla tıklama yok — hedefleme yalnızca DOM üzerinden.
2. Yeni tarayıcı/profil açılmaz; kullanıcının zaten giriş yapmış Chrome'una bağlanılır.
3. Headless çalışmaz; kullanıcı işlemi ekranda görür.
4. Sabit `sleep()` yok; her bekleme bir DOM koşuluna bağlı, timeout yalnızca emniyet ağı.
5. Trendyol'a özgü seçici/URL/buton metni **kodda bulunmaz** — yalnızca Kayıt JSON'unda.
6. Eşleşmeyen satır tahmin edilmez, `Eşleşme bulunamadı` işaretlenir.
7. Tek satırın hatası batch'i durdurmaz (kullanıcı "ilk hatada dur" demedikçe).
8. `sequentialName` ve `customLabel` ayrı alanlardır, birleştirilmez.
9. Tek panel varsayımı yapılmaz; `panel` alanı ikinci pazaryeri için hazırdır.

## Satır durumları

| Durum | Anlamı |
|---|---|
| `Bekliyor` | Henüz çalışmadı |
| `Çalışıyor` | Şu an işleniyor |
| `Başarılı` | Onay adımına ulaşıldı |
| `Başarısız` | Zorunlu bir adım başarısız oldu |
| `Eşleşme bulunamadı` | Satır için uygun Kayıt yok |
| `Eksik veri` | Sipariş No veya Doğru Desi boş ya da geçersiz |

## Sıradaki iş: Chrome eklentisi

Eklenti `src/shared/protocol.js`'teki sözleşmeyi uygulamalıdır:

- `ws://127.0.0.1:17321` adresine bağlanır, kopunca yeniden dener
- **Kayıt modu**: tıklama/yazma/gezinme olaylarını yakalar, §4.4 öncelik
  sırasına göre aday seçiciler üretir ve `recordedEvent` olarak gönderir
- **Oynatma modu**: `executeStep` alır, seçici stratejilerini sırayla dener,
  etkileşimden önce elemanı görsel olarak vurgular, `stepResult` döner
