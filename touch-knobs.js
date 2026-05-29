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

// ── MediaPipe Holistic state ─────────────────────────────────────────────
let _mpEnabled = false;          // from envil.mediapipe.enabled
let _mpSendRate = 15;            // max landmark msgs/sec to SC
let _mpModelComplexity = 1;      // 0=lite, 1=full, 2=heavy
let _mpVideoOpacity = 0.25;      // webcam background opacity
let _mpDrawLandmarks = true;     // draw overlay landmarks
let _mpLastSendTime = 0;         // throttle timestamp
const MP_LAG_TIME = 0.08;        // SC lag for smooth landmark control
const MP_PROXY_SRC = `{ |x=0, y=0, lagTime=${MP_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
// 10-channel collector: one hand's 5 fingertips (thumb/index/mid/ring/pinky × x,y)
const MP_FINGERS5_SRC = `{ |thumb_x=0,thumb_y=0, idx_x=0,idx_y=0, mid_x=0,mid_y=0, ring_x=0,ring_y=0, pinky_x=0,pinky_y=0, lagTime=${MP_LAG_TIME}| [thumb_x,thumb_y,idx_x,idx_y,mid_x,mid_y,ring_x,ring_y,pinky_x,pinky_y].collect{|v| Lag.kr(v, lagTime) } }`;
// 20-channel collector: both hands' fingertips
const MP_FINGERS10_SRC = `{ |lt_x=0,lt_y=0,li_x=0,li_y=0,lm_x=0,lm_y=0,lr_x=0,lr_y=0,lp_x=0,lp_y=0, rt_x=0,rt_y=0,ri_x=0,ri_y=0,rm_x=0,rm_y=0,rr_x=0,rr_y=0,rp_x=0,rp_y=0, lagTime=${MP_LAG_TIME}| [lt_x,lt_y,li_x,li_y,lm_x,lm_y,lr_x,lr_y,lp_x,lp_y,rt_x,rt_y,ri_x,ri_y,rm_x,rm_y,rr_x,rr_y,rp_x,rp_y].collect{|v| Lag.kr(v, lagTime) } }`;

// ── Host-side macro curve state ──────────────────────────────────────────
let _macros = [];            // [{ name, macroNum, points, position, playing, durationSec, durationBeats, loop }]
let _macroTimer = null;
let _macroLastTickMs = 0;

// ── Host-side dynamic-buffer (live looper) state ─────────────────────────
let _dynbufs = new Map();    // slot (int) → { slot, source, playing, start, end, tempoMul, rateMul, chan, pulseDivide, hasSnapshot }
let _dynbufSysSent = false;  // SC setup code emitted? (re-emit on demand; sclang side is idempotent)
let _dynbufNumChannels = 2;
let _dynbufRingSeconds = 32;
let _dynbufSnapshotSeconds = 8;
let _dynbufWriteToDisk = true;

// Notification listener: SC sends /envilDynbufWritten <slot> <path> <sr> <nch> <numFrames>
// once Buffer.write completes on the audio server side.
let _dynbufNotifyPort = null;
let _dynbufNotifyPortNumber = 0;
let _dynbufNotifyReady = false;

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

    // ── MediaPipe config ─────────────────────────────────────────────────
    const mpCfg = vscode.workspace.getConfiguration('envil.mediapipe');
    _mpEnabled = mpCfg.get('enabled', false);
    _mpSendRate = mpCfg.get('sendRate', 15);
    _mpModelComplexity = mpCfg.get('modelComplexity', 1);
    _mpVideoOpacity = mpCfg.get('videoOpacity', 0.25);
    _mpDrawLandmarks = mpCfg.get('drawLandmarks', true);

    // ── Dynbuf config ────────────────────────────────────────────────────
    const dbCfg = vscode.workspace.getConfiguration('envil.dynbuf');
    _dynbufNumChannels     = Math.max(1, Math.min(16, dbCfg.get('numChannels', 2)));
    _dynbufRingSeconds     = Math.max(1, Number(dbCfg.get('ringSeconds', 32)));
    _dynbufSnapshotSeconds = Math.max(0.1, Number(dbCfg.get('snapshotSeconds', 8)));
    _dynbufWriteToDisk     = !!dbCfg.get('writeToDisk', true);

    // Re-read settings on change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('envil.sequencer')) {
                const cfg = vscode.workspace.getConfiguration('envil.sequencer');
                _seqOscTargetPort = cfg.get('oscTargetPort', 57120);
                _seqOscTargetHost = cfg.get('oscTargetHost', '127.0.0.1');
                _seqOscEnabled = cfg.get('oscEnabled', true);
            }
            if (e.affectsConfiguration('envil.dynbuf')) {
                const dc = vscode.workspace.getConfiguration('envil.dynbuf');
                const oldNCh = _dynbufNumChannels;
                const oldRing = _dynbufRingSeconds;
                _dynbufNumChannels     = Math.max(1, Math.min(16, dc.get('numChannels', 2)));
                _dynbufRingSeconds     = Math.max(1, Number(dc.get('ringSeconds', 32)));
                _dynbufSnapshotSeconds = Math.max(0.1, Number(dc.get('snapshotSeconds', 8)));
                _dynbufWriteToDisk     = !!dc.get('writeToDisk', true);
                // If channel count or ring length changed, the SC ring buffer needs re-alloc
                if (oldNCh !== _dynbufNumChannels || oldRing !== _dynbufRingSeconds) {
                    _dynbufSysSent = false;
                    log(`  ⟳ dynbuf cfg changed → ring system will rebuild on next snapshot`);
                }
            }
            if (e.affectsConfiguration('envil.mediapipe')) {
                const mc = vscode.workspace.getConfiguration('envil.mediapipe');
                _mpEnabled = mc.get('enabled', false);
                _mpSendRate = mc.get('sendRate', 15);
                _mpModelComplexity = mc.get('modelComplexity', 1);
                _mpVideoOpacity = mc.get('videoOpacity', 0.25);
                _mpDrawLandmarks = mc.get('drawLandmarks', true);
                // Push config to webview overlay
                if (_panel) {
                    _panel.webview.postMessage({
                        type: 'mediapipe-config',
                        drawLandmarks: _mpDrawLandmarks,
                    });
                }
                // Push config to capture page via socket.io
                const io = _getIO && _getIO();
                if (io) {
                    io.emit('mediapipe-config', {
                        enabled: _mpEnabled,
                        sendRate: _mpSendRate,
                        modelComplexity: _mpModelComplexity,
                        videoOpacity: _mpVideoOpacity,
                        drawLandmarks: _mpDrawLandmarks,
                    });
                }
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

    // Allow webview to fetch dynbuf WAVs from .envil/dynbufs/
    const localRoots = [vscode.Uri.file(context.extensionPath)];
    if (_workspacePath) {
        localRoots.push(vscode.Uri.file(path.join(_workspacePath, ENVIL_DIR)));
        try { fs.mkdirSync(path.join(_workspacePath, ENVIL_DIR, 'dynbufs'), { recursive: true }); } catch (_) {}
    }

    _panel = vscode.window.createWebviewPanel(
        'envil.touchKnobs',
        '🎛 Touch Knobs',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
            enableScripts: true,
            retainContextWhenHidden: true,   // keep canvas alive when tab not visible
            localResourceRoots: localRoots,
        }
    );

    // Open the dynbuf notify port (idempotent). SC will be told its number
    // each time a snapshot is generated, so we don't need a fixed port.
    ensureDynbufNotifyPort();

    // Load HTML
    const saved = loadLayout();
    const htmlPath = path.join(context.extensionPath, 'touch-knobs-panel.html');
    let rawHtml = fs.readFileSync(htmlPath, 'utf-8');

    const initialStateScript = `globalThis.__ENVIL_INITIAL_STATE__ = ${serializeForWebview(saved || {})};
    globalThis.__ENVIL_MP_CONFIG__ = ${JSON.stringify({
        drawLandmarks: _mpDrawLandmarks,
    })};`;
    _panel.webview.html = rawHtml
        .replace(/__ENVIL_CSP_SRC__/g, _panel.webview.cspSource)
        .replace(
            'const vscode = acquireVsCodeApi();',
            `const vscode = acquireVsCodeApi();\n${initialStateScript}`,
        );

    // Fresh debug log per panel session (rotates previous to .1)
    try {
        const lp = getWebviewLogPath();
        try { if (fs.existsSync(lp)) fs.renameSync(lp, lp + '.1'); } catch (_) {}
        fs.writeFileSync(lp, `[${new Date().toISOString()}] INFO  [panel] session start\n`);
        if (_hydraOutput) _hydraOutput.appendLine(`[touch-knobs] webview log: ${lp}`);
    } catch (_) {}

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

// ── Webview debug log file ───────────────────────────────────────────────
let _webviewLogPath = null;
const WEBVIEW_LOG_MAX_BYTES = 512 * 1024; // rotate at 512 KB

function getWebviewLogPath() {
    if (_webviewLogPath) return _webviewLogPath;
    const base = _workspacePath
        ? path.join(_workspacePath, ENVIL_DIR)
        : (os.tmpdir ? os.tmpdir() : '.');
    try { fs.mkdirSync(base, { recursive: true }); } catch (_) {}
    _webviewLogPath = path.join(base, 'webview.log');
    return _webviewLogPath;
}

function appendWebviewLog(entry) {
    try {
        const p = getWebviewLogPath();
        // simple rotation: if file > MAX, rename to .1 and start fresh
        try {
            const st = fs.statSync(p);
            if (st.size > WEBVIEW_LOG_MAX_BYTES) {
                try { fs.renameSync(p, p + '.1'); } catch (_) {}
            }
        } catch (_) { /* file may not exist yet */ }
        const ts = new Date(entry.time || Date.now()).toISOString();
        const lvl = (entry.level || 'log').toUpperCase().padEnd(5);
        let line = `[${ts}] ${lvl} ${entry.message || ''}`;
        if (entry.source) line += `  (${entry.source}:${entry.line || '?'})`;
        if (entry.stack)  line += `\n    ${String(entry.stack).split('\n').join('\n    ')}`;
        fs.appendFileSync(p, line + '\n');
    } catch (e) {
        if (_hydraOutput) _hydraOutput.appendLine(`[webview-log] write failed: ${e.message}`);
    }
}

function handleMessage(msg) {
    switch (msg.type) {

        case 'webview-log': {
            appendWebviewLog(msg);
            return;
        }

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

        // ── MediaPipe landmark messages ──────────────────────────────────

        case 'mediapipe-landmarks': {
            // Process even if _mpEnabled is false (user may have toggled via UI button)
            const now = Date.now();
            const minInterval = 1000 / Math.max(1, _mpSendRate);
            if (now - _mpLastSendTime < minInterval) break;
            _mpLastSendTime = now;

            const lm = msg.landmarks;
            if (!lm) break;

            // Build a single batched SC expression for all landmark proxies.
            // Each proxy is ~mp_<name> with \x, \y (normalized 0–1).
            // x is mirrored (1-x) so left=left from the performer's perspective.
            const parts = [];
            const hydraData = {};

            const ensureProxy = (name) =>
                `if(~mp_${name}.source.isNil, { ~mp_${name}.mold(2, \\control); ~mp_${name} = ${MP_PROXY_SRC} }, ` +
                `{ if(Server.default.serverRunning and: { ~mp_${name}.isPlaying.not }, { ~mp_${name}.send }) })`;

            const setProxy = (name, x, y) => {
                if (x == null || y == null) return;
                parts.push(`${ensureProxy(name)}; ~mp_${name}.set(\\x, ${x}, \\y, ${y})`);
                hydraData[name] = { x, y };
            };

            // ── Pose landmarks ────────────────────────────────────────────
            if (lm.pose) {
                if (lm.pose.nose)           setProxy('nose',    lm.pose.nose.x,           lm.pose.nose.y);
                if (lm.pose.leftWrist)      setProxy('lwrist',  lm.pose.leftWrist.x,      lm.pose.leftWrist.y);
                if (lm.pose.rightWrist)     setProxy('rwrist',  lm.pose.rightWrist.x,     lm.pose.rightWrist.y);
                if (lm.pose.leftShoulder)   setProxy('lshldr',  lm.pose.leftShoulder.x,  lm.pose.leftShoulder.y);
                if (lm.pose.rightShoulder)  setProxy('rshldr',  lm.pose.rightShoulder.x, lm.pose.rightShoulder.y);
                if (lm.pose.leftElbow)      setProxy('lelbow',  lm.pose.leftElbow.x,      lm.pose.leftElbow.y);
                if (lm.pose.rightElbow)     setProxy('relbow',  lm.pose.rightElbow.x,     lm.pose.rightElbow.y);
                if (lm.pose.leftHip)        setProxy('lhip',    lm.pose.leftHip.x,        lm.pose.leftHip.y);
                if (lm.pose.rightHip)       setProxy('rhip',    lm.pose.rightHip.x,       lm.pose.rightHip.y);
            }

            // ── Hand landmarks (fingertips, 2ch each = x,y) ───────────
            const fingerNames = ['thumb', 'index', 'middle', 'ring', 'pinky'];
            const fingerProxyNames = { thumb: 'thumb', index: 'idx', middle: 'mid', ring: 'ring', pinky: 'pinky' };

            if (lm.leftHand) {
                for (const fn of fingerNames) {
                    const f = lm.leftHand[fn];
                    if (f) setProxy('l' + fingerProxyNames[fn], f.x, f.y);
                }
            }
            if (lm.rightHand) {
                for (const fn of fingerNames) {
                    const f = lm.rightHand[fn];
                    if (f) setProxy('r' + fingerProxyNames[fn], f.x, f.y);
                }
            }

            // ── Fingertip collector proxies ────────────────────────────
            // ~mp_lfingers (10ch), ~mp_rfingers (10ch), ~mp_fingers (20ch)
            const argNames5 = ['thumb', 'idx', 'mid', 'ring', 'pinky'];

            const buildFingerCollector = (handData, proxyName, nCh, src, argPfx) => {
                if (!handData) return;
                const args = argNames5.map((a, i) => {
                    const f = handData[fingerNames[i]];
                    return `\\${argPfx}${a}_x, ${f ? f.x : 0}, \\${argPfx}${a}_y, ${f ? f.y : 0}`;
                }).join(', ');
                const ensure = `if(~mp_${proxyName}.source.isNil, { ~mp_${proxyName}.mold(${nCh}, \\control); ~mp_${proxyName} = ${src} }, ` +
                    `{ if(Server.default.serverRunning and: { ~mp_${proxyName}.isPlaying.not }, { ~mp_${proxyName}.send }) })`;
                parts.push(`${ensure}; ~mp_${proxyName}.set(${args})`);
            };

            if (lm.leftHand)
                buildFingerCollector(lm.leftHand, 'lfingers', 10, MP_FINGERS5_SRC, '');
            if (lm.rightHand)
                buildFingerCollector(lm.rightHand, 'rfingers', 10, MP_FINGERS5_SRC, '');

            // Global 20-channel collector
            if (lm.leftHand || lm.rightHand) {
                const lh = lm.leftHand || {}, rh = lm.rightHand || {};
                const lPre = ['lt','li','lm','lr','lp'], rPre = ['rt','ri','rm','rr','rp'];
                const allPre = [...lPre, ...rPre];
                const allFingers = [...fingerNames.map(fn => lh[fn]), ...fingerNames.map(fn => rh[fn])];
                const args20 = allPre.map((p, i) => {
                    const f = allFingers[i];
                    return `\\${p}_x, ${f ? f.x : 0}, \\${p}_y, ${f ? f.y : 0}`;
                }).join(', ');
                const ensure20 = `if(~mp_fingers.source.isNil, { ~mp_fingers.mold(20, \\control); ~mp_fingers = ${MP_FINGERS10_SRC} }, ` +
                    `{ if(Server.default.serverRunning and: { ~mp_fingers.isPlaying.not }, { ~mp_fingers.send }) })`;
                parts.push(`${ensure20}; ~mp_fingers.set(${args20})`);
            }

            // ── Face key points ───────────────────────────────────────────
            if (lm.face) {
                if (lm.face.noseTip)     setProxy('fnose', lm.face.noseTip.x,     lm.face.noseTip.y);
                if (lm.face.mouthCenter) setProxy('fmouth', lm.face.mouthCenter.x, lm.face.mouthCenter.y);
            }

            // ── Aggregated metrics ────────────────────────────────────────
            if (lm.handOpenness) {
                // ~mp_open: x = left hand openness (0–1), y = right hand openness (0–1)
                const lo = lm.handOpenness.left != null ? lm.handOpenness.left : 0;
                const ro = lm.handOpenness.right != null ? lm.handOpenness.right : 0;
                setProxy('open', lo, ro);
            }

            if (parts.length > 0) {
                sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${parts.join('; ')} })`, true);
            }
            sendHydra('mediapipe-update', hydraData);
            break;
        }

        case 'mediapipe-status': {
            if (msg.status === 'starting') log('  📷 MediaPipe Holistic starting…');
            else if (msg.status === 'started') log('  📷 MediaPipe Holistic started');
            else if (msg.status === 'stopped') log('  📷 MediaPipe Holistic stopped');
            else if (msg.status === 'error') {
                log(`  ⚠ MediaPipe error: ${msg.error}`);
                vscode.window.showWarningMessage(`MediaPipe: ${msg.error}`);
            }
            break;
        }

        case 'mediapipe-open-capture': {
            // User clicked Body button — open the capture page in the default browser
            // Port 3003 = separate origin → Chrome allows independent camera selection
            const url = 'http://localhost:3003/mediapipe/capture.html';
            vscode.env.openExternal(vscode.Uri.parse(url));
            log('  📷 Opening MediaPipe capture page in browser…');
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
            }
            seqStopTimer();
            macroStopAll();
            break;
        }

        case 'seq-sync-all': {
            for (const s of _seqs) {
                s.currentStep = -1;
            }
            for (const m of _macros) {
                m.position = 0;
                macroEmitImmediate(m, { includePoints: false });
            }
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

        // ── Dynamic buffer (live looper) messages ──────────────────────

        case 'dynbuf-register': {
            // Panel created (or restored) a dynbuf slot. Cache state + ensure
            // the SC control proxies exist with the panel's current values.
            const slot = positiveInteger(msg.slot, 0) - 1 < 0 ? Math.max(0, Number(msg.slot) | 0) : Number(msg.slot) | 0;
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            const d = {
                slot: slotIdx,
                playing: msg.playing !== false,
                start:       clamp01(msg.start       != null ? msg.start       : 0),
                end:         clamp01(msg.end         != null ? msg.end         : 1),
                tempoMul:    clamp01(msg.tempoMul    != null ? msg.tempoMul    : 0.5),
                rateMul:     clamp01(msg.rateMul     != null ? msg.rateMul     : 0.5),
                chan:        clamp01(msg.chan        != null ? msg.chan        : 0),
                pulseDivide: clamp01(msg.pulseDivide != null ? msg.pulseDivide : 0.5),
                hasSnapshot: false,
                lastWavPath: typeof msg.lastWavPath === 'string' ? msg.lastWavPath : null,
            };
            _dynbufs.set(slotIdx, d);
            // Push the recorder system + control proxies (idempotent on SC side)
            sendSC(dynbufBuildSetupAndCtrls(d), true);
            // If we have a persisted WAV from a previous session and the file
            // still exists, reload it (so ~bufPlay_N becomes audible without
            // requiring a fresh SNAP) and notify the webview to draw it.
            if (d.lastWavPath) {
                try {
                    if (fs.existsSync(d.lastWavPath)) {
                        d.hasSnapshot = true;
                        sendSC(dynbufBuildReloadFromDisk(d), true);
                        if (_panel) {
                            const uri = _panel.webview.asWebviewUri(vscode.Uri.file(d.lastWavPath));
                            _panel.webview.postMessage({
                                type: 'dynbuf-wave-ready',
                                slot: slotIdx,
                                uri: uri.toString(),
                                filePath: d.lastWavPath,
                                nch: _dynbufNumChannels,
                                restored: true,
                            });
                        }
                        log(`  ↻ dynbuf slot=${slotIdx} reloaded from ${path.relative(_workspacePath || '.', d.lastWavPath)}`);
                    }
                } catch (e) {
                    console.warn('[touch-knobs] dynbuf reload failed:', e.message);
                }
            }
            log(`  ＋ dynbuf slot=${slotIdx}  (~bufPlay_${slotIdx})`);
            break;
        }

        case 'dynbuf-remove': {
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            const d = _dynbufs.get(slotIdx);
            if (!d) break;
            sendSC(dynbufBuildRemove(slotIdx), true);
            _dynbufs.delete(slotIdx);
            log(`  ✖ removed dynbuf slot=${slotIdx} (~bufPlay_${slotIdx})`);
            break;
        }

        case 'dynbuf-reload': {
            // Manual recovery hatch: re-emit the ring recorder setup, the per-slot
            // control proxies, and (if the WAV exists on disk) Buffer.read it
            // into ~bufPlay_N again. Also re-notify the webview to redraw the
            // waveform. Use this when the boot-init didn't fire (e.g. server
            // was booted manually) or after some SC-side mishap.
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            let d = _dynbufs.get(slotIdx);
            if (!d) {
                // Build a minimal stub from the message so SC ctrls can still be installed
                d = {
                    slot: slotIdx,
                    playing: msg.playing !== false,
                    start:       clamp01(msg.start       != null ? msg.start       : 0),
                    end:         clamp01(msg.end         != null ? msg.end         : 1),
                    tempoMul:    clamp01(msg.tempoMul    != null ? msg.tempoMul    : 0.5),
                    rateMul:     clamp01(msg.rateMul     != null ? msg.rateMul     : 0.5),
                    chan:        clamp01(msg.chan        != null ? msg.chan        : 0),
                    pulseDivide: clamp01(msg.pulseDivide != null ? msg.pulseDivide : 0.5),
                    hasSnapshot: false,
                    lastWavPath: typeof msg.lastWavPath === 'string' ? msg.lastWavPath : null,
                };
                _dynbufs.set(slotIdx, d);
            }
            // 1) Re-arm the ring recorder + per-slot ctrls (idempotent on SC side)
            _dynbufSysSent = false; // force setup re-emit
            sendSC(dynbufBuildSetupAndCtrls(d), true);
            // 2) If we know a WAV on disk, reload it and redraw
            const wavPath = d.lastWavPath || (_workspacePath
                ? path.join(_workspacePath, ENVIL_DIR, 'dynbufs', `slot_${slotIdx}.wav`)
                : null);
            if (wavPath && fs.existsSync(wavPath)) {
                d.lastWavPath = wavPath;
                d.hasSnapshot = true;
                sendSC(dynbufBuildReloadFromDisk(d), true);
                if (_panel) {
                    const uri = _panel.webview.asWebviewUri(vscode.Uri.file(wavPath));
                    _panel.webview.postMessage({
                        type: 'dynbuf-wave-ready',
                        slot: slotIdx,
                        uri: uri.toString(),
                        filePath: wavPath,
                        nch: _dynbufNumChannels,
                        restored: true,
                    });
                }
                log(`  ⟳ dynbuf slot=${slotIdx} manual reload from ${path.relative(_workspacePath || '.', wavPath)}`);
            } else {
                log(`  ⟳ dynbuf slot=${slotIdx} reload: no WAV on disk yet — ctrls re-armed`);
            }
            break;
        }

        case 'dynbuf-control': {
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            const d = _dynbufs.get(slotIdx);
            if (!d) break;
            const key = String(msg.key || '');
            if (!['start', 'end', 'tempoMul', 'rateMul', 'chan', 'pulseDivide'].includes(key)) break;
            const val = clamp01(msg.value);
            d[key] = val;
            sendSC(dynbufBuildSetCtrl(slotIdx, key, val), true);
            break;
        }

        case 'dynbuf-play-toggle': {
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            const d = _dynbufs.get(slotIdx);
            if (!d) break;
            d.playing = !!msg.playing;
            const code = dynbufBuildMute(slotIdx, !d.playing);
            if (code) sendSC(code, true);
            break;
        }

        case 'dynbuf-snapshot': {
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            let d = _dynbufs.get(slotIdx);
            if (!d) {
                // Slot wasn't registered yet — create a minimal stub
                d = { slot: slotIdx, playing: true, start: 0, end: 1,
                      tempoMul: 0.5, rateMul: 0.5, chan: 0, pulseDivide: 0.5, hasSnapshot: false };
                _dynbufs.set(slotIdx, d);
            }
            d.hasSnapshot = true;
            sendSC(dynbufBuildSnapshot(d), true);
            // Host-side fallback: poll for the WAV file appearing on disk and
            // push a wave-ready message even if SC's OSC notify never arrives.
            scheduleDynbufWaveFallback(d);
            log(`  ⏺ dynbuf snapshot slot=${slotIdx}`);
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
    const updates = [];
    for (const m of _macros) {
        m.playing = false;
        updates.push({ name: m.name, position: m.position, val: macroSampleValue(m, m.position), playing: false, loop: !!m.loop });
    }
    macroStopTimer();
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
// DYNBUF NOTIFY OSC LISTENER
// ─────────────────────────────────────────────────────────────────────────────
// SC sends /envilDynbufWritten <slot:i> <path:s> <sr:i> <nch:i> <numFrames:i>
// once Buffer.write completes. We forward the path to the webview as a
// webview-safe URI so it can fetch the WAV and draw a real waveform.

function ensureDynbufNotifyPort() {
    if (_dynbufNotifyPort) return;
    try {
        _dynbufNotifyPort = new osc.UDPPort({
            localAddress: '127.0.0.1',
            localPort: 0,           // OS picks ephemeral
            broadcast: false,
        });
        _dynbufNotifyPort.on('ready', () => {
            _dynbufNotifyReady = true;
            try { _dynbufNotifyPortNumber = _dynbufNotifyPort.socket.address().port; }
            catch (_) { _dynbufNotifyPortNumber = 0; }
            log(`  ⟲ dynbuf notify port ready @ udp://127.0.0.1:${_dynbufNotifyPortNumber}`);
        });
        _dynbufNotifyPort.on('error', (err) => {
            console.warn('[touch-knobs] dynbuf notify port error:', err.message);
        });
        _dynbufNotifyPort.on('message', (oscMsg) => {
            try { handleDynbufWritten(oscMsg); }
            catch (e) { console.warn('[touch-knobs] dynbuf notify handler error:', e.message); }
        });
        _dynbufNotifyPort.open();
    } catch (e) {
        console.warn('[touch-knobs] failed to open dynbuf notify port:', e.message);
        _dynbufNotifyPort = null;
        _dynbufNotifyReady = false;
    }
}

function handleDynbufWritten(oscMsg) {
    if (!oscMsg || oscMsg.address !== '/envilDynbufWritten') return;
    const a = oscMsg.args || [];
    const slot       = Number(a[0] && (a[0].value != null ? a[0].value : a[0])) | 0;
    const filePath   = String(a[1] && (a[1].value != null ? a[1].value : a[1]));
    const sampleRate = Number(a[2] && (a[2].value != null ? a[2].value : a[2])) | 0;
    const nch        = Number(a[3] && (a[3].value != null ? a[3].value : a[3])) | 0;
    const numFrames  = Number(a[4] && (a[4].value != null ? a[4].value : a[4])) | 0;
    if (!filePath) return;
    // Persist on the per-slot state
    const d = _dynbufs.get(slot);
    if (d) {
        d.lastWavPath = filePath;
        d.lastWavSampleRate = sampleRate;
        d.lastWavNumChannels = nch;
        d.lastWavNumFrames = numFrames;
        d.hasSnapshot = true;
    }
    // Forward to webview as a webview-safe URI
    if (_panel) {
        try {
            const uri = _panel.webview.asWebviewUri(vscode.Uri.file(filePath));
            _panel.webview.postMessage({
                type: 'dynbuf-wave-ready',
                slot,
                uri: uri.toString(),
                filePath,
                sampleRate,
                nch,
                numFrames,
            });
        } catch (e) {
            console.warn('[touch-knobs] asWebviewUri failed:', e.message);
        }
    }
    log(`  📊 dynbuf wav written slot=${slot} (${nch}ch, ${sampleRate} sr, ${numFrames} frames)`);
}

// Fallback path: after triggering a snapshot, watch for the WAV file appearing
// on disk and push wave-ready to the webview. This makes the OSC notify port
// optional — if it works, the webview gets two updates (cheap), if it doesn't,
// the user still sees the waveform.
function scheduleDynbufWaveFallback(d) {
    if (!_workspacePath || !_dynbufWriteToDisk) return;
    const filePath = path.join(_workspacePath, ENVIL_DIR, 'dynbufs', `slot_${d.slot}.wav`);
    const startMtime = (() => {
        try { return fs.statSync(filePath).mtimeMs; } catch (_) { return 0; }
    })();
    const startedAt = Date.now();
    const maxWaitMs = (Number(_dynbufSnapshotSeconds) + 4) * 1000;
    const tick = () => {
        if (!_panel) return;
        let m = 0;
        try { m = fs.statSync(filePath).mtimeMs; } catch (_) { m = 0; }
        if (m > startMtime) {
            try {
                const uri = _panel.webview.asWebviewUri(vscode.Uri.file(filePath));
                d.lastWavPath = filePath;
                d.hasSnapshot = true;
                _panel.webview.postMessage({
                    type: 'dynbuf-wave-ready',
                    slot: d.slot,
                    uri: uri.toString(),
                    filePath,
                    nch: _dynbufNumChannels,
                });
            } catch (e) {
                console.warn('[touch-knobs] dynbuf fallback push failed:', e.message);
            }
            return;
        }
        if (Date.now() - startedAt > maxWaitMs) {
            log(`  ⚠ dynbuf slot=${d.slot}: WAV never appeared at ${filePath}`);
            return;
        }
        setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
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

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC BUFFER (live looper) — SC code emitters
// ─────────────────────────────────────────────────────────────────────────────
//
// Port of e[\setupBufferSys] from my_footcontroller.sc.
// On the SC side we keep:
//   currentEnvironment[\envilBufRecReady]   — guard (true once setup done)
//   currentEnvironment[\envilBufRecIns]     — Buffer (ring, audio inputs)
//   currentEnvironment[\envilBufRecOuts]    — Buffer (ring, output busses)
//   currentEnvironment[\envilBufRecPhase]   — Float, current write head (frames)
//   currentEnvironment[\envilBufRecChans]   — Int, channel count
//   currentEnvironment[\envilDynBufs]       — List of snapshot Buffers (kept alive)
//   ~envilBufRec                            — the always-running recorder proxy
//   OSCdef \envilBufRecPhase                — listens on /envilBufRecPhase
//
// Per slot N:
//   ~bufPlay_N            — the player NodeProxy (audio, mono)
//   ~bufPlay_N_idx        — control proxy holding the snapshot bufnum (\val)
//   ~bufPlay_N_<arg>      — control proxy per arg (start, end, tempoMul,
//                            rateMul, chan, pulseDivide) which the player
//                            reads from via NodeProxy bus-mapping.
//   ~bufPlay_N            (play/stop via mute / set \amp 0)
//
// Setup is emitted lazily, every time a slot operation happens; the guard
// makes it a no-op on subsequent calls. If config changes (channel count
// or ring length) we reset _dynbufSysSent → next operation re-emits the
// setup which clears + re-allocates.

function dynbufBuildSetup() {
    const nch = _dynbufNumChannels;
    const ringSec = _dynbufRingSeconds;
    // Channel count is baked into the recorder synth (compile-time literal).
    // NOTE: We use Library (global class Dictionary) for non-audio state,
    // because ProxySpace.put wraps ANY value in a NodeProxy, which would
    // make `Library.at(\envil, \bufRecPhase)` return a NodeProxy instead
    // of a Float.
    return [
        `if(currentEnvironment.isKindOf(ProxySpace), {`,
        ` if(Library.at(\\envil, \\bufRecReady).isNil or: { Library.at(\\envil, \\bufRecChans) != ${nch} }, {`,
        `  Routine({`,
        `   [\\bufRecIns, \\bufRecOuts].do{|k| var b = Library.at(\\envil, k); if(b.notNil and: { b.isKindOf(Buffer) }, { b.free }) };`,
        `   Library.put(\\envil, \\bufRecChans, ${nch});`,
        `   Library.put(\\envil, \\bufRecPhase, 0.0);`,
        `   Library.put(\\envil, \\dynBufs, List.new);`,
        `   Library.put(\\envil, \\bufRecIns,  Buffer.alloc(Server.default, Server.default.sampleRate * ${ringSec}, ${nch}));`,
        `   Library.put(\\envil, \\bufRecOuts, Buffer.alloc(Server.default, Server.default.sampleRate * ${ringSec}, ${nch}));`,
        `   Server.default.sync;`,
        `   ~envilBufRec.clear; ~envilBufRec.ar(1);`,
        `   ~envilBufRec = { |bufIn= -1, bufOut= -1|`,
        `     var phase = Phasor.ar(0, BufRateScale.kr(bufIn), 0, BufFrames.kr(bufIn));`,
        `     var ins  = ${nch}.collect{|i| SoundIn.ar(i) };`,
        `     var outs = ${nch}.collect{|i| InFeedback.ar(i, 1) };`,
        `     BufWr.ar(ins,  bufIn,  phase);`,
        `     BufWr.ar(outs, bufOut, phase);`,
        `     SendReply.kr(Impulse.kr(50), '/envilBufRecPhase', [A2K.kr(phase)]);`,
        `     DC.ar(0);`,
        `   };`,
        `   ~envilBufRec.set(\\bufIn, Library.at(\\envil, \\bufRecIns).bufnum, \\bufOut, Library.at(\\envil, \\bufRecOuts).bufnum);`,
        `   ~envilBufRec.play;`,
        `   OSCdef(\\envilBufRecPhase, { |msg| Library.put(\\envil, \\bufRecPhase, msg[3]) }, '/envilBufRecPhase');`,
        `   Library.put(\\envil, \\bufRecReady, true);`,
        `   ">>> envil: dynbuf system ready (chans=${nch}, ring=${ringSec}s)".postln;`,
        `  }).play;`,
        ` });`,
        `})`,
    ].join(' ');
}

// Ensures the per-slot control proxies (~bufPlay_N_start etc.) exist and
// hold the current panel values. Idempotent.
function dynbufBuildCtrlsForSlot(d) {
    const slot = d.slot;
    const keys = [
        ['start',       d.start],
        ['end',         d.end],
        ['tempoMul',    d.tempoMul],
        ['rateMul',     d.rateMul],
        ['chan',        d.chan],
        ['pulseDivide', d.pulseDivide],
    ];
    const ctrlSrc = `{ |val=0, lagTime=0.02| Lag.kr(val, lagTime) }`;
    // Re-install the control source whenever the proxy lacks a \val arg
    // (e.g. user did `~bufPlay_N_rateMul = 0.5` in their code, which replaced
    // the source with a constant). This lets the UI knob "win back" control.
    const needsCtrl = (p) => `(${p}.source.isNil or: { ${p}.controlNames.isNil or: { ${p}.controlNames.any({|cn| cn.name == \\val }).not } })`;
    const parts = keys.map(([k, v]) => {
        const p = `~bufPlay_${slot}_${k}`;
        return `if(${needsCtrl(p)}, { ${p}.kr(1); ${p} = ${ctrlSrc} }, { if(Server.default.serverRunning and: { ${p}.isPlaying.not }, { ${p}.send }) }); ${p}.set(\\val, ${Number(v).toFixed(6)})`;
    });
    // Bufnum index proxy (~bufPlay_N_idx) holding the snapshot bufnum
    const idx = `~bufPlay_${slot}_idx`;
    parts.unshift(`if(${needsCtrl(idx)}, { ${idx}.kr(1); ${idx} = { |val=0, lagTime=0| Lag.kr(val, lagTime) } })`);
    return `if(currentEnvironment.isKindOf(ProxySpace), { ${parts.join('; ')} })`;
}

function dynbufBuildSetupAndCtrls(d) {
    let pieces = [];
    if (!_dynbufSysSent) {
        pieces.push(dynbufBuildSetup());
        _dynbufSysSent = true;
    }
    pieces.push(dynbufBuildCtrlsForSlot(d));
    return pieces.join('; ');
}

function dynbufBuildSetCtrl(slot, key, val) {
    if (!_dynbufSysSent) {
        // No SC setup yet; just cache, will be emitted on first snapshot/register.
        // Still try to push the value in case proxies happen to already exist.
    }
    const p = `~bufPlay_${slot}_${key}`;
    const ctrlSrc = `{ |val=0, lagTime=0.02| Lag.kr(val, lagTime) }`;
    // If user overrode the proxy source (e.g. `~bufPlay_N_rateMul = 0.5`),
    // it no longer has a \val arg — reinstall our control synth so the UI
    // knob regains control.
    const needsCtrl = `(${p}.source.isNil or: { ${p}.controlNames.isNil or: { ${p}.controlNames.any({|cn| cn.name == \\val }).not } })`;
    return `if(currentEnvironment.isKindOf(ProxySpace), { if(${needsCtrl}, { ${p}.kr(1); ${p} = ${ctrlSrc} }); ${p}.set(\\val, ${Number(val).toFixed(6)}) })`;
}

function dynbufBuildMute(slot, muted) {
    // No-op: ~bufPlay_N is a NodeProxy living in the user's ProxySpace.
    // The user routes it via their own chain (e.g. ~out <<> ~bufPlay_N),
    // so we don't .play/.stop it here. The play/mute toggle in the UI
    // is currently a no-op on the SC side. A future enhancement could
    // freeze the trigger via a \gate ctrl proxy.
    return '';
}

function dynbufBuildRemove(slot) {
    const proxies = [
        `~bufPlay_${slot}`,
        `~bufPlay_${slot}_idx`,
        `~bufPlay_${slot}_start`,
        `~bufPlay_${slot}_end`,
        `~bufPlay_${slot}_tempoMul`,
        `~bufPlay_${slot}_rateMul`,
        `~bufPlay_${slot}_chan`,
        `~bufPlay_${slot}_pulseDivide`,
    ];
    return `if(currentEnvironment.isKindOf(ProxySpace), { ${proxies.map(p => `${p}.clear`).join('; ')} })`;
}

function dynbufBuildSnapshot(d) {
    const slot = d.slot;
    const nch = _dynbufNumChannels;
    const snapSec = _dynbufSnapshotSeconds;
    // Always read from the inputs ring buffer (like original my_footcontroller.sc).
    // chan selector picks among the snapshot's channels.
    const sourceKey = '\\bufRecIns';
    const writeToDisk = !!_dynbufWriteToDisk;
    const diskPath = writeToDisk && _workspacePath
        ? path.join(_workspacePath, ENVIL_DIR, 'dynbufs').replace(/\\/g, '/')
        : null;

    // ALWAYS emit setup — the SC side is idempotent (gated by
    // Library.at(\envil, \bufRecReady)) and this avoids the trap where
    // the JS-side flag was flipped to true while sclang wasn't yet in a
    // ProxySpace (so the setup body silently did nothing).
    let setup = dynbufBuildSetup() + '; ';
    _dynbufSysSent = true;
    // Also (re)ensure per-slot control proxies exist before the player proxy
    // tries to map them in.
    const ctrls = dynbufBuildCtrlsForSlot(d);

    // The player proxy synth. Channel count baked in.
    // ~t is envil's tempo proxy (beats per second). Defaults to 1 if absent.
    const playerFunc = [
        `{ |bufNum=0, origTempo=1|`,
        `  var t = if(~t.source.notNil, { Mix(~t.kr) }, { DC.kr(1) });`,
        `  var start       = ~bufPlay_${slot}_start.kr;`,
        `  var endC        = ~bufPlay_${slot}_end.kr;`,
        `  var tempoMul    = ~bufPlay_${slot}_tempoMul.kr;`,
        `  var rateMul     = ~bufPlay_${slot}_rateMul.kr;`,
        `  var chan        = ~bufPlay_${slot}_chan.kr;`,
        `  var pulseDivide = ~bufPlay_${slot}_pulseDivide.kr;`,
        `  var tempoFac    = 2.0 ** (((tempoMul * 8) - 4).round);`,
        `  var pulse       = Impulse.kr(t * 128 * tempoFac);`,
        `  var divFactor   = 2 ** ((pulseDivide * 7).round);`,
        `  var trigger     = PulseDivider.kr(pulse, (128 * 32) / divFactor);`,
        `  var actualRate  = 2.0 ** (((rateMul * 8) - 4).round);`,
        `  var rate        = Latch.kr(actualRate, trigger);`,
        `  var startFrame  = Latch.kr(BufFrames.kr(bufNum) * start, trigger);`,
        `  var endFrame    = Latch.kr(BufFrames.kr(bufNum) * endC,  trigger).max(startFrame + 1);`,
        `  var durLocal    = endFrame - startFrame;`,
        `  var speed       = t / origTempo;`,
        `  var phaseR      = Sweep.ar(trigger, SampleRate.ir / durLocal * rate * speed).linlin(0, 1, startFrame, endFrame);`,
        `  var bp          = BufRd.ar(${nch}, bufNum, phaseR, interpolation: 1, loop: 0);`,
        `  var chanIdx     = K2A.ar(chan.linlin(0, 1, 0, ${nch - 1}).round);`,
        `  var bpC         = Select.ar(chanIdx, bp);`,
        `  PitchShift.ar(bpC, pitchRatio: rate.reciprocal / speed);`,
        `}`,
    ].join(' ');

    const writeBlock = writeToDisk && diskPath
        ? ` File.mkdir("${diskPath}"); snap.write("${diskPath}/slot_${slot}.wav", "WAV", "int16"); Server.default.sync; NetAddr("127.0.0.1", ${_dynbufNotifyPortNumber || 0}).sendMsg("/envilDynbufWritten", ${slot}, "${diskPath}/slot_${slot}.wav", Server.default.sampleRate.asInteger, ${nch}, snap.numFrames.asInteger);`
        : '';

    const body = [
        ctrls,
        `; if(currentEnvironment.isKindOf(ProxySpace), {`,
        ` Routine({`,
        `  var bufRing, phase, snap, dur, readFrom, origTempo;`,
        `  if(Library.at(\\envil, \\bufRecReady).isNil or: { Library.at(\\envil, \\bufRecChans) != ${nch} }, {`,
        `   [\\bufRecIns, \\bufRecOuts].do{|k| var b = Library.at(\\envil, k); if(b.notNil and: { b.isKindOf(Buffer) }, { b.free }) };`,
        `   Library.put(\\envil, \\bufRecChans, ${nch});`,
        `   Library.put(\\envil, \\bufRecPhase, 0.0);`,
        `   Library.put(\\envil, \\dynBufs, List.new);`,
        `   Library.put(\\envil, \\bufRecIns,  Buffer.alloc(Server.default, Server.default.sampleRate * ${_dynbufRingSeconds}, ${nch}));`,
        `   Library.put(\\envil, \\bufRecOuts, Buffer.alloc(Server.default, Server.default.sampleRate * ${_dynbufRingSeconds}, ${nch}));`,
        `   Server.default.sync;`,
        `   ~envilBufRec.clear; ~envilBufRec.ar(1);`,
        `   ~envilBufRec = { |bufIn= -1, bufOut= -1|`,
        `     var ph = Phasor.ar(0, BufRateScale.kr(bufIn), 0, BufFrames.kr(bufIn));`,
        `     var ins  = ${nch}.collect{|i| SoundIn.ar(i) };`,
        `     var outs = ${nch}.collect{|i| InFeedback.ar(i, 1) };`,
        `     BufWr.ar(ins,  bufIn,  ph);`,
        `     BufWr.ar(outs, bufOut, ph);`,
        `     SendReply.kr(Impulse.kr(50), '/envilBufRecPhase', [A2K.kr(ph)]);`,
        `     DC.ar(0);`,
        `   };`,
        `   ~envilBufRec.set(\\bufIn, Library.at(\\envil, \\bufRecIns).bufnum, \\bufOut, Library.at(\\envil, \\bufRecOuts).bufnum);`,
        `   ~envilBufRec.play;`,
        `   OSCdef(\\envilBufRecPhase, { |msg| Library.put(\\envil, \\bufRecPhase, msg[3]) }, '/envilBufRecPhase');`,
        `   Library.put(\\envil, \\bufRecReady, true);`,
        `   ">>> envil: dynbuf system ready, recording started. Waiting ${snapSec}s before first snapshot...".postln;`,
        `   (${snapSec}).wait;`,
        `  });`,
        `  bufRing = Library.at(\\envil, ${sourceKey});`,
        `  phase = (Library.at(\\envil, \\bufRecPhase) ? 0).asInteger;`,
        `  snap = Buffer.alloc(Server.default, Server.default.sampleRate * ${snapSec}, ${nch});`,
        `  Server.default.sync;`,
        `  dur = snap.numFrames;`,
        `  readFrom = phase - dur;`,
        `  origTempo = TempoClock.default.tempo;`,
        `  if(bufRing.isNil, {`,
        `   "[envil dynbuf] ring buffer not ready yet — try again in a second.".warn;`,
        `   snap.free;`,
        `  }, {`,
        `   if(readFrom > 0, {`,
        `    bufRing.copyData(snap, 0, readFrom, dur);`,
        `   }, {`,
        `    var part1Start = bufRing.numFrames + readFrom;`,
        `    var part1Dur = -1 * readFrom;`,
        `    var part2Dur = dur + readFrom;`,
        `    bufRing.copyData(snap, 0, part1Start, part1Dur);`,
        `    bufRing.copyData(snap, -1 * readFrom, 0, part2Dur);`,
        `   });`,
        `   Library.put(\\envil, \\dynBufs, (Library.at(\\envil, \\dynBufs) ? List.new).add(snap));`,
        writeBlock,
        `   ~bufPlay_${slot}.ar(1);`,
        `   ~bufPlay_${slot} = ${playerFunc};`,
        `   ~bufPlay_${slot}.set(\\bufNum, snap.bufnum, \\origTempo, origTempo);`,
        `   ~bufPlay_${slot}_idx.set(\\val, snap.bufnum);`,
        `   (">>> envil dynbuf snapshot -> ~bufPlay_${slot}  buf=" ++ snap.bufnum ++ "  origTempo=" ++ origTempo).postln;`,
        `  });`,
        ` }).play;`,
        `})`,
    ].join('');

    return body;
}

// Build SC code to reload a previously-written dynbuf WAV from disk into
// ~bufPlay_N. Same player function as fresh snapshot, but reads from file
// instead of copying from the ring buffer.
function dynbufBuildReloadFromDisk(d) {
    const slot = d.slot;
    const nch = _dynbufNumChannels;
    const wavPath = d.lastWavPath.replace(/\\/g, '/').replace(/"/g, '\\"');
    const ctrls = dynbufBuildCtrlsForSlot(d);
    const playerFunc = [
        `{ |bufNum=0, origTempo=1|`,
        `  var t = if(~t.source.notNil, { Mix(~t.kr) }, { DC.kr(1) });`,
        `  var start       = ~bufPlay_${slot}_start.kr;`,
        `  var endC        = ~bufPlay_${slot}_end.kr;`,
        `  var tempoMul    = ~bufPlay_${slot}_tempoMul.kr;`,
        `  var rateMul     = ~bufPlay_${slot}_rateMul.kr;`,
        `  var chan        = ~bufPlay_${slot}_chan.kr;`,
        `  var pulseDivide = ~bufPlay_${slot}_pulseDivide.kr;`,
        `  var tempoFac    = 2.0 ** (((tempoMul * 8) - 4).round);`,
        `  var pulse       = Impulse.kr(t * 128 * tempoFac);`,
        `  var divFactor   = 2 ** ((pulseDivide * 7).round);`,
        `  var trigger     = PulseDivider.kr(pulse, (128 * 32) / divFactor);`,
        `  var actualRate  = 2.0 ** (((rateMul * 8) - 4).round);`,
        `  var rate        = Latch.kr(actualRate, trigger);`,
        `  var startFrame  = Latch.kr(BufFrames.kr(bufNum) * start, trigger);`,
        `  var endFrame    = Latch.kr(BufFrames.kr(bufNum) * endC,  trigger).max(startFrame + 1);`,
        `  var durLocal    = endFrame - startFrame;`,
        `  var speed       = t / origTempo;`,
        `  var phaseR      = Sweep.ar(trigger, SampleRate.ir / durLocal * rate * speed).linlin(0, 1, startFrame, endFrame);`,
        `  var bp          = BufRd.ar(${nch}, bufNum, phaseR, interpolation: 1, loop: 0);`,
        `  var chanIdx     = K2A.ar(chan.linlin(0, 1, 0, ${nch - 1}).round);`,
        `  var bpC         = Select.ar(chanIdx, bp);`,
        `  PitchShift.ar(bpC, pitchRatio: rate.reciprocal / speed);`,
        `}`,
    ].join(' ');
    return [
        ctrls,
        `; if(currentEnvironment.isKindOf(ProxySpace), {`,
        ` Buffer.read(Server.default, "${wavPath}", action: { |snap|`,
        `  ~bufPlay_${slot}.ar(1);`,
        `  ~bufPlay_${slot} = ${playerFunc};`,
        `  ~bufPlay_${slot}.set(\\bufNum, snap.bufnum, \\origTempo, TempoClock.default.tempo);`,
        `  ~bufPlay_${slot}_idx.set(\\val, snap.bufnum);`,
        `  (">>> envil dynbuf reloaded -> ~bufPlay_${slot}  buf=" ++ snap.bufnum).postln;`,
        ` });`,
        `})`,
    ].join('');
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

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED MEDIAPIPE HANDLERS  (called from extension.js socket.io listeners)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process incoming MediaPipe landmarks (from socket.io capture page).
 * Mirrors the 'mediapipe-landmarks' case in handleMessage but is callable
 * from extension.js without needing the webview postMessage wrapper.
 */
function handleMediaPipeLandmarks(landmarks) {
    // Reuse the existing handleMessage pathway — it expects { type, landmarks }
    handleMessage({ type: 'mediapipe-landmarks', landmarks });
    // Also forward to webview so it can draw the overlay
    if (_panel) {
        _panel.webview.postMessage({
            type: 'mediapipe-overlay',
            landmarks,
        });
    }
}

/**
 * Process incoming MediaPipe status change (from socket.io capture page).
 */
function handleMediaPipeStatus(msg) {
    handleMessage({ type: 'mediapipe-status', ...msg });
}

/**
 * Return the current mediapipe config for sending to the capture page.
 */
function getMediaPipeConfig() {
    return {
        enabled: _mpEnabled,
        sendRate: _mpSendRate,
        modelComplexity: _mpModelComplexity,
        videoOpacity: _mpVideoOpacity,
        drawLandmarks: _mpDrawLandmarks,
    };
}

/**
 * Build SC code to be appended inside `s.waitForBoot {...}` so the dynbuf
 * ring recorder + per-slot control proxies + (if WAVs exist) the player
 * proxies are all live as soon as the server is up. This makes:
 *   - `~bufPlay_N.ar` immediately usable from user code without opening the panel
 *   - SNAP have zero wait time (ring is already filling)
 *   - dynbufs auto-recover after server reboot, just like macros.
 *
 * Reads the persisted .envil/state.json directly so it works even when the
 * panel isn't open yet.
 */
function buildDynbufBootInitSCCode() {
    try {
        const setup = dynbufBuildSetup();
        let slotsCode = '';
        // Read persisted dynbufs (no in-memory _dynbufs yet if panel never opened)
        let savedDynbufs = [];
        try {
            const state = loadLayout();
            if (state && Array.isArray(state.dynbufs)) savedDynbufs = state.dynbufs;
        } catch (_) {}
        for (const s of savedDynbufs) {
            const d = {
                slot: Math.max(0, Number(s.slot) | 0),
                start:       clamp01(s.start       != null ? s.start       : 0),
                end:         clamp01(s.end         != null ? s.end         : 1),
                tempoMul:    clamp01(s.tempoMul    != null ? s.tempoMul    : 0.5),
                rateMul:     clamp01(s.rateMul     != null ? s.rateMul     : 0.5),
                chan:        clamp01(s.chan        != null ? s.chan        : 0),
                pulseDivide: clamp01(s.pulseDivide != null ? s.pulseDivide : 0.5),
                lastWavPath: typeof s.lastWavPath === 'string' ? s.lastWavPath : null,
            };
            slotsCode += '; ' + dynbufBuildCtrlsForSlot(d);
            if (d.lastWavPath && fs.existsSync(d.lastWavPath)) {
                slotsCode += '; ' + dynbufBuildReloadFromDisk(d);
            }
        }
        // Wrap the whole boot init in `p.use { ... }` so that the tilde
        // syntax (~bufPlay_N etc) resolves against the ProxySpace even when
        // this code is invoked from AppClock (e.g. inside s.waitForBoot)
        // where currentEnvironment is NOT the pushed ProxySpace.
        //
        // Also emit a diagnostic postln BEFORE the guard so the user always
        // sees whether the boot init reached sclang.
        const inner = (setup + slotsCode).replace(/\n/g, '\n    ');
        const wrapped = [
            `"[envil dynbuf] boot init: evaluating (p=" ++ p.class ++ ")".postln;`,
            `if(p.isKindOf(ProxySpace), {`,
            `  p.use({`,
            `    ${inner}`,
            `  });`,
            `}, {`,
            `  "[envil dynbuf] boot init SKIPPED: p is not a ProxySpace".warn;`,
            `});`,
        ].join('\n  ');
        return '  ' + wrapped;
    } catch (e) {
        console.warn('[touch-knobs] buildDynbufBootInitSCCode failed:', e.message);
        return '';
    }
}

module.exports = { registerTouchKnobs, hasEnvilDir, handleMediaPipeLandmarks, handleMediaPipeStatus, getMediaPipeConfig, buildDynbufBootInitSCCode };
