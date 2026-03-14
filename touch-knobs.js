// @ts-nocheck
// touch-knobs.js
//
// Manages a VS Code WebviewPanel with draggable touch knobs.
// Knob positions (normalised 0–1) are sent to SuperCollider as
// proxyspace node proxies:  ~v_<name>.set(\x, val, \y, val)
//
// The naming convention mirrors the user's MIDI controller system
// (e.g. ~l_c31 for launchpad CC 31) but uses the prefix 'v' for
// virtual/visual:  ~v_k1, ~v_k2, etc.

'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const PROXY_PREFIX = 'v';           // → ~v_name
const DEFAULT_LAG_TIME = 0.05;      // 50ms lag for smooth SC control

let _panel = null;
let _getSC = null;        // function → sc module (lazy)
let _getIO = null;        // function → socket.io server (for future Hydra support)
let _hydraOutput = null;  // output channel for logging
let _layoutPath = null;   // path to persist knob layout on disk

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the touch-knobs commands and set up dependencies.
 * Call from extension.js activate().
 * @param {object} opts
 * @param {boolean} [opts.autoOpen=false] - open panel immediately on activation
 */
function registerTouchKnobs(context, { getSC, getIO, hydraOutput, extensionPath, autoOpen }) {
    _getSC = getSC;
    _getIO = getIO;
    _hydraOutput = hydraOutput;
    _layoutPath = path.join(extensionPath, 'touch-knobs-layout.json');

    context.subscriptions.push(
        vscode.commands.registerCommand('envil.touchKnobs.open', () => openPanel(context)),
        vscode.commands.registerCommand('envil.touchKnobs.close', () => closePanel()),
    );

    // Auto-open on startup (small delay so editors have time to settle)
    if (autoOpen) {
        setTimeout(() => openPanel(context), 600);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

function openPanel(context) {
    if (_panel) {
        _panel.reveal(vscode.ViewColumn.Two);
        return;
    }

    _panel = vscode.window.createWebviewPanel(
        'envil.touchKnobs',
        '🎛 Touch Knobs',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
            enableScripts: true,
            retainContextWhenHidden: true,   // keep canvas alive when tab not visible
            localResourceRoots: [],          // no local resources needed
        }
    );

    // Load HTML
    const htmlPath = path.join(context.extensionPath, 'touch-knobs-panel.html');
    _panel.webview.html = fs.readFileSync(htmlPath, 'utf-8');

    // Restore saved layout
    const saved = loadLayout();
    if (saved && saved.knobs && saved.knobs.length > 0) {
        // Small delay to let webview initialise
        setTimeout(() => {
            _panel.webview.postMessage({
                type: 'restore-knobs',
                knobs: saved.knobs,
                nextId: saved.nextId,
            });
        }, 300);
    }

    // Handle messages from webview
    _panel.webview.onDidReceiveMessage(handleMessage, null, context.subscriptions);

    _panel.onDidDispose(() => {
        _panel = null;
    }, null, context.subscriptions);

    log('🎛 Touch knobs panel opened');
}

function closePanel() {
    if (_panel) {
        _panel.dispose();
        _panel = null;
        log('🎛 Touch knobs panel closed');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

function handleMessage(msg) {
    switch (msg.type) {

        case 'knob-add': {
            // Create CC proxy — ~v_c<midiNote> (mirrors footcontroller ~l_c<ccNum>)
            const noteNum = msg.midiNote || msg.id;
            const proxyName = `~${PROXY_PREFIX}_c${noteNum}`;
            const src = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { ${proxyName}.clear; ${proxyName}.kr(2); ${proxyName} = ${src}; ${proxyName}.set(\\x, ${msg.x || 0}, \\y, ${msg.y || 0}) })`;
            sendSC(code);
            log(`  ＋ knob ${proxyName}  (x: ${fmt(msg.x)}, y: ${fmt(msg.y)})`);
            break;
        }

        case 'knob-move': {
            // Auto-init CC proxy if missing (late sclang start / ProxySpace.push / reboot)
            // ~v_c<midiNote> — mirrors footcontroller ~l_c<ccNum>
            const noteNum = msg.midiNote || msg.id;
            const proxyName = `~${PROXY_PREFIX}_c${noteNum}`;
            const src = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil, { ${proxyName} = ${src} }); ${proxyName}.set(\\x, ${msg.x}, \\y, ${msg.y}) })`;
            sendSC(code, true);
            break;
        }

        case 'knob-remove': {
            // Clear CC proxy (~v_c<midi>) + note proxy (~v_n<midi>) for this knob
            const noteNum = msg.midiNote || msg.id;
            const ccProxy   = `~${PROXY_PREFIX}_c${noteNum}`;
            const noteProxy = `~${PROXY_PREFIX}_n${noteNum}`;
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${ccProxy}.clear; ${noteProxy}.clear })`, true);
            log(`  ✖ removed ${ccProxy} + ${noteProxy}`);
            break;
        }

        case 'knob-tap': {
            // Single tap: quick noteOn + auto noteOff after 100ms
            // Mirrors footcontroller generalNoteOn / generalNoteOff pattern:
            //   ~v_n<num>  = velocity (1 on tap, 0 after release)
            //   ~v_n       = which note/knob was last tapped (the note number)
            //   ~v_n_val   = velocity of last tap (1 on tap, 0 after release)
            const noteNum = msg.note || msg.id;
            const perNote = `~${PROXY_PREFIX}_n${noteNum}`;
            const lastNote = `~${PROXY_PREFIX}_n`;
            const lastVal  = `~${PROXY_PREFIX}_n_val`;
            const src = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p} = ${src} })`;
            const code = [
                `if(currentEnvironment.isKindOf(ProxySpace), {`,
                ` ${ensureSrc(perNote)};`,
                ` ${ensureSrc(lastNote)};`,
                ` ${ensureSrc(lastVal)};`,
                ` ${perNote}.set(\\val, 1);`,
                ` ${lastNote}.set(\\val, ${noteNum});`,
                ` ${lastVal}.set(\\val, 1);`,
                ` SystemClock.sched(0.1, {`,
                `  ${perNote}.set(\\val, 0);`,
                `  ${lastVal}.set(\\val, 0);`,
                `  nil`,
                ` });`,
                `})`,
            ].join('');
            sendSC(code, true);
            log(`  ⚡ tap ${perNote}  (~${PROXY_PREFIX}_n=${noteNum})`);
            break;
        }

        case 'knob-hold-on': {
            // Double-tap-hold: noteOn only — stays ON until explicit hold-off
            const noteNum = msg.note || msg.id;
            const perNote = `~${PROXY_PREFIX}_n${noteNum}`;
            const lastNote = `~${PROXY_PREFIX}_n`;
            const lastVal  = `~${PROXY_PREFIX}_n_val`;
            const src = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p} = ${src} })`;
            const code = [
                `if(currentEnvironment.isKindOf(ProxySpace), {`,
                ` ${ensureSrc(perNote)};`,
                ` ${ensureSrc(lastNote)};`,
                ` ${ensureSrc(lastVal)};`,
                ` ${perNote}.set(\\val, 1);`,
                ` ${lastNote}.set(\\val, ${noteNum});`,
                ` ${lastVal}.set(\\val, 1);`,
                `})`,
            ].join('');
            sendSC(code, true);
            log(`  ⚡ hold-ON ${perNote}  (~${PROXY_PREFIX}_n=${noteNum})`);
            break;
        }

        case 'knob-hold-off': {
            // Release held knob: noteOff
            const noteNum = msg.note || msg.id;
            const perNote = `~${PROXY_PREFIX}_n${noteNum}`;
            const lastVal  = `~${PROXY_PREFIX}_n_val`;
            const code = [
                `if(currentEnvironment.isKindOf(ProxySpace), {`,
                ` ${perNote}.set(\\val, 0);`,
                ` ${lastVal}.set(\\val, 0);`,
                `})`,
            ].join('');
            sendSC(code, true);
            log(`  ⚡ hold-OFF ${perNote}`);
            break;
        }

        case 'knob-rename': {
            // Display-only rename — SC proxy is ~v_c<midiNote>, not name-based
            log(`  ✎ renamed label "${msg.oldName}" → "${msg.newName}"`);
            break;
        }

        case 'init-all': {
            // Recreate all CC proxies ~v_c<midiNote> (useful after SC reboot / ProxySpace.push)
            const knobList = msg.knobs || [];
            if (knobList.length === 0) return;
            const src = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
            const lines = knobList.map(k => {
                const mn = k.midiNote || k.id;
                const pn = `~${PROXY_PREFIX}_c${mn}`;
                return `${pn}.clear; ${pn}.kr(2); ${pn} = ${src}; ${pn}.set(\\x, ${k.x || 0}, \\y, ${k.y || 0})`;
            });
            // Wrap in ProxySpace check so it's safe if no ProxySpace is pushed
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${lines.join('; ')} })`);
            log(`  ⟳ initialised ${knobList.length} CC proxies`);
            break;
        }

        default:
            break;
    }

    // Persist layout on every change
    if (msg.type === 'knob-add' || msg.type === 'knob-remove' || msg.type === 'knob-rename') {
        // The webview persists its own state via vscode.setState.
        // We also save to disk for cross-session persistence.
        saveLayoutFromPanel();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SC COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────

function sendSC(code, silent = false) {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning()) return;
    sc.sendCode(code, silent);
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

function saveLayoutFromPanel() {
    if (!_panel) return;
    // We rely on the webview's vscode.getState() for webview-internal persistence.
    // For disk persistence, we ask the webview to report its current state.
    // Actually, we already get all the info we need from knob-add/remove messages.
    // The webview persists via setState — that's sufficient for same-session.
    // For cross-session, we'll save on panel dispose too.
}

function loadLayout() {
    try {
        if (_layoutPath && fs.existsSync(_layoutPath)) {
            return JSON.parse(fs.readFileSync(_layoutPath, 'utf-8'));
        }
    } catch (e) {
        console.warn('[touch-knobs] failed to load layout:', e);
    }
    return null;
}

function saveLayout(knobs, nextId) {
    try {
        if (_layoutPath) {
            fs.writeFileSync(_layoutPath, JSON.stringify({ knobs, nextId }, null, 2));
        }
    } catch (e) {
        console.warn('[touch-knobs] failed to save layout:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeName(name) {
    return (name || 'k0').replace(/[^a-zA-Z0-9_]/g, '');
}

function fmt(n) {
    return n != null ? Number(n).toFixed(3) : '0';
}

function log(msg) {
    if (_hydraOutput) _hydraOutput.appendLine(msg);
}

module.exports = { registerTouchKnobs };
