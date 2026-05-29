const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

// Re-apply translations to dynamically-set status text on language change
ipcRenderer.on('language-changed', () => {
    setTimeout(() => {
        try {
            const topStatus = document.getElementById('topStatus');
            if (topStatus) {
                if (topStatus.style.color === 'var(--success)' || topStatus.style.borderColor === 'var(--success)') {
                    topStatus.textContent = i18n.t('discord.status_active');
                } else {
                    topStatus.textContent = i18n.t('discord.status_offline');
                }
            }
        } catch (e) {}
    }, 60);
});

    // WINDOW CONTROLS AND ICON CHANGES
    const btnMax = document.getElementById('btnMax');
    const maximizeIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>`;
    const restoreIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>`;

    document.getElementById('btnClose').addEventListener('click', () => ipcRenderer.send('close-discord-window'));
    document.getElementById('btnMin').addEventListener('click', () => ipcRenderer.send('minimize-discord-window'));
    btnMax.addEventListener('click', () => ipcRenderer.send('maximize-discord-window'));

    // Double Click Fullscreen
    document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
        if (e.target === document.querySelector('.titlebar') || e.target.classList.contains('brand')) {
            ipcRenderer.send('maximize-discord-window');
        }
    });

    ipcRenderer.on('window-maximized', () => { btnMax.innerHTML = restoreIcon; });
    ipcRenderer.on('window-restored', () => { btnMax.innerHTML = maximizeIcon; });

    const gatewayLayer = document.getElementById('gatewayLayer');
    const discordWebview = document.getElementById('discordWebview');
    const topStatus = document.getElementById('topStatus');
    const loaderContainer = document.getElementById('loaderContainer');
    
    // Form Containers
    const newLoginForm = document.getElementById('newLoginForm');
    const savedAccountForm = document.getElementById('savedAccountForm');
    const savedEmailDisplay = document.getElementById('savedEmailDisplay');
    const authDesc = document.getElementById('authDesc');

    let savedEmail = '';
    let savedPass = '';
    let autoLoginAttempted = false;

    // 1. Initialize Tor network
    ipcRenderer.send('start-tor');

    // 2. Tor is ready
    ipcRenderer.on('tor-ready', () => {
        topStatus.textContent = i18n.t('discord.status_establishing');
        ipcRenderer.send('enable-discord-proxy');
    });

    // 3. Manage UI when Proxy is ready
    ipcRenderer.on('discord-proxy-success', () => {
        topStatus.textContent = i18n.t('discord.status_active');
        topStatus.style.color = "var(--success)";
        topStatus.style.borderColor = "var(--success)";
        topStatus.style.background = "rgba(35, 165, 90, 0.1)";
        topStatus.style.boxShadow = "none"; // Removed neon effect
        
        checkSavedCredentials();
    });

    // CREDENTIAL CHECK FUNCTION (uses OS keychain via safeStorage)
    let cachedCreds = null;

    async function checkSavedCredentials() {
        // One-time migration from old plaintext localStorage to encrypted store
        const legacy = localStorage.getItem('sistem_discord_creds');
        if (legacy) {
            try {
                const parsed = JSON.parse(legacy);
                if (parsed && parsed.email && parsed.pass) {
                    await ipcRenderer.invoke('creds-save', 'discord', parsed);
                }
            } catch (e) {}
            localStorage.removeItem('sistem_discord_creds');
        }

        const res = await ipcRenderer.invoke('creds-load', 'discord');
        if (res && res.ok && res.data && res.data.email) {
            cachedCreds = res.data;
            savedEmailDisplay.textContent = res.data.email;
            newLoginForm.style.display = 'none';
            savedAccountForm.style.display = 'block';
            authDesc.textContent = "A secure identity has been previously configured on the system.";
        } else {
            cachedCreds = null;
            newLoginForm.style.display = 'block';
            savedAccountForm.style.display = 'none';
            authDesc.textContent = "Your account details are stored locally on this device only.";
        }
    }

    // --- BUTTON EVENTS ---

    document.getElementById('btnSaveLogin').addEventListener('click', async () => {
        const email = document.getElementById('txtEmail').value.trim();
        const pass = document.getElementById('txtPass').value;
        if(!email || !pass) { alert('Please enter your credentials.'); return; }

        const res = await ipcRenderer.invoke('creds-save', 'discord', { email, pass });
        if (!res || !res.ok) {
            alert('Could not store credentials securely on this system. Continuing without saving.');
        } else {
            cachedCreds = { email, pass };
        }
        savedEmail = email; savedPass = pass;
        startDiscord(true);
    });

    document.getElementById('btnSkip').addEventListener('click', () => { startDiscord(false); });

    document.getElementById('btnUseSaved').addEventListener('click', () => {
        if (!cachedCreds) { startDiscord(false); return; }
        savedEmail = cachedCreds.email; savedPass = cachedCreds.pass;
        startDiscord(true);
    });

    document.getElementById('btnSkipSaved').addEventListener('click', () => { startDiscord(false); });

    document.getElementById('btnDeleteSaved').addEventListener('click', async () => {
        await ipcRenderer.invoke('creds-delete', 'discord');
        cachedCreds = null;
        savedEmail = ''; savedPass = '';
        checkSavedCredentials();
    });

    // DISCORD LAUNCHER
    function startDiscord(shouldInject) {
        if(!shouldInject) { savedEmail = ''; savedPass = ''; }
        
        newLoginForm.style.display = 'none';
        savedAccountForm.style.display = 'none';
        loaderContainer.style.display = "flex";
        
        document.querySelectorAll('.btn').forEach(b => b.disabled = true);
        
        setTimeout(() => {
            gatewayLayer.style.display = 'none';
            discordWebview.style.display = 'flex';
            discordWebview.src = 'https://discord.com/login'; 
        }, 1200);
    }

    // SMART INJECTION
    discordWebview.addEventListener('did-finish-load', () => {
        const currentUrl = discordWebview.getURL();
        
        if (currentUrl.includes('login') && savedEmail && savedPass && !autoLoginAttempted) {
            autoLoginAttempted = true;
            
            const injectCode = `
                (function() {
                    let attempts = 0;
                    const timer = setInterval(() => {
                        attempts++;
                        const emailInput = document.querySelector('input[name="email"]');
                        const passInput = document.querySelector('input[name="password"]');
                        const loginBtn = document.querySelector('button[type="submit"]');

                        if (emailInput && passInput && loginBtn) {
                            clearInterval(timer);
                            
                            function setNativeValue(element, value) {
                                const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                                const prototype = Object.getPrototypeOf(element);
                                const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value").set;
                                if (valueSetter && valueSetter !== prototypeValueSetter) {
                                    prototypeValueSetter.call(element, value);
                                } else {
                                    valueSetter.call(element, value);
                                }
                                element.dispatchEvent(new Event('input', { bubbles: true }));
                            }

                            setNativeValue(emailInput, "${savedEmail}");
                            setNativeValue(passInput, "${savedPass}");
                            
                            setTimeout(() => {
                                loginBtn.removeAttribute('disabled');
                                loginBtn.click();
                            }, 500);
                            
                        } else if (attempts > 20) {
                            clearInterval(timer);
                        }
                    }, 500); 
                })();
            `;
            
            discordWebview.executeJavaScript(injectCode);
        }
    });