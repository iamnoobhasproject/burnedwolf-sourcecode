// ==========================================================================
// --- BURNEDWOLF AI — ORCHESTRATOR ---
// ==========================================================================
// Owns the assistant end to end:
//   * API keys, encrypted at rest with the OS keychain (DPAPI on Windows)
//   * provider/model selection + live model discovery
//   * the chat turn: context snapshot → provider call → tool loop → answer
//   * usage accounting, so the in-app limit gauge shows real numbers
//
// Keys never touch settings.json, never appear in a prompt, and are never
// broadcast to renderers — the UI only ever sees a masked hint like "sk-…4f2a".

const { app, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const catalog = require('./catalog');
const providers = require('./providers');
const actions = require('./actions');
const { buildContext, renderSystemPrompt } = require('./context');
require('./eventlog');   // starts the broadcast tap

const settings = require('../settings');
const { broadcastToAll } = require('../util/broadcast');

const MAX_TOOL_ROUNDS = 6;      // enough for detect → configure → start → verify
const MAX_HISTORY = 24;         // messages kept from the renderer's transcript

// ==========================================================================
// KEY STORE
// ==========================================================================
const keyStorePath = () => path.join(app.getPath('userData'), 'ai_keys.bin');

function readKeys() {
    try {
        if (!fs.existsSync(keyStorePath())) return {};
        const raw = fs.readFileSync(keyStorePath());
        if (!safeStorage.isEncryptionAvailable()) return {};
        return JSON.parse(safeStorage.decryptString(raw)) || {};
    } catch (e) { return {}; }
}

function writeKeys(store) {
    try {
        if (!safeStorage.isEncryptionAvailable()) return false;
        fs.writeFileSync(keyStorePath(), safeStorage.encryptString(JSON.stringify(store)));
        return true;
    } catch (e) { return false; }
}

function maskKey(k) {
    if (!k) return '';
    const s = String(k);
    if (s.length <= 10) return s.slice(0, 2) + '…';
    return `${s.slice(0, 5)}…${s.slice(-4)}`;
}

// ==========================================================================
// CONFIG
// ==========================================================================
function getConfig() {
    const s = settings.readSettingsFile();
    return {
        enabled:   s.ai_enabled === true,
        provider:  s.ai_provider || null,
        model:     s.ai_model || null,
        canAct:    s.ai_can_act !== false,          // full control by default
        watch:     s.ai_watch === true,             // live traffic commentary
        endpoint:  s.ai_custom_endpoint || '',
        temperature: typeof s.ai_temperature === 'number' ? s.ai_temperature : 0.35
    };
}

function setConfig(patch) {
    const s = settings.readSettingsFile();
    const map = {
        enabled: 'ai_enabled', provider: 'ai_provider', model: 'ai_model',
        canAct: 'ai_can_act', watch: 'ai_watch', endpoint: 'ai_custom_endpoint',
        temperature: 'ai_temperature'
    };
    for (const [k, v] of Object.entries(patch || {})) {
        if (map[k] !== undefined) s[map[k]] = v;
    }
    settings.writeSettingsFile(s);
    const cfg = getConfig();
    broadcastToAll('ai-config-changed', cfg);
    return cfg;
}

// Resolve the wire config for a provider id (keys included — main process only).
function resolve(providerId, modelId) {
    const p = catalog.getProvider(providerId);
    if (!p) return null;
    const cfg = getConfig();
    const keys = readKeys();
    const entry = keys[providerId] || {};
    return {
        providerId,
        protocol: p.protocol,
        endpoint: entry.endpoint || (providerId === 'custom' ? cfg.endpoint : p.endpoint),
        apiKey: entry.key || '',
        model: modelId || cfg.model || (p.models[0] && p.models[0].id) || ''
    };
}

// ==========================================================================
// USAGE ACCOUNTING
// ==========================================================================
// Providers rarely expose a usable "quota left" number, so the app keeps its own
// ledger: requests and tokens per provider per day. Combined with the rate-limit
// headers we do get, that is what the limit gauge renders.
const usagePath = () => path.join(app.getPath('userData'), 'ai-usage.json');

function readUsage() {
    try {
        if (fs.existsSync(usagePath())) return JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    } catch (e) {}
    return { days: {}, total: { requests: 0, in: 0, out: 0 }, providers: {} };
}

function writeUsage(u) {
    try { fs.writeFileSync(usagePath(), JSON.stringify(u), 'utf8'); } catch (e) {}
}

function today() { return new Date().toISOString().slice(0, 10); }

function recordUsage(providerId, model, usage, rateLimit) {
    const u = readUsage();
    const d = today();
    u.days[d] = u.days[d] || { requests: 0, in: 0, out: 0 };
    u.days[d].requests += 1;
    u.days[d].in  += (usage && usage.in)  || 0;
    u.days[d].out += (usage && usage.out) || 0;
    u.total.requests += 1;
    u.total.in  += (usage && usage.in)  || 0;
    u.total.out += (usage && usage.out) || 0;
    const p = u.providers[providerId] = u.providers[providerId] || { requests: 0, in: 0, out: 0 };
    p.requests += 1;
    p.in  += (usage && usage.in)  || 0;
    p.out += (usage && usage.out) || 0;
    p.lastModel = model;
    p.lastUsed = Date.now();
    if (rateLimit) p.rateLimit = rateLimit;
    // Keep a fortnight of daily history; that's all the gauge charts.
    const keep = Object.keys(u.days).sort().slice(-14);
    u.days = Object.fromEntries(keep.map(k => [k, u.days[k]]));
    writeUsage(u);
    broadcastToAll('ai-usage-changed', usageReport(u));
    return u;
}

// Approximate cost from the catalog's reference prices — flagged as an estimate
// in the UI, never presented as a bill.
function estimateCost(providerId, model, u) {
    const p = catalog.getProvider(providerId);
    if (!p) return null;
    const m = p.models.find(x => x.id === model);
    if (!m || !m.price) return null;
    return ((u.in / 1e6) * m.price.in) + ((u.out / 1e6) * m.price.out);
}

function usageReport(pre) {
    const u = pre || readUsage();
    const cfg = getConfig();
    const d = today();
    const day = u.days[d] || { requests: 0, in: 0, out: 0 };
    const prov = (cfg.provider && u.providers[cfg.provider]) || null;
    return {
        today: day,
        total: u.total,
        days: u.days,
        provider: cfg.provider,
        model: cfg.model,
        providerStats: prov,
        rateLimit: prov && prov.rateLimit ? prov.rateLimit : null,
        estimatedCostToday: cfg.provider && cfg.model ? estimateCost(cfg.provider, cfg.model, day) : null,
        estimatedCostTotal: cfg.provider && cfg.model ? estimateCost(cfg.provider, cfg.model, u.total) : null
    };
}

// ==========================================================================
// THE CHAT TURN
// ==========================================================================
function sanitiseHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .slice(-MAX_HISTORY)
        .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
}

async function chat(payload, sender) {
    const cfg = getConfig();
    if (!cfg.enabled) return { ok: false, error: 'ai_disabled' };
    if (!cfg.provider || !cfg.model) return { ok: false, error: 'ai_not_configured' };

    const p = catalog.getProvider(cfg.provider);
    if (!p) return { ok: false, error: 'ai_unknown_provider' };

    const wire = resolve(cfg.provider, cfg.model);
    if (!wire.apiKey && !p.noKey && !p.custom) return { ok: false, error: 'ai_no_key' };
    if (!wire.endpoint) return { ok: false, error: 'ai_no_endpoint' };

    const lang = settings.readSettingsFile().language || 'en';
    const ctx = buildContext();
    const system = renderSystemPrompt(ctx, lang, { canAct: cfg.canAct });

    const messages = [{ role: 'system', content: system }]
        .concat(sanitiseHistory(payload.history))
        .concat([{ role: 'user', content: String(payload.message || '').slice(0, 8000) }]);

    const tools = actions.toolSchemas();
    const performed = [];
    let totalUsage = { in: 0, out: 0 };
    let lastRate = null;

    const progress = (stage, info) => {
        try {
            if (sender && !sender.isDestroyed()) sender.send('ai-progress', Object.assign({ stage }, info || {}));
        } catch (e) {}
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        progress(round === 0 ? 'thinking' : 'continuing', { round });
        const reply = await providers.chat(wire, {
            messages,
            tools,
            temperature: cfg.temperature,
            maxTokens: 1600
        });

        if (!reply.ok) {
            return {
                ok: false,
                error: 'provider_error',
                status: reply.status,
                detail: reply.error,
                performed
            };
        }

        totalUsage.in  += (reply.usage && reply.usage.in)  || 0;
        totalUsage.out += (reply.usage && reply.usage.out) || 0;
        if (reply.rateLimit) lastRate = reply.rateLimit;

        if (!reply.toolCalls || reply.toolCalls.length === 0) {
            recordUsage(cfg.provider, cfg.model, totalUsage, lastRate);
            return {
                ok: true,
                text: reply.text || '',
                performed,
                usage: totalUsage,
                provider: cfg.provider,
                model: cfg.model
            };
        }

        // The model wants to operate the app.
        messages.push({ role: 'assistant', content: reply.text || '', toolCalls: reply.toolCalls });
        for (const call of reply.toolCalls) {
            progress('tool', { tool: call.name, args: call.args });
            const result = await actions.runTool(call.name, call.args, { canAct: cfg.canAct });
            performed.push({
                tool: call.name,
                args: call.args,
                mutating: actions.isMutating(call.name),
                ok: !(result && result.error),
                error: result && result.error ? String(result.error) : null
            });
            messages.push({
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                content: JSON.stringify(result).slice(0, 12000)
            });
        }
    }

    // Ran out of rounds — report what was done rather than looping forever.
    recordUsage(cfg.provider, cfg.model, totalUsage, lastRate);
    return {
        ok: true,
        text: '',
        truncated: true,
        performed,
        usage: totalUsage,
        provider: cfg.provider,
        model: cfg.model
    };
}

// ==========================================================================
// IPC
// ==========================================================================
ipcMain.handle('ai-catalog', () => {
    const keys = readKeys();
    return catalog.publicCatalog().map(p => ({
        ...p,
        hasKey: !!(keys[p.id] && keys[p.id].key),
        keyHint: keys[p.id] && keys[p.id].key ? maskKey(keys[p.id].key) : null
    }));
});

ipcMain.handle('ai-config-get', () => getConfig());
ipcMain.handle('ai-config-set', (event, patch) => setConfig(patch));

ipcMain.handle('ai-key-save', (event, providerId, key, endpoint) => {
    const p = catalog.getProvider(providerId);
    if (!p) return { ok: false, error: 'unknown_provider' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encryption_unavailable' };
    const store = readKeys();
    store[providerId] = {
        key: String(key || '').trim(),
        endpoint: endpoint ? String(endpoint).trim() : (store[providerId] && store[providerId].endpoint) || ''
    };
    const ok = writeKeys(store);
    return { ok, hint: maskKey(store[providerId].key) };
});

ipcMain.handle('ai-key-delete', (event, providerId) => {
    const store = readKeys();
    delete store[providerId];
    return { ok: writeKeys(store) };
});

// Validate a key by asking the provider for its model list — cheap, no tokens.
ipcMain.handle('ai-test-key', async (event, providerId, key, endpoint) => {
    const p = catalog.getProvider(providerId);
    if (!p) return { ok: false, error: 'unknown_provider' };
    const stored = readKeys()[providerId] || {};
    const wire = {
        providerId,
        protocol: p.protocol,
        endpoint: (endpoint || stored.endpoint || p.endpoint || '').replace(/\/+$/, ''),
        apiKey: key || stored.key || '',
        model: ''
    };
    if (!wire.endpoint) return { ok: false, error: 'no_endpoint' };
    const r = await providers.listModels(wire);
    return r.ok ? { ok: true, count: r.models.length } : { ok: false, error: r.error };
});

// Live model list, merged with the curated metadata (falls back offline).
ipcMain.handle('ai-list-models', async (event, providerId, key, endpoint) => {
    const p = catalog.getProvider(providerId);
    if (!p) return { ok: false, error: 'unknown_provider', models: [] };
    const stored = readKeys()[providerId] || {};
    const wire = {
        providerId,
        protocol: p.protocol,
        endpoint: (endpoint || stored.endpoint || p.endpoint || '').replace(/\/+$/, ''),
        apiKey: key || stored.key || '',
        model: ''
    };
    // Offline / no key: fall back to the curated list, still correctly tiered.
    const bundled = () => catalog.publicCatalog().find(x => x.id === providerId).models;
    if (!wire.endpoint || (!wire.apiKey && !p.noKey)) {
        return { ok: true, live: false, models: bundled() };
    }
    const r = await providers.listModels(wire);
    if (!r.ok) return { ok: true, live: false, error: r.error, models: bundled() };
    return { ok: true, live: true, models: catalog.mergeModels(providerId, r.models) };
});

ipcMain.handle('ai-chat', async (event, payload) => {
    try {
        return await chat(payload || {}, event.sender);
    } catch (e) {
        return { ok: false, error: 'internal', detail: String((e && e.message) || e) };
    }
});

ipcMain.handle('ai-usage', () => usageReport());
ipcMain.handle('ai-usage-reset', () => {
    writeUsage({ days: {}, total: { requests: 0, in: 0, out: 0 }, providers: {} });
    const r = usageReport();
    broadcastToAll('ai-usage-changed', r);
    return r;
});

// Snapshot of everything the AI knows about the machine — powers the
// "what BurnedWolf AI can see" panel, so the user can audit it.
ipcMain.handle('ai-context-preview', () => {
    const ctx = buildContext();
    return {
        context: ctx,
        tools: actions.TOOLS.map(t => ({ name: t.name, description: t.description, mutating: !!t.mutating }))
    };
});

// The key pages link out to each provider's console; open in the real browser.
ipcMain.handle('ai-open-external', async (event, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false };
    try { await shell.openExternal(u); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});

module.exports = { getConfig, setConfig, usageReport };
