Merhaba dostlar, öncelikle belirtmeliyim ki bu programı yaparken yapay zekadan oldukça yardım aldım ve tamamen stabil ve düzgün bir sistem oturttuktan sonra paylaşmaya karar verdim.
https://iamnoobhasproject.github.io/burnedwolf/ Projenin github page ine buradan ulaşabilirsiniz bu sayfa bilgilendirme amaçlı.

Programı yaparken veya paylaşırken hiçbir para kazanma amacı gütmedim. Sadece kendim ve arkadaşlarımın rahatça kullanarak discorda ve engellenen her siteye, oyuna veya sunucuya erişebilmesini istediğim için ve GoodbyeDpi gibi hazır sistemlerin bazı oyunlarda hatalarda sebebiyet verdiğini gördüğüm için bu programı yaptım.

Program electron altyapısıyla yapılmıştır incelemek isteyen kişi eğer bilgili bir kişi ise; dosya konumundan app.asar dosyasını açarak javascript ve html kodlarını inceleyebilir.

Programda 2 ana uygulama mevcut; İlk olarak Tor Ağı üzerinden proxy şeklinde bağlantı sağlayan Discord'un ta kendisi. İkinci olarak ise Zapret altyapısı üzerinden çalışan ve tüm internet sağlayıcılarında rahatça çalışan bir DPI sistemi. DPI sistemi çok gelişmiş hem global hem de türkiyeye yoğun olarak her türden profil içinde bulunmakta. Ayrıca profillerin çalıştıramaması veya tek tek denemek istemeyenler için network analiz bölgesi mevcut. Bu network analiz bölgesinde tüm profilleri internetinizde belirli targetlarda test ederek en iyi profili sizin için bulur. Whitelist yöntemiyle çalıştığı için hiçbir şekilde başka uygulamalarınızı veya oyunlarınıza etki etmez. Yüksek ram veya cpu yemez.

Herşey kontrol edilebilir ve gözlemlenebilir. Programı kullanıpta sorun yaşayan vb olursa bana bu konu altından bildirebilirler. Sorunları çözmeye ve geri bildirimlere göre güncelleme getirmeye özen göstereceğim.

Programı ilk açışınızda İngilizce, Rusça ve Türkçe dil seçenekleri arasında seçim yapıyorsunuz ve otomatik güncellemeyi açıp açmamak istediğiniz hakkında soru soruluyor. Yani otomatik güncellemeyi istediğiniz gibi devredışı bırakıp açabiliyorsunuz.# 🐺 BurnedWolf

> **Turkey-focused DPI bypass + Tor-routed Discord + system integrity checker for Windows.**
> Built with Electron · MIT licensed · v1.5.0

[🇬🇧 English](#english) · [🇹🇷 Türkçe](#türkçe) · [🇷🇺 Русский](#русский)

---

## English

### What is BurnedWolf?

BurnedWolf is a Windows desktop application that bundles three privacy/connectivity tools into a single themed interface:

| Module | What it does |
|---|---|
| **🛡️ DPI Shield** | 30+ tuned [zapret](https://github.com/bol-van/zapret) profiles for Türk Telekom, Vodafone, Superonline, TurkNet, Türksat, D-Smart, Kablonet and mobile carriers. Defeats Discord/YouTube/Roblox throttling and SNI inspection. |
| **💬 Proxy Discord** | A sandboxed Discord webview that routes all traffic through Tor — useful when the regular Discord client is throttled or blocked. Auto-grants media permissions so voice works. |
| **🔍 File Integrity** | SHA-256 verification against the original server build. Auto-repairs missing or tampered application files. |

### Highlights

- ✨ **Auto ISP detection** — public IP → ASN lookup → recommends the right profile
- 🎤 **Voice-aware** — every analysis run actually probes Discord's UDP voice path (STUN), not just HTTPS
- 🔄 **Auto-failover** — rotates profiles automatically when the current one stops working
- 📊 **Live health monitor** — rolling 10-minute connection-quality badge
- 🌍 **3 languages** — English / Türkçe / Русский, switches instantly across every window
- 🛡️ **Strong security baseline** — context isolation on every webview, credentials sealed with the OS keychain (`safeStorage`), PowerShell injection-safe path handling, SHA-256 file verification

### Screenshots

> _Coming soon. Add `docs/screenshots/` to the repo if you want hosted previews._

### System requirements

- Windows 10 or 11 (64-bit)
- Administrator privileges (required by the WinDivert driver that powers zapret)
- ~200 MB free disk
- Internet connection

### Building from source

```bash
# 1. Clone the repo
git clone https://github.com/iamnoobhasproject/burnedwolf-sourcecode.git
cd burnedwolf

# 2. Install dependencies
npm install

# 3. Drop the third-party binaries (NOT bundled in the repo, see below)
#    - tor-bin/tor.exe              → official Tor Browser bundle, "Tor" subfolder
#    - zapret-bin/winws.exe         → https://github.com/bol-van/zapret-win-bundle
#    - zapret-bin/WinDivert.dll
#    - zapret-bin/WinDivert64.sys
#    - zapret-bin/cygwin1.dll

# 4. Run in dev mode
npm start

# 5. Or produce a Windows installer
npm run dist        # → output to build/Burnedwolf Setup x.x.x.exe
```

> ⚠️ **Why aren't the binaries in the repo?** Antivirus engines flag the WinDivert kernel driver and Tor binaries. Including them in a public repo causes constant false-positive scans and breaks `git clone` for many users. Grab them from the upstream projects (links above) — they're already on GitHub.

### Project structure

```
burnedwolf/
├── i18n/                  → en.json / tr.json / ru.json translation dictionaries
├── renderer/              → main window UI (titlebar)
├── icon.png               → app icon
├── main.js                → Electron main process (DPI engine, IPC, updater, tray)
├── i18n.js                → tiny i18n helper used by every renderer
├── onboarding.html/.js    → first-launch language + auto-update wizard
├── updater.html/.js       → update-check screen
├── dpi.html/.js           → DPI Shield control panel
├── discord.html/.js       → Tor-routed Discord webview
├── verify.html/.js        → SHA-256 integrity checker
├── spotlight.html/.js     → global hotkey quick-launcher
├── exit-dialog.html/.js   → 2-second shutdown overlay
├── package.json
└── LICENSE / DISCLAIMER.md
```

### Contributing

Pull requests welcome — especially:

- 🌍 **Translations** (`i18n/<lang>.json` + button in titlebar / onboarding)
- 🛡️ **New DPI profiles** for ISPs not yet covered (Argentina, Iran, Belarus, ...)
- 🐛 **Bug fixes** and UX polish

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

### Legal / privacy

Please read [DISCLAIMER.md](DISCLAIMER.md) **before** using this software. Short version:

- Network filtering bypass tools are subject to local laws
- Use at your own risk
- The only trusted download URL is `https://github.com/iamnoobhasproject/burnedwolf/releases`

### Credits

- [bol-van/zapret](https://github.com/bol-van/zapret) — the DPI bypass engine that powers the Shield module
- [The Tor Project](https://www.torproject.org/) — anonymity network
- [Electron](https://www.electronjs.org/) — desktop runtime
- [Inter](https://rsms.me/inter/) & [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — typography

### License

MIT. See [LICENSE](LICENSE).

---

## Türkçe

### BurnedWolf nedir?

BurnedWolf, üç gizlilik/bağlantı aracını tek bir temalı arayüzde birleştiren Windows masaüstü uygulamasıdır:

| Modül | Ne yapar |
|---|---|
| **🛡️ DPI Kalkanı** | Türk Telekom, Vodafone, Superonline, TurkNet, Türksat, D-Smart, Kablonet ve mobil operatörler için ince ayarlanmış 30+ [zapret](https://github.com/bol-van/zapret) profili. Discord / YouTube / Roblox kısıtlamalarını ve SNI denetimini aşar. |
| **💬 Proxy Discord** | Tüm trafiği Tor üzerinden yönlendiren izole Discord webview'ı — normal Discord istemcisi yavaşken/engelliyken işe yarar. Mikrofon izinlerini otomatik verir, ses çalışır. |
| **🔍 Dosya Doğrulama** | Orijinal sunucu sürümüne karşı SHA-256 doğrulaması. Eksik veya değiştirilmiş uygulama dosyalarını otomatik onarır. |

### Öne çıkanlar

- ✨ **Otomatik ISS tespiti** — public IP → AS sorgusu → doğru profili önerir
- 🎤 **Ses farkındalığı** — her analizde sadece HTTPS değil, Discord ses UDP yolunu da STUN ile test eder
- 🔄 **Otomatik failover** — aktif profil çalışmaz olunca otomatik geçer
- 📊 **Canlı sağlık göstergesi** — 10 dakikalık bağlantı kalitesi rozeti
- 🌍 **3 dil** — İngilizce / Türkçe / Rusça, tüm pencerelerde anında değişir
- 🛡️ **Güçlü güvenlik temeli** — her webview'da context isolation, kimlik bilgileri OS keychain'de (`safeStorage`), PowerShell injection güvenli path işleme, SHA-256 dosya doğrulama

### Sistem gereksinimleri

- Windows 10 veya 11 (64-bit)
- Yönetici izni (zapret'in kullandığı WinDivert sürücüsü için gerekli)
- ~200 MB boş disk
- İnternet bağlantısı

### Kaynaktan derleme

```bash
git clone https://github.com/iamnoobhasproject/burnedwolf-sourcecode.git
cd burnedwolf
npm install
# Üçüncü taraf binary'leri ekle (yukarıdaki English bölümünde linkler)
npm start        # geliştirme modu
npm run dist     # Windows installer üret
```

### Katkı

Pull request'lere açığız — özellikle:

- 🌍 **Çeviriler** (yeni dil için `i18n/<dil>.json` + titlebar'a buton)
- 🛡️ **Yeni DPI profilleri** (henüz desteklenmeyen ISS'ler)
- 🐛 **Bug fix'ler** ve UX iyileştirmeleri

Detay için [CONTRIBUTING.md](CONTRIBUTING.md).

### Yasal / gizlilik

Kullanmadan **önce** [DISCLAIMER.md](DISCLAIMER.md) dosyasını oku. Kısaca:

- DPI bypass araçları yerel yasalara tabidir
- Kullanım sorumluluğu kullanıcıya aittir
- Tek güvenilir indirme adresi: `https://github.com/iamnoobhasproject/burnedwolf/releases`

### Lisans

MIT. Detay için [LICENSE](LICENSE).

---

## Русский

### Что такое BurnedWolf?

BurnedWolf — это десктопное приложение для Windows, которое объединяет три инструмента для приватности и связности в едином тематическом интерфейсе:

| Модуль | Что делает |
|---|---|
| **🛡️ DPI Щит** | 30+ настроенных профилей [zapret](https://github.com/bol-van/zapret) для турецких провайдеров. Преодолевает throttling и SNI инспекцию. |
| **💬 Прокси Discord** | Изолированный webview Discord, маршрутизирующий весь трафик через Tor — полезен, когда обычный клиент Discord замедлен или заблокирован. |
| **🔍 Целостность файлов** | Проверка SHA-256 относительно оригинальной серверной сборки. Автоматическое восстановление повреждённых файлов. |

### Особенности

- ✨ **Авто-определение провайдера** (по ASN)
- 🎤 **Учитывает голосовой канал** — тестирует UDP путь Discord через STUN
- 🔄 **Авто-переключение профилей** при сбое
- 📊 **Живой индикатор состояния** — 10-минутное скользящее окно
- 🌍 **3 языка** — English / Türkçe / Русский, мгновенное переключение
- 🛡️ **Сильная база безопасности** — изоляция контекста, учётные данные в keychain ОС, защита от PowerShell injection

### Системные требования

- Windows 10 или 11 (64-bit)
- Права администратора (для драйвера WinDivert)
- ~200 МБ свободного диска

### Сборка из исходников

```bash
git clone https://github.com/iamnoobhasproject/burnedwolf-sourcecode.git
cd burnedwolf
npm install
# Добавьте сторонние бинарники (ссылки в английском разделе)
npm start
npm run dist
```

### Лицензия

MIT. См. [LICENSE](LICENSE).

---

**v1.5.0** · Built with 🐺 in Türkiye
