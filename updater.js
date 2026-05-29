const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

    function hideAllStates() {
        document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
    }

    setTimeout(() => {
        ipcRenderer.send('check-update');
    }, 1500); 

    ipcRenderer.on('update-available', (event, info) => {
        hideAllStates();
        document.getElementById('versionText').textContent = `${info.current}  ➔  ${info.new}`;
        document.getElementById('updateAvailableState').classList.add('active');
    });

    ipcRenderer.on('up-to-date', () => {
        hideAllStates();
        document.getElementById('upToDateState').classList.add('active');
        // Card accent (border / ambient glow) is now driven by a MutationObserver in updater.html
        setTimeout(() => { ipcRenderer.send('proceed-to-splash'); }, 1200);
    });

    ipcRenderer.on('server-error', () => {
        hideAllStates();
        document.getElementById('errorState').classList.add('active');
        // Card accent (border / ambient glow) is now driven by a MutationObserver in updater.html
    });

    document.getElementById('btnUpdateClose').addEventListener('click', () => { ipcRenderer.send('exit-app'); });
    document.getElementById('btnErrorClose').addEventListener('click', () => { ipcRenderer.send('exit-app'); });
    
    document.getElementById('btnUpdate').addEventListener('click', () => {
        hideAllStates();
        document.getElementById('progressState').classList.add('active');
        ipcRenderer.send('start-download');
    });

    ipcRenderer.on('download-progress', (e, percent) => {
        document.getElementById('pFill').style.width = percent + '%';
        document.getElementById('statusText').textContent = `${i18n.t('updater.downloading')} · ${percent}%`;
    });

    ipcRenderer.on('extracting', () => {
        document.getElementById('pFill').style.width = '100%';
        document.getElementById('pFill').style.background = 'linear-gradient(90deg, #F0B232 0%, #F5C757 100%)';
        document.getElementById('pFill').style.boxShadow = '0 0 12px rgba(240, 178, 50, 0.35)';
        document.getElementById('statusText').style.color = '#F0B232';
        document.getElementById('statusText').textContent = i18n.t('updater.extracting');
    });

    ipcRenderer.on('extraction-done', () => {
        let secondsLeft = 10;

        document.getElementById('pFill').style.background = 'linear-gradient(90deg, var(--success) 0%, #4ADE80 100%)';
        document.getElementById('pFill').style.boxShadow = '0 0 12px var(--success-glow)';
        document.getElementById('statusText').style.color = 'var(--success)';

        const logoBox = document.querySelector('#progressState .icon-orb');
        if (logoBox) logoBox.classList.add('success');

        // Hide the spinner now that work is done
        const spinner = document.querySelector('#progressState .ring-spinner');
        if (spinner) spinner.style.display = 'none';

        const countdownTimer = setInterval(() => {
            document.getElementById('statusText').textContent = i18n.t('updater.restart_in', { n: secondsLeft });
            secondsLeft--;

            if (secondsLeft < 0) {
                clearInterval(countdownTimer);
                document.getElementById('statusText').textContent = i18n.t('updater.shutting_down');
                ipcRenderer.send('apply-update');
            }
        }, 1000);
    });