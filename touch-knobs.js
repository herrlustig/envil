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

// ── Host-side sequencer state (clock runs here, never throttled) ─────────
let _seqs = [];              // [{ name, steps, currentStep, playing }]
let _seqBpm = 120;
let _seqSubdiv = 4;
let _seqTimer = null;        // setInterval ID
let _seqSyncSC = true;       // sync to SC TempoClock

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
        seqStopTimer();
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
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil or: { ${proxyName}.numChannels != 2 }, { ${proxyName}.mold(2, \\control); ${proxyName} = ${src} }); ${proxyName}.set(\\x, ${msg.x}, \\y, ${msg.y}) })`;
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

        case 'init-all': {
            // Recreate all CC proxies ~v_c<midiNote> (useful after SC reboot / ProxySpace.push)
            const knobList = msg.knobs || [];
            if (knobList.length === 0) return;
            const src = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
            const lines = knobList.map(k => {
                const mn = k.midiNote || k.id;
                const pn = `~${PROXY_PREFIX}_c${mn}`;
                return `${pn}.mold(2, \\control); ${pn} = ${src}; ${pn}.set(\\x, ${k.x || 0}, \\y, ${k.y || 0})`;
            });
            // Wrap in ProxySpace check so it's safe if no ProxySpace is pushed
            sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${lines.join('; ')} })`);
            // Sync all knob values to Hydra
            knobList.forEach(k => {
                const mn = k.midiNote || k.id;
                sendHydra('knob-update', { note: mn, x: k.x || 0, y: k.y || 0 });
            });
            log(`  ⟳ initialised ${knobList.length} CC proxies`);
            break;
        }

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
            break;
        }

        case 'seq-set-bpm': {
            if (msg.bpm != null) _seqBpm = Math.max(1, Math.min(999, msg.bpm));
            if (msg.subdiv != null) _seqSubdiv = msg.subdiv;
            seqReschedule();
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
    return `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil, { ${proxyName}.mold(1, \\control); ${proxyName} = ${SEQ_SRC} }); ${proxyName}.set(\\val, ${v}) })`;
}

function seqSetSCValue(s, val) {
    sendSC(seqSCCode(s, val), true);
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
            }
        }
    } catch (e) {
        // Silently ignore — sclang might not be ready
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
