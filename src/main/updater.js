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

let UPDATE_URL = UPDATE_MANIFEST_URL;

ipcMain.on('check-update', (event) => {
    const timestamp = Date.now();
    const options = {
        hostname: 'raw.githubusercontent.com',
        port: 443,
        path: `/iamnoobhasproject/app-updates/main/version.json?t=${timestamp}`,
        method: 'GET',
        headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'User-Agent': 'Mozilla/5.0'
        }
    };

    https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
            try {
                const serverData = JSON.parse(data);
                if (serverData.version !== CURRENT_VERSION) {
                    UPDATE_URL = serverData.zipUrl;
                    event.reply('update-available', { current: CURRENT_VERSION, new: serverData.version });
                } else {
                    event.reply('up-to-date');
                }
            } catch (err) {
                event.reply('server-error');
            }
        });
    }).on('error', () => {
        event.reply('server-error');
    });
});

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
