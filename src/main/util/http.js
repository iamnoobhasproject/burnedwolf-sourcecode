// Small HTTPS helpers shared by payload download, ISP detection, etc.
const https = require('https');
const fs = require('fs');

function downloadToFile(url, dest) {
    return new Promise((resolve, reject) => {
        const handle = (res, redirectsLeft = 5) => {
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectsLeft > 0) {
                https.get(res.headers.location, r => handle(r, redirectsLeft - 1)).on('error', reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(() => resolve()));
            out.on('error', reject);
        };
        https.get(url, handle).on('error', reject);
    });
}

function fetchJSON(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const req = https.get(url, {
            timeout: timeoutMs,
            headers: { 'User-Agent': 'BurnedWolf/1.3.0', 'Accept': 'application/json' }
        }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    });
}

module.exports = { downloadToFile, fetchJSON };
