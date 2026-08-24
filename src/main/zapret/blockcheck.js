// ==========================================
// --- BLOCKCHECK (DYNAMIC NETWORK ANALYSIS) ---
// ==========================================
// Probes the catalog (and, in deep mode, a mutation engine) against the
// Türkiye-relevant target list to find the best DPI profile for this network.
// Runs profile-by-profile: spawn winws → probe targets → score → kill → next.
const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const https = require('https');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { WINWS_EXE } = require('./paths');
const { ZAPRET_PROFILES, PROFILE_META, applyGlobalProfileFlags, inferProfileMeta } = require('./profiles');
const isp = require('../isp');

// --- BLOCKCHECK CANCELLATION STATE ---
// Set when the renderer asks to abort an in-flight analysis. The blockcheck
// loop checks this flag between every probe, between every profile, and
// between every mutation step so cancellation is responsive (<2 sec).
let blockcheckCancelRequested = false;

ipcMain.on('cancel-blockcheck', () => {
    blockcheckCancelRequested = true;
});

ipcMain.on('save-analysis-report', async (event, reportText) => {
    const { filePath } = await dialog.showSaveDialog({
        title: 'Save Analysis Report',
        defaultPath: 'BurnedWolf_DPI_Analysis.txt',
        buttonLabel: 'Save',
        filters: [{ name: 'Text Document', extensions: ['txt'] }]
    });
    if (filePath) {
        fs.writeFileSync(filePath, reportText, 'utf8');
        event.reply('blockcheck-log', `[INFO] Report saved successfully: ${filePath}`);
    }
});

ipcMain.on('run-blockcheck', async (event, opts) => {
    // opts: { mode: 'quick' | 'deep' }
    // quick = ISP-recommended profiles + light mutation (~1-2 min)
    // deep  = every profile + full mutation engine (~5-8 min, default)
    const mode = (opts && opts.mode === 'quick') ? 'quick' : 'deep';
    blockcheckCancelRequested = false;

    event.reply('blockcheck-log', `BURNEDWOLF DYNAMIC NETWORK ANALYSIS — ${mode.toUpperCase()} SCAN`);
    event.reply('blockcheck-log', '---------------------------------------------------');

    const zapretExePath = WINWS_EXE;
    let bestProfile = null;
    // Top-3 ranking — keeps a sorted shortlist so the final report can show
    // alternatives, not just the winner.
    let topProfiles = [];

    function trackCandidate(candidate) {
        // Insert candidate into topProfiles sorted by isBetter ordering
        topProfiles.push(candidate);
        topProfiles.sort((a, b) => {
            if (!!a.voice !== !!b.voice) return a.voice ? -1 : 1;
            return b.score - a.score;
        });
        if (topProfiles.length > 3) topProfiles = topProfiles.slice(0, 3);
    }

    function cancelled() {
        if (blockcheckCancelRequested) {
            event.reply('blockcheck-log', '[CANCELLED] Analysis stopped by user.');
            return true;
        }
        return false;
    }

    function emitProgress(phase, current, total, label) {
        event.reply('blockcheck-progress', { phase, current, total, label });
    }

    // Multi-target test list — every site Türkiye blocks or throttles at scale.
    // Discord & Roblox are full blocks; YouTube/Twitch are throttled; X is
    // occasionally throttled. A profile passes the more it covers.
    const TARGETS = [
        { name: 'discord.com',     fallbackIP: '162.159.138.232' },
        { name: 'www.youtube.com', fallbackIP: '142.250.74.110'  },
        { name: 'x.com',           fallbackIP: '104.244.42.193'  },
        { name: 'www.roblox.com',  fallbackIP: '128.116.96.78'   },
        { name: 'www.twitch.tv',   fallbackIP: '151.101.130.167' }
    ];

    const DOH_PROVIDERS = [
        { url: 'https://1.1.1.1/dns-query',          host: 'cloudflare-dns.com' },
        { url: 'https://8.8.8.8/resolve',            host: 'dns.google'         },
        { url: 'https://9.9.9.9:5053/dns-query',     host: 'dns.quad9.net'      },
        { url: 'https://dns.adguard-dns.com/resolve', host: 'dns.adguard-dns.com' }
    ];

    const fetchIP = (provider, hostname) => new Promise((resolve) => {
        const fullUrl = `${provider.url}?name=${encodeURIComponent(hostname)}&type=A`;
        const req = https.get(fullUrl, {
            headers: { 'accept': 'application/dns-json', 'Host': provider.host, 'User-Agent': 'Mozilla/5.0' },
            timeout: 2500
        }, (dnsRes) => {
            let data = '';
            dnsRes.on('data', chunk => data += chunk);
            dnsRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.Answer && json.Answer.length > 0) {
                        // Prefer first A record (type=1)
                        const a = json.Answer.find(x => x.type === 1) || json.Answer[0];
                        resolve(a.data);
                    } else resolve(null);
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null)).on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    });

    const resolveIP = async (hostname, fallback) => {
        for (const provider of DOH_PROVIDERS) {
            const ip = await fetchIP(provider, hostname);
            if (ip) return ip;
        }
        return fallback;
    };

    const probeTarget = (hostname, fallbackIP) => new Promise(async (resolve) => {
        const ip = await resolveIP(hostname, fallbackIP);
        const opts = {
            hostname: ip, port: 443, servername: hostname,
            headers: {
                'Host': hostname,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 4500
        };
        const req = https.get(opts, (res) => {
            resolve({ success: true, reason: `HTTP ${res.statusCode}`, ip });
        }).on('error', (err) => {
            let msg = err.message;
            if (err.code === 'ECONNRESET')   msg = 'Connection Reset (DPI drop)';
            if (err.code === 'ECONNREFUSED') msg = 'Refused by server';
            if (err.code === 'ETIMEDOUT')    msg = 'TCP Timeout';
            resolve({ success: false, reason: msg, ip });
        }).on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ success: false, reason: 'Timeout (heavy DPI)', ip }); });
    });

    // Discord voice path check — sends a STUN Binding Request from a source
    // port inside the Discord voice range (50000-65535) so zapret's UDP filter
    // chain is exercised. If the STUN response comes back, the voice UDP path
    // survives DPI; if it times out, voice will hang on "Starting..." in
    // Discord regardless of how good the TCP/HTTPS score looks.
    const STUN_SERVERS = [
        { host: 'stun.l.google.com',  port: 19302 },
        { host: 'stun1.l.google.com', port: 19302 },
        { host: 'stun.cloudflare.com', port: 3478 }
    ];
    const checkVoiceUDP = () => new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');

        // Build a STUN Binding Request (RFC 5389)
        const stunRequest = Buffer.alloc(20);
        stunRequest.writeUInt16BE(0x0001, 0);     // Message Type: Binding Request
        stunRequest.writeUInt16BE(0x0000, 2);     // Message Length: 0
        stunRequest.writeUInt32BE(0x2112A442, 4); // Magic Cookie
        crypto.randomBytes(12).copy(stunRequest, 8); // 96-bit Transaction ID

        let done = false;
        const finish = (success, reason) => {
            if (done) return;
            done = true;
            try { socket.close(); } catch (e) { /* ignore */ }
            resolve({ success, reason });
        };

        socket.once('message', (msg) => {
            // 0x0101 = Binding Success Response — anything coming back proves UDP path
            const ok = msg && msg.length >= 20;
            finish(true, ok ? 'STUN response' : 'UDP response');
        });
        socket.on('error', (e) => finish(false, e.code || e.message));

        // Source port inside Discord voice range — this is critical so zapret's
        // --filter-udp=50000-65535 chain actually intercepts this packet.
        const srcPort = 50000 + Math.floor(Math.random() * 14999);

        try {
            socket.bind(srcPort, () => {
                // Try the first STUN server; the timeout below catches silent drops.
                const target = STUN_SERVERS[0];
                socket.send(stunRequest, target.port, target.host, (err) => {
                    if (err) finish(false, err.message);
                });
                // Fire backup probes after a short delay in case the first server
                // is unreachable (server outage rather than DPI block).
                setTimeout(() => {
                    if (done) return;
                    for (let i = 1; i < STUN_SERVERS.length; i++) {
                        const s = STUN_SERVERS[i];
                        try { socket.send(stunRequest, s.port, s.host, () => {}); } catch (e) {}
                    }
                }, 800);
            });
        } catch (e) {
            finish(false, e.message);
        }

        setTimeout(() => finish(false, 'UDP timeout (DPI likely drops voice)'), 3500);
    });

    // Score = TCP target count + a boolean for the voice UDP path.
    // Voice support is treated as a separate axis because it's the difference
    // between "Discord login works" and "Discord call actually connects".
    const scoreProfile = async () => {
        const details = [];
        const tcpPromises = TARGETS.map(t => probeTarget(t.name, t.fallbackIP));
        const [tcpResults, voiceResult] = await Promise.all([
            Promise.all(tcpPromises),
            checkVoiceUDP()
        ]);

        let score = 0;
        TARGETS.forEach((t, i) => {
            const r = tcpResults[i];
            if (r.success) { score++; details.push(`${t.name} ✓`); }
            else           { details.push(`${t.name} ✗ (${r.reason})`); }
        });

        const voice = voiceResult.success;
        details.push(voice ? `Discord voice UDP ✓` : `Discord voice UDP ✗ (${voiceResult.reason})`);

        return { score, voice, details };
    };

    // Voice support always beats raw TCP score — a profile that gets Discord
    // login but can't carry voice is useless to a user trying to call friends.
    const isBetter = (a, b) => {
        if (!b) return true;
        if (!!a.voice !== !!b.voice) return !!a.voice;
        return a.score > b.score;
    };

    const killZapret = () => new Promise(r => exec(`taskkill /f /t /im winws.exe`, { windowsHide: true }, () => r()));

    // PHASE 1 — quick baseline (no shield)
    event.reply('blockcheck-log', 'PHASE 0: Baseline (no shield)...');
    const baseline = await scoreProfile();
    baseline.details.forEach(d => event.reply('blockcheck-log', `  · ${d}`));
    event.reply('blockcheck-log', `Baseline: ${baseline.score}/${TARGETS.length} TCP, voice ${baseline.voice ? '✓' : '✗'}`);

    if (baseline.score === TARGETS.length && baseline.voice) {
        event.reply('blockcheck-log', '[INFO] No blocking detected (web + voice both open). DPI shield not required.');
        event.reply('blockcheck-status', 'done');
        return;
    }

    event.reply('blockcheck-log', '---------------------------------------------------');

    // ISS-aware profile ordering — when the user's ISP is known, test the
    // recommended profiles FIRST. They're the most likely winners and let us
    // short-circuit the whole loop. The rest of the catalog still gets tested
    // (in deep mode) so we don't miss niche optimal matches.
    const cachedISPDetection = isp.getCachedDetection();
    let profileIds = Object.keys(ZAPRET_PROFILES);
    if (cachedISPDetection && cachedISPDetection.known && Array.isArray(cachedISPDetection.recommendedProfiles)) {
        const recs = cachedISPDetection.recommendedProfiles.filter(id => ZAPRET_PROFILES[id]);
        const rest = profileIds.filter(id => !recs.includes(id));
        profileIds = mode === 'quick' ? recs : [...recs, ...rest];
        event.reply('blockcheck-log', `PHASE 1: ${recs.length} ISP-recommended profile${recs.length === 1 ? '' : 's'} prioritised (${cachedISPDetection.ispLabel}).`);
    } else if (mode === 'quick') {
        // Quick mode without ISP info → keep TR profiles only (most likely user base)
        profileIds = profileIds.filter(id => id.startsWith('tr_') || id.startsWith('bw_discord') || id.startsWith('bw_classic'));
        event.reply('blockcheck-log', `PHASE 1: ISP unknown — testing ${profileIds.length} Turkey-focused profiles only (Quick mode).`);
    } else {
        event.reply('blockcheck-log', 'PHASE 1: Testing pre-configured BurnedWolf profiles...');
    }

    const profileTotal = profileIds.length;
    let profileIndex = 0;

    for (const profId of profileIds) {
        if (cancelled()) { event.reply('blockcheck-status', 'done'); return; }

        profileIndex++;
        const meta = PROFILE_META[profId] || { label: profId, region: '?' };
        const inferred = inferProfileMeta(profId);
        const metaTag = inferred.vendor ? ` [${inferred.vendor}${inferred.usesFakePayload ? '+fake' : ''}]` : '';

        emitProgress('phase1', profileIndex, profileTotal, `${meta.region} → ${meta.label}`);
        event.reply('blockcheck-log', `[${profileIndex}/${profileTotal}] ${meta.region} → ${meta.label}${metaTag}`);

        const testProc = spawn(zapretExePath, [...applyGlobalProfileFlags(ZAPRET_PROFILES[profId]), '--debug'], { windowsHide: true });
        await new Promise(r => setTimeout(r, 1800));

        if (cancelled()) { await killZapret(); event.reply('blockcheck-status', 'done'); return; }

        const { score, voice, details } = await scoreProfile();
        details.forEach(d => event.reply('blockcheck-log', `    · ${d}`));
        event.reply('blockcheck-log', `  → Score: ${score}/${TARGETS.length} TCP, voice ${voice ? '✓' : '✗'}`);

        await killZapret();
        await new Promise(r => setTimeout(r, 1000));

        const candidate = { id: profId, name: meta.label, args: ZAPRET_PROFILES[profId], score, voice, vendor: inferred.vendor, difficulty: inferred.difficulty };
        trackCandidate(candidate);
        if (isBetter(candidate, bestProfile)) {
            bestProfile = candidate;
            if (score === TARGETS.length && voice) {
                event.reply('blockcheck-log', `[PERFECT] ${meta.label} — full Discord (web + voice).`);
                break;
            }
        }
    }

    // PHASE 2 — mutation engine (deep mode only)
    // Skipped entirely in quick mode to keep the analysis under ~2 minutes.
    // Also skipped if Phase 1 already found a perfect (web + voice) profile.
    const perfectFound = bestProfile && bestProfile.score === TARGETS.length && bestProfile.voice;
    if (!perfectFound && mode !== 'quick' && !cancelled()) {
        event.reply('blockcheck-log', '---------------------------------------------------');
        event.reply('blockcheck-log', 'PHASE 2: Mutation Engine — synthesizing custom strategies...');

        // Voice-capable chain template. We mutate the TCP desync params while
        // keeping the voice UDP chain stable (proven any-protocol/cutoff trick).
        const buildArgs = (d, f, ttl, rep) => [
            '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
            // Voice UDP path (50000-65535) — required for Discord call to connect
            '--filter-udp=50000-65535',
            '--dpi-desync=fake', '--dpi-desync-any-protocol',
            '--dpi-desync-cutoff=d3', `--dpi-desync-repeats=${rep}`,
            '--new',
            // QUIC / HTTPS-over-UDP
            '--filter-udp=443',
            '--dpi-desync=fake', `--dpi-desync-repeats=${rep}`,
            '--new',
            // TCP HTTPS — main mutation surface
            '--filter-tcp=80,443',
            `--dpi-desync=${d}`,
            `--dpi-desync-fooling=${f}`,
            `--dpi-desync-autottl=${ttl}`,
            `--dpi-desync-repeats=${rep}`
        ];

        const desyncStrats   = ['fake,split2', 'fake,disorder2', 'split2', 'syndata', 'fake,multisplit', 'fake,disorder', 'multisplit', 'fakedsplit'];
        const foolingStrats  = ['md5sig', 'badseq', 'badsum', 'md5sig,badseq', 'md5sig,badsum', 'hopbyhop2'];
        const ttlVariants    = [2, 3, 4];
        const repeatVariants = [6, 10];

        const mutationTotal = desyncStrats.length * foolingStrats.length * ttlVariants.length * repeatVariants.length;
        let mutationIndex = 0;

        outer:
        for (const d of desyncStrats) {
            for (const f of foolingStrats) {
                for (const ttl of ttlVariants) {
                    for (const rep of repeatVariants) {
                        if (cancelled()) { await killZapret(); break outer; }

                        mutationIndex++;
                        const args = buildArgs(d, f, ttl, rep);
                        const name = `AUTO ${d}/${f} ttl=${ttl} rep=${rep}`;
                        emitProgress('phase2', mutationIndex, mutationTotal, name);
                        event.reply('blockcheck-log', `[${mutationIndex}/${mutationTotal}] MUTATION ${name}`);

                        const tp = spawn(zapretExePath, [...applyGlobalProfileFlags(args), '--debug'], { windowsHide: true });
                        await new Promise(r => setTimeout(r, 1800));

                        if (cancelled()) { await killZapret(); break outer; }

                        const { score, voice, details } = await scoreProfile();
                        details.forEach(line => event.reply('blockcheck-log', `    · ${line}`));
                        event.reply('blockcheck-log', `  → Score: ${score}/${TARGETS.length} TCP, voice ${voice ? '✓' : '✗'}`);

                        await killZapret();
                        await new Promise(r => setTimeout(r, 900));

                        const candidate = { id: 'custom_generated', name, args, score, voice, vendor: 'Mutation', difficulty: 'high' };
                        trackCandidate(candidate);
                        if (isBetter(candidate, bestProfile)) {
                            bestProfile = candidate;
                            if (score === TARGETS.length && voice) {
                                event.reply('blockcheck-log', `[PERFECT MUTATION] ${name} — full Discord (web + voice).`);
                                break outer;
                            }
                        }
                    }
                }
            }
        }
    }

    event.reply('blockcheck-log', '---------------------------------------------------');
    if (!bestProfile) {
        event.reply('blockcheck-log', '[FATAL] No DPI strategy worked. Likely IP-level blacklist.');
        event.reply('blockcheck-log', 'Try again after switching networks or check ISP filtering rules.');
        event.reply('blockcheck-status', 'done');
        return;
    }

    // Top-3 ranked summary so the user can see alternatives, not just the winner
    event.reply('blockcheck-log', `TOP RESULTS (best ${topProfiles.length} of ${profileTotal} tested):`);
    topProfiles.forEach((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
        const voiceTag = p.voice ? 'voice ✓' : 'voice ✗';
        const vendorTag = p.vendor ? ` · ${p.vendor}` : '';
        event.reply('blockcheck-log', `  ${medal} ${p.name} — ${p.score}/${TARGETS.length} TCP, ${voiceTag}${vendorTag}`);
    });
    event.reply('blockcheck-log', '---------------------------------------------------');

    const voiceTag = bestProfile.voice ? 'web + voice' : 'web only (voice WILL fail)';
    event.reply('blockcheck-log', `APPLIED: ${bestProfile.name} — ${bestProfile.score}/${TARGETS.length} TCP, ${voiceTag}.`);
    if (!bestProfile.voice) {
        event.reply('blockcheck-log', '[WARNING] No voice-ready profile found. Discord calls will hang on "Starting…".');
        event.reply('blockcheck-log', '          The Proxy Discord module routes traffic through Tor — voice may work there.');
    }
    event.reply('blockcheck-done', {
        id: 'custom',
        name: 'Analysis Result: ' + bestProfile.name,
        args: bestProfile.args,
        voice: !!bestProfile.voice,
        topProfiles: topProfiles.map(p => ({
            id: p.id,
            name: p.name,
            score: p.score,
            voice: !!p.voice,
            vendor: p.vendor || null
        }))
    });
});
