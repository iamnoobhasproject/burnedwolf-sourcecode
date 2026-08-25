// ==========================================
// --- CONFIG BACKUP (export / import) ---
// ==========================================
// Lets the user back up, restore and share their setup as a single JSON file.
//
// SECURITY: a backup contains ONLY non-secret preferences (settings.json) plus
// the DPI whitelist. API keys live encrypted in ai_keys.bin and Discord
// credentials in the OS credential store — neither is in settings.json, so they
// are never in a backup by construction. A key-name filter (SENSITIVE) is kept
// as defence in depth against a future setting that stores something sensitive.
const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('./settings');
const hostlists = require('./zapret/hostlists');
const windows = require('./windows');
const { broadcastToAll } = require('./util/broadcast');
const { CURRENT_VERSION } = require('./constants');

const FORMAT = 'burnedwolf';
const TYPE = 'config-backup';

// Never written to / read from a backup, even if present.
const SENSITIVE = /(key|secret|token|password|credential|apikey)/i;
// Machine-/first-run-specific keys that shouldn't travel between installs.
const SKIP_KEYS = new Set(['onboarded', 'ai_open_on_first_run']);

function whitelistPath() {
    return path.join(hostlists.getZapretDataPath(), 'whitelist.txt');
}

function readWhitelist() {
    try { const p = whitelistPath(); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
    catch (e) { return ''; }
}

function exportableSettings() {
    const all = settings.readSettingsFile();
    const out = {};
    for (const [k, v] of Object.entries(all)) {
        if (SKIP_KEYS.has(k) || SENSITIVE.test(k)) continue;
        out[k] = v;
    }
    return out;
}

ipcMain.handle('config-export', async () => {
    const win = windows.getMainWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    let res;
    try {
        res = await dialog.showSaveDialog(win || undefined, {
            title: 'Export BurnedWolf configuration',
            defaultPath: `burnedwolf-config-${stamp}.json`,
            filters: [{ name: 'BurnedWolf config', extensions: ['json'] }]
        });
    } catch (e) { return { ok: false, error: 'dialog' }; }
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const payload = {
        app: FORMAT,
        type: TYPE,
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: CURRENT_VERSION,
        settings: exportableSettings(),
        whitelist: readWhitelist()
    };
    try {
        fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
        return { ok: true, path: res.filePath };
    } catch (e) {
        return { ok: false, error: 'write', detail: e.message };
    }
});

ipcMain.handle('config-import', async () => {
    const win = windows.getMainWindow();
    let res;
    try {
        res = await dialog.showOpenDialog(win || undefined, {
            title: 'Import BurnedWolf configuration',
            properties: ['openFile'],
            filters: [{ name: 'BurnedWolf config', extensions: ['json'] }]
        });
    } catch (e) { return { ok: false, error: 'dialog' }; }
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8').replace(/^﻿/, ''));
    } catch (e) {
        return { ok: false, error: 'parse' };
    }
    if (!parsed || parsed.app !== FORMAT || parsed.type !== TYPE) {
        return { ok: false, error: 'invalid' };
    }

    // MERGE settings — imported keys win, existing keys we don't see stay put.
    // This is the least destructive behaviour and never wipes secrets (which
    // aren't in settings.json anyway).
    const current = settings.readSettingsFile();
    let applied = 0;
    if (parsed.settings && typeof parsed.settings === 'object') {
        for (const [k, v] of Object.entries(parsed.settings)) {
            if (SKIP_KEYS.has(k) || SENSITIVE.test(k)) continue;
            current[k] = v;
            applied++;
        }
        settings.writeSettingsFile(current);
    }

    // Whitelist — replace with the imported list if the backup carried one.
    let whitelistApplied = false;
    if (typeof parsed.whitelist === 'string') {
        try {
            const p = whitelistPath();
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cleaned = parsed.whitelist.split('\n').map(d => d.trim()).filter(Boolean).join('\n');
            fs.writeFileSync(p, cleaned, 'utf8');
            whitelistApplied = true;
            broadcastToAll('whitelist-data', cleaned);
        } catch (e) { /* ignore — settings still applied */ }
    }

    // Instant UI refresh: repaint language, then tell renderers to re-pull toggles.
    if (typeof current.language === 'string') broadcastToAll('language-changed', current.language);
    broadcastToAll('config-imported', { applied, whitelist: whitelistApplied });

    return { ok: true, applied, whitelist: whitelistApplied };
});

// ==========================================
// --- DPI PROFILE export / import (community sharing) ---
// ==========================================
// A single user-built profile is just { name, args:[...] }. These handlers write
// / read one to a shareable JSON file. args must be an array of strings — nothing
// is executed here; the file only ever feeds winws.exe flags at spawn time.
const PROFILE_TYPE = 'dpi-profile';

ipcMain.handle('profile-export', async (event, profile) => {
    const win = windows.getMainWindow();
    const p = profile || {};
    if (!Array.isArray(p.args)) return { ok: false, error: 'bad_profile' };
    const safeName = String(p.name || 'profile').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'profile';
    let res;
    try {
        res = await dialog.showSaveDialog(win || undefined, {
            title: 'Export DPI profile',
            defaultPath: `bw-profile-${safeName}.json`,
            filters: [{ name: 'BurnedWolf profile', extensions: ['json'] }]
        });
    } catch (e) { return { ok: false, error: 'dialog' }; }
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const payload = {
        app: FORMAT,
        type: PROFILE_TYPE,
        version: 1,
        exportedAt: new Date().toISOString(),
        name: String(p.name || 'Custom'),
        args: p.args.map(a => String(a))
    };
    try {
        fs.writeFileSync(res.filePath, JSON.stringify(payload, null, 2), 'utf8');
        return { ok: true, path: res.filePath };
    } catch (e) { return { ok: false, error: 'write', detail: e.message }; }
});

ipcMain.handle('profile-import', async () => {
    const win = windows.getMainWindow();
    let res;
    try {
        res = await dialog.showOpenDialog(win || undefined, {
            title: 'Import DPI profile',
            properties: ['openFile'],
            filters: [{ name: 'BurnedWolf profile', extensions: ['json'] }]
        });
    } catch (e) { return { ok: false, error: 'dialog' }; }
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };

    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8').replace(/^﻿/, '')); }
    catch (e) { return { ok: false, error: 'parse' }; }

    if (!parsed || parsed.app !== FORMAT || parsed.type !== PROFILE_TYPE || !Array.isArray(parsed.args)) {
        return { ok: false, error: 'invalid' };
    }
    // Only keep string tokens — a profile is winws flags, nothing else.
    const args = parsed.args.map(a => String(a)).filter(a => a.trim().length > 0);
    return { ok: true, name: String(parsed.name || 'Imported'), args };
});

module.exports = {};
