// --- SECURE CREDENTIAL STORAGE (Discord, etc.) ---
// Uses Electron safeStorage which delegates to the OS keychain (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). Replaces plaintext localStorage.
const { app, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const credsStorePath = () => path.join(app.getPath('userData'), 'secure_creds.bin');

ipcMain.handle('creds-save', async (event, key, payload) => {
    try {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' };
        const store = (() => {
            try {
                if (fs.existsSync(credsStorePath())) {
                    const raw = fs.readFileSync(credsStorePath());
                    const dec = safeStorage.decryptString(raw);
                    return JSON.parse(dec);
                }
            } catch (e) {}
            return {};
        })();
        store[key] = payload;
        const encrypted = safeStorage.encryptString(JSON.stringify(store));
        fs.writeFileSync(credsStorePath(), encrypted);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('creds-load', async (event, key) => {
    try {
        if (!fs.existsSync(credsStorePath())) return { ok: true, data: null };
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' };
        const raw = fs.readFileSync(credsStorePath());
        const dec = safeStorage.decryptString(raw);
        const store = JSON.parse(dec);
        return { ok: true, data: store[key] || null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('creds-delete', async (event, key) => {
    try {
        if (!fs.existsSync(credsStorePath())) return { ok: true };
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' };
        const raw = fs.readFileSync(credsStorePath());
        const dec = safeStorage.decryptString(raw);
        const store = JSON.parse(dec);
        delete store[key];
        const encrypted = safeStorage.encryptString(JSON.stringify(store));
        fs.writeFileSync(credsStorePath(), encrypted);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});
