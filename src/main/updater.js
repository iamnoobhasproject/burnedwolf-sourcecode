// ==========================================
// --- UPDATER PROTOCOLS ---
// ==========================================
// Handshake order matters: 'check-update' parses version.json and swaps
// UPDATE_URL for the real archive URL; only then may 'start-download' run.
// Both the standalone updater window and the spotlight quick-update use the
// same channels (spotlight runs check-update first for exactly this reason).
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { CURRENT_VERSION, UPDATE_MANIFEST_URL } = require('./constants');
const { runExpandArchive } = require('./util/exec');
const windows = require('./windows');
const { notify } = require('./notify');
const { readSettingsFile } = require('./settings');
const { broadcastToAll } = require('./util/broadcast');

let UPDATE_URL = UPDATE_MANIFEST_URL;

// Latest known-available update discovered by any check (the launch updater
// window, a manual "check now", or the background timer). null when up to date
// or unknown. Shape: { current, new, zipUrl }.
let pendingUpdate = null;
// Remember which version we already toasted about so the periodic re-check
// doesn't re-notify every cycle for the same release.
let lastNotifiedVersion = null;

// --- CORE VERSION CHECK ---
// The single source of truth for "is there a newer build?". Fetches version.json
// and compares to CURRENT_VERSION. Resolves (never rejects) to one of:
//   { state: 'update',  current, new, zipUrl }
//   { state: 'current', current }
//   { state: 'error',   error }
// Side effect on 'update': sets UPDATE_URL + pendingUpdate so the EXISTING
// download pipeline ('start-download') and the tray/settings surfaces can act on
// it without any extra plumbing.
function checkForUpdate() {
    return new Promise((resolve) => {
        const timestamp = Date.now();
        const options = {
            hostname: 'raw.githubusercontent.com',
            port: 443,
            path: `/iamnoobhasproject/app-updates/main/version.json?t=${timestamp}`,
            method: 'GET',
            timeout: 10000,
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'User-Agent': 'Mozilla/5.0'
            }
        };

        const req = https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const serverData = JSON.parse(data);
                    if (serverData.version && serverData.version !== CURRENT_VERSION) {
                        UPDATE_URL = serverData.zipUrl;
                        pendingUpdate = { current: CURRENT_VERSION, new: serverData.version, zipUrl: serverData.zipUrl };
                        resolve({ state: 'update', current: CURRENT_VERSION, new: serverData.version, zipUrl: serverData.zipUrl });
                    } else {
                        pendingUpdate = null;
                        resolve({ state: 'current', current: CURRENT_VERSION });
                    }
                } catch (err) {
                    resolve({ state: 'error', error: 'parse' });
                }
            });
        });
        req.on('error', () => resolve({ state: 'error', error: 'network' }));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ state: 'error', error: 'timeout' }); });
    });
}

// Existing foreground channel used by updater.html — replies are byte-for-byte
// what they always were, so the launch updater window is untouched.
ipcMain.on('check-update', async (event) => {
    const r = await checkForUpdate();
    if (r.state === 'update') {
        event.reply('update-available', { current: r.current, new: r.new });
    } else if (r.state === 'current') {
        event.reply('up-to-date');
    } else {
        event.reply('server-error');
    }
});

// Settings "check now" — returns the structured result to the renderer and
// keeps the tray in sync with whatever the check found.
ipcMain.handle('check-update-now', async () => {
    const r = await checkForUpdate();
    try { windows.refreshUpdateTray(pendingUpdate); } catch (e) {}
    return r;
});

// Open the existing updater window on demand (tray item / settings "install
// now" / notification click). Reuses the whole tested download→apply flow.
ipcMain.on('open-updater-window', () => {
    try { windows.createUpdaterWindow(); } catch (e) {}
});

// --- BACKGROUND UPDATE CHECKER ---
// The launch updater window only runs once. BurnedWolf lives in the tray for
// days at a time, so a long-lived session would never learn about a new build.
// This timer closes that gap: it re-checks quietly and, on a newly-seen
// version, toasts once, lights up the tray, and tells renderers so Settings can
// badge. It never downloads on its own — the user still decides when to install.
let bgTimer = null;
const BG_FIRST_DELAY_MS = 3 * 60 * 1000;      // first quiet check ~3 min after launch
const BG_INTERVAL_MS    = 6 * 60 * 60 * 1000; // then every 6 hours

async function runBackgroundCheck() {
    // Respect the same preference the launch flow honours.
    let autoUpdate = true;
    try { if (readSettingsFile().auto_update === false) autoUpdate = false; } catch (e) {}
    if (!autoUpdate) return;

    const r = await checkForUpdate();
    if (r.state !== 'update') return;

    try { windows.refreshUpdateTray(pendingUpdate); } catch (e) {}
    broadcastToAll('update-available-bg', { current: r.current, new: r.new });

    if (lastNotifiedVersion !== r.new) {
        lastNotifiedVersion = r.new;
        notify('Update available', `Version ${r.new} is ready to install. Open BurnedWolf to update.`);
    }
}

function startBackgroundUpdateChecks() {
    if (bgTimer) return; // idempotent — safe if called more than once
    setTimeout(() => {
        runBackgroundCheck();
        bgTimer = setInterval(runBackgroundCheck, BG_INTERVAL_MS);
    }, BG_FIRST_DELAY_MS);
}

ipcMain.on('proceed-to-splash', () => {
    const updaterWindow = windows.getUpdaterWindow();
    if (updaterWindow) updaterWindow.close();
    windows.createMainWindow();
});

ipcMain.on('start-download', (event) => {
    const rootDir = process.execPath.includes('node_modules') ? process.cwd() : path.dirname(process.execPath);
    const zipPath = path.join(rootDir, 'update.zip');
    const extractPath = path.join(rootDir, 'update_temp');
    const file = fs.createWriteStream(zipPath);

    https.get(UPDATE_URL, (response) => {
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            const percent = Math.round((downloadedSize / totalSize) * 100);
            event.reply('download-progress', percent);
        });

        response.pipe(file);

        file.on('finish', () => {
            file.close();
            event.reply('extracting');

            runExpandArchive(zipPath, extractPath, () => {
                event.reply('extraction-done');
            });
        });
    });
});

ipcMain.on('apply-update', () => {
    const rootDir = process.execPath.includes('node_modules') ? process.cwd() : path.dirname(process.execPath);
    const exePath = process.execPath;
    const batPath = path.join(rootDir, 'update_system.bat');
    const vbsPath = path.join(rootDir, 'update_hidden.vbs');
    const zipPath = path.join(rootDir, 'update.zip');
    const extractPath = path.join(rootDir, 'update_temp');

    const batContent = `
@echo off
ping 127.0.0.1 -n 3 > nul
xcopy /y /s /e "${extractPath}\\*" "${rootDir}\\" /i /c /q
if exist "${extractPath}\\app.asar" (
    copy /y "${extractPath}\\app.asar" "${rootDir}\\resources\\app.asar"
)
rmdir /s /q "${extractPath}"
del /f /q "${zipPath}"
start "" /D "${rootDir}" "${exePath}"
del /f /q "${vbsPath}"
(goto) 2>nul & del "%~f0"
`;
    const vbsContent = `CreateObject("WScript.Shell").Run """" & WScript.Arguments(0) & """", 0, False`;

    fs.writeFileSync(batPath, batContent, 'utf8');
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');

    const subprocess = spawn('wscript.exe', [vbsPath, batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: rootDir
    });
    subprocess.unref();

    app.isQuiting = true;
    app.quit();
});

module.exports = {
    checkForUpdate,
    startBackgroundUpdateChecks,
    getPendingUpdate: () => pendingUpdate
};
