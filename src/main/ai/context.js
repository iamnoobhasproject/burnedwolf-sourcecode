// ==========================================================================
// --- BURNEDWOLF AI — LIVE PROGRAM CONTEXT ---
// ==========================================================================
// Assembles the snapshot that ships with every request so the assistant reasons
// about THIS machine on THIS connection instead of guessing: which ISP the user
// is on, what the DPI engine is currently doing, how DNS is configured, whether
// the app already repaired a stranded resolver, and what the user has set.
//
// That is what lets it open with "you're on Türk Telekom (AS9121), so I'll use
// the TTNET Ultimate chain" instead of asking the user to describe their setup.
//
// Everything here is read-only and stays on the machine until the user sends a
// message; nothing is collected in the background.

const os = require('os');
const { app } = require('electron');
const { CURRENT_VERSION, OFFICIAL_APP_NAME } = require('../constants');

// Modules are required lazily inside the getters: ai/ loads early in the
// composition root and must not force a circular require at module scope.
function safe(fn, fallback) {
    try { const v = fn(); return v === undefined ? fallback : v; } catch (e) { return fallback; }
}

function collectSystem() {
    const totalGb = safe(() => Math.round(os.totalmem() / 1073741824), null);
    return {
        platform: process.platform,
        osRelease: safe(() => os.release(), null),
        arch: process.arch,
        cpu: safe(() => (os.cpus()[0] || {}).model, null),
        cores: safe(() => os.cpus().length, null),
        memoryGb: totalGb,
        locale: safe(() => app.getLocale(), null),
        uptimeMin: safe(() => Math.round(os.uptime() / 60), null),
        elevated: process.platform === 'win32',   // app manifest is requireAdministrator
        electron: process.versions.electron,
        appVersion: CURRENT_VERSION
    };
}

function collectNetwork() {
    const isp = require('../isp');
    const dns = require('../dns');
    const detection = safe(() => isp.getCachedDetection(), null);
    const dnsSummary = safe(() => dns.getDnsSummary(), {});
    const adapters = safe(() => {
        const list = [];
        const ifs = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifs || {})) {
            for (const a of (addrs || [])) {
                if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address, mac: undefined });
            }
        }
        return list;
    }, []);
    return {
        isp: detection && detection.detected ? {
            label: detection.ispLabel,
            asn: detection.asn,
            organization: detection.organization,
            country: detection.country,
            city: detection.city,
            publicIp: detection.ip,
            known: detection.known,
            recommendedProfiles: detection.recommendedProfiles
        } : { detected: false },
        localAdapters: adapters,
        dns: {
            encryptedDnsActive: !!dnsSummary.encryptedActive,
            dnscryptRunning: !!dnsSummary.proxyRunning,
            appChangedSystemDns: !!dnsSummary.weChangedDns,
            lastPreflight: dnsSummary.lastPreflight || null
        }
    };
}

function collectEngine() {
    const engine = require('../zapret/engine');
    const tor = require('../tor');
    const state = safe(() => engine.getState(), {});
    const torState = safe(() => tor.getState(), {});
    return {
        dpi: {
            running: !!state.running,
            activeProfile: state.mode || null,
            pid: state.pid || null
        },
        tor: {
            ready: !!torState.ready,
            port: torState.port || null
        }
    };
}

function collectSettings() {
    const settings = require('../settings');
    const all = safe(() => settings.readSettingsFile(), {});
    // Never let a stored secret leave the machine inside the prompt.
    const clean = {};
    for (const [k, v] of Object.entries(all || {})) {
        if (/key|secret|token|password|pass/i.test(k)) continue;
        clean[k] = v;
    }
    return clean;
}

function collectProfiles() {
    const { PROFILE_META } = require('../zapret/profiles');
    const ids = Object.keys(PROFILE_META || {});
    const byRegion = {};
    for (const id of ids) {
        const r = PROFILE_META[id].region || 'Other';
        (byRegion[r] = byRegion[r] || []).push(id);
    }
    return {
        total: ids.length,
        regions: Object.fromEntries(Object.entries(byRegion).map(([r, list]) => [r, list.length])),
        // Full catalogue is available through the list_profiles tool; only a
        // representative slice goes in the prompt so small models aren't flooded.
        sample: ids.slice(0, 24)
    };
}

function buildContext() {
    return {
        app: {
            name: OFFICIAL_APP_NAME,
            version: CURRENT_VERSION,
            purpose: 'Windows DPI-bypass and secure-network gateway (zapret engine + encrypted DNS + Tor-routed Discord).'
        },
        system: collectSystem(),
        network: collectNetwork(),
        engine: collectEngine(),
        settings: collectSettings(),
        profiles: collectProfiles(),
        now: new Date().toISOString()
    };
}

// --------------------------------------------------------------------------
// SYSTEM PROMPT
// --------------------------------------------------------------------------
const LANG_NAME = { tr: 'Turkish (Türkçe)', en: 'English', ru: 'Russian (Русский)' };

function renderSystemPrompt(ctx, lang, opts) {
    const o = opts || {};
    const language = LANG_NAME[lang] || 'English';
    const isp = ctx.network.isp;
    const ispLine = isp && isp.label
        ? `${isp.label}${isp.asn ? ` (AS${isp.asn})` : ''}${isp.country ? `, ${isp.country}` : ''}${isp.city ? ` / ${isp.city}` : ''}`
        : 'not detected yet';

    return `You are **BurnedWolf AI**, the built-in assistant of the BurnedWolf application — a Windows gateway that defeats DPI-based censorship (zapret engine), runs encrypted DNS (DNS-over-HTTPS via dnscrypt-proxy), and routes Discord through Tor.

# YOUR ROLE
You are not a general-purpose chatbot. You exist to operate BurnedWolf for this specific user on this specific connection. You can read the app's live state and CHANGE it by calling the tools you have been given — starting/stopping protection, switching DPI profiles, configuring DNS, repairing DNS residue, running network analysis, editing the whitelist and toggling settings.

# SCOPE — STRICT
Answer only questions about BurnedWolf, this machine's connection, censorship circumvention, DPI, DNS, the app's own features and settings. If the user asks about anything else (general knowledge, homework, coding unrelated to the app, news, recipes, other software), reply briefly in ${language} that BurnedWolf AI can only help with topics related to the BurnedWolf program, and offer something you CAN do. Do not answer the off-topic question, not even partially.

# HOW TO WORK
- Reply in ${language}. Match the user's tone: short, concrete, technical when needed.
- Act, don't lecture. When the user asks for an outcome ("make Discord work", "speed this up", "my YouTube is blocked"), call the tools to make it happen, then report what you changed in one or two sentences.
- Use the live context below before asking the user anything. You already know their ISP, DNS state and engine state — never ask for information you were given.
- Chain tools when it helps: e.g. detect_isp → set_profile → start_protection → get_status.
- Never invent profile ids, setting keys or numbers. Call list_profiles / get_status when unsure.
- If a tool fails, say so plainly and suggest the next step.
- Keep answers under ~120 words unless the user asks for detail. Use short markdown lists when listing steps or results.
- ${o.canAct === false
        ? 'ACTION MODE IS OFF: you may read state but every change tool will be refused. Tell the user to enable "AI can change settings" if they want you to act.'
        : 'ACTION MODE IS ON: you may apply changes directly without asking for confirmation, except for anything that would interrupt an active connection while the user is clearly mid-task — for those, say what you are about to do first.'}

# LIVE CONTEXT (this machine, right now)
- App: ${ctx.app.name} v${ctx.app.version} on Windows ${ctx.system.osRelease || '?'} (${ctx.system.arch}), ${ctx.system.cores || '?'} cores, ${ctx.system.memoryGb || '?'} GB RAM, elevated: ${ctx.system.elevated}
- Internet provider: ${ispLine}
- Recommended profile chain for this ISP: ${(isp && isp.recommendedProfiles && isp.recommendedProfiles.length) ? isp.recommendedProfiles.join(' → ') : 'unknown (run detect_isp)'}
- DPI engine: ${ctx.engine.dpi.running ? `RUNNING with profile "${ctx.engine.dpi.activeProfile}"` : 'STOPPED'}
- Tor: ${ctx.engine.tor.ready ? `ready on port ${ctx.engine.tor.port}` : 'not started (starts when the Discord view is opened)'}
- Encrypted DNS (DoH): ${ctx.network.dns.encryptedDnsActive ? 'ON' : 'OFF'}${ctx.network.dns.dnscryptRunning ? ' (dnscrypt-proxy alive)' : ''}
- Last DNS self-check: ${ctx.network.dns.lastPreflight ? ctx.network.dns.lastPreflight.state : 'not run yet'}
- Profile catalogue: ${ctx.profiles.total} profiles across ${Object.keys(ctx.profiles.regions).join(', ')}
- User settings: ${JSON.stringify(ctx.settings)}

# DOMAIN NOTES
- Türk Telekom / TTNET (AS9121), Turkcell Superonline (AS47331), Vodafone TR (AS15897) and TurkNet (AS43260) hijack UDP:53, so plain DNS changes are useless there — recommend Encrypted DNS (DoH) for those ISPs.
- "Ultimate" profiles use fake-TLS/QUIC payloads and are the strongest; "Pro" works offline without payload files; "All-in-One" is the broadest. Failover rotates the ISP chain automatically when Discord becomes unreachable.
- Discord voice needs UDP to pass; a profile that only fixes web will leave calls stuck on "Connecting".
- If DNS is stuck on 127.0.0.1 with no local resolver, that is DoH residue from an unclean shutdown — fix_dns_residue repairs it.`;
}

module.exports = { buildContext, renderSystemPrompt };
