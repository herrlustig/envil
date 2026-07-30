// @ts-nocheck
// energy-machine.js
//
// "Energy machine" — a visual node-network panel where energy tokens walk
// from an energy source through pattern pools and back. Each pool is exposed
// as a normal ProxySpace proxy (~poolA, ~poolB, …) whose source is a Pspawner
// that plays whatever pattern the arriving token picked. The token routing
// itself runs sclang-side (Routines on TempoClock.default, so travel/dwell
// are in beats and follow tap-tempo), so closing the panel
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

function registerEnergyMachine(context, { getSC, hydraOutput, extensionPath, workspacePath, autoOpen }) {
    _getSC = getSC;
    _hydraOutput = hydraOutput;
    _workspacePath = workspacePath || null;
    _extensionPath = extensionPath;

    context.subscriptions.push(
        vscode.commands.registerCommand('envil.energyMachine.open', () => openPanel(context)),
        vscode.commands.registerCommand('envil.energyMachine.close', () => closePanel()),
    );

    // Auto-open on startup (small delay so editors have time to settle)
    if (autoOpen) {
        setTimeout(() => { try { openPanel(context); } catch (e) { console.warn('[energy] autoOpen failed:', e.message); } }, 800);
    }
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
        case 'inject-token': {
            const pool = sanitizePoolName(msg.pool);
            if (pool) sendSC(`Library.at(\\envil, \\energySpawnToken) !? { |f| f.value(\\${pool}) }`, true);
            return;
        }
        case 'steal-token': {
            sendSC(`Library.at(\\envil, \\energySteal) !? { |f| f.value(${Number(msg.id) | 0}) }`, true);
            return;
        }
        case 'release-token': {
            sendSC(`Library.at(\\envil, \\energyRelease) !? { |f| f.value(${Number(msg.id) | 0}) }`, true);
            return;
        }
        case 'check-pattern': {
            const reqId = Number(msg.reqId) | 0;
            const lit = scStr(String(msg.text || ''));
            if (!_notifyPortNumber || lit.length > MAX_PAYLOAD - 400) {
                if (_panel) _panel.webview.postMessage({ type: 'check-result', reqId, ok: false, err: 'cannot check (too long or no OSC port)' });
                return;
            }
            sendSC([
                `(`,
                `var addr = NetAddr("127.0.0.1", ${_notifyPortNumber});`,
                `var r = try { ${lit}.interpret } { |err| err.errorString };`,
                `if(r.isKindOf(Pattern), { addr.sendMsg("/envilEnergyCheck", ${reqId}, 1, "ok") }, {`,
                `  addr.sendMsg("/envilEnergyCheck", ${reqId}, 0, if(r.isNil, { "syntax error (see SC post window)" }, { ("not a Pattern: " ++ r.asString).keep(140) }));`,
                `});`,
                `)`,
            ].join(' '), true);
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
        maxPatDur: 20,
        overrides: [],
        nodes: [
            { id: 'source', type: 'source', x: 90, y: 260, outs: [{ to: 'poolA', weight: 1 }] },
            {
                id: 'poolA', type: 'pool', x: 320, y: 120, toSourceWeight: 1,
                outs: [{ to: 'poolB', weight: 1 }, { to: 'poolA', weight: 0 }],
                patterns: [
                    { id: 'p1', name: 'up', weight: 1, text: 'Pbind(\\degree, Pseq([0, 2, 4, 7], 2), \\dur, 0.25, \\amp, 0.2)' },
                ],
            },
            {
                id: 'poolB', type: 'pool', x: 320, y: 400, toSourceWeight: 1,
                outs: [{ to: 'poolB', weight: 0 }],
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
        travelTime: clampNum(s.travelTime, 0, 30, 1.5),
        dwellTime: clampNum(s.dwellTime, 0, 30, 0.6),
        maxPatDur: clampNum(s.maxPatDur, 1, 3600, 20),
        distanceMode: !!s.distanceMode,
        overrides: sanitizeOvr(s.overrides),
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
            // null = no return edge; a number (incl. 0) = visible edge
            toSourceWeight: n.toSourceWeight == null ? null : clampNum(n.toSourceWeight, 0, 100, 1),
            quant: clampNum(n.quant, 0, 256, 0),
            mode: n.mode === 'par' ? 'par' : 'seq',
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
            overrides: sanitizeOvr(n.overrides),
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

// Overrides: [{key, value}] — key becomes an SC symbol, value stays a source
// string interpreted at grant time (so edits apply on the next token visit).
function sanitizeOvr(list) {
    return (Array.isArray(list) ? list : [])
        .filter(o => o && typeof o === 'object')
        .map(o => ({
            key: String(o.key || '').replace(/[^A-Za-z0-9_]/g, ''),
            value: String(o.value != null ? o.value : '').trim(),
        }))
        .filter(o => o.key && o.value);
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
        `Library.put(\\envil, \\energyNotify, if(${_notifyPortNumber || 0} > 0, { NetAddr("127.0.0.1", ${_notifyPortNumber || 0}) }, { nil }));`,
        `if(Library.at(\\envil, \\energyTokens).isNil, { Library.put(\\envil, \\energyTokens, List.new) });`,
        `if(Library.at(\\envil, \\energyNextTok).isNil, { Library.put(\\envil, \\energyNextTok, 0) });`,
        `if(Library.at(\\envil, \\energyCfg).isNil, { Library.put(\\envil, \\energyCfg, (travel: 1.5, dwell: 0.6, maxDur: 20)) });`,
        `Library.put(\\envil, \\energyMkOvr, { |list|`,
        `  var out = List.new;`,
        `  (list ? []).do { |kv|`,
        `    var v = try { kv[1].interpret } { |err| ("[energy] override " ++ kv[0] ++ " skipped: " ++ err.errorString).warn; nil };`,
        `    if(v.notNil, { out.add(kv[0]); out.add(v) });`,
        `  };`,
        `  out.asArray;`,
        `});`,
        `Library.put(\\envil, \\energyMakePool, { |name|`,
        `  Pspawner({ |sp|`,
        `    Library.put(\\envil, \\energySpawners, name, sp);`,
        `    loop {`,
        `      var q = Library.at(\\envil, \\energyQueues, name);`,
        `      var item, node, quant, mode, str, b;`,
        `      if(q.notNil and: { q.size > 0 }, { item = q.removeAt(0) });`,
        `      if(item.notNil, {`,
        `        node = Library.at(\\envil, \\energyGraph) !? { |g| g.at(name) };`,
        `        quant = ((node !? { node[\\quant] }) ? 0).max(0);`,
        `        if(quant > 0, { b = thisThread.clock.beats; sp.wait((quant - (b % quant)) % quant) });`,
        `        str = sp.par(Pfset({}, Pprotect(item[0], { |err| ("[energy] pattern error in " ++ name ++ ": " ++ err.errorString).warn }), { item[1].test = true; item[1].signal }));`,
        `        item[2] !? { Library.put(\\envil, \\energyPlaying, item[2], [name, str, item[1]]) };`,
        `        mode = (node !? { node[\\mode] }) ? \\seq;`,
        `        if(mode != \\par, { while({ item[1].test.not }, { sp.wait(0.1) }) });`,
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
        `        pr.mold(2, \\audio);`,
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
        `Library.put(\\envil, \\energySpawnToken, { |startPos|`,
        `  var id = Library.at(\\envil, \\energyNextTok) ? 0;`,
        `  var rout;`,
        `  Library.put(\\envil, \\energyNextTok, id + 1);`,
        `  rout = Routine({`,
        `    var pos = (startPos ? \\source).asSymbol, graph, cfg, addr, node, outs, dest, pats, pick, patObj, cond, w, dwell, travel, pickO, tdur, tf, prog, c2, dd, sl;`,
        `    addr = Library.at(\\envil, \\energyNotify);`,
        `    Library.put(\\envil, \\energyTokPos, id, pos);`,
        `    addr !? { addr.sendMsg("/envilEnergyTok", id, "at", pos.asString, "") };`,
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
        `            var po = Library.at(\\envil, \\energyMkOvr).value(node[\\ovr]);`,
        `            var go = Library.at(\\envil, \\energyMkOvr).value(cfg[\\govr]);`,
        `            if(po.size > 0, { patObj = Pbindf.performList(\\new, [patObj] ++ po) });`,
        `            if(go.size > 0, { patObj = Pbindf.performList(\\new, [patObj] ++ go) });`,
        `            patObj = Pfindur(cfg[\\maxDur] ? 20, patObj);`,
        `            if(q.notNil, {`,
        `              cond = Condition(false);`,
        `              q.add([patObj, cond, id]);`,
        `              addr !? { addr.sendMsg("/envilEnergyTok", id, "play", pos.asString, pick[\\id].asString) };`,
        `              cond.wait;`,
        `              Library.put(\\envil, \\energyPlaying, id, nil);`,
        `            }, {`,
        `              addr !? { addr.sendMsg("/envilEnergyTok", id, "skip", pos.asString, "noqueue") };`,
        `              dwell.max(0.05).wait;`,
        `            });`,
        `          }, {`,
        `            addr !? { addr.sendMsg("/envilEnergyTok", id, "skip", pos.asString, if(pick.isNil, { "empty" }, { pick[\\id].asString })) };`,
        `            dwell.max(0.05).wait;`,
        `          });`,
        `        }, { dwell.wait });`,
        `        outs = node[\\outs] ? [];`,
        `        if(outs.size == 0, { outs = [[\\source, 1.0]] });`,
        `        pickO = outs.wchoose(outs.collect({ |o| (o[1] ? 1).max(0.0001) }).normalizeSum);`,
        `        dest = pickO[0];`,
        `        tf = if(pickO.size > 2, { pickO[2] ? 1 }, { 1 });`,
        `        tdur = if((cfg[\\useDist] ? 0) > 0, { travel * tf }, { travel });`,
        `        addr !? { addr.sendMsg("/envilEnergyTok", id, "travel", pos.asString, dest.asString, tdur) };`,
        `        // sliced wait: re-reads cfg each tick so travel-slider moves apply mid-flight`,
        `        prog = 0;`,
        `        while({ prog < 1 }, {`,
        `          c2 = Library.at(\\envil, \\energyCfg) ? ();`,
        `          dd = if((c2[\\useDist] ? 0) > 0, { (c2[\\travel] ? 1.5) * tf }, { c2[\\travel] ? 1.5 }).max(0.02);`,
        `          sl = 0.05.min(dd);`,
        `          sl.wait;`,
        `          prog = prog + (sl / dd);`,
        `        });`,
        `        pos = dest;`,
        `        Library.put(\\envil, \\energyTokPos, id, pos);`,
        `        if(pos == \\source, { addr !? { addr.sendMsg("/envilEnergyTok", id, "at", "source", "") } });`,
        `      });`,
        `    };`,
        `  }).play(TempoClock.default);`,
        `  Library.at(\\envil, \\energyTokens).add([id, rout]);`,
        `  ("[energy] token " ++ id ++ " spawned").postln;`,
        `  id;`,
        `});`,
        `Library.put(\\envil, \\energyRecall, {`,
        `  var toks = Library.at(\\envil, \\energyTokens).copy;`,
        `  toks.do({ |t| Library.at(\\envil, \\energySteal) !? { |f| f.value(t[0]) } });`,
        `  "[energy] all tokens recalled".postln;`,
        `});`,
        `)`,
    ].join('\n');
}

/**
 * Extras: token steal (surgical sp.suspend of the tracked child stream),
 * per-pool VU meters (InFeedback synth on each pool bus → SendReply →
 * forwarded to the panel), ServerTree re-registration for reboot.
 */
function buildEnergyExtrasCode() {
    return [
        `(`,
        `// ── envil energy machine: steal + release + VU extras ──`,
        `Library.put(\\envil, \\energyRelease, { |id|`,
        `  var pl = Library.at(\\envil, \\energyPlaying, id);`,
        `  var sp;`,
        `  if(pl.notNil, {`,
        `    sp = Library.at(\\envil, \\energySpawners, pl[0]);`,
        `    sp !? { try { sp.suspend(pl[1]) } };`,
        `    Library.put(\\envil, \\energyPlaying, id, nil);`,
        `    pl[2].test = true; pl[2].signal;`,
        `    ("[energy] token " ++ id ++ " released from pattern").postln;`,
        `  });`,
        `});`,
        `Library.put(\\envil, \\energySteal, { |id|`,
        `  var toks = Library.at(\\envil, \\energyTokens);`,
        `  var addr = Library.at(\\envil, \\energyNotify);`,
        `  var idx = toks.detectIndex({ |t| t[0] == id });`,
        `  var tok, pl, sp;`,
        `  if(idx.notNil, {`,
        `    tok = toks.removeAt(idx);`,
        `    tok[1].stop;`,
        `    pl = Library.at(\\envil, \\energyPlaying, id);`,
        `    if(pl.notNil, {`,
        `      sp = Library.at(\\envil, \\energySpawners, pl[0]);`,
        `      sp !? { try { sp.suspend(pl[1]) } };`,
        `      pl[2].test = true;`,
        `      Library.put(\\envil, \\energyPlaying, id, nil);`,
        `    });`,
        `    (Library.at(\\envil, \\energyQueues) ?? { () }).do({ |q|`,
        `      var keep;`,
        `      if(q.isKindOf(List), { keep = q.reject({ |it| it[2] == id }); q.clear; keep.do({ |x| q.add(x) }) });`,
        `    });`,
        `    addr !? { addr.sendMsg("/envilEnergyTok", id, "gone", "", "") };`,
        `    ("[energy] token " ++ id ++ " recalled").postln;`,
        `  });`,
        `});`,
        `Library.put(\\envil, \\energyVURefresh, {`,
        `  Routine({`,
        `    var names, ps, srv = Server.default, t = 0;`,
        `    while({ srv.serverRunning.not and: { t < 10 } }, { 0.2.wait; t = t + 0.2 });`,
        `    if(srv.serverRunning, {`,
        `      names = Library.at(\\envil, \\energyPoolNames) ? [];`,
        `      ps = Library.at(\\envil, \\pspace);`,
        `      if(ps.isNil and: { currentEnvironment.isKindOf(ProxySpace) }, { ps = currentEnvironment });`,
        `      if(ps.notNil, {`,
        `        SynthDef(\\envilEnergyVU, { |bus=0, idx=0|`,
        `          var sig = InFeedback.ar(bus, 2);`,
        `          SendReply.kr(Impulse.kr(12), '/envilEnergyVU', [Amplitude.kr(Mix(sig) * 0.7).ampdb.clip(-60, 0)], idx);`,
        `        }).add;`,
        `        srv.sync;`,
        `        (Library.at(\\envil, \\energyVUSyns) ? ()).do({ |s| try { s.free } });`,
        `        Library.put(\\envil, \\energyVUSyns, ());`,
        `        names.do({ |name, i|`,
        `          var pr = ps.at(name);`,
        `          if(pr.loaded.not and: { pr.source.notNil }, {`,
        `            pr.wakeUp;`,
        `            ("[energy] pool ~" ++ name ++ " woken (was not running)").postln;`,
        `          });`,
        `          if(pr.bus.notNil, {`,
        `            Library.at(\\envil, \\energyVUSyns)[name] = Synth(\\envilEnergyVU, [\\bus, pr.bus.index, \\idx, i], RootNode(srv), \\addToTail);`,
        `          });`,
        `        });`,
        `      });`,
        `    });`,
        `  }).play(AppClock);`,
        `});`,
        `OSCdef(\\envilEnergyVU, { |msg|`,
        `  var addr = Library.at(\\envil, \\energyNotify);`,
        `  addr !? { addr.sendMsg("/envilEnergyVU", msg[2], msg[3]) };`,
        `}, '/envilEnergyVU');`,
        `(Library.at(\\envil, \\energyTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\energyTreeFn, { Library.at(\\envil, \\energyVURefresh) !? { |f| f.value } });`,
        `ServerTree.add(Library.at(\\envil, \\energyTreeFn), Server.default);`,
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

    // Node centers for the 'travel distance' mode. Must match the panel's
    // nodeCenter(): source = x+28,y+28; pool = x+90, y + poolH/2 where
    // poolH = HEADER(24)+6 + nPats*34 + ovrRows*18 + FOOTER(24)
    //       = 54 + nPats*34 + ovrRows*18.
    // ovrRowsOf mirrors the panel's ovrLayout() wrap math.
    const ovrRowsOf = (n) => {
        let x = 41, row = 0;
        for (const o of (n.overrides || [])) {
            const short = o.value.length > 10 ? o.value.slice(0, 9) + '…' : o.value;
            const w = (o.key.length + short.length + 2) * 5 + 21;
            if (x + w > 172 && x > (row === 0 ? 41 : 9)) { x = 9; row++; }
            x += w + 4;
        }
        return row + 1;
    };
    const centerOf = (n) => n.type === 'source'
        ? { x: num(n.x, 0) + 28, y: num(n.y, 0) + 28 }
        : { x: num(n.x, 0) + 90, y: num(n.y, 0) + (54 + (n.patterns || []).length * 34 + ovrRowsOf(n) * 18) / 2 };
    const distF = (a, b) => {
        if (!a || !b || a === b) return 1;   // self-loop = 1x travel
        const ca = centerOf(a), cb = centerOf(b);
        const f = Math.hypot(cb.x - ca.x, cb.y - ca.y) / 300;   // 300px = 1x travel
        return Math.round(Math.min(8, Math.max(0.05, f)) * 100) / 100;
    };
    const nodeById = (id) => state.nodes.find(n => n.id === id);
    // Edge weight: keep 0 as 0 (visible, ~never picked) — only default missing/NaN to 1
    const wnum = (w) => Number.isFinite(Number(w)) ? Number(w) : 1;

    // source node: outs point to pools (explicit edges live on source.outs? no —
    // source edges are stored on the source node in the webview state)
    const srcOuts = (source && Array.isArray(source.outs)) ? source.outs : [];
    const srcOutsCode = srcOuts
        .filter(o => pools.some(pl => pl.id === o.to))
        .map(o => `[\\${o.to}, ${wnum(o.weight)}, ${distF(source, nodeById(o.to))}]`)
        .join(', ');
    chunks.push(`(var g = Library.at(\\envil, \\energyGraphNew); g[\\source] = (outs: [${srcOutsCode}], pats: []);)`);

    for (const pool of pools) {
        const outs = [];
        for (const o of pool.outs) {
            if (o.to !== 'source' && pools.some(pl => pl.id === o.to)) {
                outs.push(`[\\${o.to}, ${wnum(o.weight)}, ${distF(pool, nodeById(o.to))}]`);
            }
        }
        if (pool.toSourceWeight != null) {
            outs.push(`[\\source, ${wnum(pool.toSourceWeight)}, ${distF(pool, source)}]`);
        }
        // Header chunk for the pool (outs + empty pats)
        chunks.push(`(var g = Library.at(\\envil, \\energyGraphNew); g[\\${pool.id}] = (outs: [${outs.join(', ')}], pats: List.new, ovr: List.new, quant: ${Number(pool.quant) || 0}, mode: \\${pool.mode === 'par' ? 'par' : 'seq'});)`);
        // One chunk per pattern (texts can be long)
        for (const pt of pool.patterns) {
            const code = `(var g = Library.at(\\envil, \\energyGraphNew); g[\\${pool.id}][\\pats].add((id: ${scStr(pt.id)}, w: ${Number(pt.weight) || 1}, src: ${scStr(pt.text)}));)`;
            if (code.length > MAX_PAYLOAD) {
                log(`⚠ [energy] pattern "${pt.name}" too long (${code.length} chars) — skipped in SC push`);
                continue;
            }
            chunks.push(code);
        }
        // One chunk per override
        for (const ov of (pool.overrides || [])) {
            const oc = `(var g = Library.at(\\envil, \\energyGraphNew); g[\\${pool.id}][\\ovr].add([\\${ov.key}, ${scStr(ov.value)}]);)`;
            if (oc.length > MAX_PAYLOAD) {
                log(`⚠ [energy] override "${ov.key}" too long — skipped in SC push`);
                continue;
            }
            chunks.push(oc);
        }
    }

    const poolSyms = pools.map(p => `\\${p.id}`).join(', ');
    chunks.push([
        `(`,
        `Library.put(\\envil, \\energyGraph, Library.at(\\envil, \\energyGraphNew));`,
        `Library.put(\\envil, \\energyPoolNames, [${poolSyms}]);`,
        `Library.at(\\envil, \\energyEnsurePools) !? { |f| f.value([${poolSyms}]) };`,
        `Library.at(\\envil, \\energyVURefresh) !? { |f| f.value };`,
        `("[energy] graph updated (" ++ ${pools.length} ++ " pools)").postln;`,
        `)`,
    ].join(' '));

    return chunks;
}

function buildConfigCode(state) {
    const govr = (state.overrides || []).map(o => `[\\${o.key}, ${scStr(o.value)}]`).join(', ');
    return `Library.put(\\envil, \\energyCfg, (travel: ${state.travelTime}, dwell: ${state.dwellTime}, maxDur: ${state.maxPatDur}, useDist: ${state.distanceMode ? 1 : 0}, govr: [${govr}]));`;
}

function buildStatusQueryCode() {
    if (!_notifyPortNumber) return '';
    return [
        `(`,
        `var addr = NetAddr("127.0.0.1", ${_notifyPortNumber});`,
        `var ready = Library.at(\\envil, \\energyMakePool).notNil.if(1, 0);`,
        `var isPS = currentEnvironment.isKindOf(ProxySpace).if(1, 0);`,
        `var toks = (Library.at(\\envil, \\energyTokens) ?? { List.new }).size;`,
        `addr.sendMsg("/envilEnergyStatus", ready, isPS, toks, TempoClock.default.tempo);`,
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
    sendSC(buildEnergyExtrasCode(), true);
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
            // If the backbone was already pushed with port 0 (race at startup),
            // fix the SC-side notify address now — else VU/token sends spam
            // "_NetAddr_SendMsg failed" on a port-0 NetAddr.
            if (_backboneSent && _notifyPortNumber) {
                sendSC(`Library.put(\\envil, \\energyNotify, NetAddr("127.0.0.1", ${_notifyPortNumber}))`, true);
            }
        });
        _notifyPort.on('error', (err) => console.warn('[energy] notify port error:', err.message));
        _notifyPort.on('message', (oscMsg) => {
            try {
                if (!oscMsg) return;
                if (oscMsg.address === '/envilEnergyTok') handleTokenMsg(oscMsg);
                else if (oscMsg.address === '/envilEnergyStatus') handleStatusMsg(oscMsg);
                else if (oscMsg.address === '/envilEnergyCheck') handleCheckMsg(oscMsg);
                else if (oscMsg.address === '/envilEnergyVU') handleVUMsg(oscMsg);
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

function handleCheckMsg(oscMsg) {
    const a = (oscMsg.args || []).map(oscArg);
    if (!_panel) return;
    _panel.webview.postMessage({
        type: 'check-result',
        reqId: Number(a[0]) | 0,
        ok: !!Number(a[1]),
        err: String(a[2] != null ? a[2] : ''),
    });
}

function handleVUMsg(oscMsg) {
    const a = (oscMsg.args || []).map(oscArg);
    if (!_panel) return;
    _panel.webview.postMessage({ type: 'vu', idx: Number(a[0]) | 0, db: Number(a[1]) || -60 });
}

function handleStatusMsg(oscMsg) {
    const a = (oscMsg.args || []).map(oscArg);
    // NB: tempo must stay a float (beats/sec) — do NOT truncate with |0
    const status = { ready: !!Number(a[0]), isProxySpace: !!Number(a[1]), tokens: Number(a[2]) | 0, tempo: Number(a[3]) || 0 };
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
    _test: { buildEnergyBackboneCode, buildEnergyTokenCode, buildEnergyExtrasCode, buildGraphChunks, buildConfigCode, defaultState, sanitizeState },
};
