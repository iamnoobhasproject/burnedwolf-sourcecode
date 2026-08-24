// --- AUTO-START ---
// Registers/removes a Windows scheduled task that launches the app elevated
// at logon. Only meaningful for the packaged build.
const { app, ipcMain } = require('electron');
const { exec } = require('child_process');

ipcMain.on('set-autostart', (event, state) => {
    if (!app.isPackaged) return;

    const exePath = process.execPath;
    const taskName = "BurnedWolf_AutoStart";

    if (state) {
        const addCmd = `schtasks /create /tn "${taskName}" /tr "\\"${exePath}\\" --hidden" /sc onlogon /rl highest /f`;
        exec(addCmd, { windowsHide: true });
    } else {
        const removeCmd = `schtasks /delete /tn "${taskName}" /f`;
        exec(removeCmd, { windowsHide: true });
    }
});
