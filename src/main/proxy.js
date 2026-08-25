// ==========================================
// --- LOCAL PROXY BRIDGE ---
// ==========================================
// Tor already exposes a SOCKS5 endpoint (127.0.0.1:<torPort>) that any app can
// point at directly. This module adds the two things that make that usable for
// EVERY app, not just SOCKS-aware ones:
//
//   1. An HTTP proxy (127.0.0.1:<httpPort>) implemented in pure Node that
//      tunnels through Tor's SOCKS5 — for apps/tools that only speak HTTP proxy.
//      CONNECT (HTTPS) is a raw tunnel; plain HTTP is forwarded via a Node http
//      client whose socket is the SOCKS tunnel. DNS is resolved by Tor (domain
//      ATYP), so there is no local DNS leak.
//   2. A PAC file the user can point Windows / a browser at.
//
// SECURITY: every listener binds to 127.0.0.1 only — never a routable address —
// so the bridge is reachable only from this machine.
const { ipcMain, app } = require('electron');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const tor = require('./tor');

const SOCKS_HOST = '127.0.0.1';
let httpServer = null;
let httpPort = 9080;

// --- SOCKS5 client: open a tunnel to (destHost:destPort) through Tor ---
// Calls cb(err) or cb(null, socket) with a socket ready to carry the stream.
// Uses domain ATYP so hostnames are resolved inside Tor (leak-safe).
function socks5Connect(destHost, destPort, cb) {
    const socksPort = (tor.getState() && tor.getState().port) || 9050;
    const sock = net.connect(socksPort, SOCKS_HOST);
    let stage = 0, done = false, buf = Buffer.alloc(0);

    const fail = (e) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} cb(e || new Error('socks_fail')); };
    const onData = (chunk) => {
        if (done) return;
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error('socks_method'));
            buf = buf.slice(2);
            stage = 1;
            const host = Buffer.from(destHost, 'utf8');
            const req = Buffer.alloc(5 + host.length + 2);
            req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = host.length;
            host.copy(req, 5);
            req.writeUInt16BE(destPort, 5 + host.length);
            sock.write(req);
        }
        if (stage === 1) {
            if (buf.length < 4) return;
            if (buf[1] !== 0x00) return fail(new Error('socks_connect_' + buf[1]));
            const atyp = buf[3];
            let need = 4 + 2;
            if (atyp === 0x01) need += 4;
            else if (atyp === 0x04) need += 16;
            else if (atyp === 0x03) need += 1 + (buf[4] || 0);
            else return fail(new Error('socks_atyp'));
            if (buf.length < need) return;
            const leftover = buf.slice(need);
            done = true; stage = 2;
            sock.setTimeout(0);
            sock.removeListener('data', onData);
            sock.removeListener('error', fail);
            sock.removeListener('timeout', onTimeout);
            if (leftover.length) sock.unshift(leftover);
            cb(null, sock);
        }
    };
    const onTimeout = () => fail(new Error('socks_timeout'));

    sock.setTimeout(15000, onTimeout);
    sock.on('error', fail);
    sock.on('data', onData);
    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00]))); // greet: no-auth
}

// --- HTTP proxy server ---
function startHttp(port) {
    if (httpServer) return { ok: true, port: httpPort };
    httpPort = parseInt(port, 10) || httpPort;

    httpServer = http.createServer((req, res) => {
        // Plain HTTP (absolute-form URL) — forward via a Node client whose
        // underlying socket is the SOCKS tunnel.
        let u;
        try { u = new URL(req.url); } catch (e) { res.writeHead(400); return res.end(); }
        const preq = http.request({
            method: req.method,
            host: u.hostname,
            port: u.port || 80,
            path: (u.pathname || '/') + (u.search || ''),
            headers: req.headers,
            createConnection: (opts, cb) => socks5Connect(u.hostname, parseInt(u.port || '80', 10), cb)
        }, (pres) => {
            res.writeHead(pres.statusCode || 502, pres.headers);
            pres.pipe(res);
        });
        preq.on('error', () => { try { res.writeHead(502); res.end('proxy error'); } catch (_) {} });
        req.pipe(preq);
    });

    // HTTPS tunneling via CONNECT — raw pipe over the SOCKS tunnel.
    httpServer.on('connect', (req, clientSocket, head) => {
        const idx = req.url.lastIndexOf(':');
        const host = idx > 0 ? req.url.slice(0, idx) : req.url;
        const port = parseInt(idx > 0 ? req.url.slice(idx + 1) : '443', 10) || 443;
        socks5Connect(host, port, (err, up) => {
            if (err) { try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSocket.destroy(); } catch (_) {} return; }
            try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch (_) {}
            if (head && head.length) up.write(head);
            up.pipe(clientSocket);
            clientSocket.pipe(up);
            const cleanup = () => { try { up.destroy(); } catch (_) {} try { clientSocket.destroy(); } catch (_) {} };
            up.on('error', cleanup); clientSocket.on('error', cleanup);
        });
    });
    httpServer.on('clientError', (err, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {} });
    httpServer.on('error', () => { httpServer = null; });

    try {
        httpServer.listen(httpPort, SOCKS_HOST);   // localhost only
    } catch (e) {
        httpServer = null;
        return { ok: false, error: 'listen' };
    }
    return { ok: true, port: httpPort };
}

function stopHttp() {
    if (httpServer) { try { httpServer.close(); } catch (e) {} httpServer = null; }
    return { ok: true };
}

function status() {
    const st = tor.getState() || {};
    return {
        socksHost: SOCKS_HOST,
        socksPort: st.port || 9050,
        torReady: !!st.ready,
        httpRunning: !!httpServer,
        httpPort
    };
}

// --- PAC file ---
function pacPath() { return path.join(app.getPath('userData'), 'burnedwolf.pac'); }

function writePac() {
    const st = status();
    const body =
`function FindProxyForURL(url, host) {
  if (isPlainHostName(host) || host === "localhost" ||
      shExpMatch(host, "127.*") || shExpMatch(host, "10.*") ||
      shExpMatch(host, "192.168.*") || shExpMatch(host, "172.16.*")) {
    return "DIRECT";
  }
  return "SOCKS5 ${st.socksHost}:${st.socksPort}; SOCKS ${st.socksHost}:${st.socksPort}; DIRECT";
}
`;
    try {
        const p = pacPath();
        fs.writeFileSync(p, body, 'utf8');
        return { ok: true, path: p, url: 'file:///' + p.replace(/\\/g, '/') };
    } catch (e) {
        return { ok: false, error: 'write', detail: e.message };
    }
}

// --- IPC ---
ipcMain.handle('proxy-status', () => status());
ipcMain.handle('proxy-http-start', (event, port) => { const r = startHttp(port); return Object.assign(r, status()); });
ipcMain.handle('proxy-http-stop', () => { stopHttp(); return status(); });
ipcMain.handle('proxy-write-pac', () => writePac());

module.exports = { startHttp, stopHttp, status };
