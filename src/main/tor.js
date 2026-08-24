// ==========================================
// --- GHOST TOR CORE MANAGEMENT ---
// ==========================================
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ROOT } = require('./constants');
const { broadcastToAll } = require('./util/broadcast');
const { notify } = require('./notify');

let torProcess = null;
let isTorReady = false;
let activeTorPort = 9050;

ipcMain.on('start-tor', (event) => {
    if (isTorReady) {
        event.reply('tor-ready', activeTorPort);
        return;
    }
    if (torProcess) return;

    const torPath = path.join(ROOT, 'tor-bin', 'tor.exe').replace('app.asar', 'app.asar.unpacked');
    const dataPath = path.join(app.getPath('userData'), 'tor-data');

    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }

    torProcess = spawn(torPath, ['--SocksPort', activeTorPort.toString(), '--DataDirectory', dataPath], {
        windowsHide: true
    });

    torProcess.stdout.on('data', (data) => {
        const output = data.toString();
        broadcastToAll('tor-log', output);

        if (output.includes('Bootstrapped 100%')) {
            const wasReady = isTorReady;
            isTorReady = true;
            broadcastToAll('tor-ready', activeTorPort);
            if (!wasReady) notify('Tor Connected', `Encrypted circuit established on port ${activeTorPort}.`);
        }
    });
});

function getState() {
    return {
        ready: isTorReady,
        port:  activeTorPort,
        pid:   torProcess ? torProcess.pid : null
    };
}

// Synchronous quit-time cleanup (registered with quit.js).
function killSync() {
    try { if (torProcess) torProcess.kill('SIGKILL'); } catch (e) {}
}

module.exports = { getState, killSync };
