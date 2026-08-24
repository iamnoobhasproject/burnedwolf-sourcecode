// --- ISP AUTO-DETECTION ---
// Map AS Numbers → Turkish ISPs and recommended profile order. The first
// profile in each list is the strongest (Ultimate / fake-payload variants);
// subsequent ones are lighter fallbacks.
// Each chain is ordered: Ultimate (fake-payload, strongest) → Pro (advanced
// flags, offline-ready) → All-in-One (broad coverage) → niche/legacy tunings.
// Failover walks this exact order; "Apply best" picks the first one.
const { ipcMain } = require('electron');
const { fetchJSON } = require('./util/http');

const ASN_PROFILE_MAP = {
    9121:  { isp: 'Türk Telekom',          profiles: ['tr_ttnet_ultimate',       'tr_ttnet_pro',       'tr_ttnet_all_in_one',       'tr_ttnet_fiber', 'tr_ttnet_discord', 'tr_ttnet_std'] },
    47331: { isp: 'Turkcell Superonline',  profiles: ['tr_superonline_ultimate', 'tr_superonline_pro', 'tr_superonline_all_in_one', 'tr_superonline_d', 'tr_superonline'] },
    15897: { isp: 'Vodafone TR',           profiles: ['tr_vodafone_ultimate',    'tr_vodafone_pro',    'tr_vodafone_all_in_one',    'tr_vodafone_std', 'tr_vodafone_yt'] },
    12978: { isp: 'Vodafone Mobile TR',    profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_vf'] },
    34984: { isp: 'Tellcom (Turkcell)',    profiles: ['tr_superonline_ultimate', 'tr_superonline_pro', 'tr_superonline_all_in_one', 'tr_mobile_tc'] },
    43260: { isp: 'TurkNet',               profiles: ['tr_universal_pro',        'tr_turknet_all_in_one', 'tr_turknet'] },
    16135: { isp: 'Turkcell Mobile',       profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_tc'] },
    43133: { isp: 'Türksat Uydunet',       profiles: ['tr_universal_pro',        'tr_uydunet_all_in_one', 'tr_uydunet'] },
    20978: { isp: 'D-Smart',               profiles: ['tr_universal_pro',        'tr_dsmart_all_in_one', 'tr_dsmart'] },
    8386:  { isp: 'Kablonet',              profiles: ['tr_universal_pro',        'tr_kablonet_all_in_one', 'tr_kablonet'] },
    34164: { isp: 'TT Mobil (Avea)',       profiles: ['tr_mobile_pro',           'tr_mobile_all_in_one', 'tr_mobile_tt'] }
};

// Cache the detection for the lifetime of the app — public IP rarely changes
// mid-session and we don't want to hammer ipinfo.io on every DPI panel open.
let cachedISPDetection = null;

async function detectISP(opts) {
    // opts.force = bypass cache
    if (cachedISPDetection && !(opts && opts.force)) return cachedISPDetection;

    // Try ipinfo.io first, fall back to ipapi.co — both free, no API key needed.
    let info = await fetchJSON('https://ipinfo.io/json');
    let asn = null, orgName = null;
    if (info && info.org) {
        const m = info.org.match(/^AS(\d+)\s+(.+)/);
        if (m) { asn = parseInt(m[1], 10); orgName = m[2]; }
    }

    if (!asn) {
        // Fallback provider
        info = await fetchJSON('https://ipapi.co/json/');
        if (info && info.asn) {
            const m = String(info.asn).match(/AS(\d+)/);
            if (m) asn = parseInt(m[1], 10);
            orgName = info.org || info.asn;
        }
    }

    if (!asn) {
        const fallback = { detected: false, reason: 'No public IP / ISP lookup failed' };
        cachedISPDetection = fallback;
        return fallback;
    }

    const mapping = ASN_PROFILE_MAP[asn];
    const result = {
        detected: true,
        known: !!mapping,
        ip: info.ip || null,
        country: info.country || info.country_code || null,
        city: info.city || null,
        asn,
        organization: orgName,
        ispLabel: mapping ? mapping.isp : (orgName || `AS${asn}`),
        recommendedProfiles: mapping ? mapping.profiles : []
    };
    cachedISPDetection = result;
    return result;
}

ipcMain.handle('detect-isp', (event, opts) => detectISP(opts));

// Engine failover and blockcheck read the cached detection without re-querying.
function getCachedDetection() { return cachedISPDetection; }

module.exports = { ASN_PROFILE_MAP, getCachedDetection, detectISP };
