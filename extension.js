// @ts-nocheck
const vscode = require('vscode');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const jsonc = require('jsonc-parser');
const { isEnvironmentActive, envilEnvironmentContextKey } = require('./supercollider/util');
const { registerHydraProviders } = require('./hydra-language-support');
const { registerHoverSlider } = require('./hover-slider');
const { registerBlockCodeLens, CMD_RUN_SC_BLOCK, CMD_RUN_HYDRA_BLOCK } = require('./codelens-blocks');
const { extractExpressions } = require('./peek-expressions');
const { registerTouchKnobs } = require('./touch-knobs');
const { registerProxyCompletions } = require('./proxy-completions');
const scBridge = require('./sc-bridge');
const osc = require('osc');

// SC + LSP modules are loaded lazily so a compile error never blocks activation
let _sc = null;
let _lsp = null;

function getSC() {
    if (!_sc) {
        const out = path.join(__dirname, 'client', 'out', 'sc.js');
        if (!fs.existsSync(out)) {
            vscode.window.showErrorMessage('[envil] SC module not compiled. Run "npm run compile" in envil-merged/.');
            return null;
        }
        _sc = require(out);
        _sc.initOutputChannels();
    }
    return _sc;
}

// ── Module-level state ────────────────────────────────────────────────────────

let app = null;
let server = null;
let io = null;
let isLoadingCompleted = false;
let oscPort = null;

// Status bar items
let sclangStatusBar = null;
let scsynthStatusBar = null;
let _isSCSynthRunning = false;

// Hydra output channel
let hydraOutput = null;

// ── Activate ─────────────────────────────────────────────────────────────────

async function activate(context) {
    console.log('[envil] Activating...');

    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;

    // Status bar
    sclangStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    sclangStatusBar.command = 'envil.supercollider.toggleSCLang';
    sclangStatusBar.tooltip = 'Click to start/stop SuperCollider interpreter';
    scsynthStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    scsynthStatusBar.command = 'envil.supercollider.toggleSCSynth';
    scsynthStatusBar.tooltip = 'Click to boot/quit the SuperCollider server';
    updateSclangBar(false);
    updateScsynthBar(false);
    context.subscriptions.push(sclangStatusBar, scsynthStatusBar);

    // Hydra output channel
    if (!hydraOutput) {
        hydraOutput = vscode.window.createOutputChannel('Hydra');
        context.subscriptions.push(hydraOutput);
    }

    // Restore environment if it was previously active
    const isEnvActive = vscode.workspace.getConfiguration().get(envilEnvironmentContextKey) || false;
    if (isEnvActive) {
        showNotification('Loading ENVIL environment ...');
        startServersAndSockets(workspaceFolder);
        sclangStatusBar.show();
        scsynthStatusBar.show();
    }

    // ── SuperCollider commands (implementations from client/out/sc.js) ────────

    context.subscriptions.push(

        vscode.commands.registerTextEditorCommand('envil.supercollider.executeBlock', async (editor) => {
            const sc = getSC(); if (!sc) return;
            await sc.executeBlock(editor);
        }),

        vscode.commands.registerCommand('envil.supercollider.startSCLang', async () => {
            const sc = getSC(); if (!sc) return;
            const ok = await sc.startSclang();
            if (ok) {
                updateSclangBar(true);
                startScsynthHeartbeat();
                // Auto-detect a running scsynth left over from a previous session
                const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
                sc.probeRunningServer(autoInit).then(found => {
                    if (found) {
                        _isSCSynthRunning = true;
                        updateScsynthBar(true);
                    }
                });
            }
        }),

        vscode.commands.registerCommand('envil.supercollider.stopSCLang', () => {
            const sc = getSC(); if (!sc) return;
            sc.stopSclang();
            updateSclangBar(false);
            updateScsynthBar(false);
            _isSCSynthRunning = false;
        }),

        vscode.commands.registerCommand('envil.supercollider.toggleSCLang', async () => {
            const sc = getSC(); if (!sc) return;
            if (sc.isSclangRunning()) {
                await vscode.commands.executeCommand('envil.supercollider.stopSCLang');
            } else {
                await vscode.commands.executeCommand('envil.supercollider.startSCLang');
            }
        }),

        vscode.commands.registerCommand('envil.supercollider.startSCSynth', async () => {
            const sc = getSC(); if (!sc) return;
            const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
            if (autoInit) {
                // ProxySpace.push MUST be at top level (main interpreter thread).
                // s.waitForBoot runs on AppClock — push there only affects that thread.
                await sc.executeCode([
                    'if(currentEnvironment.isKindOf(ProxySpace).not, {',
                    '  p = ProxySpace.push(s);',
                    '  ~out.ar(2);',
                    '  "[envil] ProxySpace pushed.".postln;',
                    '});',
                    's.waitForBoot {',
                    '  ~out.play;',
                    '  "[envil] ProxySpace ready.  ~out.ar(2).play".postln;',
                    '};',
                ].join('\n'));
            } else {
                await sc.bootServer();
            }
            _isSCSynthRunning = true;
            updateScsynthBar(true);
        }),

        vscode.commands.registerCommand('envil.supercollider.stopSCSynth', async () => {
            const sc = getSC(); if (!sc) return;
            await sc.killServer();
            _isSCSynthRunning = false;
            updateScsynthBar(false);
        }),

        vscode.commands.registerCommand('envil.supercollider.toggleSCSynth', async () => {
            if (_isSCSynthRunning) {
                await vscode.commands.executeCommand('envil.supercollider.stopSCSynth');
            } else {
                await vscode.commands.executeCommand('envil.supercollider.startSCSynth');
            }
        }),

        vscode.commands.registerCommand('envil.supercollider.rebootServer', async () => {
            const sc = getSC(); if (!sc) return;
            const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
            if (autoInit) {
                await sc.executeCode([
                    's.reboot;',
                    'if(currentEnvironment.isKindOf(ProxySpace).not, {',
                    '  p = ProxySpace.push(s);',
                    '  ~out.ar(2);',
                    '  "[envil] ProxySpace pushed.".postln;',
                    '});',
                    's.waitForBoot {',
                    '  ~out.play;',
                    '  "[envil] ProxySpace ready.  ~out.ar(2).play".postln;',
                    '};',
                ].join('\n'));
            } else {
                await sc.rebootServer();
            }
        }),

        vscode.commands.registerCommand('envil.supercollider.hush', async () => {
            const sc = getSC(); if (!sc) return;
            await sc.stopAllSounds();
        }),

        vscode.commands.registerTextEditorCommand('envil.supercollider.openHelpFor', async (editor) => {
            const sc = getSC(); if (!sc) return;
            await sc.openHelpForCursor(editor);
        }),

        vscode.commands.registerCommand('envil.supercollider.search', () => {
            const panel = vscode.window.createWebviewPanel(
                'supercolliderSearch', 'SuperCollider Search',
                vscode.ViewColumn.Beside, { enableScripts: true }
            );
            panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<style>body,html{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
iframe{width:100%;height:100%;border:none}</style></head>
<body><iframe src="https://docs.supercollider.online/Search.html"></iframe></body></html>`;
        })
    );

    // ── LSP client (hover + completion) ──────────────────────────────────────

    try {
        const lspOut = path.join(__dirname, 'client', 'out', 'lsp.js');
        if (fs.existsSync(lspOut)) {
            _lsp = require(lspOut);
            _lsp.startClient(context);
        } else {
            console.warn('[envil] LSP client not compiled – hover/completion unavailable.');
        }
    } catch (err) {
        console.error('[envil] LSP client failed to start:', err);
    }

    // ── Hydra language providers (hover, completion, signature help) ──────────
    registerHydraProviders(context);

    // ── SCIDE-style bracket selection ────────────────────────────────────────
    //
    // Double-clicking on any bracket in a SuperCollider file selects the full
    // content between the bracket pair, brackets included – exactly as SCIDE does.
    //
    // The same behaviour is also available as an explicit command bound to
    // Ctrl+Shift+B (Cmd+Shift+B on Mac) for keyboard-driven workflows.

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            // Only react to mouse-driven selection changes
            if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
            const editor = e.textEditor;
            if (editor.document.languageId !== 'supercollider') return;

            // A double-click on a non-word character (like a bracket) produces
            // a single-character selection.  Nothing to do for multi-char
            // selections – those are already meaningful user selections.
            if (e.selections.length !== 1) return;
            const sel = e.selections[0];
            if (sel.isEmpty) return;
            const selectedText = editor.document.getText(sel);
            if (selectedText.length !== 1) return;

            const OPEN  = '([{';
            const CLOSE = ')]}';
            if (!OPEN.includes(selectedText) && !CLOSE.includes(selectedText)) return;

            // Temporarily move the cursor to the clicked bracket so
            // buildBracketSelection can resolve it via the active position.
            editor.selection = new vscode.Selection(sel.start, sel.start);
            const expanded = buildBracketSelection(editor);
            if (expanded) editor.selection = expanded;
        }),

        vscode.commands.registerTextEditorCommand(
            'envil.supercollider.selectBracketBlock',
            (editor) => {
                // If there is already a selection, try to expand to the next
                // enclosing bracket pair; otherwise use the cursor position.
                const expanded = buildBracketSelection(editor);
                if (expanded) editor.selection = expanded;
            }
        )
    );

    // ── Signature help on cursor rest ─────────────────────────────────────────
    //
    // Fires editor.action.triggerParameterHints whenever the cursor is resting
    // inside a known Class.method( call in a SuperCollider file, so you don't
    // have to type '(' or ',' to see the argument tooltip.

    let _sigHelpTimer = null;
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor.document.languageId !== 'supercollider') return;
            if (!e.selections[0].isEmpty) return;           // ignore real selections

            // Debounce: only fire after the cursor has been still for 200 ms
            if (_sigHelpTimer) clearTimeout(_sigHelpTimer);
            _sigHelpTimer = setTimeout(() => {
                _sigHelpTimer = null;
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.languageId !== 'supercollider') return;

                const doc    = editor.document;
                const offset = doc.offsetAt(editor.selection.active);
                const text   = doc.getText();

                // Walk backwards to find an unmatched '(' that is preceded by
                // a word character — i.e. a method/constructor call open paren.
                let depth = 0;
                for (let i = offset - 1; i >= 0; i--) {
                    const ch = text[i];
                    if (ch === ')' || ch === ']' || ch === '}') { depth++; }
                    else if (ch === '[' || ch === '{') { if (depth) depth--; else break; }
                    else if (ch === '(') {
                        if (depth > 0) { depth--; continue; }
                        // We found the unmatched '(' – check there's a word before it
                        const before = text.substring(Math.max(0, i - 1), i);
                        if (/\w/.test(before)) {
                            vscode.commands.executeCommand('editor.action.triggerParameterHints');
                        }
                        break;
                    }
                }
            }, 200);
        })
    );

    // ── Signature help auto-trigger for Hydra (JS files) ──────────────────────
    //
    // Same debounced cursor-rest approach as the SC block above, but for
    // JavaScript files so Hydra argument tooltips appear automatically.

    let _hydraSignHelpTimer = null;
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            if (e.textEditor.document.languageId !== 'javascript') return;
            if (!e.selections[0].isEmpty) return;

            if (_hydraSignHelpTimer) clearTimeout(_hydraSignHelpTimer);
            _hydraSignHelpTimer = setTimeout(() => {
                _hydraSignHelpTimer = null;
                const editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.languageId !== 'javascript') return;

                const doc    = editor.document;
                const offset = doc.offsetAt(editor.selection.active);
                const text   = doc.getText();

                let depth = 0;
                for (let i = offset - 1; i >= 0; i--) {
                    const ch = text[i];
                    if (ch === ')') { depth++; }
                    else if (ch === '(') {
                        if (depth > 0) { depth--; continue; }
                        const before = text.substring(Math.max(0, i - 1), i);
                        if (/\w/.test(before)) {
                            vscode.commands.executeCommand('editor.action.triggerParameterHints');
                        }
                        break;
                    } else if (ch === '\n' && depth === 0) {
                        break;
                    }
                }
            }, 400);
        })
    );

    // ── Environment commands (Hydra / settings) ───────────────────────────────

    const openEnvironmentCommand = vscode.commands.registerCommand('envil.start', async () => {
        try {
            showNotification('Loading ENVIL environment ...');
            await updateCustomPropertyInSettings(true);

            if (workspaceFolder) {
                const wsPath = path.join(workspaceFolder, '.vscode', 'settings.json');
                await createSettingsFileIfNotExist(wsPath);
                const wsSettings = readJsonWithComments(path.join(__dirname, 'data', 'workspace_settings.json')).json;
                await updateUserSettings(wsSettings, false, vscode.ConfigurationTarget.Workspace);
            }
            const globalSettings = readJsonWithComments(path.join(__dirname, 'data', 'global_settings.json')).json;
            await updateUserSettings(globalSettings, false, vscode.ConfigurationTarget.Global);

            const alreadyActivated = context.globalState.get('HasEnvilExtensionAlreadyBeenActivated') || false;
            if (!alreadyActivated) {
                context.globalState.update('HasEnvilExtensionAlreadyBeenActivated', true);
                vscode.workspace.getConfiguration().update('custom-ui-style.reloadWithoutPrompting', true, vscode.ConfigurationTarget.Global);
            }

            startServersAndSockets(workspaceFolder);
            sclangStatusBar.show();
            scsynthStatusBar.show();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load environment: ${error.message}`);
        } finally {
            isLoadingCompleted = true;
        }
    });

    const closeEnvironmentCommand = vscode.commands.registerCommand('envil.stop', async () => {
        try {
            showNotification('Closing ENVIL environment ...');
            closeServersAndSockets();
            await updateCustomPropertyInSettings(false);

            if (workspaceFolder) {
                const wsSettings = readJsonWithComments(path.join(__dirname, 'data', 'workspace_settings.json')).json;
                await updateUserSettings(wsSettings, true, vscode.ConfigurationTarget.Workspace);
            }
            const globalSettings = readJsonWithComments(path.join(__dirname, 'data', 'global_settings.json')).json;
            await updateUserSettings(globalSettings, true, vscode.ConfigurationTarget.Global);

            sclangStatusBar.hide();
            scsynthStatusBar.hide();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to close the environment: ${error.message}`);
        } finally {
            isLoadingCompleted = true;
        }
    });

    const evaluateHydraCommand = vscode.commands.registerCommand('envil.hydra.evaluate', () => {
        if (!isEnvironmentActive()) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        let text = editor.document.getText(selection.isEmpty ? undefined : selection);
        let command = '';
        let sentCount = 0;

        for (const currentLine of text.split('\n')) {
            let line = currentLine;
            if (line.trimStart().startsWith('//')) line = '';
            if (line.includes('local/files/')) {
                line = line.replace('local/files/', 'http://localhost:3000/files/');
            }
            if (line !== '') {
                command += line;
                if (line.trimEnd().endsWith(';')) {
                    io.sockets.emit('new-command', { data: command });
                    if (hydraOutput) {
                        hydraOutput.appendLine(`▶ ${command}`);
                    }
                    command = '';
                    sentCount++;
                }
            }
        }

        if (hydraOutput) {
            if (sentCount > 0) {
                hydraOutput.appendLine(`  ✓ sent ${sentCount} statement${sentCount > 1 ? 's' : ''} to Hydra`);
                // ── Peek: extract arrow-function expressions and send to browser ──
                try {
                    const exprs = extractExpressions(text);
                    if (exprs.length > 0 && io) {
                        io.sockets.emit('monitor-expressions', { expressions: exprs });
                        hydraOutput.appendLine(`  👁 peek: monitoring ${exprs.length} expression${exprs.length > 1 ? 's' : ''} — ${exprs.map(e => e.label).join(', ')}`);
                    }
                } catch (e) {
                    console.warn('[envil] peek extraction error:', e);
                }
            } else {
                hydraOutput.appendLine('  ⚠ nothing to evaluate (no semicolons found)');
            }
            hydraOutput.show(true); // reveal Hydra output, keep editor focus
        }
    });

    // ── Peek toggle command ───────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('envil.peekToggle', () => {
            if (!isEnvironmentActive() || !io) return;
            io.sockets.emit('peek-toggle');
            if (hydraOutput) hydraOutput.appendLine('  👁 peek overlay toggled');
        }),
        vscode.commands.registerCommand('envil.peekClear', () => {
            if (!isEnvironmentActive() || !io) return;
            io.sockets.emit('peek-clear');
            if (hydraOutput) hydraOutput.appendLine('  👁 peek cleared');
        })
    );

    // AI inline-suggestion trigger with feedback
    const triggerAISuggest = vscode.commands.registerCommand('envil.triggerAISuggest', async () => {
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        // Small delay to check if a suggestion appeared
        setTimeout(() => {
            if (hydraOutput) {
                hydraOutput.appendLine('  ⓘ AI inline suggestion triggered (Alt+I)');
            }
        }, 200);
    });

    context.subscriptions.push(openEnvironmentCommand, closeEnvironmentCommand, evaluateHydraCommand, triggerAISuggest);

    // Interactive hover-slider for number literals (Hydra + SuperCollider)
    registerHoverSlider(context);

    // Clickable ▶ Run / ▶ Eval buttons above code blocks
    registerBlockCodeLens(context);

    // Touch knobs — draggable XY controllers → SC proxyspace
    const touchKnobsAutoOpen = vscode.workspace.getConfiguration('envil').get('touchKnobs.autoOpen', true);
    registerTouchKnobs(context, {
        getSC,
        getIO: () => io,
        hydraOutput,
        extensionPath: context.extensionPath,
        autoOpen: touchKnobsAutoOpen,
    });

    // ProxySpace autocompletion — ~proxy suggestions from live sclang
    registerProxyCompletions(context, { getSC });

    // SC→Hydra proxy bridge — polls scsynth buses, forwards to browser
    scBridge.initBridge({
        getSC,
        getIO: () => io,
        log: (msg) => { if (hydraOutput) hydraOutput.appendLine(msg); },
    });

    context.subscriptions.push(
        // Watch a SC proxy:  user types proxy name in quick-pick
        vscode.commands.registerCommand('envil.scBridge.watch', async () => {
            const name = await vscode.window.showInputBox({
                prompt: 'SC proxy name to watch (without ~)',
                placeHolder: 'out',
            });
            if (!name) return;
            const ok = await scBridge.watchProxy(name.trim());
            if (ok) {
                vscode.window.showInformationMessage(`sc-bridge: watching ~${name.trim()}`);
            } else {
                vscode.window.showWarningMessage(`sc-bridge: could not resolve ~${name.trim()} (no bus?)`);
            }
        }),
        vscode.commands.registerCommand('envil.scBridge.unwatch', async () => {
            const names = scBridge.getWatchedNames();
            if (names.length === 0) {
                vscode.window.showInformationMessage('sc-bridge: no proxies being watched');
                return;
            }
            const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Proxy to stop watching' });
            if (pick) scBridge.unwatchProxy(pick);
        }),
        vscode.commands.registerCommand('envil.scBridge.refresh', async () => {
            await scBridge.refreshAll();
            vscode.window.showInformationMessage('sc-bridge: refreshed all proxy bus indices');
        }),
    );

    // SC block command — sends code directly to sclang
    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_RUN_SC_BLOCK, async (blockCode) => {
            const sc = getSC();
            if (!sc) return;
            if (!sc.isSclangRunning()) {
                vscode.window.showWarningMessage('sclang is not running. Start it first.');
                return;
            }
            sc.sendCode(blockCode);
        })
    );

    // Hydra block command — sends code via socket.io (same as Ctrl+Enter)
    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_RUN_HYDRA_BLOCK, (blockCode) => {
            if (!isEnvironmentActive() || !io) return;

            let command = '';
            let sentCount = 0;

            for (const currentLine of blockCode.split('\n')) {
                let line = currentLine;
                if (line.trimStart().startsWith('//')) line = '';
                if (line.includes('local/files/')) {
                    line = line.replace('local/files/', 'http://localhost:3000/files/');
                }
                if (line !== '') {
                    command += line;
                    if (line.trimEnd().endsWith(';')) {
                        io.sockets.emit('new-command', { data: command });
                        if (hydraOutput) hydraOutput.appendLine(`▶ ${command}`);
                        command = '';
                        sentCount++;
                    }
                }
            }

            if (hydraOutput) {
                if (sentCount > 0) {
                    hydraOutput.appendLine(`  ✓ sent ${sentCount} statement${sentCount > 1 ? 's' : ''} to Hydra (CodeLens)`);
                    // ── Peek: extract arrow-function expressions and send to browser ──
                    try {
                        const exprs = extractExpressions(blockCode);
                        if (exprs.length > 0 && io) {
                            io.sockets.emit('monitor-expressions', { expressions: exprs });
                            hydraOutput.appendLine(`  👁 peek: monitoring ${exprs.length} expression${exprs.length > 1 ? 's' : ''} — ${exprs.map(e => e.label).join(', ')}`);
                        }
                    } catch (e) {
                        console.warn('[envil] peek extraction error:', e);
                    }
                } else {
                    hydraOutput.appendLine('  ⚠ nothing to evaluate');
                }
                hydraOutput.show(true);
            }
        })
    );

    console.log('[envil] Activated successfully!');
}

// ── Deactivate ────────────────────────────────────────────────────────────────

async function deactivate() {
    console.log('[envil] Deactivating...');

    if (_lsp) {
        await _lsp.stopClient();
        _lsp = null;
    }
    if (_sc) {
        _sc.stopSclang();
        _sc = null;
    }

    closeServersAndSockets();
    scBridge.dispose();
    await updateCustomPropertyInSettings(undefined);

    const currentWorkspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
    if (currentWorkspaceFolder) {
        const wsSettings = readJsonWithComments(path.join(__dirname, 'data', 'workspace_settings.json')).json;
        await updateUserSettings(wsSettings, true, vscode.ConfigurationTarget.Workspace);
    }
    const globalSettings = readJsonWithComments(path.join(__dirname, 'data', 'global_settings.json')).json;
    await updateUserSettings(globalSettings, true, vscode.ConfigurationTarget.Global);

    const config = vscode.workspace.getConfiguration();
    config.update('custom-ui-style.reloadWithoutPrompting', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('custom-ui-style.rollback');

    console.log('[envil] Deactivated.');
}

// ── Status bar helpers ────────────────────────────────────────────────────────

function updateSclangBar(running) {
    if (!sclangStatusBar) return;
    sclangStatusBar.text = running ? 'sclang 🟢' : 'sclang ⭕';
}

function updateScsynthBar(running) {
    if (!scsynthStatusBar) return;
    scsynthStatusBar.text = running ? 'scsynth 🟢' : 'scsynth ⭕';
}

// ── sclang exit + scsynth heartbeat ───────────────────────────────────────────

let _sclangExitRegistered = false;
let _heartbeatTimer = null;

function registerSclangExitCallback() {
    if (_sclangExitRegistered) return;
    const sc = getSC();
    if (!sc || !sc.onSclangExit) return;
    sc.onSclangExit((_code) => {
        updateSclangBar(false);
        _isSCSynthRunning = false;
        updateScsynthBar(false);
        stopScsynthHeartbeat();
    });
    _sclangExitRegistered = true;
}

function startScsynthHeartbeat() {
    registerSclangExitCallback();
    stopScsynthHeartbeat();
    // Poll every 5 seconds — lightweight: one queryCode round-trip
    _heartbeatTimer = setInterval(async () => {
        const sc = getSC();
        if (!sc || !sc.isSclangRunning()) {
            stopScsynthHeartbeat();
            return;
        }
        const running = await sc.checkServerRunning();
        if (running !== _isSCSynthRunning) {
            _isSCSynthRunning = running;
            updateScsynthBar(running);
        }
    }, 5000);
}

function stopScsynthHeartbeat() {
    if (_heartbeatTimer) {
        clearInterval(_heartbeatTimer);
        _heartbeatTimer = null;
    }
}

// ── Server / socket helpers (unchanged from envil) ────────────────────────────

function closeServersAndSockets() {
    if (io) { io.close(); io = null; }
    if (server) { server.close(); server = null; }
    if (oscPort) { oscPort.close(); oscPort = null; }
}

function startServersAndSockets(workspaceFolder) {
    if (app || server || io || oscPort) closeServersAndSockets();

    app = express();
    server = app.listen(3000, async () => {
        console.log('[envil] Express running at http://localhost:3000');
        vscode.env.openExternal(vscode.Uri.parse('http://localhost:3000'));
    });
    io = new Server(3001, { cors: { origin: '*' } });
    io.on('connection', (socket) => {
        console.log('[envil] Socket.io: client connected');
        if (hydraOutput) hydraOutput.appendLine('── Hydra browser connected ──');
        socket.on('disconnect', () => {
            console.log('[envil] Socket.io: client disconnected');
            if (hydraOutput) hydraOutput.appendLine('── Hydra browser disconnected ──');
        });
        socket.on('eval-result', (msg) => {
            if (hydraOutput && msg && msg.data) {
                hydraOutput.appendLine(`  ✓ ${msg.data}`);
            }
        });
        socket.on('eval-error', (msg) => {
            if (hydraOutput && msg && msg.data) {
                hydraOutput.appendLine(`  ✖ ERROR: ${msg.data}`);
                if (msg.code) {
                    hydraOutput.appendLine(`    ↳ in: ${msg.code}`);
                }
                hydraOutput.show(true);
            }
        });
        socket.on('runtime-error', (msg) => {
            if (hydraOutput && msg && msg.data) {
                hydraOutput.appendLine(`  ⚠ RUNTIME ERROR: ${msg.data}`);
                if (msg.source && msg.line) {
                    hydraOutput.appendLine(`    ↳ at ${msg.source}:${msg.line}:${msg.col}`);
                }
                hydraOutput.show(true);
            }
        });
    });

    oscPort = new osc.UDPPort({ localAddress: 'localhost', localPort: 3002 });
    oscPort.open();
    oscPort.on('message', (oscMsg) => {
        if (io) io.sockets.emit('new-command', { data: oscMsg.args[0] });
    });

    app.use(express.static(path.join(__dirname, 'hydra')));
    app.use('/files', express.static(path.join(__dirname, 'local', 'files')));

    isLoadingCompleted = true;
}

// ── Settings helpers (unchanged from envil) ───────────────────────────────────

async function createSettingsFileIfNotExist(settingsPath) {
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(settingsPath)) fs.writeFileSync(settingsPath, JSON.stringify({}, null, 4));
}

function readJsonWithComments(filePath) {
    const errors = [];
    const json = jsonc.parse(fs.readFileSync(filePath, 'utf-8'), errors);
    if (errors.length) { console.error('[envil] JSON parse errors:', errors); return null; }
    return { json };
}

async function updateUserSettings(updates, deleteSettings, configurationTarget) {
    const config = vscode.workspace.getConfiguration();
    for (const [key, value] of Object.entries(updates)) {
        config.update(key, deleteSettings ? undefined : value, configurationTarget);
    }
}

async function updateCustomPropertyInSettings(value) {
    vscode.workspace.getConfiguration().update(envilEnvironmentContextKey, value, vscode.ConfigurationTarget.Global);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function checkLoadingCompletion() {
    return new Promise((resolve) => {
        const check = async () => {
            if (isLoadingCompleted) { await delay(3500); resolve(); }
            else setTimeout(check, 1000);
        };
        check();
    });
}

function showNotification(message) {
    isLoadingCompleted = false;
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: message, cancellable: false },
        async () => { await checkLoadingCompletion(); }
    );
}

// ── SCIDE-style bracket selection ────────────────────────────────────────────
//
// Mirrors the stripCommentsAndStrings logic from client/src/sc.ts so that
// brackets inside // comments, /* */ comments (nestable in SC), "strings"
// and 'symbols' are completely ignored during matching.

function stripSCCommentsAndStrings(text) {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        // Line comment  //
        if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
                out[i] = ' '; i++;
            }
        }
        // Block comment  /* … */  (SC allows nesting)
        else if (text[i] === '/' && text[i + 1] === '*') {
            let depth = 1;
            out[i] = ' '; out[i + 1] = ' '; i += 2;
            while (i < text.length && depth > 0) {
                if (text[i] === '/' && text[i + 1] === '*') {
                    out[i] = ' '; out[i + 1] = ' '; i += 2; depth++;
                } else if (text[i] === '*' && text[i + 1] === '/') {
                    out[i] = ' '; out[i + 1] = ' '; i += 2; depth--;
                } else {
                    if (text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
                    i++;
                }
            }
        }
        // String literal  "…"
        else if (text[i] === '"') {
            out[i] = ' '; i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') { out[i] = ' '; i++; }
                if (i < text.length && text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
                i++;
            }
            if (i < text.length) { out[i] = ' '; i++; }
        }
        // Single-quoted symbol  '…'  ($' is a Character literal, not a symbol)
        else if (text[i] === '\'' && (i === 0 || text[i - 1] !== '$')) {
            out[i] = ' '; i++;
            while (i < text.length && text[i] !== '\'') {
                if (text[i] === '\\') { out[i] = ' '; i++; }
                if (i < text.length && text[i] !== '\n' && text[i] !== '\r') out[i] = ' ';
                i++;
            }
            if (i < text.length) { out[i] = ' '; i++; }
        }
        else { i++; }
    }
    return out.join('');
}

/**
 * Given a document and the character offset of a bracket, returns the offset
 * of its matching counterpart, or -1 if not found.
 * Uses comment/string-stripped text so brackets inside comments are ignored.
 */
function findMatchingBracketOffset(document, clickOffset, bracketChar) {
    const OPEN  = '([{';
    const CLOSE = ')]}';
    const openIdx  = OPEN.indexOf(bracketChar);
    const closeIdx = CLOSE.indexOf(bracketChar);
    if (openIdx === -1 && closeIdx === -1) return -1;

    const text     = document.getText();
    const stripped = stripSCCommentsAndStrings(text);

    if (openIdx !== -1) {
        // Opening bracket → scan forward
        const closeChar = CLOSE[openIdx];
        let depth = 0;
        for (let i = clickOffset; i < stripped.length; i++) {
            if (stripped[i] === bracketChar) depth++;
            else if (stripped[i] === closeChar) { depth--; if (depth === 0) return i; }
        }
    } else {
        // Closing bracket → scan backward
        const openChar = OPEN[closeIdx];
        let depth = 0;
        for (let i = clickOffset; i >= 0; i--) {
            if (stripped[i] === bracketChar) depth++;
            else if (stripped[i] === openChar) { depth--; if (depth === 0) return i; }
        }
    }
    return -1;
}

/**
 * Core logic shared by the double-click listener and the explicit command.
 * Finds the enclosing / clicked bracket pair and returns a Selection that
 * covers both brackets and everything between them, or null if not applicable.
 */
function buildBracketSelection(editor) {
    const document = editor.document;
    const OPEN  = '([{';
    const CLOSE = ')]}';

    const cursorOffset = document.offsetAt(editor.selection.active);
    const text = document.getText();

    // Look at the character at the cursor and the one before it so we catch
    // the cursor sitting right after a closing bracket too.
    const candidates = [cursorOffset, cursorOffset - 1].filter(o => o >= 0 && o < text.length);

    for (const offset of candidates) {
        const ch = text[offset];
        if (!OPEN.includes(ch) && !CLOSE.includes(ch)) continue;

        const matchOffset = findMatchingBracketOffset(document, offset, ch);
        if (matchOffset === -1) continue;

        const startOffset = OPEN.includes(ch) ? offset       : matchOffset;
        const endOffset   = OPEN.includes(ch) ? matchOffset  : offset;

        // Selection: from opening bracket to just after closing bracket
        return new vscode.Selection(
            document.positionAt(startOffset),
            document.positionAt(endOffset + 1)
        );
    }
    return null;
}

module.exports = { activate, deactivate };
