"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openHelpForCursor = exports.stopAllSounds = exports.killServer = exports.rebootServer = exports.bootServer = exports.executeBlock = exports.findCodeBlock = exports.sendCode = exports.executeCode = exports.stopSclang = exports.startSclang = exports.isSclangRunning = exports.initOutputChannels = void 0;
const fs = require("fs");
const child_process_1 = require("child_process");
const vscode_1 = require("vscode");
let sclangProcess = null;
let sclangOutput;
let postWindowOutput;
function initOutputChannels() {
    if (!sclangOutput) {
        sclangOutput = vscode_1.window.createOutputChannel('SuperCollider');
    }
    if (!postWindowOutput) {
        postWindowOutput = vscode_1.window.createOutputChannel('SuperCollider Post Window');
    }
}
exports.initOutputChannels = initOutputChannels;
function isSclangRunning() {
    return sclangProcess !== null && !sclangProcess.killed;
}
exports.isSclangRunning = isSclangRunning;
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
            proc.stdout?.on('data', (data) => postWindowOutput.append(data.toString()));
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
exports.startSclang = startSclang;
function stopSclang() {
    if (sclangProcess && !sclangProcess.killed) {
        sclangOutput.appendLine('[SuperCollider] Stopping sclang...');
        sclangProcess.kill();
        sclangProcess = null;
        sclangOutput.appendLine('[SuperCollider] sclang stopped');
    }
}
exports.stopSclang = stopSclang;
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
exports.executeCode = executeCode;
function sendCode(code) {
    if (!sclangProcess || !sclangProcess.stdin) {
        vscode_1.window.showErrorMessage('sclang is not running');
        return;
    }
    const cleanCode = code.trim();
    if (!cleanCode)
        return;
    postWindowOutput.appendLine(`\n-> ${cleanCode.split('\n')[0]}${cleanCode.includes('\n') ? '...' : ''}`);
    sclangProcess.stdin.write(cleanCode + '\x1b');
}
exports.sendCode = sendCode;
// ── Block detection (ported from supercollider-vscode) ────────────────────────
function findCodeBlock(document, position) {
    const text = document.getText();
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
        for (let i = startIndex; i < text.length; i++) {
            if (text[i] === '(')
                depth++;
            else if (text[i] === ')') {
                depth--;
                if (depth === 0)
                    return i;
            }
        }
        return -1;
    };
    const isValidRegionEnd = (endIndex) => {
        for (let i = endIndex + 1; i < text.length; i++) {
            const c = text[i];
            if (c === ' ' || c === '\t')
                continue;
            return c === '\n' || c === '\r' || c === ';';
        }
        return true;
    };
    let depth = 0;
    for (let i = offset; i >= 0; i--) {
        const c = text[i];
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
                        return text.substring(i, closeIndex + 1);
                    }
                }
            }
        }
    }
    return document.lineAt(position.line).text.trim();
}
exports.findCodeBlock = findCodeBlock;
async function executeBlock(editor) {
    const { document, selection } = editor;
    const code = selection.isEmpty
        ? (findCodeBlock(document, selection.active) ?? document.lineAt(selection.active.line).text)
        : document.getText(selection);
    await executeCode(code);
}
exports.executeBlock = executeBlock;
// ── Server helpers ────────────────────────────────────────────────────────────
async function bootServer() { await executeCode('s.boot;'); }
exports.bootServer = bootServer;
async function rebootServer() { await executeCode('s.reboot;'); }
exports.rebootServer = rebootServer;
async function killServer() { await executeCode('s.quit;'); }
exports.killServer = killServer;
async function stopAllSounds() { await executeCode('CmdPeriod.run;'); }
exports.stopAllSounds = stopAllSounds;
async function openHelpForCursor(editor) {
    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    const word = wordRange ? editor.document.getText(wordRange) : null;
    if (!word) {
        vscode_1.window.showInformationMessage('Place the cursor on a class or method name to look up its help.');
        return;
    }
    await executeCode(`HelpBrowser.openHelpFor("${word}");`);
}
exports.openHelpForCursor = openHelpForCursor;
//# sourceMappingURL=sc.js.map