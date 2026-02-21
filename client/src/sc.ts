import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import {
    window,
    workspace,
    OutputChannel,
    TextEditor,
    TextDocument,
    Position,
} from 'vscode';

let sclangProcess: ChildProcess | null = null;
let sclangOutput: OutputChannel;
let postWindowOutput: OutputChannel;

export function initOutputChannels(): void {
    if (!sclangOutput) {
        sclangOutput = window.createOutputChannel('SuperCollider');
    }
    if (!postWindowOutput) {
        postWindowOutput = window.createOutputChannel('SuperCollider Post Window');
    }
}

export function isSclangRunning(): boolean {
    return sclangProcess !== null && !sclangProcess.killed;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function getCommonMacOSPaths(): string[] {
    return [
        '/Applications/SuperCollider.app/Contents/Resources/sclang',
        '/Applications/SuperCollider.app/Contents/MacOS/sclang',
        '/usr/local/bin/sclang',
        '/opt/homebrew/bin/sclang',
        '/usr/bin/sclang',
    ];
}

function isExecutable(filePath: string): boolean {
    try {
        const stats = fs.statSync(filePath);
        return stats.isFile() && (stats.mode & fs.constants.S_IXUSR) !== 0;
    } catch {
        return false;
    }
}

function findSclangPath(configuredPath: string): string | null {
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

function getSclangPath(): string {
    return workspace.getConfiguration().get<string>('envil.supercollider.sclang.cmd') || '/usr/bin/sclang';
}

function getSclangConf(): string | null {
    return workspace.getConfiguration().get<string>('envil.supercollider.sclang.sclang_conf') || null;
}

// ── sclang process management ─────────────────────────────────────────────────

export async function startSclang(fallbackToExe = true): Promise<boolean> {
    if (sclangProcess && !sclangProcess.killed) {
        sclangOutput.appendLine('[SuperCollider] sclang already running');
        return true;
    }

    const configuredPath = getSclangPath();
    const sclangPath = findSclangPath(configuredPath);

    if (!sclangPath) {
        const msg = `Could not find sclang at: ${configuredPath}. Check the 'envil.supercollider.sclang.cmd' setting.`;
        window.showErrorMessage(msg);
        sclangOutput.appendLine(`[SuperCollider] ${msg}`);
        return false;
    }

    const conf = getSclangConf();
    const args = ['-i', 'vscode'];
    if (conf) {
        const expanded = conf.replace(/^~/, process.env.HOME || '~');
        if (fs.existsSync(expanded)) {
            args.push('-l', expanded);
        } else {
            sclangOutput.appendLine(`[SuperCollider] sclang_conf not found, skipping: ${expanded}`);
        }
    }

    sclangOutput.appendLine(`[SuperCollider] Starting: ${sclangPath} ${args.join(' ')}`);

    try {
        const spawnProcess = (pathToSpawn: string, isFallback = false): ChildProcess => {
            const proc = spawn(pathToSpawn, args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    msg += ' Executable not found.';
                }
                msg += ' Check the envil.supercollider.sclang.cmd setting.';
                window.showErrorMessage(msg);
                sclangProcess = null;
            });

            proc.stdout?.on('data', (data: Buffer) => postWindowOutput.append(data.toString()));
            proc.stderr?.on('data', (data: Buffer) => postWindowOutput.append(data.toString()));

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
    } catch (err) {
        sclangOutput.appendLine(`[SuperCollider] Failed to start sclang: ${err}`);
        window.showErrorMessage('Failed to start sclang. Check the sclang.cmd setting.');
        return false;
    }
}

export function stopSclang(): void {
    if (sclangProcess && !sclangProcess.killed) {
        sclangOutput.appendLine('[SuperCollider] Stopping sclang...');
        sclangProcess.kill();
        sclangProcess = null;
        sclangOutput.appendLine('[SuperCollider] sclang stopped');
    }
}

// ── Code execution ────────────────────────────────────────────────────────────

export async function executeCode(code: string): Promise<void> {
    if (!sclangProcess || sclangProcess.killed) {
        if (!(await startSclang())) return;
        // Wait for sclang to initialise before sending
        setTimeout(() => sendCode(code), 1000);
    } else {
        sendCode(code);
    }
}

export function sendCode(code: string): void {
    if (!sclangProcess || !sclangProcess.stdin) {
        window.showErrorMessage('sclang is not running');
        return;
    }
    const cleanCode = code.trim();
    if (!cleanCode) return;
    postWindowOutput.appendLine(`\n-> ${cleanCode.split('\n')[0]}${cleanCode.includes('\n') ? '...' : ''}`);
    sclangProcess.stdin.write(cleanCode + '\x1b');
}

// ── Block detection (ported from supercollider-vscode) ────────────────────────

export function findCodeBlock(document: TextDocument, position: Position): string | null {
    const text = document.getText();
    const offset = document.offsetAt(position);

    const isStartOfLine = (index: number): boolean => {
        for (let j = index - 1; j >= 0; j--) {
            const c = text[j];
            if (c === '\n' || c === '\r') return true;
            if (c === ' ' || c === '\t') continue;
            return false;
        }
        return true;
    };

    const findMatchingClosing = (startIndex: number): number => {
        let depth = 0;
        for (let i = startIndex; i < text.length; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') { depth--; if (depth === 0) return i; }
        }
        return -1;
    };

    const isValidRegionEnd = (endIndex: number): boolean => {
        for (let i = endIndex + 1; i < text.length; i++) {
            const c = text[i];
            if (c === ' ' || c === '\t') continue;
            return c === '\n' || c === '\r' || c === ';';
        }
        return true;
    };

    let depth = 0;
    for (let i = offset; i >= 0; i--) {
        const c = text[i];
        if (c === ')') {
            depth++;
        } else if (c === '(') {
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

export async function executeBlock(editor: TextEditor): Promise<void> {
    const { document, selection } = editor;
    const code = selection.isEmpty
        ? (findCodeBlock(document, selection.active) ?? document.lineAt(selection.active.line).text)
        : document.getText(selection);
    await executeCode(code);
}

// ── Server helpers ────────────────────────────────────────────────────────────

export async function bootServer(): Promise<void>    { await executeCode('s.boot;'); }
export async function rebootServer(): Promise<void>  { await executeCode('s.reboot;'); }
export async function killServer(): Promise<void>    { await executeCode('s.quit;'); }
export async function stopAllSounds(): Promise<void> { await executeCode('CmdPeriod.run;'); }

export async function openHelpForCursor(editor: TextEditor): Promise<void> {
    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    const word = wordRange ? editor.document.getText(wordRange) : null;
    if (!word) {
        window.showInformationMessage('Place the cursor on a class or method name to look up its help.');
        return;
    }
    await executeCode(`HelpBrowser.openHelpFor("${word}");`);
}
