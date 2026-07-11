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
let _dynbufs = new Map();    // slot (int) → { slot, source, playing, start, end, rateMul, chan, quant, loop, hasSnapshot }
let _dynbufSysSent = false;  // SC setup code emitted? (re-emit on demand; sclang side is idempotent)
let _dynbufNumChannels = 8;
let _dynbufRingSeconds = 32;
let _dynbufSnapshotSeconds = 8;
let _dynbufWriteToDisk = true;

// Notification listener: SC sends /envilDynbufWritten <slot> <path> <sr> <nch> <numFrames>
// once Buffer.write completes on the audio server side.
let _dynbufNotifyPort = null;
let _dynbufNotifyPortNumber = 0;
let _dynbufNotifyReady = false;

// Heartbeat: while panel is open, poll sclang every N ms for health status
// (backbone + per-slot proxy presence). Cached + forwarded to webview.
let _dynbufHeartbeatTimer = null;
let _dynbufHeartbeatMs = 2500;
let _dynbufLastStatus = null;        // last /envilDynbufStatus payload
let _dynbufBackboneSent = false;     // ServerTree register code already sent? (per sclang session)
let _dynbufBackboneLastRepairMs = 0; // throttle auto-repair re-sends while backbone is red
let _knobResyncLastMs = 0;           // throttle knob/macro proxy resync bursts

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
    _dynbufNumChannels     = Math.max(1, Math.min(16, dbCfg.get('numChannels', 8)));
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
                _dynbufNumChannels     = Math.max(1, Math.min(16, dc.get('numChannels', 8)));
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

    // Open the notify port at activation (not just panel-open) so the
    // knob/macro resync register code can embed its port number even when
    // the panel has never been opened this session.
    ensureDynbufNotifyPort();

    context.subscriptions.push(
        vscode.commands.registerCommand('envil.touchKnobs.open', () => openPanel(context)),
        vscode.commands.registerCommand('envil.touchKnobs.close', () => closePanel()),
        vscode.commands.registerCommand('envil.initWorkspace', () => initWorkspace(context)),
    );

    registerProxyRecHover(context);

    // Auto-open on startup (small delay so editors have time to settle)
    if (autoOpen) {
        setTimeout(() => openPanel(context), 600);
    }
}

// ── Proxy → ring-channel assignment hover ─────────────────────────────
// Hovering ~someProxy in a .sc file shows "rec → c0 … cN" links. Clicking one
// repoints that dynbuf ring-recorder channel to the proxy's bus, so any audio
// proxy can be captured by SNAP (same technique as the number hover-slider).
const CMD_DYNBUF_REC_PROXY = 'envil.dynbuf.recProxy';

class ProxyRecHoverProvider {
    provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /~[a-zA-Z_]\w*/);
        if (!range) return null;
        const name = document.getText(range);
        // Skip the per-slot control proxies — recording those makes no sense.
        if (/^~bufPlay_\d+_/.test(name)) return null;
        const md = new vscode.MarkdownString();
        md.isTrusted = { enabledCommands: [CMD_DYNBUF_REC_PROXY] };
        const links = [];
        for (let i = 0; i < _dynbufNumChannels; i++) {
            const args = encodeURIComponent(JSON.stringify({ chan: i, proxy: name }));
            links.push(`[**c${i}**](command:${CMD_DYNBUF_REC_PROXY}?${args} "record ${name} on ring channel c${i}")`);
        }
        md.appendMarkdown(`🔴 rec \`${name}\` → ${links.join(' ')}\n\n`);
        md.appendMarkdown(`*points the dynbuf ring-recorder channel at ${name}'s bus (default: c0-c3 hw ins, c4/c5 ~out)*`);
        return new vscode.Hover(md, range);
    }
}

function registerProxyRecHover(context) {
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'supercollider', scheme: 'file' },
            new ProxyRecHoverProvider(),
        ),
        vscode.commands.registerCommand(CMD_DYNBUF_REC_PROXY, (args) => {
            if (!args || !args.proxy) return;
            const chan = Math.max(0, Number(args.chan) | 0);
            const name = String(args.proxy).replace(/[^~\w]/g, '');
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { var pr = ${name}; if(pr.isNil or: { pr.bus.isNil }, { "[envil dynbuf] ${name} has no bus yet (define it with .ar first)".warn }, { Library.at(\\envil, \\setRecBus).value(${chan}, pr.bus.index) }) }, { "[envil dynbuf] not in a ProxySpace".warn })`;
            sendSC(code, true);
            vscode.window.setStatusBarMessage(`🔴 rec ${name} → c${chan}`, 2500);
        }),
    );
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

    // Send backbone register code once per panel session (if sclang is up).
    // ServerTree.add is idempotent on our side because we remove the previous
    // closure first (see dynbufBuildBackboneCode).
    try {
        const sc = _getSC ? _getSC() : null;
        if (sc && sc.isSclangRunning()) {
            sendSC(buildDynbufBackboneRegisterCode(), true);
            _dynbufBackboneSent = true;
            // knob/macro self-heal register + immediate resync so the knobs
            // shown in the panel are live in the ProxySpace from the start
            const kr = buildKnobResyncRegisterCode();
            if (kr) sendSC(kr, true);
            sendSC(buildTempoProxyRegisterCode(), true);
            knobResyncAll('panel open');
        }
    } catch (_) {}

    // Start health heartbeat
    startDynbufHeartbeat();

    _panel.onDidDispose(() => {
        seqStopTimer();
        macroStopTimer();
        stopTempoSync();
        stopDynbufHeartbeat();
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
            const code = `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil or: { ${proxyName}.numChannels != 2 }, { ${proxyName}.mold(2, \\control); ${proxyName}.fadeTime = 0; ${proxyName} = ${src} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.fadeTime = 0; ${proxyName}.source = ${proxyName}.source }) }); ${proxyName}.set(\\x, ${msg.x}, \\y, ${msg.y}) })`;
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
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p}.fadeTime = 0; ${p} = ${src} }, { if(Server.default.serverRunning and: { ${p}.isPlaying.not }, { ${p}.fadeTime = 0; ${p}.source = ${p}.source }) })`;
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
            const ensureSrc = (p) => `if(${p}.source.isNil, { ${p}.fadeTime = 0; ${p} = ${src} }, { if(Server.default.serverRunning and: { ${p}.isPlaying.not }, { ${p}.fadeTime = 0; ${p}.source = ${p}.source }) })`;
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
                `if(~mp_${name}.source.isNil, { ~mp_${name}.mold(2, \\control); ~mp_${name}.fadeTime = 0; ~mp_${name} = ${MP_PROXY_SRC} }, ` +
                `{ if(Server.default.serverRunning and: { ~mp_${name}.isPlaying.not }, { ~mp_${name}.fadeTime = 0; ~mp_${name}.source = ~mp_${name}.source }) })`;

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
                const ensure = `if(~mp_${proxyName}.source.isNil, { ~mp_${proxyName}.mold(${nCh}, \\control); ~mp_${proxyName}.fadeTime = 0; ~mp_${proxyName} = ${src} }, ` +
                    `{ if(Server.default.serverRunning and: { ~mp_${proxyName}.isPlaying.not }, { ~mp_${proxyName}.fadeTime = 0; ~mp_${proxyName}.source = ~mp_${proxyName}.source }) })`;
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
                const ensure20 = `if(~mp_fingers.source.isNil, { ~mp_fingers.mold(20, \\control); ~mp_fingers.fadeTime = 0; ~mp_fingers = ${MP_FINGERS10_SRC} }, ` +
                    `{ if(Server.default.serverRunning and: { ~mp_fingers.isPlaying.not }, { ~mp_fingers.fadeTime = 0; ~mp_fingers.source = ~mp_fingers.source }) })`;
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

        case 'insert-code': {
            // Insert a multiline code snippet at the cursor of the active
            // (or last-active visible) text editor. Used by the P badge —
            // more reliable than HTML5 drag/drop for multiline payloads.
            const code = typeof msg.code === 'string' ? msg.code : '';
            if (!code) break;
            let editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.uri.scheme !== 'file') {
                editor = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
            }
            if (!editor) {
                vscode.window.setStatusBarMessage('envil: no editor to insert into', 2000);
                break;
            }
            const pos = editor.selection.active;
            editor.edit(eb => eb.insert(pos, code)).then(() => {
                vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            });
            break;
        }

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
                rateMul: clamp01(msg.rateMul != null ? msg.rateMul : 0.5),
                chan:    clamp01(msg.chan    != null ? msg.chan    : 0),
                quant:   clamp01(msg.quant   != null ? msg.quant   : 0),
                loop:    clamp01(msg.loop    != null ? msg.loop    : 1),
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
                    rateMul: clamp01(msg.rateMul != null ? msg.rateMul : 0.5),
                    chan:    clamp01(msg.chan    != null ? msg.chan    : 0),
                    quant:   clamp01(msg.quant   != null ? msg.quant   : 0),
                    loop:    clamp01(msg.loop    != null ? msg.loop    : 1),
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
            if (!['start', 'end', 'rateMul', 'chan', 'quant', 'loop'].includes(key)) break;
            const val = clamp01(msg.value);
            d[key] = val;
            sendSC(dynbufBuildSetCtrl(slotIdx, key, val), true);
            break;
        }

        case 'dynbuf-play': {
            // Transport play button: resets to UI workflow, then fires a
            // one-shot play trigger (rewind to start + play). With the loop
            // toggle off this plays start→end once and pauses.
            const slotIdx = Math.max(0, Number(msg.slot) | 0);
            if (!_dynbufs.get(slotIdx)) break;
            sendSC(dynbufBuildPlay(slotIdx), true);
            log(`  ▶ dynbuf play slot=${slotIdx}`);
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
                      rateMul: 0.5, chan: 0, quant: 0, loop: 1, hasSnapshot: false };
                _dynbufs.set(slotIdx, d);
            }
            d.hasSnapshot = true;
            // Only re-arm backbone if last-known status says it's red. The
            // heartbeat already self-heals; re-arming on every SNAP would
            // free + reallocate the ring buffers and lose recent audio.
            if (!_dynbufLastStatus || !_dynbufLastStatus.backboneReady) {
                sendSC(buildDynbufBackboneRegisterCode(), true);
            }
            // Send ctrls FIRST in a separate write — sclang's stdin
            // command-line buffer has a hard limit (~6KB per chunk), so
            // we split ctrls + snapshot routine across two writes.
            sendSC(dynbufBuildCtrlsForSlot(d), true);
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
    // NOTE: heal via source-reassign, NEVER .send — .send layers a NEW synth
    // on top of the old one (kr buses SUM → doubled values). Reassigning the
    // source frees the old synth first; with fadeTime=0 there's no crossfade
    // summing window, so a false-positive heal (isPlaying race) is harmless.
    return `if(currentEnvironment.isKindOf(ProxySpace), { if(${proxyName}.source.isNil, { ${proxyName}.mold(1, \\control); ${proxyName}.fadeTime = 0; ${proxyName} = ${SEQ_SRC} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.fadeTime = 0; ${proxyName}.source = ${proxyName}.source; ">>> envil: healed ${proxyName}".postln }) }); ${proxyName}.set(\\val, ${v}) })`;
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
        `{ var ps = Library.at(\\envil, \\pspace) ? currentEnvironment;` +
        ` if(ps.isKindOf(ProxySpace), { ps.use({` +
        ` if(~t.source.isNil, { ~t.fadeTime = 0; ~t = ${TEMPO_PROXY_SRC} }, {` +
        ` if(Server.default.serverRunning and: { ~t.isPlaying.not }, { ~t.fadeTime = 0; ~t.source = ~t.source }) });` +
        ` ~t.set(\\val, ${t})` +
        ` }) }) }.value`,
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
            try {
                if (!oscMsg) return;
                if (oscMsg.address === '/envilDynbufWritten') handleDynbufWritten(oscMsg);
                else if (oscMsg.address === '/envilDynbufStatus') handleDynbufStatus(oscMsg);
                else if (oscMsg.address === '/envilKnobsResync') knobResyncAll('server boot');
            }
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

// Handle status reply from `buildDynbufStatusQueryCode`. Updates host-side
// health cache + pushes to the webview so the panel can render dots/badges.
function handleDynbufStatus(oscMsg) {
    if (!oscMsg || oscMsg.address !== '/envilDynbufStatus') return;
    const a = (oscMsg.args || []).map(x => Number(x && x.value != null ? x.value : x) | 0);
    if (a.length < 3) return;
    const [backboneReady, isProxySpace, backboneAlive, ...rest] = a;
    // rest is groups of 3: [slot, exposed, numChannels]
    const slots = {};
    for (let i = 0; i + 2 < rest.length; i += 3) {
        slots[rest[i]] = { exposed: !!rest[i + 1], nch: rest[i + 2] | 0 };
    }
    const status = {
        backboneReady: !!backboneReady,
        backboneAlive: !!backboneAlive,
        isProxySpace: !!isProxySpace,
        slots,
    };
    _dynbufLastStatus = status;
    if (_panel) {
        _panel.webview.postMessage({ type: 'dynbuf-status', status });
    }
    // Self-heal backbone: only when bufRecReady is genuinely false. bbAlive
    // is best-effort (depends on NodeWatcher) and shouldn't trigger repair on
    // its own. Throttle hard so the post window doesn't get spammed.
    if (!status.backboneReady) {
        const now = Date.now();
        if ((now - _dynbufBackboneLastRepairMs) > 15000) {
            _dynbufBackboneLastRepairMs = now;
            sendSC(buildDynbufBackboneRegisterCode(), true);
        }
    }
    // Self-heal: if backbone says ProxySpace exists but a known slot is NOT
    // exposed, silently re-emit the per-slot install code (no log spam).
    if (isProxySpace) {
        for (const [slotStr, info] of Object.entries(slots)) {
            const slotIdx = Number(slotStr) | 0;
            if (!info.exposed) {
                const d = _dynbufs.get(slotIdx);
                if (d) {
                    sendSC(dynbufBuildCtrlsForSlot(d), true);
                    // Also try reload-from-disk to (re)wire the player proxy
                    if (d.lastWavPath && fs.existsSync(d.lastWavPath)) {
                        sendSC(dynbufBuildReloadFromDisk(d), true);
                    }
                }
            }
        }
    }
}

// Heartbeat: every N seconds, send the status-query SC snippet so the panel
// always shows fresh health, and missing per-slot proxies self-heal after a
// fresh ProxySpace.push. Disabled while sclang is down.
function startDynbufHeartbeat() {
    if (_dynbufHeartbeatTimer) return;
    _dynbufHeartbeatTimer = setInterval(() => {
        try {
            const sc = _getSC ? _getSC() : null;
            if (!sc || !sc.isSclangRunning()) return;
            // Build query covering all known slots (panel-registered + persisted)
            const slotsSet = new Set();
            for (const k of _dynbufs.keys()) slotsSet.add(Number(k) | 0);
            try {
                const state = loadLayout();
                if (state && Array.isArray(state.dynbufs)) {
                    for (const s of state.dynbufs) slotsSet.add(Math.max(0, Number(s.slot) | 0));
                }
            } catch (_) {}
            const slots = Array.from(slotsSet).sort((a, b) => a - b);
            const code = buildDynbufStatusQueryCode(slots);
            if (code) sendSC(code, true);
        } catch (e) {
            console.warn('[touch-knobs] heartbeat error:', e.message);
        }
    }, _dynbufHeartbeatMs);
}

function stopDynbufHeartbeat() {
    if (_dynbufHeartbeatTimer) {
        clearInterval(_dynbufHeartbeatTimer);
        _dynbufHeartbeatTimer = null;
    }
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
    // Heal via source-reassign (frees old synth), NEVER .send (stacks a 2nd
    // synth → kr bus sums → macro reads 1..2 instead of 0..1). fadeTime=0
    // kills the crossfade-summing window; smoothing comes from Lag.kr anyway.
    return `if(${proxyName}.source.isNil, { ${proxyName}.mold(1, \\control); ${proxyName}.fadeTime = 0; ${proxyName} = ${MACRO_SRC} }, { if(Server.default.serverRunning and: { ${proxyName}.isPlaying.not }, { ${proxyName}.fadeTime = 0; ${proxyName}.source = ${proxyName}.source; ">>> envil: healed ${proxyName}".postln }) })`;
}

function macroProxyName(m) {
    return `~mcr_${positiveInteger(m && m.macroNum, 1)}`;
}

// ── Knob/macro proxy self-init + self-heal ─────────────────────────────────────
//
// Same self-heal contract as the dynbuf backbone / input proxies: a tiny
// ServerTree-registered SC closure pings us back (/envilKnobsResync) on EVERY
// server (re)boot — including boots triggered outside the extension — and we
// answer by re-creating ALL knob + macro proxies with FRESH values from the
// persisted panel state (works even while the panel is closed). Host-driven so
// values are never stale, unlike embedding them in the register code itself.

// Batched, chunked (stay well under sclang's ~6KB stdin limit per write).
function knobResyncAll(reason) {
    const now = Date.now();
    if (now - _knobResyncLastMs < 1000) return;   // debounce boot bursts
    _knobResyncLastMs = now;

    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning()) return;

    const state = loadLayout() || {};
    const parts = [];

    // ── 2D knobs: ~v_c<midiNote> with last x/y ──
    const knobs = Array.isArray(state.knobs) ? state.knobs : [];
    const knobSrc = `{ |x=0, y=0, lagTime=${DEFAULT_LAG_TIME}| [Lag.kr(x, lagTime), Lag.kr(y, lagTime)] }`;
    for (const k of knobs) {
        const noteNum = Number(k.midiNote != null ? k.midiNote : k.id) | 0;
        const x = clamp01(Number(k.nx) || 0);
        const y = clamp01(Number(k.ny) || 0);
        const pn = `~${PROXY_PREFIX}_c${noteNum}`;
        parts.push(`if(${pn}.source.isNil or: { ${pn}.numChannels != 2 }, { ${pn}.mold(2, \\control); ${pn}.fadeTime = 0; ${pn} = ${knobSrc} }, { if(Server.default.serverRunning and: { ${pn}.isPlaying.not }, { ${pn}.fadeTime = 0; ${pn}.source = ${pn}.source }) }); ${pn}.set(\\x, ${x}, \\y, ${y})`);
    }

    // ── shared tap/note proxies: ~v_n / ~v_n_val (idle = 0) ──
    if (knobs.length > 0) {
        const noteSrc = `{ |val=0, lagTime=0| Lag.kr(val, lagTime) }`;
        for (const pn of [`~${PROXY_PREFIX}_n`, `~${PROXY_PREFIX}_n_val`]) {
            parts.push(`if(${pn}.source.isNil, { ${pn}.fadeTime = 0; ${pn} = ${noteSrc} }, { if(Server.default.serverRunning and: { ${pn}.isPlaying.not }, { ${pn}.fadeTime = 0; ${pn}.source = ${pn}.source }) })`);
        }
    }

    // ── macros: ~mcr_<num> with last sampled value ──
    // (playing macros heal themselves every tick, but idle ones would
    //  otherwise stay dead until pressed play)
    const macros = _macros.length > 0 ? _macros : (Array.isArray(state.macros) ? state.macros : []);
    for (const m of macros) {
        const pos = clamp01(Number(m.position != null ? m.position : m.currentPos) || 0);
        const val = macroSampleValue(m, pos);
        parts.push(`${macroEnsureSCCode(macroProxyName(m))}; ${macroProxyName(m)}.set(\\val, ${val})`);
    }

    // ── sequencers: ~seq_<name> (idle = current step value; playing ones
    //    heal themselves every tick via seqSCCode, idle ones need this) ──
    const seqs = _seqs.length > 0 ? _seqs : (Array.isArray(state.seqs) ? state.seqs : []);
    for (const s of seqs) {
        if (!s || !s.name) continue;
        const pn = `~seq_${s.name}`;
        const v = (Array.isArray(s.steps) && s.steps.length > 0)
            ? (Number(s.steps[(s.currentStep || 0) % s.steps.length]) || 0) : 0;
        parts.push(`if(${pn}.source.isNil, { ${pn}.mold(1, \\control); ${pn}.fadeTime = 0; ${pn} = ${SEQ_SRC} }, { if(Server.default.serverRunning and: { ${pn}.isPlaying.not }, { ${pn}.fadeTime = 0; ${pn}.source = ${pn}.source }) }); ${pn}.set(\\val, ${v})`);
    }

    if (parts.length === 0 && _dynbufs.size === 0) return;

    // Chunked sends: ~5 proxies per write, each wrapped in the ProxySpace guard
    const CHUNK = 5;
    for (let i = 0; i < parts.length; i += CHUNK) {
        const body = parts.slice(i, i + CHUNK).join('; ');
        sendSC(`if(currentEnvironment.isKindOf(ProxySpace), { ${body} })`, true);
    }

    // ── dynbuf slots: reload persisted WAVs ──
    // A reboot wipes ALL server buffers; player proxy SOURCES survive in the
    // ProxySpace, so the "exposed" heal-check passes while the synth reads a
    // dead bufnum ("Buffer UGen: no buffer data"). This ping fires on every
    // boot (ServerTree) — re-read each slot's WAV from disk. The reload code
    // is throttled SC-side (3s/slot) so overlapping paths collapse to one.
    try {
        const dynSlots = new Map(_dynbufs);
        if (dynSlots.size === 0 && state && Array.isArray(state.dynbufs)) {
            for (const sd of state.dynbufs) {
                const si = Math.max(0, Number(sd.slot) | 0);
                dynSlots.set(si, {
                    slot: si,
                    start:   clamp01(sd.start   != null ? sd.start   : 0),
                    end:     clamp01(sd.end     != null ? sd.end     : 1),
                    rateMul: clamp01(sd.rateMul != null ? sd.rateMul : 0.5),
                    chan:    clamp01(sd.chan    != null ? sd.chan    : 0),
                    quant:   clamp01(sd.quant   != null ? sd.quant   : 0),
                    loop:    clamp01(sd.loop    != null ? sd.loop    : 1),
                    lastWavPath: typeof sd.lastWavPath === 'string' ? sd.lastWavPath : null,
                });
            }
        }
        for (const d of dynSlots.values()) {
            if (d.lastWavPath && fs.existsSync(d.lastWavPath)) {
                sendSC(dynbufBuildReloadFromDisk(d), true);
            }
        }
    } catch (e) {
        console.warn('[touch-knobs] dynbuf boot reload failed:', e.message);
    }

    log(`  ♻ knob/macro proxies resynced (${knobs.length} knobs, ${macros.length} macros) — ${reason}`);
}

// SC register code: ServerTree closure that pings /envilKnobsResync on every
// boot; fires immediately if the server is already running. Idempotent.
// Send as its own executeCode write. Returns '' until the notify port is up.
function buildKnobResyncRegisterCode() {
    ensureDynbufNotifyPort();
    if (!_dynbufNotifyPortNumber) return '';
    return [
        `(`,
        `Library.put(\\envil, \\knobResyncFn, {`,
        `  Routine({`,
        `    Server.default.sync;`,
        `    NetAddr("127.0.0.1", ${_dynbufNotifyPortNumber}).sendMsg("/envilKnobsResync");`,
        `  }).play;`,
        `});`,
        `(Library.at(\\envil, \\knobResyncTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\knobResyncTreeFn, { Library.at(\\envil, \\knobResyncFn).value });`,
        `ServerTree.add(Library.at(\\envil, \\knobResyncTreeFn), Server.default);`,
        `if(Server.default.serverRunning, { Library.at(\\envil, \\knobResyncFn).value }, { "[envil] knob/macro proxies registered — will auto-init on s.boot".postln });`,
        `);`,
    ].join('\n');
}

// ~t tempo proxy — first-class self-healed register (same pattern as input
// proxies / synthdef loader). An SC-side watcher Routine mirrors
// TempoClock.default.tempo into ~t every 250ms, so ANY tempo source (panel
// tap, footpedal e[\timeSyncInput] hook, manual `TempoClock.default.tempo=`)
// reaches ~t — previously only the panel's own tap/BPM field pushed it.
// ServerTree refires it on every boot AND Cmd-Period (which kills AppClock
// routines — the stale \tempoWatchBeat stamp lets the heartbeat heal too).
// The ~t reassign (fadeTime=0, source=source) revives a dead synth after
// reboot — idempotent, never .send.
function buildTempoProxyRegisterCode() {
    return [
        `(`,
        `Library.put(\\envil, \\tempoProxyFn, {`,
        `  var last = Library.at(\\envil, \\tempoProxyLastFire) ? -10;`,
        `  if((Main.elapsedTime - last) > 3, {`,
        `    Library.put(\\envil, \\tempoProxyLastFire, Main.elapsedTime);`,
        `    Routine({`,
        `      var n = 0, ps;`,
        `      while({ Server.default.serverRunning.not and: { n < 100 } }, { 0.1.wait; n = n + 1 });`,
        `      ps = Library.at(\\envil, \\pspace) ? currentEnvironment;`,
        `      if(Server.default.serverRunning and: { ps.isKindOf(ProxySpace) }, {`,
        `        ps.use({`,
        `          if(~t.source.isNil, { ~t.fadeTime = 0; ~t = { |val=1, lagTime=0.1| Lag.kr(val, lagTime) } }, { ~t.fadeTime = 0; ~t.source = ~t.source });`,
        `          ~t.set(\\val, TempoClock.default.tempo);`,
        `        });`,
        `        (Library.at(\\envil, \\tempoWatch)) !? { |r| r.stop };`,
        `        Library.put(\\envil, \\tempoWatch, Routine({`,
        `          var lastT = -1;`,
        `          loop({`,
        `            var tt = TempoClock.default.tempo;`,
        `            Library.put(\\envil, \\tempoWatchBeat, Main.elapsedTime);`,
        `            if(tt != lastT, {`,
        `              var sp = Library.at(\\envil, \\pspace) ? currentEnvironment;`,
        `              lastT = tt;`,
        `              if(sp.isKindOf(ProxySpace), { sp.use({ if(~t.source.notNil, { ~t.set(\\val, tt) }) }) });`,
        `            });`,
        `            0.25.wait;`,
        `          });`,
        `        }).play(AppClock));`,
        `      });`,
        `    }).play(AppClock);`,
        `  });`,
        `});`,
        `(Library.at(\\envil, \\tempoProxyTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\tempoProxyTreeFn, { Library.at(\\envil, \\tempoProxyFn).value });`,
        `ServerTree.add(Library.at(\\envil, \\tempoProxyTreeFn), Server.default);`,
        `Library.at(\\envil, \\tempoProxyFn).value;`,
        `);`,
    ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC BUFFER (live looper) — SC code emitters
// ─────────────────────────────────────────────────────────────────────────────
//
// Architecture (two clean layers):
//
//   1) BACKBONE  (server-scoped, ProxySpace-INDEPENDENT)
//      The always-on ring recorder. Lives entirely in `Library.at(\envil, *)`
//      and as a plain `Synth(\envilBufRec, ...)` on the rootNode. NO tilde
//      syntax, NO NodeProxy. Registered via `ServerTree.add(fn, s)` so it
//      auto-(re)builds on every boot / reboot / cmd-period. Also fires once
//      immediately when registered if the server is already running.
//
//      Library keys:
//        \envil, \bufRecReady    — Boolean guard
//        \envil, \bufRecChans    — Int, channel count (default 8)
//        \envil, \bufRecRingSec  — Int, ring length seconds
//        \envil, \bufRecIns      — Buffer (single N-ch ring, InFeedback taps)
//        \envil, \recBusses      — Array of bus indices, one per ring channel.
//                                  Default (8ch): [nOut+0..nOut+3, 0, 1, 2, 3]
//                                  → c0-c3 = hardware inputs, c4/c5 = ~out L/R
//                                  (main out buses), c6/c7 = free/custom.
//        \envil, \setRecBus      — fn(idx, bus): re-point ring channel idx to
//                                  any bus, e.g. a proxy:
//                                  Library.at(\envil,\setRecBus).value(6, ~pat.bus.index)
//        \envil, \bufRecPhase    — Float, current write head (frames)
//        \envil, \bufRecSynth    — the Synth instance
//        \envil, \dynBufs        — List of snapshot Buffers (kept alive)
//        \envil, \dynBufBySlot   — IdentityDictionary slot → snapshot Buffer
//
//   2) REPRESENTATIONS  (ProxySpace-scoped, slot-per-slot)
//      The per-slot NodeProxies that the user / Pbinds interact with. Only
//      created when `currentEnvironment.isKindOf(ProxySpace)`. Re-emitted on:
//        - panel register / snapshot / reload / reload-button
//        - heartbeat (every few seconds while panel open) — self-heals after
//          a fresh ProxySpace.push.
//
//      Per slot N:
//        ~bufPlay_N            — player NodeProxy (audio, mono)
//        ~bufPlay_N_idx        — control proxy holding current bufnum (\val)
//        ~bufPlay_N_<arg>      — control proxies for start, end, rateMul,
//                                chan, quant, loop

// Backbone: register the ServerTree closure that builds / repairs the ring
// recorder on every server (re)boot. Also fires immediately if server is up.
// Idempotent on the SC side: re-evaluating this snippet replaces the closure
// (via Library.put) instead of stacking up duplicates.
function dynbufBuildBackboneCode() {
    const nch = _dynbufNumChannels;
    const ringSec = _dynbufRingSeconds;
    return [
        `(`,
        `// ── envil dynbuf backbone (ProxySpace-independent) ──`,
        `Library.put(\\envil, \\bufRecChansCfg, ${nch});`,
        `Library.put(\\envil, \\bufRecRingSecCfg, ${ringSec});`,
        `Library.put(\\envil, \\backboneFn, {`,
        `  Routine({`,
        `    var srv = Server.default;`,
        `    var nch = Library.at(\\envil, \\bufRecChansCfg) ? 8;`,
        `    var ringSec = Library.at(\\envil, \\bufRecRingSecCfg) ? 32;`,
        `    var nOut, nIns, busses, bufIn, syn;`,
        `    Library.put(\\envil, \\bufRecReady, false);`,
        `    "[envil backbone] step 1: cleaning up old state".postln;`,
        `    (Library.at(\\envil, \\bufRecSynth)) !? { |x| try { x.free } };`,
        `    [\\bufRecIns, \\bufRecOuts].do{|k| var b = Library.at(\\envil, k); if(b.notNil and: { b.isKindOf(Buffer) }, { try { b.free } }) };`,
        `    Library.put(\\envil, \\bufRecPhase, 0.0);`,
        `    // Default source layout (like my_footcontroller.sc):`,
        `    //   first half  = hardware inputs (bus nOut+i)`,
        `    //   second half = output buses 0.. (c4/c5 capture ~out L/R; rest free)`,
        `    nOut = srv.options.numOutputBusChannels;`,
        `    nIns = (nch / 2).asInteger;`,
        `    busses = nch.collect{|i| if(i < nIns, { nOut + i }, { i - nIns }) };`,
        `    Library.put(\\envil, \\recBusses, busses);`,
        `    Library.put(\\envil, \\setRecBus, { |idx, bus|`,
        `      var arr = Library.at(\\envil, \\recBusses);`,
        `      arr[idx] = bus.asInteger;`,
        `      Library.at(\\envil, \\bufRecSynth) !? { |sy| sy.setn(\\busses, arr) };`,
        `      ("[envil dynbuf] rec slot c" ++ idx ++ " -> bus " ++ bus).postln;`,
        `    });`,
        `    "[envil backbone] step 2: registering SynthDef".postln;`,
        `    SynthDef(\\envilBufRec, { |bufIn= -1|`,
        `      var busses = \\busses.kr(Array.fill(nch, 0));`,
        `      var phase = Phasor.ar(0, BufRateScale.kr(bufIn), 0, BufFrames.kr(bufIn));`,
        `      var ins = nch.collect{|i| InFeedback.ar(busses[i]) };`,
        `      BufWr.ar(ins, bufIn, phase);`,
        `      SendReply.kr(Impulse.kr(50), '/envilBufRecPhase', [A2K.kr(phase)]);`,
        `      DC.ar(0);`,
        `    }).add;`,
        `    srv.sync;`,
        `    "[envil backbone] step 3: allocating ring buffer".postln;`,
        `    bufIn = Buffer.alloc(srv, srv.sampleRate * ringSec, nch);`,
        `    Library.put(\\envil, \\bufRecIns, bufIn);`,
        `    srv.sync;`,
        `    "[envil backbone] step 4: starting recorder synth".postln;`,
        `    syn = Synth(\\envilBufRec, [\\bufIn, bufIn.bufnum, \\busses, busses], target: RootNode(srv), addAction: \\addToHead);`,
        `    syn.register;`,
        `    Library.put(\\envil, \\bufRecSynth, syn);`,
        `    OSCdef(\\envilBufRecPhase, { |msg| Library.put(\\envil, \\bufRecPhase, msg[3]) }, '/envilBufRecPhase');`,
        `    Library.put(\\envil, \\bufRecChans, nch);`,
        `    Library.put(\\envil, \\bufRecRingSec, ringSec);`,
        `    Library.put(\\envil, \\bufRecReady, true);`,
        `    ("[envil backbone] \u2713 ring recorder up (chans=" ++ nch ++ " ring=" ++ ringSec ++ "s busses=" ++ busses ++ " synth=" ++ syn.nodeID ++ ")").postln;`,
        `  }).play;`,
        `});`,
        `// Register on ServerTree \u2014 fires automatically on every (re)boot.`,
        `// Remove previous wrapper if any (idempotent).`,
        `(Library.at(\\envil, \\backboneTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\backboneTreeFn, { Library.at(\\envil, \\backboneFn).value });`,
        `ServerTree.add(Library.at(\\envil, \\backboneTreeFn), Server.default);`,
        `"[envil backbone] ServerTree fn registered".postln;`,
        `// Fire immediately if server already running`,
        `if(Server.default.serverRunning, { "[envil backbone] server already running \u2014 firing now".postln; Library.at(\\envil, \\backboneFn).value }, { "[envil backbone] server not running yet \u2014 will auto-init on s.boot".postln });`,
        `);`,
    ].join('\n');
}

// Backwards-compat alias (some call sites still use the old name).
function dynbufBuildSetup() { return dynbufBuildBackboneCode(); }

// Ensures the per-slot control proxies (~bufPlay_N_start etc.) exist and
// hold the current panel values. Idempotent.
//
// Compact form: a single closure `fn` performs the install-if-needed-and-set
// dance, so each key only emits ~30 chars rather than ~220. Big win for
// staying under sclang's stdin command-line buffer limit (~6KB).
function dynbufBuildCtrlsForSlot(d) {
    const slot = d.slot;
    // [proxy, val, lagTime]
    const items = [
        [`~bufPlay_${slot}_idx`,     0,                              0],
        [`~bufPlay_${slot}_start`,   d.start,                        0.02],
        [`~bufPlay_${slot}_end`,     d.end,                          0.02],
        [`~bufPlay_${slot}_rateMul`, d.rateMul,                      0.02],
        [`~bufPlay_${slot}_chan`,    d.chan,                         0.02],
        [`~bufPlay_${slot}_quant`,   d.quant != null ? d.quant : 0,  0],
        [`~bufPlay_${slot}_loop`,    d.loop  != null ? d.loop  : 1,  0],
    ];
    // Helper closure: takes proxy + value + lagTime; reinstalls the control
    // synth if the user replaced .source with a constant (no \val arg) and
    // pushes the value via .set(\val, v).
    // Heal via source-reassign, NEVER .send (.send stacks a 2nd synth → kr
    // bus sums → e.g. rateMul doubles → bufplay races/goes silent).
    const helperDef = `var fn = { |p, v, lag| if(p.source.isNil or: { p.controlNames.isNil or: { p.controlNames.any({|cn| cn.name == \\val }).not } }, { p.kr(1); p.fadeTime = 0; p.source = { |val=0, lagTime=0| Lag.kr(val, lagTime) }; p.set(\\lagTime, lag) }, { if(Server.default.serverRunning and: { p.isPlaying.not }, { p.fadeTime = 0; p.source = p.source }) }); p.set(\\val, v) };`;
    const calls = items.map(([p, v, lag]) => `fn.value(${p}, ${Number(v).toFixed(6)}, ${Number(lag).toFixed(3)});`).join(' ');
    return `if(currentEnvironment.isKindOf(ProxySpace), { ${helperDef} ${calls} })`;
}

function dynbufBuildSetupAndCtrls(d) {
    // NOTE: backbone is now auto-managed by ServerTree (registered separately
    // when the panel opens / sclang starts / server reboots). We do NOT prepend
    // it here — prepending plus the per-slot ctrls plus the snapshot routine
    // produced payloads big enough to choke sclang's command-line parser.
    return dynbufBuildCtrlsForSlot(d);
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
    // Any UI interaction (except SNAP) fully resets the player to UI workflow:
    // clears all direct-arg overrides (-1 = follow UI proxies), restores amp,
    // and clears dur (dur=0 releases pattern gating -> sound resumes).
    const uiReset = `~bufPlay_${slot}.set(\\start, -1, \\end, -1, \\rateMul, -1, \\chan, -1, \\quant, -1, \\loop, -1, \\amp, 1, \\dur, 0, \\dStart, 0, \\dEnd, 0)`;
    return `if(currentEnvironment.isKindOf(ProxySpace), { if(${needsCtrl}, { ${p}.kr(1); ${p} = ${ctrlSrc} }); ${p}.set(\\val, ${Number(val).toFixed(6)}); ${uiReset} })`;
}

// Transport play: reset to UI workflow (like any other UI interaction),
// then fire the one-shot play trigger. With the loop toggle off this plays
// start→end once and pauses; with loop on it restarts the loop from start.
function dynbufBuildPlay(slot) {
    const p = `~bufPlay_${slot}`;
    const uiReset = `${p}.set(\\start, -1, \\end, -1, \\rateMul, -1, \\chan, -1, \\quant, -1, \\loop, -1, \\amp, 1, \\dur, 0, \\dStart, 0, \\dEnd, 0)`;
    return `if(currentEnvironment.isKindOf(ProxySpace), { ${uiReset}; ${p}.set(\\t_play, 1) })`;
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
        `~bufPlay_${slot}_rateMul`,
        `~bufPlay_${slot}_chan`,
        `~bufPlay_${slot}_quant`,
        `~bufPlay_${slot}_loop`,
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

    // Backbone is registered separately via ServerTree (sent on extension
    // load / sclang start / server reboot). The per-slot ctrls are sent in
    // a SEPARATE sendSC call BEFORE this snapshot code by the message handler
    // (see the 'dynbuf-snapshot' case) — this keeps each individual sclang
    // stdin write below the ~6KB command-line buffer limit.
    // The snapshot routine waits up to 3s for `bufRecReady` and warns clearly
    // if the backbone is missing (then user clicks ↻ to re-arm).

    // The player proxy synth. Channel count baked in.
    // ~t is envil's tempo proxy (beats per second). Defaults to 1 if absent.
    // All essential params are REAL synth args (pattern-settable via
    // ~bufPlay_N.set(\start, x) or Pbind \type \set). Default -1 means
    // "follow the UI control proxy" (~bufPlay_N_start etc.); any value >= 0
    // overrides the UI. Set back to -1 to hand control back to the panel.
    // NOTE: Mix() unwraps the 1-elem array returned by NodeProxy.kr — without
    // it, Select.ar multichannel-expands and the mono proxy mixes ALL chans.
    //
    // Transport model (macro-like):
    //   t_play      — trigger: rewind to start and play once (start→end)
    //   loop        — 0 = one-shot (auto-pause at end), 1 = looping
    //   quant       — 0..1 → 13 steps [off, 1/16, ⅛, ¼, ½, 1..8 beats]. off = free
    //                 loop (wrap at end); N = retrigger from start every N
    //                 beats (forces restart even if the end wasn't reached;
    //                 pauses early if shorter). Sub-beat steps = glitch repeats.
    //   rateMul     — 0..1 → 2^(round(x*8)-4); PitchShift auto-corrects pitch
    //                 (correction clamps at 4x — the PitchShift UGen limit —
    //                 so rates below 1/4 can't be fully corrected)
    //   dur/legato  — pattern gating: t_play with dur > 0 (beats) cuts the
    //                 sound after dur*legato beats. dur=0 disables the cut.
    //                 Rest() sends no trigger → silent beat. Reverse: end < start.
    //   dStart/dEnd — additive offsets (default 0) on top of the resolved
    //                 start/end — lets patterns shift the UI-set window.
    // NOTE: this array is .join(' ')ed — NO // comments inside!
    const playerFunc = [
        `{ |bufNum=0, start= -1, end= -1, rateMul= -1, chan= -1, quant= -1, loop= -1, amp=1, t_play=0, dur=0, legato=1, dStart=0, dEnd=0|`,
        `  var tRaw = if(~t.source.notNil, { Mix(~t.kr) }, { DC.kr(1) });`,
        `  var t = Select.kr(tRaw > 0.001, [DC.kr(1), tRaw]);`,
        `  var startV   = (Select.kr(start >= 0,   [Mix(~bufPlay_${slot}_start.kr),   start]) + dStart).clip(0, 1);`,
        `  var endV     = (Select.kr(end >= 0,     [Mix(~bufPlay_${slot}_end.kr),     end]) + dEnd).clip(0, 1);`,
        `  var rateMulV = Select.kr(rateMul >= 0, [Mix(~bufPlay_${slot}_rateMul.kr), rateMul]);`,
        `  var chanV    = Select.kr(chan >= 0,    [Mix(~bufPlay_${slot}_chan.kr),    chan]);`,
        `  var quantV   = Select.kr(quant >= 0,   [Mix(~bufPlay_${slot}_quant.kr),   quant]);`,
        `  var loopV    = Select.kr(loop >= 0,    [Mix(~bufPlay_${slot}_loop.kr),    loop]);`,
        `  var quantB   = Select.kr((quantV * 12).round, [0, 0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8]);`,
        `  var loopOn   = loopV > 0.5;`,
        `  var rate     = Lag.kr(2.0 ** (((rateMulV * 8) - 4).round), 0.05);`,
        `  var trig     = t_play + Impulse.kr(t / quantB.max(0.0625) * ((quantB > 0.05) * loopOn));`,
        `  var startFrame = BufFrames.kr(bufNum) * startV;`,
        `  var endFrame   = BufFrames.kr(bufNum) * endV;`,
        `  var durFrames  = (endFrame - startFrame).abs.max(1);`,
        `  var prog       = Sweep.ar(trig, SampleRate.ir / durFrames * rate);`,
        `  var freeLoop   = K2A.ar(loopOn * (quantB < 0.05));`,
        `  var pos        = Select.ar(freeLoop, [prog.clip(0, 1), prog.wrap(0, 1)]);`,
        `  var playGate   = (prog < 1).max(freeLoop);`,
        `  var sustain    = (dur * legato / t.max(0.001)).max(0.02);`,
        `  var cutEnv     = Select.kr(dur > 0, [DC.kr(1), Trig.kr(t_play, sustain)]).lag(0.01);`,
        `  var phaseR     = pos.linlin(0, 1, startFrame, endFrame);`,
        `  var bp         = BufRd.ar(${nch}, bufNum, phaseR, interpolation: 1, loop: 0);`,
        `  var chanIdx    = K2A.ar(chanV.linlin(0, 1, 0, ${nch - 1}).round);`,
        `  var bpC        = Select.ar(chanIdx, bp);`,
        `  PitchShift.ar(bpC, pitchRatio: rate.reciprocal.clip(0.25, 4)) * amp.lag(0.05) * playGate.lag(0.005) * cutEnv;`,
        `}`,
    ].join(' ');

    const writeBlock = writeToDisk && diskPath
        ? ` File.mkdir("${diskPath}"); snap.write("${diskPath}/slot_${slot}.wav", "WAV", "int16"); Server.default.sync; NetAddr("127.0.0.1", ${_dynbufNotifyPortNumber || 0}).sendMsg("/envilDynbufWritten", ${slot}, "${diskPath}/slot_${slot}.wav", Server.default.sampleRate.asInteger, ${nch}, snap.numFrames.asInteger);`
        : '';

    const body = [
        `if(currentEnvironment.isKindOf(ProxySpace), {`,
        ` Routine({`,
        `  var bufRing, phase, snap, dur, readFrom, attempts;`,
        `  // Wait for backbone (max ~3s) — should already be up via ServerTree, but be safe.`,
        `  attempts = 0;`,
        `  while({ Library.at(\\envil, \\bufRecReady) != true and: { attempts < 30 } }, { 0.1.wait; attempts = attempts + 1 });`,
        `  if(Library.at(\\envil, \\bufRecReady) != true, {`,
        `    "[envil dynbuf] SNAP aborted: backbone not ready. Try the panel \u21bb (reload) button or re-evaluate the backbone setup.".warn;`,
        `  }, {`,
        `   bufRing = Library.at(\\envil, ${sourceKey});`,
        `   phase = (Library.at(\\envil, \\bufRecPhase) ? 0).asInteger;`,
        `   snap = Buffer.alloc(Server.default, Server.default.sampleRate * ${snapSec}, ${nch});`,
        `   Server.default.sync;`,
        `   dur = snap.numFrames;`,
        `   readFrom = phase - dur;`,
        `   if(bufRing.isNil, {`,
        `    "[envil dynbuf] ring buffer missing in Library — backbone repair needed.".warn;`,
        `    snap.free;`,
        `   }, {`,
        `    if(readFrom > 0, {`,
        `     bufRing.copyData(snap, 0, readFrom, dur);`,
        `    }, {`,
        `     var part1Start = bufRing.numFrames + readFrom;`,
        `     var part1Dur = -1 * readFrom;`,
        `     var part2Dur = dur + readFrom;`,
        `     bufRing.copyData(snap, 0, part1Start, part1Dur);`,
        `     bufRing.copyData(snap, -1 * readFrom, 0, part2Dur);`,
        `    });`,
        `    Library.put(\\envil, \\dynBufs, (Library.at(\\envil, \\dynBufs) ? List.new).add(snap));`,
        `    (Library.at(\\envil, \\dynBufBySlot) ?? { var d = IdentityDictionary.new; Library.put(\\envil, \\dynBufBySlot, d); d }).put(${slot}, snap);`,
        writeBlock,
        `    ~bufPlay_${slot}.ar(1);`,
        `    ~bufPlay_${slot} = ${playerFunc};`,
        `    ~bufPlay_${slot}.set(\\bufNum, snap.bufnum);`,
        `    ~bufPlay_${slot}_idx.set(\\val, snap.bufnum);`,
        `    (">>> envil dynbuf snapshot -> ~bufPlay_${slot}  buf=" ++ snap.bufnum).postln;`,
        `   });`,
        `  });`,
        ` }).play;`,
        `})`,
    ].join('\n');

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
        `{ |bufNum=0, start= -1, end= -1, rateMul= -1, chan= -1, quant= -1, loop= -1, amp=1, t_play=0, dur=0, legato=1, dStart=0, dEnd=0|`,
        `  var tRaw = if(~t.source.notNil, { Mix(~t.kr) }, { DC.kr(1) });`,
        `  var t = Select.kr(tRaw > 0.001, [DC.kr(1), tRaw]);`,
        `  var startV   = (Select.kr(start >= 0,   [Mix(~bufPlay_${slot}_start.kr),   start]) + dStart).clip(0, 1);`,
        `  var endV     = (Select.kr(end >= 0,     [Mix(~bufPlay_${slot}_end.kr),     end]) + dEnd).clip(0, 1);`,
        `  var rateMulV = Select.kr(rateMul >= 0, [Mix(~bufPlay_${slot}_rateMul.kr), rateMul]);`,
        `  var chanV    = Select.kr(chan >= 0,    [Mix(~bufPlay_${slot}_chan.kr),    chan]);`,
        `  var quantV   = Select.kr(quant >= 0,   [Mix(~bufPlay_${slot}_quant.kr),   quant]);`,
        `  var loopV    = Select.kr(loop >= 0,    [Mix(~bufPlay_${slot}_loop.kr),    loop]);`,
        `  var quantB   = Select.kr((quantV * 12).round, [0, 0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 7, 8]);`,
        `  var loopOn   = loopV > 0.5;`,
        `  var rate     = Lag.kr(2.0 ** (((rateMulV * 8) - 4).round), 0.05);`,
        `  var trig     = t_play + Impulse.kr(t / quantB.max(0.0625) * ((quantB > 0.05) * loopOn));`,
        `  var startFrame = BufFrames.kr(bufNum) * startV;`,
        `  var endFrame   = BufFrames.kr(bufNum) * endV;`,
        `  var durFrames  = (endFrame - startFrame).abs.max(1);`,
        `  var prog       = Sweep.ar(trig, SampleRate.ir / durFrames * rate);`,
        `  var freeLoop   = K2A.ar(loopOn * (quantB < 0.05));`,
        `  var pos        = Select.ar(freeLoop, [prog.clip(0, 1), prog.wrap(0, 1)]);`,
        `  var playGate   = (prog < 1).max(freeLoop);`,
        `  var sustain    = (dur * legato / t.max(0.001)).max(0.02);`,
        `  var cutEnv     = Select.kr(dur > 0, [DC.kr(1), Trig.kr(t_play, sustain)]).lag(0.01);`,
        `  var phaseR     = pos.linlin(0, 1, startFrame, endFrame);`,
        `  var bp         = BufRd.ar(${nch}, bufNum, phaseR, interpolation: 1, loop: 0);`,
        `  var chanIdx    = K2A.ar(chanV.linlin(0, 1, 0, ${nch - 1}).round);`,
        `  var bpC        = Select.ar(chanIdx, bp);`,
        `  PitchShift.ar(bpC, pitchRatio: rate.reciprocal.clip(0.25, 4)) * amp.lag(0.05) * playGate.lag(0.005) * cutEnv;`,
        `}`,
    ].join(' ');
    return [
        `if(currentEnvironment.isKindOf(ProxySpace), {`,
        // Wait for serverRunning instead of firing blind: it only flips true
        // AFTER the boot notify handshake (which resets ALL allocators). A
        // Buffer.read landing in the boot window would get a bufnum the ring
        // buffer then reuses. The boot ping can arrive moments before
        // notified flips — so wait (max ~10s) rather than silently no-op.
        // SC-side per-slot throttle (3s): several paths can race at boot;
        // without it each fire allocates a NEW buffer and re-assigns the player.
        ` if((Main.elapsedTime - (Library.at(\\envil, \\dynbufReloadLast${slot}) ? -10)) > 3, {`,
        `  Library.put(\\envil, \\dynbufReloadLast${slot}, Main.elapsedTime);`,
        `  Routine({`,
        `   var n = 0;`,
        `   while({ Server.default.serverRunning.not and: { n < 100 } }, { 0.1.wait; n = n + 1 });`,
        `   if(Server.default.serverRunning, {`,
        // ctrls MUST run here (post-serverRunning), not at send time: their
        // heal helper is serverRunning-gated, so firing it during the boot
        // window silently skips reinstalling the control synths → all ctrl
        // buses read 0 → end=start=0 → player silent (reboot bug 2026-07).
        `    ${ctrls};`,
        `    Buffer.read(Server.default, "${wavPath}", action: { |snap|`,
        `     ~bufPlay_${slot}.ar(1);`,
        `     ~bufPlay_${slot} = ${playerFunc};`,
        `     ~bufPlay_${slot}.set(\\bufNum, snap.bufnum);`,
        `     ~bufPlay_${slot}_idx.set(\\val, snap.bufnum);`,
        `     (">>> envil dynbuf reloaded -> ~bufPlay_${slot}  buf=" ++ snap.bufnum).postln;`,
        `    });`,
        `   });`,
        `  }).play(AppClock);`,
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
 * Build SC code for the per-slot ProxySpace exposure step. Safe to call
 * whether a ProxySpace is current or not — the inner code is guarded.
 *
 * Reads the persisted .envil/state.json directly so it works even when the
 * panel isn't open yet.
 *
 * Note: this no longer sets up the BACKBONE — that's now done independently
 * by `buildDynbufBackboneRegisterCode()` which uses ServerTree and is sent
 * BEFORE waitForBoot (since it's ProxySpace-independent).
 */
function buildDynbufBootInitSCCode() {
    try {
        let slotsCode = '';
        let savedDynbufs = [];
        try {
            const state = loadLayout();
            if (state && Array.isArray(state.dynbufs)) savedDynbufs = state.dynbufs;
        } catch (_) {}
        // Also include any slots currently registered by an open panel (may be
        // more up-to-date than the persisted layout).
        const knownSlots = new Set();
        for (const s of savedDynbufs) knownSlots.add(Math.max(0, Number(s.slot) | 0));
        const allSlots = [];
        for (const s of savedDynbufs) {
            allSlots.push({
                slot: Math.max(0, Number(s.slot) | 0),
                start:   clamp01(s.start   != null ? s.start   : 0),
                end:     clamp01(s.end     != null ? s.end     : 1),
                rateMul: clamp01(s.rateMul != null ? s.rateMul : 0.5),
                chan:    clamp01(s.chan    != null ? s.chan    : 0),
                quant:   clamp01(s.quant   != null ? s.quant   : 0),
                loop:    clamp01(s.loop    != null ? s.loop    : 1),
                lastWavPath: typeof s.lastWavPath === 'string' ? s.lastWavPath : null,
            });
        }
        for (const d of allSlots) {
            slotsCode += '; ' + dynbufBuildCtrlsForSlot(d);
            if (d.lastWavPath && fs.existsSync(d.lastWavPath)) {
                slotsCode += '; ' + dynbufBuildReloadFromDisk(d);
            }
        }
        if (!slotsCode) return '';
        // Wrap in `p.use { ... }` so tilde-syntax resolves to the ProxySpace
        // regardless of which thread we're on (e.g. AppClock from waitForBoot).
        const inner = slotsCode.replace(/^; /, '').replace(/\n/g, '\n    ');
        return [
            `  "[envil dynbuf] expose slots: evaluating".postln;`,
            `  if(p.isKindOf(ProxySpace), {`,
            `    p.use({`,
            `      ${inner}`,
            `    });`,
            `  }, {`,
            `    "[envil dynbuf] expose slots SKIPPED: p is not a ProxySpace".warn;`,
            `  });`,
        ].join('\n');
    } catch (e) {
        console.warn('[touch-knobs] buildDynbufBootInitSCCode failed:', e.message);
        return '';
    }
}

/**
 * Build the SC code that registers the backbone (ring recorder) on
 * ServerTree, so it auto-(re)builds on every server (re)boot. Safe to call
 * even when no server is running yet — registration is class-level. If the
 * server IS already running, the backbone is built immediately.
 *
 * Send this OUTSIDE `s.waitForBoot` (it's ProxySpace-independent and doesn't
 * need to wait for the server).
 */
function buildDynbufBackboneRegisterCode() {
    return dynbufBuildBackboneCode();
}

/**
 * Build SC code that reports backbone + per-slot health via the dynbuf
 * notify OSC port. The host's heartbeat sends this every few seconds while
 * the panel is open and updates the panel UI accordingly.
 *
 * OSC payload (sent to /envilDynbufStatus):
 *   [backboneReady:i, isProxySpace:i, slot0_exposed:i, slot1_exposed:i, ...]
 *
 * `<slotN_exposed>` is 1 iff all of: ~bufPlay_N has a source AND each ctrl
 * proxy has a \val controlName.
 */
function buildDynbufStatusQueryCode(slots) {
    if (!_dynbufNotifyPortNumber) return '';
    const items = slots.map(slot => {
        const player = `~bufPlay_${slot}`;
        const idx = `~bufPlay_${slot}_idx`;
        const start = `~bufPlay_${slot}_start`;
        return `${slot}, (${player}.source.notNil and: { ${idx}.source.notNil and: { ${start}.source.notNil } }).if(1, 0), ${player}.bus.notNil.if(${player}.numChannels ? 0, 0)`;
    });
    const slotPairs = items.length ? ', ' + items.join(', ') : '';
    return [
        `(`,
        `var addr = NetAddr("127.0.0.1", ${_dynbufNotifyPortNumber});`,
        `var bbReady = (Library.at(\\envil, \\bufRecReady) == true).if(1, 0);`,
        `var isPS = currentEnvironment.isKindOf(ProxySpace).if(1, 0);`,
        `var bbSyn = Library.at(\\envil, \\bufRecSynth);`,
        `var bbAlive = (bbSyn.notNil and: { try { bbSyn.isPlaying } { false } }).if(1, 0);`,
        `addr.sendMsg("/envilDynbufStatus", bbReady, isPS, bbAlive${slotPairs});`,
        `)`,
    ].join(' ');
}

module.exports = { registerTouchKnobs, hasEnvilDir, handleMediaPipeLandmarks, handleMediaPipeStatus, getMediaPipeConfig, buildDynbufBootInitSCCode, buildDynbufBackboneRegisterCode, buildKnobResyncRegisterCode, buildTempoProxyRegisterCode };
