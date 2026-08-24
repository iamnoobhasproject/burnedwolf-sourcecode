// ==========================================
// --- BURNEDWOLF MAIN-PROCESS ENTRY ---
// ==========================================
// Composition root: configures the app, loads every domain module (each one
// registers its own IPC handlers at require time), wires the quit-cleanup
// order, and runs the boot sequence. No business logic lives here.
//
// Module map:
//   constants.js        app name / version / root path
//   util/               exec (PowerShell), http, broadcast helpers
//   settings.js         settings.json persistence + settings-get/set IPC
//   notify.js           native toast notifications
//   windows.js          all windows + tray + window IPC (main = the whole app)
//   quit.js             guaranteed full shutdown (cleanup task registry)
//   dns.js              DNS presets + dnscrypt-proxy + crash-safe restore
//   tor.js              tor.exe lifecycle
//   discord.js          Discord partition proxy + media permissions
//   credentials.js      safeStorage-backed credential store
//   isp.js              ASN-based ISP detection + recommended profiles
//   autostart.js        logon scheduled task
//   updater.js          check/download/apply update pipeline
//   verify.js           file-integrity download/compare/repair
//   zapret/             DPI engine: paths, profiles, payloads, hostlists,
//                       engine (start/stop/failover/health), blockcheck
//   ai/                 BurnedWolf AI: provider catalog, wire protocols,
//                       live program context, action registry, usage ledger
const { app, ipcMain, powerSaveBlocker } = require('electron');
const { OFFICIAL_APP_NAME } = require('./constants');

app.setName(OFFICIAL_APP_NAME);

// Silence harmless Chromium disk-cache warnings that occur when the app runs
// elevated (requireAdministrator). The cache create/move calls fail with 0x5
// because the user profile path resolves to a SYSTEM-restricted directory.
// Disabling the on-disk cache removes the noise without affecting features.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');

// Domain modules — required for their side effects (IPC registration).
const settings = require('./settings');
const windows = require('./windows');
const quit = require('./quit');
const dns = require('./dns');
const tor = require('./tor');
require('./discord');
require('./credentials');
require('./isp');
require('./autostart');
require('./updater');
require('./verify');
const hostlists = require('./zapret/hostlists');
const payloads = require('./zapret/payloads');
require('./zapret/profiles');
const engine = require('./zapret/engine');
require('./zapret/blockcheck');
// BurnedWolf AI — loaded last so its context builder can lazily reach every
// module above. Registers the ai-* IPC surface; costs nothing until the user
// configures a provider.
require('./ai');

powerSaveBlocker.start('prevent-app-suspension');

// Quit cleanup order mirrors the original shutdown sequence:
// kill tor → kill zapret → kill dnscrypt + restore the user's DNS.
quit.registerQuitTask(tor.killSync);
quit.registerQuitTask(engine.killSync);
quit.registerQuitTask(dns.cleanupSync);

// Onboarding finished → proceed with the regular boot sequence based on the
// auto-update preference the user just saved.
function proceedAfterOnboarding() {
    let autoUpdate = true; // safe default
    try {
        const v = settings.readSettingsFile().auto_update;
        if (v === false) autoUpdate = false;
    } catch (e) { /* default true */ }

    if (autoUpdate) {
        windows.createUpdaterWindow();
    } else {
        // Skip the update screen entirely; main window appears immediately
        windows.createMainWindow();
    }
}

ipcMain.on('onboarding-complete', () => {
    const onboardingWindow = windows.getOnboardingWindow();
    if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close();
    proceedAfterOnboarding();
});

// INITIALIZATION
app.whenReady().then(() => {
    // Crash-safety: if a previous session left encrypted DNS on without a clean quit
    // (forced shutdown / restart / power loss), the system is stranded on the now-dead
    // 127.0.0.1 resolver. Repair DNS before anything else so the user has working
    // internet from the first second. No-op on a normal launch (no marker file).
    try { dns.recoverDnsFromCrash(); } catch (e) {}

    // Second line of defence, and the one that matters most in practice. The
    // marker file above can be missing (hard power-off before it was written,
    // disk cleanup, an older build) while the adapter is still pointing at the
    // dead 127.0.0.1 resolver — meaning no DNS at all, so the update check would
    // fail and the user would be left fixing DNS by hand. preflightDns() asks the
    // OS directly, repairs the stranded adapters, and only reports a problem when
    // the automatic repair didn't take. Kicked off here (not awaited) so the
    // window still appears instantly; the updater screen invokes 'dns-preflight'
    // and receives this very same in-flight promise, so the scan happens once and
    // the update check waits for its result.
    try { dns.preflightDns(); } catch (e) {}

    // Branch on first-launch state: if the user hasn't completed onboarding
    // (no language / auto-update preferences yet) show the onboarding wizard
    // first. Otherwise honour their saved auto-update preference.
    let onboarded = false;
    try { onboarded = settings.readSettingsFile().onboarded === true; } catch (e) {}

    if (!onboarded) {
        windows.createOnboardingWindow();
    } else {
        proceedAfterOnboarding();
    }

    // Kick off fake-TLS/QUIC payload download in the background. We don't
    // block startup on this — profiles that require these files will simply
    // pick a fallback path until the download finishes.
    payloads.ensureFakePayloads();

    // Ship the TR master blocked-domain hostlist to userData/zapret-lists/.
    // Rewritten every launch so list updates ship with the app, not with the
    // user's local file edits.
    hostlists.ensureTrMasterList();
});

app.on('will-quit', () => {
    // Fallback cleanup for any quit path that bypassed performFullQuit() (e.g. the
    // OS closing the last window). Idempotent — a no-op if cleanup already ran, so
    // DNS revert + process kills happen exactly once no matter how we exit.
    quit.runQuitCleanup();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') { app.quit(); } });
