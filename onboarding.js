const { ipcRenderer } = require('electron');
const i18n = require('./i18n');

let selectedLang   = null;
let selectedUpdate = null;

const stepIndicator   = document.getElementById('stepIndicator');
const stepLanguage    = document.getElementById('step-language');
const stepUpdate      = document.getElementById('step-update');
const btnLangNext     = document.getElementById('btnLangNext');
const btnUpdateFinish = document.getElementById('btnUpdateFinish');
const footerHint      = document.getElementById('footerHint');

// Language tile selection
document.querySelectorAll('.lang-tile').forEach(tile => {
    tile.addEventListener('click', () => {
        document.querySelectorAll('.lang-tile').forEach(t => t.classList.remove('selected'));
        tile.classList.add('selected');
        selectedLang = tile.dataset.lang;
        btnLangNext.disabled = false;
        // Live-translate the rest of the onboarding UI as soon as user picks
        applyTranslation(selectedLang);
    });
});

// Step 1 -> Step 2 (with language now confirmed)
btnLangNext.addEventListener('click', async () => {
    if (!selectedLang) return;
    await ipcRenderer.invoke('settings-set', 'language', selectedLang);

    stepLanguage.classList.remove('active');
    stepUpdate.classList.add('active');
    applyTranslation(selectedLang);
    stepIndicator.textContent = i18n.t('onboard.step', { n: 2 });
});

// Update choice tiles
document.querySelectorAll('.choice-tile').forEach(tile => {
    tile.addEventListener('click', () => {
        document.querySelectorAll('.choice-tile').forEach(t => t.classList.remove('selected'));
        tile.classList.add('selected');
        selectedUpdate = tile.dataset.update === 'yes';
        btnUpdateFinish.disabled = false;
    });
});

// Finish — persist and tell main to proceed
btnUpdateFinish.addEventListener('click', async () => {
    if (selectedUpdate === null) return;
    await ipcRenderer.invoke('settings-set', 'auto_update',   selectedUpdate);
    await ipcRenderer.invoke('settings-set', 'onboarded',      true);
    ipcRenderer.send('onboarding-complete');
});

function applyTranslation(lang) {
    i18n.loadLang(lang);
    document.querySelector('#step-language .title').textContent    = i18n.t('onboard.lang_title');
    document.querySelector('#step-language .subtitle').textContent = i18n.t('onboard.lang_sub');
    btnLangNext.textContent                                        = i18n.t('common.continue');
    document.getElementById('updateTitle').textContent             = i18n.t('onboard.update_title');
    document.getElementById('updateSubtitle').textContent          = i18n.t('onboard.update_sub');
    document.getElementById('updateYesName').textContent           = i18n.t('onboard.update_yes');
    document.getElementById('updateYesDesc').textContent           = i18n.t('onboard.update_yes_desc');
    document.getElementById('updateNoName').textContent            = i18n.t('onboard.update_no');
    document.getElementById('updateNoDesc').textContent            = i18n.t('onboard.update_no_desc');
    btnUpdateFinish.textContent                                    = i18n.t('onboard.finish');
    footerHint.textContent                                         = i18n.t('onboard.footer');
    const currentStep = stepLanguage.classList.contains('active') ? 1 : 2;
    stepIndicator.textContent = i18n.t('onboard.step', { n: currentStep });
}

// Initial paint using English
applyTranslation('en');
