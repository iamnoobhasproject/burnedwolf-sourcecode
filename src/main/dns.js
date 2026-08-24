// ==========================================
// --- DNS MANAGEMENT + DNSCRYPT-PROXY LIFECYCLE ---
// ==========================================
// Why this exists:
//   Türk Telekom (and a few other ISPs) hijack UDP port 53 traffic so changing
//   the system DNS to Cloudflare alone doesn't help — the ISP intercepts the
//   query and returns its own answer. DoH (DNS-over-HTTPS, port 443) bypasses
//   this because the ISP can't tell DNS-over-HTTPS apart from regular HTTPS.
//
//   We bundle `dnscrypt-proxy.exe` (open-source, well-trusted) which listens on
//   127.0.0.1:53 and forwards every query over HTTPS to Cloudflare/Quad9.
//   When the user enables Encrypted DNS, we point the OS at 127.0.0.1 and the
//   ISP can no longer see what's being resolved.
//
// Safety:
//   - Only the active network adapter is touched
//   - Original DNS configuration is captured before any change so we can revert
//   - On app exit (quit cleanup) we always revert if we changed something
//   - If dnscrypt-proxy crashes we automatically revert
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const nodeDns = require('dns');
const { spawn, exec, execSync } = require('child_process');
const { ROOT } = require('./constants');
const { runPs } = require('./util/exec');
const { broadcastToAll } = require('./util/broadcast');

const DNSCRYPT_BIN_DIR = path.join(ROOT, 'dnsproxy-bin').replace('app.asar', 'app.asar.unpacked');
const DNSCRYPT_EXE     = path.join(DNSCRYPT_BIN_DIR, 'dnscrypt-proxy.exe');
const DNSCRYPT_CONFIG  = path.join(DNSCRYPT_BIN_DIR, 'dnscrypt-proxy.toml');

let dnscryptProcess      = null;
let isEncryptedDnsActive = false;
let dnsRevertNeeded      = false; // true once we've changed system DNS
// The user's REAL DNS config captured right before we point them at the encrypted
// loopback. Shape: { adapter, v4Dhcp, v4:[..], v6Dhcp, v6:[..] }. Consumed on quit
// to put DNS back exactly how it was, so killing the app never leaves a dead
// 127.0.0.1 pointer that would cut the user's internet.
let dnsOriginalSnapshot  = null;

// Provider plate → friendly name. Used by the UI banner to show "Cloudflare"
// instead of a raw IP. Extend as needed.
const DNS_PROVIDER_NAMES = {
    '1.1.1.1':            'Cloudflare',
    '1.0.0.1':            'Cloudflare',
    '8.8.8.8':            'Google',
    '8.8.4.4':            'Google',
    '9.9.9.9':            'Quad9',
    '149.112.112.112':    'Quad9',
    '94.140.14.14':       'AdGuard',
    '94.140.15.15':       'AdGuard',
    '208.67.222.222':     'OpenDNS',
    '208.67.220.220':     'OpenDNS',
    '127.0.0.1':          'Encrypted (local DoH)',
    // Turkish ISP defaults — flagged as "ISP default" in UI
    '195.175.39.39':      'Türk Telekom',
    '195.175.39.40':      'Türk Telekom',
    '212.156.4.4':        'Türk Telekom',
    '212.156.4.5':        'Türk Telekom',
    '195.46.39.39':       'Türk Telekom',
    '212.252.31.247':     'Vodafone TR',
    '212.252.30.247':     'Vodafone TR',
    '212.253.130.250':    'Turkcell',
    '212.74.245.21':      'TurkNet'
};

// Returns the InterfaceAlias of the adapter that owns the default route.
// That's the one the user is actually using to reach the internet.
async function getActiveAdapter() {
    const out = await runPs(
        "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue " +
        "| Sort-Object -Property RouteMetric,InterfaceMetric " +
        "| Select-Object -First 1 -ExpandProperty InterfaceAlias)"
    );
    return out || null;
}

// Returns { adapter, ipv4: [...], ipv6: [...] }
async function getCurrentDnsServers() {
    const adapter = await getActiveAdapter();
    if (!adapter) return { adapter: null, ipv4: [], ipv6: [] };
    const psQuoted = "'" + adapter.replace(/'/g, "''") + "'";
    // PowerShell-side newline is `n (backtick-n). We build the script using
    // ordinary string concatenation so JS template-literal parser doesn't
    // choke on the backtick.
    const script =
        '$a = Get-DnsClientServerAddress -InterfaceAlias ' + psQuoted + ' -ErrorAction SilentlyContinue;' +
        "$v4 = ($a | Where-Object AddressFamily -eq 2 | Select-Object -ExpandProperty ServerAddresses) -join ',';" +
        "$v6 = ($a | Where-Object AddressFamily -eq 23 | Select-Object -ExpandProperty ServerAddresses) -join ',';" +
        '"IPv4=$v4|IPv6=$v6"';
    const out = await runPs(script);
    if (!out) return { adapter, ipv4: [], ipv6: [] };
    const ipv4 = ((out.match(/IPv4=([^|]*)/) || [])[1] || '').split(',').filter(Boolean);
    const ipv6 = ((out.match(/IPv6=([^|]*)/) || [])[1] || '').split(',').filter(Boolean);
    return { adapter, ipv4, ipv6 };
}

// Map IP list -> friendly provider summary used by the banner.
function describeDnsProvider(ipv4) {
    if (!ipv4 || ipv4.length === 0) return { name: null, isISP: false, isEncrypted: false };
    const first = ipv4[0];
    const friendly = DNS_PROVIDER_NAMES[first] || null;
    const isEncrypted = first === '127.0.0.1' || first === '::1';
    // Treat unknown DNS + adapter using DHCP as "ISP default"
    const ispProviders = ['Türk Telekom', 'Vodafone TR', 'Turkcell', 'TurkNet'];
    const isISP = friendly ? ispProviders.includes(friendly) : true;
    return { name: friendly, isISP, isEncrypted, raw: ipv4.join(', ') };
}

ipcMain.handle('get-dns-status', async () => {
    const cur = await getCurrentDnsServers();
    const prov = describeDnsProvider(cur.ipv4);
    return {
        adapter:    cur.adapter,
        ipv4:       cur.ipv4,
        ipv6:       cur.ipv6,
        provider:   prov.name,
        isISP:      prov.isISP,
        isEncrypted: isEncryptedDnsActive || prov.isEncrypted,
        raw:        prov.raw
    };
});

// Hard-set DNS on the active adapter. `primary` and `secondary` are v4 strings;
// `primaryV6`/`secondaryV6` are optional v6 strings.
async function setStaticDns(primary, secondary, primaryV6, secondaryV6) {
    const adapter = await getActiveAdapter();
    if (!adapter) return false;
    const q = '"' + adapter.replace(/"/g, '\\"') + '"';
    const cmds = [
        `netsh interface ipv4 set dnsservers ${q} static ${primary} primary validate=no`
    ];
    if (secondary) cmds.push(`netsh interface ipv4 add dnsservers ${q} ${secondary} index=2 validate=no`);
    if (primaryV6) {
        cmds.push(`netsh interface ipv6 set dnsservers ${q} static ${primaryV6} primary validate=no`);
        if (secondaryV6) cmds.push(`netsh interface ipv6 add dnsservers ${q} ${secondaryV6} index=2 validate=no`);
    }
    for (const c of cmds) {
        await new Promise(r => exec(c, { windowsHide: true }, () => r()));
    }
    dnsRevertNeeded = true;
    return true;
}

async function revertDnsToDhcp() {
    const adapter = await getActiveAdapter();
    if (!adapter) return false;
    const q = '"' + adapter.replace(/"/g, '\\"') + '"';
    await new Promise(r => exec(`netsh interface ipv4 set dnsservers ${q} source=dhcp`, { windowsHide: true }, () => r()));
    await new Promise(r => exec(`netsh interface ipv6 set dnsservers ${q} source=dhcp`, { windowsHide: true }, () => r()));
    dnsRevertNeeded = false;
    return true;
}

// Snapshot the user's REAL DNS config for the active adapter before we hijack it
// for encrypted DNS. We read the static NameServer registry value (authoritative
// and locale-independent): a non-empty value means statically-configured DNS, an
// empty value means DHCP/automatic. Loopback servers are scrubbed so we can never
// "restore" a broken 127.0.0.1 pointer. Returns the snapshot, or null on failure.
async function captureDnsSnapshot() {
    const adapter = await getActiveAdapter();
    if (!adapter) return null;
    const psq = "'" + adapter.replace(/'/g, "''") + "'";
    // Built with string concatenation so JS template-literal parsing doesn't choke
    // on the PowerShell tokens. Registry backslashes are JS-escaped (\\ -> \).
    const script =
        '$g=(Get-NetAdapter -InterfaceAlias ' + psq + ' -ErrorAction SilentlyContinue).InterfaceGuid;' +
        '$n4="";$n6="";' +
        'if($g){' +
        "$n4=(Get-ItemProperty ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\'+$g) -Name NameServer -ErrorAction SilentlyContinue).NameServer;" +
        "$n6=(Get-ItemProperty ('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters\\Interfaces\\'+$g) -Name NameServer -ErrorAction SilentlyContinue).NameServer;" +
        '}' +
        '"V4=" + $n4 + "|V6=" + $n6';
    const out = await runPs(script);
    if (out === null) return null;
    const splitServers = (s) => (s || '').split(/[ ,]+/).filter(Boolean);
    let v4 = splitServers((out.match(/V4=([^|]*)/) || [])[1]);
    let v6 = splitServers((out.match(/V6=([^|]*)/) || [])[1]);
    // Never carry a loopback pointer into the "original" we plan to restore.
    if (v4.some(ip => ip.startsWith('127.'))) v4 = [];
    if (v6.some(ip => ip === '::1'))          v6 = [];
    return { adapter, v4Dhcp: v4.length === 0, v4, v6Dhcp: v6.length === 0, v6 };
}

// Build the netsh commands that put DNS back to a captured snapshot (DHCP or the
// exact static servers). Pure/synchronous so it can be replayed via execSync from
// the quit cleanup. Returns [] when there's nothing to restore.
function buildSnapshotRevertCmds(snap) {
    if (!snap || !snap.adapter) return [];
    const q = '"' + snap.adapter.replace(/"/g, '') + '"';
    const cmds = [];
    if (snap.v4Dhcp || !snap.v4.length) {
        cmds.push(`netsh interface ipv4 set dnsservers ${q} source=dhcp`);
    } else {
        cmds.push(`netsh interface ipv4 set dnsservers ${q} static ${snap.v4[0]} primary validate=no`);
        for (let i = 1; i < snap.v4.length; i++)
            cmds.push(`netsh interface ipv4 add dnsservers ${q} ${snap.v4[i]} index=${i + 1} validate=no`);
    }
    if (snap.v6Dhcp || !snap.v6.length) {
        cmds.push(`netsh interface ipv6 set dnsservers ${q} source=dhcp`);
    } else {
        cmds.push(`netsh interface ipv6 set dnsservers ${q} static ${snap.v6[0]} primary validate=no`);
        for (let i = 1; i < snap.v6.length; i++)
            cmds.push(`netsh interface ipv6 add dnsservers ${q} ${snap.v6[i]} index=${i + 1} validate=no`);
    }
    return cmds;
}

// PowerShell one-liner that resets ANY adapter still pointing at a loopback DNS,
// by numeric index (immune to adapter-name encoding / adapter switches between
// sessions). Shared by quit cleanup and crash recovery.
const LOOPBACK_RESET_CMD =
    'powershell -NoProfile -NonInteractive -Command "' +
    "Get-DnsClientServerAddress -ErrorAction SilentlyContinue | " +
    "Where-Object { ($_.ServerAddresses -contains '127.0.0.1') -or ($_.ServerAddresses -contains '::1') } | " +
    "ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue }" +
    '"';

// --- CRASH-SAFE DNS RESTORE (survives power loss / forced shutdown) ---
// The snapshot above lives only in RAM, so a clean Quit can put DNS back. But if
// the machine is shut down / restarted / loses power while encrypted DNS is on
// (no clean quit), the OS is left pointing at the now-dead 127.0.0.1 resolver and
// the in-memory snapshot is gone — the user loses internet until they manually fix
// DNS. To survive that, we ALSO persist the snapshot to disk the moment we hijack
// DNS, and delete it on every clean revert. On the next launch recoverDnsFromCrash()
// sees the leftover marker and restores DNS before anything else runs.
function getDnsPendingPath() {
    return path.join(app.getPath('userData'), 'dns-pending.json');
}
function writeDnsPending(snapshot) {
    try {
        fs.writeFileSync(getDnsPendingPath(), JSON.stringify({ snapshot: snapshot || null, ts: Date.now() }));
    } catch (e) {}
}
function clearDnsPending() {
    try { fs.unlinkSync(getDnsPendingPath()); } catch (e) {}
}

// Runs once at startup. If a previous session left encrypted DNS on without a clean
// quit, the system is stranded on a loopback resolver right now — replay the
// captured DNS (exact static servers or DHCP) and then reset ANY adapter still
// stuck on 127.0.0.1 / ::1, then delete the marker. Mirrors the quit-time logic.
function recoverDnsFromCrash() {
    let raw = null;
    try {
        const p = getDnsPendingPath();
        if (!fs.existsSync(p)) return;          // normal launch: nothing to repair
        raw = fs.readFileSync(p, 'utf8');
    } catch (e) { return; }
    // The marker exists → a previous DoH session didn't clean up, so DNS may be
    // stranded on loopback right now. Repair it even if the file is corrupt (a
    // half-written marker from power loss still means "DoH was on").
    let pending = null;
    try { pending = JSON.parse(raw); } catch (e) { pending = null; }
    // 1. Replay the exact captured DNS for its adapter (no-op if snapshot missing).
    try {
        for (const c of buildSnapshotRevertCmds(pending && pending.snapshot)) {
            try { execSync(c, { windowsHide: true, timeout: 6000 }); } catch (e) {}
        }
    } catch (e) {}
    // 2. Safety net — reset any adapter still pointing at a loopback DNS.
    try {
        execSync(LOOPBACK_RESET_CMD, { windowsHide: true, timeout: 8000 });
    } catch (e) {}
    clearDnsPending();
}

// ==========================================================================
// --- DoH RESIDUE PREFLIGHT (runs on every launch) ---
// ==========================================================================
// recoverDnsFromCrash() above only fires when OUR marker file survived. It can't
// help in the cases users actually hit:
//   * the machine was force-powered-off before the marker was ever written
//   * the marker was lost/cleaned, or an older build left the residue
//   * dnscrypt-proxy was killed by an AV / cleanup tool while DNS stayed hijacked
// In all of those the adapter is still pointing at 127.0.0.1 with nothing
// listening there, so the machine has NO working DNS: the update check fails and
// the user is told to fix DNS by hand. That is exactly what must not happen.
//
// So on every launch we independently ask the OS which adapters resolve through
// loopback and whether anything is actually answering there. A loopback pointer
// WITH a live local resolver is legitimate (the user may run AdGuard Home,
// Pi-hole, Simple DNSCrypt, or our own proxy) and is never touched. A loopback
// pointer with nothing answering is residue, and we repair it before the app
// goes anywhere near the network.

// One PowerShell round-trip returns everything we need to make that decision.
const RESIDUE_SCAN_PS =
    "$rows = Get-DnsClientServerAddress -ErrorAction SilentlyContinue | " +
    "Where-Object { ($_.ServerAddresses -contains '127.0.0.1') -or ($_.ServerAddresses -contains '::1') } | " +
    "ForEach-Object { \"$($_.InterfaceIndex)~$($_.InterfaceAlias)~$($_.ServerAddresses -join ',')\" };" +
    "$listen = @(Get-NetUDPEndpoint -LocalPort 53 -ErrorAction SilentlyContinue).Count;" +
    "'ROWS=' + ($rows -join ';') + '|LISTEN=' + $listen";

// Ask 127.0.0.1 to resolve a name. Definitive proof that a local resolver is
// alive — a listening socket alone can be a stale/half-dead process.
function probeLoopbackResolver(timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => finish(false), timeoutMs || 1400);
        try {
            const r = new nodeDns.Resolver();
            r.setServers(['127.0.0.1']);
            r.resolve4('cloudflare.com', (err, addrs) => {
                clearTimeout(timer);
                finish(!err && Array.isArray(addrs) && addrs.length > 0);
            });
        } catch (e) { clearTimeout(timer); finish(false); }
    });
}

// Can the machine resolve names at all right now (using whatever the OS is set
// to)? This is the symptom the user feels: "the updater can't connect".
function probeSystemDns(timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        const timer = setTimeout(() => finish(false), timeoutMs || 2500);
        try {
            nodeDns.lookup('raw.githubusercontent.com', { family: 4 }, (err, addr) => {
                clearTimeout(timer);
                finish(!err && !!addr);
            });
        } catch (e) { clearTimeout(timer); finish(false); }
    });
}

// Pure detection — never changes anything.
// → { adapters: [{index, alias, servers}], localResolverAlive, dnsWorking, stranded }
async function scanDnsResidue() {
    const report = { adapters: [], localResolverAlive: false, dnsWorking: true, stranded: false, ownProxy: isEncryptedDnsActive };
    let out = null;
    try { out = await runPs(RESIDUE_SCAN_PS); } catch (e) { out = null; }
    if (out) {
        const rowsRaw = ((out.match(/ROWS=([^|]*)/) || [])[1] || '').trim();
        if (rowsRaw) {
            for (const row of rowsRaw.split(';')) {
                const parts = row.split('~');
                if (parts.length < 3) continue;
                const index = parseInt(parts[0], 10);
                if (!Number.isFinite(index)) continue;
                report.adapters.push({
                    index,
                    alias: parts[1] || '',
                    servers: (parts[2] || '').split(',').filter(Boolean)
                });
            }
        }
    }
    if (report.adapters.length === 0) return report;    // nothing points at loopback

    // Our own encrypted DNS running = the loopback pointer is ours and correct.
    if (isEncryptedDnsActive && dnscryptProcess) {
        report.localResolverAlive = true;
        return report;
    }
    report.localResolverAlive = await probeLoopbackResolver(1400);
    if (report.localResolverAlive) return report;       // somebody else's resolver — hands off

    // An adapter pointing at a dead loopback resolver IS residue, full stop.
    // This used to be gated on "can the machine resolve anything at all", which
    // silently skipped the repair whenever some OTHER path still worked — a
    // second adapter, or IPv6 servers on the same one. The user's IPv4 lookups
    // are still broken in that state, and it is exactly the half-broken case
    // that is hardest to diagnose by hand.
    report.stranded = true;
    // Still probe: it decides whether this is urgent (nothing resolves at all)
    // or a quieter cleanup, and it is what the UI reports back to the user.
    report.dnsWorking = await probeSystemDns(2500);
    report.severity = report.dnsWorking ? 'partial' : 'offline';
    return report;
}

// Put the stranded adapters back. Restores the exact pre-DoH servers when we
// still have the crash marker, otherwise hands the adapter back to DHCP (which
// is what the overwhelming majority of home setups use).
async function repairDnsResidue() {
    const before = await scanDnsResidue();
    if (before.adapters.length === 0) {
        return { ok: true, repaired: false, reason: 'no_residue', report: before };
    }
    if (before.localResolverAlive) {
        return { ok: true, repaired: false, reason: 'local_resolver_alive', report: before };
    }

    // 1. Prefer the user's captured original config (exact static servers / DHCP).
    let pending = null;
    try {
        const p = getDnsPendingPath();
        if (fs.existsSync(p)) pending = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { pending = null; }
    for (const c of buildSnapshotRevertCmds(pending && pending.snapshot)) {
        try { execSync(c, { windowsHide: true, timeout: 6000 }); } catch (e) {}
    }

    // 2. Reset every adapter still on loopback, by interface index so adapter
    //    renames / non-ASCII names can't make this miss.
    for (const a of before.adapters) {
        const cmd = 'powershell -NoProfile -NonInteractive -Command "' +
            `Set-DnsClientServerAddress -InterfaceIndex ${a.index} -ResetServerAddresses -ErrorAction SilentlyContinue` + '"';
        try { execSync(cmd, { windowsHide: true, timeout: 8000 }); } catch (e) {}
        try { execSync(`netsh interface ipv4 set dnsservers name="${a.index}" source=dhcp`, { windowsHide: true, timeout: 6000 }); } catch (e) {}
        try { execSync(`netsh interface ipv6 set dnsservers name="${a.index}" source=dhcp`, { windowsHide: true, timeout: 6000 }); } catch (e) {}
    }
    // 3. Broad safety net for anything the per-index pass missed.
    try { execSync(LOOPBACK_RESET_CMD, { windowsHide: true, timeout: 8000 }); } catch (e) {}
    // 4. Drop the stale resolver cache so the very next lookup uses the new servers.
    try { execSync('ipconfig /flushdns', { windowsHide: true, timeout: 5000 }); } catch (e) {}
    clearDnsPending();
    dnsRevertNeeded = false;

    const after = await scanDnsResidue();
    const ok = after.adapters.length === 0 || after.localResolverAlive || after.dnsWorking;
    return {
        ok,
        repaired: true,
        adaptersFixed: before.adapters.map(a => a.alias || ('#' + a.index)),
        usedSnapshot: !!(pending && pending.snapshot),
        report: after
    };
}

// Last preflight result, so any window that opens later can render the outcome
// without re-running the scan.
let lastPreflight = null;
// The main process starts the preflight at boot and the updater window asks for
// it a moment later. Share the in-flight promise so the scan runs exactly once.
let preflightInFlight = null;

// Launch-time entry point. Detects residue and repairs it silently; only when
// the repair fails does the UI need to bother the user with a button.
function preflightDns(opts) {
    if (preflightInFlight) return preflightInFlight;
    preflightInFlight = runPreflight(opts).finally(() => { preflightInFlight = null; });
    return preflightInFlight;
}

async function runPreflight(opts) {
    const autoRepair = !(opts && opts.autoRepair === false);
    let result;
    try {
        const scan = await scanDnsResidue();
        if (!scan.stranded) {
            result = { state: scan.adapters.length && scan.localResolverAlive ? 'local_resolver' : 'healthy', scan };
        } else if (!autoRepair) {
            result = { state: 'residue', scan };
        } else {
            const fix = await repairDnsResidue();
            result = {
                state: fix.ok ? 'repaired' : 'failed',
                adaptersFixed: fix.adaptersFixed || [],
                usedSnapshot: !!fix.usedSnapshot,
                scan: fix.report
            };
        }
    } catch (e) {
        result = { state: 'error', error: String(e && e.message || e) };
    }
    result.ts = Date.now();
    lastPreflight = result;
    broadcastToAll('dns-preflight-result', result);
    return result;
}

ipcMain.handle('dns-preflight', async (event, opts) => preflightDns(opts));
ipcMain.handle('dns-residue-scan', async () => scanDnsResidue());
ipcMain.handle('dns-residue-fix', async () => {
    const fix = await repairDnsResidue();
    lastPreflight = { state: fix.ok ? 'repaired' : 'failed', adaptersFixed: fix.adaptersFixed || [], scan: fix.report, ts: Date.now() };
    broadcastToAll('dns-preflight-result', lastPreflight);
    return fix;
});
ipcMain.handle('dns-preflight-last', () => lastPreflight);

// Built-in provider presets used by the UI dropdown.
const DNS_PRESETS = {
    cloudflare: { v4: ['1.1.1.1', '1.0.0.1'],          v6: ['2606:4700:4700::1111', '2606:4700:4700::1001'] },
    google:     { v4: ['8.8.8.8', '8.8.4.4'],          v6: ['2001:4860:4860::8888', '2001:4860:4860::8844'] },
    quad9:      { v4: ['9.9.9.9', '149.112.112.112'],  v6: ['2620:fe::fe', '2620:fe::9'] },
    adguard:    { v4: ['94.140.14.14', '94.140.15.15'],v6: ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'] }
};

async function applyDnsPreset(key) {
    if (key === 'dhcp') {
        // Make sure any encrypted-DNS process is also stopped before reverting
        if (isEncryptedDnsActive) await stopEncryptedDns();
        return await revertDnsToDhcp();
    }
    const preset = DNS_PRESETS[key];
    if (!preset) return false;
    // Switching to a plain DNS provider implies encrypted DNS must go off
    if (isEncryptedDnsActive) await stopEncryptedDns();
    return await setStaticDns(preset.v4[0], preset.v4[1], preset.v6[0], preset.v6[1]);
}
ipcMain.handle('apply-dns-preset', (event, key) => applyDnsPreset(key));

// --- DNSCRYPT-PROXY LIFECYCLE ---

async function startEncryptedDns() {
    if (isEncryptedDnsActive && dnscryptProcess) return { ok: true, already: true };
    if (!fs.existsSync(DNSCRYPT_EXE)) {
        return { ok: false, error: 'binary_missing' };
    }
    try {
        dnscryptProcess = spawn(DNSCRYPT_EXE, ['-config', DNSCRYPT_CONFIG], {
            cwd: DNSCRYPT_BIN_DIR,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        dnscryptProcess.on('exit', () => {
            // If the proxy dies unexpectedly we must revert DNS so the user isn't
            // left with a broken 127.0.0.1 pointer
            if (isEncryptedDnsActive) {
                isEncryptedDnsActive = false;
                dnscryptProcess = null;
                revertDnsToDhcp().catch(() => {});
                clearDnsPending();   // DNS is back on DHCP — drop the crash-restore marker
                broadcastToAll('encrypted-dns-status', { active: false, crashed: true });
            }
        });
        // Give the proxy ~1.5s to bind port 53 before pointing the OS at it
        await new Promise(r => setTimeout(r, 1500));
        if (!dnscryptProcess || dnscryptProcess.exitCode !== null) {
            isEncryptedDnsActive = false;
            return { ok: false, error: 'port_in_use_or_crashed' };
        }
        // Capture the user's real DNS BEFORE we overwrite it, so quit can restore
        // it exactly (and never leave a dead 127.0.0.1 pointer).
        dnsOriginalSnapshot = await captureDnsSnapshot();
        const ok = await setStaticDns('127.0.0.1', null, '::1', null);
        if (!ok) {
            stopEncryptedDnsInternal();
            return { ok: false, error: 'dns_apply_failed' };
        }
        isEncryptedDnsActive = true;
        // Persist the captured snapshot to disk so a crash / power loss / forced
        // shutdown (no clean quit) can self-heal DNS on the next launch.
        writeDnsPending(dnsOriginalSnapshot);
        broadcastToAll('encrypted-dns-status', { active: true });
        return { ok: true };
    } catch (e) {
        isEncryptedDnsActive = false;
        dnscryptProcess = null;
        return { ok: false, error: e.message };
    }
}
ipcMain.handle('start-encrypted-dns', () => startEncryptedDns());

ipcMain.handle('stop-encrypted-dns', async () => {
    await stopEncryptedDns();
    return { ok: true };
});

function stopEncryptedDnsInternal() {
    if (dnscryptProcess) {
        try { dnscryptProcess.kill('SIGKILL'); } catch (e) {}
        dnscryptProcess = null;
    }
    isEncryptedDnsActive = false;
}

async function stopEncryptedDns() {
    stopEncryptedDnsInternal();
    if (dnsRevertNeeded) await revertDnsToDhcp();
    clearDnsPending();   // user turned DoH off cleanly — drop the crash-restore marker
    broadcastToAll('encrypted-dns-status', { active: false });
}

// Synchronous quit-time cleanup (registered with quit.js). Kills the proxy and
// restores the user's real pre-encrypted DNS (exact static servers, or DHCP),
// synchronously, so the internet keeps working once the app is gone.
function cleanupSync() {
    try { if (dnscryptProcess) { dnscryptProcess.kill('SIGKILL'); dnscryptProcess = null; } } catch (e) {}
    if (dnsRevertNeeded) {
        try {
            for (const c of buildSnapshotRevertCmds(dnsOriginalSnapshot)) {
                try { execSync(c, { windowsHide: true, timeout: 6000 }); } catch (e) {}
            }
        } catch (e) {}
        // Safety net — guarantee NO adapter is left pointing at a loopback DNS,
        // even if the snapshot restore above failed.
        try {
            execSync(LOOPBACK_RESET_CMD, { windowsHide: true, timeout: 8000 });
        } catch (e) {}
        dnsRevertNeeded = false;
        try { clearDnsPending(); } catch (e) {}   // clean revert done — drop the crash-restore marker
    }
}

// Read-only status for the AI context builder (never triggers a PowerShell call).
function getDnsSummary() {
    return {
        encryptedActive: isEncryptedDnsActive,
        proxyRunning: !!dnscryptProcess,
        weChangedDns: dnsRevertNeeded,
        originalSnapshot: dnsOriginalSnapshot,
        lastPreflight
    };
}

module.exports = {
    recoverDnsFromCrash,
    cleanupSync,
    scanDnsResidue,
    repairDnsResidue,
    preflightDns,
    getDnsSummary,
    getCurrentDnsServers,
    describeDnsProvider,
    applyDnsPreset,
    startEncryptedDns,
    stopEncryptedDns
};
