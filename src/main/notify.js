// --- TOAST NOTIFICATIONS ---
// Show a native Windows toast. Coalesces rapid-fire duplicates within 2s so
// log-spam (e.g. multiple TOR bootstrap milestones) doesn't burst the action center.
const { Notification } = require('electron');
const path = require('path');
const { ROOT } = require('./constants');

const recentToasts = new Map();

function notify(title, body, opts = {}) {
    try {
        const key = `${title}::${body}`;
        const now = Date.now();
        if (recentToasts.has(key) && (now - recentToasts.get(key)) < 2000) return;
        recentToasts.set(key, now);

        const n = new Notification({
            title: `BurnedWolf · ${title}`,
            body: String(body || ''),
            icon: path.join(ROOT, 'icon.png'),
            silent: opts.silent === true
        });
        n.show();
    } catch (e) { /* notifications can fail on some systems — ignore */ }
}

module.exports = { notify };
