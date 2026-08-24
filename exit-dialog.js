// ==========================================================================
// --- EXIT DIALOG ---
// ==========================================================================
// Purely presentational. The real teardown (tor → zapret → dnscrypt + DNS
// restore) runs synchronously in the main process once 'exit-yes' is sent;
// this window exists so the user sees WHY the app takes a second to go away,
// and so the DNS-restore step is visibly acknowledged rather than silent.

const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

// The cloth is finished off, pick by pick, as the session ends.
const loom = LOOM.weave(document.getElementById('exitLoom'), { pps: 13, loop: false });
const rows = Array.from(document.querySelectorAll('.kill'));

window.onload = () => {
    // Tick the steps in the order the main process actually runs them.
    rows.forEach((r, i) => setTimeout(() => r.classList.add('done'), 320 + i * 420));

    // Keep the original 2s grace period before the actual quit.
    setTimeout(() => ipcRenderer.send('exit-yes'), 2000);
};
