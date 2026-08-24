// ==========================================================================
// --- FIRST-LAUNCH ONBOARDING ---
// ==========================================================================
// Three questions, each setting something the rest of the boot depends on:
// interface language, whether to check for updates at launch, and whether to
// open the BurnedWolf AI provider list once the app appears.

const { ipcRenderer } = require('electron');
const i18n = require('./i18n');

const $ = (id) => document.getElementById(id);
const TOTAL = 3;

let lang = null, wantUpdate = null, wantAi = null;

const stepLanguage = $('step-language'), stepUpdate = $('step-update'), stepAi = $('step-ai');
const btnLangNext = $('btnLangNext'), btnUpdateNext = $('btnUpdateNext'), btnFinish = $('btnUpdateFinish');

function stepNo() {
    if (stepLanguage.classList.contains('on')) return 1;
    if (stepUpdate.classList.contains('on')) return 2;
    return 3;
}
function go(el) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('on'));
    el.classList.add('on');
    $('stepIndicator').textContent = i18n.t('onboard.step', { n: stepNo(), total: TOTAL });
}

document.querySelectorAll('.lang').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.lang').forEach(x => x.classList.remove('sel'));
    t.classList.add('sel');
    lang = t.dataset.lang;
    btnLangNext.disabled = false;
    paint(lang);   // live-translate the rest of the wizard immediately
}));

btnLangNext.addEventListener('click', async () => {
    if (!lang) return;
    await ipcRenderer.invoke('settings-set', 'language', lang);
    go(stepUpdate);
});

document.querySelectorAll('.choice[data-update]').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.choice[data-update]').forEach(x => x.classList.remove('sel'));
    t.classList.add('sel');
    wantUpdate = t.dataset.update === 'yes';
    btnUpdateNext.disabled = false;
}));

btnUpdateNext.addEventListener('click', async () => {
    if (wantUpdate === null) return;
    await ipcRenderer.invoke('settings-set', 'auto_update', wantUpdate);
    go(stepAi);
});

document.querySelectorAll('.choice[data-ai]').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.choice[data-ai]').forEach(x => x.classList.remove('sel'));
    t.classList.add('sel');
    wantAi = t.dataset.ai === 'yes';
    btnFinish.disabled = false;
}));

btnFinish.addEventListener('click', async () => {
    if (wantAi === null) return;
    // The main window reads this flag once and opens the AI provider list.
    await ipcRenderer.invoke('settings-set', 'ai_open_on_first_run', wantAi);
    await ipcRenderer.invoke('settings-set', 'onboarded', true);
    ipcRenderer.send('onboarding-complete');
});

function paint(l) {
    i18n.loadLang(l);
    $('langTitle').textContent      = i18n.t('onboard.lang_title');
    $('langWhy').textContent        = i18n.t('onboard.lang_sub');
    btnLangNext.textContent         = i18n.t('common.continue');

    $('updateTitle').textContent    = i18n.t('onboard.update_title');
    $('updateSubtitle').textContent = i18n.t('onboard.update_sub');
    $('updateYesName').textContent  = i18n.t('onboard.update_yes');
    $('updateYesDesc').textContent  = i18n.t('onboard.update_yes_desc');
    $('updateNoName').textContent   = i18n.t('onboard.update_no');
    $('updateNoDesc').textContent   = i18n.t('onboard.update_no_desc');
    btnUpdateNext.textContent       = i18n.t('common.continue');

    $('aiTitle').textContent        = i18n.t('onboard.ai_title');
    $('aiSubtitle').textContent     = i18n.t('onboard.ai_sub');
    $('aiYesName').textContent      = i18n.t('onboard.ai_yes');
    $('aiYesDesc').textContent      = i18n.t('onboard.ai_yes_desc');
    $('aiNoName').textContent       = i18n.t('onboard.ai_no');
    $('aiNoDesc').textContent       = i18n.t('onboard.ai_no_desc');
    btnFinish.textContent           = i18n.t('onboard.finish');

    $('footerHint').textContent     = i18n.t('onboard.footer');
    $('stepIndicator').textContent  = i18n.t('onboard.step', { n: stepNo(), total: TOTAL });
}

paint('en');
