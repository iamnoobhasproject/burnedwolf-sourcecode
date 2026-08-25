// ==========================================
// --- ENGINE STATISTICS STORE ---
// ==========================================
// The engine's in-memory healthHistory only covers a rolling 10 minutes and is
// wiped on every profile change / stop. This module keeps the things worth
// remembering ACROSS sessions and restarts, so the Stats panel can show real
// history:
//   * per-profile runtime, session count and probe success rate
//   * failover rotations (from → to, when)
//   * recent session history (profile, start/end, duration)
//   * a down-sampled health timeline (1-minute buckets) for the sparkline
//
// Persisted to <userData>/engine-stats.json. Writes are throttled (a 5s debounce
// plus hard flushes on session boundaries / quit) so the per-probe cadence never
// hammers the disk.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const FILE = () => path.join(app.getPath('userData'), 'engine-stats.json');

const TIMELINE_MAX = 240;   // 1-min buckets → ~4h of sparkline history
const FAILOVER_MAX = 50;
const SESSION_MAX  = 50;
const BUCKET_MS    = 60 * 1000;

let data = null;                 // lazy-loaded store
let dirty = false;
let saveTimer = null;

// Live session tracking (not persisted until the session ends).
let sessionStart = null;         // ms epoch
let sessionProfile = null;

function blank() {
    return {
        profiles: {},   // id -> { sessions, runtimeMs, ok, fail, lastUsed }
        failovers: [],  // { ts, from, to }
        sessions: [],   // { profile, start, end, durationMs }
        timeline: [],   // { ts, ok, total }
        totals: { runtimeMs: 0, sessions: 0, ok: 0, fail: 0 },
        _bucket: null   // in-progress timeline bucket
    };
}

function load() {
    if (data) return data;
    try {
        const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
        // Defensive: merge onto a blank so a truncated/old file can't crash us.
        data = Object.assign(blank(), parsed);
        data.profiles  = data.profiles  || {};
        data.failovers = Array.isArray(data.failovers) ? data.failovers : [];
        data.sessions  = Array.isArray(data.sessions)  ? data.sessions  : [];
        data.timeline  = Array.isArray(data.timeline)  ? data.timeline  : [];
        data.totals    = Object.assign({ runtimeMs: 0, sessions: 0, ok: 0, fail: 0 }, data.totals || {});
    } catch (e) {
        data = blank();
    }
    return data;
}

function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 5000);
}

function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!dirty || !data) return;
    try { fs.writeFileSync(FILE(), JSON.stringify(data)); dirty = false; } catch (e) { /* disk full / locked — try again next tick */ }
}

function profileEntry(id) {
    const d = load();
    return (d.profiles[id] = d.profiles[id] || { sessions: 0, runtimeMs: 0, ok: 0, fail: 0, lastUsed: 0 });
}

function closeBucket() {
    const d = load();
    if (d._bucket && d._bucket.total > 0) {
        d.timeline.push(d._bucket);
        while (d.timeline.length > TIMELINE_MAX) d.timeline.shift();
    }
    d._bucket = null;
}

// --- ENGINE HOOKS (called from engine.js) ---
function onSessionStart(profile) {
    const d = load();
    sessionStart = Date.now();
    sessionProfile = profile || 'unknown';
    const p = profileEntry(sessionProfile);
    p.sessions += 1;
    p.lastUsed = sessionStart;
    d.totals.sessions += 1;
    scheduleSave();
}

function onSessionEnd() {
    if (!sessionStart) return;   // idempotent — safe to call twice on a race
    const d = load();
    const end = Date.now();
    const dur = Math.max(0, end - sessionStart);
    const profile = sessionProfile || 'unknown';

    profileEntry(profile).runtimeMs += dur;
    d.totals.runtimeMs += dur;
    d.sessions.push({ profile, start: sessionStart, end, durationMs: dur });
    while (d.sessions.length > SESSION_MAX) d.sessions.shift();

    sessionStart = null;
    sessionProfile = null;
    closeBucket();
    scheduleSave();
}

function onProbe(ok) {
    const d = load();
    if (sessionProfile) {
        const p = profileEntry(sessionProfile);
        if (ok) p.ok += 1; else p.fail += 1;
    }
    if (ok) d.totals.ok += 1; else d.totals.fail += 1;

    // Bucket probes into 1-minute cells for the sparkline.
    const key = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    if (!d._bucket || d._bucket.ts !== key) {
        closeBucket();
        d._bucket = { ts: key, ok: 0, total: 0 };
    }
    d._bucket.ok += ok ? 1 : 0;
    d._bucket.total += 1;
    scheduleSave();
}

function onFailover(from, to) {
    const d = load();
    d.failovers.push({ ts: Date.now(), from: from || null, to: to || null });
    while (d.failovers.length > FAILOVER_MAX) d.failovers.shift();
    scheduleSave();
}

// --- REPORT (for the renderer) ---
function report() {
    const d = load();
    const profiles = Object.entries(d.profiles).map(([id, p]) => {
        const probes = p.ok + p.fail;
        return {
            id,
            sessions: p.sessions,
            runtimeMs: p.runtimeMs,
            ok: p.ok,
            fail: p.fail,
            probes,
            successRate: probes ? Math.round((p.ok / probes) * 100) : null,
            lastUsed: p.lastUsed
        };
    }).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

    // Include the live in-progress bucket so the sparkline updates in real time.
    const timeline = d.timeline.slice();
    if (d._bucket && d._bucket.total > 0) timeline.push(d._bucket);

    const totalProbes = d.totals.ok + d.totals.fail;
    return {
        totals: {
            runtimeMs: d.totals.runtimeMs,
            sessions: d.totals.sessions,
            ok: d.totals.ok,
            fail: d.totals.fail,
            successRate: totalProbes ? Math.round((d.totals.ok / totalProbes) * 100) : null,
            failoverCount: d.failovers.length
        },
        profiles,
        failovers: d.failovers.slice().reverse(),   // newest first
        sessions: d.sessions.slice().reverse(),
        timeline,
        currentSession: sessionStart ? { profile: sessionProfile, start: sessionStart } : null
    };
}

function reset() {
    data = blank();
    dirty = true;
    flush();
    return report();
}

ipcMain.handle('get-engine-stats', () => report());
ipcMain.handle('reset-engine-stats', () => reset());

module.exports = { onSessionStart, onSessionEnd, onProbe, onFailover, flush, report, reset };
