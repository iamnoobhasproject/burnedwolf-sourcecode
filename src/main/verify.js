// ==========================================
// --- FILE INTEGRITY VERIFICATION ---
// ==========================================
// Downloads the reference archive, compares every file (size, then SHA-256)
// against the local install and repairs missing/corrupt ones. The verify
// window itself is created in windows.js; this module only does the work.
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { runExpandArchive } = require('./util/exec');

ipcMain.on('start-verification', async (event) => {
    const rootDir = process.execPath.includes('node_modules') ? process.cwd() : path.dirname(process.execPath);
    const zipPath = path.join(rootDir, 'net.zip');
    const extractPath = path.join(rootDir, 'net_temp');

    const netZipUrl = "https://github.com/iamnoobhasproject/app-updates/releases/download/123f12okopw21dwqdqwfwqdf/net.zip";

    event.reply('verify-log', 'Connecting to server. Downloading net.zip...');

    const file = fs.createWriteStream(zipPath);

    https.get(netZipUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, handleDownload).on('error', (err) => { event.reply('verify-error', "Download Error: " + err.message); });
        } else {
            handleDownload(response);
        }

        function handleDownload(res) {
            if (res.statusCode !== 200) {
                event.reply('verify-error', `Server file not found: HTTP ${res.statusCode}`);
                return;
            }

            const totalSize = parseInt(res.headers['content-length'], 10);
            let downloadedSize = 0;

            res.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
                event.reply('verify-progress', { phase: 'download', percent: percent, msg: `Downloading from server...` });
            });

            res.pipe(file);

            file.on('finish', () => {
                file.close();
                event.reply('verify-log', 'Extracting archive...');
                event.reply('verify-progress', { phase: 'extract', percent: 100, msg: `Opening files...` });

                runExpandArchive(zipPath, extractPath, async (err) => {
                    if (err) { event.reply('verify-error', "Extraction Error! " + err.message); return; }

                    event.reply('verify-log', 'Matching system files with server files...');

                    let missingOrCorruptFiles = [];

                    function getAllFiles(dirPath, arrayOfFiles) {
                        let files = fs.readdirSync(dirPath);
                        arrayOfFiles = arrayOfFiles || [];
                        files.forEach(function (file) {
                            if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
                                arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
                            } else {
                                arrayOfFiles.push(path.join(dirPath, file));
                            }
                        });
                        return arrayOfFiles;
                    }

                    function sha256File(filePath) {
                        return new Promise((resolve, reject) => {
                            const hash = crypto.createHash('sha256');
                            const stream = fs.createReadStream(filePath);
                            stream.on('data', d => hash.update(d));
                            stream.on('end', () => resolve(hash.digest('hex')));
                            stream.on('error', reject);
                        });
                    }

                    let extractedFiles = [];
                    try {
                        extractedFiles = getAllFiles(extractPath);
                    } catch (e) {
                        event.reply('verify-error', "Read error: " + e.message); return;
                    }

                    const totalFiles = extractedFiles.length;
                    let checkedCount = 0;

                    // Files we must never overwrite during integrity repair:
                    //   - The running executable itself (Windows locks it, copy fails
                    //     and the user sees "Burnedwolf.exe being replaced" forever).
                    //   - The asar bundle (handled by the updater, not by verify).
                    //   - Anything used by an active backend process (winws/tor) so
                    //     a live shield session doesn't get its binary swapped.
                    const runningExeName = path.basename(process.execPath).toLowerCase();
                    const SKIP_FILES = new Set([
                        runningExeName,         // e.g. "burnedwolf.exe"
                        'burnedwolf.exe',       // fixed fallback even when running via electron .
                        'app.asar',
                        'app.asar.unpacked',
                        'update.zip',
                        'update_system.bat',
                        'update_hidden.vbs',
                        'net.zip',
                        'settings.json'
                    ]);
                    // Folders to skip entirely (anywhere in the relative path).
                    const SKIP_DIR_PARTS = new Set([
                        'node_modules', 'tor-data', 'update_temp', 'net_temp', 'build', '.git'
                    ]);

                    const shouldSkip = (relPath) => {
                        const lowered = relPath.toLowerCase();
                        const base = path.basename(lowered);
                        if (SKIP_FILES.has(base)) return true;
                        const parts = lowered.split(/[\\/]/);
                        return parts.some(p => SKIP_DIR_PARTS.has(p));
                    };

                    for (const tempFilePath of extractedFiles) {
                        checkedCount++;
                        const relativePath = path.relative(extractPath, tempFilePath);
                        const localFilePath = path.join(rootDir, relativePath);

                        event.reply('verify-progress', { phase: 'check', percent: Math.round((checkedCount / totalFiles) * 100), msg: `Checking: ${relativePath}` });
                        await new Promise(r => setTimeout(r, 20));

                        // Skip protected/locked files — these belong to the updater
                        // pipeline, not to file-integrity repair.
                        if (shouldSkip(relativePath)) {
                            event.reply('verify-log', `[SKIPPED] ${relativePath} (protected by integrity policy)`);
                            continue;
                        }

                        let needsCopy = false;
                        if (!fs.existsSync(localFilePath)) {
                            needsCopy = true;
                            event.reply('verify-log', `[MISSING FILE] ${relativePath} not found in local directory.`);
                        } else {
                            const tempStat = fs.statSync(tempFilePath);
                            const localStat = fs.statSync(localFilePath);
                            if (tempStat.size !== localStat.size) {
                                needsCopy = true;
                                event.reply('verify-log', `[CORRUPT FILE] ${relativePath} (Size mismatch, will be repaired).`);
                            } else {
                                // Size matches — verify with SHA-256 to detect tampering
                                try {
                                    const [tempHash, localHash] = await Promise.all([
                                        sha256File(tempFilePath),
                                        sha256File(localFilePath)
                                    ]);
                                    if (tempHash !== localHash) {
                                        needsCopy = true;
                                        event.reply('verify-log', `[CORRUPT FILE] ${relativePath} (Hash mismatch, will be repaired).`);
                                    }
                                } catch (hashErr) {
                                    event.reply('verify-log', `[WARN] ${relativePath} hash check failed: ${hashErr.message}`);
                                }
                            }
                        }

                        if (needsCopy) {
                            missingOrCorruptFiles.push({ temp: tempFilePath, local: localFilePath, rel: relativePath });
                        }
                    }

                    if (missingOrCorruptFiles.length > 0) {
                        event.reply('verify-log', `Repairing total ${missingOrCorruptFiles.length} missing/corrupt files...`);
                        for (let i = 0; i < missingOrCorruptFiles.length; i++) {
                            const item = missingOrCorruptFiles[i];
                            event.reply('verify-progress', { phase: 'repair', percent: Math.round(((i + 1) / missingOrCorruptFiles.length) * 100), msg: `Copying: ${item.rel}` });

                            try {
                                const localDir = path.dirname(item.local);
                                if (!fs.existsSync(localDir)) { fs.mkdirSync(localDir, { recursive: true }); }
                                fs.copyFileSync(item.temp, item.local);
                            } catch (copyErr) {
                                // EBUSY / EPERM happen when a file is locked (e.g. .exe
                                // currently running, .dll mapped into a process). We log
                                // and keep going instead of looping forever.
                                event.reply('verify-log', `[SKIPPED] ${item.rel} could not be replaced (${copyErr.code || copyErr.message}). Continuing.`);
                            }
                            await new Promise(r => setTimeout(r, 30));
                        }
                    }

                    event.reply('verify-progress', { phase: 'cleanup', percent: 100, msg: `Cleaning up temporary files...` });
                    try { fs.rmSync(extractPath, { recursive: true, force: true }); } catch (e) {}
                    try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
                    event.reply('verify-done', { repairedCount: missingOrCorruptFiles.length });
                });
            });
        }
    }).on('error', (err) => { event.reply('verify-error', "Download Error: " + err.message); });
});
