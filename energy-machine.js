// @ts-nocheck
// energy-machine.js
//
// "Energy machine" — a visual node-network panel where energy tokens walk
// from an energy source through pattern pools and back. Each pool is exposed
// as a normal ProxySpace proxy (~poolA, ~poolB, …) whose source is a Pspawner
// that plays whatever pattern the arriving token picked. The token routing
// itself runs sclang-side (Routines on SystemClock), so closing the panel
// never stops the music — the panel is display + intervention only.
//
// SC-side state lives under Library.at(\envil, \energy*):
//   \energyGraph     IdentityDictionary  node -> (outs: [[dest, w]…], pats: [(id, w, src)…])
//   \energyCfg       (travel:, dwell:, maxDur:)
//   \energyQueues    per-pool List of [pattern, Condition]
//   \energyTokens    List of [id, Routine]
//   \energyMakePool / \energyEnsurePools / \energySpawnToken / \energyRecall
//
// House rules respected: payloads ≤ ~5.5KB (graph pushed in per-node chunks),
// heals idempotent (pool source only reassigned when missing), everything
// tolerant of sclang/server not running yet.

'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const osc = require('osc');

const ENVIL_DIR = '.envil';
const STATE_FILE = 'energy.json';
const STATE_VERSION = 1;
const MAX_PAYLOAD = 5200;          // stay safely under sclang's ~6KB stdin limit

let _panel = null;
let _getSC = null;
let _hydraOutput = null;
let _workspacePath = null;
let _extensionPath = null;

let _notifyPort = null;
let _notifyPortNumber = 0;

let _heartbeatTimer = null;
const HEARTBEAT_MS = 3000;
let _lastRepairMs = 0;
let _backboneSent = false;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

function registerEnergyMachine(context, { getSC, hydraOutput, extensionPath, workspacePath }) {
    _getSC = getSC;
    _hydraOutput = hydraOutput;
    _workspacePath = workspacePath || null;
    _extensionPath = extensionPath;

    context.subscriptions.push(
        vscode.commands.registerCommand('envil.energyMachine.open', () => openPanel(context)),
        vscode.commands.registerCommand('envil.energyMachine.close', () => closePanel()),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

function openPanel(context) {
    if (_panel) { _panel.reveal(vscode.ViewColumn.Two); return; }

    _panel = vscode.window.createWebviewPanel(
        'envil.energyMachine',
        '⚡ Energy Machine',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.file(context.extensionPath)],
        }
    );

    ensureNotifyPort();

    const state = loadState();
    const htmlPath = path.join(context.extensionPath, 'energy-panel.html');
    let rawHtml = fs.readFileSync(htmlPath, 'utf-8');
    _panel.webview.html = rawHtml
        .replace(/__ENVIL_CSP_SRC__/g, _panel.webview.cspSource)
        .replace(
            'const vscode = acquireVsCodeApi();',
            `const vscode = acquireVsCodeApi();\nglobalThis.__ENVIL_ENERGY_STATE__ = ${JSON.stringify(state)};`,
        );

    _panel.webview.onDidReceiveMessage(handleMessage, null, context.subscriptions);

    // Bring SC side up if sclang is already running
    try {
        const sc = _getSC ? _getSC() : null;
        if (sc && sc.isSclangRunning()) {
            pushAllToSC(state);
        }
    } catch (_) {}

    startHeartbeat();

    _panel.onDidDispose(() => {
        stopHeartbeat();
        _panel = null;
        log('⚡ energy machine panel closed');
    }, null, context.subscriptions);

    log('⚡ energy machine panel opened');
}

function closePanel() {
    if (_panel) { _panel.dispose(); _panel = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER (webview → host)
// ─────────────────────────────────────────────────────────────────────────────

function handleMessage(msg) {
    switch (msg.type) {
        case 'graph-update': {
            // Full state replace: persist + (re)push graph & cfg to SC
            const state = sanitizeState(msg.state);
            saveState(state);
            const sc = _getSC ? _getSC() : null;
            if (sc && sc.isSclangRunning()) {
                pushGraphToSC(state);
                pushConfigToSC(state);
            }
            return;
        }
        case 'spawn-token': {
            sendSC(`Library.at(\\envil, \\energySpawnToken) !? { |f| f.value }`, true);
            return;
        }
        case 'recall-tokens': {
            sendSC(`Library.at(\\envil, \\energyRecall) !? { |f| f.value }`, true);
            return;
        }
        case 'resync-sc': {
            // Manual "push everything again" button
            const state = loadState();
            pushAllToSC(state);
            return;
        }
        case 'webview-log': {
            log(`[energy webview] ${msg.message || ''}`);
            return;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE PERSISTENCE  (.envil/energy.json)
// ─────────────────────────────────────────────────────────────────────────────

function statePath() {
    const base = _workspacePath || _extensionPath;
    return path.join(base, ENVIL_DIR, STATE_FILE);
}

function defaultState() {
    return {
        _version: STATE_VERSION,
        travelTime: 1.5,
        dwellTime: 0.6,
        maxPatDur: 60,
        nodes: [
            { id: 'source', type: 'source', x: 90, y: 260, outs: [{ to: 'poolA', weight: 1 }] },
            {
                id: 'poolA', type: 'pool', x: 320, y: 120, toSourceWeight: 1,
                outs: [{ to: 'poolB', weight: 1 }],
                patterns: [
                    { id: 'p1', name: 'up', weight: 1, text: 'Pbind(\\degree, Pseq([0, 2, 4, 7], 2), \\dur, 0.25, \\amp, 0.2)' },
                ],
            },
            {
                id: 'poolB', type: 'pool', x: 320, y: 400, toSourceWeight: 1,
                outs: [],
                patterns: [
                    { id: 'p2', name: 'down', weight: 1, text: 'Pbind(\\degree, Pseq([7, 4, 2, 0], 2), \\dur, 0.25, \\amp, 0.2)' },
                ],
            },
        ],
    };
}

function loadState() {
    try {
        const p = statePath();
        if (fs.existsSync(p)) return sanitizeState(JSON.parse(fs.readFileSync(p, 'utf-8')));
    } catch (e) { console.warn('[energy] loadState failed:', e.message); }
    return defaultState();
}

function saveState(state) {
    try {
        const p = statePath();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(state, null, 2));
    } catch (e) { console.warn('[energy] saveState failed:', e.message); }
}

// Keep pool ids proxy-safe and structure sound.
function sanitizeState(state) {
    const s = (state && typeof state === 'object') ? state : {};
    const out = {
        _version: STATE_VERSION,
        travelTime: clampNum(s.travelTime, 0.1, 30, 1.5),
        dwellTime: clampNum(s.dwellTime, 0.05, 30, 0.6),
        maxPatDur: clampNum(s.maxPatDur, 1, 3600, 60),
        nodes: [],
    };
    const ids = new Set();
    let hasSource = false;
    for (const n of (Array.isArray(s.nodes) ? s.nodes : [])) {
        if (!n || typeof n !== 'object') continue;
        if (n.type === 'source') {
            if (hasSource) continue;
            hasSource = true;
            out.nodes.push({
                id: 'source', type: 'source', x: num(n.x, 90), y: num(n.y, 260),
                outs: (Array.isArray(n.outs) ? n.outs : [])
                    .filter(o => o && typeof o.to === 'string')
                    .map(o => ({ to: sanitizePoolName(o.to) || 'source', weight: clampNum(o.weight, 0, 100, 1) })),
            });
            ids.add('source');
            continue;
        }
        const id = sanitizePoolName(n.id);
        if (!id || ids.has(id)) continue;
        ids.add(id);
        out.nodes.push({
            id, type: 'pool',
            x: num(n.x, 300), y: num(n.y, 200),
            toSourceWeight: clampNum(n.toSourceWeight, 0, 100, 1),
            outs: (Array.isArray(n.outs) ? n.outs : [])
                .filter(o => o && typeof o.to === 'string')
                .map(o => ({ to: sanitizePoolName(o.to) || 'source', weight: clampNum(o.weight, 0, 100, 1) })),
            patterns: (Array.isArray(n.patterns) ? n.patterns : [])
                .filter(pt => pt && typeof pt === 'object')
                .map(pt => ({
                    id: String(pt.id || ('p' + Math.random().toString(36).slice(2, 8))),
                    name: String(pt.name || 'pat'),
                    weight: clampNum(pt.weight, 0, 100, 1),
                    text: String(pt.text || ''),
                })),
        });
    }
    if (!hasSource) out.nodes.unshift({ id: 'source', type: 'source', x: 90, y: 260, outs: [] });
    // Drop edges pointing at deleted nodes (pool->source is implicit via toSourceWeight)
    for (const n of out.nodes) {
        if (n.type === 'pool') n.outs = n.outs.filter(o => o.to === 'source' ? false : ids.has(o.to));
        else if (n.type === 'source') n.outs = n.outs.filter(o => ids.has(o.to) && o.to !== 'source');
    }
    return out;
}

function sanitizePoolName(name) {
    let n = String(name || '').replace(/[^A-Za-z0-9_]/g, '');
    if (!n) return null;
    if (!/^[a-z]/.test(n)) n = 'p' + n;
    if (n === 'source') return null;
    return n;
}

function num(v, d) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function clampNum(v, lo, hi, d) { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; }

// ─────────────────────────────────────────────────────────────────────────────
// SC CODE GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/** Escape arbitrary pattern text into a single-line SC string literal. */
function scStr(text) {
    return '"' + String(text)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t') + '"';
}

/**
 * ProxySpace-independent backbone: pool factory, ensure-pools, token spawn,
 * recall. Idempotent — safe to re-send anytime. Queues/token lists survive
 * re-sends (only created when missing).
 */
function buildEnergyBackboneCode() {
    return [
        `(`,
        `// ── envil energy machine backbone ──`,
        `Library.put(\\envil, \\energyNotify, NetAddr("127.0.0.1", ${_notifyPortNumber || 0}));`,
        `if(Library.at(\\envil, \\energyTokens).isNil, { Library.put(\\envil, \\energyTokens, List.new) });`,
        `if(Library.at(\\envil, \\energyNextTok).isNil, { Library.put(\\envil, \\energyNextTok, 0) });`,
        `if(Library.at(\\envil, \\energyCfg).isNil, { Library.put(\\envil, \\energyCfg, (travel: 1.5, dwell: 0.6, maxDur: 60)) });`,
        `Library.put(\\envil, \\energyMakePool, { |name|`,
        `  Pspawner({ |sp|`,
        `    loop {`,
        `      var q = Library.at(\\envil, \\energyQueues, name);`,
        `      var item;`,
        `      if(q.notNil and: { q.size > 0 }, { item = q.removeAt(0) });`,
        `      if(item.notNil, {`,
        `        try { sp.seq(item[0]) } { |err| ("[energy] pattern crashed in " ++ name ++ ": " ++ err.errorString).warn };`,
        `        item[1].test = true; item[1].signal;`,
        `      }, { sp.wait(0.1) });`,
        `    };`,
        `  });`,
        `});`,
        `Library.put(\\envil, \\energyEnsurePools, { |names|`,
        `  var ps = Library.at(\\envil, \\pspace);`,
        `  if(ps.isNil and: { currentEnvironment.isKindOf(ProxySpace) }, { ps = currentEnvironment });`,
        `  names.do { |name|`,
        `    if(Library.at(\\envil, \\energyQueues, name).isNil, { Library.put(\\envil, \\energyQueues, name, List.new) });`,
        `  };`,
        `  if(ps.isNil, { "[energy] no ProxySpace found - pool proxies not created".warn }, {`,
        `    names.do { |name|`,
        `      var pr = ps.at(name);`,
        `      if(pr.source.isNil, {`,
        `        pr.fadeTime = 0;`,
        `        ps.put(name, Library.at(\\envil, \\energyMakePool).value(name));`,
        `        ("[energy] pool proxy ~" ++ name ++ " up").postln;`,
        `      });`,
        `    };`,
        `  });`,
        `});`,
        `)`,
    ].join('\n');
}

function buildEnergyTokenCode() {
    return [
        `(`,
        `// ── envil energy machine: token engine ──`,
        `Library.put(\\envil, \\energySpawnToken, {`,
        `  var id = Library.at(\\envil, \\energyNextTok) ? 0;`,
        `  var rout;`,
        `  Library.put(\\envil, \\energyNextTok, id + 1);`,
        `  rout = Routine({`,
        `    var pos = \\source, graph, cfg, addr, node, outs, dest, pats, pick, patObj, cond, w, dwell, travel;`,
        `    addr = Library.at(\\envil, \\energyNotify);`,
        `    addr !? { addr.sendMsg("/envilEnergyTok", id, "at", "source", "") };`,
        `    loop {`,
        `      graph = Library.at(\\envil, \\energyGraph);`,
        `      cfg = Library.at(\\envil, \\energyCfg) ? ();`,
        `      dwell = cfg[\\dwell] ? 0.6; travel = cfg[\\travel] ? 1.5;`,
        `      node = graph !? { graph.at(pos) };`,
        `      if(node.isNil and: { pos != \\source }, { pos = \\source; node = graph !? { graph.at(\\source) } });`,
        `      if(node.isNil, { dwell.wait }, {`,
        `        if(pos != \\source, {`,
        `          pats = node[\\pats] ? [];`,
        `          pick = nil; patObj = nil;`,
        `          if(pats.size > 0, {`,
        `            w = pats.collect({ |p| (p[\\w] ? 1).max(0.0001) }).normalizeSum;`,
        `            pick = pats.wchoose(w);`,
        `          });`,
        `          if(pick.notNil, {`,
        `            patObj = try { pick[\\src].interpret } { |err| ("[energy] interpret failed (" ++ pick[\\id] ++ "): " ++ err.errorString).warn; nil };`,
        `            if(patObj.isKindOf(Pattern).not, {`,
        `              if(patObj.notNil, { ("[energy] " ++ pick[\\id] ++ " is not a Pattern - skipped").warn });`,
        `              patObj = nil;`,
        `            });`,
        `          });`,
        `          if(patObj.notNil, {`,
        `            var q = Library.at(\\envil, \\energyQueues, pos);`,
        `            patObj = Pfindur(cfg[\\maxDur] ? 60, patObj);`,
        `            if(q.notNil, {`,
        `              cond = Condition(false);`,
        `              q.add([patObj, cond]);`,
        `              addr !? { addr.sendMsg("/envilEnergyTok", id, "play", pos.asString, pick[\\id].asString) };`,
        `              cond.wait;`,
        `            }, {`,
        `              addr !? { addr.sendMsg("/envilEnergyTok", id, "skip", pos.asString, "noqueue") };`,
        `              dwell.wait;`,
        `            });`,
        `          }, {`,
        `            addr !? { addr.sendMsg("/envilEnergyTok", id, "skip", pos.asString, if(pick.isNil, { "empty" }, { pick[\\id].asString })) };`,
        `            dwell.wait;`,
        `          });`,
        `        }, { dwell.wait });`,
        `        outs = node[\\outs] ? [];`,
        `        if(outs.size == 0, { outs = [[\\source, 1.0]] });`,
        `        dest = outs.wchoose(outs.collect({ |o| (o[1] ? 1).max(0.0001) }).normalizeSum)[0];`,
        `        addr !? { addr.sendMsg("/envilEnergyTok", id, "travel", pos.asString, dest.asString, travel) };`,
        `        travel.wait;`,
        `        pos = dest;`,
        `        if(pos == \\source, { addr !? { addr.sendMsg("/envilEnergyTok", id, "at", "source", "") } });`,
        `      });`,
        `    };`,
        `  }).play(SystemClock);`,
        `  Library.at(\\envil, \\energyTokens).add([id, rout]);`,
        `  ("[energy] token " ++ id ++ " spawned").postln;`,
        `  id;`,
        `});`,
        `Library.put(\\envil, \\energyRecall, {`,
        `  var toks = Library.at(\\envil, \\energyTokens);`,
        `  var addr = Library.at(\\envil, \\energyNotify);`,
        `  var names = Library.at(\\envil, \\energyPoolNames) ? [];`,
        `  toks.do({ |t| t[1].stop; addr !? { addr.sendMsg("/envilEnergyTok", t[0], "gone", "", "") } });`,
        `  toks.clear;`,
        `  names.do({ |n| Library.at(\\envil, \\energyQueues, n) !? { |q| q.clear } });`,
        `  "[energy] all tokens recalled".postln;`,
        `});`,
        `)`,
    ].join('\n');
}

/**
 * Graph push, chunked per node so arbitrary pattern texts never blow the
 * stdin limit. Builds into \energyGraphNew scratch, commits atomically.
 */
function buildGraphChunks(state) {
    const chunks = [];
    chunks.push(`Library.put(\\envil, \\energyGraphNew, IdentityDictionary.new);`);

    const pools = state.nodes.filter(n => n.type === 'pool');
    const source = state.nodes.find(n => n.type === 'source');

    // source node: outs point to pools (explicit edges live on source.outs? no —
    // source edges are stored on the source node in the webview state)
    const srcOuts = (source && Array.isArray(source.outs)) ? source.outs : [];
    const srcOutsCode = srcOuts
        .filter(o => pools.some(pl => pl.id === o.to))
        .map(o => `[\\${o.to}, ${Number(o.weight) || 1}]`)
        .join(', ');
    chunks.push(`(var g = Library.at(\\envil, \\energyGraphNew); g[\\source] = (outs: [${srcOutsCode}], pats: []);)`);

    for (const pool of pools) {
        const outs = [];
        for (const o of pool.outs) {
            if (o.to !== 'source' && pools.some(pl => pl.id === o.to)) {
                outs.push(`[\\${o.to}, ${Number(o.weight) || 1}]`);
            }
        }
        if ((Number(pool.toSourceWeight) || 0) > 0) {
            outs.push(`[\\source, ${Number(pool.toSourceWeight)}]`);
        }
        // Header chunk for the pool (outs + empty pats)
        chunks.push(`(var g = Library.at(\\envil, \\energyGraphNew); g[\\${pool.id}] = (outs: [${outs.join(', ')}], pats: List.new);)`);
        // One chunk per pattern (texts can be long)
        for (const pt of pool.patterns) {
            const code = `(var g = Library.at(\\envil, \\energyGraphNew); g[\\${pool.id}][\\pats].add((id: ${scStr(pt.id)}, w: ${Number(pt.weight) || 1}, src: ${scStr(pt.text)}));)`;
            if (code.length > MAX_PAYLOAD) {
                log(`⚠ [energy] pattern "${pt.name}" too long (${code.length} chars) — skipped in SC push`);
                continue;
            }
            chunks.push(code);
        }
    }

    const poolSyms = pools.map(p => `\\${p.id}`).join(', ');
    chunks.push([
        `(`,
        `Library.put(\\envil, \\energyGraph, Library.at(\\envil, \\energyGraphNew));`,
        `Library.put(\\envil, \\energyPoolNames, [${poolSyms}]);`,
        `Library.at(\\envil, \\energyEnsurePools) !? { |f| f.value([${poolSyms}]) };`,
        `("[energy] graph updated (" ++ ${pools.length} ++ " pools)").postln;`,
        `)`,
    ].join(' '));

    return chunks;
}

function buildConfigCode(state) {
    return `Library.put(\\envil, \\energyCfg, (travel: ${state.travelTime}, dwell: ${state.dwellTime}, maxDur: ${state.maxPatDur}));`;
}

function buildStatusQueryCode() {
    if (!_notifyPortNumber) return '';
    return [
        `(`,
        `var addr = NetAddr("127.0.0.1", ${_notifyPortNumber});`,
        `var ready = Library.at(\\envil, \\energyMakePool).notNil.if(1, 0);`,
        `var isPS = currentEnvironment.isKindOf(ProxySpace).if(1, 0);`,
        `var toks = (Library.at(\\envil, \\energyTokens) ?? { List.new }).size;`,
        `addr.sendMsg("/envilEnergyStatus", ready, isPS, toks);`,
        `)`,
    ].join(' ');
}

function pushGraphToSC(state) {
    for (const chunk of buildGraphChunks(state)) sendSC(chunk, true);
}

function pushConfigToSC(state) {
    sendSC(buildConfigCode(state), true);
}

function pushAllToSC(state) {
    sendSC(buildEnergyBackboneCode(), true);
    sendSC(buildEnergyTokenCode(), true);
    pushConfigToSC(state);
    pushGraphToSC(state);
    _backboneSent = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY PORT + HEARTBEAT
// ─────────────────────────────────────────────────────────────────────────────

function ensureNotifyPort() {
    if (_notifyPort) return;
    try {
        _notifyPort = new osc.UDPPort({ localAddress: '127.0.0.1', localPort: 0, broadcast: false });
        _notifyPort.on('ready', () => {
            try { _notifyPortNumber = _notifyPort.socket.address().port; } catch (_) { _notifyPortNumber = 0; }
            log(`⚡ energy notify port ready @ udp://127.0.0.1:${_notifyPortNumber}`);
        });
        _notifyPort.on('error', (err) => console.warn('[energy] notify port error:', err.message));
        _notifyPort.on('message', (oscMsg) => {
            try {
                if (!oscMsg) return;
                if (oscMsg.address === '/envilEnergyTok') handleTokenMsg(oscMsg);
                else if (oscMsg.address === '/envilEnergyStatus') handleStatusMsg(oscMsg);
            } catch (e) { console.warn('[energy] notify handler error:', e.message); }
        });
        _notifyPort.open();
    } catch (e) {
        console.warn('[energy] failed to open notify port:', e.message);
        _notifyPort = null;
    }
}

function oscArg(a) { return a && a.value != null ? a.value : a; }

function handleTokenMsg(oscMsg) {
    const a = (oscMsg.args || []).map(oscArg);
    // [id, kind, arg1, arg2, (dur)]
    if (!_panel) return;
    _panel.webview.postMessage({
        type: 'token-event',
        id: Number(a[0]) | 0,
        kind: String(a[1] || ''),
        a: String(a[2] != null ? a[2] : ''),
        b: String(a[3] != null ? a[3] : ''),
        dur: Number(a[4]) || 0,
    });
}

function handleStatusMsg(oscMsg) {
    const a = (oscMsg.args || []).map(x => Number(oscArg(x)) | 0);
    const status = { ready: !!a[0], isProxySpace: !!a[1], tokens: a[2] | 0 };
    if (_panel) _panel.webview.postMessage({ type: 'status', status });
    // Self-heal: backbone missing (fresh sclang) → re-push everything, throttled
    if (!status.ready) {
        const now = Date.now();
        if (now - _lastRepairMs > 15000) {
            _lastRepairMs = now;
            pushAllToSC(loadState());
            log('⚡ [energy] backbone missing — re-pushed');
        }
    }
}

function startHeartbeat() {
    if (_heartbeatTimer) return;
    _heartbeatTimer = setInterval(() => {
        try {
            const sc = _getSC ? _getSC() : null;
            if (!sc || !sc.isSclangRunning()) {
                _backboneSent = false;
                if (_panel) _panel.webview.postMessage({ type: 'status', status: { ready: false, isProxySpace: false, tokens: 0, sclangDown: true } });
                return;
            }
            const code = buildStatusQueryCode();
            if (code) sendSC(code, true);
        } catch (e) { console.warn('[energy] heartbeat error:', e.message); }
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function sendSC(code, silent = false) {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning()) return;
    sc.sendCode(code, silent);
}

function log(msg) {
    if (_hydraOutput) _hydraOutput.appendLine(msg);
}

module.exports = {
    registerEnergyMachine,
    // exported for offline codegen testing
    _test: { buildEnergyBackboneCode, buildEnergyTokenCode, buildGraphChunks, buildConfigCode, defaultState, sanitizeState },
};
