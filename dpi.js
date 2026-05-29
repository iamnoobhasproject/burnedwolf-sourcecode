const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

// When the language toggles in any window, re-apply translations to dynamic
// strings the renderer writes by hand (engine status, phase labels, etc.)
ipcRenderer.on('language-changed', () => {
    setTimeout(() => {
        try { applyDynamicTranslations(); } catch (e) {}
    }, 60);
});

// Called after a language change so non-static (JS-painted) strings update too
function applyDynamicTranslations() {
    // Engine status badge
    const statusTxt = document.getElementById('dpiStatusTxt');
    if (statusTxt) {
        const isRunning = statusTxt.textContent && (
            statusTxt.textContent.includes('Active') ||
            statusTxt.textContent.includes('Aktif') ||
            statusTxt.textContent.includes('активен')
        );
        statusTxt.textContent = i18n.t(isRunning ? 'dpi.engine_active' : 'dpi.engine_stopped');
    }
    // Scan run button — depends on selected mode
    const btn = document.getElementById('btnRunBlockcheck');
    if (btn) {
        const mode = (typeof selectedScanMode !== 'undefined') ? selectedScanMode : 'quick';
        btn.textContent = i18n.t(mode === 'quick' ? 'dpi.btn_start_quick' : 'dpi.btn_start_deep');
    }
    // ISP banner hint texts — re-evaluate from current state
    if (typeof refreshISPBannerLocale === 'function') refreshISPBannerLocale();
    // Health pill meta refreshes itself via the 5s poll, no manual call needed
}

// --- WINDOW CONTROLS ---
document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('close-dpi-window'));
document.getElementById('btnMax').addEventListener('click', () => ipcRenderer.send('maximize-dpi-window'));
document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('minimize-dpi-window'));

// --- TAB ROUTING ---
function openTab(tabId, evt) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    // Use the passed event when available, fall back to global for legacy HTML
    const e = evt || window.event;
    if (e && e.currentTarget) e.currentTarget.classList.add('active');
}
window.openTab = openTab;

// --- DOM ELEMENTS ---
const btnStart = document.getElementById('btnStartZapret');
const btnStop = document.getElementById('btnStopZapret');
const statusBadge = document.getElementById('dpiStatus');
const statusTxt = document.getElementById('dpiStatusTxt');
const mainTerminal = document.getElementById('mainTerminal');
const blockcheckTerminal = document.getElementById('blockcheckTerminal');
const btnBlockcheck = document.getElementById('btnRunBlockcheck');
const btnDownloadReport = document.getElementById('btnDownloadReport');

const whitelistInput = document.getElementById('whitelistInput');
const autoWhitelistToggle = document.getElementById('autoWhitelistToggle');
const customGroup = document.getElementById('customGroup');
const customOption = document.getElementById('customOption');
const btnDeleteCustom = document.getElementById('btnDeleteCustom');
const modeSelect = document.getElementById('zapretMode');

// Log Memory for Reporting
let analysisLogs = [];

// --- LOGGING FUNCTION ---
function logTerm(terminal, msg, isWarning = false) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = `<span style="opacity:0.5; margin-right:5px;">></span> ${msg}`;
    if (isWarning) div.style.color = 'var(--warning)';
    if (msg.includes('SUCCESS') || msg.includes('FOUND') || msg.includes('VERIFIED')) div.style.color = 'var(--success)';
    if (msg.includes('FAILED') || msg.includes('INTERCEPTED') || msg.includes('FATAL') || msg.includes('ERROR')) div.style.color = '#5865F2';
    
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
    
    if(terminal.id === 'blockcheckTerminal') {
        const time = new Date().toLocaleTimeString();
        analysisLogs.push(`[${time}] ${msg}`);
    }
}

// --- CUSTOM THEMED DROPDOWN ---
// Native <select> dropdown panels can't be styled on Windows (Chromium delegates
// rendering to the OS), so we hide the real select and drive a custom UI
// against it. The select stays the source of truth for `modeSelect.value`.
function mountCustomDropdown(selectEl) {
    if (selectEl._bwMounted) return;
    selectEl._bwMounted = true;

    // Wrap select in a container that takes the same flex slot
    const wrapper = document.createElement('div');
    wrapper.className = 'bw-select';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'bw-select-trigger';
    trigger.innerHTML = `
        <span class="bw-select-label">—</span>
        <span class="bw-select-region" style="display:none;"></span>
        <svg class="bw-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
    `;
    wrapper.appendChild(trigger);

    const panel = document.createElement('div');
    panel.className = 'bw-select-panel';
    wrapper.appendChild(panel);

    function getCurrentOption() {
        const idx = selectEl.selectedIndex;
        return idx >= 0 ? selectEl.options[idx] : null;
    }

    function getRegionFor(option) {
        const parent = option ? option.parentElement : null;
        return parent && parent.tagName === 'OPTGROUP' ? parent.label : '';
    }

    function rebuildPanel() {
        panel.innerHTML = '';
        const currentValue = selectEl.value;

        Array.from(selectEl.children).forEach(child => {
            if (child.tagName === 'OPTGROUP') {
                if (child.style.display === 'none' || !child.children.length) return;
                const label = document.createElement('div');
                label.className = 'bw-select-group-label';
                label.textContent = child.label;
                panel.appendChild(label);
                Array.from(child.children).forEach(opt => panel.appendChild(makeOption(opt, currentValue)));
            } else if (child.tagName === 'OPTION') {
                panel.appendChild(makeOption(child, currentValue));
            }
        });
    }

    function makeOption(opt, currentValue) {
        const item = document.createElement('div');
        item.className = 'bw-select-option' + (opt.value === currentValue ? ' selected' : '');
        // Decorate recommended profiles (from ISP auto-detection) with a star.
        // recommendedProfileIds is a module-scope array populated by detectAndApplyISP.
        const isRecommended = (typeof recommendedProfileIds !== 'undefined') &&
            Array.isArray(recommendedProfileIds) && recommendedProfileIds.includes(opt.value);
        const starMark = isRecommended ? '<span class="bw-rec-star" title="Recommended for your ISP">★</span>' : '';

        // Metadata badges: voice mic, difficulty dots, fake-payload F
        const voiceBadge = opt.dataset.voiceReady === '1'
            ? '<span class="bw-meta-badge voice" title="Discord voice supported"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8"></path></svg></span>'
            : '';
        const fakeBadge = opt.dataset.fakePayload === '1'
            ? '<span class="bw-meta-badge fake" title="Uses Google fake-TLS / fake-QUIC payloads (needs .bin files)">F</span>'
            : '';
        const diff = opt.dataset.difficulty;
        let diffDots = '';
        if (diff) {
            const level = diff === 'extreme' ? 4 : diff === 'high' ? 3 : diff === 'medium' ? 2 : 1;
            diffDots = `<span class="bw-meta-diff bw-diff-${diff}" title="Aggressiveness: ${diff}">`;
            for (let i = 0; i < 4; i++) diffDots += `<span class="bw-diff-dot${i < level ? ' on' : ''}"></span>`;
            diffDots += `</span>`;
        }

        item.innerHTML = `
            <span class="bw-opt-label">${starMark}${opt.textContent}</span>
            <span class="bw-opt-meta">${voiceBadge}${fakeBadge}${diffDots}<span class="bw-dot"></span></span>
        `;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            selectEl.value = opt.value;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            refresh();
            close();
        });
        return item;
    }

    function refresh() {
        const opt = getCurrentOption();
        const labelEl = trigger.querySelector('.bw-select-label');
        const regionEl = trigger.querySelector('.bw-select-region');
        if (opt) {
            const isRecommended = (typeof recommendedProfileIds !== 'undefined') &&
                Array.isArray(recommendedProfileIds) && recommendedProfileIds.includes(opt.value);
            labelEl.innerHTML = (isRecommended ? '<span class="bw-rec-star">★</span>' : '') + opt.textContent;
            const region = getRegionFor(opt);
            if (region) { regionEl.textContent = region; regionEl.style.display = 'inline-block'; }
            else { regionEl.style.display = 'none'; }
        } else {
            labelEl.textContent = '—';
            regionEl.style.display = 'none';
        }
        rebuildPanel();
    }

    function open()  { wrapper.classList.add('open'); rebuildPanel(); }
    function close() { wrapper.classList.remove('open'); }

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        wrapper.classList.contains('open') ? close() : open();
    });
    document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    // Expose a manual refresh so code that mutates select.value programmatically
    // (loadCustomProfile, blockcheck-done) can sync the visual state.
    selectEl._bwRefresh = refresh;
    refresh();
}

// --- DYNAMIC PROFILE CATALOG (loaded from main process) ---
// Profiles are grouped by region in the dropdown so the user can pick the
// closest match for their ISP. Default selection is 'bw_standard'.
async function loadProfileCatalog() {
    try {
        const profiles = await ipcRenderer.invoke('get-dpi-profiles');
        if (!Array.isArray(profiles) || profiles.length === 0) return;

        // Group by region
        const grouped = {};
        profiles.forEach(p => {
            if (!grouped[p.region]) grouped[p.region] = [];
            grouped[p.region].push(p);
        });

        // Preserve the System Generated custom group (already in HTML)
        const customGroup = document.getElementById('customGroup');
        // Region display order
        const order = ['Generic', 'Turkey', 'Russia', 'Europe', 'Middle East', 'Asia'];
        const regions = order.filter(r => grouped[r]).concat(
            Object.keys(grouped).filter(r => !order.includes(r))
        );

        // Insert region optgroups before the custom group. Profile metadata
        // (voice, difficulty, vendor) is stashed on data-* attributes so the
        // themed dropdown can decorate options without a second IPC round-trip.
        regions.forEach(region => {
            const og = document.createElement('optgroup');
            og.label = region;
            grouped[region].forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.label;
                if (p.voiceReady)       opt.dataset.voiceReady  = '1';
                if (p.usesFakePayload)  opt.dataset.fakePayload = '1';
                if (p.difficulty)       opt.dataset.difficulty  = p.difficulty;
                if (p.vendor)           opt.dataset.vendor      = p.vendor;
                og.appendChild(opt);
            });
            modeSelect.insertBefore(og, customGroup);
        });

        // Default to Standard
        if (!modeSelect.value || modeSelect.value === '') modeSelect.value = 'bw_standard';

        // Mount the themed dropdown over the now-populated select
        mountCustomDropdown(modeSelect);

        // ISP detection runs after the catalog is loaded so the dropdown can
        // be re-rendered with recommendation stars applied.
        detectAndApplyISP();
    } catch (e) {
        console.warn('Failed to load profile catalog:', e);
    }
}
loadProfileCatalog();

// --- ISP AUTO-DETECTION & PROFILE RECOMMENDATION ---
// On open, query the main process for the user's ISP (based on AS Number).
// If detected, we paint a banner at the top of the dashboard, mark recommended
// profiles in the dropdown with a ★, and offer a one-click "Apply best" button
// that selects the strongest recommended profile.
let recommendedProfileIds = [];

async function detectAndApplyISP() {
    const banner = document.getElementById('ispBanner');
    const nameEl = document.getElementById('ispName');
    const hintEl = document.getElementById('ispHint');
    const applyBtn = document.getElementById('btnApplyIsp');
    if (!banner || !nameEl) return;

    let result;
    try {
        result = await ipcRenderer.invoke('detect-isp');
    } catch (e) {
        return; // silent fail — banner stays hidden
    }

    if (!result || !result.detected) {
        // Show a soft warning banner so the user knows detection ran but failed
        banner.classList.add('unknown');
        nameEl.textContent = i18n.t('dpi.isp_hint_could_not_detect');
        hintEl.textContent = i18n.t('dpi.isp_hint_unknown');
        applyBtn.style.display = 'none';
        banner.style.display = 'flex';
        return;
    }

    if (result.known && result.recommendedProfiles.length > 0) {
        // Known Turkish ISP
        banner.classList.remove('unknown');
        nameEl.textContent = result.ispLabel;
        hintEl.textContent = i18n.t('dpi.isp_hint_default');
        applyBtn.style.display = 'inline-block';
        recommendedProfileIds = result.recommendedProfiles.slice();

        // Apply best button: pick the first recommended profile that exists in
        // the catalog and is not the legacy combined fallback.
        applyBtn.onclick = () => {
            const target = recommendedProfileIds.find(id =>
                modeSelect.querySelector(`option[value="${id}"]`)
            );
            if (target) {
                modeSelect.value = target;
                if (modeSelect._bwRefresh) modeSelect._bwRefresh();
                logTerm(mainTerminal, `[ISP] Switched to recommended profile: ${target.toUpperCase()}`);
            }
        };
    } else {
        // Detected but unknown ISP (e.g. user is on a foreign network / VPN)
        banner.classList.add('unknown');
        nameEl.textContent = `${result.ispLabel || result.organization || 'Unknown'} (AS${result.asn})`;
        hintEl.textContent = 'No tuned profile for this ISP — try Generic profiles like Standard or Advanced.';
        applyBtn.style.display = 'none';
    }

    banner.style.display = 'flex';

    // Re-render the dropdown so stars appear on recommended profiles.
    if (modeSelect._bwRefresh) modeSelect._bwRefresh();
}

// --- CUSTOM PROFILE MANAGEMENT ---
let savedCustomArgs = [];
function loadCustomProfile() {
    const savedData = localStorage.getItem('bw_custom_profile');
    if (savedData) {
        const profile = JSON.parse(savedData);
        savedCustomArgs = profile.args;
        customOption.textContent = profile.name;
        customGroup.style.display = 'block';
        btnDeleteCustom.style.display = 'block';
    } else {
        customGroup.style.display = 'none';
        btnDeleteCustom.style.display = 'none';
        if (modeSelect.value === 'custom') modeSelect.value = 'bw_standard';
    }
    if (modeSelect._bwRefresh) modeSelect._bwRefresh();
}
loadCustomProfile();

btnDeleteCustom.addEventListener('click', () => {
    localStorage.removeItem('bw_custom_profile');
    loadCustomProfile();
    logTerm(mainTerminal, "Custom analysis profile deleted.", true);
});

// --- WHITELIST & AUTO-LIST ---
const DEFAULT_WHITELIST = ['discord.com', 'discordapp.com', 'gateway.discord.gg', 'youtube.com', 'googlevideo.com', 'x.com', 'roblox.com'];

ipcRenderer.send('load-whitelist');

ipcRenderer.on('whitelist-data', (event, data) => {
    if(data) whitelistInput.value = data;
    else if(autoWhitelistToggle.checked) whitelistInput.value = DEFAULT_WHITELIST.join('\n');
});

document.getElementById('btnSaveWhitelist').addEventListener('click', () => {
    ipcRenderer.send('save-whitelist-only', whitelistInput.value);
    const s = document.getElementById('saveStatus');
    s.style.display = 'inline';
    setTimeout(() => s.style.display = 'none', 2000);
});

// --- ENGINE CONTROLS ---
// --- ENGINE HEALTH BADGE ---
// Polls the main process every 5 seconds while the engine is running and
// renders a colour-coded pill showing the last 10 minutes of probe results.
// Color tiers: ≥90% good (green) · 60–89% warn (orange) · <60% bad (red)
// While samples<3 we show "warming up" (blue, pulsing).
const healthPill   = document.getElementById('healthPill');
const healthValue  = document.getElementById('healthValue');
const healthMeta   = document.getElementById('healthMeta');
let healthTimer    = null;
let isEngineRunningForHealth = false;

function trendArrow(t) {
    if (t === 'improving') return '▲';
    if (t === 'degrading') return '▼';
    if (t === 'stable')    return '•';
    return '';
}

async function refreshHealthBadge() {
    try {
        const h = await ipcRenderer.invoke('get-engine-health');
        if (!h || !h.engineRunning) {
            if (healthPill) healthPill.style.display = 'none';
            return;
        }

        if (!healthPill) return;
        healthPill.style.display = 'inline-flex';
        healthPill.classList.remove('good', 'warn', 'bad', 'warming');

        // Not enough samples yet — show warming-up state
        if (h.samples === null || h.samples < 3 || h.percent === null) {
            healthPill.classList.add('warming');
            healthValue.textContent = '— %';
            healthMeta.textContent  = `${h.samples || 0} probe${(h.samples || 0) === 1 ? '' : 's'} · warming up`;
            return;
        }

        // Apply tier
        if      (h.percent >= 90) healthPill.classList.add('good');
        else if (h.percent >= 60) healthPill.classList.add('warn');
        else                      healthPill.classList.add('bad');

        const arrow = trendArrow(h.trend);
        healthValue.textContent = `${h.percent}%`;
        healthMeta.textContent  = `${h.ok}/${h.samples} · ${h.trend} ${arrow}`.trim();
    } catch (e) {
        // Main not ready or IPC error — keep current state
    }
}

// Drive the polling based on engine status events the existing handler dispatches
ipcRenderer.on('zapret-status', (event, status) => {
    if (status === 'running') {
        isEngineRunningForHealth = true;
        // First refresh immediately, then on a 5s interval
        refreshHealthBadge();
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = setInterval(refreshHealthBadge, 5000);
    } else {
        isEngineRunningForHealth = false;
        if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
        if (healthPill) healthPill.style.display = 'none';
    }
});

// If we land in an already-running engine (window reopened mid-session), kick
// off polling right away — the startup state sync further down already paints
// the running UI, we just need the badge to follow.
(async () => {
    try {
        const st = await ipcRenderer.invoke('query-engine-status');
        if (st && st.zapret && st.zapret.running) {
            isEngineRunningForHealth = true;
            refreshHealthBadge();
            if (healthTimer) clearInterval(healthTimer);
            healthTimer = setInterval(refreshHealthBadge, 5000);
        }
    } catch (e) { /* ignore */ }
})();

// --- TURKEY MASTER LIST TOGGLE ---
// Bundled hostlist of Türkiye-blocked / throttled domains. Defaults ON.
// Toggling re-writes the user pref to main process settings.json.
const trMasterToggle = document.getElementById('trMasterToggle');
const trMasterCount  = document.getElementById('trMasterCount');

(async () => {
    try {
        const stored = await ipcRenderer.invoke('settings-get', 'dpi_use_tr_master_list');
        // undefined → default true
        trMasterToggle.checked = stored === undefined ? true : (stored === true);
    } catch (e) { trMasterToggle.checked = true; }

    try {
        const info = await ipcRenderer.invoke('get-tr-master-info');
        if (info && typeof info.count === 'number' && trMasterCount) {
            trMasterCount.textContent = `${info.count} domains bundled (Discord, Roblox, YouTube, X, Mega, Twitch, …).`;
        }
    } catch (e) { /* ignore */ }
})();

trMasterToggle.addEventListener('change', async (e) => {
    await ipcRenderer.invoke('settings-set', 'dpi_use_tr_master_list', e.target.checked);
});

// --- AUTO-FAILOVER TOGGLE ---
// Persisted in main settings.json so the user's preference survives restarts.
// Disabled when ISP detection couldn't produce a chain (nothing to rotate to).
const failoverToggle = document.getElementById('failoverToggle');
const failoverHint   = document.getElementById('failoverHint');

(async () => {
    try {
        const stored = await ipcRenderer.invoke('settings-get', 'dpi_failover');
        failoverToggle.checked = stored === true;
    } catch (e) { /* default off */ }
})();

failoverToggle.addEventListener('change', async (e) => {
    await ipcRenderer.invoke('settings-set', 'dpi_failover', e.target.checked);
});

// When ISP detection finishes, gate the toggle on having a chain to rotate
function reflectFailoverAvailability() {
    const haveChain = Array.isArray(recommendedProfileIds) && recommendedProfileIds.length > 1;
    if (!haveChain) {
        failoverToggle.disabled = true;
        failoverToggle.checked  = false;
        if (failoverHint) failoverHint.textContent = 'Needs a known ISP with multiple recommended profiles. Detection inconclusive — toggle disabled.';
    } else {
        failoverToggle.disabled = false;
        if (failoverHint) failoverHint.textContent = `Rotate through ${recommendedProfileIds.length} profiles if Discord becomes unreachable.`;
    }
}
// Re-evaluate after the ISP banner finishes its async detection
setTimeout(reflectFailoverAvailability, 1500);
setTimeout(reflectFailoverAvailability, 5000);

btnStart.addEventListener('click', () => {
    const mode = modeSelect.value;
    const config = {
        mode: mode,
        customArgs: mode === 'custom' ? savedCustomArgs : null,
        whitelistData: whitelistInput.value,
        failover: !!(failoverToggle && failoverToggle.checked && !failoverToggle.disabled)
    };
    btnStart.disabled = true;
    ipcRenderer.send('start-zapret', config);
});

btnStop.addEventListener('click', () => {
    ipcRenderer.send('stop-zapret');
});

ipcRenderer.on('zapret-status', (event, status) => {
    if (status === 'running') {
        statusBadge.classList.add('running');
        statusTxt.textContent = i18n.t('dpi.engine_active');
        btnStart.style.display = 'none';
        btnStop.style.display = 'block';
    } else {
        statusBadge.classList.remove('running');
        statusTxt.textContent = i18n.t('dpi.engine_stopped');
        btnStart.style.display = 'block';
        btnStop.style.display = 'none';
    }
    btnStart.disabled = false;
});

// --- STARTUP STATE SYNC ---
// When the user closes the DPI window and reopens it, the renderer is fresh but
// the zapret backend in main may still be running. Sync the UI to that truth so
// the user doesn't see "Engine Stopped" while it's actually active.
(async () => {
    try {
        const st = await ipcRenderer.invoke('query-engine-status');
        if (st && st.zapret && st.zapret.running) {
            statusBadge.classList.add('running');
            statusTxt.textContent = i18n.t('dpi.engine_active');
            btnStart.style.display = 'none';
            btnStop.style.display = 'block';
            const modeName = st.zapret.mode ? st.zapret.mode.toUpperCase() : 'UNKNOWN';
            logTerm(mainTerminal, `[INFO] Engine already active. Profile: ${modeName}`);
            // Reflect the running profile in the dropdown
            if (st.zapret.mode && modeSelect) {
                modeSelect.value = st.zapret.mode;
                if (modeSelect._bwRefresh) modeSelect._bwRefresh();
            }
        }
    } catch (e) { /* main not ready yet — ignore */ }
})();

ipcRenderer.on('zapret-log', (event, msg) => {
    logTerm(mainTerminal, msg, msg.includes('ERROR') || msg.includes('SYS'));
});

// --- BLOCKCHECK ANALYSIS & REPORTING ---
const btnQuickScan       = document.getElementById('btnQuickScan');
const btnDeepScan        = document.getElementById('btnDeepScan');
const btnCancelScan      = document.getElementById('btnCancelBlockcheck');
const scanProgressCard   = document.getElementById('scanProgressCard');
const scanPhaseLabel     = document.getElementById('scanPhaseLabel');
const scanProgressCount  = document.getElementById('scanProgressCount');
const scanProgressFill   = document.getElementById('scanProgressFill');
const scanProgressTarget = document.getElementById('scanProgressTarget');
const topResultsCard     = document.getElementById('topResultsCard');
const topResultsList     = document.getElementById('topResultsList');

let selectedScanMode = 'quick';

function setScanMode(mode) {
    selectedScanMode = mode;
    btnQuickScan.classList.toggle('active', mode === 'quick');
    btnDeepScan.classList.toggle('active', mode === 'deep');
    btnBlockcheck.textContent = i18n.t(mode === 'quick' ? 'dpi.btn_start_quick' : 'dpi.btn_start_deep');
}
btnQuickScan.addEventListener('click', () => setScanMode('quick'));
btnDeepScan.addEventListener('click',  () => setScanMode('deep'));

btnBlockcheck.addEventListener('click', () => {
    blockcheckTerminal.innerHTML = '';
    analysisLogs = [];
    btnDownloadReport.style.display = 'none';
    topResultsCard.style.display = 'none';
    topResultsList.innerHTML = '';

    btnBlockcheck.style.display = 'none';
    btnCancelScan.style.display = 'inline-flex';

    // Reset progress UI
    scanProgressCard.style.display = 'block';
    scanPhaseLabel.textContent = 'Initializing…';
    scanProgressCount.textContent = '0 / 0';
    scanProgressFill.style.width = '0%';
    scanProgressTarget.textContent = '—';

    ipcRenderer.send('run-blockcheck', { mode: selectedScanMode });
});

btnCancelScan.addEventListener('click', () => {
    btnCancelScan.disabled = true;
    btnCancelScan.textContent = 'Cancelling…';
    ipcRenderer.send('cancel-blockcheck');
});

function resetScanUI() {
    btnBlockcheck.style.display = 'inline-flex';
    btnBlockcheck.disabled = false;
    btnCancelScan.style.display = 'none';
    btnCancelScan.disabled = false;
    btnCancelScan.textContent = 'Cancel Scan';
}

ipcRenderer.on('blockcheck-log', (event, msg) => {
    logTerm(blockcheckTerminal, msg);
});

ipcRenderer.on('blockcheck-progress', (event, data) => {
    if (!data) return;
    const { phase, current, total, label } = data;
    if (phase === 'phase1') scanPhaseLabel.textContent = 'Phase 1 — testing profiles';
    else if (phase === 'phase2') scanPhaseLabel.textContent = 'Phase 2 — mutation engine';
    if (typeof current === 'number' && typeof total === 'number' && total > 0) {
        scanProgressCount.textContent = `${current} / ${total}`;
        scanProgressFill.style.width = `${Math.round((current / total) * 100)}%`;
    }
    if (label) scanProgressTarget.textContent = label;
});

function renderTopResults(top) {
    if (!Array.isArray(top) || top.length === 0) return;
    topResultsList.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    top.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'top-result-row' + (i === 0 ? ' gold' : '');
        const voiceTag = p.voice
            ? '<span class="pass">voice ✓</span>'
            : '<span class="fail">voice ✗</span>';
        const vendorTag = p.vendor ? `<span>${p.vendor}</span>` : '';
        const scoreTotal = 5; // Matches TARGETS.length in main.js
        row.innerHTML = `
            <div class="top-medal">${medals[i] || '·'}</div>
            <div class="top-result-info">
                <div class="top-result-name">${p.name}</div>
                <div class="top-result-meta">
                    <span>${p.score}/${scoreTotal} TCP</span>
                    ${voiceTag}
                    ${vendorTag}
                </div>
            </div>
        `;
        topResultsList.appendChild(row);
    });
    topResultsCard.style.display = 'block';
}

ipcRenderer.on('blockcheck-done', (event, profileData) => {
    localStorage.setItem('bw_custom_profile', JSON.stringify(profileData));
    loadCustomProfile();
    modeSelect.value = 'custom';
    if (modeSelect._bwRefresh) modeSelect._bwRefresh();

    // Surface the voice-readiness result
    if (profileData.voice === true) {
        logTerm(blockcheckTerminal, '[VOICE] Profile supports Discord voice (UDP path verified) ✓');
    } else if (profileData.voice === false) {
        logTerm(blockcheckTerminal, '[VOICE WARNING] Profile is WEB-ONLY — Discord calls will hang on "Starting..."');
    }

    // Render the Top 3 alternatives card
    renderTopResults(profileData.topProfiles);

    // Hide the progress card now that we're done
    scanPhaseLabel.textContent = 'Complete';
    scanProgressFill.style.width = '100%';

    resetScanUI();
    btnDownloadReport.style.display = 'inline-flex';
});

ipcRenderer.on('blockcheck-status', (event, status) => {
    if (status === 'done') {
        resetScanUI();
        scanProgressCard.style.display = 'none';
        btnDownloadReport.style.display = 'inline-flex';
    }
});

btnDownloadReport.addEventListener('click', () => {
    const reportText = `=============================================\n` +
                       `BURNEDWOLF NETWORK ANALYSIS REPORT\n` +
                       `Date: ${new Date().toLocaleString()}\n` +
                       `=============================================\n\n` +
                       analysisLogs.join('\n') +
                       `\n\n=============================================\n` +
                       `BurnedWolf Security Systems\n`;
    
    ipcRenderer.send('save-analysis-report', reportText);
});