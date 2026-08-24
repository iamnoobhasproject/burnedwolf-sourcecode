// ==========================================
// --- ZAPRET (DPI) ENGINE ---
// ==========================================
// Owns the winws.exe process plus the two monitors attached to it:
//   - health monitor: rolling 10-minute probe history for the UI badge
//   - failover: rotates through ISP-recommended profiles after repeated
//     probe failures (state lives here so the DPI window can close without
//     interrupting the loop)
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { broadcastToAll } = require('../util/broadcast');
const { notify } = require('../notify');
const { readSettingsFile } = require('../settings');
const { WINWS_EXE } = require('./paths');
const { ZAPRET_PROFILES, applyGlobalProfileFlags } = require('./profiles');
const hostlists = require('./hostlists');
const isp = require('../isp');
const tor = require('../tor');

// --- CORE STATE ---
let zapretProcess = null;
let isZapretRunning = false;
let currentZapretMode = null;       // remember the active profile so reopened windows can show it
let currentZapretWhitelist = '';    // cached whitelist text so failover restarts keep it

function broadcastZapretLog(msg) {
    broadcastToAll('zapret-log', msg);
}

// --- ENGINE HEALTH MONITORING ---
// Tracks the last 10 minutes of connectivity probes against Discord so the UI
// can render a "Health: 95% • 19/20 probes" badge. Probes are shared with the
// failover loop when it's running; otherwise a dedicated 60s timer drives them.
const HEALTH_WINDOW_MS  = 10 * 60 * 1000;   // rolling 10 minutes
const HEALTH_PROBE_INTERVAL_MS = 60 * 1000; // when failover is OFF
let healthHistory = [];                     // [{ ts, ok }]
let healthTimer = null;                     // dedicated monitor timer when failover off

function recordHealthProbe(ok) {
    const now = Date.now();
    healthHistory.push({ ts: now, ok: !!ok });
    // Drop samples older than the window
    const cutoff = now - HEALTH_WINDOW_MS;
    while (healthHistory.length && healthHistory[0].ts < cutoff) healthHistory.shift();
}

function computeHealthStats() {
    const now = Date.now();
    const cutoff = now - HEALTH_WINDOW_MS;
    const samples = healthHistory.filter(s => s.ts >= cutoff);
    if (samples.length === 0) {
        return { samples: 0, ok: 0, fail: 0, percent: null, trend: 'unknown' };
    }
    const ok = samples.filter(s => s.ok).length;
    const fail = samples.length - ok;
    const percent = Math.round((ok / samples.length) * 100);

    // Trend = compare second half vs first half of the window
    let trend = 'stable';
    if (samples.length >= 6) {
        const mid = Math.floor(samples.length / 2);
        const first = samples.slice(0, mid);
        const second = samples.slice(mid);
        const firstRate  = first.filter(s => s.ok).length  / first.length;
        const secondRate = second.filter(s => s.ok).length / second.length;
        const diff = secondRate - firstRate;
        if (diff > 0.15)  trend = 'improving';
        else if (diff < -0.15) trend = 'degrading';
    }
    return { samples: samples.length, ok, fail, percent, trend };
}

function startDedicatedHealthMonitor() {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(async () => {
        // Stop if the engine has been turned off OR failover took over probing
        if (!isZapretRunning) { stopDedicatedHealthMonitor(); return; }
        if (failoverEnabled)  { return; /* failover is feeding the history */ }
        try {
            const ok = await failoverHealthProbe();
            recordHealthProbe(ok);
        } catch (e) { /* ignore */ }
    }, HEALTH_PROBE_INTERVAL_MS);
}

function stopDedicatedHealthMonitor() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

function getHealth() {
    const stats = computeHealthStats();
    return {
        engineRunning: isZapretRunning,
        currentMode:   currentZapretMode,
        ...stats
    };
}
ipcMain.handle('get-engine-health', () => getHealth());

// --- ENGINE STATUS QUERY ---
// Renderers that get reopened (DPI) need to know the current backend
// state to render correct UI. Without this they'd default to "stopped" while
// the underlying process is actually still running in main.
ipcMain.handle('query-engine-status', () => {
    const torState = tor.getState();
    return {
        zapret: {
            running: isZapretRunning && zapretProcess !== null,
            mode:    currentZapretMode
        },
        tor: {
            ready: torState.ready,
            port:  torState.port
        }
    };
});

// --- FAILOVER CHAIN STATE ---
// When auto-failover is on, the engine watches its own connectivity and
// automatically rotates to the next recommended profile (from the ISP's
// ASN_PROFILE_MAP chain) after 3 consecutive failed probes.
let failoverEnabled        = false;
let failoverChain          = [];   // array of profile ids, ordered strongest -> weakest
let failoverCurrentIndex   = 0;
let failoverFailCount      = 0;
let failoverTimer          = null;
const FAILOVER_PROBE_INTERVAL_MS = 30000;
const FAILOVER_FAIL_THRESHOLD    = 3;

// --- FAILOVER MONITORING ---
// Probe consists of two parts so the failover can catch BOTH common breakage
// modes for Discord: HTTPS reset on the gateway (TCP) and voice UDP drop
// (STUN). A profile is healthy only if both succeed — otherwise we'd never
// rotate when login works but voice "Starting..." hangs.
function failoverHealthProbe() {
    const tcpCheck = new Promise((resolve) => {
        const req = https.get({
            hostname: 'discord.com', port: 443, path: '/', timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
        }, (res) => { res.destroy(); resolve(true); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(false); });
    });

    const udpCheck = new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const stunRequest = Buffer.alloc(20);
        stunRequest.writeUInt16BE(0x0001, 0);
        stunRequest.writeUInt16BE(0x0000, 2);
        stunRequest.writeUInt32BE(0x2112A442, 4);
        crypto.randomBytes(12).copy(stunRequest, 8);

        let done = false;
        const finish = (ok) => {
            if (done) return; done = true;
            try { socket.close(); } catch (e) {}
            resolve(ok);
        };
        socket.once('message', () => finish(true));
        socket.on('error', () => finish(false));
        const srcPort = 50000 + Math.floor(Math.random() * 14999);
        try {
            socket.bind(srcPort, () => {
                socket.send(stunRequest, 19302, 'stun.l.google.com', (err) => { if (err) finish(false); });
            });
        } catch (e) { finish(false); }
        setTimeout(() => finish(false), 3500);
    });

    return Promise.all([tcpCheck, udpCheck]).then(([tcp, udp]) => tcp && udp);
}

function stopFailoverMonitor() {
    if (failoverTimer) { clearInterval(failoverTimer); failoverTimer = null; }
    failoverFailCount = 0;
}

async function rotateToNextProfile() {
    const nextIndex = failoverCurrentIndex + 1;
    if (nextIndex >= failoverChain.length) {
        broadcastZapretLog(`[FAILOVER] All recommended profiles exhausted. Stopping engine.`);
        notify('DPI Failover Exhausted', 'No more profiles to try. Manual intervention needed.');
        failoverEnabled = false;
        stopFailoverMonitor();
        stopZapret();
        return;
    }

    const nextProfile = failoverChain[nextIndex];
    failoverCurrentIndex = nextIndex;

    broadcastZapretLog(`[FAILOVER] Rotating to next profile → ${nextProfile.toUpperCase()}`);
    notify('DPI Failover', `Switched to: ${nextProfile.toUpperCase()}`);

    // Kill current zapret, then relaunch with the next profile in chain
    await new Promise((resolve) => {
        exec(`taskkill /f /t /im winws.exe`, { windowsHide: true }, () => resolve());
    });
    await new Promise(r => setTimeout(r, 1200));

    // Re-enter the standard start path — keeps spawn / event-wiring code
    // in one place. We pass failover:true so monitoring continues.
    startZapret({
        mode: nextProfile,
        whitelistData: currentZapretWhitelist,
        customArgs: null,
        failover: true,
        failoverChain: failoverChain,        // preserve the chain across the restart
        failoverIndex: failoverCurrentIndex
    });
}

function startFailoverMonitor() {
    stopFailoverMonitor();
    failoverFailCount = 0;

    failoverTimer = setInterval(async () => {
        if (!failoverEnabled || !isZapretRunning) {
            stopFailoverMonitor();
            return;
        }

        const ok = await failoverHealthProbe();
        recordHealthProbe(ok);
        if (ok) {
            if (failoverFailCount > 0) {
                broadcastZapretLog(`[FAILOVER] Connection recovered. Counter reset.`);
            }
            failoverFailCount = 0;
            return;
        }

        failoverFailCount++;
        broadcastZapretLog(`[FAILOVER] Probe failed (${failoverFailCount}/${FAILOVER_FAIL_THRESHOLD}).`);

        if (failoverFailCount >= FAILOVER_FAIL_THRESHOLD) {
            failoverFailCount = 0;
            rotateToNextProfile();
        }
    }, FAILOVER_PROBE_INTERVAL_MS);
}

// --- START / STOP ---
function startZapret(config) {
    if (isZapretRunning || zapretProcess) {
        broadcastZapretLog('[ERROR] Shield is already running!');
        return;
    }

    const { mode, whitelistData, customArgs, failover, failoverChain: presetChain, failoverIndex: presetIndex } = config;

    // Cache whitelist so failover restarts (which don't get the renderer's
    // config) can keep the user's filter list intact.
    currentZapretWhitelist = whitelistData || '';

    const zapretDir = hostlists.getZapretDataPath();
    if (!fs.existsSync(zapretDir)) fs.mkdirSync(zapretDir, { recursive: true });

    const filePath = path.join(zapretDir, 'whitelist.txt');
    const autoListPath = path.join(zapretDir, 'autohostlist.txt');
    if (!fs.existsSync(autoListPath)) fs.writeFileSync(autoListPath, '', 'utf8');

    let finalDomains = (whitelistData || '').split('\n').map(d => d.trim()).filter(d => d.length > 0);
    fs.writeFileSync(filePath, finalDomains.join('\n'), 'utf8');

    if (!fs.existsSync(WINWS_EXE)) {
        broadcastToAll('zapret-status', 'error');
        broadcastZapretLog('[FATAL] winws.exe not found! Check zapret-bin directory.');
        return;
    }

    let baseArgs = mode === 'custom' ? customArgs : (ZAPRET_PROFILES[mode] || ZAPRET_PROFILES['bw_standard']);
    // Apply global flags (IPv6 dual-stack) to every profile automatically so new
    // profiles inherit the setting without manual edits.
    let args = [
        ...applyGlobalProfileFlags(baseArgs),
        `--hostlist=${filePath}`,
        `--hostlist-auto=${autoListPath}`,
        `--hostlist-auto-debug`,
        '--debug'
    ];

    // Append the Turkey master blocked list as a second --hostlist (zapret
    // supports multiple, OR-ed together). User can disable via settings.json
    // key `dpi_use_tr_master_list = false`.
    try {
        const useMaster = readSettingsFile().dpi_use_tr_master_list;
        const enabled = useMaster === undefined ? true : useMaster === true;
        if (enabled) {
            const trMasterPath = hostlists.getTrMasterListPath();
            if (fs.existsSync(trMasterPath)) {
                args.push(`--hostlist=${trMasterPath}`);
            }
        }
    } catch (e) { /* ignore — fall through without master list */ }

    broadcastZapretLog(`[INFO] Initializing Shield... Profile: ${mode.toUpperCase()}`);
    // Tell the user whether the TR master list is being applied (transparency)
    try {
        const useMaster = readSettingsFile().dpi_use_tr_master_list;
        const enabled = useMaster === undefined ? true : useMaster === true;
        if (enabled && fs.existsSync(hostlists.getTrMasterListPath())) {
            broadcastZapretLog(`[INFO] Turkey master blocked list applied (${hostlists.TR_MASTER_BLOCKED_LIST.length} domains).`);
        }
    } catch (e) { /* silent */ }

    try {
        zapretProcess = spawn(WINWS_EXE, args, { windowsHide: true });
        isZapretRunning = true;
        currentZapretMode = mode;

        broadcastToAll('zapret-status', 'running');
        notify('DPI Shield Active', `Profile: ${mode.toUpperCase()}`);

        // Reset health history when a fresh profile starts so the badge
        // reflects only the current session, not the previous profile's stats.
        healthHistory = [];
        startDedicatedHealthMonitor();

        // Auto-failover wiring
        if (failover) {
            failoverEnabled = true;

            if (Array.isArray(presetChain) && presetChain.length > 0) {
                // Rotation restart — preserve in-flight chain & index
                failoverChain = presetChain.slice();
                failoverCurrentIndex = typeof presetIndex === 'number' ? presetIndex : 0;
            } else {
                // Fresh start — build chain from cached ISP detection
                const detection = isp.getCachedDetection();
                if (detection && Array.isArray(detection.recommendedProfiles) && detection.recommendedProfiles.length > 0) {
                    failoverChain = detection.recommendedProfiles.slice();
                } else {
                    // Detection unavailable; chain contains only current mode (no rotation possible)
                    failoverChain = [mode];
                }
                // Make sure the active profile is the starting point in the chain
                const idx = failoverChain.indexOf(mode);
                if (idx >= 0) {
                    failoverCurrentIndex = idx;
                } else {
                    failoverChain.unshift(mode);
                    failoverCurrentIndex = 0;
                }
            }

            broadcastZapretLog(`[FAILOVER] Monitoring enabled. Chain: ${failoverChain.map(p => p.toUpperCase()).join(' → ')}`);
            broadcastZapretLog(`[FAILOVER] Current step: ${failoverCurrentIndex + 1}/${failoverChain.length} (${mode.toUpperCase()})`);
            startFailoverMonitor();
        } else {
            failoverEnabled = false;
            stopFailoverMonitor();
            failoverChain = [];
            failoverCurrentIndex = 0;
        }

        zapretProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                broadcastZapretLog(output);
            }
        });

        zapretProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString().trim();
            if (errorOutput) {
                broadcastZapretLog(`[SYS]: ${errorOutput}`);
            }
        });

        zapretProcess.on('close', (code) => {
            const wasRunning = isZapretRunning;
            isZapretRunning = false;
            zapretProcess = null;
            currentZapretMode = null;
            broadcastToAll('zapret-status', 'stopped');
            broadcastZapretLog(`[INFO] Shield deactivated. (Code: ${code})`);
            if (wasRunning) notify('DPI Shield Stopped', 'Network filtering hooks have been released.');
        });

    } catch (err) {
        isZapretRunning = false;
        broadcastToAll('zapret-status', 'error');
        broadcastZapretLog(`[START ERROR]: ${err.message}`);
    }
}

function stopZapret() {
    // Manual stop ALWAYS disables failover — user wants the engine off, not rotated
    failoverEnabled = false;
    stopFailoverMonitor();
    failoverChain = [];
    failoverCurrentIndex = 0;
    stopDedicatedHealthMonitor();
    healthHistory = [];

    if (zapretProcess) {
        broadcastZapretLog('[INFO] Sending termination signal to driver...');
        exec(`taskkill /f /t /im winws.exe`, (err) => {
            isZapretRunning = false;
            zapretProcess = null;
            currentZapretMode = null;
            broadcastToAll('zapret-status', 'stopped');
            broadcastZapretLog('[INFO] Shield stopped and network hooks cleared.');
        });
    }
}

ipcMain.on('start-zapret', (event, config) => startZapret(config));
ipcMain.on('stop-zapret', () => stopZapret());

function getState() {
    return {
        running: isZapretRunning,
        mode:    currentZapretMode,
        pid:     zapretProcess ? zapretProcess.pid : null
    };
}

// Synchronous quit-time cleanup (registered with quit.js).
function killSync() {
    try { if (zapretProcess) zapretProcess.kill('SIGKILL'); } catch (e) {}
}

module.exports = { startZapret, stopZapret, getState, getHealth, killSync };
