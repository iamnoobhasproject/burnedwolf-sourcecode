// --- PERSISTENT SETTINGS (settings.json) ---
// localStorage is unreliable for file:// origin renderers in Electron — the
// browser sometimes treats them as opaque/ephemeral. To keep simple key/value
// preferences (autostart toggle, spotlight hotkey, etc.) reliably persisted
// across launches, we store them in <userData>/settings.json via IPC.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { broadcastToAll } = require('./util/broadcast');

function getSettingsPath() {
    return path.join(app.getPath('userData'), 'settings.json');
}

function readSettingsFile() {
    try {
        const p = getSettingsPath();
        // Strip a UTF-8 BOM if an external editor (Notepad, PowerShell) added one,
        // otherwise JSON.parse throws on the leading ﻿ and all settings reset.
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
        console.warn('settings read failed:', e.message);
    }
    return {};
}

function writeSettingsFile(data) {
    try {
        const p = getSettingsPath();
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.warn('settings write failed:', e.message);
        return false;
    }
}

ipcMain.handle('settings-get', (event, key) => {
    const all = readSettingsFile();
    return key ? all[key] : all;
});

ipcMain.handle('settings-set', (event, key, value) => {
    const all = readSettingsFile();
    all[key] = value;
    const ok = writeSettingsFile(all);
    // When the language preference changes, push it to every open renderer
    // so they can re-paint their DOM instantly without a restart.
    if (ok && key === 'language' && typeof value === 'string') {
        broadcastToAll('language-changed', value);
    }
    return ok;
});

module.exports = { readSettingsFile, writeSettingsFile };
