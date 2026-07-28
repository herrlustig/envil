// @ts-nocheck
const vscode = require('vscode');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jsonc = require('jsonc-parser');
const { isEnvironmentActive, envilEnvironmentContextKey } = require('./supercollider/util');
const { registerHydraProviders } = require('./hydra-language-support');
const { registerHoverSlider } = require('./hover-slider');
const { registerBlockCodeLens, CMD_RUN_SC_BLOCK, CMD_RUN_HYDRA_BLOCK } = require('./codelens-blocks');
const { extractExpressions } = require('./peek-expressions');

const ENVIL_BUILD_STAMP = '20260728-163917';   // rewritten by rebuild-install.sh

// Auto-watch SC proxies referenced as _s.<name> in evaluated Hydra code.
// Knob/macro/seq aliases (v_c*, v_n*, mcr_*, seq_*) are served by their own
// pipelines — anything else is an SC bus that needs the sc-bridge poller.
const _autoWatched = new Set();
function autoWatchScAliases(text) {
    const scBridgeMod = require('./sc-bridge');
    const re = /_s\.([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        if (/^(v_c\d+|v_n\d*|v_n_val|mcr_\d+|seq_\w+)$/.test(name)) continue;
        if (_autoWatched.has(name) || scBridgeMod.getWatchedNames().includes(name)) continue;
        _autoWatched.add(name);
        scBridgeMod.watchProxy(name).then(ok => {
            if (!ok) _autoWatched.delete(name);   // retry on next eval
            if (hydraOutput) {
                hydraOutput.appendLine(ok
                    ? `  \u{1F517} sc-bridge: auto-watching ~${name} (used as _s.${name})`
                    : `  \u26A0 sc-bridge: could not resolve ~${name} — is the proxy playing?`);
            }
        }).catch(() => _autoWatched.delete(name));
    }
}
const { registerTouchKnobs, hasEnvilDir, buildDynbufBootInitSCCode, buildDynbufBackboneRegisterCode, buildKnobResyncRegisterCode, buildTempoProxyRegisterCode } = require('./touch-knobs');
const { registerEnergyMachine } = require('./energy-machine');
const { registerProxyCompletions } = require('./proxy-completions');
const { registerEnvCompletions, clearEnvKeyCache } = require('./env-completions');
const { registerPbindCompletions } = require('./pbind-completions');
const { registerSCCompletions, clearSCCompletionCaches } = require('./sc-completions');
const scBridge = require('./sc-bridge');
const suggestions = require('./suggestions');
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
let queueStatusBar = null;
let _isSCSynthRunning = false;

// Hydra output channel
let hydraOutput = null;

// ── Server options SC code builder ────────────────────────────────────────────
//
// Applies the configured hardware I/O channel counts to s.options.
// MUST be evaluated BEFORE s.boot / s.reboot / s.waitForBoot — scsynth reads
// the options only at boot time. Because this runs right before the plugin
// boots the server (i.e. AFTER startup.scd already ran), these values win
// over anything a user startup file set earlier.

function buildServerOptionsSCCode() {
    const cfg = vscode.workspace.getConfiguration('envil.supercollider.server');
    const ins = cfg.get('numInputBusChannels', 4);
    const outs = cfg.get('numOutputBusChannels', 2);
    return [
        `s.options.numInputBusChannels = ${ins};`,
        `s.options.numOutputBusChannels = ${outs};`,
        `"[envil] server options: ${ins} ins / ${outs} outs".postln;`,
    ].join('\n');
}

// ── Input proxy SC code builder ───────────────────────────────────────────────
//
// Generates SC code that creates, for each hardware input channel:
//   ~i0 … ~iN        — SoundIn.ar with LeakDC + gentle compression
//   ~pd0 … ~pdN      — pitch analysis bundle [latchedFreq, gate] (internal;
//                      Tartini/Pitch runs ONCE here — it's CPU-heavy)
//   ~f0 … ~fN        — latched pitch (reads ~pdN channel 0)
//   ~hasFreq0 … N    — pitch-confidence gate 0/1 (reads ~pdN channel 1)
//   ~a0 … ~aN        — amplitude follower
//
// Inspired by my_footcontroller.sc  e[\setupProxy]
// Must be called from INSIDE s.waitForBoot (needs running server).

function buildInputProxySCCode() {
    const cfg = vscode.workspace.getConfiguration('envil.supercollider.proxySpace');
    const n = cfg.get('numInputs', 2);
    if (n <= 0) return '';

    const method = cfg.get('pitchMethod', 'Tartini');

    const lines = [];
    lines.push(`  // ── audio inputs + analysis (numInputs=${n}, pitch=${method}) ──`);

    for (let i = 0; i < n; i++) {
        // ~iN — audio input proxy
        lines.push(`  ~i${i}.ar(1);`);
        lines.push(`  ~i${i} = {`);
        lines.push(`    var in = SoundIn.ar(${i});`);
        lines.push(`    in = LeakDC.ar(in);`);
        lines.push(`    in = Compander.ar(in, in, thresh: 0.04, slopeBelow: 10, slopeAbove: 1, clampTime: 0.01, relaxTime: 0.01);`);
        lines.push(`    in;`);
        lines.push(`  };`);

        // ~pdN — analysis bundle [freqLatched, gate]; the (expensive) pitch
        // UGen lives ONLY here so ~fN + ~hasFreqN don't double the CPU cost.
        // Tartini mode auto-falls back to Pitch.kr if sc3-plugins not installed.
        if (method === 'Tartini' || method === 'Pitch') {
            lines.push(`  ~pd${i}.kr(2);`);
            lines.push(`  ~pd${i}.fadeTime = 0;`);
            lines.push(`  ~pd${i} = { |threshold=0.9, maxFreq=2000|`);
            lines.push(`    var in = Mix(~i${i}.ar);`);
            lines.push(`    var freq, hasFreq, gate;`);
            if (method === 'Tartini') {
                lines.push(`    #freq, hasFreq = if(\\Tartini.asClass.notNil, {`);
                lines.push(`      \\Tartini.asClass.kr(in, n: 4096);`);
                lines.push(`    }, {`);
                lines.push(`      Pitch.kr(in, minFreq: 60, maxFreq: maxFreq, ampThreshold: 0.05);`);
                lines.push(`    });`);
            } else {
                lines.push(`    #freq, hasFreq = Pitch.kr(in, minFreq: 60, maxFreq: maxFreq, ampThreshold: 0.05);`);
            }
            lines.push(`    gate = (hasFreq > threshold) * (freq < maxFreq);`);
            lines.push(`    [Latch.kr(freq, gate), gate];`);
            lines.push(`  };`);
            lines.push(`  ~f${i}.kr(1);`);
            lines.push(`  ~f${i}.fadeTime = 0;`);
            lines.push(`  ~f${i} = { ~pd${i}.kr(2)[0] };`);
            lines.push(`  ~hasFreq${i}.kr(1);`);
            lines.push(`  ~hasFreq${i}.fadeTime = 0;`);
            lines.push(`  ~hasFreq${i} = { ~pd${i}.kr(2)[1] };`);
        } else {
            // ZeroCrossing — lightest, rawer. Gate = amplitude threshold.
            lines.push(`  ~f${i}.kr(1);`);
            lines.push(`  ~f${i}.fadeTime = 0;`);
            lines.push(`  ~f${i} = { |maxFreq=2000|`);
            lines.push(`    var in = Mix(~i${i}.ar);`);
            lines.push(`    var freq;`);
            lines.push(`    in = LPF.ar(in, maxFreq);`);
            lines.push(`    freq = ZeroCrossing.ar(in);`);
            lines.push(`    freq.min(maxFreq);`);
            lines.push(`  };`);
            lines.push(`  ~hasFreq${i}.kr(1);`);
            lines.push(`  ~hasFreq${i}.fadeTime = 0;`);
            lines.push(`  ~hasFreq${i} = { |threshold=0.02| Amplitude.kr(Mix(~i${i}.ar)) > threshold };`);
        }

        // ~aN — amplitude follower proxy
        lines.push(`  ~a${i}.kr(1);`);
        lines.push(`  ~a${i}.fadeTime = 0;`);
        lines.push(`  ~a${i} = { Amplitude.kr(Mix(~i${i}.ar)) };`);
    }

    lines.push(`  "[envil] ${n} input proxies ready: ~i0..~i${n - 1}, ~f0.. ~hasFreq0.. ~a0..".postln;`);
    return lines.join('\n');
}

// ── Input proxy REGISTER code (self-init + self-heal) ────────────────────────
//
// Wraps buildInputProxySCCode in a Library function registered on ServerTree
// (same pattern as the dynbuf backbone): re-fires on EVERY server (re)boot,
// fires immediately if the server is already running, and wraps the body in
// `p.use { ... }` so tilde-syntax resolves to the ProxySpace regardless of
// which thread evaluates it (waitForBoot/AppClock does NOT — that was the bug
// that made ~i/~f/~a silently land nowhere).
// Send as its own executeCode write (keeps payloads under sclang's ~6KB stdin
// limit). Idempotent: re-evaluating replaces the previous ServerTree closure.

function buildInputProxyRegisterCode() {
    const body = buildInputProxySCCode();
    if (!body) return '';
    const indented = body.split('\n').map(l => '      ' + l).join('\n');
    return [
        `(`,
        `// ── envil input proxies: ServerTree-registered (self-init + self-heal) ──`,
        `// capture the MAIN-thread ProxySpace: this code arrives via stdin and runs`,
        `// on the interpreter thread — the SAME space the user's editor evals see.`,
        `// (currentEnvironment is per-thread; a ProxySpace.push inside a Routine/`,
        `// ServerTree fn diverges \`p\` from what the editor resolves ~tildes in!)`,
        `if(currentEnvironment.isKindOf(ProxySpace), { Library.put(\\envil, \\pspace, currentEnvironment) });`,
        `Library.put(\\envil, \\inputProxiesFn, {`,
        `  // throttle: ServerTree + boot-waiter can both fire within ms of each`,
        `  // other; a double re-assign overlaps two synths per proxy for fadeTime`,
        `  // seconds (Out.kr sums -> ~hasFreq reads 2!) and can orphan nodes.`,
        `  var last = Library.at(\\envil, \\inputProxiesLastFire) ? -10;`,
        `  if((Main.elapsedTime - last) > 5, {`,
        `    Library.put(\\envil, \\inputProxiesLastFire, Main.elapsedTime);`,
        `    Routine({`,
        `      var srv = Server.default;`,
        `      var ps = Library.at(\\envil, \\pspace) ? p;`,
        `      srv.sync;`,
        `      if(ps.isKindOf(ProxySpace), {`,
        `        ps.use({`,
        indented,
        `        });`,
        `      }, {`,
        `        "[envil] input proxies SKIPPED: no ProxySpace found".warn;`,
        `      });`,
        `    }).play;`,
        `  });`,
        `});`,
        `(Library.at(\\envil, \\inputProxiesTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\inputProxiesTreeFn, { Library.at(\\envil, \\inputProxiesFn).value });`,
        `ServerTree.add(Library.at(\\envil, \\inputProxiesTreeFn), Server.default);`,
        `// ── bus re-base on every boot ─────────────────────────────────────────`,
        `// SC's notify handshake (prHandleClientLoginInfoFromServer -> clientID_)`,
        `// resets ALL allocators on every boot. Our ONE surviving ProxySpace would`,
        `// keep stale bus indices that new allocations then collide with (kr buses`,
        `// sum -> macros read 0..2, bufplay ctrls shared with ~mcr_N!). ServerBoot`,
        `// runs AFTER that reset and BEFORE ServerTree (and NOT on Cmd-Period):`,
        `// free every proxy bus so everything re-allocates fresh. Sources are kept;`,
        `// proxies rebuild lazily (ServerTree heals + user evals).`,
        `// ALSO call serverQuit on each proxy: plain ProxySpaces never register`,
        `// for ServerQuit (only Ndef's dict does), so 'loaded' stays true across`,
        `// a reboot and proxies s_new synthdefs the NEW server never received`,
        `// ("Cannot create synth (synthdef: temp__...)" storms). serverQuit sets`,
        `// loaded=false -> defs are re-sent with the next rebuild.`,
        `(Library.at(\\envil, \\busRebaseFn)) !? { |fn| ServerBoot.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\busRebaseFn, {`,
        `  var ps = Library.at(\\envil, \\pspace) ? p;`,
        `  if(ps.isKindOf(ProxySpace), {`,
        `    ps.do { |px| px.serverQuit; if(px.bus.notNil, { px.freeBus }) };`,
        `    "[envil] proxy buses re-based (boot allocator reset)".postln;`,
        `  });`,
        `});`,
        `ServerBoot.add(Library.at(\\envil, \\busRebaseFn), Server.default);`,
        `// fire now if server is up — else wait up to 30s for it (adoption of an`,
        `// already-running server sets serverRunning asynchronously), else ServerTree`,
        `if(Server.default.serverRunning, {`,
        `  Library.at(\\envil, \\inputProxiesFn).value;`,
        `}, {`,
        `  "[envil] input proxies registered — waiting for server".postln;`,
        `  Routine({`,
        `    var n = 0;`,
        `    while({ Server.default.serverRunning.not and: { n < 60 } }, { 0.5.wait; n = n + 1 });`,
        `    if(Server.default.serverRunning, { Library.at(\\envil, \\inputProxiesFn).value });`,
        `  }).play(AppClock);`,
        `});`,
        `);`,
    ].join('\n');
}

// ── Default SynthDef loader (self-init + self-heal) ─────────────────────────
//
// Default synths live as plain .scd files (each holding `SynthDef(..).add;`
// code) in three conventional folders, later layers shadow same-named files:
//   bundled:   <extension>/supercollider/synthdefs/  — shipped with the plugin
//   global:    ~/.config/envil/synthdefs/            — shared across workspaces
//   workspace: <workspace>/.envil/synthdefs/         — workspace wins
// SC loads them via executeFile (no stdin size limit!) from a Library fn
// registered on ServerTree — SynthDefs die with the server, so they must be
// re-sent on EVERY (re)boot, same as buffers. The fn Routine-waits for
// serverRunning (SynthDef.add only sends to booted servers) and is throttled
// so racing boot paths collapse to one load.

function collectSynthDefFiles() {
    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;
    const dirs = [
        path.join(__dirname, 'supercollider', 'synthdefs'),
        path.join(os.homedir(), '.config', 'envil', 'synthdefs'),
        workspaceFolder ? path.join(workspaceFolder, '.envil', 'synthdefs') : null,
    ].filter(Boolean);
    const byName = new Map();   // later dirs (workspace) shadow same-named files
    for (const dir of dirs) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (f.endsWith('.scd') || f.endsWith('.sc')) byName.set(f, path.join(dir, f));
            }
        } catch (_) { /* dir missing — fine */ }
    }
    return Array.from(byName.keys()).sort().map(k => byName.get(k));
}

function buildSynthDefLoaderCode() {
    const enabled = vscode.workspace.getConfiguration('envil.supercollider.synthDefs').get('autoLoad', true);
    if (!enabled) return '';
    const files = collectSynthDefFiles();
    if (files.length === 0) return '';
    const list = files
        .map(f => `"${f.replace(/\\/g, '/').replace(/"/g, '\\"')}"`)
        .join(', ');
    return [
        `(`,
        `// ── envil default SynthDefs: (re)loaded from disk on every boot ──`,
        `Library.put(\\envil, \\synthDefFiles, [ ${list} ]);`,
        `Library.put(\\envil, \\synthDefsFn, {`,
        `  var last = Library.at(\\envil, \\synthDefsLastFire) ? -10;`,
        `  if((Main.elapsedTime - last) > 3, {`,
        `    Library.put(\\envil, \\synthDefsLastFire, Main.elapsedTime);`,
        `    Routine({`,
        `      var n = 0;`,
        `      while({ Server.default.serverRunning.not and: { n < 100 } }, { 0.1.wait; n = n + 1 });`,
        `      if(Server.default.serverRunning, {`,
        `        var files = Library.at(\\envil, \\synthDefFiles) ? [];`,
        `        var okCount = 0;`,
        `        files.do { |f| var r; try { r = thisProcess.interpreter.executeFile(f); if(r.isNil, { ("[envil] synthdef file SKIPPED (syntax error? see post window above): " ++ f).warn }, { okCount = okCount + 1 }) } { |err| ("[envil] synthdef file FAILED: " ++ f ++ " — " ++ err.errorString).warn } };`,
        `        ("[envil] " ++ okCount ++ "/" ++ files.size ++ " synthdef file(s) loaded").postln;`,
        `      });`,
        `    }).play(AppClock);`,
        `  });`,
        `});`,
        `(Library.at(\\envil, \\synthDefsTreeFn)) !? { |fn| ServerTree.remove(fn, Server.default) };`,
        `Library.put(\\envil, \\synthDefsTreeFn, { Library.at(\\envil, \\synthDefsFn).value });`,
        `ServerTree.add(Library.at(\\envil, \\synthDefsTreeFn), Server.default);`,
        `Library.at(\\envil, \\synthDefsFn).value;`,
        `);`,
    ].join('\n');
}

// ── Auto MIDI proxy SC code builder ──────────────────────────────────────────
//
// Ported from my_footcontroller.sc  e[\initMidi] + e[\createProxyPresets],
// but LAZY: instead of pre-creating 85 proxies × devices (old script needed
// maxNodes = 512*4 for that!), proxies are created on the FIRST message that
// touches them. Naming convention (same as the old rig):
//   ~<pfx>_c<num>    — CC value 0..1        (e.g. ~f_c49)
//   ~<pfx>_n<num>    — noteOn velocity 0..1, 0 again on noteOff
//   ~<pfx>_n         — last note number played on that device
//   ~<pfx>_n_val     — velocity of last note (0 on release)
//
// <pfx> comes from envil.supercollider.midi.devicePrefixes (case-insensitive
// substring match on "device name"); unknown devices share defaultPrefix.
// Language-level + idempotent (MIDIdef keys replace themselves) — send it
// OUTSIDE s.waitForBoot. Proxy creation is guarded until ProxySpace+server up.

function buildMidiProxySCCode() {
    const cfg = vscode.workspace.getConfiguration('envil.supercollider.midi');
    if (!cfg.get('autoProxies', true)) return '';

    const sanitizePfx = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'm';
    const defaultPrefix = sanitizePfx(cfg.get('defaultPrefix', 'm'));
    const watchdogSec = Math.max(0, Math.min(3600, Number(cfg.get('watchdogSeconds', 60)) || 0));
    const map = cfg.get('devicePrefixes', {}) || {};
    const pairs = Object.entries(map)
        .filter(([k, v]) => k && typeof v === 'string')
        .map(([k, v]) => `["${String(k).toLowerCase().replace(/[\\"]/g, '')}", "${sanitizePfx(v)}"]`)
        .join(', ');

    return [
        `{`,
        `// ── envil auto MIDI proxies (lazy) ──`,
        `var prefixMap = [ ${pairs} ];`,
        `var defaultPrefix = "${defaultPrefix}";`,
        `var watchdogSec = ${watchdogSec};`,
        `if(MIDIClient.initialized.not, { MIDIClient.init(verbose: false); MIDIIn.connectAll(false) });`,
        `Library.put(\\envil, \\midiPrefixCache, IdentityDictionary());`,
        `Library.put(\\envil, \\midiPrefixFor, { |srcID|`,
        `  var cache = Library.at(\\envil, \\midiPrefixCache);`,
        `  cache[srcID] ?? {`,
        `    var src = MIDIClient.sources.detect { |ep| ep.uid == srcID };`,
        `    var name = if(src.notNil, { (src.device.asString ++ " " ++ src.name.asString).toLower }, { "" });`,
        `    var hit = prefixMap.detect { |pair| name.contains(pair[0]) };`,
        `    var pfx = if(hit.notNil, { hit[1] }, { defaultPrefix });`,
        `    cache.put(srcID, pfx);`,
        `    ("[envil midi] device '" ++ name ++ "' -> ~" ++ pfx ++ "_c<num> / ~" ++ pfx ++ "_n<num>").postln;`,
        `    pfx;`,
        `  };`,
        `});`,
        `Library.put(\\envil, \\midiSetProxy, { |name, v|`,
        `  var ps = Library.at(\\envil, \\pspace) ? p;`,
        `  if(ps.isKindOf(ProxySpace) and: { Server.default.serverRunning }, {`,
        `    var px = ps[name.asSymbol];`,
        `    if(px.source.isNil or: { px.controlNames.isNil or: { px.controlNames.any({ |cn| cn.name == \\val }).not } }, {`,
        `      px.kr(1); px.source = { |val=0, lagTime=0| Lag.kr(val, lagTime) };`,
        `      ("[envil midi] created ~" ++ name).postln;`,
        `    });`,
        `    px.set(\\val, v);`,
        `  });`,
        `});`,
        `MIDIdef.cc(\\envilAutoCC, { |val, num, chan, src|`,
        `  var pfx = Library.at(\\envil, \\midiPrefixFor).value(src);`,
        `  Library.at(\\envil, \\midiSetProxy).value(pfx ++ "_c" ++ num, val / 127);`,
        `}).permanent_(true);`,
        `MIDIdef.noteOn(\\envilAutoNoteOn, { |vel, num, chan, src|`,
        `  var pfx = Library.at(\\envil, \\midiPrefixFor).value(src);`,
        `  var set = Library.at(\\envil, \\midiSetProxy);`,
        `  set.value(pfx ++ "_n" ++ num, vel / 127);`,
        `  set.value(pfx ++ "_n", num);`,
        `  set.value(pfx ++ "_n_val", vel / 127);`,
        `}).permanent_(true);`,
        `MIDIdef.noteOff(\\envilAutoNoteOff, { |vel, num, chan, src|`,
        `  var pfx = Library.at(\\envil, \\midiPrefixFor).value(src);`,
        `  var set = Library.at(\\envil, \\midiSetProxy);`,
        `  set.value(pfx ++ "_n" ++ num, 0);`,
        `  set.value(pfx ++ "_n_val", 0);`,
        `}).permanent_(true);`,
        `// watchdog: periodic MIDI reconnect (like e[\\startMidiWatchdog]) — 0 = off`,
        `Library.at(\\envil, \\midiWatchdog) !? { |r| try { r.stop } };`,
        `if(watchdogSec > 0, {`,
        `  var rt = Routine({`,
        `    loop {`,
        `      Library.put(\\envil, \\midiWatchdogBeat, Main.elapsedTime);`,
        `      try {`, 
        `        MIDIClient.sources.do { |src| if((src.device.asString ++ src.name.asString).contains("SuperCollider").not, { try { MIDIIn.connect(0, src) } }) };`,
        `        ("[envil midi] watchdog \u2713 " ++ MIDIClient.sources.size ++ " sources reconnected (every " ++ watchdogSec ++ "s)").postln;`,
        `      } { |err| ("[envil midi] watchdog error: " ++ err.errorString).postln };`,
        `      watchdogSec.wait;`,
        `    };`,
        `  }).play(AppClock);`,
        `  Library.put(\\envil, \\midiWatchdog, rt);`,
        `});`,
        `("[envil midi] auto proxies armed (" ++ MIDIClient.sources.size ++ " sources, default ~" ++ defaultPrefix ++ "_*, watchdog " ++ if(watchdogSec > 0, { watchdogSec.asString ++ "s" }, { "off" }) ++ ")").postln;`,
        `}.value;`,
    ].join('\n');
}

// ── Activate ─────────────────────────────────────────────────────────────────

async function activate(context) {
    // BUILD STAMP — updated by rebuild-install.sh; verifies which build is live
    console.log(`[envil] Activating... build ${ENVIL_BUILD_STAMP}`);
    try {
        vscode.window.setStatusBarMessage(`envil build ${ENVIL_BUILD_STAMP}`, 8000);
    } catch (_) {}

    const workspaceFolder = vscode.workspace.workspaceFolders
        ? vscode.workspace.workspaceFolders[0].uri.fsPath : null;

    // One-time hint: workspace synthdef folder convention
    if (workspaceFolder && !context.workspaceState.get('envil.synthDefHintShown')) {
        const sdDir = path.join(workspaceFolder, '.envil', 'synthdefs');
        if (!fs.existsSync(sdDir)) {
            vscode.window.showInformationMessage(
                '[envil] Tip: put SynthDef files (.scd/.sc ending in SynthDef(..).add) into ' +
                '.envil/synthdefs/ in your workspace — they auto-load on every server boot.',
                'Create folder', 'Got it'
            ).then(choice => {
                context.workspaceState.update('envil.synthDefHintShown', true);
                if (choice === 'Create folder') {
                    fs.mkdirSync(sdDir, { recursive: true });
                    vscode.window.showInformationMessage('[envil] created ' + sdDir);
                }
            });
        } else {
            context.workspaceState.update('envil.synthDefHintShown', true);
        }
    }

    // Status bar — all left-aligned, high priority so they stay visible on narrow windows
    //   Order (left→right): health bar (10000) → sclang (9999) → scsynth (9998)
    sclangStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9999);
    sclangStatusBar.command = 'envil.supercollider.toggleSCLang';
    sclangStatusBar.tooltip = 'Click to start/stop SuperCollider interpreter';
    scsynthStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9998);
    scsynthStatusBar.command = 'envil.supercollider.toggleSCSynth';
    scsynthStatusBar.tooltip = 'Click to boot/quit the SuperCollider server';
    queueStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    queueStatusBar.tooltip = 'SC Server Health — hover for details';
    updateSclangBar(false);
    updateScsynthBar(false);
    updateQueueBar(null);
    context.subscriptions.push(sclangStatusBar, scsynthStatusBar, queueStatusBar);

    // Hydra output channel
    if (!hydraOutput) {
        hydraOutput = vscode.window.createOutputChannel('Hydra');
        context.subscriptions.push(hydraOutput);
    }

    // Restore environment if it was previously active
    const isEnvActive = vscode.workspace.getConfiguration().get(envilEnvironmentContextKey) || false;
    // Post-start init for EVERY sclang spawn path (command, auto-start on
    // eval, …) — registered UNCONDITIONALLY so Ctrl+Enter auto-start gets the
    // identical init even when the envil environment flag is off.
    registerSclangStartCallback();
    if (isEnvActive) {
        showNotification('Loading ENVIL environment ...');
        startServersAndSockets(workspaceFolder);
        sclangStatusBar.show();
        scsynthStatusBar.show();
        // Heartbeat checks sclang (child process) + scsynth (OSC) every 3s
        startHeartbeat();
        // If both survived a window reload, reconnect ProxySpace
        probeAndReconnect();
    }

    // ── SuperCollider commands (implementations from client/out/sc.js) ────────

    context.subscriptions.push(

        vscode.commands.registerTextEditorCommand('envil.supercollider.executeBlock', async (editor) => {
            const sc = getSC(); if (!sc) return;
            await sc.executeBlock(editor);
        }),

        vscode.commands.registerCommand('envil.supercollider.startSCLang', async () => {
            const sc = getSC(); if (!sc) return;
            // Init (cache clears, probe, proxy registers, status bar) happens in
            // the onSclangStart callback — shared with the auto-start-on-eval path.
            await sc.startSclang();
        }),

        vscode.commands.registerCommand('envil.supercollider.stopSCLang', () => {
            const sc = getSC(); if (!sc) return;
            sc.stopSclang();
            updateSclangBar(false);
            // NOTE: do NOT touch scsynth bar — it's an independent process.
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
                    '// Hardware I/O channel counts (must be set before boot)',
                    buildServerOptionsSCCode(),
                    '// NOTE: no allocator resets here — we keep ONE ProxySpace per',
                    '// session, and its proxies own their buses. Resetting the',
                    '// allocators makes new proxies/buffers collide with them.',
                    'TempoClock.default = TempoClock(queueSize: 8192).permanent_(true);',
                    'if(currentEnvironment.isKindOf(ProxySpace).not, {',
                    '  p = ProxySpace.push(s);',
                    '  ~out.ar(2);',
                    '  p.fadeTime = 4;',
                    '  p.quant = 1;',
                    '  "[envil] ProxySpace pushed. fadeTime=4, quant=1".postln;',
                    '});',
                    '// dynbuf BACKBONE (ProxySpace-independent) — registers on ServerTree,',
                    '// auto-(re)builds on every (re)boot; fires immediately if server is up.',
                    buildDynbufBackboneRegisterCode(),
                    's.waitForBoot {',
                    '  ~out.play;',
                    '  // dynbuf per-slot REPRESENTATIONS (ProxySpace-scoped) — auto-expose persisted slots',
                    buildDynbufBootInitSCCode(),
                    '  "[envil] ProxySpace ready.  ~out.ar(2).play".postln;',
                    '};',
                ].join('\n'));
                // input proxies (~i/~f/~hasFreq/~a) — ServerTree-registered, fires on boot
                { const ir = buildInputProxyRegisterCode(); if (ir) await sc.executeCode(ir); }
                // auto MIDI proxies — separate write (language-level, keeps payload small)
                { const m = buildMidiProxySCCode(); if (m) await sc.executeCode(m); }
                // knob/macro proxies — ServerTree ping → host resyncs with fresh values
                { const kr = buildKnobResyncRegisterCode(); if (kr) await sc.executeCode(kr); }
                // default SynthDefs — ServerTree-registered, re-loaded on every boot
                { const sd = buildSynthDefLoaderCode(); if (sd) await sc.executeCode(sd); }
                // ~t tempo proxy + TempoClock mirror — ServerTree-registered
                { const tp = buildTempoProxyRegisterCode(); if (tp) await sc.executeCode(tp); }
            } else {
                await sc.executeCode(buildServerOptionsSCCode() + '\ns.boot;');
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
                    '// Hardware I/O channel counts (must be set before reboot)',
                    buildServerOptionsSCCode(),
                    '// ONE ProxySpace per session: no pop/re-push, no allocator',
                    '// resets (existing proxies own their buses — resetting makes',
                    '// new allocations collide and sum on the same buses).',
                    'if(currentEnvironment.isKindOf(ProxySpace).not, {',
                    '  p = ProxySpace.push(s);',
                    '  p.fadeTime = 4;',
                    '  p.quant = 1;',
                    '});',
                    's.reboot;',
                    '// dynbuf BACKBONE (ProxySpace-independent) — registers on ServerTree,',
                    '// auto-(re)builds on every (re)boot.',
                    buildDynbufBackboneRegisterCode(),
                    's.waitForBoot {',
                    '  ~out.play;',
                    '  // dynbuf per-slot REPRESENTATIONS (ProxySpace-scoped) — auto-expose persisted slots',
                    buildDynbufBootInitSCCode(),
                    '  "[envil] ProxySpace ready.  ~out.ar(2).play".postln;',
                    '};',
                ].join('\n'));
                // input proxies (~i/~f/~hasFreq/~a) — ServerTree-registered, fires on boot
                { const ir = buildInputProxyRegisterCode(); if (ir) await sc.executeCode(ir); }
                // auto MIDI proxies — separate write (language-level, keeps payload small)
                { const m = buildMidiProxySCCode(); if (m) await sc.executeCode(m); }
                // knob/macro proxies — ServerTree ping → host resyncs with fresh values
                { const kr = buildKnobResyncRegisterCode(); if (kr) await sc.executeCode(kr); }
                // default SynthDefs — ServerTree-registered, re-loaded on every boot
                { const sd = buildSynthDefLoaderCode(); if (sd) await sc.executeCode(sd); }
                // ~t tempo proxy + TempoClock mirror — ServerTree-registered
                { const tp = buildTempoProxyRegisterCode(); if (tp) await sc.executeCode(tp); }
            } else {
                await sc.executeCode(buildServerOptionsSCCode() + '\ns.reboot;');
            }
        }),

        vscode.commands.registerCommand('envil.supercollider.hush', async () => {
            const sc = getSC(); if (!sc) return;
            await sc.stopAllSounds();
        }),

        vscode.commands.registerCommand('envil.supercollider.reloadSynthDefs', async () => {
            const sc = getSC(); if (!sc) return;
            const sd = buildSynthDefLoaderCode();
            if (sd) {
                await sc.executeCode(sd);
                vscode.window.setStatusBarMessage(`[envil] synthdefs reloading (${collectSynthDefFiles().length} file(s))`, 3000);
            } else {
                vscode.window.showInformationMessage('[envil] no synthdef files found (~/.config/envil/synthdefs/ or <workspace>/.envil/synthdefs/)');
            }
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

    // ── Offline suggestions (corpus + templates + inline + optional Ollama) ──
    try {
        suggestions.activate(context);
    } catch (err) {
        console.error('[envil] suggestions activation failed:', err);
    }

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
            // Heartbeat checks sclang (child process) + scsynth (OSC) every 3s
            startHeartbeat();
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
            disposeHeartbeat();
            await updateCustomPropertyInSettings(false);

            if (workspaceFolder) {
                const wsSettings = readJsonWithComments(path.join(__dirname, 'data', 'workspace_settings.json')).json;
                await updateUserSettings(wsSettings, true, vscode.ConfigurationTarget.Workspace);
            }
            const globalSettings = readJsonWithComments(path.join(__dirname, 'data', 'global_settings.json')).json;
            await updateUserSettings(globalSettings, true, vscode.ConfigurationTarget.Global);

            sclangStatusBar.hide();
            scsynthStatusBar.hide();
            queueStatusBar.hide();
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
                autoWatchScAliases(text);
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
    // Auto-open when: .envil/ exists AND state.json has autoOpen: true (default)
    // The VS Code setting acts as a global kill-switch.
    const touchKnobsCfgAutoOpen = vscode.workspace.getConfiguration('envil').get('touchKnobs.autoOpen', true);
    let touchKnobsAutoOpen = false;
    if (touchKnobsCfgAutoOpen && hasEnvilDir(workspaceFolder)) {
        try {
            const stateRaw = fs.readFileSync(path.join(workspaceFolder, '.envil', 'state.json'), 'utf-8');
            const stateObj = JSON.parse(stateRaw);
            touchKnobsAutoOpen = stateObj.autoOpen !== false; // default true if key missing
        } catch (_) { touchKnobsAutoOpen = true; /* .envil exists, state unreadable → open anyway */ }
    }
    registerTouchKnobs(context, {
        getSC,
        getIO: () => io,
        hydraOutput,
        extensionPath: context.extensionPath,
        autoOpen: touchKnobsAutoOpen,
        workspacePath: workspaceFolder,
    });

    // Energy machine — visual node network: tokens walk source → pools → back,
    // pools are Pspawner-backed proxies (~poolA.ar etc.) usable in ~out.
    // Auto-opens when the workspace has used it before (.envil/energy.json).
    const energyCfgAutoOpen = vscode.workspace.getConfiguration('envil').get('energyMachine.autoOpen', true);
    const energyAutoOpen = energyCfgAutoOpen && workspaceFolder
        && fs.existsSync(path.join(workspaceFolder, '.envil', 'energy.json'));
    registerEnergyMachine(context, {
        getSC,
        hydraOutput,
        extensionPath: context.extensionPath,
        workspacePath: workspaceFolder,
        autoOpen: energyAutoOpen,
    });

    // ProxySpace autocompletion — ~proxy suggestions from live sclang
    registerProxyCompletions(context, { getSC });

    // Environment/Dictionary key completions — e[\key] suggestions from live sclang
    registerEnvCompletions(context, { getSC });

    // Pbind/Event key completions + hover — \degree, \dur, SynthDef args, Pdef names
    registerPbindCompletions(context, { getSC });

    // SC class/method completions — dynamic from sclang, static fallback
    registerSCCompletions(context, { getSC });

    // Re-trigger the completion dropdown when the cursor ENDS UP right after a
    // trigger char without typing it — VS Code only auto-fires completion when
    // a trigger character is TYPED. Covered: deleting "instrument" from
    // "\instrument", and cursor movement (arrows/mouse) onto such a spot.
    // Cases: '\' (Pbind/env keys), '~' (proxies), '_' (snippet launcher), 'ident[' (dict/env lookup
    // like e[ ). DWELL: fires only after the cursor RESTS there for 250ms —
    // sliding through code with arrow keys (or holding backspace) must not
    // trap the user in a dropdown. The timer re-checks the CURRENT cursor at
    // expiry, so any further move/edit cancels or re-schedules.
    const cursorAtTrigger = (doc, pos) => {
        if (pos.character === 0) return false;
        const before = doc.getText(new vscode.Range(pos.line, Math.max(0, pos.character - 2), pos.line, pos.character));
        const last = before[before.length - 1];
        return last === '\\' || last === '~' || last === '_'
            || (last === '[' && /\w/.test(before[before.length - 2] || ''));
    };
    let _cursorTriggerTimer = null;
    const scheduleTriggerCheck = () => {
        if (_cursorTriggerTimer) clearTimeout(_cursorTriggerTimer);
        _cursorTriggerTimer = setTimeout(() => {
            _cursorTriggerTimer = null;
            const ed = vscode.window.activeTextEditor;
            if (!ed || ed.document.languageId !== 'supercollider') return;
            if (!ed.selection.isEmpty) return;
            if (cursorAtTrigger(ed.document, ed.selection.active)) {
                vscode.commands.executeCommand('editor.action.triggerSuggest');
            }
        }, 250);
    };
    let _lastScDocChangeMs = 0;
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((ev) => {
        if (ev.document.languageId !== 'supercollider' || ev.contentChanges.length === 0) return;
        _lastScDocChangeMs = Date.now();
        // deletions only — typed trigger chars already work natively
        if (!ev.contentChanges.every(c => c.text === '' && c.rangeLength > 0)) {
            if (_cursorTriggerTimer) { clearTimeout(_cursorTriggerTimer); _cursorTriggerTimer = null; }
            return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== ev.document) return;
        scheduleTriggerCheck();
    }));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (ev.textEditor.document.languageId !== 'supercollider') return;
        // pure cursor moves only (mouse click / arrow keys) — selection events
        // caused by edits arrive right after a doc change; those are handled
        // above (deletes) or natively (typed trigger chars)
        if (Date.now() - _lastScDocChangeMs < 100) return;
        if (ev.kind !== vscode.TextEditorSelectionChangeKind.Keyboard
            && ev.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
            if (_cursorTriggerTimer) { clearTimeout(_cursorTriggerTimer); _cursorTriggerTimer = null; }
            return;
        }
        scheduleTriggerCheck();
    }));

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
                    autoWatchScAliases(blockCode);
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
    disposeHeartbeat();
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

const QUEUE_MAX = 8192;
const NODE_MAX = 8192;  // s.options.maxNodes = 1024*8

function updateQueueBar(status, queueSize, proxyCount, tdefCount, pdefCount, memMaxMB) {
    if (!queueStatusBar) return;

    const hasServer = status && status.alive;
    const hasQueue = queueSize !== null && queueSize !== undefined;

    if (!hasServer && !hasQueue) {
        queueStatusBar.hide();
        return;
    }

    // Compact bar:  Q:42/8192 | Nds:28/8192 | Prx:12 Defs:3 | Mem:2000M | CPU:12%
    const parts = [];
    const tooltipParts = [];
    let worstLevel = 0;  // 0=ok, 1=warn, 2=critical

    // Queue
    if (hasQueue) {
        parts.push(`Q:${queueSize}/${QUEUE_MAX}`);
        const qRatio = queueSize / QUEUE_MAX;
        if (qRatio > 0.75) { worstLevel = Math.max(worstLevel, 2); tooltipParts.push('🚨 Queue critically full!'); }
        else if (qRatio > 0.5) { worstLevel = Math.max(worstLevel, 1); tooltipParts.push('⚠️ Queue getting full'); }
    }

    // Nodes (synths + groups from scsynth OSC)
    if (hasServer && status.numSynths !== undefined) {
        const nodes = status.numSynths + status.numGroups;
        parts.push(`Nds:${nodes}/${NODE_MAX}`);
        const nRatio = nodes / NODE_MAX;
        if (nRatio > 0.75) { worstLevel = Math.max(worstLevel, 2); tooltipParts.push('🚨 Node count critically high!'); }
        else if (nRatio > 0.5) { worstLevel = Math.max(worstLevel, 1); tooltipParts.push('⚠️ Node count getting high'); }
    }

    // Proxies + Defs combined (compact)
    const prxDef = [];
    if (proxyCount !== null && proxyCount !== undefined) prxDef.push(`Prx:${proxyCount}`);
    const hasTdef = tdefCount !== null && tdefCount !== undefined;
    const hasPdef = pdefCount !== null && pdefCount !== undefined;
    if (hasTdef || hasPdef) {
        const total = (hasTdef ? tdefCount : 0) + (hasPdef ? pdefCount : 0);
        prxDef.push(`Defs:${total}`);
    }
    if (prxDef.length) parts.push(prxDef.join(' '));

    // Memory — configured RT pool size (s.options.memSize)
    // scsynth pre-allocates this at boot; no API to query how much is used.
    if (memMaxMB !== null) {
        parts.push(`Mem:${memMaxMB}M`);
    }

    // CPU
    if (hasServer && status.avgCPU !== undefined) {
        const cpu = status.avgCPU.toFixed(0);
        parts.push(`CPU:${cpu}%`);
        if (status.avgCPU > 80) { worstLevel = Math.max(worstLevel, 2); tooltipParts.push('🚨 CPU critically high!'); }
        else if (status.avgCPU > 50) { worstLevel = Math.max(worstLevel, 1); tooltipParts.push('⚠️ CPU getting high'); }
    }

    queueStatusBar.text = parts.join(' | ');

    // Detailed tooltip
    const tipLines = ['SC Server Health  (hover for details)'];
    if (hasQueue) tipLines.push(`  Scheduler Queue: ${queueSize} / ${QUEUE_MAX}`);
    if (hasServer && status.numSynths !== undefined) {
        tipLines.push(`  Synths: ${status.numSynths}   Groups: ${status.numGroups}   UGens: ${status.numUGens}   SynthDefs: ${status.numSynthDefs}`);
        tipLines.push(`  Nodes (synths+groups): ${status.numSynths + status.numGroups} / ${NODE_MAX}`);
    }
    if (proxyCount !== null) tipLines.push(`  ProxySpace slots: ${proxyCount}`);
    if (hasTdef) tipLines.push(`  Running Tdefs (tasks): ${tdefCount}`);
    if (hasPdef) tipLines.push(`  Running Pdefs (patterns): ${pdefCount}`);
    if (memMaxMB !== null) tipLines.push(`  RT memory pool: ${memMaxMB} MB (s.options.memSize)`);
    if (hasServer && status.avgCPU !== undefined) {
        tipLines.push(`  CPU: ${status.avgCPU.toFixed(1)}% avg / ${status.peakCPU.toFixed(1)}% peak`);
    }
    if (tooltipParts.length) tipLines.push('', ...tooltipParts);
    queueStatusBar.tooltip = tipLines.join('\n');

    // Color based on worst alarm level
    if (worstLevel >= 2) {
        queueStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (worstLevel >= 1) {
        queueStatusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        queueStatusBar.backgroundColor = undefined;
    }

    queueStatusBar.show();
}

// ── sclang exit callback + scsynth heartbeat (OSC-based) ──────────────────────
//
// sclang detection:  it's our child process → just check sclangProcess liveness.
// scsynth detection: send /status via raw UDP to 57110, listen for /status.reply.
//                    Uses Node.js dgram directly — no sclang round-trip needed.

const dgram = require('dgram');

let _sclangExitRegistered = false;
let _sclangStartRegistered = false;
let _heartbeatTimer = null;

// One init path for EVERY sclang spawn — the startSCLang command AND the
// implicit auto-start when the user Ctrl+Enters code with no interpreter
// running (sc.ts executeBlock/executeCode call startSclang() directly; that
// path used to skip ALL of this, which is why proxies existed only when
// sclang was started via the command).
function registerSclangStartCallback() {
    if (_sclangStartRegistered) return;
    const sc = getSC();
    if (!sc || !sc.onSclangStart) return;
    sc.onSclangStart(() => {
        console.log('[envil] sclang started — running post-start init');
        clearSCCompletionCaches();   // class library may recompile
        clearEnvKeyCache();          // env state is gone after restart
        updateSclangBar(true);
        // Auto-detect a running scsynth left over from a previous session
        const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
        const inputCode = autoInit ? (buildDynbufBackboneRegisterCode() + '\n' + buildDynbufBootInitSCCode()) : '';
        sc.probeRunningServer(autoInit, inputCode).then(found => {
            if (found) {
                _isSCSynthRunning = true;
                updateScsynthBar(true);
            }
            // Self-guarding, ServerTree-registered — safe to send whether or
            // not a server was found (they fire now or on next boot).
            if (autoInit) {
                const ir = buildInputProxyRegisterCode(); if (ir) sc.executeCode(ir);
                const m = buildMidiProxySCCode(); if (m) sc.executeCode(m);
                const kr = buildKnobResyncRegisterCode(); if (kr) sc.executeCode(kr);
                const sd = buildSynthDefLoaderCode(); if (sd) sc.executeCode(sd);
                const tp = buildTempoProxyRegisterCode(); if (tp) sc.executeCode(tp);
            }
        }).catch(() => { /* heartbeat heal covers any missed init */ });
    });
    _sclangStartRegistered = true;
}

function registerSclangExitCallback() {
    if (_sclangExitRegistered) return;
    const sc = getSC();
    if (!sc || !sc.onSclangExit) return;
    sc.onSclangExit((_code) => {
        console.log('[envil] sclang exited');
        updateSclangBar(false);
        // NOTE: do NOT touch scsynth bar or stop heartbeat here.
        // scsynth is an independent process — the heartbeat will detect its state.
    });
    _sclangExitRegistered = true;
}

// OSC /status message as raw bytes (12 bytes total):
//   bytes 0-7:  "/status\0"   (address, null-terminated, 4-byte aligned)
//   bytes 8-11: ",\0\0\0"     (type tag: just comma, no args, padded)
const OSC_STATUS_MSG = Buffer.from([
    0x2F, 0x73, 0x74, 0x61, 0x74, 0x75, 0x73, 0x00,  // /status\0
    0x2C, 0x00, 0x00, 0x00,                            // ,\0\0\0
]);

/**
 * Send /status to scsynth on UDP 57110 and parse /status.reply.
 * Resolves with { alive, numUGens, numSynths, numGroups, numSynthDefs, avgCPU, peakCPU }
 * or { alive: false } on timeout/error.
 */
function pingScsynthOSC(timeoutMs = 1500) {
    return new Promise((resolve) => {
        let done = false;
        let sock;
        try {
            sock = dgram.createSocket('udp4');
        } catch (_) { resolve({ alive: false }); return; }

        const finish = (result) => {
            if (done) return;
            done = true;
            try { sock.close(); } catch (_) {}
            resolve(result);
        };

        sock.on('message', (buf) => {
            // /status.reply OSC: address, type-tag ",iiiiiff", then 7 values:
            //   [0] unused, [1] numUGens, [2] numSynths, [3] numGroups,
            //   [4] numSynthDefs, [5] avgCPU(float), [6] peakCPU(float)
            try {
                // Find start of args: skip address + type-tag strings
                let i = 0;
                while (i < buf.length && buf[i] !== 0) i++; // skip address
                i = (i + 4) & ~3; // align to 4
                while (i < buf.length && buf[i] !== 0) i++; // skip type tag
                i = (i + 4) & ~3; // align to 4
                if (i + 28 <= buf.length) {
                    const unused      = buf.readInt32BE(i);
                    const numUGens    = buf.readInt32BE(i + 4);
                    const numSynths   = buf.readInt32BE(i + 8);
                    const numGroups   = buf.readInt32BE(i + 12);
                    const numSynthDefs = buf.readInt32BE(i + 16);
                    const avgCPU      = buf.readFloatBE(i + 20);
                    const peakCPU     = buf.readFloatBE(i + 24);
                    finish({ alive: true, numUGens, numSynths, numGroups, numSynthDefs, avgCPU, peakCPU });
                    return;
                }
            } catch (_) {}
            finish({ alive: true });
        });
        sock.on('error', () => finish({ alive: false }));

        sock.send(OSC_STATUS_MSG, 57110, '127.0.0.1', (err) => {
            if (err) finish({ alive: false });
        });

        setTimeout(() => finish({ alive: false }), timeoutMs);
    });
}

// ── Proxy self-heal (rides the heartbeat, dynbuf-style) ─────────────────────
// Outcome-based, like the dynbuf backbone: every tick we check what ACTUALLY
// exists in the interpreter — not whether we once registered something.
//   input:  does ~i0 have a source in the MAIN thread's ProxySpace?
//   midi:   does MIDIdef \envilAutoCC exist (survives cmd-period, not recompile)?
//   knob:   is the resync ServerTree fn registered?
// The query runs as a stdin eval = main interpreter thread = the exact space
// the user's editor evals resolve ~tildes in. It also refreshes the
// Library \envil \pspace capture, so even a hostile startup.scd that swaps
// ProxySpaces mid-session gets converged back within one tick. Heals are
// idempotent + throttled (10s JS-side, 5s SC-side for inputs).
let _regHealBusy = false;
let _regHealLastSendMs = 0;
let _optsRebootWarned = false;   // one warning per session when a live server has wrong I/O

async function ensureProxyRegisters(sc) {
    if (_regHealBusy || !sc.queryCode) return;
    const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
    if (!autoInit) return;
    if (Date.now() - _regHealLastSendMs < 10000) return;  // let a fresh send settle
    _regHealBusy = true;
    try {
        const numInputs = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('numInputs', 2);
        const cfgIns = vscode.workspace.getConfiguration('envil.supercollider.server').get('numInputBusChannels', 4);
        const wdSec = Math.max(0, Math.min(3600, Number(vscode.workspace.getConfiguration('envil.supercollider.midi').get('watchdogSeconds', 60)) || 0));
        const marker = '<<E_REG>>';
        sc.addSuppressMarker(marker);
        const q = `{ var ps, srv, e, inLive, inArmed, midiOk, wdOk, knobOk, bbOk, sdOk, tpOk, optIns; `
            + `ps = currentEnvironment.isKindOf(ProxySpace); `
            + `if(ps, { Library.put(\\envil, \\pspace, currentEnvironment) }); `
            + `srv = Server.default.serverRunning; `
            + `e = if(ps, { currentEnvironment.envir }, { nil }); `
            + `inLive = e.notNil and: { e[\\i0].notNil and: { e[\\i0].source.notNil } }; `
            + `inArmed = Library.at(\\envil, \\inputProxiesFn).notNil; `
            + `midiOk = MIDIdef.all[\\envilAutoCC].notNil and: { Library.at(\\envil, \\midiSetProxy).notNil }; `
            + `wdOk = (Library.at(\\envil, \\midiWatchdogBeat) ? -1e9) > (Main.elapsedTime - ${wdSec * 2 + 30}); `
            + `knobOk = Library.at(\\envil, \\knobResyncFn).notNil; `
            + `bbOk = Library.at(\\envil, \\backboneFn).notNil; `
            + `sdOk = Library.at(\\envil, \\synthDefsFn).notNil; `
            + `tpOk = Library.at(\\envil, \\tempoProxyFn).notNil and: { srv.not or: { (Library.at(\\envil, \\tempoWatchBeat) ? -1e9) > (Main.elapsedTime - 15) } }; `
            + `optIns = Server.default.options.numInputBusChannels; `
            + `("${marker}" ++ [ps, srv, inLive, inArmed, midiOk, wdOk, knobOk, bbOk, sdOk, tpOk].collect(_.binaryValue).join(",") ++ "," ++ optIns ++ "${marker}").postln; }.value;`;
        const res = await sc.queryCode(q, marker, 2500);
        if (!res) return;  // interpreter still compiling/busy — retry next tick
        const parts = res.trim().split(',');
        const [psOk, srvOk, inLive, inArmed, midiOk, wdOk, knobOk, bbOk, sdOk, tpOk] = parts.map(v => v === '1');
        const optIns = parseInt(parts[10], 10);
        // server options: keep s.options in sync with settings so ANY boot path
        // (user's s.boot, startup.scd waitForBoot, extension commands) picks them
        // up. Options only apply at boot — if the server is already running with
        // the wrong count, tell the user once instead of silently doing nothing.
        if (Number.isFinite(optIns) && optIns !== cfgIns) {
            sc.executeCode(buildServerOptionsSCCode());
            if (srvOk && !_optsRebootWarned) {
                _optsRebootWarned = true;
                sc.executeCode(`"[envil] ⚠ server is RUNNING with ${optIns} input channel(s) but settings want ${cfgIns} — reboot the server to apply (inputs beyond the booted count are silent)".postln;`);
            }
        }
        // input proxies: heal when the server is up but ~i0 is dead in the
        // user's ACTUAL space (outcome check) — or arm the ServerTree/boot-waiter
        // if nothing is registered yet while the server is down. The register's
        // immediate-fire leg uses the freshly captured \pspace, so it lands in
        // the right space under any startup.scd.
        const needInput = numInputs > 0 && ((psOk && srvOk && !inLive) || (!srvOk && !inArmed));
        if (needInput) {
            const ir = buildInputProxyRegisterCode();
            if (ir) { _regHealLastSendMs = Date.now(); sc.executeCode(ir); console.log(`[envil] ♥ healing input proxies (live=${inLive} armed=${inArmed} srv=${srvOk})`); }
        }
        if (!midiOk || (wdSec > 0 && !wdOk)) {
            // covers dead MIDIdefs (recompile, MIDIdef.freeAll) AND a stopped
            // watchdog Routine — the MIDI code re-creates both idempotently
            const m = buildMidiProxySCCode();
            if (m) { _regHealLastSendMs = Date.now(); sc.executeCode(m); console.log(`[envil] ♥ healing MIDI (defs=${midiOk} watchdog=${wdOk})`); }
        }
        if (!knobOk) {
            const kr = buildKnobResyncRegisterCode();
            if (kr) { _regHealLastSendMs = Date.now(); sc.executeCode(kr); console.log('[envil] ♥ (re)sent knob resync register'); }
        }
        if (!bbOk) {
            // dynbuf backbone register wiped (class-lib recompile) — without
            // this the backbone only healed while the knobs panel was open
            const bb = buildDynbufBackboneRegisterCode();
            if (bb) { _regHealLastSendMs = Date.now(); sc.executeCode(bb); console.log('[envil] ♥ (re)sent dynbuf backbone register'); }
        }
        if (!sdOk) {
            const sd = buildSynthDefLoaderCode();
            if (sd) { _regHealLastSendMs = Date.now(); sc.executeCode(sd); console.log('[envil] ♥ (re)sent synthdef loader'); }
        }
        if (!tpOk) {
            // ~t register missing OR its watcher Routine died (Cmd-Period kills
            // AppClock routines; stamp goes stale) — re-send, idempotent
            const tp = buildTempoProxyRegisterCode();
            if (tp) { _regHealLastSendMs = Date.now(); sc.executeCode(tp); console.log('[envil] ♥ (re)sent ~t tempo proxy register'); }
        }
    } catch (_) { /* heartbeat retries next tick */ }
    finally { _regHealBusy = false; }
}

function startHeartbeat() {
    registerSclangExitCallback();
    registerSclangStartCallback();   // retry if activation-time getSC() failed
    stopHeartbeat();
    console.log('[envil] ♥ heartbeat active');

    // Do one immediate tick, then every 3 seconds
    heartbeatTick();
    _heartbeatTimer = setInterval(heartbeatTick, 3000);
}

async function heartbeatTick() {
    // ── sclang: direct child-process check ──
    const sc = getSC();
    const sclangAlive = sc ? sc.isSclangRunning() : false;
    updateSclangBar(sclangAlive);

    // ── proxy registers: verify installed, re-send if missing (self-heal) ──
    if (sclangAlive && sc) ensureProxyRegisters(sc);

    // ── scsynth: direct OSC /status ping (with full stats) ──
    const status = await pingScsynthOSC();
    if (status.alive !== _isSCSynthRunning) {
        _isSCSynthRunning = status.alive;
        updateScsynthBar(status.alive);
    }

    // ── scheduler queue + proxy count + running defs + memory (from sclang) ──
    let queueSize = null;
    let proxyCount = null;
    let tdefCount = null;
    let pdefCount = null;
    let memSizeKB = null;
    if (sclangAlive && sc && sc.queryCode) {
        try {
            const marker = '<<ENVQ>>';
            sc.addSuppressMarker(marker);
            const code = `("${marker}" ++ TempoClock.default.queue.size ++ "," ++ currentEnvironment.envir.size ++ "," ++ Tdef.all.select(_.isPlaying).size ++ "," ++ Pdef.all.select(_.isPlaying).size ++ "," ++ s.options.memSize ++ "${marker}").postln;`;
            const result = await sc.queryCode(code, marker, 2000);
            if (result) {
                const parts = result.trim().split(',');
                queueSize  = parseInt(parts[0], 10);
                proxyCount = parseInt(parts[1], 10);
                tdefCount  = parseInt(parts[2], 10);
                pdefCount  = parseInt(parts[3], 10);
                memSizeKB  = parseInt(parts[4], 10);
                if (isNaN(queueSize))  queueSize = null;
                if (isNaN(proxyCount)) proxyCount = null;
                if (isNaN(tdefCount))  tdefCount = null;
                if (isNaN(pdefCount))  pdefCount = null;
                if (isNaN(memSizeKB))  memSizeKB = null;
            }
        } catch (e) { /* ignore query failures */ }
    }

    const memMaxMB = memSizeKB ? Math.round(memSizeKB / 1024) : null;

    updateQueueBar(status, queueSize, proxyCount, tdefCount, pdefCount, memMaxMB);
}

function stopHeartbeat() {
    if (_heartbeatTimer) {
        clearInterval(_heartbeatTimer);
        _heartbeatTimer = null;
    }

}

function disposeHeartbeat() {
    stopHeartbeat();
}

/**
 * One-shot: if sclang + scsynth survived a window reload, reconnect ProxySpace.
 * (The heartbeat keeps the bars in sync from then on.)
 */
async function probeAndReconnect() {
    const sc = getSC();
    if (!sc || !sc.isSclangRunning()) return;
    const status = await pingScsynthOSC();
    if (!status.alive) return;
    _isSCSynthRunning = true;
    updateScsynthBar(true);
    const autoInit = vscode.workspace.getConfiguration('envil.supercollider.proxySpace').get('autoInit', true);
    const inputCode = autoInit ? (buildDynbufBackboneRegisterCode() + '\n' + buildDynbufBootInitSCCode()) : '';
    await sc.probeRunningServer(autoInit, inputCode);
    // Self-guarding, ServerTree-registered — fire now (server confirmed) or on next boot.
    if (autoInit) {
        const ir = buildInputProxyRegisterCode(); if (ir) sc.executeCode(ir);
        const m = buildMidiProxySCCode(); if (m) sc.executeCode(m);
        const kr = buildKnobResyncRegisterCode(); if (kr) sc.executeCode(kr);
        const sd = buildSynthDefLoaderCode(); if (sd) sc.executeCode(sd);
        const tp = buildTempoProxyRegisterCode(); if (tp) sc.executeCode(tp);
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
        // Browser signals readiness (all proxy scripts loaded) → push current
        // macro/seq/knob state so idle values resolve immediately.
        socket.on('hydra-ready', () => {
            try { require('./touch-knobs').emitHydraStateSnapshot(); } catch (_) {}
        });
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
        // ── MediaPipe events from the capture browser page ─────────────
        socket.on('mediapipe-landmarks', (landmarks) => {
            // Forward to touch-knobs handler (same pipeline as webview postMessage)
            const { handleMediaPipeLandmarks } = require('./touch-knobs');
            handleMediaPipeLandmarks(landmarks);
        });
        socket.on('mediapipe-status', (msg) => {
            const { handleMediaPipeStatus } = require('./touch-knobs');
            handleMediaPipeStatus(msg);
        });
        socket.on('mediapipe-hello', () => {
            if (hydraOutput) hydraOutput.appendLine('  📷 MediaPipe capture page connected');
            // Send current config to the capture page
            const { getMediaPipeConfig } = require('./touch-knobs');
            const cfg = getMediaPipeConfig();
            if (cfg) socket.emit('mediapipe-config', cfg);
        });
    });

    oscPort = new osc.UDPPort({ localAddress: 'localhost', localPort: 3002 });
    oscPort.open();
    oscPort.on('message', (oscMsg) => {
        if (io) io.sockets.emit('new-command', { data: oscMsg.args[0] });
    });

    app.use(express.static(path.join(__dirname, 'hydra')));
    app.use('/files', express.static(path.join(__dirname, 'local', 'files')));
    // MediaPipe: dedicated Express on port 3003 (separate origin → independent
    // Chrome camera selection from Hydra on :3000)
    const mpApp = express();
    mpApp.use('/mediapipe', express.static(path.join(__dirname, 'mediapipe')));
    mpApp.use('/lib', express.static(path.join(__dirname, 'hydra', 'lib')));
    mpApp.listen(3003, () => {
        if (hydraOutput) hydraOutput.appendLine('  📷 MediaPipe capture server on http://localhost:3003');
    });

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
