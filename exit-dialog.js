const { ipcRenderer } = require('electron');
const i18n = require('./i18n');
i18n.init();

window.onload = () => {
    // Show the loading animation for 2 seconds to ensure a graceful shutdown visual,
    // then send the exit command to completely close the app and clear all background processes.
    setTimeout(() => {
        ipcRenderer.send('exit-yes');
    }, 2000);
};