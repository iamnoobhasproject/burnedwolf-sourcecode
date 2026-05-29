const { app, BrowserWindow, Tray, Menu, ipcMain, powerSaveBlocker, session, dialog, globalShortcut, safeStorage, Notification } = require('electron');
const path = require('path');
const { spawn, exec, execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const dgram = require('dgram');

// --- SAFE PATH HELPERS (PowerShell injection protection) ---
function psQuote(p) {
    // Escapes a path for safe use inside a PowerShell single-quoted string.
    // PowerShell escapes single quotes by doubling them.
    return "'" + String(p).replace(/'/g, "''") + "'";
}

function runExpandArchive(zipPath, destPath, cb) {
    // Uses execFile + array args to avoid shell interpretation of paths.
    const psArgs = [
        '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(destPath)} -Force`
    ];
    execFile('powershell.exe', psArgs, { windowsHide: true }, cb);
}

// --- ZAPRET ASSET PATHS ---
// Resolved at startup so profile templates can reference fake-TLS/QUIC payloads
// without bundling them in the static ZAPRET_PROFILES object.
const ZAPRET_BIN_DIR  = path.join(__dirname, 'zapret-bin').replace('app.asar', 'app.asar.unpacked');
const FAKE_PAYLOAD_DIR = path.join(ZAPRET_BIN_DIR, 'fake');
const FAKE_TLS_PATH    = path.join(FAKE_PAYLOAD_DIR, 'tls_clienthello_www_google_com.bin');
const FAKE_QUIC_PATH   = path.join(FAKE_PAYLOAD_DIR, 'quic_initial_www_google_com.bin');

// Fetch the fake-TLS / fake-QUIC payloads from the zapret-win-bundle repo on
// first run. These are real ClientHello / Initial packets captured from
// google.com — many DPI vendors (TTNet's Sandvine especially) refuse to drop
// packets that look like they belong to a Google handshake, so wrapping our
// fake injections in this payload dramatically improves the bypass rate.
// Payloads live in the main zapret repository under files/fake/, NOT in the
// Windows bundle (that one only ships the QUIC Initial inside files/, no fake/
// subfolder and no TLS variant). URLs verified May 2025 — TLS: 681 B, QUIC: 1200 B.
const FAKE_PAYLOAD_SOURCES = {
    'tls_clienthello_www_google_com.bin':
        'https://raw.githubusercontent.com/bol-van/zapret/master/files/fake/tls_clienthello_www_google_com.bin',
    'quic_initial_www_google_com.bin':
        'https://raw.githubusercontent.com/bol-van/zapret/master/files/fake/quic_initial_www_google_com.bin'
};

function downloadToFile(url, dest) {
    return new Promise((resolve, reject) => {
        const handle = (res, redirectsLeft = 5) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
                https.get(res.headers.location, r => handle(r, redirectsLeft - 1)).on('error', reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
        };
        https.get(url, handle).on('error', reject);
    });
}

async function ensureFakePayloads() {
    try {
        if (!fs.existsSync(FAKE_PAYLOAD_DIR)) fs.mkdirSync(FAKE_PAYLOAD_DIR, { recursive: true });
        for (const [name, url] of Object.entries(FAKE_PAYLOAD_SOURCES)) {
            const filePath = path.join(FAKE_PAYLOAD_DIR, name);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) continue;
            try {
                await downloadToFile(url, filePath);
            } catch (e) {
                console.warn(`[fake-payload] Could not download ${name}: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn('[fake-payload] ensure failed:', e.message);
    }
}

// Helper that profile templates use: returns true iff both fake-payload files
// are present and non-empty. Profiles fall back to non-fake variants when false.
function fakePayloadsAvailable() {
    try {
        return fs.existsSync(FAKE_TLS_PATH)  && fs.statSync(FAKE_TLS_PATH).size  > 0
            && fs.existsSync(FAKE_QUIC_PATH) && fs.statSync(FAKE_QUIC_PATH).size > 0;
    } catch (e) { return false; }
}

// Wraps a profile's argv with global flags before spawn:
//   1. --wf-l3=ipv4,ipv6 prepended (IPv6 dual-stack)
//   2. --dpi-desync-fake-tls / -fake-quic flags stripped if the payload files
//      haven't been downloaded yet (otherwise winws.exe would refuse to start)
// Centralising this keeps the static profile list clean and lets new profiles
// inherit safe defaults automatically.
function applyGlobalProfileFlags(args) {
    let out = Array.isArray(args) ? args.slice() : [];

    // Strip fake payload flags if the bin files aren't on disk yet
    if (!fakePayloadsAvailable()) {
        out = out.filter(a =>
            typeof a !== 'string' ||
            (!a.startsWith('--dpi-desync-fake-tls=') && !a.startsWith('--dpi-desync-fake-quic='))
        );
    }

    // IPv6 dual-stack prepend
    const hasL3 = out.some(a => typeof a === 'string' && a.startsWith('--wf-l3='));
    if (!hasL3) out.unshift('--wf-l3=ipv4,ipv6');

    return out;
}

// --- CONSTANTS ---
const OFFICIAL_APP_NAME = "Burnedwolf";
app.setName(OFFICIAL_APP_NAME);

// Silence harmless Chromium disk-cache warnings that occur when the app runs
// elevated (requireAdministrator). The cache create/move calls fail with 0x5
// because the user profile path resolves to a SYSTEM-restricted directory.
// Disabling the on-disk cache removes the noise without affecting features.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

let win;
let tray;
let exitWindow;
let updaterWindow;
let onboardingWindow;
let discordWindow;
let dpiWindow;
let verifyWindow;
let spotlightWindow; // SPOTLIGHT WINDOW
let currentSpotlightHotkey = 'Ctrl+Space';

// --- UPDATE VARIABLES ---
const CURRENT_VERSION = "1.6.0";
let UPDATE_URL = "https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/version.json"; 

// --- TOR CORE VARIABLES ---
let torProcess = null;
let isTorReady = false;
let activeTorPort = 9050;

// --- ZAPRET CORE VARIABLES ---
let zapretProcess = null;
let isZapretRunning = false;
let currentZapretMode = null;       // remember the active profile so reopened windows can show it
let currentZapretWhitelist = '';    // cached whitelist text so failover restarts keep it

// --- TURKEY MASTER BLOCKED-DOMAIN LIST ---
// These are the high-value targets that BTK blocks or major Turkish ISPs
// throttle. Including them as a secondary --hostlist focuses DPI bypass work
// on the sites that actually need it, which reduces false positives elsewhere
// (Google search, banking, etc. stay untouched and full-speed).
//
// Maintained statically; user's own whitelist still takes precedence.
const TR_MASTER_BLOCKED_LIST = [
    // === Discord (block + voice region servers) ===
    'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg',
    'discord.media', 'discord.gift', 'discordstatus.com',
    'cdn.discordapp.com', 'media.discordapp.net',
    'gateway.discord.gg', 'remote-auth-gateway.discord.gg',
    // === Roblox (full block) ===
    'roblox.com', 'rbxcdn.com', 'roblox.org', 'robloxlabs.com',
    'web.roblox.com', 'www.roblox.com',
    // === X / Twitter (throttled + occasional block) ===
    'twitter.com', 'x.com', 't.co',
    'twimg.com', 'abs.twimg.com', 'video.twimg.com',
    'ton.twitter.com', 'api.twitter.com',
    // === YouTube (severe throttle) ===
    'youtube.com', 'youtu.be', 'm.youtube.com',
    'googlevideo.com', 'ytimg.com', 'yt3.ggpht.com',
    'youtube-nocookie.com', 'youtubei.googleapis.com',
    // === Mega ===
    'mega.nz', 'mega.co.nz', 'megaupload.com',
    // === Twitch (throttle) ===
    'twitch.tv', 'ttvnw.net', 'jtvnw.net',
    // === Reddit (occasional throttle) ===
    'reddit.com', 'redditstatic.com', 'redditmedia.com',
    // === Wikipedia (legacy, kept for historical block) ===
    'wikipedia.org', 'wikimedia.org',
    // === Cloudflare Workers (selective .workers.dev throttle) ===
    'workers.dev',
    // === Mainstream VPN sites (often blocked, useful for users wanting to access) ===
    'protonvpn.com', 'windscribe.com', 'mullvad.net', 'nordvpn.com',
    // === Tor ===
    'torproject.org'
];

function getTrMasterListPath() {
    return path.join(getZapretDataPath(), 'tr_master.txt');
}

// Write the TR master list to disk on every app start so list updates ship
// with the binary rather than being persisted by users.
function ensureTrMasterList() {
    try {
        const p = getTrMasterListPath();
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, TR_MASTER_BLOCKED_LIST.join('\n') + '\n', 'utf8');
    } catch (e) {
        console.warn('[tr-master-list] write failed:', e.message);
    }
}

// --- BLOCKCHECK CANCELLATION STATE ---
// Set when the renderer asks to abort an in-flight analysis. The blockcheck
// loop checks this flag between every probe, between every profile, and
// between every mutation step so cancellation is responsive (<2 sec).
let blockcheckCancelRequested = false;

ipcMain.on('cancel-blockcheck', () => {
    blockcheckCancelRequested = true;
});

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

ipcMain.handle('get-engine-health', () => {
    const stats = computeHealthStats();
    return {
        engineRunning: isZapretRunning,
        currentMode:   currentZapretMode,
        ...stats
    };
});

// --- FAILOVER CHAIN STATE ---
// When auto-failover is on, the engine watches its own connectivity and
// automatically rotates to the next recommended profile (from ASN_PROFILE_MAP)
// after 3 consecutive failed probes. State lives in main so the DPI window can
// close without interrupting the failover loop.
let failoverEnabled        = false;
let failoverChain          = [];   // array of profile ids, ordered strongest -> weakest
let failoverCurrentIndex   = 0;
let failoverFailCount      = 0;
let failoverTimer          = null;
const FAILOVER_PROBE_INTERVAL_MS = 30000;
const FAILOVER_FAIL_THRESHOLD    = 3;

// BURNEDWOLF DPI PROFILES
// Category prefixes:
//   bw_     -> Generic / Global (works in most regions)
//   tr_     -> Turkey-focused (Turk Telekom, Vodafone, Turkcell Superonline, TurkNet, D-Smart, Kablonet)
//   ru_     -> Russia / CIS (Rostelecom, MTS, Beeline, MegaFon, Yota)
//   eu_     -> Europe (UK, DE, FR ISPs that throttle YouTube/Discord)
//   mid_    -> Middle East / GCC
//   asia_   -> South / Central Asia
const ZAPRET_PROFILES = {
    // ===== GENERIC / GLOBAL =====
    'bw_standard':       ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--new', '--filter-tcp=80,443', '--dpi-desync=split2'],
    'bw_advanced':       ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    'bw_aggressive':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq', '--dpi-desync-autottl=2'],
    'bw_ultra':          ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badsum', '--dpi-desync-autottl=2'],
    'bw_discord_voice':  ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443,50000-65535', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2'],
    'bw_youtube_4k':     ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-repeats=6'],
    'bw_quic_pass':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--dpi-desync-repeats=2', '--dpi-desync-fake-quic=quic_initial.bin'],
    'bw_tls_split':      ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=split', '--dpi-desync-split-pos=2', '--dpi-desync-split-seqovl=652', '--dpi-desync-fooling=md5sig'],
    'bw_minimal':        ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake'],

    // ===== CLASSIC COMMUNITY RULESETS (zapret-discord-youtube) =====
    // These are the long-proven rulesets from the original Russian/Turkish
    // bypass community. They split UDP voice traffic (50000-65535) from
    // standard HTTPS/QUIC into its own filter chain, which is the trick that
    // gets Discord voice unstuck on aggressive DPI providers (TTNet fiber).
    'bw_classic_discord': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig'
    ],
    'bw_classic_universal': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split', '--dpi-desync-autottl', '--dpi-desync-fooling=md5sig'
    ],

    // ===== TURKEY (TR) =====
    // Türk Telekom (TTNet) — heavy SNI inspection on 443, light on 80
    'tr_ttnet_std':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'tr_ttnet_youtube':  ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-autottl=4', '--dpi-desync-repeats=10'],
    // TTNet + Discord: voice UDP (50000-65535) gets its own filter chain with
    // --dpi-desync-any-protocol so each voice packet is fragmented, otherwise
    // Discord gets stuck on "Starting" because TTNet drops the voice handshake.
    'tr_ttnet_discord':  [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    // TTNet Fiber: even more aggressive — fiber lines have deeper inspection,
    // so we add badseq fooling and bump TTL/repeats. Use when discord_std fails.
    'tr_ttnet_fiber':    [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d4', '--dpi-desync-repeats=10',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-repeats=8'
    ],
    // Vodafone TR — aggressive QUIC drop, TLS 1.3 reassembly
    'tr_vodafone_std':   ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=badseq,hopbyhop2', '--dpi-desync-autottl=2'],
    'tr_vodafone_yt':    ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badsum', '--dpi-desync-repeats=8', '--dpi-desync-autottl=2'],
    // Turkcell Superonline — fiber, aggressive deep inspection
    'tr_superonline':    ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'],
    'tr_superonline_d':  ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443,50000-65535', '--dpi-desync=fake', '--dpi-desync-repeats=8', '--new', '--filter-tcp=443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq'],
    // TurkNet — relatively light DPI, often standard works
    'tr_turknet':        ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake', '--dpi-desync-fooling=md5sig', '--new', '--filter-udp=443', '--dpi-desync=fake'],
    // D-Smart / Kablonet — cable, moderate filtering
    'tr_dsmart':         ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=md5sig'],
    'tr_kablonet':       ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    // Mobile carriers (legacy combined entry — kept for backward compatibility)
    'tr_mobile_std':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=4'],
    // Per-carrier mobile profiles (3 big operators use different DPI vendors/tunings)
    'tr_mobile_tt':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=6'],
    'tr_mobile_vf':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'tr_mobile_tc':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'],
    // Türksat Uydunet (satellite/fiber hybrid) — moderate inspection
    'tr_uydunet':        ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=3', '--dpi-desync-repeats=4'],

    // ===== TURKEY — ALL-IN-ONE (one profile, every protocol) =====
    // Same 4-chain architecture as Ultimate (QUIC + Voice UDP + TCP 80 + TCP 443)
    // but WITHOUT the fake-TLS/QUIC payload files — so these work even when the
    // GitHub download has failed or the user has no internet on first launch.
    // Each ISS variant tunes the TCP chain's fooling combo to match its DPI
    // vendor (Sandvine vs Allot vs lighter setups).
    'tr_ttnet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_vodafone_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_superonline_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_turknet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'
    ],
    'tr_uydunet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=4'
    ],
    'tr_dsmart_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=md5sig'
    ],
    'tr_kablonet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=4'
    ],
    // Universal mobile All-in-One — works on TT Mobil / Vodafone Mobile / Turkcell Mobile
    // because mobile DPI uses common Sandvine-derived patterns
    'tr_mobile_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,disorder2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-repeats=6'
    ],

    // ===== TURKEY — PRO (vendor-specific advanced fooling signatures) =====
    // These profiles use the strongest community-proven flag combinations for
    // each DPI vendor (Sandvine, Allot, Light/generic). They do NOT depend on
    // the fake-payload .bin files, so they ship offline-ready. Key differences
    // vs. plain profiles: split-seqovl=652 (defeats TLS 1.3 reassembly),
    // split-pos=2 with multisplit, 3-way fooling (md5sig + badseq + hopbyhop2),
    // and split TCP 80 / TCP 443 chains so the SNI-inspection layer can be
    // attacked separately from plain HTTP.
    'tr_ttnet_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d4', '--dpi-desync-repeats=10',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig,badseq',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig,badseq,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],
    'tr_vodafone_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,split2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,split2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig,badseq',
        '--dpi-desync-repeats=8'
    ],
    'tr_superonline_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig,badseq',
        '--dpi-desync-repeats=6'
    ],
    'tr_mobile_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,disorder2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,disorder2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],
    // Universal TR aggressive — works on TTNet/Vodafone/Superonline simultaneously
    // by combining the strongest fooling set across vendors. Slightly slower
    // than vendor-specific Pro but the safest choice when ISP is uncertain.
    'tr_universal_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=3',
        '--dpi-desync-fooling=md5sig,badseq,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],

    // ===== TURKEY — ULTIMATE (uses downloaded fake-TLS / fake-QUIC payloads) =====
    // These profiles wrap our fake desync packets in real Google ClientHello /
    // QUIC Initial captures. Sandvine (TTNet) and Allot (Superonline) DPI
    // vendors won't drop a packet that looks like a Google handshake, which
    // dramatically boosts the bypass rate — especially for Discord voice.
    // If the .bin files haven't been downloaded yet, profiles fall back to
    // their non-fake equivalents at spawn time (see applyGlobalProfileFlags).
    'tr_ttnet_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],
    'tr_vodafone_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],
    'tr_superonline_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],

    // ===== RUSSIA / CIS =====
    // Rostelecom — large state ISP, heavy YouTube throttling
    'ru_rostelecom':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'ru_rostelecom_yt':  ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=4', '--dpi-desync-repeats=10', '--dpi-desync-fake-tls=tls_clienthello_www_google_com.bin'],
    // MTS / Beeline / MegaFon — mobile, TPROXY-like behavior
    'ru_mts':            ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=2'],
    'ru_beeline':        ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,hopbyhop2'],
    'ru_megafon':        ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,disorder', '--dpi-desync-fooling=md5sig'],
    // Yota — heavy QUIC filtering
    'ru_yota':           ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--dpi-desync-repeats=4', '--new', '--filter-tcp=443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badsum'],

    // ===== EUROPE =====
    // UK ISPs (BT, Virgin, Sky) — court-ordered blocking
    'eu_uk_std':         ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    // German / French ISPs with light DPI
    'eu_de_fr':          ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=split2', '--dpi-desync-split-pos=2'],

    // ===== MIDDLE EAST =====
    // Iran / UAE / Saudi — heavy filtering, multiple layers
    'mid_iran':          ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badseq,badsum', '--dpi-desync-autottl=4', '--dpi-desync-repeats=12'],
    'mid_uae':           ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=8'],

    // ===== ASIA =====
    'asia_in':           ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=2'],
    'asia_pk':           ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=6']
};

// Profile metadata for UI categorization
const PROFILE_META = {
    'bw_standard':       { label: 'Standard',                  region: 'Generic' },
    'bw_advanced':       { label: 'Advanced',                  region: 'Generic' },
    'bw_aggressive':     { label: 'Aggressive',                region: 'Generic' },
    'bw_ultra':          { label: 'Ultra',                     region: 'Generic' },
    'bw_discord_voice':  { label: 'Discord Voice Optimized',   region: 'Generic' },
    'bw_youtube_4k':     { label: 'YouTube 4K Bypass',         region: 'Generic' },
    'bw_quic_pass':      { label: 'QUIC Passthrough',          region: 'Generic' },
    'bw_tls_split':      { label: 'TLS Split (Light)',         region: 'Generic' },
    'bw_minimal':        { label: 'Minimal',                   region: 'Generic' },
    'bw_classic_discord':   { label: 'Classic Discord (legacy)',   region: 'Generic' },
    'bw_classic_universal': { label: 'Classic Universal (legacy)', region: 'Generic' },
    'tr_ttnet_std':      { label: 'Türk Telekom — Standard',         region: 'Turkey' },
    'tr_ttnet_youtube':  { label: 'Türk Telekom — YouTube',          region: 'Turkey' },
    'tr_ttnet_discord':  { label: 'Türk Telekom — Discord',          region: 'Turkey' },
    'tr_ttnet_fiber':    { label: 'Türk Telekom Fiber — Discord+',   region: 'Turkey' },
    'tr_vodafone_std':   { label: 'Vodafone TR — Standard',    region: 'Turkey' },
    'tr_vodafone_yt':    { label: 'Vodafone TR — YouTube',     region: 'Turkey' },
    'tr_superonline':    { label: 'Superonline — Standard',    region: 'Turkey' },
    'tr_superonline_d':  { label: 'Superonline — Discord',     region: 'Turkey' },
    'tr_turknet':        { label: 'TurkNet',                   region: 'Turkey' },
    'tr_dsmart':         { label: 'D-Smart',                   region: 'Turkey' },
    'tr_kablonet':       { label: 'Kablonet',                       region: 'Turkey' },
    'tr_uydunet':        { label: 'Türksat Uydunet',                region: 'Turkey' },
    'tr_mobile_std':     { label: 'TR Mobile (combined, legacy)',   region: 'Turkey' },
    'tr_mobile_tt':      { label: 'TR Mobile — TT Mobil (4.5G/5G)', region: 'Turkey' },
    'tr_mobile_vf':      { label: 'TR Mobile — Vodafone',           region: 'Turkey' },
    'tr_mobile_tc':      { label: 'TR Mobile — Turkcell',           region: 'Turkey' },
    'tr_ttnet_ultimate':       { label: 'TT Ultimate (fake-TLS+QUIC)',          region: 'Turkey' },
    'tr_vodafone_ultimate':    { label: 'Vodafone Ultimate (fake-TLS+QUIC)',    region: 'Turkey' },
    'tr_superonline_ultimate': { label: 'Superonline Ultimate (fake-TLS+QUIC)', region: 'Turkey' },
    'tr_ttnet_pro':            { label: 'TT Pro (Sandvine signature)',          region: 'Turkey' },
    'tr_vodafone_pro':         { label: 'Vodafone Pro (Sandvine variant)',      region: 'Turkey' },
    'tr_superonline_pro':      { label: 'Superonline Pro (Allot signature)',    region: 'Turkey' },
    'tr_mobile_pro':           { label: 'TR Mobile Pro (Sandvine mobile)',      region: 'Turkey' },
    'tr_universal_pro':        { label: 'TR Universal Pro (multi-vendor)',      region: 'Turkey' },
    'tr_ttnet_all_in_one':       { label: 'TT All-in-One (Discord+YT+X)',          region: 'Turkey' },
    'tr_vodafone_all_in_one':    { label: 'Vodafone All-in-One (Discord+YT+X)',    region: 'Turkey' },
    'tr_superonline_all_in_one': { label: 'Superonline All-in-One (Discord+YT+X)', region: 'Turkey' },
    'tr_turknet_all_in_one':     { label: 'TurkNet All-in-One',                    region: 'Turkey' },
    'tr_uydunet_all_in_one':     { label: 'Uydunet All-in-One',                    region: 'Turkey' },
    'tr_dsmart_all_in_one':      { label: 'D-Smart All-in-One',                    region: 'Turkey' },
    'tr_kablonet_all_in_one':    { label: 'Kablonet All-in-One',                   region: 'Turkey' },
    'tr_mobile_all_in_one':      { label: 'TR Mobile All-in-One (universal)',      region: 'Turkey' },
    'ru_rostelecom':     { label: 'Rostelecom',                region: 'Russia' },
    'ru_rostelecom_yt':  { label: 'Rostelecom — YouTube',      region: 'Russia' },
    'ru_mts':            { label: 'MTS',                       region: 'Russia' },
    'ru_beeline':        { label: 'Beeline',                   region: 'Russia' },
    'ru_megafon':        { label: 'MegaFon',                   region: 'Russia' },
    'ru_yota':           { label: 'Yota',                      region: 'Russia' },
    'eu_uk_std':         { label: 'UK (BT/Virgin/Sky)',        region: 'Europe' },
    'eu_de_fr':          { label: 'Germany / France',          region: 'Europe' },
    'mid_iran':          { label: 'Iran (Heavy DPI)',          region: 'Middle East' },
    'mid_uae':           { label: 'UAE (Etisalat/du)',         region: 'Middle East' },
    'asia_in':           { label: 'India',                     region: 'Asia' },
    'asia_pk':           { label: 'Pakistan',                  region: 'Asia' }
};

powerSaveBlocker.start('prevent-app-suspension');

// ==========================================
// --- 1. PHASE: UPDATER WINDOW ---
// ==========================================
function createUpdaterWindow() {
    updaterWindow = new BrowserWindow({
        width: 600, height: 400, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    updaterWindow.loadFile('updater.html');
}

// ==========================================
// --- ONBOARDING WINDOW (first-launch only) ---
// ==========================================
function createOnboardingWindow() {
    onboardingWindow = new BrowserWindow({
        width: 560, height: 540, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
        resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    onboardingWindow.loadFile('onboarding.html');
    onboardingWindow.on('closed', () => { onboardingWindow = null; });
}

// Onboarding finished → proceed with the regular boot sequence based on the
// auto-update preference the user just saved.
ipcMain.on('onboarding-complete', () => {
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    proceedAfterOnboarding();
});

function proceedAfterOnboarding() {
    let autoUpdate = true; // safe default
    try {
        const v = readSettingsFile().auto_update;
        if (v === false) autoUpdate = false;
    } catch (e) { /* default true */ }

    if (autoUpdate) {
        createUpdaterWindow();
    } else {
        // Skip the update screen entirely; main window appears immediately
        createWindow();
    }
}

// ==========================================
// --- UNIVERSAL STEALTH TRAY SYSTEM ---
// ==========================================
let hiddenWindowsTracker = [];

function hideAllAppWindowsToTray() {
    hiddenWindowsTracker = []; 
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed() && (w.isVisible() || w.isMinimized()) && w !== spotlightWindow) {
            hiddenWindowsTracker.push(w.id); 
            w.hide(); 
        }
    });
}

function minimizeToTray(targetWindow) {
    if (targetWindow && !targetWindow.isDestroyed()) {
        if (!hiddenWindowsTracker.includes(targetWindow.id)) {
            hiddenWindowsTracker.push(targetWindow.id);
        }
        targetWindow.hide(); 
    }
}

// ==========================================
// --- 2. PHASE: MAIN SCREEN ---
// ==========================================
function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 600, minWidth: 560, minHeight: 600,
    icon: path.join(__dirname, 'icon.ico'),
    title: "BurnedWolf Gateway",
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'titlebar.html')).catch(() => {
      win.loadFile('titlebar.html');
  }); 

  // win.maximize(); BURADAN SİLİNDİ
  win.once('ready-to-show', () => {
      win.show();
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('app-name', "BURNEDWOLF");
    win.webContents.send('app-version', CURRENT_VERSION);
  });

  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip("BurnedWolf System Gateway");
  
  // Tray right-click menu: show main window, quick-open every module, and quit.
  // Each module item re-uses the existing open-X-window IPC handler via
  // ipcMain.emit, so menu and Spotlight share one code path for window creation.
  const contextMenu = Menu.buildFromTemplate([
      { label: 'Show BurnedWolf', click: () => {
          if (win && !win.isDestroyed()) {
              win.show();
              win.focus();
              if (!hiddenWindowsTracker.includes(win.id)) return;
              // also restore any other windows the user had hidden into tray
              BrowserWindow.getAllWindows().forEach(w => {
                  if (!w.isDestroyed() && hiddenWindowsTracker.includes(w.id)) {
                      w.show();
                  }
              });
              hiddenWindowsTracker = [];
          }
      }},
      { type: 'separator' },
      { label: 'DPI Shield',        click: () => ipcMain.emit('open-dpi-window',    null) },
      { label: 'Discord',           click: () => ipcMain.emit('open-discord-window',null) },
      { label: 'File Integrity',    click: () => ipcMain.emit('open-verify-window', null) },
      { type: 'separator' },
      { label: 'Quit BurnedWolf',   click: () => attemptExit() }
  ]);

  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
      if (hiddenWindowsTracker.length > 0) {
          BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed() && hiddenWindowsTracker.includes(w.id)) {
                  w.show();
                  w.restore(); 
              }
          });
          hiddenWindowsTracker = []; 
          if (win && !win.isDestroyed()) win.focus();
      } else {
          hideAllAppWindowsToTray();
      }
  });

  win.on('minimize', (event) => { event.preventDefault(); win.hide(); });
  win.on('close', (event) => { if (!app.isQuiting) { event.preventDefault(); win.hide(); } });
}

function attemptExit() {
  if (exitWindow) return;
  exitWindow = new BrowserWindow({
    width: 500, height: 340, frame: false, transparent: true, alwaysOnTop: true, parent: win, modal: true, 
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  exitWindow.loadFile('exit-dialog.html');
  exitWindow.on('closed', () => { exitWindow = null; });
}

// IPC WINDOW MANAGEMENT
ipcMain.on('minimize-window', () => { hideAllAppWindowsToTray(); });
ipcMain.on('maximize-window', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.on('completely-exit', () => attemptExit());
ipcMain.on('exit-yes', () => { app.isQuiting = true; app.quit(); });
ipcMain.on('exit-no', () => { if (exitWindow) exitWindow.close(); if (win) win.webContents.send('exit-cancelled'); });

// Minimize-to-tray handlers (window-controls X button)
ipcMain.on('minimize-verify-window', () => minimizeToTray(verifyWindow));
ipcMain.on('minimize-discord-window', () => minimizeToTray(discordWindow));
ipcMain.on('minimize-dpi-window', () => minimizeToTray(dpiWindow));

// --- PERSISTENT SETTINGS (settings.json) ---
// localStorage is unreliable for file:// origin renderers in Electron — the
// browser sometimes treats them as opaque/ephemeral. To keep simple key/value
// preferences (autostart toggle, spotlight hotkey, etc.) reliably persisted
// across launches, we store them in <userData>/settings.json via IPC.
function getSettingsPath() {
    return path.join(app.getPath('userData'), 'settings.json');
}
function readSettingsFile() {
    try {
        const p = getSettingsPath();
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
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
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                try { w.webContents.send('language-changed', value); } catch (e) {}
            }
        });
    }
    return ok;
});

// --- TOAST NOTIFICATIONS ---
// Show a native Windows toast. Coalesces rapid-fire duplicates within 2s so
// log-spam (e.g. multiple TOR bootstrap milestones) doesn't burst the action center.
const recentToasts = new Map();
function notify(title, body, opts = {}) {
    try {
        const key = `${title}::${body}`;
        const now = Date.now();
        if (recentToasts.has(key) && (now - recentToasts.get(key)) < 2000) return;
        recentToasts.set(key, now);

        const n = new Notification({
            title: `BurnedWolf · ${title}`,
            body: String(body || ''),
            icon: path.join(__dirname, 'icon.png'),
            silent: opts.silent === true
        });
        n.show();
    } catch (e) { /* notifications can fail on some systems — ignore */ }
}

// --- ENGINE STATUS QUERY ---
// Renderers that get reopened (DPI) need to know the current backend
// state to render correct UI. Without this they'd default to "stopped" while
// the underlying process is actually still running in main.
ipcMain.handle('query-engine-status', () => ({
    zapret: {
        running: isZapretRunning && zapretProcess !== null,
        mode:    currentZapretMode
    },
    tor: {
        ready: isTorReady,
        port:  activeTorPort
    }
}));

// --- MEMORY MONITOR ---
// Returns { moduleId: <MB or null> } for every known module window. `null`
// means neither the renderer window nor any backing process is alive (idle).
//
// For modules with a long-running OS process (DPI -> winws.exe via zapretProcess,
// Discord -> tor.exe via torProcess), we also include that process's working set so
// the user sees real memory usage even when the window is closed.

// Cross-platform-ish memory probe via Windows `tasklist`. We cache the result
// for a few seconds to keep the 2s spotlight poll snappy and avoid spawning
// tasklist twice in parallel.
const externalMemCache = new Map(); // pid -> { mb, expires }
function getExternalProcessMemoryMB(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve(null);
        const cached = externalMemCache.get(pid);
        const now = Date.now();
        if (cached && cached.expires > now) return resolve(cached.mb);

        execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
            { windowsHide: true, timeout: 2500 },
            (err, stdout) => {
                if (err || !stdout) return resolve(null);
                // Last CSV column looks like:  "12,345 K"
                const match = stdout.match(/"([\d.,]+)\s*K"\s*$/m);
                if (!match) return resolve(null);
                const kb = parseInt(match[1].replace(/[.,]/g, ''), 10);
                const mb = isNaN(kb) ? null : Math.round(kb / 1024);
                externalMemCache.set(pid, { mb, expires: now + 2500 });
                resolve(mb);
            });
    });
}

ipcMain.handle('get-module-memory', async () => {
    const slots = {
        dpi:     dpiWindow,
        discord: discordWindow,
        verify:  verifyWindow
    };
    let metrics = [];
    try { metrics = app.getAppMetrics(); } catch (e) { /* ignore */ }

    const rendererMem = (w) => {
        if (!w || w.isDestroyed()) return null;
        try {
            const pid = w.webContents.getOSProcessId();
            const m = metrics.find(x => x.pid === pid);
            return m && m.memory ? Math.round(m.memory.workingSetSize / 1024) : null;
        } catch (e) { return null; }
    };

    // Probe backend processes in parallel so the whole call is fast.
    const [zapretMb, torMb] = await Promise.all([
        isZapretRunning && zapretProcess ? getExternalProcessMemoryMB(zapretProcess.pid) : Promise.resolve(null),
        isTorReady     && torProcess     ? getExternalProcessMemoryMB(torProcess.pid)    : Promise.resolve(null)
    ]);

    const result = {};
    for (const [id, w] of Object.entries(slots)) {
        let mb = rendererMem(w);
        if (id === 'dpi'     && zapretMb != null) mb = (mb || 0) + zapretMb;
        // Discord depends on the Tor backend process, so attribute Tor's RAM there
        if (id === 'discord' && torMb    != null) mb = (mb || 0) + torMb;
        result[id] = mb;
    }
    return result;
});

// --- AUTO-START ---
ipcMain.on('set-autostart', (event, state) => {
    if (!app.isPackaged) return; 

    const exePath = process.execPath;
    const taskName = "BurnedWolf_AutoStart";

    if (state) {
        const addCmd = `schtasks /create /tn "${taskName}" /tr "\\"${exePath}\\" --hidden" /sc onlogon /rl highest /f`;
        exec(addCmd, { windowsHide: true });
    } else {
        const removeCmd = `schtasks /delete /tn "${taskName}" /f`;
        exec(removeCmd, { windowsHide: true });
    }
});

// ==========================================
// --- UPDATER PROTOCOLS ---
// ==========================================
ipcMain.on('exit-app', () => { app.quit(); });

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
    if(updaterWindow) updaterWindow.close();
    createWindow();
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

// ==========================================
// --- FILE INTEGRITY VERIFICATION ---
// ==========================================
ipcMain.on('open-verify-window', () => {
    if (verifyWindow) { verifyWindow.show(); verifyWindow.focus(); return; }
    
    verifyWindow = new BrowserWindow({
      width: 800, height: 600,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      title: "System Integrity",
      icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    
    verifyWindow.loadFile('verify.html');
    verifyWindow.on('closed', () => { verifyWindow = null; });
});

ipcMain.on('close-verify-window', () => { if (verifyWindow) verifyWindow.close(); });

ipcMain.on('start-verification', async (event) => {
    const rootDir = process.execPath.includes('node_modules') ? process.cwd() : path.dirname(process.execPath);
    const zipPath = path.join(rootDir, 'net.zip');
    const extractPath = path.join(rootDir, 'net_temp');
    
    const netZipUrl = "https://github.com/iamnoobhasproject/app-updates/releases/download/123f12okopw21dwqdqwfwqdf/net.zip"; 

    event.reply('verify-log', 'Connecting to server. Downloading net.zip...');
    
    const file = fs.createWriteStream(zipPath);
    
    https.get(netZipUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, handleDownload).on('error', (err) => { event.reply('verify-error', "Download Error: " + err.message); });
        } else {
            handleDownload(response);
        }

        function handleDownload(res) {
            if (res.statusCode !== 200) { 
                event.reply('verify-error', `Server file not found: HTTP ${res.statusCode}`); 
                return; 
            }
            
            const totalSize = parseInt(res.headers['content-length'], 10);
            let downloadedSize = 0;

            res.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
                event.reply('verify-progress', { phase: 'download', percent: percent, msg: `Downloading from server...` });
            });

            res.pipe(file);
            
            file.on('finish', () => {
                file.close();
                event.reply('verify-log', 'Extracting archive...');
                event.reply('verify-progress', { phase: 'extract', percent: 100, msg: `Opening files...` });

                runExpandArchive(zipPath, extractPath, async (err) => {
                    if(err) { event.reply('verify-error', "Extraction Error! " + err.message); return; }

                    event.reply('verify-log', 'Matching system files with server files...');

                    let missingOrCorruptFiles = [];

                    function getAllFiles(dirPath, arrayOfFiles) {
                        let files = fs.readdirSync(dirPath);
                        arrayOfFiles = arrayOfFiles || [];
                        files.forEach(function(file) {
                            if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
                                arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
                            } else {
                                arrayOfFiles.push(path.join(dirPath, file));
                            }
                        });
                        return arrayOfFiles;
                    }

                    function sha256File(filePath) {
                        return new Promise((resolve, reject) => {
                            const hash = crypto.createHash('sha256');
                            const stream = fs.createReadStream(filePath);
                            stream.on('data', d => hash.update(d));
                            stream.on('end', () => resolve(hash.digest('hex')));
                            stream.on('error', reject);
                        });
                    }

                    let extractedFiles = [];
                    try {
                        extractedFiles = getAllFiles(extractPath);
                    } catch(e) {
                        event.reply('verify-error', "Read error: " + e.message); return;
                    }

                    const totalFiles = extractedFiles.length;
                    let checkedCount = 0;

                    // Files we must never overwrite during integrity repair:
                    //   - The running executable itself (Windows locks it, copy fails
                    //     and the user sees "Burnedwolf.exe being replaced" forever).
                    //   - The asar bundle (handled by the updater, not by verify).
                    //   - Anything used by an active backend process (winws/tor) so
                    //     a live shield session doesn't get its binary swapped.
                    const runningExeName = path.basename(process.execPath).toLowerCase();
                    const SKIP_FILES = new Set([
                        runningExeName,         // e.g. "burnedwolf.exe"
                        'burnedwolf.exe',       // fixed fallback even when running via electron .
                        'app.asar',
                        'app.asar.unpacked',
                        'update.zip',
                        'update_system.bat',
                        'update_hidden.vbs',
                        'net.zip',
                        'settings.json'
                    ]);
                    // Folders to skip entirely (anywhere in the relative path).
                    const SKIP_DIR_PARTS = new Set([
                        'node_modules', 'tor-data', 'update_temp', 'net_temp', 'build', '.git'
                    ]);

                    const shouldSkip = (relPath) => {
                        const lowered = relPath.toLowerCase();
                        const base = path.basename(lowered);
                        if (SKIP_FILES.has(base)) return true;
                        const parts = lowered.split(/[\\/]/);
                        return parts.some(p => SKIP_DIR_PARTS.has(p));
                    };

                    for (const tempFilePath of extractedFiles) {
                        checkedCount++;
                        const relativePath = path.relative(extractPath, tempFilePath);
                        const localFilePath = path.join(rootDir, relativePath);

                        event.reply('verify-progress', { phase: 'check', percent: Math.round((checkedCount / totalFiles) * 100), msg: `Checking: ${relativePath}` });
                        await new Promise(r => setTimeout(r, 20));

                        // Skip protected/locked files — these belong to the updater
                        // pipeline, not to file-integrity repair.
                        if (shouldSkip(relativePath)) {
                            event.reply('verify-log', `[SKIPPED] ${relativePath} (protected by integrity policy)`);
                            continue;
                        }

                        let needsCopy = false;
                        if (!fs.existsSync(localFilePath)) {
                            needsCopy = true;
                            event.reply('verify-log', `[MISSING FILE] ${relativePath} not found in local directory.`);
                        } else {
                            const tempStat = fs.statSync(tempFilePath);
                            const localStat = fs.statSync(localFilePath);
                            if (tempStat.size !== localStat.size) {
                                needsCopy = true;
                                event.reply('verify-log', `[CORRUPT FILE] ${relativePath} (Size mismatch, will be repaired).`);
                            } else {
                                // Size matches — verify with SHA-256 to detect tampering
                                try {
                                    const [tempHash, localHash] = await Promise.all([
                                        sha256File(tempFilePath),
                                        sha256File(localFilePath)
                                    ]);
                                    if (tempHash !== localHash) {
                                        needsCopy = true;
                                        event.reply('verify-log', `[CORRUPT FILE] ${relativePath} (Hash mismatch, will be repaired).`);
                                    }
                                } catch (hashErr) {
                                    event.reply('verify-log', `[WARN] ${relativePath} hash check failed: ${hashErr.message}`);
                                }
                            }
                        }

                        if (needsCopy) {
                            missingOrCorruptFiles.push({ temp: tempFilePath, local: localFilePath, rel: relativePath });
                        }
                    }

                    if (missingOrCorruptFiles.length > 0) {
                        event.reply('verify-log', `Repairing total ${missingOrCorruptFiles.length} missing/corrupt files...`);
                        for (let i = 0; i < missingOrCorruptFiles.length; i++) {
                            const item = missingOrCorruptFiles[i];
                            event.reply('verify-progress', { phase: 'repair', percent: Math.round(((i+1) / missingOrCorruptFiles.length) * 100), msg: `Copying: ${item.rel}` });

                            try {
                                const localDir = path.dirname(item.local);
                                if (!fs.existsSync(localDir)) { fs.mkdirSync(localDir, { recursive: true }); }
                                fs.copyFileSync(item.temp, item.local);
                            } catch (copyErr) {
                                // EBUSY / EPERM happen when a file is locked (e.g. .exe
                                // currently running, .dll mapped into a process). We log
                                // and keep going instead of looping forever.
                                event.reply('verify-log', `[SKIPPED] ${item.rel} could not be replaced (${copyErr.code || copyErr.message}). Continuing.`);
                            }
                            await new Promise(r => setTimeout(r, 30));
                        }
                    }

                    event.reply('verify-progress', { phase: 'cleanup', percent: 100, msg: `Cleaning up temporary files...` });
                    try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch(e) {}
                    try { fs.rmSync(zipPath, { force: true }); } catch(e) {}
                    event.reply('verify-done', { repairedCount: missingOrCorruptFiles.length });
                });
            });
        }
    }).on('error', (err) => { event.reply('verify-error', "Download Error: " + err.message); });
});

// ==========================================
// --- GHOST TOR CORE MANAGEMENT ---
// ==========================================
ipcMain.on('start-tor', (event) => {
    if (isTorReady) {
        event.reply('tor-ready', activeTorPort);
        return;
    }
    if (torProcess) return; 

    const torPath = path.join(__dirname, 'tor-bin', 'tor.exe').replace('app.asar', 'app.asar.unpacked');
    const dataPath = path.join(app.getPath('userData'), 'tor-data'); 

    if (!fs.existsSync(dataPath)) {
        fs.mkdirSync(dataPath, { recursive: true });
    }

    torProcess = spawn(torPath, ['--SocksPort', activeTorPort.toString(), '--DataDirectory', dataPath], {
        windowsHide: true 
    });

    torProcess.stdout.on('data', (data) => {
        const output = data.toString();
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) w.webContents.send('tor-log', output);
        });
        
        if (output.includes('Bootstrapped 100%')) {
            const wasReady = isTorReady;
            isTorReady = true;
            BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) w.webContents.send('tor-ready', activeTorPort);
            });
            if (!wasReady) notify('Tor Connected', `Encrypted circuit established on port ${activeTorPort}.`);
        }
    });
});

// ==========================================
// --- INTEGRATED TOR DISCORD MODULE ---
// ==========================================
ipcMain.on('open-discord-window', () => {
    if (discordWindow) { discordWindow.show(); discordWindow.focus(); return; }
    
    discordWindow = new BrowserWindow({
      width: 1100, height: 750, frame: false, transparent: true, backgroundColor: '#00000000',
      title: "SYSTEM_DISCORD", icon: path.join(__dirname, 'icon.ico'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webviewTag: true,
        // Allow Discord's WebRTC incoming audio to play without requiring a
        // user gesture. Without this, Chromium silently mutes remote streams
        // even after the user has joined the call.
        autoplayPolicy: 'no-user-gesture-required'
      }
    });
    
    discordWindow.loadFile('discord.html');
    discordWindow.on('maximize', () => { discordWindow.webContents.send('window-maximized'); });
    discordWindow.on('unmaximize', () => { discordWindow.webContents.send('window-restored'); });
    discordWindow.on('closed', () => { discordWindow = null; });
});
ipcMain.on('close-discord-window', () => { if (discordWindow) discordWindow.close(); });
ipcMain.on('maximize-discord-window', () => { if (discordWindow) discordWindow.isMaximized() ? discordWindow.restore() : discordWindow.maximize(); });

// --- SECURE CREDENTIAL STORAGE (Discord, etc.) ---
// Uses Electron safeStorage which delegates to the OS keychain (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). Replaces plaintext localStorage.
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

ipcMain.on('enable-discord-proxy', async (event) => {
    try {
        const dSession = session.fromPartition('persist:discordPartition');
        await dSession.setProxy({ proxyRules: `socks5://127.0.0.1:${activeTorPort}` });

        // Auto-grant media (microphone / camera) permissions inside the Discord
        // webview. Without these handlers Electron silently rejects getUserMedia
        // and the call stays muted even when the user clicked "Allow" inside
        // Discord's own UI. We scope this strictly to the Discord partition so
        // it can't affect the main app.
        const mediaPermissions = new Set([
            'media',                 // legacy single permission
            'microphone',
            'camera',
            'audioCapture',
            'videoCapture',
            'mediaKeySystem',
            'display-capture'
        ]);
        dSession.setPermissionRequestHandler((webContents, permission, callback) => {
            callback(mediaPermissions.has(permission));
        });
        dSession.setPermissionCheckHandler((webContents, permission) => {
            return mediaPermissions.has(permission);
        });

        event.reply('discord-proxy-success');
    } catch (e) {
        console.error("Discord Proxy Error: ", e);
    }
});

// ==========================================
// --- ZAPRET (DPI) MODULE ---
// ==========================================
ipcMain.on('open-dpi-window', () => {
    if (dpiWindow) { dpiWindow.show(); dpiWindow.focus(); return; }
    
    dpiWindow = new BrowserWindow({
      width: 900, height: 650, frame: false, transparent: true, backgroundColor: '#00000000',
      title: "BurnedWolf DPI", icon: path.join(__dirname, 'icon.ico'),
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    
    dpiWindow.loadFile('dpi.html');
    dpiWindow.on('closed', () => { dpiWindow = null; });
});

ipcMain.on('close-dpi-window', () => { if (dpiWindow) dpiWindow.close(); });
ipcMain.on('maximize-dpi-window', () => { if (dpiWindow) dpiWindow.isMaximized() ? dpiWindow.unmaximize() : dpiWindow.maximize(); });

// Expose profile catalog to renderer for UI categorization
// Infer rich metadata for a profile by inspecting its zapret argv. This avoids
// hand-writing 50+ entries and stays correct when profiles are tuned later —
// the UI sees fresh info on every restart.
function inferProfileMeta(id) {
    const args = ZAPRET_PROFILES[id] || [];
    const argStr = args.join(' ');

    // Voice-ready iff there's a dedicated UDP 50000-65535 filter chain OR
    // any-protocol UDP fragmentation (the two patterns Discord voice needs).
    const voiceReady = argStr.includes('--filter-udp=50000-65535') ||
                       argStr.includes('--dpi-desync-any-protocol');

    // Uses fake-TLS or fake-QUIC payloads (depends on downloaded .bin files)
    const usesFakePayload = argStr.includes('--dpi-desync-fake-tls=') ||
                            argStr.includes('--dpi-desync-fake-quic=');

    // Counts chain segments separated by '--new'
    const chainCount = args.filter(a => a === '--new').length + (args.length > 0 ? 1 : 0);

    // Difficulty heuristic — id suffix + flag richness
    let difficulty = 'low';
    if (id.endsWith('_ultimate'))          difficulty = 'extreme';
    else if (id.endsWith('_pro'))          difficulty = 'high';
    else if (id.endsWith('_all_in_one'))   difficulty = 'medium';
    else if (id.endsWith('_fiber'))        difficulty = 'high';
    else if (chainCount >= 4)              difficulty = 'high';
    else if (chainCount >= 2)              difficulty = 'medium';

    // Vendor / family classification by id prefix
    let vendor = null;
    if (id.startsWith('tr_ttnet'))         vendor = 'Sandvine';
    else if (id.startsWith('tr_vodafone')) vendor = 'Sandvine';
    else if (id.startsWith('tr_superonline')) vendor = 'Allot';
    else if (id.startsWith('tr_mobile'))   vendor = 'Sandvine-Mobile';
    else if (id.startsWith('tr_'))         vendor = 'Light';
    else if (id.startsWith('ru_'))         vendor = 'TSPU';
    else if (id.startsWith('eu_'))         vendor = 'Light';
    else if (id.startsWith('mid_'))        vendor = 'Heavy';
    else if (id.startsWith('asia_'))       vendor = 'Mixed';

    // Coarse 'supports' tags — driven by argv content + id intent
    const supports = [];
    if (argStr.includes('--filter-udp=50000-65535')) supports.push('discord-voice');
    if (id.includes('discord'))                       supports.push('discord');
    if (id.includes('youtube') || id.includes('yt'))  supports.push('youtube');
    if (id.includes('discord') || id.endsWith('_ultimate') || id.endsWith('_pro') || id.endsWith('_all_in_one')) {
        if (!supports.includes('discord')) supports.push('discord');
    }
    // All-in-One / Ultimate / Pro implicitly cover the major targets
    if (id.endsWith('_ultimate') || id.endsWith('_pro') || id.endsWith('_all_in_one')) {
        ['youtube', 'x', 'twitch'].forEach(s => { if (!supports.includes(s)) supports.push(s); });
    }

    return { voiceReady, usesFakePayload, chainCount, difficulty, vendor, supports };
}

ipcMain.handle('get-dpi-profiles', () => {
    return Object.keys(PROFILE_META).map(id => {
        const base = PROFILE_META[id];
        const meta = inferProfileMeta(id);
        return {
            id,
            label: base.label,
            region: base.region,
            ...meta
        };
    });
});

// Expose the TR master list size so the whitelist tab can show "N domains bundled"
ipcMain.handle('get-tr-master-info', () => {
    return {
        count: TR_MASTER_BLOCKED_LIST.length,
        path: getTrMasterListPath()
    };
});

// --- ISP AUTO-DETECTION ---
// Map AS Numbers → Turkish ISPs and recommended profile order. The first
// profile in each list is the strongest (Ultimate / fake-payload variants);
// subsequent ones are lighter fallbacks.
// Each chain is ordered: Ultimate (fake-payload, strongest) → Pro (advanced
// flags, offline-ready) → All-in-One (broad coverage) → niche/legacy tunings.
// Failover walks this exact order; "Apply best" picks the first one.
const ASN_PROFILE_MAP = {
    9121:  { isp: 'Türk Telekom',          profiles: ['tr_ttnet_ultimate',       'tr_ttnet_pro',       'tr_ttnet_all_in_one',       'tr_ttnet_fiber', 'tr_ttnet_discord', 'tr_ttnet_std'] },
    47331: { isp: 'Turkcell Superonline',  profiles: ['tr_superonline_ultimate', 'tr_superonline_pro', 'tr_superonline_all_in_one', 'tr_superonline_d', 'tr_superonline'] },
    15897: { isp: 'Vodafone TR',           profiles: ['tr_vodafone_ultimate',    'tr_vodafone_pro',    'tr_vodafone_all_in_one',    'tr_vodafone_std', 'tr_vodafone_yt'] },
    12978: { isp: 'Vodafone Mobile TR',    profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_vf'] },
    34984: { isp: 'Tellcom (Turkcell)',    profiles: ['tr_superonline_ultimate', 'tr_superonline_pro', 'tr_superonline_all_in_one', 'tr_mobile_tc'] },
    43260: { isp: 'TurkNet',               profiles: ['tr_universal_pro',        'tr_turknet_all_in_one', 'tr_turknet'] },
    16135: { isp: 'Turkcell Mobile',       profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_tc'] },
    43133: { isp: 'Türksat Uydunet',       profiles: ['tr_universal_pro',        'tr_uydunet_all_in_one', 'tr_uydunet'] },
    20978: { isp: 'D-Smart',               profiles: ['tr_universal_pro',        'tr_dsmart_all_in_one', 'tr_dsmart'] },
    8386:  { isp: 'Kablonet',              profiles: ['tr_universal_pro',        'tr_kablonet_all_in_one', 'tr_kablonet'] },
    34164: { isp: 'TT Mobil (Avea)',       profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_tt'] }
};

// Cache the detection for the lifetime of the app — public IP rarely changes
// mid-session and we don't want to hammer ipinfo.io on every DPI panel open.
let cachedISPDetection = null;

function fetchJSON(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const req = https.get(url, {
            timeout: timeoutMs,
            headers: { 'User-Agent': 'BurnedWolf/1.3.0', 'Accept': 'application/json' }
        }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    });
}

ipcMain.handle('detect-isp', async (event, opts) => {
    // opts.force = bypass cache
    if (cachedISPDetection && !(opts && opts.force)) return cachedISPDetection;

    // Try ipinfo.io first, fall back to ipapi.co — both free, no API key needed.
    let info = await fetchJSON('https://ipinfo.io/json');
    let asn = null, orgName = null;
    if (info && info.org) {
        const m = info.org.match(/^AS(\d+)\s+(.+)/);
        if (m) { asn = parseInt(m[1], 10); orgName = m[2]; }
    }

    if (!asn) {
        // Fallback provider
        info = await fetchJSON('https://ipapi.co/json/');
        if (info && info.asn) {
            const m = String(info.asn).match(/AS(\d+)/);
            if (m) asn = parseInt(m[1], 10);
            orgName = info.org || info.asn;
        }
    }

    if (!asn) {
        const fallback = { detected: false, reason: 'No public IP / ISP lookup failed' };
        cachedISPDetection = fallback;
        return fallback;
    }

    const mapping = ASN_PROFILE_MAP[asn];
    const result = {
        detected: true,
        known: !!mapping,
        ip: info.ip || null,
        country: info.country || info.country_code || null,
        city: info.city || null,
        asn,
        organization: orgName,
        ispLabel: mapping ? mapping.isp : (orgName || `AS${asn}`),
        recommendedProfiles: mapping ? mapping.profiles : []
    };
    cachedISPDetection = result;
    return result;
});

const getZapretDataPath = () => {
    const zapretDataPath = path.join(app.getPath('userData'), 'zapret-lists');
    if (!fs.existsSync(zapretDataPath)) fs.mkdirSync(zapretDataPath, { recursive: true });
    return zapretDataPath;
};

ipcMain.on('save-whitelist-only', (event, whitelistData) => {
    const filePath = path.join(getZapretDataPath(), 'whitelist.txt');
    const finalDomains = whitelistData.split('\n').map(d => d.trim()).filter(d => d.length > 0);
    fs.writeFileSync(filePath, finalDomains.join('\n'), 'utf8');
});

ipcMain.on('load-whitelist', (event) => {
    const filePath = path.join(getZapretDataPath(), 'whitelist.txt');
    if (fs.existsSync(filePath)) {
        event.reply('whitelist-data', fs.readFileSync(filePath, 'utf8'));
    } else {
        event.reply('whitelist-data', '');
    }
});

ipcMain.on('save-analysis-report', async (event, reportText) => {
    const { filePath } = await dialog.showSaveDialog({
        title: 'Save Analysis Report',
        defaultPath: 'BurnedWolf_DPI_Analysis.txt',
        buttonLabel: 'Save',
        filters: [{ name: 'Text Document', extensions: ['txt'] }]
    });
    if (filePath) {
        fs.writeFileSync(filePath, reportText, 'utf8');
        event.reply('blockcheck-log', `[INFO] Report saved successfully: ${filePath}`);
    }
});

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

function broadcastZapretLog(msg) {
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('zapret-log', msg);
    });
}

async function rotateToNextProfile() {
    const nextIndex = failoverCurrentIndex + 1;
    if (nextIndex >= failoverChain.length) {
        broadcastZapretLog(`[FAILOVER] All recommended profiles exhausted. Stopping engine.`);
        notify('DPI Failover Exhausted', 'No more profiles to try. Manual intervention needed.');
        failoverEnabled = false;
        stopFailoverMonitor();
        ipcMain.emit('stop-zapret', null);
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

    // Re-enter the standard start handler — keeps spawn / event-wiring code
    // in one place. We pass failover:true so monitoring continues.
    ipcMain.emit('start-zapret', null, {
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

// Start Zapret
ipcMain.on('start-zapret', (event, config) => {
    if (isZapretRunning || zapretProcess) {
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) w.webContents.send('zapret-log', '[ERROR] Shield is already running!');
        });
        return;
    }

    const { mode, whitelistData, customArgs, failover, failoverChain: presetChain, failoverIndex: presetIndex } = config;

    // Cache whitelist so failover restarts (which don't get the renderer's
    // config) can keep the user's filter list intact.
    currentZapretWhitelist = whitelistData || '';

    const zapretDir = getZapretDataPath();
    if (!fs.existsSync(zapretDir)) fs.mkdirSync(zapretDir, { recursive: true });

    const filePath = path.join(zapretDir, 'whitelist.txt');
    const autoListPath = path.join(zapretDir, 'autohostlist.txt');
    if (!fs.existsSync(autoListPath)) fs.writeFileSync(autoListPath, '', 'utf8');

    let finalDomains = (whitelistData || '').split('\n').map(d => d.trim()).filter(d => d.length > 0);
    fs.writeFileSync(filePath, finalDomains.join('\n'), 'utf8');

    const zapretExePath = path.join(__dirname, 'zapret-bin', 'winws.exe').replace('app.asar', 'app.asar.unpacked');
    
    if (!fs.existsSync(zapretExePath)) {
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                w.webContents.send('zapret-status', 'error');
                w.webContents.send('zapret-log', '[FATAL] winws.exe not found! Check zapret-bin directory.');
            }
        });
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
            const trMasterPath = getTrMasterListPath();
            if (fs.existsSync(trMasterPath)) {
                args.push(`--hostlist=${trMasterPath}`);
            }
        }
    } catch (e) { /* ignore — fall through without master list */ }

    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('zapret-log', `[INFO] Initializing Shield... Profile: ${mode.toUpperCase()}`);
    });
    // Tell the user whether the TR master list is being applied (transparency)
    try {
        const useMaster = readSettingsFile().dpi_use_tr_master_list;
        const enabled = useMaster === undefined ? true : useMaster === true;
        if (enabled && fs.existsSync(getTrMasterListPath())) {
            broadcastZapretLog(`[INFO] Turkey master blocked list applied (${TR_MASTER_BLOCKED_LIST.length} domains).`);
        }
    } catch (e) { /* silent */ }
    
    try {
        zapretProcess = spawn(zapretExePath, args, { windowsHide: true });
        isZapretRunning = true;
        currentZapretMode = mode;

        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) w.webContents.send('zapret-status', 'running');
        });
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
                const isp = cachedISPDetection;
                if (isp && Array.isArray(isp.recommendedProfiles) && isp.recommendedProfiles.length > 0) {
                    failoverChain = isp.recommendedProfiles.slice();
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
                BrowserWindow.getAllWindows().forEach(w => {
                    if (!w.isDestroyed()) w.webContents.send('zapret-log', output);
                });
            }
        });

        zapretProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString().trim();
            if (errorOutput) {
                BrowserWindow.getAllWindows().forEach(w => {
                    if (!w.isDestroyed()) w.webContents.send('zapret-log', `[SYS]: ${errorOutput}`);
                });
            }
        });

        zapretProcess.on('close', (code) => {
            const wasRunning = isZapretRunning;
            isZapretRunning = false;
            zapretProcess = null;
            currentZapretMode = null;
            BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) {
                    w.webContents.send('zapret-status', 'stopped');
                    w.webContents.send('zapret-log', `[INFO] Shield deactivated. (Code: ${code})`);
                }
            });
            if (wasRunning) notify('DPI Shield Stopped', 'Network filtering hooks have been released.');
        });

    } catch (err) {
        isZapretRunning = false;
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) {
                w.webContents.send('zapret-status', 'error');
                w.webContents.send('zapret-log', `[START ERROR]: ${err.message}`);
            }
        });
    }
});

ipcMain.on('stop-zapret', (event) => {
    // Manual stop ALWAYS disables failover — user wants the engine off, not rotated
    failoverEnabled = false;
    stopFailoverMonitor();
    failoverChain = [];
    failoverCurrentIndex = 0;
    stopDedicatedHealthMonitor();
    healthHistory = [];

    if (zapretProcess) {
        BrowserWindow.getAllWindows().forEach(w => {
            if (!w.isDestroyed()) w.webContents.send('zapret-log', '[INFO] Sending termination signal to driver...');
        });
        exec(`taskkill /f /t /im winws.exe`, (err) => {
            isZapretRunning = false;
            zapretProcess = null;
            currentZapretMode = null;
            BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) {
                    w.webContents.send('zapret-status', 'stopped');
                    w.webContents.send('zapret-log', '[INFO] Shield stopped and network hooks cleared.');
                }
            });
        });
    }
});

ipcMain.on('run-blockcheck', async (event, opts) => {
    // opts: { mode: 'quick' | 'deep' }
    // quick = ISP-recommended profiles + light mutation (~1-2 min)
    // deep  = every profile + full mutation engine (~5-8 min, default)
    const mode = (opts && opts.mode === 'quick') ? 'quick' : 'deep';
    blockcheckCancelRequested = false;

    event.reply('blockcheck-log', `BURNEDWOLF DYNAMIC NETWORK ANALYSIS — ${mode.toUpperCase()} SCAN`);
    event.reply('blockcheck-log', '---------------------------------------------------');

    const zapretExePath = path.join(__dirname, 'zapret-bin', 'winws.exe').replace('app.asar', 'app.asar.unpacked');
    let bestProfile = null;
    // Top-3 ranking — keeps a sorted shortlist so the final report can show
    // alternatives, not just the winner.
    let topProfiles = [];

    function trackCandidate(candidate) {
        // Insert candidate into topProfiles sorted by isBetter ordering
        topProfiles.push(candidate);
        topProfiles.sort((a, b) => {
            if (!!a.voice !== !!b.voice) return a.voice ? -1 : 1;
            return b.score - a.score;
        });
        if (topProfiles.length > 3) topProfiles = topProfiles.slice(0, 3);
    }

    function cancelled() {
        if (blockcheckCancelRequested) {
            event.reply('blockcheck-log', '[CANCELLED] Analysis stopped by user.');
            return true;
        }
        return false;
    }

    function emitProgress(phase, current, total, label) {
        event.reply('blockcheck-progress', { phase, current, total, label });
    }

    // Multi-target test list — every site Türkiye blocks or throttles at scale.
    // Discord & Roblox are full blocks; YouTube/Twitch are throttled; X is
    // occasionally throttled. A profile passes the more it covers.
    const TARGETS = [
        { name: 'discord.com',     fallbackIP: '162.159.138.232' },
        { name: 'www.youtube.com', fallbackIP: '142.250.74.110'  },
        { name: 'x.com',           fallbackIP: '104.244.42.193'  },
        { name: 'www.roblox.com',  fallbackIP: '128.116.96.78'   },
        { name: 'www.twitch.tv',   fallbackIP: '151.101.130.167' }
    ];

    const DOH_PROVIDERS = [
        { url: 'https://1.1.1.1/dns-query',          host: 'cloudflare-dns.com' },
        { url: 'https://8.8.8.8/resolve',            host: 'dns.google'         },
        { url: 'https://9.9.9.9:5053/dns-query',     host: 'dns.quad9.net'      },
        { url: 'https://dns.adguard-dns.com/resolve', host: 'dns.adguard-dns.com' }
    ];

    const fetchIP = (provider, hostname) => new Promise((resolve) => {
        const fullUrl = `${provider.url}?name=${encodeURIComponent(hostname)}&type=A`;
        const req = https.get(fullUrl, {
            headers: { 'accept': 'application/dns-json', 'Host': provider.host, 'User-Agent': 'Mozilla/5.0' },
            timeout: 2500
        }, (dnsRes) => {
            let data = '';
            dnsRes.on('data', chunk => data += chunk);
            dnsRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.Answer && json.Answer.length > 0) {
                        // Prefer first A record (type=1)
                        const a = json.Answer.find(x => x.type === 1) || json.Answer[0];
                        resolve(a.data);
                    } else resolve(null);
                } catch(e) { resolve(null); }
            });
        }).on('error', () => resolve(null)).on('timeout', () => { try { req.destroy(); } catch(e){} resolve(null); });
    });

    const resolveIP = async (hostname, fallback) => {
        for (const provider of DOH_PROVIDERS) {
            const ip = await fetchIP(provider, hostname);
            if (ip) return ip;
        }
        return fallback;
    };

    const probeTarget = (hostname, fallbackIP) => new Promise(async (resolve) => {
        const ip = await resolveIP(hostname, fallbackIP);
        const opts = {
            hostname: ip, port: 443, servername: hostname,
            headers: {
                'Host': hostname,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 4500
        };
        const req = https.get(opts, (res) => {
            resolve({ success: true, reason: `HTTP ${res.statusCode}`, ip });
        }).on('error', (err) => {
            let msg = err.message;
            if (err.code === 'ECONNRESET')   msg = 'Connection Reset (DPI drop)';
            if (err.code === 'ECONNREFUSED') msg = 'Refused by server';
            if (err.code === 'ETIMEDOUT')    msg = 'TCP Timeout';
            resolve({ success: false, reason: msg, ip });
        }).on('timeout', () => { try { req.destroy(); } catch(e){} resolve({ success: false, reason: 'Timeout (heavy DPI)', ip }); });
    });

    // Discord voice path check — sends a STUN Binding Request from a source
    // port inside the Discord voice range (50000-65535) so zapret's UDP filter
    // chain is exercised. If the STUN response comes back, the voice UDP path
    // survives DPI; if it times out, voice will hang on "Starting..." in
    // Discord regardless of how good the TCP/HTTPS score looks.
    const STUN_SERVERS = [
        { host: 'stun.l.google.com',  port: 19302 },
        { host: 'stun1.l.google.com', port: 19302 },
        { host: 'stun.cloudflare.com', port: 3478 }
    ];
    const checkVoiceUDP = () => new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');

        // Build a STUN Binding Request (RFC 5389)
        const stunRequest = Buffer.alloc(20);
        stunRequest.writeUInt16BE(0x0001, 0);     // Message Type: Binding Request
        stunRequest.writeUInt16BE(0x0000, 2);     // Message Length: 0
        stunRequest.writeUInt32BE(0x2112A442, 4); // Magic Cookie
        crypto.randomBytes(12).copy(stunRequest, 8); // 96-bit Transaction ID

        let done = false;
        const finish = (success, reason) => {
            if (done) return;
            done = true;
            try { socket.close(); } catch (e) { /* ignore */ }
            resolve({ success, reason });
        };

        socket.once('message', (msg) => {
            // 0x0101 = Binding Success Response — anything coming back proves UDP path
            const ok = msg && msg.length >= 20;
            finish(true, ok ? 'STUN response' : 'UDP response');
        });
        socket.on('error', (e) => finish(false, e.code || e.message));

        // Source port inside Discord voice range — this is critical so zapret's
        // --filter-udp=50000-65535 chain actually intercepts this packet.
        const srcPort = 50000 + Math.floor(Math.random() * 14999);

        try {
            socket.bind(srcPort, () => {
                // Try the first STUN server; the timeout below catches silent drops.
                const target = STUN_SERVERS[0];
                socket.send(stunRequest, target.port, target.host, (err) => {
                    if (err) finish(false, err.message);
                });
                // Fire backup probes after a short delay in case the first server
                // is unreachable (server outage rather than DPI block).
                setTimeout(() => {
                    if (done) return;
                    for (let i = 1; i < STUN_SERVERS.length; i++) {
                        const s = STUN_SERVERS[i];
                        try { socket.send(stunRequest, s.port, s.host, () => {}); } catch (e) {}
                    }
                }, 800);
            });
        } catch (e) {
            finish(false, e.message);
        }

        setTimeout(() => finish(false, 'UDP timeout (DPI likely drops voice)'), 3500);
    });

    // Score = TCP target count + a boolean for the voice UDP path.
    // Voice support is treated as a separate axis because it's the difference
    // between "Discord login works" and "Discord call actually connects".
    const scoreProfile = async () => {
        const details = [];
        const tcpPromises = TARGETS.map(t => probeTarget(t.name, t.fallbackIP));
        const [tcpResults, voiceResult] = await Promise.all([
            Promise.all(tcpPromises),
            checkVoiceUDP()
        ]);

        let score = 0;
        TARGETS.forEach((t, i) => {
            const r = tcpResults[i];
            if (r.success) { score++; details.push(`${t.name} ✓`); }
            else           { details.push(`${t.name} ✗ (${r.reason})`); }
        });

        const voice = voiceResult.success;
        details.push(voice ? `Discord voice UDP ✓` : `Discord voice UDP ✗ (${voiceResult.reason})`);

        return { score, voice, details };
    };

    // Voice support always beats raw TCP score — a profile that gets Discord
    // login but can't carry voice is useless to a user trying to call friends.
    const isBetter = (a, b) => {
        if (!b) return true;
        if (!!a.voice !== !!b.voice) return !!a.voice;
        return a.score > b.score;
    };

    const killZapret = () => new Promise(r => exec(`taskkill /f /t /im winws.exe`, { windowsHide: true }, () => r()));

    // PHASE 1 — quick baseline (no shield)
    event.reply('blockcheck-log', 'PHASE 0: Baseline (no shield)...');
    const baseline = await scoreProfile();
    baseline.details.forEach(d => event.reply('blockcheck-log', `  · ${d}`));
    event.reply('blockcheck-log', `Baseline: ${baseline.score}/${TARGETS.length} TCP, voice ${baseline.voice ? '✓' : '✗'}`);

    if (baseline.score === TARGETS.length && baseline.voice) {
        event.reply('blockcheck-log', '[INFO] No blocking detected (web + voice both open). DPI shield not required.');
        event.reply('blockcheck-status', 'done');
        return;
    }

    event.reply('blockcheck-log', '---------------------------------------------------');

    // ISS-aware profile ordering — when the user's ISP is known, test the
    // recommended profiles FIRST. They're the most likely winners and let us
    // short-circuit the whole loop. The rest of the catalog still gets tested
    // (in deep mode) so we don't miss niche optimal matches.
    let profileIds = Object.keys(ZAPRET_PROFILES);
    if (cachedISPDetection && cachedISPDetection.known && Array.isArray(cachedISPDetection.recommendedProfiles)) {
        const recs = cachedISPDetection.recommendedProfiles.filter(id => ZAPRET_PROFILES[id]);
        const rest = profileIds.filter(id => !recs.includes(id));
        profileIds = mode === 'quick' ? recs : [...recs, ...rest];
        event.reply('blockcheck-log', `PHASE 1: ${recs.length} ISP-recommended profile${recs.length === 1 ? '' : 's'} prioritised (${cachedISPDetection.ispLabel}).`);
    } else if (mode === 'quick') {
        // Quick mode without ISP info → keep TR profiles only (most likely user base)
        profileIds = profileIds.filter(id => id.startsWith('tr_') || id.startsWith('bw_discord') || id.startsWith('bw_classic'));
        event.reply('blockcheck-log', `PHASE 1: ISP unknown — testing ${profileIds.length} Turkey-focused profiles only (Quick mode).`);
    } else {
        event.reply('blockcheck-log', 'PHASE 1: Testing pre-configured BurnedWolf profiles...');
    }

    const profileTotal = profileIds.length;
    let profileIndex = 0;

    for (const profId of profileIds) {
        if (cancelled()) { event.reply('blockcheck-status', 'done'); return; }

        profileIndex++;
        const meta = PROFILE_META[profId] || { label: profId, region: '?' };
        const inferred = inferProfileMeta(profId);
        const metaTag = inferred.vendor ? ` [${inferred.vendor}${inferred.usesFakePayload ? '+fake' : ''}]` : '';

        emitProgress('phase1', profileIndex, profileTotal, `${meta.region} → ${meta.label}`);
        event.reply('blockcheck-log', `[${profileIndex}/${profileTotal}] ${meta.region} → ${meta.label}${metaTag}`);

        const testProc = spawn(zapretExePath, [...applyGlobalProfileFlags(ZAPRET_PROFILES[profId]), '--debug'], { windowsHide: true });
        await new Promise(r => setTimeout(r, 1800));

        if (cancelled()) { await killZapret(); event.reply('blockcheck-status', 'done'); return; }

        const { score, voice, details } = await scoreProfile();
        details.forEach(d => event.reply('blockcheck-log', `    · ${d}`));
        event.reply('blockcheck-log', `  → Score: ${score}/${TARGETS.length} TCP, voice ${voice ? '✓' : '✗'}`);

        await killZapret();
        await new Promise(r => setTimeout(r, 1000));

        const candidate = { id: profId, name: meta.label, args: ZAPRET_PROFILES[profId], score, voice, vendor: inferred.vendor, difficulty: inferred.difficulty };
        trackCandidate(candidate);
        if (isBetter(candidate, bestProfile)) {
            bestProfile = candidate;
            if (score === TARGETS.length && voice) {
                event.reply('blockcheck-log', `[PERFECT] ${meta.label} — full Discord (web + voice).`);
                break;
            }
        }
    }

    // PHASE 2 — mutation engine (deep mode only)
    // Skipped entirely in quick mode to keep the analysis under ~2 minutes.
    // Also skipped if Phase 1 already found a perfect (web + voice) profile.
    const perfectFound = bestProfile && bestProfile.score === TARGETS.length && bestProfile.voice;
    if (!perfectFound && mode !== 'quick' && !cancelled()) {
        event.reply('blockcheck-log', '---------------------------------------------------');
        event.reply('blockcheck-log', 'PHASE 2: Mutation Engine — synthesizing custom strategies...');

        // Voice-capable chain template. We mutate the TCP desync params while
        // keeping the voice UDP chain stable (proven any-protocol/cutoff trick).
        const buildArgs = (d, f, ttl, rep) => [
            '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
            // Voice UDP path (50000-65535) — required for Discord call to connect
            '--filter-udp=50000-65535',
            '--dpi-desync=fake', '--dpi-desync-any-protocol',
            '--dpi-desync-cutoff=d3', `--dpi-desync-repeats=${rep}`,
            '--new',
            // QUIC / HTTPS-over-UDP
            '--filter-udp=443',
            '--dpi-desync=fake', `--dpi-desync-repeats=${rep}`,
            '--new',
            // TCP HTTPS — main mutation surface
            '--filter-tcp=80,443',
            `--dpi-desync=${d}`,
            `--dpi-desync-fooling=${f}`,
            `--dpi-desync-autottl=${ttl}`,
            `--dpi-desync-repeats=${rep}`
        ];

        const desyncStrats   = ['fake,split2', 'fake,disorder2', 'split2', 'syndata', 'fake,multisplit', 'fake,disorder', 'multisplit', 'fakedsplit'];
        const foolingStrats  = ['md5sig', 'badseq', 'badsum', 'md5sig,badseq', 'md5sig,badsum', 'hopbyhop2'];
        const ttlVariants    = [2, 3, 4];
        const repeatVariants = [6, 10];

        const mutationTotal = desyncStrats.length * foolingStrats.length * ttlVariants.length * repeatVariants.length;
        let mutationIndex = 0;

        outer:
        for (const d of desyncStrats) {
            for (const f of foolingStrats) {
                for (const ttl of ttlVariants) {
                    for (const rep of repeatVariants) {
                        if (cancelled()) { await killZapret(); break outer; }

                        mutationIndex++;
                        const args = buildArgs(d, f, ttl, rep);
                        const name = `AUTO ${d}/${f} ttl=${ttl} rep=${rep}`;
                        emitProgress('phase2', mutationIndex, mutationTotal, name);
                        event.reply('blockcheck-log', `[${mutationIndex}/${mutationTotal}] MUTATION ${name}`);

                        const tp = spawn(zapretExePath, [...applyGlobalProfileFlags(args), '--debug'], { windowsHide: true });
                        await new Promise(r => setTimeout(r, 1800));

                        if (cancelled()) { await killZapret(); break outer; }

                        const { score, voice, details } = await scoreProfile();
                        details.forEach(line => event.reply('blockcheck-log', `    · ${line}`));
                        event.reply('blockcheck-log', `  → Score: ${score}/${TARGETS.length} TCP, voice ${voice ? '✓' : '✗'}`);

                        await killZapret();
                        await new Promise(r => setTimeout(r, 900));

                        const candidate = { id: 'custom_generated', name, args, score, voice, vendor: 'Mutation', difficulty: 'high' };
                        trackCandidate(candidate);
                        if (isBetter(candidate, bestProfile)) {
                            bestProfile = candidate;
                            if (score === TARGETS.length && voice) {
                                event.reply('blockcheck-log', `[PERFECT MUTATION] ${name} — full Discord (web + voice).`);
                                break outer;
                            }
                        }
                    }
                }
            }
        }
    }

    event.reply('blockcheck-log', '---------------------------------------------------');
    if (!bestProfile) {
        event.reply('blockcheck-log', '[FATAL] No DPI strategy worked. Likely IP-level blacklist.');
        event.reply('blockcheck-log', 'Try again after switching networks or check ISP filtering rules.');
        event.reply('blockcheck-status', 'done');
        return;
    }

    // Top-3 ranked summary so the user can see alternatives, not just the winner
    event.reply('blockcheck-log', `TOP RESULTS (best ${topProfiles.length} of ${profileTotal} tested):`);
    topProfiles.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        const voiceTag = p.voice ? 'voice ✓' : 'voice ✗';
        const vendorTag = p.vendor ? ` · ${p.vendor}` : '';
        event.reply('blockcheck-log', `  ${medal} ${p.name} — ${p.score}/${TARGETS.length} TCP, ${voiceTag}${vendorTag}`);
    });
    event.reply('blockcheck-log', '---------------------------------------------------');

    const voiceTag = bestProfile.voice ? 'web + voice' : 'web only (voice WILL fail)';
    event.reply('blockcheck-log', `APPLIED: ${bestProfile.name} — ${bestProfile.score}/${TARGETS.length} TCP, ${voiceTag}.`);
    if (!bestProfile.voice) {
        event.reply('blockcheck-log', '[WARNING] No voice-ready profile found. Discord calls will hang on "Starting…".');
        event.reply('blockcheck-log', '          The Proxy Discord module routes traffic through Tor — voice may work there.');
    }
    event.reply('blockcheck-done', {
        id: 'custom',
        name: 'Analysis Result: ' + bestProfile.name,
        args: bestProfile.args,
        voice: !!bestProfile.voice,
        topProfiles: topProfiles.map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            voice: !!p.voice,
            vendor: p.vendor || null
        }))
    });
});

// ==========================================
// --- SPOTLIGHT (QUICK ACTION) MODULE ---
// ==========================================

function createSpotlightWindow() {
    if (spotlightWindow) return;
    spotlightWindow = new BrowserWindow({
        width: 650, height: 480, frame: false, transparent: true, skipTaskbar: true,
        show: false, center: true, alwaysOnTop: true, type: 'pop-up-menu',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    
    spotlightWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    spotlightWindow.setAlwaysOnTop(true, 'screen-saver', 1); 
    
    spotlightWindow.loadFile('spotlight.html');
    
    spotlightWindow.on('blur', () => { spotlightWindow.hide(); });
    spotlightWindow.on('close', (e) => {
        if (!app.isQuiting) { e.preventDefault(); spotlightWindow.hide(); }
    });
}

function toggleSpotlight() {
    if (!spotlightWindow) createSpotlightWindow();
    if (spotlightWindow.isVisible()) {
        spotlightWindow.hide();
    } else {
        spotlightWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        spotlightWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        spotlightWindow.show();
        spotlightWindow.focus();
        spotlightWindow.webContents.send('spotlight-opened');
    }
}

ipcMain.on('hide-spotlight', () => { if (spotlightWindow) spotlightWindow.hide(); });

ipcMain.on('update-spotlight-hotkey', (event, newHotkey) => {
    globalShortcut.unregister(currentSpotlightHotkey);
    if (newHotkey) {
        currentSpotlightHotkey = newHotkey;
        try { globalShortcut.register(currentSpotlightHotkey, toggleSpotlight); } 
        catch(e) { console.error("Kısayol atanamadı:", e); }
    }
});

// INITIALIZATION
app.whenReady().then(() => {
    // Load the persisted spotlight hotkey from settings.json so the global
    // shortcut is correct from the very first launch — before the titlebar
    // renderer has a chance to send `update-spotlight-hotkey`.
    try {
        const saved = readSettingsFile().spotlight_hotkey;
        if (saved && typeof saved === 'string') currentSpotlightHotkey = saved;
    } catch (e) { /* fall back to default */ }

    // Branch on first-launch state: if the user hasn't completed onboarding
    // (no language / auto-update preferences yet) show the onboarding wizard
    // first. Otherwise honour their saved auto-update preference.
    let onboarded = false;
    try { onboarded = readSettingsFile().onboarded === true; } catch (e) {}

    if (!onboarded) {
        createOnboardingWindow();
    } else {
        proceedAfterOnboarding();
    }
    createSpotlightWindow();

    try { globalShortcut.register(currentSpotlightHotkey, toggleSpotlight); } catch(e){}

    // Kick off fake-TLS/QUIC payload download in the background. We don't
    // block startup on this — profiles that require these files will simply
    // pick a fallback path until the download finishes.
    ensureFakePayloads();

    // Ship the TR master blocked-domain hostlist to userData/zapret-lists/.
    // Rewritten every launch so list updates ship with the app, not with the
    // user's local file edits.
    ensureTrMasterList();
});

app.on('will-quit', () => {
    if (torProcess) torProcess.kill('SIGKILL');
    if (zapretProcess) zapretProcess.kill('SIGKILL');
    globalShortcut.unregisterAll(); 
    exec(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { app.quit(); } });