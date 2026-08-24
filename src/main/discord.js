// ==========================================
// --- INTEGRATED TOR DISCORD MODULE (session glue) ---
// ==========================================
// Routes the Discord webview partition through the local Tor SOCKS port and
// grants the media permissions WebRTC needs. The Discord window itself is
// created in windows.js; credentials live in credentials.js.
const { ipcMain, session } = require('electron');
const tor = require('./tor');

ipcMain.on('enable-discord-proxy', async (event) => {
    try {
        const dSession = session.fromPartition('persist:discordPartition');
        await dSession.setProxy({ proxyRules: `socks5://127.0.0.1:${tor.getState().port}` });

        // Auto-grant media (microphone / camera) permissions inside the Discord
        // webview. Without these handlers Electron silently rejects getUserMedia
        // and the call stays muted even when the user clicked "Allow" inside
        // Discord's own UI. We scope this strictly to the Discord partition so
        // it can't affect the main app.
        const mediaPermissions = new Set([
            'media',                 // legacy single permission
            'microphone',
            'camera',
            'audioCapture',
            'videoCapture',
            'mediaKeySystem',
            'display-capture'
        ]);
        dSession.setPermissionRequestHandler((webContents, permission, callback) => {
            callback(mediaPermissions.has(permission));
        });
        dSession.setPermissionCheckHandler((webContents, permission) => {
            return mediaPermissions.has(permission);
        });

        event.reply('discord-proxy-success');
    } catch (e) {
        console.error("Discord Proxy Error: ", e);
    }
});
