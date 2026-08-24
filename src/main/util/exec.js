// PowerShell / external-process helpers (PowerShell injection protection).
const { execFile } = require('child_process');

function psQuote(p) {
    // Escapes a path for safe use inside a PowerShell single-quoted string.
    // PowerShell escapes single quotes by doubling them.
    return "'" + String(p).replace(/'/g, "''") + "'";
}

function runExpandArchive(zipPath, destPath, cb) {
    // Uses execFile + array args to avoid shell interpretation of paths.
    const psArgs = [
        '-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Expand-Archive -Path ${psQuote(zipPath)} -DestinationPath ${psQuote(destPath)} -Force`
    ];
    execFile('powershell.exe', psArgs, { windowsHide: true }, cb);
}

// PowerShell wrapper that runs a snippet hidden and returns trimmed stdout.
function runPs(script, timeoutMs = 5000) {
    return new Promise((resolve) => {
        execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
            windowsHide: true,
            timeout: timeoutMs
        }, (err, stdout) => {
            resolve(err ? null : (stdout || '').trim());
        });
    });
}

module.exports = { psQuote, runExpandArchive, runPs };
