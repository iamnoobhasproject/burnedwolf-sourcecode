// ==========================================================================
// --- BURNEDWOLF AI — EVENT TAP ---
// ==========================================================================
// A small ring buffer fed from the app's own broadcast bus. It exists so the
// assistant can answer "what just happened?" / "why did it stop?" with the same
// events the user saw scroll past in the log strip, instead of guessing.
//
// Only operational channels are captured. Nothing is written to disk and the
// buffer never leaves the machine unless the user sends a message that makes
// the model call get_recent_events.

const { tapBroadcast } = require('../util/broadcast');

const MAX = 160;
const events = [];

// Channels worth remembering, mapped to how their payload should be rendered.
const WATCHED = {
    'zapret-log':            (a) => String(a[0] ?? ''),
    'zapret-status':         (a) => `engine status: ${a[0]}`,
    'tor-log':               (a) => String(a[0] ?? ''),
    'tor-ready':             (a) => `tor ready on port ${a[0]}`,
    'encrypted-dns-status':  (a) => `encrypted DNS ${a[0] && a[0].active ? 'ON' : 'OFF'}${a[0] && a[0].crashed ? ' (proxy crashed, DNS reverted)' : ''}`,
    'dns-preflight-result':  (a) => `DNS self-check: ${a[0] && a[0].state}`,
    'blockcheck-log':        (a) => `analysis: ${String(a[0] ?? '')}`,
    'verify-log':            (a) => `integrity: ${String(a[0] ?? '')}`,
    'verify-error':          (a) => `integrity ERROR: ${String(a[0] ?? '')}`
};

// Tor bootstrap spams; keep only the milestones.
function keep(channel, text) {
    if (channel === 'tor-log' && !/Bootstrapped/.test(text)) return false;
    return text && text.trim().length > 0;
}

tapBroadcast((channel, args) => {
    const fmt = WATCHED[channel];
    if (!fmt) return;
    let text = '';
    try { text = fmt(args); } catch (e) { return; }
    if (!keep(channel, text)) return;
    events.push({ t: Date.now(), channel, text: text.slice(0, 400) });
    if (events.length > MAX) events.splice(0, events.length - MAX);
});

function getEvents(limit) {
    const n = Math.max(1, Math.min(MAX, limit || 30));
    return events.slice(-n).map(e => ({
        time: new Date(e.t).toLocaleTimeString(),
        source: e.channel,
        text: e.text
    }));
}

module.exports = { getEvents };
