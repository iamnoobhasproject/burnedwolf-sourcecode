// Fetch the fake-TLS / fake-QUIC payloads from the zapret-win-bundle repo on
// first run. These are real ClientHello / Initial packets captured from
// google.com — many DPI vendors (TTNet's Sandvine especially) refuse to drop
// packets that look like they belong to a Google handshake, so wrapping our
// fake injections in this payload dramatically improves the bypass rate.
// Payloads live in the main zapret repository under files/fake/, NOT in the
// Windows bundle (that one only ships the QUIC Initial inside files/, no fake/
// subfolder and no TLS variant). URLs verified May 2025 — TLS: 681 B, QUIC: 1200 B.
const fs = require('fs');
const path = require('path');
const { downloadToFile } = require('../util/http');
const { FAKE_PAYLOAD_DIR, FAKE_TLS_PATH, FAKE_QUIC_PATH } = require('./paths');

const FAKE_PAYLOAD_SOURCES = {
    'tls_clienthello_www_google_com.bin':
        'https://raw.githubusercontent.com/bol-van/zapret/master/files/fake/tls_clienthello_www_google_com.bin',
    'quic_initial_www_google_com.bin':
        'https://raw.githubusercontent.com/bol-van/zapret/master/files/fake/quic_initial_www_google_com.bin'
};

async function ensureFakePayloads() {
    try {
        if (!fs.existsSync(FAKE_PAYLOAD_DIR)) fs.mkdirSync(FAKE_PAYLOAD_DIR, { recursive: true });
        for (const [name, url] of Object.entries(FAKE_PAYLOAD_SOURCES)) {
            const filePath = path.join(FAKE_PAYLOAD_DIR, name);
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) continue;
            try {
                await downloadToFile(url, filePath);
            } catch (e) {
                console.warn(`[fake-payload] Could not download ${name}: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn('[fake-payload] ensure failed:', e.message);
    }
}

// Helper that profile templates use: returns true iff both fake-payload files
// are present and non-empty. Profiles fall back to non-fake variants when false.
function fakePayloadsAvailable() {
    try {
        return fs.existsSync(FAKE_TLS_PATH)  && fs.statSync(FAKE_TLS_PATH).size  > 0
            && fs.existsSync(FAKE_QUIC_PATH) && fs.statSync(FAKE_QUIC_PATH).size > 0;
    } catch (e) { return false; }
}

module.exports = { ensureFakePayloads, fakePayloadsAvailable };
