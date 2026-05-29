const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

// Mapping of dynamic phases to i18n keys (set as data-phase-key when changed)
const VERIFY_PHASE_KEYS = {
    connecting: 'verify.phase_connecting',
    download:   'verify.phase_download',
    extract:    'verify.phase_extract',
    check:      'verify.phase_check',
    repair:     'verify.phase_repair',
    cleanup:    'verify.phase_cleanup',
    done:       'verify.phase_done',
    error:      'verify.phase_error'
};

// Re-apply phase label / button text on language change
ipcRenderer.on('language-changed', () => {
    setTimeout(() => {
        try {
            const phase = document.getElementById('phaseText');
            const key = phase && phase.dataset.phaseKey;
            if (key) phase.textContent = i18n.t(key);
            const btn = document.getElementById('btnStartVerify');
            if (btn) {
                if (btn.disabled) btn.textContent = i18n.t('verify.btn_analyzing');
                else if (btn.textContent && btn.textContent.includes('CLOSE')) btn.textContent = i18n.t('verify.btn_done');
                else btn.textContent = i18n.t('verify.btn_start');
            }
        } catch (e) {}
    }, 60);
});

document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('close-verify-window'));
document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('minimize-verify-window'));

const btnStart = document.getElementById('btnStartVerify');
const progressBar = document.getElementById('progressBar');
const percentText = document.getElementById('percentText');
const phaseText = document.getElementById('phaseText');
const activeFileText = document.getElementById('activeFileText');
const terminal = document.getElementById('verifyTerminal');

function logTerm(msg, type = 'normal') {
    const div = document.createElement('div');
    div.className = 'log-line';
    let prefix = '<span style="color:var(--primary); font-weight:bold;">></span>';
    
    if(type === 'error') div.style.color = 'var(--primary)';
    if(type === 'success') div.style.color = 'var(--success)';
    if(type === 'warning') div.style.color = '#F0B232';

    div.innerHTML = `${prefix} ${msg}`;
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
}

btnStart.addEventListener('click', () => {
    btnStart.disabled = true;
    btnStart.textContent = i18n.t('verify.btn_analyzing');
    
    // Reset progress
    progressBar.style.width = `0%`;
    percentText.textContent = `0%`;
    phaseText.dataset.phaseKey = VERIFY_PHASE_KEYS.connecting;
    phaseText.textContent = i18n.t(VERIFY_PHASE_KEYS.connecting);
    activeFileText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Accessing secure server...`;
    
    terminal.innerHTML = '';
    logTerm("Initiating integrity verification...");
    
    ipcRenderer.send('start-verification');
});

ipcRenderer.on('verify-progress', (event, data) => {
    progressBar.style.width = `${data.percent}%`;
    percentText.textContent = `${data.percent}%`;
    
    // Icon and filename update
    activeFileText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg> ${data.msg}`;

    // Dynamic Phase Texts
    const key = VERIFY_PHASE_KEYS[data.phase];
    if (key) {
        phaseText.dataset.phaseKey = key;
        phaseText.textContent = i18n.t(key);
    }
});

ipcRenderer.on('verify-log', (event, msg) => {
    let type = 'normal';
    if(msg.includes('[MISSING FILE]') || msg.includes('[CORRUPT FILE]')) type = 'warning';
    if(msg.includes('repaired successfully') || msg.includes('flawless') || msg.includes('Completed')) type = 'success';
    logTerm(msg, type);
});

ipcRenderer.on('verify-error', (event, msg) => {
    logTerm(`CRITICAL ERROR: ${msg}`, 'error');
    btnStart.disabled = false;
    btnStart.textContent = i18n.t('common.retry');
    phaseText.dataset.phaseKey = VERIFY_PHASE_KEYS.error;
    phaseText.textContent = i18n.t(VERIFY_PHASE_KEYS.error);
    phaseText.style.color = "var(--primary)";
    progressBar.style.backgroundColor = 'var(--primary)';
});

ipcRenderer.on('verify-done', (event, result) => {
    progressBar.style.width = `100%`;
    progressBar.style.backgroundColor = `var(--success)`;
    percentText.textContent = `100%`;
    percentText.style.color = `var(--success)`;
    percentText.style.borderColor = `rgba(35, 165, 90, 0.3)`;
    percentText.style.boxShadow = `0 0 15px rgba(35, 165, 90, 0.2)`;
    
    activeFileText.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> System repair completed successfully.`;
    phaseText.dataset.phaseKey = VERIFY_PHASE_KEYS.done;
    phaseText.textContent = i18n.t(VERIFY_PHASE_KEYS.done);
    
    btnStart.disabled = false;
    btnStart.textContent = i18n.t('verify.btn_done');
    btnStart.onclick = () => ipcRenderer.send('close-verify-window');
    
    if (result.repairedCount > 0) {
        logTerm(`System firewall renewed. A total of ${result.repairedCount} files were repaired.`, 'success');
    } else {
        logTerm("Integrity verified at 100%. All files are original and no intervention was required.", 'success');
    }
});