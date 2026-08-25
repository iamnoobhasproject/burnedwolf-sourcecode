/* ==========================================================================
   BURNEDWOLF — MAIN WINDOW
   --------------------------------------------------------------------------
   Every IPC channel below is unchanged from the working build; this file was
   rewritten for the Flat Weave world, not for new behaviour.
   ========================================================================== */
const { ipcRenderer, clipboard } = require('electron');
const i18n = require('../i18n');

const i18nReady = i18n.init();
i18nReady.then(() => { try { repaintDynamic(); } catch (e) {} });

const $ = (id) => document.getElementById(id);

function repaintDynamic() {
    highlightActiveLang();
    paintState();
    paintDns();
    paintTor();
    paintHealth();
    paintAi();
    paintHints();
}

// ==========================================
// --- WOVEN METER ---
// ==========================================
// Progress as discrete picks of weft. Cells are built once and only their
// class flips, so a progress update never touches layout.
function meter(el, frac, cells) {
    if (!el) return;
    const n = cells || 24;
    if (el.childElementCount !== n) {
        el.replaceChildren();
        for (let i = 0; i < n; i++) el.appendChild(document.createElement('i'));
    }
    const filled = Math.round(Math.max(0, Math.min(1, frac)) * n);
    Array.from(el.children).forEach((c, i) => c.classList.toggle('f', i < filled));
}

// ==========================================
// --- THE LOOM (3D) ---
// ==========================================
const guard = LOOM.guard($('guardMotif'));
const bootLoom = LOOM.weave($('bootLoom'), { pps: 11 });
let usageBars = null;

// ==========================================
// --- BOOT ---
// ==========================================
let booted = false;
const BOOT_STEPS = [['boot.init', .16], ['boot.engine', .42], ['boot.network', .68], ['boot.ai', .88]];
i18nReady.then(function runBoot() {
    let i = 0;
    (function tick() {
        if (booted || i >= BOOT_STEPS.length) return;
        const [k, f] = BOOT_STEPS[i++];
        const s = document.querySelector('[data-boot-status]');
        if (s) s.textContent = i18n.t(k);
        meter($('bootMeter'), f, 20);
        setTimeout(tick, 240);
    })();
});
function finishBoot() {
    if (booted) return;
    booted = true;
    const s = document.querySelector('[data-boot-status]');
    if (s) s.textContent = i18n.t('boot.ready');
    meter($('bootMeter'), 1, 20);
    setTimeout(() => {
        $('bootScreen').classList.add('gone');
        LOOM.stop(bootLoom);
    }, 300);
}
setTimeout(finishBoot, 4200);

// ==========================================
// --- VIEWS ---
// ==========================================
const views = ['homeView', 'aiView', 'aiSetupView', 'aiProviderView', 'aiLimitView', 'aiAuditView',
    'dnsView', 'analysisView', 'statsView', 'verifyView', 'discordView', 'advancedView', 'builderView', 'proxyView', 'bridgesView', 'donateView', 'settingsView'];
const RAIL_OF = { aiSetupView: 'aiView', aiProviderView: 'aiView', aiLimitView: 'aiView', aiAuditView: 'aiView', builderView: 'advancedView', proxyView: 'advancedView', bridgesView: 'advancedView' };
let windowMode = 'normal';
let currentView = 'homeView';

function showView(id) {
    if (!views.includes(id)) return;
    currentView = id;
    views.forEach(v => {
        const el = $(v);
        if (!el) return;
        const on = v === id;
        el.hidden = !on;
        if (on) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
    });
    const target = RAIL_OF[id] || id;
    document.querySelectorAll('.rbtn').forEach(b => b.classList.toggle('on', b.dataset.nav === target));

    const want = id === 'discordView' ? 'discord' : 'normal';
    if (want !== windowMode) { windowMode = want; ipcRenderer.send('set-window-mode', want); }

    if (id === 'dnsView') refreshDns();
    if (id === 'advancedView') reflectFailover();
    if (id === 'discordView') initDiscord();
    if (id === 'aiView') scrollChat();
    if (id === 'aiSetupView') renderProviders();
    if (id === 'aiLimitView') refreshUsage();
    if (id === 'aiAuditView') renderAudit();
    if (id === 'statsView') refreshStats();
    if (id === 'builderView') openBuilder();
    if (id === 'proxyView') openProxy();
    if (id === 'bridgesView') openBridges();
    if (id === 'donateView') paintDonate();
}

const rail = Array.from(document.querySelectorAll('.rbtn'));
rail.forEach((b, i) => {
    b.addEventListener('click', () => {
        if (b.dataset.nav === 'aiView') { openAi(); return; }
        showView(b.dataset.nav);
    });
    b.addEventListener('keydown', (e) => {
        let next = null;
        if (e.key === 'ArrowDown') next = rail[(i + 1) % rail.length];
        else if (e.key === 'ArrowUp') next = rail[(i - 1 + rail.length) % rail.length];
        else if (e.key === 'Home') next = rail[0];
        else if (e.key === 'End') next = rail[rail.length - 1];
        if (next) { e.preventDefault(); next.focus(); }
    });
});
document.querySelectorAll('.nav-back').forEach(b => b.addEventListener('click', () => showView('homeView')));
$('cardDns').addEventListener('click', () => showView('dnsView'));
$('cardDiscord').addEventListener('click', () => showView('discordView'));
$('cardHealth').addEventListener('click', () => showView('analysisView'));
$('cardAi').addEventListener('click', () => openAi());

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if ($('donateOverlay').classList.contains('show')) { closeDonate(); return; }
        if ($('notesOverlay').classList.contains('show')) { closeNotes(); return; }
        if (currentView !== 'homeView') showView('homeView');
    }
});
$('exit').addEventListener('click', () => ipcRenderer.send('minimize-window'));
$('btnMinimize').addEventListener('click', () => ipcRenderer.send('minimize-window'));

// ==========================================
// --- ENGINE STATE ---
// ==========================================
const stateText = $('stateText');
const stateSub = $('stateSub');
const btnPower = $('btnPower');
const btnPowerLabel = $('btnPowerLabel');
const profileSelect = $('profileSelect');
const btnAutoPick = $('btnAutoPick');

let engineRunning = false, engineMode = null, engineError = false;
let startedAt = null, lastHealth = null;
let profileLabels = {}, whitelistCache = '', savedCustomArgs = [], userProfilesMap = {};

const profileLabel = (id) => !id ? '' : (id === 'custom' ? (profileLabels.custom || 'Custom') : (profileLabels[id] || id.toUpperCase()));

function uptime() {
    if (!startedAt) return null;
    const m = Math.floor((Date.now() - startedAt) / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? i18n.t('home.uptime_hm', { h, m: m % 60 }) : i18n.t('home.uptime_m', { m });
}

function paintState() {
    stateText.textContent = i18n.t(engineError ? 'home.protection_err' : (engineRunning ? 'home.protection_on' : 'home.protection_off'));
    stateText.classList.toggle('on', engineRunning && !engineError);
    btnPowerLabel.textContent = i18n.t(engineRunning ? 'home.stop' : 'home.start');
    btnPower.classList.toggle('plain', engineRunning);
    if (guard) guard.set(engineRunning && !engineError);

    if (engineError) stateSub.textContent = i18n.t('home.err_sub');
    else if (engineRunning) {
        const parts = [i18n.t('home.profile_running', { p: profileLabel(engineMode) })];
        const u = uptime(); if (u) parts.push(u);
        stateSub.textContent = parts.join(' · ');
    } else stateSub.textContent = i18n.t('home.stopped_sub');

    profileSelect.disabled = engineRunning;
    btnAutoPick.disabled = engineRunning;
    $('btnChangeProfile').disabled = engineRunning;
    document.querySelector('.rbtn[data-nav="homeView"]').classList.toggle('hot', engineRunning);
    paintHealth();
}

function paintHealth() {
    const val = $('healthVal'), sub = $('healthSub');
    if (!engineRunning) { val.textContent = '—'; sub.textContent = i18n.t('home.health_idle'); return; }
    if (lastHealth && lastHealth.percent != null) {
        val.textContent = '%' + lastHealth.percent;
        sub.textContent = i18n.t('home.health_samples', { ok: lastHealth.ok, n: lastHealth.samples });
    } else {
        val.textContent = i18n.t('home.measuring');
        sub.textContent = i18n.t('home.health_wait');
    }
}

btnPower.addEventListener('click', () => {
    if (engineRunning) ipcRenderer.send('stop-zapret');
    else {
        engineError = false;
        const mode = profileSelect.value || 'bw_standard';
        ipcRenderer.send('start-zapret', {
            mode,
            customArgs: argsForProfile(mode),
            whitelistData: whitelistCache,
            failover: !!(failoverToggle && failoverToggle.checked && !failoverToggle.disabled)
        });
    }
    btnPower.disabled = true;
});

ipcRenderer.on('zapret-status', (e, status) => {
    if (status === 'running') {
        engineRunning = true; engineError = false;
        engineMode = profileSelect.value || engineMode;
        if (!startedAt) startedAt = Date.now();
    } else if (status === 'error') {
        engineRunning = false; engineError = true; startedAt = null; lastHealth = null;
    } else {
        engineRunning = false; engineMode = null; startedAt = null; lastHealth = null;
    }
    btnPower.disabled = false;
    paintState();
});

setInterval(async () => {
    if (!engineRunning) return;
    try {
        const h = await ipcRenderer.invoke('get-engine-health');
        lastHealth = (h && h.percent != null) ? h : null;
    } catch (e) {}
    paintState();
}, 15000);

// ==========================================
// --- PROFILE + ISP ---
// ==========================================
const ispText = $('ispText');
let detectedISP = null, recommended = [];

$('btnChangeProfile').addEventListener('click', () => {
    const w = $('profileWrap');
    const open = w.classList.toggle('show');
    $('btnChangeProfile').textContent = i18n.t(open ? 'home.done' : 'home.change');
    if (open) profileSelect.focus();
});

function paintProfileName() {
    $('profileName').textContent = profileLabel(profileSelect.value) || '—';
}

async function loadProfiles() {
    try {
        const profiles = await ipcRenderer.invoke('get-dpi-profiles');
        if (!Array.isArray(profiles)) return;
        profileSelect.replaceChildren();
        const order = ['Generic', 'Turkey', 'Russia', 'Europe', 'Middle East', 'Asia'];
        const groups = new Map(); const seen = [];
        for (const p of profiles) {
            profileLabels[p.id] = p.label;
            if (!groups.has(p.region)) { groups.set(p.region, []); seen.push(p.region); }
            groups.get(p.region).push(p);
        }
        const regions = order.filter(r => groups.has(r)).concat(seen.filter(r => !order.includes(r)));
        for (const region of regions) {
            const og = document.createElement('optgroup');
            og.label = region;
            for (const p of groups.get(region)) {
                const o = document.createElement('option');
                o.value = p.id; o.textContent = p.label;
                og.appendChild(o);
            }
            profileSelect.appendChild(og);
        }
        decorate();
        const saved = await ipcRenderer.invoke('settings-get', 'last_profile');
        const target = engineMode || saved;
        profileSelect.value = (target && (profileLabels[target] || target === 'custom')) ? target : 'bw_standard';
        paintProfileName();
        paintState();
    } catch (e) {}
}

function decorate() {
    Array.from(profileSelect.querySelectorAll('option')).forEach(o => {
        const base = profileLabels[o.value] || o.textContent.replace(/^★\s*/, '');
        o.textContent = (recommended.includes(o.value) ? '★ ' : '') + base;
    });
}

profileSelect.addEventListener('change', () => {
    ipcRenderer.invoke('settings-set', 'last_profile', profileSelect.value);
    paintProfileName();
});

async function detectISP() {
    try {
        const r = await ipcRenderer.invoke('detect-isp', {});
        detectedISP = r;
        if (r && r.detected) {
            ispText.textContent = r.asn ? `${r.ispLabel} · AS${r.asn}` : r.ispLabel;
            recommended = Array.isArray(r.recommendedProfiles) ? r.recommendedProfiles.slice() : [];
            decorate();
            paintProfileName();
        } else ispText.textContent = i18n.t('home.isp_unknown');
    } catch (e) { ispText.textContent = i18n.t('home.isp_unknown'); }
    reflectFailover();
}

btnAutoPick.addEventListener('click', () => {
    if (engineRunning) return;
    const recs = recommended.filter(id => profileLabels[id]);
    if (recs.length) {
        profileSelect.value = recs[0];
        ipcRenderer.invoke('settings-set', 'last_profile', recs[0]);
        paintProfileName();
    } else ispText.textContent = i18n.t('home.isp_unknown');
});

// ==========================================
// --- WHITELIST ---
// ==========================================
ipcRenderer.on('whitelist-data', (e, data) => {
    whitelistCache = data || '';
    const ta = $('whitelistInput');
    if (ta && document.activeElement !== ta) ta.value = whitelistCache;
});
ipcRenderer.send('load-whitelist');

// ==========================================
// --- DNS ---
// ==========================================
const dohToggle = $('dohToggle');
let dnsStatus = null;

const DNS_PRESETS = [
    { key: 'cloudflare', name: 'Cloudflare', meta: '1.1.1.1' },
    { key: 'google', name: 'Google', meta: '8.8.8.8' },
    { key: 'quad9', name: 'Quad9', meta: '9.9.9.9' },
    { key: 'adguard', name: 'AdGuard', meta: '94.140.14.14' }
];

function buildPresets() {
    const box = $('dnsPresets');
    if (!box || box.childElementCount) return;
    DNS_PRESETS.forEach(p => {
        const row = document.createElement('label');
        row.className = 'preset';
        row.innerHTML = `<input type="radio" name="dns-pick" value="${p.key}"><span class="pn"></span><span class="pm"></span>`;
        row.querySelector('.pn').textContent = p.name;
        row.querySelector('.pm').textContent = p.meta;
        row.addEventListener('click', () => setTimeout(syncPresets, 0));
        row.querySelector('input').addEventListener('change', async () => {
            await ipcRenderer.invoke('apply-dns-preset', p.key);
            pushLog(`[DNS] ${p.name} (${p.meta})`);
            await refreshDns();
        });
        box.appendChild(row);
    });
}
function syncPresets() {
    document.querySelectorAll('#dnsPresets .preset').forEach(r => r.classList.toggle('on', r.querySelector('input').checked));
}

function paintDns() {
    const val = $('dnsVal'), sub = $('dnsSub'), pill = $('dnsStatePill'), cur = $('dnsCurrent');
    if (!dnsStatus) { val.textContent = '—'; sub.textContent = ''; return; }
    if (dnsStatus.isEncrypted) {
        val.textContent = i18n.t('home.on');
        sub.textContent = i18n.t('home.dns_active');
        if (pill) { pill.textContent = 'DoH'; pill.className = 'tag on'; }
        if (cur) cur.textContent = i18n.t('home.dns_active');
    } else {
        const p = dnsStatus.provider || (dnsStatus.isISP ? i18n.t('home.dns_isp_default') : (dnsStatus.raw || '—'));
        val.textContent = p;
        sub.textContent = i18n.t(dnsStatus.isISP ? 'home.dns_isp_warn' : 'home.dns_plain');
        if (pill) { pill.textContent = dnsStatus.isISP ? i18n.t('home.dns_isp_default') : 'OK'; pill.className = 'tag ' + (dnsStatus.isISP ? 'warn' : 'ok'); }
        if (cur) cur.textContent = dnsStatus.provider || ((dnsStatus.ipv4 && dnsStatus.ipv4.length) ? dnsStatus.ipv4.join(', ') : '—');
    }
    if (dohToggle) dohToggle.checked = !!dnsStatus.isEncrypted;
}

async function refreshDns() {
    buildPresets();
    try { dnsStatus = await ipcRenderer.invoke('get-dns-status'); } catch (e) {}
    paintDns();
}

dohToggle.addEventListener('change', async () => {
    dohToggle.disabled = true;
    try {
        if (dohToggle.checked) {
            const r = await ipcRenderer.invoke('start-encrypted-dns');
            if (r && !r.ok && r.error === 'binary_missing') $('dnsCurrent').textContent = i18n.t('home.dns_missing');
        } else await ipcRenderer.invoke('stop-encrypted-dns');
    } catch (e) {}
    await refreshDns();
    dohToggle.disabled = false;
});

$('btnDnsDhcp').addEventListener('click', async () => {
    await ipcRenderer.invoke('apply-dns-preset', 'dhcp');
    pushLog('[DNS] DHCP');
    document.querySelectorAll('#dnsPresets input').forEach(i => { i.checked = false; });
    syncPresets();
    await refreshDns();
});

ipcRenderer.on('encrypted-dns-status', () => refreshDns());
setInterval(() => { if (!$('dnsView').hidden) refreshDns(); }, 30000);

// ==========================================
// --- DoH RESIDUE ---
// ==========================================
const notice = $('dnsNotice');
function showNotice(kind, titleKey, textKey, args) {
    notice.classList.add('show');
    notice.classList.toggle('good', kind === 'ok');
    $('dnsNoticeTitle').textContent = i18n.t(titleKey, args);
    $('dnsNoticeText').textContent = i18n.t(textKey, args);
    $('btnFixResidue').style.display = kind === 'ok' ? 'none' : '';
    if (kind === 'ok') setTimeout(() => notice.classList.remove('show'), 7000);
}

ipcRenderer.on('dns-preflight-result', (e, r) => {
    if (!r) return;
    if (r.state === 'repaired') {
        const names = (r.adaptersFixed || []).join(', ');
        showNotice('ok', 'dnsfix.fixed_title', 'dnsfix.fixed_text', { a: names || '—' });
        pushLog(`[DNS] ${i18n.t('dnsfix.log_fixed')}${names ? ' — ' + names : ''}`);
    } else if (r.state === 'failed' || r.state === 'residue') {
        const partial = r.scan && r.scan.severity === 'partial';
        showNotice('warn', 'dnsfix.banner_title', partial ? 'dnsfix.banner_text_partial' : 'dnsfix.banner_text');
        pushLog('[DNS] ' + i18n.t('dnsfix.log_stranded'));
    } else notice.classList.remove('show');
    refreshDns();
});

async function runFix(btn) {
    const label = btn.textContent;
    btn.disabled = true; btn.classList.add('busy'); btn.textContent = i18n.t('dnsfix.working');
    try {
        const r = await ipcRenderer.invoke('dns-residue-fix');
        if (r && r.ok && r.repaired) showNotice('ok', 'dnsfix.fixed_title', 'dnsfix.fixed_text', { a: (r.adaptersFixed || []).join(', ') || '—' });
        else if (r && r.ok) showNotice('ok', 'dnsfix.none_title', 'dnsfix.none_text');
        else showNotice('warn', 'dnsfix.failed_title', 'dnsfix.failed_text');
    } catch (e) { showNotice('warn', 'dnsfix.failed_title', 'dnsfix.failed_text'); }
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = label;
    refreshDns();
}
$('btnFixResidue').addEventListener('click', (e) => runFix(e.currentTarget));
$('btnFixResidue2').addEventListener('click', (e) => runFix(e.currentTarget));

(async () => {
    try {
        const last = await ipcRenderer.invoke('dns-preflight-last');
        if (last && (last.state === 'failed' || last.state === 'residue')) showNotice('warn', 'dnsfix.banner_title', 'dnsfix.banner_text');
        else if (last && last.state === 'repaired') pushLog('[DNS] ' + i18n.t('dnsfix.log_fixed'));
    } catch (e) {}
})();

// ==========================================
// --- TOR / DISCORD readout ---
// ==========================================
let torReady = false;
function paintTor() {
    $('torSub').textContent = i18n.t(torReady ? 'home.tor_ready' : 'home.tor_idle');
    document.querySelector('.rbtn[data-nav="discordView"]').classList.toggle('hot', torReady);
}
ipcRenderer.on('tor-ready', () => { torReady = true; paintTor(); });

// ==========================================
// --- ANALYSIS ---
// ==========================================
const scanTerm = $('scanTerm');
const btnRunScan = $('btnRunScan'), btnCancelScan = $('btnCancelScan'), btnReport = $('btnReport');
let scanMode = 'quick', analysisLogs = [];

$('segQuick').addEventListener('click', () => setScanMode('quick'));
$('segDeep').addEventListener('click', () => setScanMode('deep'));
function setScanMode(m) {
    scanMode = m;
    $('segQuick').classList.toggle('on', m === 'quick');
    $('segDeep').classList.toggle('on', m === 'deep');
}

function clearEmpty(el) { const e = el.querySelector('.log-empty'); if (e) e.remove(); }

function scanLog(msg) {
    clearEmpty(scanTerm);
    const d = document.createElement('div');
    d.className = 'l';
    d.textContent = msg;
    if (/FATAL|ERROR|✗|FAILED/.test(msg)) d.classList.add('bad');
    else if (/PERFECT|APPLIED|✓ full|\[VOICE\]/.test(msg)) d.classList.add('ok');
    scanTerm.appendChild(d);
    scanTerm.scrollTop = scanTerm.scrollHeight;
    analysisLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function startScan() {
    scanTerm.replaceChildren();
    analysisLogs = [];
    $('topResults').style.display = 'none';
    $('topResults').replaceChildren();
    btnReport.style.display = 'none';
    btnRunScan.style.display = 'none';
    btnCancelScan.style.display = 'inline-flex';
    btnCancelScan.disabled = false;
    btnCancelScan.textContent = i18n.t('analysis.cancel');
    $('scanProgress').style.display = 'block';
    $('scanPhase').textContent = i18n.t('analysis.initializing');
    $('scanCount').textContent = '0 / 0';
    meter($('scanMeter'), 0, 30);
    $('scanTarget').textContent = '—';
    ipcRenderer.send('run-blockcheck', { mode: scanMode });
}
btnRunScan.addEventListener('click', startScan);
btnCancelScan.addEventListener('click', () => {
    btnCancelScan.disabled = true;
    btnCancelScan.textContent = i18n.t('analysis.cancelling');
    ipcRenderer.send('cancel-blockcheck');
});
function resetScan() { btnRunScan.style.display = 'inline-flex'; btnCancelScan.style.display = 'none'; }

ipcRenderer.on('blockcheck-log', (e, m) => scanLog(m));
ipcRenderer.on('blockcheck-progress', (e, d) => {
    if (!d) return;
    if (d.phase === 'phase1') $('scanPhase').textContent = i18n.t('analysis.phase1');
    else if (d.phase === 'phase2') $('scanPhase').textContent = i18n.t('analysis.phase2');
    if (typeof d.current === 'number' && typeof d.total === 'number' && d.total > 0) {
        $('scanCount').textContent = `${d.current} / ${d.total}`;
        meter($('scanMeter'), d.current / d.total, 30);
    }
    if (d.label) $('scanTarget').textContent = d.label;
});

function renderTop(top) {
    if (!Array.isArray(top) || !top.length) return;
    const box = $('topResults');
    box.replaceChildren();
    top.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'rank' + (i === 0 ? ' first' : '');
        row.innerHTML = `<span class="n">${i + 1}</span><span class="rb"><span class="rn"></span><span class="rm"><span class="num"></span><span class="${p.voice ? 'y' : 'n2'}"></span><span class="vd"></span></span></span>`;
        row.querySelector('.rn').textContent = p.name;
        row.querySelector('.num').textContent = `${p.score}/5 TCP`;
        row.querySelector(p.voice ? '.y' : '.n2').textContent = i18n.t(p.voice ? 'analysis.voice_ok' : 'analysis.voice_no');
        row.querySelector('.vd').textContent = p.vendor || '';
        box.appendChild(row);
    });
    box.style.display = 'block';
}

ipcRenderer.on('blockcheck-done', (e, data) => {
    localStorage.setItem('bw_custom_profile', JSON.stringify(data));
    loadCustom();
    profileSelect.value = 'custom';
    ipcRenderer.invoke('settings-set', 'last_profile', 'custom');
    paintProfileName();
    if (data.voice === true) scanLog('[VOICE] Profile supports Discord voice (UDP verified)');
    else if (data.voice === false) scanLog('[VOICE WARNING] Web-only — Discord calls may hang');
    renderTop(data.topProfiles);
    $('scanPhase').textContent = i18n.t('analysis.complete');
    meter($('scanMeter'), 1, 30);
    resetScan();
    btnReport.style.display = 'inline-flex';
});
ipcRenderer.on('blockcheck-status', (e, s) => {
    if (s === 'done') { resetScan(); $('scanProgress').style.display = 'none'; btnReport.style.display = 'inline-flex'; }
});

btnReport.addEventListener('click', () => {
    ipcRenderer.send('save-analysis-report',
        `=============================================\nBURNEDWOLF NETWORK ANALYSIS REPORT\nDate: ${new Date().toLocaleString()}\n=============================================\n\n` +
        analysisLogs.join('\n') + `\n\n=============================================\nBurnedWolf\n`);
});

function loadCustom() {
    const raw = localStorage.getItem('bw_custom_profile');
    let opt = profileSelect.querySelector('option[value="custom"]');
    if (raw) {
        try {
            const p = JSON.parse(raw);
            savedCustomArgs = p.args || [];
            profileLabels.custom = p.name || 'Custom';
            if (!opt) { opt = document.createElement('option'); opt.value = 'custom'; profileSelect.appendChild(opt); }
            opt.textContent = profileLabels.custom;
        } catch (e) {}
    } else if (opt) opt.remove();
}

// ==========================================
// --- PROFILE BUILDER ---
// ==========================================
// User-built DPI profiles live in localStorage 'bw_user_profiles' as
// [{ id, name, args:[] }]. They show in the main profile dropdown under
// "My profiles" and, when started, carry their own argv to the engine (which
// keeps the id for stats). The legacy scan-generated 'custom' slot is untouched.
function readUserProfiles() {
    try { const l = JSON.parse(localStorage.getItem('bw_user_profiles') || '[]'); return Array.isArray(l) ? l : []; }
    catch (e) { return []; }
}
function writeUserProfiles(list) {
    try { localStorage.setItem('bw_user_profiles', JSON.stringify(list)); } catch (e) {}
}

// Register saved user profiles: dropdown optgroup + label map + args map.
function loadUserProfiles() {
    userProfilesMap = {};
    const prev = profileSelect.querySelector('optgroup[data-user="1"]');
    if (prev) prev.remove();
    const list = readUserProfiles();
    if (!list.length) return list;
    const og = document.createElement('optgroup');
    og.label = i18n.t('builder.my_profiles');
    og.dataset.user = '1';
    list.forEach(p => {
        if (!p || !p.id) return;
        userProfilesMap[p.id] = { name: p.name || 'Custom', args: Array.isArray(p.args) ? p.args : [] };
        profileLabels[p.id] = p.name || 'Custom';
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name || 'Custom';
        og.appendChild(o);
    });
    profileSelect.appendChild(og);
    return list;
}

// argv a profile id should start with; null = resolve from the built-in catalog.
function argsForProfile(id) {
    if (id === 'custom') return savedCustomArgs;
    if (userProfilesMap[id]) return userProfilesMap[id].args;
    return null;
}

let bpEditingId = null;   // set when editing an existing saved profile

function tokenizeArgs(text) {
    return String(text || '').split(/\s+/).map(t => t.trim()).filter(Boolean);
}

function bpAnalyze(tokens) {
    const argStr = tokens.join(' ');
    const chains = tokens.filter(t => t === '--new').length + (tokens.length ? 1 : 0);
    const voice = argStr.includes('--filter-udp=50000-65535') || argStr.includes('--dpi-desync-any-protocol');
    const hasWf = tokens.some(t => t.startsWith('--wf-tcp') || t.startsWith('--wf-udp'));
    const hasDesync = tokens.some(t => t.startsWith('--dpi-desync'));
    const bad = tokens.filter(t => !t.startsWith('--'));
    return { chains, voice, hasWf, hasDesync, bad };
}

function bpRenderSummary() {
    if (!$('bpArgs')) return;
    const tokens = tokenizeArgs($('bpArgs').value);
    const a = bpAnalyze(tokens);
    const box = $('bpSummary');
    const warn = a.bad.length || !a.hasWf || !a.hasDesync;
    if (box) box.classList.toggle('warn', !!warn);
    $('bpSummaryTitle').textContent = i18n.t('builder.summary_title', { chains: a.chains, n: tokens.length });
    const parts = [ a.voice ? i18n.t('builder.voice_yes') : i18n.t('builder.voice_no') ];
    if (!a.hasWf) parts.push(i18n.t('builder.warn_nowf'));
    if (!a.hasDesync) parts.push(i18n.t('builder.warn_nodesync'));
    if (a.bad.length) parts.push(i18n.t('builder.warn_badtokens', { t: a.bad.slice(0, 3).join(', ') }));
    $('bpSummaryText').textContent = parts.join(' · ');
}

const BP_CHIPS = [
    '--new',
    '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
    '--filter-tcp=80,443', '--filter-tcp=443', '--filter-udp=443', '--filter-udp=50000-65535',
    '--dpi-desync=fake', '--dpi-desync=split2', '--dpi-desync=fake,split2', '--dpi-desync=fake,disorder2', '--dpi-desync=fake,multisplit',
    '--dpi-desync-fooling=md5sig', '--dpi-desync-fooling=md5sig,badseq',
    '--dpi-desync-autottl=2', '--dpi-desync-repeats=6', '--dpi-desync-split-pos=2', '--dpi-desync-any-protocol'
];

function bpBuildChips() {
    const box = $('bpChips');
    if (!box || box.childElementCount) return; // build once
    BP_CHIPS.forEach(flag => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = flag === '--new' ? i18n.t('builder.new_chain') : flag;
        b.title = flag;
        b.addEventListener('click', () => {
            const ta = $('bpArgs');
            const cur = ta.value.replace(/\s+$/, '');
            ta.value = (cur ? cur + '\n' : '') + flag + '\n';
            bpRenderSummary();
        });
        box.appendChild(b);
    });
}

function bpFillCloneOptions() {
    const sel = $('bpClone');
    if (!sel) return;
    sel.replaceChildren();
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = i18n.t('builder.clone_blank');
    sel.appendChild(blank);
    Object.keys(profileLabels).forEach(id => {
        if (id === 'custom' || userProfilesMap[id]) return; // built-ins only
        const o = document.createElement('option');
        o.value = id; o.textContent = profileLabels[id];
        sel.appendChild(o);
    });
}

function bpRenderList() {
    const box = $('bpList');
    if (!box) return;
    box.replaceChildren();
    const list = readUserProfiles();
    if (!list.length) {
        const e = document.createElement('div');
        e.className = 'rank-empty'; e.textContent = i18n.t('builder.none');
        box.appendChild(e);
        return;
    }
    list.forEach(p => {
        const row = document.createElement('div');
        row.className = 'rank';
        const rb = document.createElement('div'); rb.className = 'rb';
        const rn = document.createElement('div'); rn.className = 'rn'; rn.textContent = p.name || 'Custom';
        const rm = document.createElement('div'); rm.className = 'rm';
        const meta = document.createElement('span'); meta.textContent = i18n.t('builder.list_meta', { n: (p.args || []).length });
        rm.appendChild(meta);
        rb.append(rn, rm);
        const actions = document.createElement('div');
        actions.style.marginLeft = 'auto'; actions.style.display = 'flex'; actions.style.gap = 'var(--s2)';
        const useB = document.createElement('button'); useB.className = 'act plain sm'; useB.textContent = i18n.t('builder.use');
        useB.addEventListener('click', () => bpUse(p.id));
        const editB = document.createElement('button'); editB.className = 'act plain sm'; editB.textContent = i18n.t('builder.edit');
        editB.addEventListener('click', () => bpEdit(p.id));
        actions.append(useB, editB);
        row.append(rb, actions);
        box.appendChild(row);
    });
}

function openBuilder() {
    bpBuildChips();
    bpFillCloneOptions();
    bpRenderList();
    bpRenderSummary();
}

function bpNew() {
    bpEditingId = null;
    if ($('bpName')) $('bpName').value = '';
    if ($('bpArgs')) $('bpArgs').value = '';
    if ($('btnDeleteProfile')) $('btnDeleteProfile').style.display = 'none';
    if ($('bpStatus')) $('bpStatus').textContent = '';
    bpRenderSummary();
}

function bpEdit(id) {
    const p = readUserProfiles().find(x => x.id === id);
    if (!p) return;
    bpEditingId = id;
    $('bpName').value = p.name || '';
    $('bpArgs').value = (p.args || []).join('\n');
    $('btnDeleteProfile').style.display = '';
    $('bpStatus').textContent = '';
    bpRenderSummary();
    showView('builderView');
}

function bpUse(id) {
    loadUserProfiles();
    if (profileLabels[id] || id === 'custom') {
        profileSelect.value = id;
        ipcRenderer.invoke('settings-set', 'last_profile', id);
        paintProfileName();
    }
    showView('homeView');
}

function bpSave(useAfter) {
    const name = ($('bpName').value || '').trim();
    const args = tokenizeArgs($('bpArgs').value);
    if (!name) { $('bpStatus').textContent = i18n.t('builder.need_name'); return null; }
    if (!args.length) { $('bpStatus').textContent = i18n.t('builder.need_args'); return null; }
    const list = readUserProfiles();
    let id = bpEditingId;
    if (id) {
        const idx = list.findIndex(x => x.id === id);
        if (idx >= 0) list[idx] = { id, name, args }; else list.push({ id, name, args });
    } else {
        id = 'user_' + Date.now().toString(36);
        list.push({ id, name, args });
        bpEditingId = id;
    }
    writeUserProfiles(list);
    loadUserProfiles();
    if ($('btnDeleteProfile')) $('btnDeleteProfile').style.display = '';
    $('bpStatus').textContent = i18n.t('builder.saved');
    bpRenderList();
    if (useAfter) bpUse(id);
    return id;
}

function bpDelete() {
    if (!bpEditingId) return;
    const deleted = bpEditingId;
    writeUserProfiles(readUserProfiles().filter(x => x.id !== deleted));
    loadUserProfiles();
    if (profileSelect.value === deleted) {
        profileSelect.value = 'bw_standard';
        ipcRenderer.invoke('settings-set', 'last_profile', 'bw_standard');
        paintProfileName();
    }
    bpNew();
    bpRenderList();
}

// --- builder wiring ---
if ($('btnOpenBuilder')) $('btnOpenBuilder').addEventListener('click', () => { bpNew(); showView('builderView'); });
if ($('bpArgs')) $('bpArgs').addEventListener('input', bpRenderSummary);
if ($('btnCloneLoad')) $('btnCloneLoad').addEventListener('click', async () => {
    const id = $('bpClone').value;
    if (!id) return;
    let args = null;
    try { args = await ipcRenderer.invoke('get-profile-args', id); } catch (e) {}
    if (Array.isArray(args)) {
        $('bpArgs').value = args.join('\n');
        if (!$('bpName').value.trim()) $('bpName').value = (profileLabels[id] || id) + ' (copy)';
        bpRenderSummary();
    }
});
if ($('btnSaveProfile')) $('btnSaveProfile').addEventListener('click', () => bpSave(false));
if ($('btnSaveUseProfile')) $('btnSaveUseProfile').addEventListener('click', () => bpSave(true));
if ($('btnDeleteProfile')) $('btnDeleteProfile').addEventListener('click', bpDelete);
if ($('btnExportProfile')) $('btnExportProfile').addEventListener('click', async () => {
    const name = ($('bpName').value || '').trim() || 'Custom';
    const args = tokenizeArgs($('bpArgs').value);
    if (!args.length) { $('bpStatus').textContent = i18n.t('builder.need_args'); return; }
    let r = null;
    try { r = await ipcRenderer.invoke('profile-export', { name, args }); } catch (e) {}
    if (r && r.ok) $('bpStatus').textContent = i18n.t('builder.export_ok');
    else if (r && r.canceled) $('bpStatus').textContent = '';
    else $('bpStatus').textContent = i18n.t('builder.op_failed');
});
if ($('btnImportProfile')) $('btnImportProfile').addEventListener('click', async () => {
    let r = null;
    try { r = await ipcRenderer.invoke('profile-import'); } catch (e) {}
    if (r && r.ok) {
        bpEditingId = null;
        $('bpName').value = r.name || 'Imported';
        $('bpArgs').value = (r.args || []).join('\n');
        if ($('btnDeleteProfile')) $('btnDeleteProfile').style.display = 'none';
        $('bpStatus').textContent = i18n.t('builder.import_ok');
        bpRenderSummary();
    } else if (r && r.canceled) {
        $('bpStatus').textContent = '';
    } else if (r && r.error === 'invalid') {
        $('bpStatus').textContent = i18n.t('builder.import_invalid');
    } else {
        $('bpStatus').textContent = i18n.t('builder.op_failed');
    }
});

// ==========================================
// --- ADVANCED ---
// ==========================================
const failoverToggle = $('failoverToggle'), trMasterToggle = $('trMasterToggle');

(async () => {
    try { failoverToggle.checked = (await ipcRenderer.invoke('settings-get', 'dpi_failover')) === true; } catch (e) {}
    try {
        const s = await ipcRenderer.invoke('settings-get', 'dpi_use_tr_master_list');
        trMasterToggle.checked = s === undefined ? true : s === true;
    } catch (e) { trMasterToggle.checked = true; }
    try {
        const info = await ipcRenderer.invoke('get-tr-master-info');
        if (info && typeof info.count === 'number') $('trMasterCount').textContent = i18n.t('adv.trmaster_count', { n: info.count });
    } catch (e) {}
})();

failoverToggle.addEventListener('change', e => ipcRenderer.invoke('settings-set', 'dpi_failover', e.target.checked));
trMasterToggle.addEventListener('change', e => ipcRenderer.invoke('settings-set', 'dpi_use_tr_master_list', e.target.checked));

function reflectFailover() {
    const chain = Array.isArray(recommended) && recommended.length > 1;
    failoverToggle.disabled = !chain;
    if (!chain) { failoverToggle.checked = false; $('failoverHint').textContent = i18n.t('adv.failover_unavailable'); }
    else $('failoverHint').textContent = i18n.t('adv.failover_ready', { n: recommended.length });
}

$('btnSaveWhitelist').addEventListener('click', () => {
    const ta = $('whitelistInput');
    whitelistCache = ta.value;
    ipcRenderer.send('save-whitelist-only', ta.value);
    const t = $('saveToast');
    t.style.display = 'inline';
    setTimeout(() => t.style.display = 'none', 2000);
});

// ==========================================
// --- LOG ---
// ==========================================
const LOG_MAX = 150;
let logLines = [];
function pushLog(msg) {
    const d = new Date();
    const p = `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}]`;
    String(msg).split('\n').map(l => l.trim()).filter(Boolean).forEach(l => logLines.push(`${p} ${l}`));
    if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
    $('logLine').textContent = logLines[logLines.length - 1] || i18n.t('home.log_empty');
    if (!$('logPanel').hidden) { $('logBuf').textContent = logLines.join('\n'); $('logPanel').scrollTop = $('logPanel').scrollHeight; }
}
$('logBar').addEventListener('click', () => {
    const p = $('logPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) { $('logBuf').textContent = logLines.join('\n') || i18n.t('home.log_empty'); p.scrollTop = p.scrollHeight; }
});
ipcRenderer.on('zapret-log', (e, m) => pushLog(m));
ipcRenderer.on('tor-log', (e, m) => { if (String(m).includes('Bootstrapped')) pushLog(m); });

// ==========================================
// --- UPDATE NOTES ---
// ==========================================
const notesOverlay = $('notesOverlay');
// Closing the notes hands the screen to the support sheet, so the two never
// stack on top of each other at launch.
function closeNotes() { notesOverlay.classList.remove('show'); maybeDonate(); }
$('notesClose').addEventListener('click', closeNotes);
notesOverlay.addEventListener('click', e => { if (e.target === notesOverlay) closeNotes(); });

// Resolves true when the sheet actually went up — the boot sequence uses that
// to decide whether the support sheet may open immediately instead.
async function maybeNotes() {
    let on = true;
    try { on = (await ipcRenderer.invoke('settings-get', 'show_update_notes')) !== false; } catch (e) {}
    if (!on) return false;
    try {
        const res = await fetch('https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/logs.txt?t=' + Date.now());
        const lines = (await res.text()).split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return false;
        const body = $('notesBody');
        body.replaceChildren();
        lines.forEach(l => {
            const it = document.createElement('div');
            it.style.cssText = 'display:flex;gap:10px;padding:5px 0;font-size:13px;line-height:1.5;';
            it.innerHTML = '<span style="width:5px;height:5px;background:var(--madder);margin-top:8px;flex-shrink:0;"></span><span></span>';
            it.querySelector('span:last-child').textContent = l;
            body.appendChild(it);
        });
        try {
            const v = await (await fetch('https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/version.json?t=' + Date.now())).json();
            if (v && v.version) $('notesVersion').textContent = 'v' + v.version;
        } catch (e) {}
        notesOverlay.classList.add('show');
        return true;
    } catch (e) {}
    return false;
}

// ==========================================
// --- SUPPORT / DONATION ---
// ==========================================
// The address never lives here. Main owns it (src/main/donate.js) and this file
// only renders what main hands over, so a renderer-side mistake can't put a
// wrong address on screen or a renderer-supplied string into shell.openExternal.
const donateOverlay = $('donateOverlay');
let donateInfo = null;

async function paintDonate() {
    if (!donateInfo) {
        try { donateInfo = await ipcRenderer.invoke('donate-info'); } catch (e) { return; }
    }
    if (!donateInfo || !donateInfo.address) return;
    ['donateAddr', 'donateAddr2'].forEach(id => { const el = $(id); if (el) el.textContent = donateInfo.address; });
}

// Transient one-line feedback next to the buttons; clears itself so the panel
// doesn't keep a stale "Copied" sitting there for the rest of the session.
function donateSay(el, key, bad) {
    if (!el) return;
    el.textContent = i18n.t(key);
    el.classList.toggle('bad', !!bad);
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.textContent = ''; el.classList.remove('bad'); }, 2800);
}

async function donateCopy(said) {
    let ok = false;
    try { ok = (await ipcRenderer.invoke('donate-copy')) === true; } catch (e) {}
    donateSay(said, ok ? 'donate.copied' : 'donate.copy_failed', !ok);
}

async function donateWallet(said) {
    let r = null;
    try { r = await ipcRenderer.invoke('donate-open-wallet'); } catch (e) {}
    // No wallet registered for bitcoin: is the normal case, not an error worth
    // shouting about — the address and the QR are still right there.
    if (!r || !r.ok) donateSay(said, 'donate.no_wallet', true);
}

function closeDonate() { donateOverlay.classList.remove('show'); }
$('donateClose').addEventListener('click', closeDonate);
$('btnDonateLater').addEventListener('click', closeDonate);
donateOverlay.addEventListener('click', e => { if (e.target === donateOverlay) closeDonate(); });
$('btnDonateNever').addEventListener('click', async () => {
    try { await ipcRenderer.invoke('settings-set', 'show_donate', false); } catch (e) {}
    if ($('donateToggle')) $('donateToggle').checked = false;
    closeDonate();
});

$('btnDonateCopy').addEventListener('click', () => donateCopy($('donateSaid')));
$('btnDonateCopy2').addEventListener('click', () => donateCopy($('donateSaid2')));
$('btnDonateWallet').addEventListener('click', () => donateWallet($('donateSaid')));
$('btnDonateWallet2').addEventListener('click', () => donateWallet($('donateSaid2')));

// Launch policy. Asking for money on every single launch is how an app teaches
// people to close it fast, so: at most once per session, never stacked on the
// update notes, silenced permanently by "Don't show this again", and quiet for
// a week after each time it appears.
const DONATE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
let donateAsked = false;

async function maybeDonate() {
    if (donateAsked) return;
    donateAsked = true;
    try {
        if ((await ipcRenderer.invoke('settings-get', 'show_donate')) === false) return;
        const last = Number(await ipcRenderer.invoke('settings-get', 'donate_last_shown')) || 0;
        if (last && Date.now() - last < DONATE_COOLDOWN_MS) return;
        await ipcRenderer.invoke('settings-set', 'donate_last_shown', Date.now());
    } catch (e) { return; }
    await paintDonate();
    donateOverlay.classList.add('show');
}

// ==========================================
// --- VERSION + SETTINGS ---
// ==========================================
ipcRenderer.on('app-version', (e, v) => {
    $('versionDisplay').textContent = v;
    $('verChip').textContent = 'v' + v;
    localStorage.setItem('bw_current_version', v);
});

function highlightActiveLang() {
    const cur = i18n.getLang();
    document.querySelectorAll('.lang-pill').forEach(b => b.classList.toggle('on', b.dataset.lang === cur));
}
document.querySelectorAll('.lang-pill').forEach(b => b.addEventListener('click', async () => {
    await ipcRenderer.invoke('settings-set', 'language', b.dataset.lang);
    highlightActiveLang();
}));
highlightActiveLang();
ipcRenderer.on('language-changed', () => repaintDynamic());

const autoStartToggle = $('autoStartToggle');
(async () => {
    const on = (await ipcRenderer.invoke('settings-get', 'autostart')) === true;
    autoStartToggle.checked = on;
    ipcRenderer.send('set-autostart', on);
})();
autoStartToggle.addEventListener('change', async e => {
    await ipcRenderer.invoke('settings-set', 'autostart', e.target.checked);
    ipcRenderer.send('set-autostart', e.target.checked);
});

const autoUpdateToggle = $('autoUpdateToggle');
(async () => { const s = await ipcRenderer.invoke('settings-get', 'auto_update'); autoUpdateToggle.checked = s === undefined ? true : s === true; })();
autoUpdateToggle.addEventListener('change', e => ipcRenderer.invoke('settings-set', 'auto_update', e.target.checked));

const updateNotesToggle = $('updateNotesToggle');
(async () => { const s = await ipcRenderer.invoke('settings-get', 'show_update_notes'); updateNotesToggle.checked = s === undefined ? true : s === true; })();
updateNotesToggle.addEventListener('change', e => ipcRenderer.invoke('settings-set', 'show_update_notes', e.target.checked));

const donateToggle = $('donateToggle');
(async () => { const s = await ipcRenderer.invoke('settings-get', 'show_donate'); donateToggle.checked = s === undefined ? true : s === true; })();
donateToggle.addEventListener('change', async e => {
    await ipcRenderer.invoke('settings-set', 'show_donate', e.target.checked);
    // Turning it back on should mean "ask me next launch", not "wait out the
    // rest of a cooldown the user has already forgotten about".
    if (e.target.checked) await ipcRenderer.invoke('settings-set', 'donate_last_shown', 0);
});
$('btnOpenDonate').addEventListener('click', () => showView('donateView'));

// --- Manual "check for updates" + background-check badge ---
// The main process owns the actual version check (updater.js). Here we drive the
// Settings button and reflect a pending update as a rail badge + "Install now".
const btnCheckUpdate    = $('btnCheckUpdate');
const btnInstallUpdate  = $('btnInstallUpdate');
const checkUpdateStatus = $('checkUpdateStatus');

function setSettingsUpdateBadge(on) {
    const navBtn = document.querySelector('.rbtn[data-nav="settingsView"]');
    if (navBtn) navBtn.classList.toggle('has-update', !!on);
}
function markUpdateAvailable(v) {
    if (checkUpdateStatus) checkUpdateStatus.textContent = i18n.t('settings.update_found', { v });
    if (btnInstallUpdate) btnInstallUpdate.hidden = false;
    setSettingsUpdateBadge(true);
}

if (btnCheckUpdate) btnCheckUpdate.addEventListener('click', async () => {
    btnCheckUpdate.disabled = true;
    if (checkUpdateStatus) checkUpdateStatus.textContent = i18n.t('settings.checking');
    let r = null;
    try { r = await ipcRenderer.invoke('check-update-now'); } catch (e) {}
    btnCheckUpdate.disabled = false;
    if (!r || r.state === 'error') { if (checkUpdateStatus) checkUpdateStatus.textContent = i18n.t('settings.check_failed'); return; }
    if (r.state === 'update') {
        markUpdateAvailable(r.new);
    } else {
        if (checkUpdateStatus) checkUpdateStatus.textContent = i18n.t('settings.up_to_date');
        if (btnInstallUpdate) btnInstallUpdate.hidden = true;
        setSettingsUpdateBadge(false);
    }
});

if (btnInstallUpdate) btnInstallUpdate.addEventListener('click', () => ipcRenderer.send('open-updater-window'));

// The background checker in main broadcasts this when it finds a newer build.
ipcRenderer.on('update-available-bg', (e, info) => { if (info && info.new) markUpdateAvailable(info.new); });

// --- Config backup: export / import (main: backup.js) ---
const btnExportConfig = $('btnExportConfig');
const btnImportConfig = $('btnImportConfig');
const backupStatus    = $('backupStatus');

if (btnExportConfig) btnExportConfig.addEventListener('click', async () => {
    btnExportConfig.disabled = true;
    let r = null;
    try { r = await ipcRenderer.invoke('config-export'); } catch (e) {}
    btnExportConfig.disabled = false;
    if (r && r.ok) backupStatus.textContent = i18n.t('settings.export_ok');
    else if (r && r.canceled) backupStatus.textContent = '';
    else backupStatus.textContent = i18n.t('settings.backup_failed');
});

if (btnImportConfig) btnImportConfig.addEventListener('click', async () => {
    btnImportConfig.disabled = true;
    let r = null;
    try { r = await ipcRenderer.invoke('config-import'); } catch (e) {}
    btnImportConfig.disabled = false;
    if (r && r.ok) backupStatus.textContent = i18n.t('settings.import_ok');
    else if (r && r.canceled) backupStatus.textContent = '';
    else if (r && r.error === 'invalid') backupStatus.textContent = i18n.t('settings.import_invalid');
    else backupStatus.textContent = i18n.t('settings.backup_failed');
});

// After an import, re-pull the visible toggles + AI config so the UI matches the
// newly-applied settings without a restart. (Launch-only settings still take
// full effect next launch — the status line tells the user.)
ipcRenderer.on('config-imported', async () => {
    try {
        const as = (await ipcRenderer.invoke('settings-get', 'autostart')) === true;
        autoStartToggle.checked = as;
        ipcRenderer.send('set-autostart', as); // apply the imported autostart state now
        const au = await ipcRenderer.invoke('settings-get', 'auto_update');       autoUpdateToggle.checked  = au === undefined ? true : au === true;
        const un = await ipcRenderer.invoke('settings-get', 'show_update_notes');  updateNotesToggle.checked = un === undefined ? true : un === true;
        const dn = await ipcRenderer.invoke('settings-get', 'show_donate');        donateToggle.checked      = dn === undefined ? true : dn === true;
        failoverToggle.checked = (await ipcRenderer.invoke('settings-get', 'dpi_failover')) === true;
        const tr = await ipcRenderer.invoke('settings-get', 'dpi_use_tr_master_list'); trMasterToggle.checked = tr === undefined ? true : tr === true;
    } catch (e) {}
    try { aiConfig = await ipcRenderer.invoke('ai-config-get'); paintAi(); } catch (e) {}
    try { highlightActiveLang(); } catch (e) {}
});

$('btnOpenAiSettings').addEventListener('click', () => showView('aiSetupView'));

// ==========================================
// --- PROXY BRIDGE ---
// ==========================================
// Surfaces Tor's SOCKS endpoint, an optional HTTP→SOCKS bridge, and a PAC file
// so other apps can route through Tor. All the real work is in main (proxy.js);
// this only drives the UI.
let proxyWired = false;

function pxCopy(text, statusEl) {
    try { clipboard.writeText(String(text || '')); if (statusEl) statusEl.textContent = i18n.t('proxy.copied'); } catch (e) {}
}

async function refreshProxy() {
    let s = null;
    try { s = await ipcRenderer.invoke('proxy-status'); } catch (e) {}
    if (!s) return;
    if ($('pxTor')) $('pxTor').textContent = s.torReady ? i18n.t('home.tor_ready') : i18n.t('home.tor_idle');
    if ($('pxTorSub')) $('pxTorSub').textContent = s.torReady ? i18n.t('proxy.tor_on', { p: s.socksPort }) : i18n.t('proxy.tor_off');
    if ($('btnProxyStartTor')) $('btnProxyStartTor').style.display = s.torReady ? 'none' : '';
    if ($('pxSocks')) $('pxSocks').textContent = `${s.socksHost}:${s.socksPort}`;
    if ($('pxHttp')) $('pxHttp').textContent = `${s.socksHost}:${s.httpPort}`;
    if ($('btnToggleHttp')) $('btnToggleHttp').textContent = i18n.t(s.httpRunning ? 'proxy.disable' : 'proxy.enable');
    if ($('pxHttpStatus')) $('pxHttpStatus').textContent = s.httpRunning ? i18n.t('proxy.http_on', { p: s.httpPort }) : '';
}

function openProxy() {
    refreshProxy();
    if (proxyWired) return;
    proxyWired = true;
    $('btnProxyStartTor').addEventListener('click', () => {
        ipcRenderer.send('start-tor');
        if ($('pxTorSub')) $('pxTorSub').textContent = i18n.t('discord.status_establishing');
    });
    $('btnCopySocks').addEventListener('click', () => pxCopy($('pxSocks').textContent, $('pxHttpStatus')));
    $('btnCopyHttp').addEventListener('click', () => pxCopy($('pxHttp').textContent, $('pxHttpStatus')));
    $('btnToggleHttp').addEventListener('click', async () => {
        let s = null;
        try { s = await ipcRenderer.invoke('proxy-status'); } catch (e) {}
        try {
            if (s && s.httpRunning) await ipcRenderer.invoke('proxy-http-stop');
            else await ipcRenderer.invoke('proxy-http-start', 9080);
        } catch (e) {}
        refreshProxy();
    });
    $('btnGenPac').addEventListener('click', async () => {
        let r = null;
        try { r = await ipcRenderer.invoke('proxy-write-pac'); } catch (e) {}
        if (r && r.ok) { $('pxPac').textContent = r.url; $('pxPacStatus').textContent = i18n.t('proxy.pac_saved'); }
        else { $('pxPacStatus').textContent = i18n.t('proxy.pac_failed'); }
    });
    $('btnCopyPac').addEventListener('click', () => pxCopy($('pxPac').textContent, $('pxPacStatus')));
}

if ($('btnOpenProxy')) $('btnOpenProxy').addEventListener('click', () => showView('proxyView'));
// Keep the proxy view's Tor line live if Tor becomes ready while it is open.
ipcRenderer.on('tor-ready', () => { if (currentView === 'proxyView') refreshProxy(); });

// ==========================================
// --- TOR BRIDGES (pluggable transports) ---
// ==========================================
// UI over the bridge config in main (tor.js). The transport binaries live in
// tor-bin/ and are the user's to supply; availability is reflected here.
let bridgesWired = false;
let brTransport = 'obfs4';

function paintBridgeAvail(s) {
    if (!s || !$('brAvail')) return;
    const avail = brTransport === 'snowflake' ? s.snowflakeAvailable : s.obfs4Available;
    const f = brTransport === 'snowflake' ? 'snowflake-client.exe' : 'obfs4proxy.exe / lyrebird.exe';
    $('brAvail').textContent = avail ? i18n.t('bridges.avail_ok', { f }) : i18n.t('bridges.avail_missing', { f });
    $('brAvail').style.color = avail ? 'var(--ok-lit)' : 'var(--bad-lit)';
}
function paintTransportPick() {
    document.querySelectorAll('#brTransport button').forEach(b => b.classList.toggle('on', b.dataset.t === brTransport));
}
async function refreshBridges() {
    let s = null;
    try { s = await ipcRenderer.invoke('tor-bridge-config'); } catch (e) {}
    if (!s) return;
    if ($('brEnable')) $('brEnable').checked = s.enabled;
    brTransport = s.transport;
    paintTransportPick();
    if ($('brLines')) $('brLines').value = s.lines || '';
    paintBridgeAvail(s);
    if ($('brStatus')) $('brStatus').textContent = s.torRunning ? (s.torReady ? i18n.t('home.tor_ready') : i18n.t('discord.status_establishing')) : i18n.t('home.tor_idle');
}
async function saveBridges(restart) {
    const cfg = { enabled: $('brEnable').checked, transport: brTransport, lines: $('brLines').value };
    try { await ipcRenderer.invoke('tor-bridge-save', cfg); } catch (e) {}
    if (restart) {
        try { await ipcRenderer.invoke('tor-restart'); } catch (e) {}
        if ($('brSaveStatus')) $('brSaveStatus').textContent = i18n.t('bridges.restarting');
    } else if ($('brSaveStatus')) {
        $('brSaveStatus').textContent = i18n.t('bridges.saved');
    }
    refreshBridges();
}
function openBridges() {
    refreshBridges();
    if (bridgesWired) return;
    bridgesWired = true;
    document.querySelectorAll('#brTransport button').forEach(b => b.addEventListener('click', async () => {
        brTransport = b.dataset.t;
        paintTransportPick();
        try { paintBridgeAvail(await ipcRenderer.invoke('tor-bridge-config')); } catch (e) {}
    }));
    if ($('btnBridgeSave')) $('btnBridgeSave').addEventListener('click', () => saveBridges(false));
    if ($('btnBridgeRestart')) $('btnBridgeRestart').addEventListener('click', () => saveBridges(true));
}
if ($('btnOpenBridges')) $('btnOpenBridges').addEventListener('click', () => showView('bridgesView'));
ipcRenderer.on('tor-ready', () => { if (currentView === 'bridgesView') refreshBridges(); });

// ==========================================
// --- STATS PANEL ---
// ==========================================
// Reads the persisted engine stats (main: zapret/stats.js) and paints the
// tiles, sparkline, per-profile ranks and failover history. A 1s ticker keeps
// the live "uptime" tile moving while the panel is open and a session runs.
let lastStats = null;
let statsTicker = null;

function fmtDur(ms) {
    const s = Math.floor((ms || 0) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? i18n.t('home.uptime_hm', { h, m }) : i18n.t('home.uptime_m', { m });
}

function renderSpark(timeline) {
    const el = $('stSpark');
    if (!el) return;
    const pts = (timeline || []).slice(-60);
    el.replaceChildren();
    if (!pts.length) {
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        const e = document.createElement('span');
        e.className = 'tiny';
        e.textContent = i18n.t('stats.timeline_empty');
        el.appendChild(e);
        return;
    }
    el.style.alignItems = 'flex-end';
    el.style.justifyContent = '';
    pts.forEach(p => {
        const rate = p.total ? (p.ok / p.total) : 0;
        const bar = document.createElement('i');
        bar.style.height = Math.max(8, Math.round(rate * 100)) + '%';
        if (rate < 0.5) bar.classList.add('bad');
        else if (rate < 0.85) bar.classList.add('warn');
        bar.title = Math.round(rate * 100) + '%';
        el.appendChild(bar);
    });
}

function renderProfileRanks(profiles) {
    const el = $('stProfiles');
    if (!el) return;
    el.replaceChildren();
    if (!profiles || !profiles.length) {
        const e = document.createElement('div');
        e.className = 'rank-empty';
        e.textContent = i18n.t('stats.no_profiles');
        el.appendChild(e);
        return;
    }
    profiles.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'rank' + (i === 0 ? ' first' : '');
        const n = document.createElement('div'); n.className = 'n'; n.textContent = String(i + 1);
        const rb = document.createElement('div'); rb.className = 'rb';
        const rn = document.createElement('div'); rn.className = 'rn'; rn.textContent = profileLabel(p.id);
        const rm = document.createElement('div'); rm.className = 'rm';
        const sr = document.createElement('span');
        if (p.successRate === null) {
            sr.textContent = i18n.t('stats.no_data');
        } else {
            sr.textContent = i18n.t('stats.success_n', { n: p.successRate });
            sr.className = p.successRate >= 85 ? 'y' : (p.successRate < 50 ? 'n2' : '');
        }
        const rt = document.createElement('span'); rt.textContent = fmtDur(p.runtimeMs);
        const ss = document.createElement('span'); ss.textContent = i18n.t('stats.sessions_n', { n: p.sessions });
        rm.append(sr, rt, ss);
        rb.append(rn, rm);
        row.append(n, rb);
        el.appendChild(row);
    });
}

function renderFailovers(list) {
    const el = $('stFailoverList');
    if (!el) return;
    el.replaceChildren();
    if (!list || !list.length) {
        const e = document.createElement('div');
        e.className = 'rank-empty';
        e.textContent = i18n.t('stats.no_failovers');
        el.appendChild(e);
        return;
    }
    list.slice(0, 20).forEach(f => {
        const row = document.createElement('div');
        row.className = 'rank';
        const rb = document.createElement('div'); rb.className = 'rb';
        const rn = document.createElement('div'); rn.className = 'rn';
        rn.textContent = `${profileLabel(f.from) || '—'} → ${profileLabel(f.to) || '—'}`;
        const rm = document.createElement('div'); rm.className = 'rm';
        const t = document.createElement('span'); t.textContent = new Date(f.ts).toLocaleString();
        rm.append(t);
        rb.append(rn, rm);
        row.append(rb);
        el.appendChild(row);
    });
}

async function refreshStats() {
    let s = null;
    try { s = await ipcRenderer.invoke('get-engine-stats'); } catch (e) {}
    if (!s) return;
    lastStats = s;

    if (s.currentSession) {
        $('stUptime').textContent = fmtDur(Date.now() - s.currentSession.start);
        $('stUptimeSub').textContent = profileLabel(s.currentSession.profile);
    } else {
        $('stUptime').textContent = '—';
        $('stUptimeSub').textContent = i18n.t('stats.idle_short');
    }
    $('stRuntime').textContent = fmtDur(s.totals.runtimeMs);
    $('stSessions').textContent = i18n.t('stats.sessions_n', { n: s.totals.sessions });
    $('stSuccess').textContent = s.totals.successRate === null ? '—' : (s.totals.successRate + '%');
    $('stProbes').textContent = i18n.t('stats.probes_n', { ok: s.totals.ok, n: s.totals.ok + s.totals.fail });
    $('stFailovers').textContent = String(s.totals.failoverCount);

    renderSpark(s.timeline);
    renderProfileRanks(s.profiles);
    renderFailovers(s.failovers);

    // Live uptime ticker — only while the panel is open and a session is running.
    if (statsTicker) { clearInterval(statsTicker); statsTicker = null; }
    if (s.currentSession && currentView === 'statsView') {
        statsTicker = setInterval(() => {
            if (currentView !== 'statsView') { clearInterval(statsTicker); statsTicker = null; return; }
            if (lastStats && lastStats.currentSession) {
                $('stUptime').textContent = fmtDur(Date.now() - lastStats.currentSession.start);
            }
        }, 1000);
    }
}

if ($('btnResetStats')) $('btnResetStats').addEventListener('click', async () => {
    try { await ipcRenderer.invoke('reset-engine-stats'); } catch (e) {}
    refreshStats();
});

// ==========================================
// --- INTEGRITY ---
// ==========================================
const V_PHASE = {
    connecting: 'verify.phase_connecting', download: 'verify.phase_download', extract: 'verify.phase_extract',
    check: 'verify.phase_check', repair: 'verify.phase_repair', cleanup: 'verify.phase_cleanup',
    done: 'verify.phase_done', error: 'verify.phase_error'
};
const verifyTerm = $('verifyTerm'), btnStartVerify = $('btnStartVerify');

function vLog(msg, type) {
    clearEmpty(verifyTerm);
    const d = document.createElement('div');
    d.className = 'l' + (type ? ' ' + type : '');
    d.textContent = msg;
    verifyTerm.appendChild(d);
    verifyTerm.scrollTop = verifyTerm.scrollHeight;
}

function startVerify() {
    btnStartVerify.disabled = true;
    btnStartVerify.textContent = i18n.t('verify.btn_analyzing');
    meter($('vMeter'), 0, 30);
    $('vPct').textContent = '0%';
    $('vPhase').textContent = i18n.t(V_PHASE.connecting);
    $('vFile').textContent = '—';
    verifyTerm.replaceChildren();
    vLog('Initiating integrity verification…');
    ipcRenderer.send('start-verification');
}
btnStartVerify.addEventListener('click', startVerify);

ipcRenderer.on('verify-progress', (e, d) => {
    if (!d) return;
    meter($('vMeter'), (d.percent || 0) / 100, 30);
    $('vPct').textContent = `${d.percent}%`;
    $('vFile').textContent = d.msg || '';
    const k = V_PHASE[d.phase];
    if (k) $('vPhase').textContent = i18n.t(k);
});
ipcRenderer.on('verify-log', (e, m) => {
    let t = '';
    if (m.includes('[MISSING FILE]') || m.includes('[CORRUPT FILE]')) t = 'warn';
    if (m.includes('repaired') || m.includes('flawless') || m.includes('Completed') || m.includes('100%')) t = 'ok';
    vLog(m, t);
});
ipcRenderer.on('verify-error', (e, m) => {
    vLog(`ERROR: ${m}`, 'bad');
    btnStartVerify.disabled = false;
    btnStartVerify.textContent = i18n.t('common.retry');
    $('vPhase').textContent = i18n.t(V_PHASE.error);
    $('vMeter').classList.add('warn');
});
ipcRenderer.on('verify-done', (e, r) => {
    meter($('vMeter'), 1, 30);
    $('vMeter').classList.add('ok');
    $('vPct').textContent = '100%';
    $('vPhase').textContent = i18n.t(V_PHASE.done);
    btnStartVerify.disabled = false;
    btnStartVerify.textContent = i18n.t('verify.btn_start');
    if (r && r.repairedCount > 0) vLog(`${r.repairedCount} file(s) repaired.`, 'ok');
    else vLog('Integrity verified at 100%.', 'ok');
});

// ==========================================
// --- DISCORD ---
// ==========================================
let discordInited = false, dEmail = '', dPass = '', dAuto = false, dCreds = null;
const discordWebview = $('discordWebview'), discordGateway = $('discordGateway');

function initDiscord() {
    if (discordInited) return;
    discordInited = true;
    ipcRenderer.send('start-tor');
}
ipcRenderer.on('tor-ready', () => {
    if (!discordInited) return;
    $('discordStatus').textContent = i18n.t('discord.status_establishing');
    ipcRenderer.send('enable-discord-proxy');
});
ipcRenderer.on('discord-proxy-success', () => {
    const s = $('discordStatus');
    s.textContent = i18n.t('discord.status_active');
    s.className = 'tag ok';
    checkCreds();
});

async function checkCreds() {
    const legacy = localStorage.getItem('sistem_discord_creds');
    if (legacy) {
        try { const p = JSON.parse(legacy); if (p && p.email && p.pass) await ipcRenderer.invoke('creds-save', 'discord', p); } catch (e) {}
        localStorage.removeItem('sistem_discord_creds');
    }
    const res = await ipcRenderer.invoke('creds-load', 'discord');
    if (res && res.ok && res.data && res.data.email) {
        dCreds = res.data;
        $('dSavedEmail').textContent = res.data.email;
        $('dNewForm').style.display = 'none'; $('dSavedForm').style.display = 'block';
    } else {
        dCreds = null;
        $('dNewForm').style.display = 'block'; $('dSavedForm').style.display = 'none';
    }
}

$('dSaveLogin').addEventListener('click', async () => {
    const email = $('dEmail').value.trim(), pass = $('dPass').value;
    if (!email || !pass) return;
    await ipcRenderer.invoke('creds-save', 'discord', { email, pass });
    dCreds = { email, pass }; dEmail = email; dPass = pass;
    launchDiscord(true);
});
$('dSkip').addEventListener('click', () => launchDiscord(false));
$('dUseSaved').addEventListener('click', () => {
    if (!dCreds) { launchDiscord(false); return; }
    dEmail = dCreds.email; dPass = dCreds.pass;
    launchDiscord(true);
});
$('dSkipSaved').addEventListener('click', () => launchDiscord(false));
$('dDeleteSaved').addEventListener('click', async () => {
    await ipcRenderer.invoke('creds-delete', 'discord');
    dCreds = null; dEmail = ''; dPass = '';
    checkCreds();
});

function launchDiscord(inject) {
    if (!inject) { dEmail = ''; dPass = ''; }
    $('dNewForm').style.display = 'none'; $('dSavedForm').style.display = 'none';
    $('dLoader').style.display = 'flex';
    document.querySelectorAll('#discordView .gate-box .act').forEach(b => b.disabled = true);
    setTimeout(() => {
        discordGateway.style.display = 'none';
        discordWebview.style.display = 'flex';
        discordWebview.src = 'https://discord.com/login';
    }, 1200);
}

discordWebview.addEventListener('did-finish-load', () => {
    const url = discordWebview.getURL();
    if (url.includes('login') && dEmail && dPass && !dAuto) {
        dAuto = true;
        discordWebview.executeJavaScript(`
            (function() {
                let n = 0;
                const t = setInterval(() => {
                    n++;
                    const e = document.querySelector('input[name="email"]');
                    const p = document.querySelector('input[name="password"]');
                    const b = document.querySelector('button[type="submit"]');
                    if (e && p && b) {
                        clearInterval(t);
                        function set(el, v) {
                            const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                            const ps = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
                            if (s && s !== ps) ps.call(el, v); else s.call(el, v);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        set(e, ${JSON.stringify(dEmail)});
                        set(p, ${JSON.stringify(dPass)});
                        setTimeout(() => { b.removeAttribute('disabled'); b.click(); }, 500);
                    } else if (n > 20) clearInterval(t);
                }, 500);
            })();
        `);
    }
});

// ==========================================
// --- BURNEDWOLF AI ---
// ==========================================
let aiConfig = { enabled: false, provider: null, model: null, canAct: true };
let aiCatalog = [], aiHistory = [], aiBusy = false;
let activeProvider = null, activeModels = [], modelsLive = false, modelFilter = 'all';

const aiChat = $('aiChat'), aiInput = $('aiInput'), aiSend = $('aiSend');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function md(src) {
    const lines = esc(src).split('\n');
    let html = '', list = null;
    const inline = s => s
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    for (const raw of lines) {
        const line = raw.trim();
        const ul = line.match(/^[-*•]\s+(.*)$/), ol = line.match(/^(\d+)[.)]\s+(.*)$/);
        if (ul) { if (list !== 'ul') { if (list) html += `</${list}>`; html += '<ul>'; list = 'ul'; } html += `<li>${inline(ul[1])}</li>`; }
        else if (ol) { if (list !== 'ol') { if (list) html += `</${list}>`; html += '<ol>'; list = 'ol'; } html += `<li>${inline(ol[2])}</li>`; }
        else { if (list) { html += `</${list}>`; list = null; } if (line) html += `<p>${inline(line)}</p>`; }
    }
    if (list) html += `</${list}>`;
    return html || `<p>${inline(esc(src))}</p>`;
}

const IC_ME = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="miter"><path d="M4 20 v-2 a4 4 0 0 1 4-4 h8 a4 4 0 0 1 4 4 v2"></path><path d="M12 4 L15 7 L12 10 L9 7 Z"></path></svg>';
const IC_AI = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="miter"><path d="M3 12 L7 8 L11 12 L15 8 L19 12"></path><path d="M3 17 L7 13 L11 17 L15 13 L19 17"></path></svg>';

function addMsg(role, text, opts) {
    const o = opts || {};
    const w = document.createElement('div');
    w.className = 'msg ' + (role === 'user' ? 'me' : 'ai');
    const ic = document.createElement('div');
    ic.className = 'ic';
    ic.innerHTML = role === 'user' ? IC_ME : IC_AI;
    const b = document.createElement('div');
    b.className = 'bub' + (o.error ? ' err' : '');
    b.innerHTML = md(text);
    if (o.performed && o.performed.length) {
        const box = document.createElement('div');
        box.className = 'did';
        for (const p of o.performed) {
            const r = document.createElement('i');
            if (!p.ok) r.className = 'no';
            const nm = document.createElement('b'); nm.textContent = p.tool;
            const ds = document.createElement('span'); ds.textContent = p.ok ? i18n.t('ai.act_done') : (p.error || i18n.t('ai.act_failed'));
            r.appendChild(nm); r.appendChild(ds);
            box.appendChild(r);
        }
        b.appendChild(box);
    }
    w.appendChild(ic); w.appendChild(b);
    aiChat.appendChild(w);
    scrollChat();
    return w;
}
function scrollChat() { aiChat.scrollTop = aiChat.scrollHeight; }

function addLive() {
    const r = document.createElement('div');
    r.className = 'msg ai';
    r.innerHTML = `<div class="ic">${IC_AI}</div><div class="bub"><div class="thinking"><span class="sh"></span><span class="what"></span></div></div>`;
    aiChat.appendChild(r); scrollChat();
    return r;
}

const HINTS = ['ai.s1', 'ai.s2', 'ai.s3', 'ai.s4'];
function paintHints() {
    const box = $('aiSuggest');
    if (!box) return;
    box.replaceChildren();
    if (aiHistory.length) return;
    HINTS.forEach(k => {
        const b = document.createElement('button');
        b.className = 'hint';
        b.textContent = i18n.t(k);
        b.addEventListener('click', () => { aiInput.value = b.textContent; sendAi(); });
        box.appendChild(b);
    });
}

function greet() {
    if (aiChat.childElementCount) return;
    const isp = detectedISP && detectedISP.detected ? detectedISP.ispLabel : null;
    addMsg('ai', isp ? i18n.t('ai.greet_isp', { isp }) : i18n.t('ai.greet'));
    paintHints();
}

async function openAi() {
    await loadAiConfig();
    if (!aiConfig.enabled || !aiConfig.provider || !aiConfig.model) showView('aiSetupView');
    else { showView('aiView'); greet(); }
}

async function loadAiConfig() {
    try { aiConfig = await ipcRenderer.invoke('ai-config-get'); } catch (e) {}
    try { aiCatalog = await ipcRenderer.invoke('ai-catalog'); } catch (e) { aiCatalog = []; }
    $('aiEnableToggle').checked = !!aiConfig.enabled;
    $('aiActToggle').checked = aiConfig.canAct !== false;
    const p = aiCatalog.find(x => x.id === aiConfig.provider);
    $('aiModelChip').textContent = p && aiConfig.model ? `${p.name} · ${aiConfig.model}` : i18n.t('ai.not_set');
    paintAi();
    refreshUsage();
}

function paintAi() {
    const p = aiCatalog.find(x => x.id === aiConfig.provider);
    const ready = aiConfig.enabled && aiConfig.provider && aiConfig.model;
    $('aiVal').textContent = ready ? (p ? p.name : aiConfig.provider) : i18n.t('ai.not_set');
    $('aiSub').textContent = ready ? (aiConfig.model || '') : i18n.t('ai.tile_sub');
    document.querySelector('.rbtn[data-nav="aiView"]').classList.toggle('hot', !!ready);
}

$('aiEnableToggle').addEventListener('change', async e => { aiConfig = await ipcRenderer.invoke('ai-config-set', { enabled: e.target.checked }); paintAi(); });
$('aiActToggle').addEventListener('change', async e => { aiConfig = await ipcRenderer.invoke('ai-config-set', { canAct: e.target.checked }); });
ipcRenderer.on('ai-config-changed', (e, c) => { aiConfig = c; paintAi(); });

function renderProviders() {
    const box = $('providerGrid');
    box.replaceChildren();
    const ordered = aiCatalog.slice().sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
    for (const p of ordered) {
        const r = document.createElement('button');
        r.className = 'prov' + (aiConfig.provider === p.id ? ' now' : '');
        r.innerHTML = `<span class="dot" style="background:${esc(p.accent)}"></span>
            <span><span class="pn"><span class="nm2"></span><span class="tag ${p.tier === 'paid' ? 'warn' : 'ok'}"></span>${p.recommended ? `<span class="tag on"></span>` : ''}</span><span class="pd"></span></span>
            <span class="pk"></span>
            <svg class="go" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5 L16 12 L9 19"></path></svg>`;
        r.querySelector('.nm2').textContent = p.name;
        r.querySelectorAll('.tag')[0].textContent = i18n.t('ai.tier_' + p.tier);
        if (p.recommended) r.querySelectorAll('.tag')[1].textContent = i18n.t('ai.recommended');
        r.querySelector('.pd').textContent = i18n.t('ai.free.' + p.freeNote);
        const k = r.querySelector('.pk');
        k.textContent = p.noKey ? i18n.t('ai.no_key_needed') : (p.hasKey ? i18n.t('ai.key_saved', { k: p.keyHint }) : i18n.t('ai.key_needed'));
        k.classList.toggle('set', !!(p.hasKey || p.noKey));
        r.addEventListener('click', () => openProvider(p.id));
        box.appendChild(r);
    }
}

async function openProvider(id) {
    activeProvider = aiCatalog.find(p => p.id === id);
    if (!activeProvider) return;
    const p = activeProvider;
    $('provTitle').textContent = p.name;
    const pill = $('provTierPill');
    pill.textContent = i18n.t('ai.tier_' + p.tier);
    pill.className = 'tag ' + (p.tier === 'paid' ? 'warn' : 'ok');
    $('provFreeNote').textContent = i18n.t('ai.free.' + p.freeNote);
    const q = $('provQuotaNote');
    q.textContent = p.freeQuota ? i18n.t('ai.quota.' + p.freeQuota) : '';
    q.style.display = p.freeQuota ? '' : 'none';

    const steps = $('provSteps');
    steps.replaceChildren();
    const raw = i18n.t('ai.steps.' + p.id);
    const items = raw && raw !== 'ai.steps.' + p.id ? String(raw).split('|') : [i18n.t('ai.steps.generic')];
    for (const s of items) {
        const row = document.createElement('div');
        row.className = 'step';
        row.innerHTML = '<i></i><span></span>';
        row.querySelector('span').textContent = s;
        steps.appendChild(row);
    }
    $('btnOpenConsole').style.display = p.keysUrl ? '' : 'none';
    $('btnOpenPricing').style.display = p.pricingUrl ? '' : 'none';
    $('provKeyPanel').style.display = p.noKey ? 'none' : '';
    $('provKeyInput').value = ''; $('provKeyInput').type = 'password';
    $('provCustomEndpoint').style.display = p.custom ? 'block' : 'none';
    $('provEndpointInput').value = p.custom ? (aiConfig.endpoint || '') : '';
    const st = $('provKeyState');
    st.className = 'keystate';
    st.textContent = p.hasKey ? i18n.t('ai.key_saved', { k: p.keyHint }) : '';
    $('btnKeyDelete').style.display = p.hasKey ? 'inline' : 'none';
    modelFilter = 'all'; paintFilter();
    renderModels(p.models, false);
    showView('aiProviderView');
}

function paintFilter() {
    $('segModelsAll').classList.toggle('on', modelFilter === 'all');
    $('segModelsFree').classList.toggle('on', modelFilter === 'free');
}
$('segModelsAll').addEventListener('click', () => { modelFilter = 'all'; paintFilter(); renderModels(activeModels, modelsLive); });
$('segModelsFree').addEventListener('click', () => { modelFilter = 'free'; paintFilter(); renderModels(activeModels, modelsLive); });

function usd(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v === 0) return '0';
    if (v < 0.01) return v.toFixed(4).replace(/0+$/, '');
    if (v < 1) return v.toFixed(2);
    return v % 1 === 0 ? String(v) : v.toFixed(2);
}

function renderModels(models, live) {
    activeModels = models || [];
    modelsLive = !!live;
    const list = $('modelList');
    list.replaceChildren();
    const src = $('modelSourcePill');
    src.textContent = i18n.t(live ? 'ai.list_live' : 'ai.list_bundled');
    src.className = 'tag' + (live ? ' ok' : '');

    const free = m => m.tier === 'free' || m.tier === 'local';
    const anyFree = activeModels.some(free);
    $('segModelsFree').style.display = anyFree ? '' : 'none';
    if (!anyFree && modelFilter === 'free') { modelFilter = 'all'; paintFilter(); }
    const shown = modelFilter === 'free' ? activeModels.filter(free) : activeModels;

    if (!shown.length) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.innerHTML = '<p></p>';
        e.querySelector('p').textContent = i18n.t(activeModels.length ? 'ai.no_free_models' : 'ai.no_models');
        list.appendChild(e);
        return;
    }
    for (const m of shown) {
        const row = document.createElement('button');
        row.className = 'model' + (activeProvider && aiConfig.provider === activeProvider.id && aiConfig.model === m.id ? ' now' : '');
        const zero = m.price && Number(m.price.in) === 0 && Number(m.price.out) === 0;
        let price;
        if (m.tier === 'local') price = `<b>${esc(i18n.t('ai.price_local'))}</b>`;
        else if (zero) price = `<b>${esc(i18n.t('ai.price_free'))}</b>`;
        else if (m.tier === 'free' && m.price) price = `<b>${esc(i18n.t('ai.price_free'))}</b><br>${esc(i18n.t('ai.price_after_quota', { i: usd(m.price.in), o: usd(m.price.out) }))}`;
        else if (m.price) price = `<b>$${usd(m.price.in)}</b> ${esc(i18n.t('ai.per_in'))}<br><b>$${usd(m.price.out)}</b> ${esc(i18n.t('ai.per_out'))}`;
        else price = esc(i18n.t('ai.price_unknown'));

        row.innerHTML = `<span class="mm"><span class="mn"><span class="nm3"></span>${m.best ? '<span class="tag on"></span>' : ''}${m.tier && m.tier !== 'unknown' ? `<span class="tag ${m.tier === 'paid' ? 'warn' : 'ok'}"></span>` : ''}</span><span class="mi"></span></span><span class="mp">${price}</span>`;
        row.querySelector('.nm3').textContent = m.label || m.id;
        const tags = row.querySelectorAll('.tag');
        let ti = 0;
        if (m.best) tags[ti++].textContent = i18n.t('ai.best_pick');
        if (m.tier && m.tier !== 'unknown' && tags[ti]) tags[ti].textContent = i18n.t('ai.tier_' + m.tier);
        row.querySelector('.mi').textContent = m.ctx ? `${m.id} · ${Math.round(m.ctx / 1000)}K` : m.id;
        row.addEventListener('click', () => chooseModel(m.id));
        list.appendChild(row);
    }
}

async function chooseModel(id) {
    if (!activeProvider) return;
    aiConfig = await ipcRenderer.invoke('ai-config-set', {
        provider: activeProvider.id, model: id, enabled: true,
        endpoint: activeProvider.custom ? $('provEndpointInput').value.trim() : aiConfig.endpoint
    });
    aiCatalog = await ipcRenderer.invoke('ai-catalog');
    paintAi();
    renderModels(activeModels, modelsLive);
    $('aiEnableToggle').checked = true;
    const p = aiCatalog.find(x => x.id === aiConfig.provider);
    $('aiModelChip').textContent = p ? `${p.name} · ${id}` : id;
    aiChat.replaceChildren(); aiHistory = [];
    showView('aiView');
    greet();
}

$('btnCustomModel').addEventListener('click', () => { const v = $('customModelInput').value.trim(); if (v) chooseModel(v); });
$('btnKeyReveal').addEventListener('click', () => { const el = $('provKeyInput'); el.type = el.type === 'password' ? 'text' : 'password'; });

$('btnKeySave').addEventListener('click', async () => {
    if (!activeProvider) return;
    const key = $('provKeyInput').value.trim();
    const endpoint = activeProvider.custom ? $('provEndpointInput').value.trim() : '';
    const st = $('provKeyState');
    if (!key && !activeProvider.noKey) { st.className = 'keystate bad'; st.textContent = i18n.t('ai.key_empty'); return; }
    st.className = 'keystate'; st.textContent = i18n.t('ai.testing');
    const test = await ipcRenderer.invoke('ai-test-key', activeProvider.id, key, endpoint);
    if (!test.ok) { st.className = 'keystate bad'; st.textContent = i18n.t('ai.key_bad', { e: String(test.error || '').slice(0, 120) }); return; }
    const saved = await ipcRenderer.invoke('ai-key-save', activeProvider.id, key, endpoint);
    if (!saved.ok) { st.className = 'keystate bad'; st.textContent = i18n.t('ai.key_store_fail'); return; }
    st.className = 'keystate ok'; st.textContent = i18n.t('ai.key_ok', { n: test.count });
    $('provKeyInput').value = '';
    $('btnKeyDelete').style.display = 'inline';
    aiCatalog = await ipcRenderer.invoke('ai-catalog');
    activeProvider = aiCatalog.find(p => p.id === activeProvider.id);
    loadLive();
});

$('btnKeyDelete').addEventListener('click', async () => {
    if (!activeProvider) return;
    await ipcRenderer.invoke('ai-key-delete', activeProvider.id);
    aiCatalog = await ipcRenderer.invoke('ai-catalog');
    activeProvider = aiCatalog.find(p => p.id === activeProvider.id);
    $('provKeyState').className = 'keystate';
    $('provKeyState').textContent = i18n.t('ai.key_removed');
    $('btnKeyDelete').style.display = 'none';
    paintAi();
});

async function loadLive() {
    if (!activeProvider) return;
    const b = $('btnRefreshModels');
    b.disabled = true; b.classList.add('busy');
    const r = await ipcRenderer.invoke('ai-list-models', activeProvider.id, '', activeProvider.custom ? $('provEndpointInput').value.trim() : '');
    b.disabled = false; b.classList.remove('busy');
    renderModels(r.models || [], !!r.live);
}
$('btnRefreshModels').addEventListener('click', loadLive);
$('btnOpenConsole').addEventListener('click', () => { if (activeProvider) ipcRenderer.invoke('ai-open-external', activeProvider.keysUrl); });
$('btnOpenPricing').addEventListener('click', () => { if (activeProvider) ipcRenderer.invoke('ai-open-external', activeProvider.pricingUrl); });
$('btnBackToProviders').addEventListener('click', () => showView('aiSetupView'));
$('btnAiSettings').addEventListener('click', () => showView('aiSetupView'));
$('btnAiLimits').addEventListener('click', () => showView('aiLimitView'));
if ($('btnAiDiagnose')) $('btnAiDiagnose').addEventListener('click', diagnoseAi);
$('btnBackFromLimits').addEventListener('click', () => showView(aiConfig.enabled && aiConfig.model ? 'aiView' : 'aiSetupView'));
$('btnAiAudit').addEventListener('click', () => showView('aiAuditView'));
$('btnBackFromAudit').addEventListener('click', () => showView('aiSetupView'));
$('btnAiClear').addEventListener('click', () => { aiChat.replaceChildren(); aiHistory = []; greet(); });

aiInput.addEventListener('input', () => { aiInput.style.height = 'auto'; aiInput.style.height = Math.min(130, aiInput.scrollHeight) + 'px'; });
aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAi(); } });
aiSend.addEventListener('click', sendAi);

const AI_ERR = {
    ai_disabled: 'ai.err_disabled', ai_not_configured: 'ai.err_not_configured',
    ai_no_key: 'ai.err_no_key', ai_no_endpoint: 'ai.err_no_endpoint', ai_unknown_provider: 'ai.err_provider'
};

// Shared AI turn — used by the text composer and by one-click auto-diagnose.
async function runAiExchange(userLabel, invoke) {
    if (aiBusy) return;
    if (!aiConfig.enabled || !aiConfig.provider || !aiConfig.model) { showView('aiSetupView'); return; }
    addMsg('user', userLabel);
    $('aiSuggest').replaceChildren();
    aiBusy = true; aiSend.disabled = true;

    const live = addLive();
    const what = live.querySelector('.what');
    what.textContent = i18n.t('ai.thinking');

    const onProgress = (e, p) => {
        if (!p) return;
        if (p.stage === 'tool') what.textContent = i18n.t('ai.running_tool', { t: p.tool });
        else if (p.stage === 'continuing') what.textContent = i18n.t('ai.applying');
    };
    ipcRenderer.on('ai-progress', onProgress);

    let res;
    try { res = await invoke(); }
    catch (e) { res = { ok: false, error: 'internal', detail: String(e && e.message || e) }; }
    ipcRenderer.removeListener('ai-progress', onProgress);
    live.remove();

    if (res && res.ok) {
        const body = res.text && res.text.trim() ? res.text : i18n.t('ai.done_no_text');
        addMsg('ai', body, { performed: res.performed });
        aiHistory.push({ role: 'user', content: userLabel });
        aiHistory.push({ role: 'assistant', content: body });
        if (res.performed && res.performed.some(p => p.mutating && p.ok)) resync();
        refreshUsage();
    } else {
        const k = AI_ERR[res && res.error];
        addMsg('ai', k ? i18n.t(k) : i18n.t('ai.err_provider_detail', { e: String((res && (res.detail || res.error)) || 'unknown').slice(0, 220) }), { error: true });
    }
    aiBusy = false; aiSend.disabled = false; aiInput.focus();
}

async function sendAi() {
    if (aiBusy) return;
    const text = aiInput.value.trim();
    if (!text) return;
    if (!aiConfig.enabled || !aiConfig.provider || !aiConfig.model) { showView('aiSetupView'); return; }
    aiInput.value = ''; aiInput.style.height = 'auto';
    await runAiExchange(text, () => ipcRenderer.invoke('ai-chat', { message: text, history: aiHistory }));
}

// One-click auto-diagnose: no typing — main gathers the snapshot and the model
// analyses (and, with action mode on, fixes) the connection.
async function diagnoseAi() {
    if (aiBusy) return;
    if (!aiConfig.enabled || !aiConfig.provider || !aiConfig.model) { showView('aiSetupView'); return; }
    await runAiExchange(i18n.t('ai.diagnose_msg'), () => ipcRenderer.invoke('ai-diagnose'));
}

async function resync() {
    refreshDns();
    try {
        const st = await ipcRenderer.invoke('query-engine-status');
        if (st && st.zapret) {
            engineRunning = !!st.zapret.running;
            engineMode = st.zapret.mode || engineMode;
            if (engineRunning && !startedAt) startedAt = Date.now();
            if (!engineRunning) startedAt = null;
            paintState();
        }
    } catch (e) {}
    try {
        failoverToggle.checked = (await ipcRenderer.invoke('settings-get', 'dpi_failover')) === true;
        const tr = await ipcRenderer.invoke('settings-get', 'dpi_use_tr_master_list');
        trMasterToggle.checked = tr === undefined ? true : tr === true;
    } catch (e) {}
    ipcRenderer.send('load-whitelist');
}

ipcRenderer.on('ai-ui-command', (e, cmd) => {
    if (!cmd) return;
    switch (cmd.action) {
        case 'navigate': {
            const map = { home: 'homeView', dns: 'dnsView', analysis: 'analysisView', verify: 'verifyView', discord: 'discordView', advanced: 'advancedView', settings: 'settingsView', ai: 'aiView' };
            if (map[cmd.view]) showView(map[cmd.view]);
            break;
        }
        case 'select-profile':
            if (cmd.profileId && (profileLabels[cmd.profileId] || cmd.profileId === 'custom')) {
                profileSelect.value = cmd.profileId; paintProfileName(); paintState();
            }
            break;
        case 'run-analysis': setScanMode(cmd.mode === 'deep' ? 'deep' : 'quick'); showView('analysisView'); startScan(); break;
        case 'cancel-analysis': ipcRenderer.send('cancel-blockcheck'); break;
        case 'run-verify': showView('verifyView'); startVerify(); break;
        case 'refresh-dns': refreshDns(); break;
        case 'apply-autostart': ipcRenderer.send('set-autostart', !!cmd.value); autoStartToggle.checked = !!cmd.value; break;
        case 'settings-changed':
            if (cmd.key === 'dpi_failover') failoverToggle.checked = !!cmd.value;
            if (cmd.key === 'dpi_use_tr_master_list') trMasterToggle.checked = !!cmd.value;
            if (cmd.key === 'auto_update') autoUpdateToggle.checked = !!cmd.value;
            if (cmd.key === 'show_update_notes') updateNotesToggle.checked = !!cmd.value;
            if (cmd.key === 'show_donate') donateToggle.checked = !!cmd.value;
            break;
    }
});

// --- usage ---
function refreshUsage() { ipcRenderer.invoke('ai-usage').then(paintUsage).catch(() => {}); }
ipcRenderer.on('ai-usage-changed', (e, r) => paintUsage(r));

function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function paintUsage(r) {
    if (!r) return;
    const chip = $('aiLimitChip');
    if (chip) chip.textContent = i18n.t('ai.chip_usage', { n: r.today.requests, t: fmt(r.today.in + r.today.out) });
    if ($('aiLimitView').hidden) return;

    $('statReq').textContent = r.today.requests;
    $('statIn').textContent = fmt(r.today.in);
    $('statOut').textContent = fmt(r.today.out);
    $('statCost').textContent = r.estimatedCostTotal != null ? ('$' + r.estimatedCostTotal.toFixed(4)) : '—';

    const keys = Object.keys(r.days).sort().slice(-14);
    const today = new Date().toISOString().slice(0, 10);
    const day = k => { const d = new Date(k + 'T00:00:00'); return `${d.getDate()}/${d.getMonth() + 1}`; };
    const series = keys.map(k => ({ key: k, label: day(k), value: r.days[k].requests || 0, today: k === today }));
    $('chartEmpty').hidden = series.length > 0;
    if (!usageBars) usageBars = LOOM.bars($('usageChart'));
    if (usageBars) usageBars.setData(series);

    const panel = $('rateLimitPanel'), rows = $('rateLimitRows');
    if (r.rateLimit) {
        rows.replaceChildren();
        const map = { requestsRemaining: 'ai.rl_req_left', tokensRemaining: 'ai.rl_tok_left', requestsLimit: 'ai.rl_req_limit', tokensLimit: 'ai.rl_tok_limit', reset: 'ai.rl_reset' };
        for (const [k, lbl] of Object.entries(map)) {
            if (r.rateLimit[k] == null) continue;
            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML = '<span class="rt"><h4></h4></span><span class="num tiny"></span>';
            row.querySelector('h4').textContent = i18n.t(lbl);
            row.querySelector('.num').textContent = String(r.rateLimit[k]);
            rows.appendChild(row);
        }
        panel.style.display = rows.childElementCount ? '' : 'none';
    } else panel.style.display = 'none';
}

$('btnResetUsage').addEventListener('click', async () => paintUsage(await ipcRenderer.invoke('ai-usage-reset')));

async function renderAudit() {
    const res = await ipcRenderer.invoke('ai-context-preview');
    const c = res.context;
    const list = $('ctxList');
    list.replaceChildren();
    const rows = [
        ['app', `${c.app.name} v${c.app.version}`],
        ['system', `Windows ${c.system.osRelease} · ${c.system.arch} · ${c.system.cores} cores · ${c.system.memoryGb} GB`],
        ['locale', c.system.locale],
        ['isp', c.network.isp.detected === false ? '—' : `${c.network.isp.label} (AS${c.network.isp.asn}) ${c.network.isp.country || ''} ${c.network.isp.city || ''}`],
        ['public ip', c.network.isp.publicIp || '—'],
        ['dns', `DoH ${c.network.dns.encryptedDnsActive ? 'on' : 'off'} · ${c.network.dns.lastPreflight ? c.network.dns.lastPreflight.state : '—'}`],
        ['dpi engine', c.engine.dpi.running ? `running · ${c.engine.dpi.activeProfile}` : 'stopped'],
        ['tor', c.engine.tor.ready ? `ready :${c.engine.tor.port}` : 'not started'],
        ['profiles', `${c.profiles.total}`],
        ['settings', JSON.stringify(c.settings)]
    ];
    for (const [k, v] of rows) {
        const it = document.createElement('div');
        it.className = 'ctxr';
        it.innerHTML = '<span class="k"></span><span class="v"></span>';
        it.querySelector('.k').textContent = k;
        it.querySelector('.v').textContent = v == null ? '—' : String(v);
        list.appendChild(it);
    }
    const tools = $('toolList');
    tools.replaceChildren();
    for (const t of res.tools) {
        const it = document.createElement('div');
        it.className = 'ctxr';
        it.innerHTML = '<span class="k"></span><span class="v"></span>';
        it.querySelector('.k').textContent = t.name;
        it.querySelector('.v').textContent = (t.mutating ? '± ' : '· ') + t.description;
        tools.appendChild(it);
    }
}

// ==========================================
// --- STARTUP ---
// ==========================================
(async () => {
    try {
        const st = await ipcRenderer.invoke('query-engine-status');
        if (st && st.zapret && st.zapret.running) {
            engineRunning = true; engineMode = st.zapret.mode;
            if (!startedAt) startedAt = Date.now();
        }
        if (st && st.tor && st.tor.ready) torReady = true;
    } catch (e) {}
    loadCustom();
    paintState();
    paintTor();
    await loadProfiles();
    loadUserProfiles();
    loadCustom();
    // Re-apply the saved selection now that user profiles are registered too
    // (loadProfiles ran before them and would have fallen back to bw_standard).
    try {
        const saved = await ipcRenderer.invoke('settings-get', 'last_profile');
        const target = engineMode || saved;
        if (target && (profileLabels[target] || target === 'custom')) profileSelect.value = target;
    } catch (e) {}
    if (engineMode && (profileLabels[engineMode] || engineMode === 'custom')) profileSelect.value = engineMode;
    paintProfileName();
    await loadAiConfig();
    finishBoot();
    detectISP();
    refreshDns();
    // Notes first; the support sheet follows when they close, or opens straight
    // away when there were none to show.
    maybeNotes().then(shown => { if (!shown) maybeDonate(); });
    try {
        if (await ipcRenderer.invoke('settings-get', 'ai_open_on_first_run') === true) {
            await ipcRenderer.invoke('settings-set', 'ai_open_on_first_run', false);
            setTimeout(() => showView('aiSetupView'), 800);
        }
    } catch (e) {}
})();
