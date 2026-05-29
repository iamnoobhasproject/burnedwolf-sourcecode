# Contributing to BurnedWolf

Thanks for your interest! BurnedWolf is a community-friendly project — translation fixes, new DPI profiles, and bug reports are all welcome.

## Quick start

```bash
git clone https://github.com/iamnoobhasproject/burnedwolf.git
cd burnedwolf
npm install
# Drop tor-bin/ and zapret-bin/ binaries (see README.md)
npm start
```

## What to contribute

### 🌍 Translations

The easiest first contribution. Each language is a single JSON file under `i18n/`:

1. Copy `i18n/en.json` to `i18n/<your-lang>.json` (e.g. `de.json` for German)
2. Translate every value (keep keys as-is)
3. Add a button in two places:
   - `onboarding.html` → `.lang-grid` section
   - `renderer/titlebar.html` → `.lang-picker` section
4. Open a Pull Request

Already supported: 🇬🇧 English · 🇹🇷 Turkish · 🇷🇺 Russian
High-value next targets: 🇩🇪 German · 🇫🇷 French · 🇮🇷 Persian · 🇪🇸 Spanish · 🇨🇳 Chinese

### 🛡️ DPI profiles

If your ISP isn't covered or the existing profile is suboptimal:

1. Open `main.js`, find `ZAPRET_PROFILES`
2. Add an entry with a meaningful ID (`tr_yourisp_descriptor`)
3. Add a `PROFILE_META` entry with label + region
4. If your country isn't yet in `ASN_PROFILE_MAP`, look up the ASN(s) and add an entry
5. Test with `Quick Scan` in the Network Analysis tab
6. Open a PR with a short note: which ISP, which AS Number, what DPI behavior you observed

### 🐛 Bug reports

Open an issue with:

- BurnedWolf version (`Settings → Current build`)
- Your ISP (helps narrow down DPI-specific bugs)
- Steps to reproduce
- Screenshot of the terminal log if it's a DPI issue (`DPI → Dashboard → terminal area`)

### 🎨 UI / theme

We keep the UI deliberately minimal — purple accent on near-black. Avoid:

- Heavy gradients, glow shadows, animated shimmer
- AI-vibe ambient radial backgrounds
- Excessive border-radius (cap at 10px for cards, 6px for inputs/buttons)

## Pull request checklist

- [ ] `npm start` runs without console errors
- [ ] No personal information committed (paths, IPs, credentials)
- [ ] All three language JSONs updated if you added a new UI string
- [ ] `node --check <file>` passes for any edited `.js`
- [ ] If you added a setting, it persists via `settings.json` (not localStorage)

## Code style

- 4-space indent
- Comments in English (so we can review faster)
- Prefer `const` and arrow functions
- IPC handler names use kebab-case (`open-dpi-window`)

## What we don't accept

- ❌ Closed-source binaries
- ❌ Analytics/telemetry that phones home
- ❌ Forced login / authentication walls
- ❌ Anything that modifies user files outside the app's `userData` directory
- ❌ DDoS, scraping, or any module that targets specific third parties offensively

## Security

If you find a security vulnerability, please **don't** open a public issue. Instead, follow the disclosure process described in `SECURITY.md` (or email the maintainer privately if `SECURITY.md` is missing).

---

Happy hacking! 🐺
