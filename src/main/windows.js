// ==========================================
// --- WINDOW + TRAY LIFECYCLE ---
// ==========================================
// Owns every BurnedWolf window. The main window (titlebar) is the whole app now:
// DPI control, analysis and DNS all live inside it. Discord and Verify stay as
// their own windows (a heavy webview and a distinct repair flow) and are opened
// through the open-*-window IPC channels; the tray menu reuses the same functions.
const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron');
const path = require('path');
const { ROOT, CURRENT_VERSION } = require('./constants');

let win = null;              // main window (titlebar) — the whole app
let tray = null;
let exitWindow = null;
let updaterWindow = null;
let onboardingWindow = null;

// Window sizes are measured against real content at the longest translation
// (Turkish and Russian strings run materially longer than English), not picked
// by eye. The exit dialog used to be 340px tall holding 447px of content, which
// cut its footer off entirely; every size here was re-derived after that.
//
// The main window is resizable with a floor, so a small laptop screen still
// gets a working layout instead of a clipped one.
const NORMAL_SIZE  = { w: 1000, h: 700 };
const NORMAL_MIN   = { w: 880,  h: 620 };
const DISCORD_SIZE = { w: 1200, h: 820 };
const DISCORD_MIN  = { w: 900,  h: 640 };

// ==========================================
// --- UNIVERSAL STEALTH TRAY SYSTEM ---
// ==========================================
let hiddenWindowsTracker = [];

function hideAllAppWindowsToTray() {
    hiddenWindowsTracker = [];
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed() && (w.isVisible() || w.isMinimized())) {
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

// Maximize / restore for the module windows. We DON'T use Electron's
// maximize()/unmaximize() here: on transparent + frameless windows (the style every
// module uses) those are unreliable — restore() can be a complete no-op, so a
// maximized window could never be shrunk back. Instead we toggle the bounds by
// hand against the display's work area and remember the pre-maximize rectangle,
// which behaves identically on transparent windows. We also tell the renderer to
// swap its maximize/restore icon, since no native maximize/unmaximize event fires.
function toggleWindowMaximize(w) {
    if (!w || w.isDestroyed()) return;
    if (w._bwRestoreBounds) {
        // --- restore ---
        try { w.setBounds(w._bwRestoreBounds); } catch (e) {}
        w._bwRestoreBounds = null;
        if (!w.isDestroyed()) w.webContents.send('window-restored');
    } else {
        // --- maximize ---
        w._bwRestoreBounds = w.getBounds();
        let area;
        try { area = screen.getDisplayMatching(w.getBounds()).workArea; }
        catch (e) { area = screen.getPrimaryDisplay().workArea; }
        try { w.setBounds(area); } catch (e) {}
        if (!w.isDestroyed()) w.webContents.send('window-maximized');
    }
}

// ==========================================
// --- 1. PHASE: UPDATER WINDOW ---
// ==========================================
function createUpdaterWindow() {
    // Guard: never stack two updater windows. If one is already open (e.g. the
    // tray "install update" item clicked twice), just surface the existing one.
    if (updaterWindow && !updaterWindow.isDestroyed()) {
        try { updaterWindow.show(); updaterWindow.focus(); } catch (e) {}
        return;
    }
    updaterWindow = new BrowserWindow({
        width: 620, height: 470, frame: false, transparent: false, backgroundColor: '#0e1118', alwaysOnTop: true, skipTaskbar: true,
        resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    updaterWindow.loadFile('updater.html');
    updaterWindow.on('closed', () => { updaterWindow = null; });
}

// ==========================================
// --- ONBOARDING WINDOW (first-launch only) ---
// ==========================================
function createOnboardingWindow() {
    onboardingWindow = new BrowserWindow({
        width: 600, height: 560, frame: false, transparent: false, backgroundColor: '#0e1118', alwaysOnTop: true, skipTaskbar: true,
        resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    onboardingWindow.loadFile('onboarding.html');
    onboardingWindow.on('closed', () => { onboardingWindow = null; });
}

// ==========================================
// --- TRAY MENU (rebuildable) ---
// ==========================================
// The tray menu gains an "Install update" item only while a check (background or
// manual) has found a newer build. Kept behind a builder so refreshUpdateTray()
// can rebuild it when that state changes, without disturbing the rest of the app.
let pendingUpdateInfo = null;

function showMainFromTray() {
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
}

function buildTrayMenu() {
    const items = [
        { label: 'Show BurnedWolf', click: showMainFromTray }
    ];
    if (pendingUpdateInfo && pendingUpdateInfo.new) {
        items.push({ type: 'separator' });
        items.push({ label: `Install update (v${pendingUpdateInfo.new})`, click: () => createUpdaterWindow() });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Quit BurnedWolf', click: () => attemptExit() });
    return Menu.buildFromTemplate(items);
}

// Called by the updater module whenever a check changes the pending-update state.
// No-op safe before the tray exists (early boot).
function refreshUpdateTray(info) {
    pendingUpdateInfo = (info && info.new) ? info : null;
    if (tray && !tray.isDestroyed()) {
        try { tray.setContextMenu(buildTrayMenu()); } catch (e) {}
        try {
            tray.setToolTip(pendingUpdateInfo
                ? `BurnedWolf · Update v${pendingUpdateInfo.new} available`
                : 'BurnedWolf System Gateway');
        } catch (e) {}
    }
}

// ==========================================
// --- 2. PHASE: MAIN SCREEN ---
// ==========================================
function createMainWindow() {
    // Guard: the app has exactly one main window. Opening the updater window
    // mid-session ends in 'proceed-to-splash' → createMainWindow(); without this
    // guard that path would spawn a SECOND main window over the running app.
    if (win && !win.isDestroyed()) {
        try { win.show(); win.focus(); } catch (e) {}
        return;
    }
    win = new BrowserWindow({
        width: NORMAL_SIZE.w, height: NORMAL_SIZE.h,
        minWidth: NORMAL_MIN.w, minHeight: NORMAL_MIN.h,
        icon: path.join(ROOT, 'icon.png'),   // icon.ico has never existed here
        title: "BurnedWolf Gateway",
        frame: false,
        // The Flat Weave shell is an opaque piece of cloth with a hard edge —
        // there is nothing to see through, so transparency only costs a
        // compositing path and the odd Windows repaint artefact.
        transparent: false,
        backgroundColor: '#0e1118',
        resizable: true,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            sandbox: false,
            webviewTag: true,
            backgroundThrottling: false
        }
    });

    win.loadFile(path.join(ROOT, 'renderer', 'titlebar.html')).catch(() => {
        win.loadFile('titlebar.html');
    });

    win.once('ready-to-show', () => {
        win.show();
    });

    win.webContents.on('did-finish-load', () => {
        win.webContents.send('app-name', "BURNEDWOLF");
        win.webContents.send('app-version', CURRENT_VERSION);
    });

    tray = new Tray(path.join(ROOT, 'icon.png'));
    tray.setToolTip("BurnedWolf System Gateway");

    // Tray right-click menu: show main window, (optionally) install a pending
    // update, and quit. Built via buildTrayMenu() so it can be rebuilt later.
    tray.setContextMenu(buildTrayMenu());
    // If a check already found an update before the tray existed, reflect it now.
    refreshUpdateTray(pendingUpdateInfo);

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

// ==========================================
// --- EXIT DIALOG ---
// ==========================================
function attemptExit() {
    if (exitWindow) return;
    exitWindow = new BrowserWindow({
        width: 430, height: 260, frame: false, transparent: false, backgroundColor: '#0e1118', alwaysOnTop: true, parent: win, modal: true, resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    exitWindow.loadFile('exit-dialog.html');
    exitWindow.on('closed', () => { exitWindow = null; });
}

function destroyTray() {
    try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch (e) {}
    tray = null;
}

// ==========================================
// --- IPC: WINDOW MANAGEMENT ---
// ==========================================
ipcMain.on('minimize-window', () => { hideAllAppWindowsToTray(); });
ipcMain.on('maximize-window', () => { if (win.isMaximized()) win.unmaximize(); else win.maximize(); });
ipcMain.on('completely-exit', () => attemptExit());
ipcMain.on('exit-no', () => { if (exitWindow) exitWindow.close(); if (win) win.webContents.send('exit-cancelled'); });

// Discord and File Integrity now render INSIDE the main window as views (see
// renderer/titlebar). The Discord view embeds a full webview, so the renderer
// asks us to grow the window when it opens and shrink back when it leaves.
ipcMain.on('set-window-mode', (event, mode) => {
    if (!win || win.isDestroyed()) return;
    const s = mode === 'discord' ? DISCORD_SIZE : NORMAL_SIZE;
    const min = mode === 'discord' ? DISCORD_MIN : NORMAL_MIN;
    try {
        // Relax the floor before growing, tighten it after shrinking, so setSize
        // is never clamped by a stale minimum. Only grow the window when the
        // user is actually smaller than the target — resizing someone's
        // deliberately enlarged window back down is hostile.
        win.setMinimumSize(Math.min(min.w, s.w), Math.min(min.h, s.h));
        const [cw, ch] = win.getSize();
        if (cw < s.w || ch < s.h) {
            win.setSize(Math.max(cw, s.w), Math.max(ch, s.h));
            win.center();
        }
        win.setMinimumSize(min.w, min.h);
    } catch (e) {}
});

module.exports = {
    createMainWindow,
    createUpdaterWindow,
    createOnboardingWindow,
    refreshUpdateTray,
    attemptExit,
    destroyTray,
    getMainWindow:       () => win,
    getUpdaterWindow:    () => updaterWindow,
    getOnboardingWindow: () => onboardingWindow
};
