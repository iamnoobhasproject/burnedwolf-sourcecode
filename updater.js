// ==========================================================================
// --- UPDATER WINDOW ---
// ==========================================================================
// Boot order matters and is deliberate:
//   1. DNS self-check / repair   ← nothing else can work without name resolution
//   2. update check
//   3. download → extract → relaunch
//
// Step 1 is why this file exists in its current shape. If a previous session
// left the machine resolving through 127.0.0.1 with dnscrypt-proxy gone, the
// update check simply times out and the user is stuck being told to "check your
// connection". The main process already tried to repair it at launch; here we
// wait for that result, show it, and offer a manual repair when it failed.

const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- the loom
const checkLoom = LOOM.weave($('checkLoom'), { pps: 10 });
const updLoom   = LOOM.weave($('updLoom'),   { pps: 10 });
const dlLoom    = LOOM.weave($('dlLoom'),    { pps: 15 });

// Woven progress: discrete picks of weft. Cells are built once and only their
// class flips, so a progress update never touches layout.
function meter(el, frac, cells) {
    if (!el) return;
    const n = cells || 30;
    if (el.childElementCount !== n) {
        el.replaceChildren();
        for (let i = 0; i < n; i++) el.appendChild(document.createElement('i'));
    }
    const f = Math.round(Math.max(0, Math.min(1, frac)) * n);
    Array.from(el.children).forEach((c, i) => c.classList.toggle('f', i < f));
}

const ZONE = {
    dnsCheckState: 'dnsfix.label_dns',
    dnsFixedState: 'dnsfix.label_dns',
    dnsBrokenState: 'dnsfix.label_dns',
    checkState: 'updater.label_updater',
    updateAvailableState: 'updater.label_update',
    progressState: 'updater.label_installing',
    upToDateState: 'updater.label_ready',
    errorState: 'updater.label_offline'
};

function showState(id) {
    document.querySelectorAll('.state').forEach(el => el.classList.remove('on'));
    const el = $(id);
    if (el) el.classList.add('on');
    if (ZONE[id]) $('zone').textContent = i18n.t(ZONE[id]);
}
ipcRenderer.on('language-changed', () => {
    const a = document.querySelector('.state.on');
    if (a && ZONE[a.id]) setTimeout(() => { $('zone').textContent = i18n.t(ZONE[a.id]); }, 60);
});

// ==========================================================================
// STEP 1 — DNS SELF-CHECK
// ==========================================================================
let dnsStepDone = false;

function proceedToUpdateCheck() {
    if (dnsStepDone) return;
    dnsStepDone = true;
    showState('checkState');
    setTimeout(() => ipcRenderer.send('check-update'), 600);
}

async function runDnsPreflight() {
    let res = null;
    try {
        // The main process kicked this off at launch; invoking returns that same
        // in-flight promise, so the scan happens exactly once.
        res = await ipcRenderer.invoke('dns-preflight');
    } catch (e) { res = null; }

    if (!res || res.state === 'healthy' || res.state === 'local_resolver' || res.state === 'error') {
        proceedToUpdateCheck();
        return;
    }
    if (res.state === 'repaired') {
        const names = (res.adaptersFixed || []).join(', ');
        showState('dnsFixedState');
        if (names) $('dnsFixedSub').textContent = i18n.t('dnsfix.fixed_text_named', { a: names });
        setTimeout(proceedToUpdateCheck, 1900);
        return;
    }
    showState('dnsBrokenState');
}

$('btnDnsRepair').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add('busy'); btn.textContent = i18n.t('dnsfix.working');
    let r = null;
    try { r = await ipcRenderer.invoke('dns-residue-fix'); } catch (err) {}
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label;
    if (r && r.ok) {
        showState('dnsFixedState');
        const names = (r.adaptersFixed || []).join(', ');
        if (names) $('dnsFixedSub').textContent = i18n.t('dnsfix.fixed_text_named', { a: names });
        setTimeout(proceedToUpdateCheck, 1700);
    } else {
        // Still broken: don't trap the user in the updater — let them in.
        proceedToUpdateCheck();
    }
});
$('btnDnsSkip').addEventListener('click', proceedToUpdateCheck);

setTimeout(runDnsPreflight, 700);
setTimeout(proceedToUpdateCheck, 9000);

// ==========================================================================
// STEP 2 — UPDATE CHECK
// ==========================================================================
ipcRenderer.on('update-available', (event, info) => {
    $('versionText').textContent = `${info.current}  →  ${info.new}`;
    showState('updateAvailableState');
});

ipcRenderer.on('up-to-date', () => {
    showState('upToDateState');
    setTimeout(() => { ipcRenderer.send('proceed-to-splash'); }, 1300);
});

ipcRenderer.on('server-error', () => showState('errorState'));

// Declining an update, or failing to reach the update server, must never lock
// the user out of the app they already have installed — this is a censorship
// bypass tool, so "the update channel is unreachable" is a situation it has to
// keep working in, not a fatal error. Both buttons continue into the app.
$('btnUpdateClose').addEventListener('click', () => ipcRenderer.send('proceed-to-splash'));
$('btnErrorClose').addEventListener('click', () => ipcRenderer.send('proceed-to-splash'));

$('btnErrorRepair').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add('busy'); btn.textContent = i18n.t('dnsfix.working');
    try { await ipcRenderer.invoke('dns-residue-fix'); } catch (err) {}
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label;
    showState('checkState');
    setTimeout(() => ipcRenderer.send('check-update'), 700);
});

// ==========================================================================
// STEP 3 — DOWNLOAD / INSTALL
// ==========================================================================
$('btnUpdate').addEventListener('click', () => {
    showState('progressState');
    ipcRenderer.send('start-download');
});

ipcRenderer.on('download-progress', (e, percent) => {
    meter($('dlMeter'), percent / 100);
    $('statusText').textContent = `${i18n.t('updater.downloading')} · ${percent}%`;
});

ipcRenderer.on('extracting', () => {
    meter($('dlMeter'), 1);
    $('dlMeter').classList.add('warn');
    $('statusText').textContent = i18n.t('updater.extracting');
});

ipcRenderer.on('extraction-done', () => {
    let left = 10;
    $('dlMeter').classList.remove('warn');
    $('dlMeter').classList.add('ok');
    LOOM.stop(dlLoom);
    const t = setInterval(() => {
        $('statusText').textContent = i18n.t('updater.restart_in', { n: left });
        left--;
        if (left < 0) {
            clearInterval(t);
            $('statusText').textContent = i18n.t('updater.shutting_down');
            ipcRenderer.send('apply-update');
        }
    }, 1000);
});
