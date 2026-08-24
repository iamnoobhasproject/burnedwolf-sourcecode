// --- HOSTLIST FILES (whitelist + Turkey master blocked-domain list) ---
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const getZapretDataPath = () => {
    const zapretDataPath = path.join(app.getPath('userData'), 'zapret-lists');
    if (!fs.existsSync(zapretDataPath)) fs.mkdirSync(zapretDataPath, { recursive: true });
    return zapretDataPath;
};

// --- TURKEY MASTER BLOCKED-DOMAIN LIST ---
// These are the high-value targets that BTK blocks or major Turkish ISPs
// throttle. Including them as a secondary --hostlist focuses DPI bypass work
// on the sites that actually need it, which reduces false positives elsewhere
// (Google search, banking, etc. stay untouched and full-speed).
//
// Maintained statically; user's own whitelist still takes precedence.
const TR_MASTER_BLOCKED_LIST = [
    // === Discord (block + voice region servers) ===
    'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg',
    'discord.media', 'discord.gift', 'discordstatus.com',
    'cdn.discordapp.com', 'media.discordapp.net',
    'gateway.discord.gg', 'remote-auth-gateway.discord.gg',
    // === Roblox (full block) ===
    'roblox.com', 'rbxcdn.com', 'roblox.org', 'robloxlabs.com',
    'web.roblox.com', 'www.roblox.com',
    // === X / Twitter (throttled + occasional block) ===
    'twitter.com', 'x.com', 't.co',
    'twimg.com', 'abs.twimg.com', 'video.twimg.com',
    'ton.twitter.com', 'api.twitter.com',
    // === YouTube (severe throttle) ===
    'youtube.com', 'youtu.be', 'm.youtube.com',
    'googlevideo.com', 'ytimg.com', 'yt3.ggpht.com',
    'youtube-nocookie.com', 'youtubei.googleapis.com',
    // === Mega ===
    'mega.nz', 'mega.co.nz', 'megaupload.com',
    // === Twitch (throttle) ===
    'twitch.tv', 'ttvnw.net', 'jtvnw.net',
    // === Reddit (occasional throttle) ===
    'reddit.com', 'redditstatic.com', 'redditmedia.com',
    // === Wikipedia (legacy, kept for historical block) ===
    'wikipedia.org', 'wikimedia.org',
    // === Cloudflare Workers (selective .workers.dev throttle) ===
    'workers.dev',
    // === Mainstream VPN sites (often blocked, useful for users wanting to access) ===
    'protonvpn.com', 'windscribe.com', 'mullvad.net', 'nordvpn.com',
    // === Tor ===
    'torproject.org'
];

function getTrMasterListPath() {
    return path.join(getZapretDataPath(), 'tr_master.txt');
}

// Write the TR master list to disk on every app start so list updates ship
// with the binary rather than being persisted by users.
function ensureTrMasterList() {
    try {
        const p = getTrMasterListPath();
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, TR_MASTER_BLOCKED_LIST.join('\n') + '\n', 'utf8');
    } catch (e) {
        console.warn('[tr-master-list] write failed:', e.message);
    }
}

// --- IPC: whitelist persistence + TR master info ---
ipcMain.on('save-whitelist-only', (event, whitelistData) => {
    const filePath = path.join(getZapretDataPath(), 'whitelist.txt');
    const finalDomains = whitelistData.split('\n').map(d => d.trim()).filter(d => d.length > 0);
    fs.writeFileSync(filePath, finalDomains.join('\n'), 'utf8');
});

ipcMain.on('load-whitelist', (event) => {
    const filePath = path.join(getZapretDataPath(), 'whitelist.txt');
    if (fs.existsSync(filePath)) {
        event.reply('whitelist-data', fs.readFileSync(filePath, 'utf8'));
    } else {
        event.reply('whitelist-data', '');
    }
});

// Expose the TR master list size so the whitelist tab can show "N domains bundled"
ipcMain.handle('get-tr-master-info', () => {
    return {
        count: TR_MASTER_BLOCKED_LIST.length,
        path: getTrMasterListPath()
    };
});

module.exports = { getZapretDataPath, getTrMasterListPath, ensureTrMasterList, TR_MASTER_BLOCKED_LIST };
