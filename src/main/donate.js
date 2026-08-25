// --- DONATION ---
// BurnedWolf is free and always has been. This module is the single place the
// Bitcoin address exists in code.
//
// The renderer never supplies the address or the URI — it asks for them
// (`donate-info`), asks main to copy (`donate-copy`), or asks main to hand the
// URI to the OS (`donate-open-wallet`). Nothing a renderer says can change
// where funds go or what reaches shell.openExternal, which is the whole reason
// the string is not simply hardcoded in titlebar.js next to the markup.
//
// If ADDRESS ever changes, renderer/donate-qr.svg must be regenerated from the
// new `bitcoin:` URI — the QR carries a copy of the address that this file
// cannot keep in sync on its own. The SVG records its payload in a comment at
// the top; regenerate at error-correction level M with a 4-module quiet zone.
const { ipcMain, shell, clipboard } = require('electron');

// Native SegWit (P2WPKH, bech32). Verified: valid checksum, mainnet hrp "bc",
// witness v0, 20-byte program.
const ADDRESS = 'bc1qqcqsdfm29rv4ta55e2xyqwqcs5ujwaqzx326uv';

// BIP-21. No amount and no label: a donation is whatever the sender decides.
const URI = 'bitcoin:' + ADDRESS;

ipcMain.handle('donate-info', () => ({ address: ADDRESS, uri: URI }));

// Copying happens in main so the address the user pastes is the address this
// file holds, not whatever the renderer had on screen.
ipcMain.handle('donate-copy', () => {
    try { clipboard.writeText(ADDRESS); return true; } catch (e) { return false; }
});

// Hands the bitcoin: URI to the OS, which opens whichever wallet is registered
// for the scheme. Fails quietly (returns ok:false) when no wallet is installed
// — the panel still shows the address and the QR, so nothing is lost.
ipcMain.handle('donate-open-wallet', async () => {
    try { await shell.openExternal(URI); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
});

module.exports = { ADDRESS, URI };
