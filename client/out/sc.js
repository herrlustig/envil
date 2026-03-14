"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addSuppressMarker = addSuppressMarker;
exports.initOutputChannels = initOutputChannels;
exports.isSclangRunning = isSclangRunning;
exports.startSclang = startSclang;
exports.stopSclang = stopSclang;
exports.executeCode = executeCode;
exports.sendCode = sendCode;
exports.queryCode = queryCode;
exports.findCodeBlock = findCodeBlock;
exports.executeBlock = executeBlock;
exports.bootServer = bootServer;
exports.rebootServer = rebootServer;
exports.killServer = killServer;
exports.stopAllSounds = stopAllSounds;
exports.openHelpForCursor = openHelpForCursor;
const fs = require("fs");
const child_process_1 = require("child_process");
const vscode_1 = require("vscode");
let sclangProcess = null;
let sclangOutput;
let postWindowOutput;
const stdoutListeners = [];
// ── Markers to suppress from Post Window ──────────────────────────────────────
const suppressMarkers = new Set();
let _stdoutBuf = '';
function addSuppressMarker(marker) {
    suppressMarkers.add(marker);
}
/**
 * Strip any marker-delimited blocks from text before it reaches the Post Window.
 * Accumulates partial data across chunks to handle split markers.
 */
function filterMarkers(text) {
    if (suppressMarkers.size === 0)
        return text;
    _stdoutBuf += text;
    // Remove each complete marker…marker block
    for (const m of suppressMarkers) {
        let startIdx;
        while ((startIdx = _stdoutBuf.indexOf(m)) !== -1) {
            const endIdx = _stdoutBuf.indexOf(m, startIdx + m.length);
            if (endIdx === -1) {
                // Partial — wait for more data.  Return everything before the marker.
                const clean = _stdoutBuf.substring(0, startIdx);
                _stdoutBuf = _stdoutBuf.substring(startIdx);
                return clean;
            }
            // Remove the full block including trailing newline if present
            let removeEnd = endIdx + m.length;
            if (_stdoutBuf[removeEnd] === '\n')
                removeEnd++;
            _stdoutBuf = _stdoutBuf.substring(0, startIdx) + _stdoutBuf.substring(removeEnd);
        }
    }
    // No partial marker pending — flush the whole buffer
    const result = _stdoutBuf;
    _stdoutBuf = '';
    return result;
}
function initOutputChannels() {
    if (!sclangOutput) {
        sclangOutput = vscode_1.window.createOutputChannel('SuperCollider');
    }
    if (!postWindowOutput) {
        postWindowOutput = vscode_1.window.createOutputChannel('SuperCollider Post Window');
    }
}
function isSclangRunning() {
    return sclangProcess !== null && !sclangProcess.killed;
}
// ── Path helpers ─────────────────────────────────────────────────────────────
function getCommonMacOSPaths() {
    return [
        '/Applications/SuperCollider.app/Contents/Resources/sclang',
        '/Applications/SuperCollider.app/Contents/MacOS/sclang',
        '/usr/local/bin/sclang',
        '/opt/homebrew/bin/sclang',
        '/usr/bin/sclang',
    ];
}
function isExecutable(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && (stats.mode & fs.constants.S_IXUSR) !== 0;
    }
    catch {
        return false;
    }
}
function findSclangPath(configuredPath) {
    // Absolute / explicit path – check directly
    if (configuredPath !== 'sclang' && (configuredPath.includes('/') || configuredPath.includes('\\'))) {
        return isExecutable(configuredPath) ? configuredPath : null;
    }
    // On macOS try common install paths first
    if (process.platform === 'darwin') {
        for (const p of getCommonMacOSPaths()) {
            if (isExecutable(p)) {
                sclangOutput?.appendLine(`[SuperCollider] Found sclang at: ${p}`);
                return p;
            }
        }
    }
    // Fallback: hope it's on PATH
    return configuredPath;
}
function getSclangPath() {
    return vscode_1.workspace.getConfiguration().get('envil.supercollider.sclang.cmd') || '/usr/bin/sclang';
}
function getSclangConf() {
    return vscode_1.workspace.getConfiguration().get('envil.supercollider.sclang.sclang_conf') || null;
}
// ── sclang process management ─────────────────────────────────────────────────
async function startSclang(fallbackToExe = true) {
    if (sclangProcess && !sclangProcess.killed) {
        sclangOutput.appendLine('[SuperCollider] sclang already running');
        return true;
    }
    const configuredPath = getSclangPath();
    const sclangPath = findSclangPath(configuredPath);
    if (!sclangPath) {
        const msg = `Could not find sclang at: ${configuredPath}. Check the 'envil.supercollider.sclang.cmd' setting.`;
        vscode_1.window.showErrorMessage(msg);
        sclangOutput.appendLine(`[SuperCollider] ${msg}`);
        return false;
    }
    const conf = getSclangConf();
    const args = ['-i', 'vscode'];
    if (conf) {
        const expanded = conf.replace(/^~/, process.env.HOME || '~');
        if (fs.existsSync(expanded)) {
            args.push('-l', expanded);
        }
        else {
            sclangOutput.appendLine(`[SuperCollider] sclang_conf not found, skipping: ${expanded}`);
        }
    }
    sclangOutput.appendLine(`[SuperCollider] Starting: ${sclangPath} ${args.join(' ')}`);
    try {
        const spawnProcess = (pathToSpawn, isFallback = false) => {
            const proc = (0, child_process_1.spawn)(pathToSpawn, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            proc.on('error', async (err) => {
                sclangOutput.appendLine(`[SuperCollider] Error spawning ${pathToSpawn}: ${err.message}`);
                // Linux/WSL fallback to sclang.exe
                if (pathToSpawn === 'sclang' && fallbackToExe && !isFallback &&
                    (process.platform === 'linux' || process.platform === 'win32')) {
                    sclangOutput.appendLine('[SuperCollider] Attempting fallback to sclang.exe...');
                    sclangProcess = spawnProcess('sclang.exe', true);
                    return;
                }
                // macOS fallback through common paths
                if (process.platform === 'darwin' && !isFallback) {
                    for (const p of getCommonMacOSPaths()) {
                        if (isExecutable(p) && p !== pathToSpawn) {
                            sclangOutput.appendLine(`[SuperCollider] Attempting fallback to: ${p}`);
                            sclangProcess = spawnProcess(p, true);
                            return;
                        }
                    }
                }
                let msg = `Failed to start sclang (${pathToSpawn}): ${err.message}.`;
                if (err.code === 'ENOENT') {
                    msg += ' Executable not found.';
                }
                msg += ' Check the envil.supercollider.sclang.cmd setting.';
                vscode_1.window.showErrorMessage(msg);
                sclangProcess = null;
            });
            proc.stdout?.on('data', (data) => {
                const text = data.toString();
                const filtered = filterMarkers(text);
                if (filtered)
                    postWindowOutput.append(filtered);
                for (const fn of stdoutListeners)
                    fn(text);
            });
            proc.stderr?.on('data', (data) => postWindowOutput.append(data.toString()));
            proc.on('exit', (code) => {
                sclangOutput.appendLine(`[SuperCollider] sclang exited with code ${code}`);
                sclangProcess = null;
            });
            return proc;
        };
        sclangProcess = spawnProcess(sclangPath);
        sclangOutput.appendLine('[SuperCollider] sclang process spawned, waiting for output...');
        postWindowOutput.show(true);
        return true;
    }
    catch (err) {
        sclangOutput.appendLine(`[SuperCollider] Failed to start sclang: ${err}`);
        vscode_1.window.showErrorMessage('Failed to start sclang. Check the sclang.cmd setting.');
        return false;
    }
}
function stopSclang() {
    if (sclangProcess && !sclangProcess.killed) {
        sclangOutput.appendLine('[SuperCollider] Stopping sclang...');
        sclangProcess.kill();
        sclangProcess = null;
        sclangOutput.appendLine('[SuperCollider] sclang stopped');
    }
}
// ── Code execution ────────────────────────────────────────────────────────────
async function executeCode(code) {
    if (!sclangProcess || sclangProcess.killed) {
        if (!(await startSclang()))
            return;
        // Wait for sclang to initialise before sending
        setTimeout(() => sendCode(code), 1000);
    }
    else {
        sendCode(code);
    }
}
function sendCode(code, silent = false) {
    if (!sclangProcess || !sclangProcess.stdin) {
        vscode_1.window.showErrorMessage('sclang is not running');
        return;
    }
    const cleanCode = code.trim();
    if (!cleanCode)
        return;
    // \x0c = kInterpretPrintCmdLine → prints "-> result" (SC IDE behaviour)
    // \x1b = kInterpretCmdLine     → silent, no output
    sclangProcess.stdin.write(cleanCode + (silent ? '\x1b' : '\x0c'));
    if (!silent) {
        postWindowOutput.show(true); // reveal SC Post Window, keep editor focus
    }
}
/**
 * Send SC code that prints a marker-delimited response and capture it.
 *
 * The SC code MUST print:  <marker>…payload…<marker>
 * We listen on stdout for the opening and closing markers and return
 * the text between them.  Returns null on timeout or if sclang isn't running.
 *
 * Uses \x1b (silent interpret) so the result doesn't clutter the Post Window
 * with a "-> …" echo line.
 */
function queryCode(scCode, marker, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (!sclangProcess || !sclangProcess.stdin) {
            resolve(null);
            return;
        }
        let buf = '';
        let resolved = false;
        const listener = (text) => {
            buf += text;
            const startIdx = buf.indexOf(marker);
            if (startIdx === -1)
                return;
            const payloadStart = startIdx + marker.length;
            const endIdx = buf.indexOf(marker, payloadStart);
            if (endIdx === -1)
                return; // haven't received closing marker yet
            cleanup();
            resolve(buf.substring(payloadStart, endIdx));
        };
        const cleanup = () => {
            if (resolved)
                return;
            resolved = true;
            const idx = stdoutListeners.indexOf(listener);
            if (idx !== -1)
                stdoutListeners.splice(idx, 1);
        };
        stdoutListeners.push(listener);
        sclangProcess.stdin.write(scCode + '\x1b');
        setTimeout(() => { cleanup(); if (!resolved)
            resolve(null); }, timeoutMs);
    });
}
// ── Block detection (ported from supercollider-vscode) ────────────────────────
/**
 * Returns a copy of `text` with the same length where every character that is
 * inside a line comment (//…), a block comment (/* … *\/, nestable in SC),
 * or a string literal ("…") is replaced with a space.
 * Newlines are preserved so that line-number calculations stay accurate.
 */
function stripCommentsAndStrings(text) {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        // Line comment  //
        if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
                out[i] = ' ';
                i++;
            }
        }
        // Block comment  /* … */  (SC allows nesting)
        else if (text[i] === '/' && text[i + 1] === '*') {
            let depth = 1;
            out[i] = ' ';
            out[i + 1] = ' ';
            i += 2;
            while (i < text.length && depth > 0) {
                if (text[i] === '/' && text[i + 1] === '*') {
                    out[i] = ' ';
                    out[i + 1] = ' ';
                    i += 2;
                    depth++;
                }
                else if (text[i] === '*' && text[i + 1] === '/') {
                    out[i] = ' ';
                    out[i + 1] = ' ';
                    i += 2;
                    depth--;
                }
                else {
                    if (text[i] !== '\n' && text[i] !== '\r')
                        out[i] = ' ';
                    i++;
                }
            }
        }
        // String literal  "…"
        else if (text[i] === '"') {
            out[i] = ' ';
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') {
                    out[i] = ' ';
                    i++;
                }
                if (i < text.length && text[i] !== '\n' && text[i] !== '\r')
                    out[i] = ' ';
                i++;
            }
            if (i < text.length) {
                out[i] = ' ';
                i++;
            }
        }
        // Single-quoted symbol/string  '…'  (SC allows multi-line symbols)
        // Skip if preceded by $ (e.g. $' is a Character literal, not a string)
        else if (text[i] === '\'' && (i === 0 || text[i - 1] !== '$')) {
            out[i] = ' ';
            i++;
            while (i < text.length && text[i] !== '\'') {
                if (text[i] === '\\') {
                    out[i] = ' ';
                    i++;
                }
                if (i < text.length && text[i] !== '\n' && text[i] !== '\r')
                    out[i] = ' ';
                i++;
            }
            if (i < text.length) {
                out[i] = ' ';
                i++;
            }
        }
        else {
            i++;
        }
    }
    return out.join('');
}
function findCodeBlock(document, position) {
    const text = document.getText();
    // Use a comment/string-stripped copy for all paren scanning so that
    // parens inside  // comments, /* */ comments, or "strings" are ignored.
    const stripped = stripCommentsAndStrings(text);
    const offset = document.offsetAt(position);
    const isStartOfLine = (index) => {
        for (let j = index - 1; j >= 0; j--) {
            const c = text[j];
            if (c === '\n' || c === '\r')
                return true;
            if (c === ' ' || c === '\t')
                continue;
            return false;
        }
        return true;
    };
    const findMatchingClosing = (startIndex) => {
        let depth = 0;
        for (let i = startIndex; i < stripped.length; i++) {
            if (stripped[i] === '(')
                depth++;
            else if (stripped[i] === ')') {
                depth--;
                if (depth === 0)
                    return i;
            }
        }
        return -1;
    };
    const isValidRegionEnd = (endIndex) => {
        for (let i = endIndex + 1; i < stripped.length; i++) {
            const c = stripped[i];
            if (c === ' ' || c === '\t')
                continue;
            return c === '\n' || c === '\r' || c === ';';
        }
        return true;
    };
    // Scan backwards from cursor, recording every valid enclosing block found.
    // We keep overwriting `result` so the last (outermost) block wins –
    // this matches standard SC IDE behaviour where the outermost ( at start
    // of a line is evaluated, not the innermost one.
    let depth = 0;
    let result = null;
    for (let i = offset; i >= 0; i--) {
        const c = stripped[i];
        if (c === ')') {
            depth++;
        }
        else if (c === '(') {
            depth--;
            if (isStartOfLine(i) && depth <= 0) {
                const closeIndex = findMatchingClosing(i);
                if (closeIndex !== -1 && isValidRegionEnd(closeIndex)) {
                    const closePos = document.positionAt(closeIndex);
                    if (closeIndex >= offset || closePos.line === position.line) {
                        // Valid enclosing block – keep scanning for an outer one.
                        result = text.substring(i, closeIndex + 1);
                    }
                }
            }
        }
    }
    return result ?? document.lineAt(position.line).text.trim();
}
async function executeBlock(editor) {
    const { document, selection } = editor;
    let code = selection.isEmpty
        ? (findCodeBlock(document, selection.active) ?? document.lineAt(selection.active.line).text)
        : document.getText(selection);
    const filePath = document.uri.fsPath;
    const prelude = (filePath && !filePath.startsWith('untitled'))
        ? `thisProcess.nowExecutingPath = ${JSON.stringify(filePath)};`
        : null;
    // Always wrap in ( … ) so that var declarations and multi-line blocks
    // are evaluated as a single SC block.
    // const wrappedCode = `(\n${code}\n)`;
    const wrappedCode = `${code}`;
    // If we have a prelude, send it as a separate message so `var` remains
    // the first statement in the evaluated block.
    if (prelude) {
        if (!sclangProcess || sclangProcess.killed) {
            if (!(await startSclang()))
                return;
            setTimeout(() => { sendCode(prelude, true); sendCode(wrappedCode); }, 1000);
            return;
        }
        sendCode(prelude, true); // silent: don't print -> /path/to/file
        sendCode(wrappedCode);
        return;
    }
    await executeCode(wrappedCode);
}
// ── Server helpers ────────────────────────────────────────────────────────────
async function bootServer() { await executeCode('s.boot;'); }
async function rebootServer() { await executeCode('s.reboot;'); }
async function killServer() { await executeCode('s.quit;'); }
async function stopAllSounds() { await executeCode('CmdPeriod.run;'); }
async function openHelpForCursor(editor) {
    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    const word = wordRange ? editor.document.getText(wordRange) : null;
    if (!word) {
        vscode_1.window.showInformationMessage('Place the cursor on a class or method name to look up its help.');
        return;
    }
    await executeCode(`HelpBrowser.openHelpFor("${word}");`);
}
//# sourceMappingURL=sc.js.map