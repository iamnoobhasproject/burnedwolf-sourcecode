const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

// Re-render the module grid when the language changes so module names/descs
// translate live without needing to reopen the spotlight.
ipcRenderer.on('language-changed', () => {
    setTimeout(() => { try { renderResults(searchInput.value || ''); } catch (e) {} }, 60);
});

const searchInput = document.getElementById('searchInput');
const resultsList = document.getElementById('resultsList');
const emptyState = document.getElementById('emptyState');
const announceList = document.getElementById('announceList');

// Module catalog — names/descriptions resolve through i18n at render time so
// they stay in sync with the current language. Tags stay English so search
// works regardless of UI language.
const modules = [
    { id: 'dpi',     nameKey: 'spotlight.module_dpi',     descKey: 'spotlight.module_dpi_desc',     tags: ['dpi', 'zapret', 'bypass', 'shield', 'internet'],   icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>' },
    { id: 'discord', nameKey: 'spotlight.module_discord', descKey: 'spotlight.module_discord_desc', tags: ['discord', 'proxy', 'voice', 'chat'],               icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>' },
    { id: 'verify',  nameKey: 'spotlight.module_verify',  descKey: 'spotlight.module_verify_desc',  tags: ['verify', 'integrity', 'repair', 'fix', 'system'],  icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>' }
];

// Resolve translated name/desc for a module at render time
function moduleName(m) { return i18n.t(m.nameKey); }
function moduleDesc(m) { return i18n.t(m.descKey); }

let currentIndex = 0;
let currentResults = [];

// --- LOGS ACCORDION LOGIC ---
const logsHeader = document.getElementById('logsHeader');
const logsAccordion = document.getElementById('logsAccordion');
logsHeader.addEventListener('click', () => {
    logsAccordion.classList.toggle('expanded');
});

// --- RENDER & SELECTION LOGIC ---
function renderResults(query = "") {
    resultsList.innerHTML = '';
    const q = query.toLowerCase().trim();

    // Grid layout — match by name and tags only (descriptions removed from UI)
    currentResults = modules.filter(m =>
        moduleName(m).toLowerCase().includes(q) ||
        m.tags.some(t => t.includes(q))
    );

    if (currentResults.length === 0) {
        emptyState.style.display = 'block';
    } else {
        emptyState.style.display = 'none';
        currentResults.forEach((mod, index) => {
            const div = document.createElement('div');
            div.className = 'result-item';

            div.addEventListener('mouseenter', () => {
                currentIndex = index;
                updateSelection(false);
            });

            div.onclick = () => executeAction(mod.id);
            div.dataset.moduleId = mod.id;
            // Desktop-icon style: label on top, icon middle, RAM usage badge below
            div.innerHTML = `
                <div class="item-title">${moduleName(mod)}</div>
                <div class="item-icon">${mod.icon}</div>
                <div class="item-mem idle" data-mem-for="${mod.id}">idle</div>
            `;
            resultsList.appendChild(div);
        });
        updateSelection(false);
        refreshMemoryBadges();
    }
}

// --- MODULE MEMORY USAGE BADGES ---
let memoryPollTimer = null;
async function refreshMemoryBadges() {
    try {
        const usage = await ipcRenderer.invoke('get-module-memory');
        if (!usage) return;
        document.querySelectorAll('.item-mem').forEach(span => {
            const id = span.dataset.memFor;
            const mb = usage[id];
            if (mb == null) {
                span.textContent = 'idle';
                span.classList.add('idle');
                span.classList.remove('active');
            } else {
                span.textContent = `${mb} MB`;
                span.classList.remove('idle');
                span.classList.add('active');
            }
        });
    } catch (e) { /* ignore — IPC handler may not be ready yet */ }
}

function updateSelection(shouldScroll = false) {
    const items = resultsList.querySelectorAll('.result-item');
    items.forEach((item, index) => {
        if (index === currentIndex) {
            item.classList.add('active');
            if (shouldScroll) {
                item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        } else {
            item.classList.remove('active');
        }
    });
}

function executeAction(id) {
    ipcRenderer.send('hide-spotlight');

    if      (id === 'dpi')     ipcRenderer.send('open-dpi-window');
    else if (id === 'discord') ipcRenderer.send('open-discord-window');
    else if (id === 'verify')  ipcRenderer.send('open-verify-window');

    searchInput.value = "";
}

// --- FETCH LOGS & UPDATE CHECK ---
async function fetchSpotlightData() {
    try {
        const lRes = await fetch('https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/logs.txt?t=' + Date.now());
        const text = await lRes.text();
        const lines = text.split('\n').filter(l => l.trim() !== "");
        
        let html = '';
        lines.forEach(line => {
            html += `<div class="announce-item"><div class="announce-bullet"></div><div>${line.trim()}</div></div>`;
        });
        announceList.innerHTML = lines.length > 0 ? html : '<div style="text-align:center; padding:10px; color:var(--text-muted); font-size:0.75rem;">No new system logs.</div>';

        // UPDATE CHECK LOGIC
        const localVersion = localStorage.getItem('bw_current_version');
        if (localVersion) {
            const vRes = await fetch('https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/version.json?t=' + Date.now());
            const vData = await vRes.json();
            
            if (vData.version !== localVersion) {
                document.getElementById('spotlightUpdateArea').style.display = 'flex';
                document.getElementById('spotlightNewVersion').textContent = vData.version;
                logsAccordion.classList.add('expanded'); 
            } else {
                document.getElementById('spotlightUpdateArea').style.display = 'none';
            }
        }
    } catch(e) {
        announceList.innerHTML = '<div style="text-align:center; padding:10px; color:var(--text-muted); font-size:0.75rem;">Failed to connect to server.</div>';
    }
}

// --- UPDATE HANDLERS ---
const btnSpotlightUpdate = document.getElementById('btnSpotlightUpdate');
const spotlightUpdateProgress = document.getElementById('spotlightUpdateProgress');

if (btnSpotlightUpdate) {
    btnSpotlightUpdate.addEventListener('click', () => {
        btnSpotlightUpdate.style.display = 'none';
        spotlightUpdateProgress.style.display = 'block';
        ipcRenderer.send('start-download');
    });
}

ipcRenderer.on('download-progress', (event, percent) => {
    if (spotlightUpdateProgress) spotlightUpdateProgress.textContent = `Downloading: ${percent}%`;
});

ipcRenderer.on('extracting', () => {
    if (spotlightUpdateProgress) {
        spotlightUpdateProgress.style.color = 'var(--warning)';
        spotlightUpdateProgress.textContent = "Extracting files...";
    }
});

ipcRenderer.on('extraction-done', () => {
    let sec = 5;
    if (spotlightUpdateProgress) {
        spotlightUpdateProgress.style.color = 'var(--success)';
        const restartTimer = setInterval(() => {
            spotlightUpdateProgress.textContent = `Rebooting system (${sec})...`;
            sec--;
            if (sec < 0) {
                clearInterval(restartTimer);
                ipcRenderer.send('apply-update');
            }
        }, 1000);
    }
});

// --- KEYBOARD LISTENER (grid-aware: Up/Down jumps rows, Left/Right walks cols) ---
const GRID_COLUMNS = 4; // keep in sync with .results-container `grid-template-columns`

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        ipcRenderer.send('hide-spotlight');
        return;
    }

    if (currentResults.length === 0) return;

    const total = currentResults.length;
    let next = currentIndex;

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        next = Math.min(currentIndex + 1, total - 1);
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        next = Math.max(currentIndex - 1, 0);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        next = Math.min(currentIndex + GRID_COLUMNS, total - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        next = Math.max(currentIndex - GRID_COLUMNS, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        executeAction(currentResults[currentIndex].id);
        return;
    } else {
        return;
    }

    if (next !== currentIndex) {
        currentIndex = next;
        updateSelection(true);
    }
});

searchInput.addEventListener('input', (e) => {
    currentIndex = 0;
    renderResults(e.target.value);
});

ipcRenderer.on('spotlight-opened', () => {
    searchInput.value = "";
    currentIndex = 0;
    logsAccordion.classList.remove('expanded');
    renderResults();
    searchInput.focus();
    fetchSpotlightData();
    // Refresh memory immediately, then keep it live while the panel is visible.
    refreshMemoryBadges();
    if (memoryPollTimer) clearInterval(memoryPollTimer);
    memoryPollTimer = setInterval(refreshMemoryBadges, 2000);
});

// Stop polling when the spotlight is hidden (the window blurs).
window.addEventListener('blur', () => {
    if (memoryPollTimer) { clearInterval(memoryPollTimer); memoryPollTimer = null; }
});

renderResults();