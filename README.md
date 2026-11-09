# tthome

Coolify'da çalışan kişisel panel:

- **Durum** — masaüstü ve laptop çevrimiçi mi (ping + TCP port kontrolü, 10 sn'de bir)
- **Uyandır** — kapalıysa Wake-on-LAN magic packet gönderir
- **RustDesk ile bağlan** — tek tıkla `rustdesk://ID` açar, ID'yi kopyalar
- **Kamera** — bilgisayardaki webcam'i (go2rtc üzerinden) panelde canlı izlersin; görüntü sunucu üzerinden geçer, go2rtc internete açılmaz
- Şifreli giriş, 30 günlük oturum, kaba-kuvvet koruması. Harici npm bağımlılığı yok.

```
 Telefon / dışarıdaki laptop
        │ HTTPS (Coolify/Traefik)
        ▼
 ┌──────────── Evdeki Coolify sunucusu ────────────┐
 │  app (panel)  ──ping/TCP──►  PC, Laptop          │
 │      │  ──/cam proxy──►  go2rtc :1984 (webcam)   │
 │      └─► wol-relay (host ağı) ──UDP broadcast──► │
 └──────────────────────────────────────────────────┘
 RustDesk bağlantısı doğrudan RustDesk istemcisiyle kurulur.
```

> **Önemli:** Coolify sunucusu **evdeki ağda** olmalı (ev sunucusu, Raspberry Pi, NAS vb.).
> WoL broadcast paketi internet üzerinden yönlendirilemez. Coolify bir VPS'teyse aşağıdaki
> "VPS'te Coolify" bölümüne bak.

---

## 1. Windows bilgisayarları hazırla (her biri için)

1. **BIOS/UEFI**: `Wake on LAN`, `Power On By PCI-E/PCI` gibi seçeneği aç. `ErP / Deep Sleep` varsa kapat.
2. **Sabit IP**: Router'da her cihaza DHCP rezervasyonu ver.
3. **RustDesk**: Kur → Ayarlar → Güvenlik → *Kalıcı şifre* belirle. Ana ekrandaki **ID**'yi not al.
   RustDesk'i servis olarak kurarsan (varsayılan) açılış ekranına da bağlanabilirsin.
4. **go2rtc (webcam)**:
   - [go2rtc](https://github.com/AlexxIT/go2rtc/releases) `go2rtc_win64.zip` → `C:\go2rtc\go2rtc.exe`
   - [ffmpeg](https://www.gyan.dev/ffmpeg/builds/) `ffmpeg-release-essentials.zip` içindeki `bin\ffmpeg.exe` → `C:\go2rtc\ffmpeg.exe`
   - [windows/go2rtc.yaml](windows/go2rtc.yaml) dosyasını `C:\go2rtc\` içine kopyala, **şifreyi değiştir**.
   - Test: `http://localhost:1984/api/stream.mjpeg?src=webcam` tarayıcıda görüntü vermeli.
5. **Hazırlık betiği** (Yönetici PowerShell):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\windows\setup.ps1
   ```

   Ping ve 1984 portunu yalnızca yerel ağa açar, ağ kartında WoL'u etkinleştirir, Hızlı Başlatma'yı
   kapatır, go2rtc'yi oturum açılışında başlatır ve **MAC / IP** adreslerini yazdırır.

> **Laptop notu:** WoL genelde yalnızca **kablolu (Ethernet)** bağlantıda ve laptop **şarja takılıyken**
> çalışır. Wi-Fi üzerinden kapalı bir laptopu uyandırmak çoğu modelde mümkün değildir; uyku
> modundaysa bazen çalışır. Laptopta durum/RustDesk/kamera yine çalışır.

> **Kamera notu:** go2rtc kullanıcı oturumu açılınca başlar. WoL ile açılan bilgisayara önce
> RustDesk ile bağlanıp oturum aç, sonra kamera kullanılabilir. (İstersen Windows'ta otomatik oturum açmayı etkinleştirebilirsin.)

## 2. Coolify'a kur

1. Bu klasörü bir Git deposuna (GitHub/Gitea, **özel** depo) gönder.
2. Coolify → **New Resource → Private/Public Repository** → depoyu seç.
3. **Build Pack: Docker Compose**, dosya: `docker-compose.yml`.
4. `app` servisi için domain: `https://ev.ornek.com:3000` (sondaki `:3000` konteyner portudur).
5. **Environment Variables** — [.env.example](.env.example) içindekileri gir:

   | Değişken | Açıklama |
   |---|---|
   | `APP_PASSWORD` | Panel giriş şifresi |
   | `WOL_RELAY_TOKEN` | Panel ↔ relay gizli anahtarı (`openssl rand -hex 32`) |
   | `SESSION_SECRET` | İsteğe bağlı, oturum anahtarı |
   | `DEVICES` | Cihaz listesi, tek satır JSON (aşağıda) |
   | `POLL_SECONDS` | Kontrol aralığı (varsayılan 10) |

6. **Deploy**.

### `DEVICES` alanları

```json
[
  {
    "id": "pc",
    "name": "Masaüstü",
    "icon": "desktop",
    "host": "192.168.1.20",
    "mac": "AA:BB:CC:DD:EE:01",
    "broadcast": "192.168.1.255",
    "rustdeskId": "123456789",
    "camUrl": "http://kamera:SIFRE@192.168.1.20:1984/api/stream.mjpeg?src=webcam",
    "checkPorts": [21118, 1984, 3389, 445]
  }
]
```

| Alan | Zorunlu | Açıklama |
|---|---|---|
| `id` | – | URL'de kullanılan kısa ad |
| `name` | – | Panelde görünen ad |
| `icon` | – | `desktop` veya `laptop` |
| `host` | ✔ | Cihazın yerel IP'si |
| `mac` | WoL için | Ethernet kartının MAC adresi |
| `broadcast` | – | Ağın broadcast adresi (ör. `192.168.1.255`) |
| `rustdeskId` | – | RustDesk ID |
| `camUrl` | – | go2rtc MJPEG adresi (go2rtc.yaml'daki kullanıcı/şifre ile) |
| `checkPorts` | – | Çevrimiçi kontrolünde denenecek TCP portları |

Coolify'a girerken JSON'u **tek satır** yaz.

## 3. Sunucu güvenlik duvarı

`wol-relay` sunucunun 9099 portunu dinler; panel ona `host.docker.internal` üzerinden ulaşır.
Sunucuda `ufw` açıksa Docker ağından bu porta izin ver, dışarıya açma:

```bash
sudo ufw allow from 172.16.0.0/12 to any port 9099 proto tcp
```

İstek token olmadan reddedilir, yine de 9099'u router'da dışarı yönlendirme.

## VPS'te Coolify

Panel VPS'teyse ev ağına bir yoldan ulaşması gerekir:

1. Evde sürekli açık bir cihaza (Pi/NAS) ve VPS'e **Tailscale** kur; ev cihazında *subnet router* olarak
   `192.168.1.0/24`'ü yayınla.
2. `wol-relay`'i ev cihazında çalıştır (`docker compose up -d wol-relay` veya `MODE=relay node server.js`).
3. Coolify'da `WOL_RELAY_URL` değerini ev cihazının Tailscale IP'si ile değiştir: `http://100.x.y.z:9099`.

## Yerelde deneme

```bash
APP_PASSWORD=test WOL_RELAY_TOKEN=x DEVICES='[{"id":"pc","name":"PC","host":"192.168.1.20","mac":"AA:BB:CC:DD:EE:01"}]' node server.js
```

Relay olmadan çalıştırırsan (`WOL_RELAY_URL` boş) WoL paketi doğrudan panel sürecinden gönderilir.

## Sorun giderme

- **Hep "Kapalı" görünüyor** → `setup.ps1` çalıştı mı? Sunucudan `ping 192.168.1.20` dene. Ağ profili "Ortak" ise "Özel" yap.
- **Uyandır çalışmıyor** → BIOS ayarı, Hızlı Başlatma, kablolu bağlantı, doğru MAC. Relay loglarında `WoL gönderildi` satırını kontrol et.
- **Kamera açılmıyor** → bilgisayarda `http://localhost:1984` açılıyor mu, sunucudan `curl -u kamera:SIFRE http://IP:1984/api/streams` yanıt veriyor mu? Başka uygulama kamerayı kullanıyorsa go2rtc açamaz.
- **Kamera dışarıdan donuyor** → Coolify'da bu servis için gzip/compress middleware'i kapat.
