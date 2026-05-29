// Shared i18n helper for every renderer.
// Usage:
//   const i18n = require('./i18n');
//   await i18n.init();        // reads language from main settings.json + paints DOM
//   i18n.t('titlebar.welcome');
//   i18n.applyToDom();        // re-paint after dynamic DOM changes
//
// Markup conventions (see HTML files):
//   <h1 data-i18n="titlebar.welcome"></h1>           ← textContent
//   <input data-i18n-placeholder="search">           ← placeholder
//   <button data-i18n-title="tooltip.x">btn</button> ← title
//   <span data-i18n="updater.restart_in" data-i18n-args='{"n":5}'></span>
//
// Live updates:
//   The main process broadcasts a `language-changed` IPC when any window
//   toggles the language. Every renderer that has called init() will refresh
//   automatically — no manual subscription needed.

const fs   = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

let currentLang  = 'en';
let translations = {};
const fallback   = {};  // English copy so missing keys still render
let fallbackLoaded = false;

function loadFallback() {
    if (fallbackLoaded) return;
    try {
        const file = path.join(__dirname, 'i18n', 'en.json');
        Object.assign(fallback, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) { /* ignore — keys will just echo */ }
    fallbackLoaded = true;
}

function loadLang(lang) {
    loadFallback();
    try {
        const file = path.join(__dirname, 'i18n', `${lang}.json`);
        translations = JSON.parse(fs.readFileSync(file, 'utf8'));
        currentLang = lang;
    } catch (e) {
        // Fall back to English when the requested language can't be read
        translations = { ...fallback };
        currentLang = 'en';
    }
}

function t(key, args) {
    let val = translations[key];
    if (val === undefined) val = fallback[key];
    if (val === undefined) val = key;
    if (args && typeof val === 'string') {
        for (const [k, v] of Object.entries(args)) {
            val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
    }
    return val;
}

function applyToDom() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        let args;
        if (el.dataset.i18nArgs) {
            try { args = JSON.parse(el.dataset.i18nArgs); } catch (e) {}
        }
        el.textContent = t(key, args);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.dataset.i18nHtml;
        el.innerHTML = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
    });
}

async function init() {
    let lang = 'en';
    try {
        const stored = await ipcRenderer.invoke('settings-get', 'language');
        if (stored && typeof stored === 'string') lang = stored;
    } catch (e) {}
    loadLang(lang);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyToDom);
    } else {
        applyToDom();
    }
}

// Live broadcast — every window updates its own DOM when language changes
ipcRenderer.on('language-changed', (event, lang) => {
    loadLang(lang);
    applyToDom();
});

function getLang() { return currentLang; }

module.exports = { init, t, loadLang, applyToDom, getLang };
