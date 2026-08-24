// ==========================================
// --- GUARANTEED FULL SHUTDOWN ---
// ==========================================
// Quitting must do two things, unconditionally: (a) close EVERY BurnedWolf window
// — not just the main one — and (b) put the system DNS back exactly how the user
// had it. Both used to hang off app's 'will-quit'. The trap: 'will-quit' only
// fires after every window has agreed to close, and a single window can veto that
// (the Discord webview's beforeunload, or a modal dialog). When that happened
// `app.quit()` quietly aborted — DPI/Discord stayed open in the background AND the
// DNS revert never ran, stranding the user on a dead 127.0.0.1 resolver with no
// internet. So we now run cleanup explicitly and destroy() every window. destroy()
// bypasses any close/beforeunload veto, making the quit impossible to cancel.
//
// Engines (Tor, Zapret, DNS) register their synchronous cleanup here via
// registerQuitTask() — quit.js itself knows nothing about them, which keeps the
// shutdown path decoupled from every engine's internals. Registration order in
// index.js preserves the original cleanup order (tor → zapret → dns).
const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const { execSync } = require('child_process');
const windows = require('./windows');

const quitTasks = [];

function registerQuitTask(fn) {
    quitTasks.push(fn);
}

let quitCleanupDone = false;
function runQuitCleanup() {
    if (quitCleanupDone) return;     // idempotent: safe to call from quit AND will-quit
    quitCleanupDone = true;
    for (const task of quitTasks) {
        try { task(); } catch (e) {}
    }
    try { globalShortcut.unregisterAll(); } catch (e) {}
    // Turn the system proxy flag back off (DPI/Tor may have enabled it).
    try {
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f', { windowsHide: true, timeout: 5000 });
    } catch (e) {}
}

// The one true way to quit BurnedWolf: clean up, force every window shut, exit.
function performFullQuit() {
    app.isQuiting = true;
    runQuitCleanup();
    windows.destroyTray();
    // destroy() (not close()) releases any window that was vetoing the quit.
    BrowserWindow.getAllWindows().forEach(w => {
        try { if (!w.isDestroyed()) w.destroy(); } catch (e) {}
    });
    app.quit();
    // Hard-exit fallback: if some native handle still lingers, leave anyway so the
    // user never sees a phantom background process.
    setTimeout(() => { try { app.exit(0); } catch (e) {} }, 1200);
}

ipcMain.on('exit-yes', () => { performFullQuit(); });
ipcMain.on('exit-app', () => { performFullQuit(); });

module.exports = { registerQuitTask, runQuitCleanup, performFullQuit };
