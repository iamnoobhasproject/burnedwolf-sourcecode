// ==========================================
// --- GHOST TOR CORE MANAGEMENT ---
// ==========================================
// Owns tor.exe. Normally Tor connects directly; when the user enables pluggable
// transports (obfs4 / snowflake) it launches Tor with UseBridges + a
// ClientTransportPlugin pointing at the transport binary in tor-bin/, plus the
// user's pasted Bridge lines. With bridges disabled (the default) the launch is
// byte-for-byte what it always was.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ROOT } = require('./constants');
const { broadcastToAll } = require('./util/broadcast');
const { notify } = require('./notify');
const { readSettingsFile, writeSettingsFile } = require('./settings');

let torProcess = null;
let isTorReady = false;
let activeTorPort = 9050;

// tor-bin resolves to app.asar.unpacked at runtime (asarUnpack in package.json).
function binDir() { return path.join(ROOT, 'tor-bin').replace('app.asar', 'app.asar.unpacked'); }
function torExePath() { return path.join(binDir(), 'tor.exe'); }

function resolvePt(names) {
    for (const n of names) {
        const p = path.join(binDir(), n);
        try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
    return null;
}
// obfs4proxy was renamed to "lyrebird" upstream — accept either filename so the
// user can drop in whichever their Tor Browser shipped without renaming it.
function obfs4Exe() { return resolvePt(['obfs4proxy.exe', 'lyrebird.exe']); }
function snowflakeExe() { return resolvePt(['snowflake-client.exe', 'snowflake.exe']); }

function dataDir() {
    const d = path.join(app.getPath('userData'), 'tor-data');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

// Build the tor.exe argv. Bridges are appended only when explicitly enabled AND
// the chosen transport binary is present, so a misconfiguration can never stop
// Tor from starting — it just falls back to a direct connection.
function buildTorArgs() {
    const args = ['--SocksPort', activeTorPort.toString(), '--DataDirectory', dataDir()];
    try {
        const s = readSettingsFile();
        if (s.tor_bridges_enabled === true) {
            const transport = s.tor_transport === 'snowflake' ? 'snowflake' : 'obfs4';
            const exe = transport === 'snowflake' ? snowflakeExe() : obfs4Exe();
            const lines = String(s.tor_bridge_lines || '').split('\n').map(l => l.trim()).filter(Boolean);
            if (!exe) {
                broadcastToAll('tor-log', `[BRIDGES] ${transport} binary not found in tor-bin — starting WITHOUT bridges.`);
            } else if (!lines.length) {
                broadcastToAll('tor-log', '[BRIDGES] No bridge lines set — starting WITHOUT bridges.');
            } else {
                args.push('--UseBridges', '1');
                args.push('--ClientTransportPlugin', `${transport} exec ${exe}`);
                for (const line of lines) args.push('--Bridge', line.replace(/^Bridge\s+/i, ''));
                broadcastToAll('tor-log', `[BRIDGES] Using ${transport} with ${lines.length} bridge line(s).`);
            }
        }
    } catch (e) { /* fall back to direct */ }
    return args;
}

function spawnTor() {
    if (torProcess) return;
    if (!fs.existsSync(torExePath())) {
        broadcastToAll('tor-log', '[FATAL] tor.exe not found in tor-bin.');
        return;
    }
    torProcess = spawn(torExePath(), buildTorArgs(), { windowsHide: true });

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
    torProcess.on('close', () => { isTorReady = false; torProcess = null; });
}

ipcMain.on('start-tor', (event) => {
    if (isTorReady) {
        event.reply('tor-ready', activeTorPort);
        return;
    }
    if (torProcess) return;
    spawnTor();
});

// Kill and relaunch Tor so a new bridge configuration takes effect.
function restartTor() {
    try {
        if (torProcess) { torProcess.removeAllListeners('close'); torProcess.kill('SIGKILL'); }
    } catch (e) {}
    torProcess = null;
    isTorReady = false;
    broadcastToAll('tor-log', '[BRIDGES] Restarting Tor to apply configuration…');
    setTimeout(spawnTor, 800);
}

function bridgeStatus() {
    const s = (() => { try { return readSettingsFile(); } catch (e) { return {}; } })();
    return {
        enabled: s.tor_bridges_enabled === true,
        transport: s.tor_transport === 'snowflake' ? 'snowflake' : 'obfs4',
        lines: String(s.tor_bridge_lines || ''),
        obfs4Available: !!obfs4Exe(),
        snowflakeAvailable: !!snowflakeExe(),
        torReady: isTorReady,
        torRunning: !!torProcess
    };
}

ipcMain.handle('tor-bridge-config', () => bridgeStatus());

ipcMain.handle('tor-bridge-save', (event, cfg) => {
    const c = cfg || {};
    const s = readSettingsFile();
    if (typeof c.enabled === 'boolean') s.tor_bridges_enabled = c.enabled;
    if (c.transport === 'obfs4' || c.transport === 'snowflake') s.tor_transport = c.transport;
    if (typeof c.lines === 'string') s.tor_bridge_lines = c.lines;
    writeSettingsFile(s);
    return bridgeStatus();
});

ipcMain.handle('tor-restart', () => { restartTor(); return bridgeStatus(); });

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

module.exports = { getState, killSync, buildTorArgs, bridgeStatus };
