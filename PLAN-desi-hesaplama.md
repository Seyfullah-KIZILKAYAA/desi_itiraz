# Plan — Desi İtiraz Hesaplama Modülü

## 1. Amaç

Trendyol'dan indirilen `Siparişleriniz_*.xlsx` dosyasını Excel sekmesine yükleyip,
hangi paketlerin desi itirazına uygun olduğunu otomatik hesaplamak.
Sonuç listesi ekranda görünecek, satır silinebilecek, ardından mevcut
kayıt/oynatma altyapısıyla itiraz kuyruğuna dönüşecek.

## 2. Excel dosyasının gerçek yapısı (doğrulandı)

Örnek dosya: `prod_165724_..._Siparişleriniz_28.07.2026-14.00.xlsx`

- Sayfa adı: `Tedarikci_Siparisleri`
- **1. satır yasal uyarı metni; gerçek başlık 2. satırda.** Mevcut
  `readWorkbook()` başlığı 1. satırdan okuduğu için desi modülü kendi
  okuyucusunu kullanacak (`readOrderWorkbook`).
- 147.921 veri satırı, 86.358 farklı `Sipariş Numarası`.

Kullanılacak kolonlar:

| Kolon | Kullanım |
|---|---|
| `Sipariş Numarası` | **Gruplama anahtarı** (bir sipariş = bir kargo poşeti = bir itiraz) |
| `Paket No` | Bilgi olarak taşınır |
| `Ürün Adı` | Kategori tespiti (kategori sütunu yok) |
| `Adet` | Paketteki toplam ürün adedi |
| `Kargodan alınan desi` | Trendyol'un yazdığı desi (itiraz edilen değer) |
| `Faturalanan Kargo Tutarı` | Fiyat kuralı |
| `Sipariş Statüsü` | Bilgi (`Teslim Edildi` / `İade edildi`) |
| `Birim Fiyatı`, `Marka`, `Stok Kodu` | Görüntüleme |

Doğrulanan veri gerçekleri:

- Bir siparişte birden fazla ürün olabiliyor ama **tek kargo poşetiyle**
  gidiyor → desi sipariş bazında hesaplanır, ürün bazında değil.
  147.921 satırın 34.310'u çok ürünlü siparişlere ait.
- Sipariş içinde `Kargodan alınan desi` **her zaman aynı** (0 istisna) →
  sipariş başına tek desi değeri.
- Sipariş içinde `Faturalanan Kargo Tutarı` **her zaman aynı** (0 istisna).
- Bu dosyada hiçbir sipariş birden fazla `Paket No`'ya bölünmemiş
  (86.358 sipariş = 86.358 paket), yani iki anahtar aynı gruplamayı veriyor.
  Yine de gruplama `Sipariş Numarası` üzerinden yapılır; bir sipariş ileride
  birden çok pakete bölünürse doğru olan budur.
- Mevcut desi dağılımı: 2.0 → 138.027, 3.0 → 7.138, 4.0 → 2.283, 1.0 → 243,
  kalan yüksek değerler birkaç yüz satır.
- Kargo tutarı dağılımı: `Henüz fatura kesilmemiştir.` → 99.220,
  `110.39` → 39.081, `105.49` → 6.315, `122.39` → 2.106, geri kalanı seyrek.
- Adet dağılımı: 1 → 143.453, 2 → 3.458, 3 → 603, 4 → 198, 5+ → az.

## 3. Hesaplama algoritması

Sipariş bazında çalışır — bir sipariş tek kargo poşetiyle gittiği için
desi siparişteki tüm ürünlerin toplamıdır.

### Adım 1 — Siparişleri grupla
Satırları `Sipariş Numarası`'na göre grupla. Sipariş başına:
- `mevcutDesi` = `Kargodan alınan desi` (siparişin ilk satırından)
- `kargoTutari` = `Faturalanan Kargo Tutarı`
- ürün satırları listesi (ürün adı + adet)
- `paketNo` = bilgi olarak taşınır

### Adım 2 — Kategori tespiti (ürün adından)
Kategori sütunu olmadığı için `Ürün Adı` metninde kategori anahtar
kelimeleri aranır. Türkçe normalize edilir (küçük harf, `İ/ı/ş/ğ/ç/ö/ü`
sadeleştirme — mevcut `normalizeHeader` mantığının aynısı).

Eşleme kuralları:
- **En uzun eşleşme kazanır.** "Polo Yaka T-shirt" varsa "T-Shirt"e değil
  ona düşer; "Büyük Beden T-Shirt" varsa ona düşer.
- **Büyük Beden önceliklidir**: ürün adında "büyük beden" geçiyorsa önce
  `Büyük Beden <X>` kategorisi denenir.
- Hiçbiri tutmazsa kategori = `Diğer` (varsayılan desi ile, listede
  "kategori bulunamadı" rozetiyle işaretlenir ki kullanıcı görebilsin).

### Adım 3 — Hesaplanan desiyi bul
```
hamDesi   = Σ (satır.adet × kategoriOrtalamaDesi)
hesapDesi = max(1, ceil(hamDesi))      // yukarı yuvarla, 1 desi taban
```
- `ceil` — 0,8 → 1; 2,4 → 3. (Kargo firması aşağı yuvarlamaz.)
- `max(1, …)` — panel 1 desi altını kabul etmiyor.

Örnek (senin verdiğin): 4 adet T-Shirt × 0,2 = 0,8 → ceil → 1 desi.
Excel'de 3 yazıyor → itiraz: 3 → 1.

### Adım 4 — Filtre kuralları (hepsi geçilmeli)

1. **Fiyat kuralı** — `kargoTutari` sayıya çevrilir.
   - `Henüz fatura kesilmemiştir.` (veya sayı olmayan herhangi bir değer)
     → **dahil edilir** (henüz faturalandırılmamış olanlar dahil).
   - Sayısal ve **eşiğe eşit ya da altındaysa → hariç** (`<= 110.39`).
     Yani 110,39'un kendisi de hariç; sadece üstü dahil.
   - Eşik varsayılan **110,39**, ayarlardan değiştirilebilir.
   - *Etki: 86.358 siparişten 26.909'u bu kuralda elenir, 59.449 kalır.*
2. **Küçültme kuralı** — sadece `hesapDesi < mevcutDesi` olanlar itiraza
   girer. Eşit veya büyükse **hariç** (desi büyütme yok).
3. **Taban kuralı** — `hesapDesi >= 1` zaten Adım 3'te garanti; ayrıca
   `mevcutDesi <= 1` olan siparişler hariç (indirilecek yer yok).
4. **Statü kuralı** — `İade edildi` siparişler varsayılan olarak hariç
   (ayarlardan açılabilir onay kutusu).
5. **Yükseltme kuralı** — `hesapDesi = 1` ve `mevcutDesi > 3` ise (yani 4 ve
   üzeri; 3 dahil değil) itirazda **1 yerine 2 desi** girilir.
   Bu, fark kontrolünden ÖNCE uygulanır çünkü artık girilecek değer 2'dir.
6. **Fark kuralı** — `mevcutDesi - girilecekDesi >= 2` olmalı. Panel 1 farklı
   itirazı (2 → 1, 3 → 2) kabul etmiyor, o yüzden hiç listeye alınmaz.

Fiyat kuralının tarih ayrımı: kargo fiyatı **13.07.2026'dan sonra** güncellendiği
için o tarihten sonraki siparişlerde eşik **115,67**, öncesinde **110,39**'dur.
Her iki eşik ve geçiş tarihi ayarlardan değiştirilebilir.

Kalanlar = itiraz edilecekler listesi.

## 4. Kategori varsayılan desi tablosu

İki görselden birleştirilmiş liste. Değerler ilk varsayılan; uygulamadaki
**Desi Bilgileri** ekranından düzenlenebilir ve kalıcı kaydedilir.

| Kategori | Varsayılan desi |
|---|---|
| T-Shirt | 0,20 |
| Polo Yaka T-shirt | 0,25 |
| Atlet | 0,15 |
| Spor Atlet | 0,15 |
| Body | 0,15 |
| Büstiyer | 0,15 |
| Bluz | 0,25 |
| Gömlek | 0,35 |
| Elbise | 0,45 |
| Tunik | 0,35 |
| Etek | 0,30 |
| Şort & Bermuda | 0,30 |
| Pantolon | 0,50 |
| Tayt | 0,25 |
| Hırka | 0,50 |
| Kazak | 0,50 |
| Sweatshirt | 0,60 |
| Ceket | 0,80 |
| Kimono & Kaftan | 0,40 |
| Çorap | 0,05 |
| Pijama Üstü | 0,25 |
| Eşofman Altı | 0,45 |
| Spor Eşofman Altı | 0,45 |
| Eşofman Takımı | 0,90 |
| Alt - Üst Takım | 0,80 |
| Spor Tulum | 0,60 |
| Parfüm | 0,50 |
| Büyük Beden T-Shirt | 0,30 |
| Büyük Beden Atlet | 0,20 |
| Büyük Beden Bluz | 0,35 |
| Büyük Beden Body | 0,20 |
| Büyük Beden Büstiyer | 0,20 |
| Büyük Beden Gömlek | 0,45 |
| Büyük Beden Elbise | 0,60 |
| Büyük Beden Tunik | 0,45 |
| Büyük Beden Etek | 0,40 |
| Büyük Beden Pantolon | 0,65 |
| Büyük Beden Tayt | 0,35 |
| Büyük Beden Sweatshirt | 0,75 |
| Büyük Beden Ceket | 1,00 |
| Büyük Beden Eşofman Altı | 0,60 |
| Büyük Beden Alt - Üst Takım | 1,00 |
| Diğer (varsayılan) | 0,30 |

> Bu sayılar tahmini başlangıç değerleridir; gerçek ortalamaları
> **Desi Bilgileri** ekranından girmen gerekiyor. Kaydedilen değerler
> varsayılanların üzerine yazılır.

## 5. Uygulama değişiklikleri

### 5.1 Yeni dosya: `src/core/desi.js`
Saf hesaplama (Electron'a bağımlı değil, test edilebilir):
- `readOrderWorkbook(filePath)` — başlığı 2. satırdan okur, kolonları isimle bulur
- `DEFAULT_CATEGORY_DESI` — §4 tablosu
- `detectCategory(urunAdi, categories)` — en-uzun-eşleşme + Büyük Beden önceliği
- `groupByOrder(rows)` — `Sipariş Numarası` bazlı gruplama
- `computeClaims(orders, { categoryDesi, priceThreshold, includeReturned })`
  → `{ claims, stats }`

`stats`: toplam sipariş, kategori bulunamayan, fiyat kuralında elenen,
küçültme kuralında elenen, kalan itiraz sayısı.

### 5.2 Ayar kalıcılığı: `src/core/settings.js`
`app.getPath('userData')/desi-settings.json` içinde
`{ categoryDesi, priceThreshold, includeReturned }`. Yoksa varsayılan.

### 5.3 IPC: `src/main/main.js` + `preload.js`
- `desi:loadExcel` (dosya yolu → paketler + stats özeti)
- `desi:getSettings` / `desi:saveSettings`
- `desi:compute` (mevcut yüklü dosya + ayarlar → claims)
- `desi:toQueue` (seçili/kalan claims → mevcut Work Queue formatına dönüştür,
  `siparisNo` = Sipariş Numarası, `dogruDesi` = hesapDesi,
  `itirazSebebi` = otomatik metin)

### 5.4 Arayüz: Excel sekmesi (`index.html`, `app.js`, `styles.css`)
Mevcut "Excel Dosyası Seç" satırının altına:

```
[Excel Dosyası Seç]  dosya.xlsx — 147.921 satır / 86.358 sipariş
[Desi Bilgileri]  [İtirazları Hesapla]
```

- **Desi Bilgileri** → modal/panel: kategori + desi giriş tablosu,
  fiyat eşiği alanı, "İade edilenleri dahil et" onay kutusu,
  `Kaydet` / `Varsayılanlara Dön`.
- **İtirazları Hesapla** → altta sonuç tablosu:
  `Sipariş No | Paket No | Ürünler (kategori × adet) | Mevcut Desi |
   Hesaplanan Desi | Kargo Tutarı | Sil`
  - Üstte özet: "86.358 siparişten 1.245'i itiraza uygun".
  - Her satırda **Sil** butonu; ayrıca çoklu seçim + "Seçilenleri Sil".
  - Kategori bulunamayan ürünler sarı rozetle işaretlenir.
  - Büyük liste için sayfalama (100'erli) — 86 bin satır DOM'a basılmaz.
- **Kuyruğa Aktar** butonu → kalan liste mevcut Work Queue'ya yazılır,
  Çalıştır sekmesi normal akışıyla devam eder.

### 5.5 Testler: `test/desi.test.js`
- 4 adet T-Shirt → 0,8 → 1 desi (senin örneğin)
- Kargo tutarı 105,49 → elenir; tam 110,39 → **elenir**;
  122,39 → kalır; `Henüz fatura kesilmemiştir.` → kalır
- Çok ürünlü sipariş tek grup olur (3 satır → 1 itiraz, desiler toplanır)
- hesapDesi == mevcutDesi → elenir; hesapDesi > mevcutDesi → elenir
- mevcutDesi 1 → elenir
- "Büyük Beden T-Shirt" → T-Shirt'e değil kendi kategorisine düşer
- "Polo Yaka T-shirt" → T-Shirt'e değil kendi kategorisine düşer
- Karışık sipariş (2 tişört + 1 pantolon) toplamı doğru

## 6. Uygulanan hali (tamamlandı)

Dosyalar:

- `src/core/desi.js` — okuma, kategori tespiti, gruplama, hesaplama, dışa aktarma
- `src/core/desi-settings.js` — ayar kalıcılığı (`userData/data/desi-settings.json`)
- `test/desi.test.js` (27 test), `test/desi-settings.test.js` (7 test) — 105/105 geçiyor
- `src/main/main.js`, `src/main/preload.js` — `desi:*` IPC uçları
- `src/renderer/index.html`, `app.js`, `styles.css` — Excel sekmesindeki arayüz

Gerçek dosyayla (147.921 satır) ölçülen sonuç:

| Ölçüt | Değer |
|---|---|
| Toplam sipariş | 86.358 |
| Kargo tutarı eşiğinde elenen | 26.817 |
| **1 desi fark olduğu için elenen** | **54.519** |
| Desi zaten doğru/düşük (küçültme yok) | 1.697 |
| İade edildiği için elenen | 337 |
| Mevcut desi 1 olduğu için elenen | 40 |
| **İtiraz edilecek** | **2.948** |
| Bunlardan 1 yerine 2 desi girilecek | 525 |
| Kategorisi bulunamayan ürün içeren | 11 |

Kalan itirazların dağılımı: 3 → 1 (2.195), 4 → 2 (730), gerisi tekil yüksek
desili siparişler. 13.07.2026 sonrası 34.129 sipariş yeni eşiğe tabi.

Uygulama sırasında çıkan iki düzeltme:

1. **"Şort" eşleşmiyordu.** Kategori adı `Şort & Bermuda` ama ürün adlarında
   yalnızca "Şort" geçiyor. Birleşik adlar `&` işaretinden bölünüp parçaları
   da arama terimi yapıldı → kategorisiz ürün adı 182'den 21'e düştü,
   etkilenen sipariş 2.019'dan 193'e indi.
2. **Performans.** Aynı ürün adı on binlerce satırda tekrar ettiği için
   kategori tespiti ürün adı başına önbelleğe alındı.

Dikkat edilmesi gereken bulgu: itirazların %94'ü (54.158) "2 desi → 1 desi"
kalıbında ve bunların 33.769'u tek ürünlü sipariş. Yani tek bir tişört/şort
için 2 desi yazılmış. Kod kurallara uygun çalışıyor; sayının gerçekçiliği
§4 tablosundaki ortalama desilere bağlı — gerçek değerler girildiğinde bu
sayı belirgin şekilde değişecektir.

## 7. Uygulama sırası (izlenen yol)

1. `src/core/desi.js` + `test/desi.test.js`
2. `src/core/settings.js`
3. IPC uçları (`main.js`, `preload.js`)
4. Arayüz (Excel sekmesi: iki buton, ayar paneli, sonuç tablosu, silme)
5. Kuyruğa aktarma bağlantısı
6. Gerçek dosyayla uçtan uca deneme

## 8. Karara bağlananlar / açık nokta

Karara bağlandı:

- **Fiyat eşiği:** 110,39 **hariç** (`<= 110.39` elenir). 86.358 siparişten
  26.909'u elenir, 59.449 kalır.
- **Gruplama:** `Sipariş Numarası` — bir sipariş tek kargo poşetiyle gidiyor,
  siparişteki tüm ürünlerin desisi toplanır.

Açık nokta:

- **§4 tablosundaki desi değerleri tahminidir** — görsellerde yalnızca
  kategori isimleri vardı, ortalama desi yoktu. T-Shirt senin verdiğin
  0,20 ile sabitlendi, diğerleri ona göre ölçeklendi. Bu değerlerle
  başlanacak; **Desi Bilgileri** ekranından düzeltilip kalıcı kaydedilecek.
  Gerçek ortalamalar elindeyse kodlama sırasında doğrudan yazılabilir.
