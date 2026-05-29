# Security Policy

## Supported versions

Security fixes are applied to the latest released version only.

| Version | Supported |
|---------|-----------|
| 1.6.x   | ✅        |
| < 1.5   | ❌        |

## Reporting a vulnerability

If you discover a security issue in BurnedWolf — credential leak, code execution path, privilege escalation, sandbox escape, etc. — **please report it privately first**.

### Where to send the report

- Open a **private GitHub Security Advisory** on the [iamnoobhasproject/burnedwolf](https://github.com/iamnoobhasproject/burnedwolf) repository
  → `Security` tab → `Report a vulnerability`
- Or email the maintainer directly (address listed on the GitHub profile)

### What to include

- Affected version
- Steps to reproduce (proof of concept welcome)
- Suggested fix if you have one
- Whether you'd like to be credited in the release notes

### What to expect

- Acknowledgement within **72 hours**
- An initial assessment within **7 days**
- A patched release as soon as a fix is verified, typically within **14 days** for confirmed issues

We follow responsible disclosure — please give us a reasonable window before going public.

## Scope

In scope:

- Code in this repository (`main.js`, renderer JS, IPC handlers, the i18n loader)
- The update mechanism (`updater.js` + the auto-update flow)
- Anything touching `settings.json`, `safeStorage`, the Discord webview, or the verify pipeline

Out of scope:

- Vulnerabilities in upstream `zapret`, `Tor`, or `Electron` — please report those to their maintainers
- Antivirus false positives (these are heuristic and we can't fix them on our end)
- Issues affecting only modified forks
- Social-engineering reports (phishing, impersonation) — those are a takedown matter, not a vulnerability

Thanks for keeping BurnedWolf users safe.
