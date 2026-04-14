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
const os = require('os');
const osc = require('osc');

const PROXY_PREFIX = 'v';           // → ~v_name
const DEFAULT_LAG_TIME = 0.05;      // 50ms lag for smooth SC control
const STATE_VERSION = 1;            // bump when state schema changes
const ENVIL_DIR = '.envil';         // workspace-local config directory
const STATE_FILE = 'state.json';    // knob/macro/seq state

let _panel = null;
let _getSC = null;        // function → sc module (lazy)
let _getIO = null;        // function → socket.io server (for future Hydra support)
let _hydraOutput = null;  // output channel for logging
let _layoutPath = null;   // path to persist knob layout on disk (workspace-local)
let _workspacePath = null; // workspace root (if available)

// ── Host-side sequencer state (clock runs here, never throttled) ─────────
let _seqs = [];              // [{ name, steps, currentStep, playing }]
let _seqBpm = 120;
let _seqSubdiv = 4;
let _seqTimer = null;        // setInterval ID
let _seqSyncSC = true;       // sync to SC TempoClock

// ── Host-side sequencer OSC output ───────────────────────────────────────
let _seqOscPort = null;      // osc.UDPPort for sending sequencer events
let _seqOscReady = false;    // true once the UDP socket is bound and ready
let _seqOscTargetPort = 57120; // sclang NetAddr.langPort default
let _seqOscTargetHost = '127.0.0.1';
let _seqOscEnabled = true;   // master on/off from setting

// ── Host-side macro curve state ──────────────────────────────────────────
let _macros = [];            // [{ name, macroNum, points, position, playing, durationSec, durationBeats, loop }]
let _macroTimer = null;
let _macroLastTickMs = 0;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the touch-knobs commands and set up dependencies.
 * Call from extension.js activate().
 * @param {object} opts
 * @param {boolean} [opts.autoOpen=false] - open panel immediately on activation
 * @param {string|null} [opts.workspacePath] - workspace root; state saved to .envil/state.json there
 */
function registerTouchKnobs(context, { getSC, getIO, hydraOutput, extensionPath, autoOpen, workspacePath }) {
    _getSC = getSC;
    _getIO = getIO;
    _hydraOutput = hydraOutput;
    _workspacePath = workspacePath || null;

    // ── Sequencer OSC output setup ───────────────────────────────────────
    const seqCfg = vscode.workspace.getConfiguration('envil.sequencer');
    _seqOscTargetPort = seqCfg.get('oscTargetPort', 57120);
    _seqOscTargetHost = seqCfg.get('oscTargetHost', '127.0.0.1');
    _seqOscEnabled = seqCfg.get('oscEnabled', true);
    ensureSeqOscPort();

    // Re-read settings on change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('envil.sequencer')) {
                const cfg = vscode.workspace.getConfiguration('envil.sequencer');
                _seqOscTargetPort = cfg.get('oscTargetPort', 57120);
                _seqOscTargetHost = cfg.get('oscTargetHost', '127.0.0.1');
                _seqOscEnabled = cfg.get('oscEnabled', true);
            }
        }),
    );

    // Compute state file path: prefer workspace-local .envil/state.json,
    // fall back to extension-global touch-knobs-layout.json
    if (_workspacePath) {
        _layoutPath = path.join(_workspacePath, ENVIL_DIR, STATE_FILE);
    } else {
        _layoutPath = path.join(extensionPath, 'touch-knobs-layout.json');
    }

    // Migrate: if workspace already has .envil/ dir but no state.json,
    // and old extension-global layout file exists, copy it over.
    // (Only migrates into workspaces the user has already init'd)
    if (_workspacePath && hasEnvilDir(_workspacePath)) {
        const oldGlobal = path.join(extensionPath, 'touch-knobs-layout.json');
        if (!fs.existsSync(_layoutPath) && fs.existsSync(oldGlobal)) {
            try {
                const dir = path.dirname(_layoutPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const old = JSON.parse(fs.readFileSync(oldGlobal, 'utf-8'));
                old.autoOpen = true;
                old._version = STATE_VERSION;
                old._migratedFrom = 'extension-global';
                fs.writeFileSync(_layoutPath, JSON.stringify(old, null, 2));
                log(`  ⟳ migrated touch-knobs state → ${path.relative(_workspacePath, _layoutPath)}`);
            } catch (e) {
                console.warn('[touch-knobs] migration failed:', e);
            }
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('envil.touchKnobs.open', () => openPanel(context)),
        vscode.commands.registerCommand('envil.touchKnobs.close', () => closePanel()),
        vscode.commands.registerCommand('envil.initWorkspace', () => initWorkspace(context)),
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
    const saved = loadLayout();
    const htmlPath = path.join(context.extensionPath, 'touch-knobs-panel.html');
    const rawHtml = fs.readFileSync(htmlPath, 'utf-8');
    const initialStateScript = `globalThis.__ENVIL_INITIAL_STATE__ = ${serializeForWebview(saved || {})};`;
    _panel.webview.html = rawHtml.replace(
        'const vscode = acquireVsCodeApi();',
        `const vscode = acquireVsCodeApi();\n${initialStateScript}`,
    );

    // Handle messages from webview
    _panel.webview.onDidReceiveMessage(handleMessage, null, context.subscriptions);

    _panel.onDidDispose(() => {
        seqStopTimer();
        macroStopTimer();
        stopTempoSync();
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
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { ${proxyName}.mold(2, \\control); ${proxyName} = ${src}; ${proxyName}.set(\\x, ${msg.x || 0}, \\y, ${msg.y || 0}) })`;
            sendSC(code);
            sendHydra('knob-update', { note: noteNum, x: msg.x || 0, y: msg.y || 0 });
            log(`  ＋ knob ${proxyName}  (x: ${fmt(msg.x)}, y: ${fmt(msg.y)})`);
            break;
        }

        case 'knob-move': {
            // Auto-init or repair CC proxy if missing / wrong channel count
            // ~v_c<midiNote> — mirrors footcontroller ~l_c<ccNum>
            const noteNum = msg.midiNote || msg.id;
            const proxyName = `~${PROXY_PREFIX}_c${noteNum}`;
            const src = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil or: { ${proxyName}.numChannels != 2 }, { ${proxyName}.mold(2, \\control); ${proxyName} = ${src} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.send }) }); ${proxyName}.set(\\x, ${msg.x}, \\y, ${msg.y}) })`;
            sendSC(code, true);
            sendHydra('knob-update', { note: noteNum, x: msg.x, y: msg.y });
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
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p} = ${src} }, { if(Server.default.serverRunning and: { ${p}.isPlaying.not }, { ${p}.send }) })`;
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
            sendHydra('knob-note', { note: noteNum, val: 1 });
            setTimeout(() => sendHydra('knob-note-off', { note: noteNum }), 100);
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
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p} = ${src} }, { if(Server.default.serverRunning and: { ${p}.isPlaying.not }, { ${p}.send }) })`;
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
            sendHydra('knob-note', { note: noteNum, val: 1 });
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
            sendHydra('knob-note-off', { note: noteNum });
            log(`  ⚡ hold-OFF ${perNote}`);
            break;
        }

        case 'knob-rename': {
            // Display-only rename — SC proxy is ~v_c<midiNote>, not name-based
            log(`  ✎ renamed label "${msg.oldName}" → "${msg.newName}"`);
            break;
        }

        case 'panel-state-cache': {
            if (msg.state) saveLayout(msg.state);
            break;
        }

        // 'init-all' removed — proxies now self-heal via isPlaying.not checks

        // ── Sequencer messages ───────────────────────────────────────────

        case 'seq-create': {
            const name = sanitizeName(msg.name);
            const steps = msg.steps || new Array(8).fill(0);
            const playing = msg.playing !== false;
            // Create SC proxy — only if it doesn't already exist (preserves bus index)
            const proxyName = `~seq_${name}`;
            const seqSrc = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil, { ${proxyName}.mold(1, \\control); ${proxyName} = ${seqSrc} }); ${proxyName}.set(\\val, 0) })`);
            // Add to host-side state
            _seqs.push({ name, steps: steps.slice(), currentStep: -1, playing });
            seqEnsureTimer();
            log(`  ＋ seq ${proxyName}  steps=${steps.length}  playing=${playing}`);
            break;
        }

        case 'seq-remove': {
            const name = sanitizeName(msg.name);
            const proxyName = `~seq_${name}`;
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${proxyName}.clear })`, true);
            _seqs = _seqs.filter(s => s.name !== name);
            seqEnsureTimer();
            log(`  ✖ removed seq ${proxyName}`);
            break;
        }

        case 'seq-play-toggle': {
            const name = sanitizeName(msg.name);
            const s = _seqs.find(x => x.name === name);
            if (!s) break;
            s.playing = msg.playing;
            if (!s.playing) {
                // Pause: zero SC output but KEEP currentStep for resume
                seqSetSCValue(s, 0);
            } else if (s.currentStep >= 0 && s.currentStep < s.steps.length) {
                // Resume from paused position: immediately emit the current step
                const val = s.steps[s.currentStep];
                seqSetSCValue(s, val);
                sendHydra('seq-step', { name: s.name, step: s.currentStep, val, steps: s.steps });
                if (_panel) {
                    _panel.webview.postMessage({ type: 'seq-visual-tick', ticks: [{ name: s.name, step: s.currentStep, val }] });
                }
            }
            seqEnsureTimer();
            break;
        }

        case 'seq-stop-all': {
            for (const s of _seqs) {
                seqSetSCValue(s, 0);
                s.playing = false;
                s.currentStep = -1;
            }
            seqStopTimer();
            macroStopAll();
            break;
        }

        case 'seq-set-bpm': {
            if (msg.bpm != null) _seqBpm = Math.max(1, Math.min(999, msg.bpm));
            if (msg.subdiv != null) _seqSubdiv = msg.subdiv;
            seqReschedule();
            // Sync ~t proxy + TempoClock
            const newTempo = _seqBpm / 60;
            sendSC(`TempoClock.default.tempo = ${newTempo}`, true);
            pushTempoProxy(newTempo);
            log(`  ♩ seq BPM=${_seqBpm}  ÷${_seqSubdiv}`);
            break;
        }

        case 'seq-toggle-step': {
            const name = sanitizeName(msg.name);
            const s = _seqs.find(x => x.name === name);
            if (s && msg.steps) s.steps = msg.steps.slice();
            sendHydra('seq-step', { name, step: msg.step, val: msg.val, steps: msg.steps });
            break;
        }

        case 'seq-update-steps': {
            // +/- step length changed
            const name = sanitizeName(msg.name);
            const s = _seqs.find(x => x.name === name);
            if (s && msg.steps) {
                s.steps = msg.steps.slice();
                if (s.currentStep >= s.steps.length) s.currentStep = s.currentStep % s.steps.length;
            }
            break;
        }

        case 'seq-tempo-sync': {
            _seqSyncSC = true;
            startTempoSync();
            break;
        }

        case 'seq-tempo-unsync': {
            _seqSyncSC = false;
            stopTempoSync();
            break;
        }

        case 'seq-tempo-tap': {
            if (_seqSyncSC) {
                const tappedBpm = Math.max(1, Math.min(999, Number(msg.bpm) || _seqBpm || 120));
                const tappedTempo = Math.max(0.001, tappedBpm / 60);
                sendSC(`try { var tap = if(e.notNil) { e[\\timeSyncInput] } { nil }; var tappedTempo = ${tappedTempo}; if(tap.notNil) { tap.value; } { TempoClock.default.tempo = tappedTempo; } } { |err| err }`, true);
                pushTempoProxy(tappedTempo);
                setTimeout(() => {
                    if (_seqSyncSC) pollSCTempo();
                }, 150);
                setTimeout(() => {
                    if (_seqSyncSC) pollSCTempo();
                }, 450);
                log(`  ♩ tap → SC sync (${Number(msg.bpm) > 0 ? `fallback bpm=${tappedBpm}` : 'fallback armed'})`);
            }
            break;
        }

        case 'seq-rename': {
            const oldName = sanitizeName(msg.oldName);
            const newName = sanitizeName(msg.newName);
            const oldProxy = `~seq_${oldName}`;
            const newProxy = `~seq_${newName}`;
            const seqSrc = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${oldProxy}.clear; ${newProxy} = ${seqSrc} })`, true);
            const s = _seqs.find(x => x.name === oldName);
            if (s) s.name = newName;
            log(`  ✎ seq renamed ${oldProxy} → ${newProxy}`);
            break;
        }

        // ── Macro curve messages ───────────────────────────────────────

        case 'macro-create': {
            const name = sanitizeName(msg.name || `macro${_macros.length + 1}`);
            const points = normalizeMacroPoints(msg.points);
            const playing = msg.playing !== false;
            const durationSec = positiveNumber(msg.durationSec, 30);
            const durationBeats = positiveNumber(msg.durationBeats, 64);
            const loop = msg.loop !== false;
            const macroNum = positiveInteger(msg.macroNum, _macros.length + 1);
            const position = clamp01(msg.currentPos != null ? msg.currentPos : 0);
            const proxyName = macroProxyName({ macroNum });
                sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${macroEnsureSCCode(proxyName)} })`, true);
            let m = _macros.find(x => x.name === name);
            if (m) {
                m.macroNum = macroNum;
                m.points = points;
                m.playing = playing;
                m.durationSec = durationSec;
                m.durationBeats = durationBeats;
                m.loop = loop;
                m.position = position;
            } else {
                m = { name, macroNum, points, position, playing, durationSec, durationBeats, loop };
                _macros.push(m);
            }
            macroEmitImmediate(m, { includePoints: true });
            macroEnsureTimer();
            log(`  ＋ macro ${proxyName}  points=${points.length}  playing=${playing}`);
            break;
        }

        case 'macro-remove': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            const proxyName = macroProxyName(m);
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${proxyName}.clear })`, true);
            _macros = _macros.filter(x => x !== m);
            macroEnsureTimer();
            sendHydra('macro-remove', { name });
            log(`  ✖ removed macro ${proxyName}`);
            break;
        }

        case 'macro-play-toggle': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            m.playing = !!msg.playing;
            if (msg.loop != null) m.loop = !!msg.loop;
            if (msg.currentPos != null) m.position = clamp01(msg.currentPos);
            macroEmitImmediate(m, { includePoints: false });
            macroEnsureTimer();
            break;
        }

        case 'macro-update-curve': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            m.points = normalizeMacroPoints(msg.points);
            if (msg.currentPos != null) m.position = clamp01(msg.currentPos);
            macroEmitImmediate(m, { includePoints: true });
            break;
        }

        case 'macro-set-duration': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            m.durationSec = positiveNumber(msg.durationSec, m.durationSec || 30);
            m.durationBeats = positiveNumber(msg.durationBeats, m.durationBeats || 64);
            break;
        }

        case 'macro-set-loop': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            m.loop = !!msg.loop;
            break;
        }

        case 'macro-seek': {
            const name = sanitizeName(msg.name);
            const m = _macros.find(x => x.name === name);
            if (!m) break;
            m.position = clamp01(msg.position);
            macroEmitImmediate(m, { includePoints: false });
            break;
        }

        case 'macro-rename': {
            const oldName = sanitizeName(msg.oldName);
            const newName = sanitizeName(msg.newName);
            const m = _macros.find(x => x.name === oldName);
            if (!m) break;
            sendHydra('macro-remove', { name: oldName });
            m.name = newName;
            macroEmitImmediate(m, { includePoints: true });
            log(`  ✎ macro renamed ${oldName} → ${newName}  (${macroProxyName(m)})`);
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
// SEQUENCER ENGINE (runs in Node.js — never throttled by Chromium)
// ─────────────────────────────────────────────────────────────────────────────

const SEQ_SRC = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
const MACRO_SRC = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
const MACRO_TICK_MS = 33;
const LOCAL_MACRO_BASE_BPM = 120;

function seqAnyPlaying() {
    return _seqs.some(s => s.playing);
}

function seqEnsureTimer() {
    if (seqAnyPlaying() && !_seqTimer) {
        seqStartTimer();
    } else if (!seqAnyPlaying() && _seqTimer) {
        seqStopTimer();
    }
}

function seqStartTimer() {
    seqStopTimer();
    const intervalMs = 60000 / (_seqBpm * _seqSubdiv);
    _seqTimer = setInterval(seqTick, intervalMs);
}

function seqStopTimer() {
    if (_seqTimer) { clearInterval(_seqTimer); _seqTimer = null; }
}

function seqReschedule() {
    if (seqAnyPlaying()) {
        seqStartTimer();
    }
}

function seqTick() {
    const ticks = [];  // batch visual updates
    const scParts = []; // batch SC updates into one sendCode
    for (const s of _seqs) {
        if (!s.playing) continue;
        s.currentStep = (s.currentStep + 1) % s.steps.length;
        const val = s.steps[s.currentStep];
        // Collect SC code for batching
        scParts.push(seqSCCode(s, val));
        // Hydra: emit step event
        sendHydra('seq-step', { name: s.name, step: s.currentStep, val, steps: s.steps });
        ticks.push({ name: s.name, step: s.currentStep, val });
    }
    // OSC: send sequencer events to sclang
    if (_seqOscEnabled && _seqOscPort) {
        for (const t of ticks) {
            // Always send step message: /envil/seq/<name> step val
            sendSeqOSC('/envil/seq/' + t.name, [t.step, t.val]);
            // On-event only when step is active (val > 0)
            if (t.val > 0) {
                sendSeqOSC('/envil/seq/on', [t.name, t.step, t.val]);
            }
        }
    }
    // SC: send all proxy updates in ONE write (avoid stdin race)
    if (scParts.length > 0) {
        sendSC(scParts.join('; '), true);
    }
    // Webview: lightweight visual update only
    if (_panel && ticks.length > 0) {
        _panel.webview.postMessage({ type: 'seq-visual-tick', ticks });
    }
}

function seqSCCode(s, val) {
    const proxyName = `~seq_${s.name}`;
    const v = val != null ? val : 0;
    return `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil, { ${proxyName}.mold(1, \\control); ${proxyName} = ${SEQ_SRC} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.send; ">>> envil: auto-resent ${proxyName}".postln }) }); ${proxyName}.set(\\val, ${v}) })`;
}

function seqSetSCValue(s, val) {
    sendSC(seqSCCode(s, val), true);
}

// ─────────────────────────────────────────────────────────────────────────────
// MACRO CURVE ENGINE (runs in Node.js — shared transport with sequencers)
// ─────────────────────────────────────────────────────────────────────────────

function macroAnyPlaying() {
    return _macros.some(m => m.playing);
}

function macroEnsureTimer() {
    if (macroAnyPlaying() && !_macroTimer) {
        macroStartTimer();
    } else if (!macroAnyPlaying() && _macroTimer) {
        macroStopTimer();
    }
}

function macroStartTimer() {
    macroStopTimer();
    _macroLastTickMs = Date.now();
    _macroTimer = setInterval(macroTick, MACRO_TICK_MS);
}

function macroStopTimer() {
    if (_macroTimer) {
        clearInterval(_macroTimer);
        _macroTimer = null;
    }
}

function macroStopAll() {
    const scParts = [];
    const updates = [];
    for (const m of _macros) {
        m.playing = false;
        m.position = 0;
        const val = macroSampleValue(m, m.position);
        scParts.push(macroSCCode(m, val));
        sendHydra('macro-update', macroHydraPayload(m, val, false));
        updates.push({ name: m.name, position: m.position, val, playing: false, loop: !!m.loop });
    }
    macroStopTimer();
    if (scParts.length > 0) sendSC(scParts.join('; '), true);
    if (_panel && updates.length > 0) {
        _panel.webview.postMessage({ type: 'macro-visual-update', macros: updates });
    }
}

function macroTick() {
    const now = Date.now();
    const deltaMs = Math.max(1, now - (_macroLastTickMs || now));
    _macroLastTickMs = now;

    const scParts = [];
    const updates = [];

    for (const m of _macros) {
        if (!m.playing) continue;
        const durationMs = macroDurationMs(m);
        if (!(durationMs > 0)) continue;

        const nextPos = m.position + (deltaMs / durationMs);
        const reachedEnd = nextPos >= 1;
        if (m.loop && reachedEnd) {
            m.position = nextPos % 1;
        } else {
            m.position = clamp01(nextPos);
            if (reachedEnd) m.playing = false;
        }

        const val = macroSampleValue(m, m.position);
        scParts.push(macroSCCode(m, val));
        sendHydra('macro-update', macroHydraPayload(m, val, reachedEnd));
        updates.push({ name: m.name, position: m.position, val, playing: m.playing, loop: !!m.loop });
    }

    if (scParts.length > 0) sendSC(scParts.join('; '), true);
    if (_panel && updates.length > 0) {
        _panel.webview.postMessage({ type: 'macro-visual-update', macros: updates });
    }

    macroEnsureTimer();
}

function macroDurationMs(m) {
    if (_seqSyncSC) {
        const beats = positiveNumber(m.durationBeats, 64);
        return beats * (60000 / Math.max(1, _seqBpm));
    }
    const seconds = positiveNumber(m.durationSec, 30);
    const localRate = Math.max(0.01, Math.max(1, _seqBpm) / LOCAL_MACRO_BASE_BPM);
    return (seconds * 1000) / localRate;
}

function macroSampleValue(m, position) {
    const points = normalizeMacroPoints(m.points);
    if (points.length === 1) return clamp01(points[0]);
    const scaled = clamp01(position) * (points.length - 1);
    const idx = Math.floor(scaled);
    const frac = scaled - idx;
    const a = clamp01(points[idx]);
    const b = clamp01(points[Math.min(points.length - 1, idx + 1)]);
    return clamp01(a + ((b - a) * frac));
}

function macroSCCode(m, val) {
    const proxyName = macroProxyName(m);
    const v = clamp01(val != null ? val : 0);
        return `if(currentEnvironment.isKindOf(ProxySpace), { ${macroEnsureSCCode(proxyName)}; ${proxyName}.set(\\val, ${v}) })`;
}

function macroHydraPayload(m, val, includePoints = false) {
    return {
        name: m.name,
        pos: clamp01(m.position),
        val: clamp01(val != null ? val : 0),
        length: Array.isArray(m.points) ? m.points.length : 0,
        playing: !!m.playing,
        loop: !!m.loop,
        points: includePoints ? normalizeMacroPoints(m.points) : undefined,
    };
}

function macroEmitImmediate(m, { includePoints = false } = {}) {
    const val = macroSampleValue(m, m.position);
    sendSC(macroSCCode(m, val), true);
    sendHydra('macro-update', macroHydraPayload(m, val, includePoints));
    if (_panel) {
        _panel.webview.postMessage({
            type: 'macro-visual-update',
            macros: [{ name: m.name, position: clamp01(m.position), val, playing: !!m.playing, loop: !!m.loop }],
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SC TEMPO SYNC (polls TempoClock.default.tempo → updates host-side BPM)
// ─────────────────────────────────────────────────────────────────────────────

let _tempoSyncInterval = null;

function startTempoSync() {
    stopTempoSync();
    log('  ♩ SC tempo sync ON');
    pollSCTempo();
    _tempoSyncInterval = setInterval(pollSCTempo, 500);
}

function stopTempoSync() {
    if (_tempoSyncInterval) {
        clearInterval(_tempoSyncInterval);
        _tempoSyncInterval = null;
        log('  ♩ SC tempo sync OFF');
    }
}

async function pollSCTempo() {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning() || !sc.queryCode) return;
    try {
        const marker = '__ENVIL_TEMPO__';
        if (sc.addSuppressMarker) sc.addSuppressMarker(marker);
        const code = `"${marker}".post; TempoClock.default.tempo.asString.post; "${marker}".postln`;
        const result = await sc.queryCode(code, marker, 1000);
        if (result != null) {
            const tempo = parseFloat(result);
            if (!isNaN(tempo) && tempo > 0) {
                const bpm = Math.round(tempo * 60);
                if (bpm !== _seqBpm && bpm >= 1 && bpm <= 999) {
                    _seqBpm = bpm;
                    seqReschedule();
                    // Push updated BPM to webview for display
                    if (_panel) {
                        _panel.webview.postMessage({ type: 'seq-tempo-update', bpm });
                    }
                }
                // Always sync ~t proxy to current tempo
                pushTempoProxy(tempo);
            }
        }
    } catch (e) {
        // Silently ignore — sclang might not be ready
    }
}

/**
 * Push current tempo into the ~t control proxy in ProxySpace.
 * Uses e[\timeSyncInput] if available (footcontroller tap-tempo flow),
 * otherwise sets ~t directly. Also sets TempoClock.default.tempo.
 * ~t holds beats-per-second (same unit as TempoClock.default.tempo).
 */
const TEMPO_PROXY_SRC = `{ |val=1, lagTime=0.1| Lag.kr(val, lagTime) }`;

function pushTempoProxy(tempo) {
    const t = Math.max(0.001, tempo);
    sendSC(
        `if(currentEnvironment.isKindOf(ProxySpace), {` +
        ` if(~t.source.isNil, { ~t = ${TEMPO_PROXY_SRC} });` +
        ` if(Server.default.serverRunning and: { ~t.isPlaying.not }, { ~t.send });` +
        ` ~t.set(\\val, ${t})` +
        ` })`,
        true
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCER OSC OUTPUT
// ─────────────────────────────────────────────────────────────────────────────

function ensureSeqOscPort() {
    if (_seqOscPort) return;
    try {
        _seqOscPort = new osc.UDPPort({
            localAddress: '0.0.0.0',
            localPort: 0,             // OS picks an ephemeral port
            broadcast: false,
        });
        _seqOscPort.on('ready', () => {
            _seqOscReady = true;
            console.log('[touch-knobs] seq OSC port ready, sending to ' + _seqOscTargetHost + ':' + _seqOscTargetPort);
        });
        _seqOscPort.on('error', (err) => {
            console.warn('[touch-knobs] seq OSC port error:', err.message);
        });
        _seqOscPort.open();
    } catch (e) {
        console.warn('[touch-knobs] failed to open seq OSC port:', e.message);
        _seqOscPort = null;
        _seqOscReady = false;
    }
}

function sendSeqOSC(address, args) {
    if (!_seqOscPort || !_seqOscReady) return;
    try {
        const oscArgs = args.map(a => {
            if (typeof a === 'string') return { type: 's', value: a };
            if (Number.isInteger(a))    return { type: 'i', value: a };
            return { type: 'f', value: Number(a) };
        });
        _seqOscPort.send({
            address,
            args: oscArgs,
        }, _seqOscTargetHost, _seqOscTargetPort);
    } catch (e) {
        // Silently ignore — target might not be listening
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

/** Emit a socket.io event to the Hydra browser page. */
function sendHydra(event, data) {
    const io = _getIO ? _getIO() : null;
    if (!io) return;
    io.sockets.emit(event, data);
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
            const raw = fs.readFileSync(_layoutPath, 'utf-8');
            const data = JSON.parse(raw);
            return data;
        }
    } catch (e) {
        console.warn('[touch-knobs] failed to load layout:', e);
        // Attempt to recover from backup
        const bak = _layoutPath + '.bak';
        if (bak && fs.existsSync(bak)) {
            try {
                console.warn('[touch-knobs] trying backup…');
                return JSON.parse(fs.readFileSync(bak, 'utf-8'));
            } catch (_) { /* give up */ }
        }
    }
    return null;
}

function saveLayout(state) {
    try {
        if (!_layoutPath) return;
        // Ensure directory exists
        const dir = path.dirname(_layoutPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Stamp version
        const out = Object.assign({}, state || {}, { _version: STATE_VERSION });
        const json = JSON.stringify(out, null, 2);
        // Atomic write: write to .tmp then rename
        const tmp = _layoutPath + '.tmp';
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, _layoutPath);
    } catch (e) {
        console.warn('[touch-knobs] failed to save layout:', e);
        // Direct-write fallback (rename can fail across filesystems, though unlikely here)
        try {
            fs.writeFileSync(_layoutPath, JSON.stringify(state || {}, null, 2));
        } catch (_) { /* give up */ }
    }
}

function serializeForWebview(value) {
    return JSON.stringify(value || {}).replace(/</g, '\\u003c');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeName(name) {
    return (name || 'k0').replace(/[^a-zA-Z0-9_]/g, '');
}

function macroEnsureSCCode(proxyName) {
    return `if(${proxyName}.source.isNil, { ${proxyName} = ${MACRO_SRC} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.send; ">>> envil: auto-resent ${proxyName}".postln }) }); ${proxyName}.mold(1, \\control)`;
}

function macroProxyName(m) {
    return `~mcr_${positiveInteger(m && m.macroNum, 1)}`;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
}

function normalizeMacroPoints(points) {
    if (!Array.isArray(points) || points.length === 0) return [0.5];
    return points.map(clamp01);
}

function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInteger(value, fallback) {
    return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

function fmt(n) {
    return n != null ? Number(n).toFixed(3) : '0';
}

function log(msg) {
    if (_hydraOutput) _hydraOutput.appendLine(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE INIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the workspace has a .envil/ directory (i.e. was previously
 * initialised for envil use).
 */
function hasEnvilDir(workspacePath) {
    if (!workspacePath) return false;
    try { return fs.existsSync(path.join(workspacePath, ENVIL_DIR)); }
    catch { return false; }
}

/**
 * Command handler:  Envil: Init Workspace
 * Creates .envil/ directory + default state.json, optionally opens touch knobs.
 */
async function initWorkspace(context) {
    if (!_workspacePath) {
        vscode.window.showWarningMessage('Envil: No workspace folder open — cannot initialise.');
        return;
    }
    const dir = path.join(_workspacePath, ENVIL_DIR);
    const stateFile = path.join(dir, STATE_FILE);

    if (fs.existsSync(stateFile)) {
        const choice = await vscode.window.showInformationMessage(
            `Workspace already has ${ENVIL_DIR}/${STATE_FILE}. Open Touch Knobs?`,
            'Open', 'Cancel',
        );
        if (choice === 'Open') openPanel(context);
        return;
    }

    // Create directory + empty state
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ autoOpen: true, _version: STATE_VERSION }, null, 2));
        log(`  ✔ created ${ENVIL_DIR}/${STATE_FILE}`);
    } catch (e) {
        vscode.window.showErrorMessage(`Envil: Failed to create ${ENVIL_DIR}/: ${e.message}`);
        return;
    }

    // Suggest .gitignore entry
    const gitignorePath = path.join(_workspacePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        if (!content.includes(ENVIL_DIR)) {
            const addIt = await vscode.window.showInformationMessage(
                `Add "${ENVIL_DIR}/" to .gitignore? (personal knob state shouldn't be committed)`,
                'Yes', 'No',
            );
            if (addIt === 'Yes') {
                fs.appendFileSync(gitignorePath, `\n# envil workspace state (touch knobs / macros)\n${ENVIL_DIR}/\n`);
            }
        }
    }

    vscode.window.showInformationMessage(`Envil workspace initialised.  Touch Knobs state will be saved in ${ENVIL_DIR}/${STATE_FILE}`);
    openPanel(context);
}

module.exports = { registerTouchKnobs, hasEnvilDir };
