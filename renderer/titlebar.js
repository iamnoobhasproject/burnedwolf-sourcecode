const { ipcRenderer } = require('electron');
const i18n = require('../i18n');

// Initialize translations as early as possible so the first paint shows the
// user's preferred language. applyToDom runs again after DOMContentLoaded.
i18n.init();

// Language pill picker — instantly switches the entire app's UI
function highlightActiveLang() {
    const current = i18n.getLang();
    document.querySelectorAll('.lang-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.lang === current);
    });
}
document.addEventListener('DOMContentLoaded', () => {
    highlightActiveLang();
    document.querySelectorAll('.lang-pill').forEach(btn => {
        btn.addEventListener('click', async () => {
            const lang = btn.dataset.lang;
            await ipcRenderer.invoke('settings-set', 'language', lang);
            // Main process will broadcast 'language-changed' to every window
            // (including this one), so i18n.applyToDom() runs automatically.
            highlightActiveLang();
        });
    });
});
// Re-highlight when language changes from another window or programmatically
ipcRenderer.on('language-changed', () => setTimeout(highlightActiveLang, 50));

let localVersion = null;

ipcRenderer.on('app-version', (event, version) => {
    localVersion = version;
    document.getElementById('versionDisplay').textContent = localVersion;
    // Persist for Spotlight's update check
    localStorage.setItem('bw_current_version', localVersion);
});

const autoStartToggle = document.getElementById('autoStartToggle');
if (autoStartToggle) {
    // Persisted via main-process settings.json (localStorage on file:// renderers
    // is unreliable across Electron launches — see main.js settings handlers).
    (async () => {
        const isAutoStart = (await ipcRenderer.invoke('settings-get', 'autostart')) === true;
        autoStartToggle.checked = isAutoStart;
        ipcRenderer.send('set-autostart', isAutoStart);
    })();

    autoStartToggle.addEventListener('change', async (e) => {
        await ipcRenderer.invoke('settings-set', 'autostart', e.target.checked);
        ipcRenderer.send('set-autostart', e.target.checked);
    });
}

const autoUpdateToggle = document.getElementById('autoUpdateToggle');
if (autoUpdateToggle) {
    // Loaded from settings.json (defaults to true if absent — safer to be on)
    (async () => {
        const stored = await ipcRenderer.invoke('settings-get', 'auto_update');
        autoUpdateToggle.checked = stored === undefined ? true : (stored === true);
    })();

    autoUpdateToggle.addEventListener('change', async (e) => {
        await ipcRenderer.invoke('settings-set', 'auto_update', e.target.checked);
    });
}

// X now sends the app to the system tray. Use the tray icon's right-click
// menu to fully quit. (Minimize button removed — close == tray.)
document.getElementById('exit').addEventListener('click', () => ipcRenderer.send('minimize-window'));

const spotlightKeyBtn = document.getElementById('spotlightKeyBtn');
if (spotlightKeyBtn) {
    // Persisted via main-process settings.json
    let savedSpotlightKey = 'Ctrl+Space';
    (async () => {
        const stored = await ipcRenderer.invoke('settings-get', 'spotlight_hotkey');
        if (stored && typeof stored === 'string') savedSpotlightKey = stored;
        spotlightKeyBtn.textContent = savedSpotlightKey;
        ipcRenderer.send('update-spotlight-hotkey', savedSpotlightKey);
    })();

    let isRecordingSpotlight = false;
    spotlightKeyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isRecordingSpotlight = true;
        spotlightKeyBtn.textContent = "PRESS KEY...";
        spotlightKeyBtn.style.borderColor = "var(--primary)";
    });

    document.addEventListener('keydown', (e) => {
        if (!isRecordingSpotlight) return;
        e.preventDefault();

        let key = e.key;
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return;

        let char = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key.toUpperCase();
        const validKeyRegex = /^[A-Z0-9]$|^F(?:[1-9]|1[0-9]|2[0-4])$|^SPACE$|^ENTER$|^TAB$|^ESCAPE$|^BACKSPACE$|^DELETE$|^INSERT$|^HOME$|^END$|^PAGEUP$|^PAGEDOWN$|^UP$|^DOWN$|^LEFT$|^RIGHT$/;

        if (!validKeyRegex.test(char)) {
            spotlightKeyBtn.textContent = "INVALID KEY!";
            spotlightKeyBtn.style.borderColor = "var(--warning)";
            spotlightKeyBtn.style.color = "var(--warning)";
            setTimeout(() => {
                spotlightKeyBtn.textContent = savedSpotlightKey;
                spotlightKeyBtn.style.borderColor = "var(--border)";
                spotlightKeyBtn.style.color = "#fff";
                isRecordingSpotlight = false;
            }, 1500);
            return;
        }

        let keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        keys.push(char);

        savedSpotlightKey = keys.join('+');
        spotlightKeyBtn.textContent = savedSpotlightKey;
        spotlightKeyBtn.style.borderColor = "var(--border)";
        ipcRenderer.invoke('settings-set', 'spotlight_hotkey', savedSpotlightKey);

        ipcRenderer.send('update-spotlight-hotkey', savedSpotlightKey);
        isRecordingSpotlight = false;
    });

    window.addEventListener('click', (e) => {
        if (isRecordingSpotlight && e.target !== spotlightKeyBtn) {
            isRecordingSpotlight = false;
            spotlightKeyBtn.textContent = savedSpotlightKey;
            spotlightKeyBtn.style.borderColor = "var(--border)";
        }
    });
}
