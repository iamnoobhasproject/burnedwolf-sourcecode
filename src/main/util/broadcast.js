// Sends an IPC message to every live renderer. This is the main process'
// only fan-out mechanism: engines broadcast state changes and any window
// that cares (DPI panel, spotlight, titlebar) picks them up.
const { BrowserWindow } = require('electron');

// Optional observers. BurnedWolf AI subscribes here so it can answer "what just
// happened?" from the same event stream the windows see, without any module
// having to know the AI exists.
const taps = new Set();

function broadcastToAll(channel, ...args) {
    for (const tap of taps) {
        try { tap(channel, args); } catch (e) {}
    }
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
            try { w.webContents.send(channel, ...args); } catch (e) {}
        }
    });
}

function tapBroadcast(fn) {
    taps.add(fn);
    return () => taps.delete(fn);
}

module.exports = { broadcastToAll, tapBroadcast };
