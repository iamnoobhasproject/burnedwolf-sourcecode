// --- ZAPRET ASSET PATHS ---
// Resolved at startup so profile templates can reference fake-TLS/QUIC payloads
// without bundling them in the static ZAPRET_PROFILES object.
const path = require('path');
const { ROOT } = require('../constants');

const ZAPRET_BIN_DIR   = path.join(ROOT, 'zapret-bin').replace('app.asar', 'app.asar.unpacked');
const WINWS_EXE        = path.join(ZAPRET_BIN_DIR, 'winws.exe');
const FAKE_PAYLOAD_DIR = path.join(ZAPRET_BIN_DIR, 'fake');
const FAKE_TLS_PATH    = path.join(FAKE_PAYLOAD_DIR, 'tls_clienthello_www_google_com.bin');
const FAKE_QUIC_PATH   = path.join(FAKE_PAYLOAD_DIR, 'quic_initial_www_google_com.bin');

module.exports = { ZAPRET_BIN_DIR, WINWS_EXE, FAKE_PAYLOAD_DIR, FAKE_TLS_PATH, FAKE_QUIC_PATH };
