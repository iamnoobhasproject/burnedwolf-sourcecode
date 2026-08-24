// ==========================================================================
// --- BURNEDWOLF AI — ACTION REGISTRY ---
// ==========================================================================
// The hands of the assistant. Each entry is a tool the model may call; the
// schema is plain JSON Schema and ai/providers.js translates it per vendor.
//
// Rules baked in here:
//   * `mutating: true` tools are refused when the user has turned "AI can change
//     settings" off — the model is told why, so it can relay it.
//   * Nothing irreversible is exposed. No uninstall, no update-apply, no quit,
//     no arbitrary command execution, no file writes outside the app's own data.
//   * Long-running, visual jobs (network analysis, integrity check) are handed
//     to the window that already renders their progress instead of running
//     head-less, so the user always sees what the AI set in motion.

const fs = require('fs');
const path = require('path');
const { broadcastToAll } = require('../util/broadcast');

// ------------------------------------------------------------------ helpers
function uiCommand(action, payload) {
    broadcastToAll('ai-ui-command', Object.assign({ action }, payload || {}));
}

function whitelistPath() {
    const { getZapretDataPath } = require('../zapret/hostlists');
    return path.join(getZapretDataPath(), 'whitelist.txt');
}

function readWhitelist() {
    try {
        const p = whitelistPath();
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch (e) { return ''; }
}

// Settings the assistant is allowed to write. Anything else is refused, so a
// prompt-injected instruction can't reach into unrelated state.
const WRITABLE_SETTINGS = {
    dpi_failover:            'boolean',
    dpi_use_tr_master_list:  'boolean',
    auto_update:             'boolean',
    show_update_notes:       'boolean',
    autostart:               'boolean',
    last_profile:            'string',
    language:                'string',
    ai_can_act:              'boolean'
};

// -------------------------------------------------------------------- tools
const TOOLS = [
    {
        name: 'get_status',
        description: 'Full live snapshot of BurnedWolf: DPI engine state and active profile, Tor state, DNS/DoH state, detected ISP, and current settings. Call this first when the user asks how things are or reports a problem.',
        parameters: { type: 'object', properties: {} },
        async run() {
            const { buildContext } = require('./context');
            const ctx = buildContext();
            return {
                engine: ctx.engine,
                network: ctx.network,
                settings: ctx.settings,
                system: { osRelease: ctx.system.osRelease, arch: ctx.system.arch, locale: ctx.system.locale, appVersion: ctx.system.appVersion },
                profiles: { total: ctx.profiles.total, regions: ctx.profiles.regions }
            };
        }
    },
    {
        name: 'detect_isp',
        description: "Detect the user's internet provider by ASN and return the recommended DPI profile chain for it. Use force=true only if the user changed network or says the detection is wrong.",
        parameters: {
            type: 'object',
            properties: { force: { type: 'boolean', description: 'Bypass the cached detection and query again.' } }
        },
        async run(args) {
            // Same function the UI calls, so detection can never diverge.
            return await require('../isp').detectISP({ force: !!args.force });
        }
    },
    {
        name: 'list_profiles',
        description: 'List the DPI bypass profiles this build ships with. Filter by region ("Turkey", "Russia", "Generic", "Europe", "Middle East", "Asia") or ask only for the ones recommended for the detected ISP.',
        parameters: {
            type: 'object',
            properties: {
                region: { type: 'string', description: 'Optional region filter.' },
                recommended_only: { type: 'boolean', description: 'Only the profiles recommended for the detected ISP.' }
            }
        },
        async run(args) {
            const { PROFILE_META, inferProfileMeta } = require('../zapret/profiles');
            const isp = require('../isp');
            const rec = (isp.getCachedDetection() || {}).recommendedProfiles || [];
            let ids = Object.keys(PROFILE_META);
            if (args.recommended_only) ids = ids.filter(id => rec.includes(id));
            if (args.region) ids = ids.filter(id => String(PROFILE_META[id].region || '').toLowerCase() === String(args.region).toLowerCase());
            return {
                count: ids.length,
                recommendedForIsp: rec,
                profiles: ids.slice(0, 80).map(id => {
                    const meta = (() => { try { return inferProfileMeta(id); } catch (e) { return {}; } })();
                    return {
                        id,
                        label: PROFILE_META[id].label,
                        region: PROFILE_META[id].region,
                        voiceReady: meta.voiceReady,
                        usesFakePayload: meta.usesFakePayload,
                        difficulty: meta.difficulty
                    };
                })
            };
        }
    },
    {
        name: 'set_profile',
        description: 'Select the DPI profile that will be used the next time protection starts (and persist it). Does not start the engine — call start_protection for that.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: { profile_id: { type: 'string', description: 'Profile id from list_profiles, or "custom" for the analysis result.' } },
            required: ['profile_id']
        },
        async run(args) {
            const { PROFILE_META } = require('../zapret/profiles');
            const id = String(args.profile_id || '');
            if (id !== 'custom' && !PROFILE_META[id]) return { ok: false, error: `Unknown profile "${id}". Call list_profiles first.` };
            const settings = require('../settings');
            const all = settings.readSettingsFile();
            all.last_profile = id;
            settings.writeSettingsFile(all);
            uiCommand('select-profile', { profileId: id });
            return { ok: true, profile: id, label: id === 'custom' ? 'Custom (analysis)' : PROFILE_META[id].label };
        }
    },
    {
        name: 'start_protection',
        description: 'Start the DPI bypass engine. Uses the given profile, or the saved/recommended one when omitted. Also loads the saved whitelist and honours the failover setting.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: {
                profile_id: { type: 'string', description: 'Optional profile id; defaults to the saved selection.' },
                failover: { type: 'boolean', description: 'Rotate the ISP profile chain automatically if the connection stays broken.' }
            }
        },
        async run(args) {
            const engine = require('../zapret/engine');
            const settings = require('../settings');
            const isp = require('../isp');
            const all = settings.readSettingsFile();
            const rec = (isp.getCachedDetection() || {}).recommendedProfiles || [];
            const mode = String(args.profile_id || all.last_profile || rec[0] || 'bw_standard');
            const failover = args.failover != null ? !!args.failover : all.dpi_failover === true;
            engine.startZapret({
                mode,
                customArgs: null,
                whitelistData: readWhitelist(),
                failover
            });
            uiCommand('select-profile', { profileId: mode });
            return { ok: true, starting: true, profile: mode, failover, note: 'The engine reports "running" or "error" to the UI within a few seconds; call get_status to confirm.' };
        }
    },
    {
        name: 'stop_protection',
        description: 'Stop the DPI bypass engine.',
        mutating: true,
        parameters: { type: 'object', properties: {} },
        async run() {
            require('../zapret/engine').stopZapret();
            return { ok: true, stopped: true };
        }
    },
    {
        name: 'get_engine_health',
        description: 'Connectivity health of the running engine: success percentage over the recent probe window.',
        parameters: { type: 'object', properties: {} },
        async run() {
            return require('../zapret/engine').getHealth();
        }
    },
    {
        name: 'get_dns_status',
        description: 'Current DNS configuration of the active adapter: servers, friendly provider name, whether it is the ISP default and whether encrypted DNS is on.',
        parameters: { type: 'object', properties: {} },
        async run() {
            const dns = require('../dns');
            const cur = await dns.getCurrentDnsServers();
            const prov = dns.describeDnsProvider(cur.ipv4);
            const summary = dns.getDnsSummary();
            return {
                adapter: cur.adapter, ipv4: cur.ipv4, ipv6: cur.ipv6,
                provider: prov.name, isIspDefault: prov.isISP,
                encryptedDnsActive: summary.encryptedActive,
                lastPreflight: summary.lastPreflight
            };
        }
    },
    {
        name: 'set_dns_provider',
        description: 'Point the active adapter at a public DNS provider, or hand it back to the router (dhcp). Turning this on switches encrypted DNS off.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: { provider: { type: 'string', enum: ['cloudflare', 'google', 'quad9', 'adguard', 'dhcp'] } },
            required: ['provider']
        },
        async run(args) {
            const ok = await require('../dns').applyDnsPreset(String(args.provider));
            uiCommand('refresh-dns');
            return { ok: !!ok, provider: args.provider };
        }
    },
    {
        name: 'set_encrypted_dns',
        description: 'Turn encrypted DNS (DNS-over-HTTPS through the bundled dnscrypt-proxy) on or off. This is the fix for ISPs that hijack UDP port 53, like Türk Telekom.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
            required: ['enabled']
        },
        async run(args) {
            const dns = require('../dns');
            let r;
            if (args.enabled) {
                r = await dns.startEncryptedDns();
            } else {
                await dns.stopEncryptedDns();
                r = { ok: true, enabled: false };
            }
            uiCommand('refresh-dns');
            return r;
        }
    },
    {
        name: 'fix_dns_residue',
        description: 'Detect and repair DNS left stranded on 127.0.0.1 by an unclean shutdown while encrypted DNS was on (the "no internet after a crash" case). Safe to call any time: it does nothing when a real local resolver is answering.',
        mutating: true,
        parameters: { type: 'object', properties: {} },
        async run() {
            const dns = require('../dns');
            const r = await dns.repairDnsResidue();
            uiCommand('refresh-dns');
            return r;
        }
    },
    {
        name: 'run_analysis',
        description: 'Start the network analysis (blockcheck): tests profiles against Discord, YouTube, X, Roblox and Twitch and applies the winner as the Custom profile. "quick" takes a couple of minutes, "deep" much longer. Progress is shown in the app.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: { mode: { type: 'string', enum: ['quick', 'deep'] } }
        },
        async run(args) {
            uiCommand('run-analysis', { mode: args.mode === 'deep' ? 'deep' : 'quick' });
            return { ok: true, started: true, mode: args.mode || 'quick', note: 'Running in the Analysis view; results are applied automatically when it finishes.' };
        }
    },
    {
        name: 'cancel_analysis',
        description: 'Cancel a running network analysis.',
        mutating: true,
        parameters: { type: 'object', properties: {} },
        async run() {
            uiCommand('cancel-analysis');
            return { ok: true };
        }
    },
    {
        name: 'get_whitelist',
        description: 'Read the domain whitelist that receives DPI bypass treatment.',
        parameters: { type: 'object', properties: {} },
        async run() {
            const raw = readWhitelist();
            const domains = raw.split('\n').map(s => s.trim()).filter(Boolean);
            return { count: domains.length, domains: domains.slice(0, 200) };
        }
    },
    {
        name: 'set_whitelist',
        description: 'Replace or extend the domain whitelist. Pass mode="add" to append to what is already there.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: {
                domains: { type: 'array', items: { type: 'string' }, description: 'Bare domains, e.g. ["discord.com","youtube.com"].' },
                mode: { type: 'string', enum: ['replace', 'add'] }
            },
            required: ['domains']
        },
        async run(args) {
            const incoming = (args.domains || []).map(d => String(d).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
            let list = incoming;
            if (args.mode === 'add') {
                const existing = readWhitelist().split('\n').map(s => s.trim()).filter(Boolean);
                list = Array.from(new Set(existing.concat(incoming)));
            }
            try {
                fs.writeFileSync(whitelistPath(), list.join('\n'), 'utf8');
            } catch (e) { return { ok: false, error: e.message }; }
            broadcastToAll('whitelist-data', list.join('\n'));
            return { ok: true, count: list.length };
        }
    },
    {
        name: 'get_settings',
        description: 'Read the app settings the assistant is allowed to change.',
        parameters: { type: 'object', properties: {} },
        async run() {
            const settings = require('../settings');
            const all = settings.readSettingsFile();
            const out = {};
            for (const k of Object.keys(WRITABLE_SETTINGS)) out[k] = all[k];
            return { settings: out, writableKeys: Object.keys(WRITABLE_SETTINGS) };
        }
    },
    {
        name: 'set_setting',
        description: 'Change one app setting. Allowed keys: dpi_failover, dpi_use_tr_master_list, auto_update, show_update_notes, autostart, last_profile, language, ai_can_act.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                value: { description: 'Boolean for toggles, string for language ("en"|"tr"|"ru") and last_profile.' }
            },
            required: ['key', 'value']
        },
        async run(args) {
            const key = String(args.key || '');
            const expect = WRITABLE_SETTINGS[key];
            if (!expect) return { ok: false, error: `"${key}" is not a setting BurnedWolf AI may change. Allowed: ${Object.keys(WRITABLE_SETTINGS).join(', ')}` };
            let value = args.value;
            if (expect === 'boolean') value = (value === true || value === 'true' || value === 1 || value === '1');
            if (expect === 'string') value = String(value);
            if (key === 'language' && !['en', 'tr', 'ru'].includes(value)) return { ok: false, error: 'language must be en, tr or ru' };

            const settings = require('../settings');
            const all = settings.readSettingsFile();
            all[key] = value;
            const ok = settings.writeSettingsFile(all);
            if (ok && key === 'language') broadcastToAll('language-changed', value);
            if (ok && key === 'autostart') {
                try { require('../autostart'); broadcastToAll('ai-ui-command', { action: 'apply-autostart', value }); } catch (e) {}
            }
            uiCommand('settings-changed', { key, value });
            return { ok, key, value };
        }
    },
    {
        name: 'verify_files',
        description: 'Start the file-integrity check: compares the local installation against the original server files and repairs anything missing or corrupt.',
        mutating: true,
        parameters: { type: 'object', properties: {} },
        async run() {
            uiCommand('run-verify');
            return { ok: true, started: true, note: 'Running in the File integrity view.' };
        }
    },
    {
        name: 'check_update',
        description: 'Ask the update server whether a newer BurnedWolf build exists. Reports only — installing stays a user decision.',
        parameters: { type: 'object', properties: {} },
        async run() {
            const { fetchJSON } = require('../util/http');
            const { CURRENT_VERSION } = require('../constants');
            const data = await fetchJSON('https://raw.githubusercontent.com/iamnoobhasproject/app-updates/main/version.json?t=' + Date.now());
            if (!data || !data.version) return { ok: false, error: 'Update server unreachable (check DNS/connection).', current: CURRENT_VERSION };
            return { ok: true, current: CURRENT_VERSION, latest: data.version, updateAvailable: data.version !== CURRENT_VERSION };
        }
    },
    {
        name: 'navigate_ui',
        description: 'Open one of the app screens for the user: home, dns, analysis, verify, discord, advanced, settings, ai.',
        mutating: true,
        parameters: {
            type: 'object',
            properties: { view: { type: 'string', enum: ['home', 'dns', 'analysis', 'verify', 'discord', 'advanced', 'settings', 'ai'] } },
            required: ['view']
        },
        async run(args) {
            uiCommand('navigate', { view: String(args.view) });
            return { ok: true, view: args.view };
        }
    },
    {
        name: 'get_recent_events',
        description: 'The most recent engine / DNS / Tor events the app has emitted. Use this when the user says something "just broke" or asks what happened.',
        parameters: {
            type: 'object',
            properties: { limit: { type: 'number', description: 'How many events, default 30, max 100.' } }
        },
        async run(args) {
            const { getEvents } = require('./eventlog');
            const n = Math.max(1, Math.min(100, Number(args.limit) || 30));
            return { events: getEvents(n) };
        }
    }
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

// Schema handed to the model (implementation details stripped).
function toolSchemas() {
    return TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

async function runTool(name, args, opts) {
    const tool = BY_NAME.get(name);
    if (!tool) return { error: `Unknown tool "${name}".` };
    if (tool.mutating && opts && opts.canAct === false) {
        return { error: 'Refused: the user has turned "AI can change settings" off. Ask them to enable it in AI settings, or answer without changing anything.' };
    }
    try {
        const out = await tool.run(args || {});
        return out === undefined ? { ok: true } : out;
    } catch (e) {
        return { error: String((e && e.message) || e) };
    }
}

module.exports = { TOOLS, toolSchemas, runTool, isMutating: (n) => !!(BY_NAME.get(n) || {}).mutating };
