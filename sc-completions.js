// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Dynamic SuperCollider class & method completions
//
// When sclang is running, queries it for the real class hierarchy and methods.
// Falls back to static lists when sclang is not available.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');

const LANGUAGE_ID   = 'supercollider';
const MARKER_CLS    = '___ENVIL_SC_CLS___';
const MARKER_MTH    = '___ENVIL_SC_MTH___';
const MARKER_CMTH   = '___ENVIL_SC_CMTH___';
const MARKER_IMTH   = '___ENVIL_SC_IMTH___';   // instance methods
const MARKER_VCLS   = '___ENVIL_SC_VCLS___';   // variable class lookup
const MARKER_SIG    = '___ENVIL_SC_SIG___';    // method signatures
const POLL_INTERVAL = 30000;           // refresh class list every 30s
const QUERY_TIMEOUT = 4000;
const VAR_CLASS_TTL = 5000;            // cache variable→class for 5s

// ── State ────────────────────────────────────────────────────────────────────

let _getSC = null;
let _pollTimer = null;

// Dynamic data (populated by querying sclang)
let _dynamicClasses       = null;      // string[] | null  (null = not yet loaded)
let _classMethodCache     = new Map(); // Map<className, TieredResult[]>  (class-side)
let _instanceMethodCache  = new Map(); // Map<className, TieredResult[]>  (instance-side)
let _varClassCache        = new Map(); // Map<varExpr, { cls: string, ts: number }>
let _allMethods           = null;      // TieredResult[] | null  (tiered by prevalence)
let _sigCache             = new Map(); // Map<'Class:method', { label, params[] } | null>
// TieredResult = { owner: string, methods: string[] }

// ── Static fallback lists (used when sclang is not running) ──────────────────

const STATIC_CLASSES = [
    'SinOsc', 'Saw', 'Pulse', 'LFSaw', 'LFPulse', 'LFNoise0', 'LFNoise1', 'LFNoise2',
    'Blip', 'Formant', 'Klang', 'VOsc', 'VOsc3', 'FSinOsc', 'PMOsc', 'COsc',
    'Gendy1', 'Gendy2', 'Gendy3',
    'WhiteNoise', 'PinkNoise', 'BrownNoise', 'ClipNoise', 'GrayNoise',
    'Dust', 'Dust2', 'Impulse', 'Crackle', 'Logistic',
    'Stepper', 'PulseDivider', 'Trig1', 'TDelay', 'TDuty', 'SendTrig', 'Latch', 'Gate',
    'Trig', 'Timer', 'Sweep', 'Phasor', 'Peak', 'RunningMin', 'RunningMax',
    'LPF', 'HPF', 'BPF', 'BRF', 'RLPF', 'RHPF', 'Resonz', 'Ringz', 'Formlet',
    'Median', 'MoogFF', 'DFM1', 'FOS', 'SOS', 'TwoPole', 'TwoZero',
    'OnePole', 'OneZero', 'Integrator', 'LeakDC',
    'FreeVerb', 'GVerb', 'AllpassN', 'AllpassL', 'AllpassC',
    'CombN', 'CombL', 'CombC', 'DelayN', 'DelayL', 'DelayC',
    'PitchShift', 'Pitch', 'FreqShift',
    'FFT', 'IFFT',
    'Pan2', 'Balance2', 'LinPan2', 'Splay', 'Pan4', 'PanAz', 'Rotate2', 'XFade2',
    'EnvGen', 'Env', 'Line', 'XLine', 'Linen',
    'PlayBuf', 'RecordBuf', 'BufRd', 'BufWr', 'Buffer',
    'GrainBuf', 'GrainIn', 'Warp1', 'Shaper',
    'Out', 'In', 'LocalIn', 'LocalOut', 'ReplaceOut', 'XOut', 'OffsetOut',
    'Mix', 'Limiter', 'Compander', 'Normalizer',
    'MouseX', 'MouseY', 'MouseButton',
    'Lag', 'Lag2', 'Lag3', 'Ramp', 'VarLag', 'Decay', 'Decay2',
    'SoftClip', 'Distort', 'Clip', 'Fold', 'Wrap',
    'A2K', 'K2A', 'T2A', 'DC', 'Silent',
    'Free', 'FreeSelf', 'PauseSelf', 'Done', 'FreeSelfWhenDone', 'PauseSelfWhenDone',
    'Server', 'ServerOptions', 'SynthDef', 'Synth', 'Group', 'Bus',
    'Pbind', 'Pseq', 'Prand', 'Pxrand', 'Pwrand', 'Pshuf',
    'Pwhite', 'Pexprand', 'Pgauss',
    'Pn', 'Pdef', 'Ppar', 'Ptpar', 'Pchain', 'Pkey',
    'Pfunc', 'Prout', 'Plazy',
    'EventStreamPlayer', 'Routine', 'Task',
    'Array', 'List', 'Set', 'IdentitySet', 'Dictionary', 'IdentityDictionary',
    'Event', 'Environment', 'TempoClock', 'SystemClock', 'AppClock',
    'MIDIClient', 'MIDIIn', 'MIDIOut', 'MIDIFunc', 'MIDIdef',
    'NetAddr', 'OSCFunc', 'OSCdef',
    'String', 'Symbol', 'Float', 'Integer', 'Boolean', 'Nil', 'Object', 'Function', 'Class',
    'Signal', 'Wavetable', 'FloatArray',
    'File', 'PathName', 'Platform',
    'Point', 'Rect', 'Color', 'Pen',
    'Condition', 'Semaphore',
    'ProxySpace', 'NodeProxy', 'Ndef',
];

const STATIC_METHODS = [
    'play', 'stop', 'free', 'release', 'set', 'get',
    'ar', 'kr', 'ir', 'tr',
    'new', 'newClear', 'newFrom', 'copy', 'deepCopy',
    'add', 'addAll', 'remove', 'removeAt', 'pop', 'push',
    'at', 'put', 'atFail', 'first', 'last', 'size', 'isEmpty',
    'do', 'collect', 'select', 'reject', 'detect', 'any', 'every',
    'sum', 'mean', 'maxItem', 'minItem', 'sort', 'reverse',
    'midicps', 'cpsmidi', 'midiratio', 'ratiomidi', 'ampdb', 'dbamp',
    'linlin', 'linexp', 'explin', 'expexp', 'lincurve', 'curvelin',
    'clip', 'wrap', 'fold', 'round', 'trunc', 'ceil', 'floor', 'abs', 'neg',
    'rand', 'rand2', 'rrand', 'exprand', 'bilinrand', 'linrand',
    'wait', 'yield', 'value', 'valueEnvir', 'valueArray',
    'postln', 'post', 'postf', 'debug', 'trace',
    'asString', 'asSymbol', 'asInteger', 'asFloat', 'asArray',
    'dup', 'blend', 'series', 'geom',
    'scope', 'plot', 'gui',
    'asStream', 'embedInStream', 'reset', 'next', 'nextN', 'all',
    'softclip', 'distort', 'tanh', 'reciprocal', 'squared', 'cubed', 'sqrt',
    'sign', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'sinh', 'cosh', 'isPositive', 'isNegative', 'isStrictlyPositive',
    'coin', 'degrad', 'raddeg', 'frac',
    'pow', 'min', 'max', 'mod', 'div', 'lcm', 'gcd', 'thresh',
    'atan2', 'hypot', 'ring1', 'ring2', 'ring3', 'ring4',
    'sumsqr', 'difsqr', 'sqrsum', 'sqrdif', 'absdif',
    'amclip', 'scaleneg', 'clip2', 'wrap2', 'fold2', 'excess',
    'range', 'exprange', 'unipolar', 'bipolar', 'lag', 'lag2', 'lag3',
    'lagud', 'lag2ud', 'lag3ud', 'varlag',
    'flop', 'flat', 'clump', 'reshape', 'stutter',
    'numFrames', 'numChannels', 'duration', 'sampleRate', 'bufnum',
    'read', 'write', 'loadToFloatArray', 'getToFloatArray',
    'run', 'map', 'unmap', 'setn', 'getn', 'fill',
    'moveBefore', 'moveAfter', 'moveToHead', 'moveToTail',
    'isPlaying', 'isRunning',
    'respondsTo', 'isKindOf', 'isNil', 'notNil',
    'includes', 'indexOf', 'indexOfEqual',
    'keep', 'drop', 'copyRange', 'copyToEnd', 'copyFromStart',
    'wrapAt', 'clipAt', 'foldAt', 'wrapPut', 'clipPut',
    'normalize', 'normalizeSum', 'integrate', 'differentiate',
    'scramble', 'choose', 'wchoose', 'rotate', 'mirror', 'mirror1',
    'poll', 'dpoll', 'checkBadValues',
    'mold', 'source', 'clear', 'bus', 'index',
    'fadeTime', 'quant', 'numOutputs', 'numInputs', 'rate',
    'printOn', 'storeOn', 'cs', 'class', 'dump', 'inspect',
];

// ── sclang queries ───────────────────────────────────────────────────────────

function _sc() {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning || !sc.isSclangRunning() || !sc.queryCode) return null;
    return sc;
}

/**
 * Query sclang for all class names.
 */
async function queryClassList() {
    const sc = _sc();
    if (!sc) return;
    if (sc.addSuppressMarker) {
        sc.addSuppressMarker(MARKER_CLS);
        sc.addSuppressMarker(MARKER_MTH);
        sc.addSuppressMarker(MARKER_CMTH);
    }

    const code =
        `("${MARKER_CLS}" ++ Class.allClasses.collect{|c| c.name.asString}.asArray.sort.join(",") ++ "${MARKER_CLS}").postln;`;
    const raw = await sc.queryCode(code, MARKER_CLS, QUERY_TIMEOUT);
    if (!raw) return;

    _dynamicClasses = raw.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[envil] SC completions: ${_dynamicClasses.length} classes loaded from sclang`);
}

/**
 * Query sclang for ALL unique method names across all classes.
 * Results are tiered by prevalence:
 *   Tier 0 "core"   : methods from Object, AbstractFunction, Number, etc.
 *   Tier 1 "common" : methods from Collection, UGen, Stream, Pattern, etc.
 *   Tier 2 "audio"  : methods from Node, Buffer, Bus, Server, NodeProxy, etc.
 *   Tier 3 "other"  : everything else
 * Within each tier, methods are sorted alphabetically.
 */
async function queryAllMethods() {
    const sc = _sc();
    if (!sc) return;

    // SC code that groups methods into prevalence tiers.
    // The `seen` set avoids duplicates — a method is attributed to the
    // highest-priority tier that defines it.
    const code = [
        `({`,
        `var core = [Object, AbstractFunction, Function, Boolean, Nil,`,
        `  Number, SimpleNumber, Integer, Float, Char, Symbol, String];`,
        `var common = [Collection, SequenceableCollection, ArrayedCollection,`,
        `  Array, List, Dictionary, IdentityDictionary, Set, IdentitySet,`,
        `  Event, Environment, Association,`,
        `  UGen, MultiOutUGen, OutputProxy, AbstractOut, BufInfoUGenBase,`,
        `  Stream, Pattern, ListPattern, FilterPattern, Pdef, EventStreamPlayer,`,
        `  Routine, Task, Thread, Quant, TempoClock, SystemClock, AppClock];`,
        `var audio = [Node, Synth, Group, ParGroup, SynthDef,`,
        `  Buffer, Bus, Server, ServerOptions,`,
        `  NodeProxy, ProxySpace, Ndef, BusPlug, Monitor,`,
        `  Env, EnvGen, MIDIFunc, MIDIdef, OSCFunc, OSCdef, NetAddr];`,
        `var seen = IdentitySet.new;`,
        `var collect = {|classes|`,
        `  var ms = List.new;`,
        `  classes.do{|c|`,
        `    [c.methods, c.class.methods].do{|mList|`,
        `      if(mList.notNil, { mList.do{|m|`,
        `        if(seen.includes(m.name).not, {`,
        `          seen.add(m.name); ms.add(m.name.asString)`,
        `        })`,
        `      }})`,
        `    }`,
        `  };`,
        `  ms.sort`,
        `};`,
        `var t0 = collect.value(core);`,
        `var t1 = collect.value(common);`,
        `var t2 = collect.value(audio);`,
        `var rest = List.new;`,
        `var out;`,
        `Class.allClasses.do{|c|`,
        `  [c.methods, c.class.methods].do{|mList|`,
        `    if(mList.notNil, { mList.do{|m|`,
        `      if(seen.includes(m.name).not, {`,
        `        seen.add(m.name); rest.add(m.name.asString)`,
        `      })`,
        `    }})`,
        `  }`,
        `};`,
        `rest = rest.sort;`,
        `out = "core:" ++ t0.join(",") ++ ";"`,
        `  ++ "common:" ++ t1.join(",") ++ ";"`,
        `  ++ "audio:" ++ t2.join(",") ++ ";"`,
        `  ++ "other:" ++ rest.join(",") ++ ";";`,
        `("${MARKER_MTH}" ++ out ++ "${MARKER_MTH}").postln;`,
        `}).value;`
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_MTH, 10000);  // longer timeout — big query
    if (!raw) return;

    _allMethods = parseTieredResult(raw);
    const total = _allMethods.reduce((n, t) => n + t.methods.length, 0);
    console.log(`[envil] SC completions: ${total} methods in ${_allMethods.length} tiers loaded from sclang`);
}

/**
 * Query sclang for the class-side methods of a specific class (e.g. SinOsc.ar).
 * Walks the metaclass hierarchy so inherited class methods are included.
 * Returns tiered array: [ { owner: 'SinOsc', methods: [...] }, { owner: 'UGen', methods: [...] }, ... ]
 */
async function queryClassMethods(className) {
    if (_classMethodCache.has(className)) return _classMethodCache.get(className);

    const sc = _sc();
    if (!sc) return null;

    // Validate the className is actually a known class (avoid injecting arbitrary code)
    const classes = _dynamicClasses || STATIC_CLASSES;
    if (!classes.includes(className)) return null;

    // SC code that outputs  OwnerClass:method1,method2;NextClass:method3;...
    const code = [
        `({`,
        `var cls = ${className}.class;`,
        `var out = "";`,
        `var seen = IdentitySet.new;`,
        `var owner, ms;`,
        `while({cls.notNil and: {cls != Class}}, {`,
        `  owner = cls.name.asString.replace("Meta_", "");`,
        `  ms = List.new;`,
        `  if(cls.methods.notNil, {`,
        `    cls.methods.do{|m|`,
        `      if(seen.includes(m.name).not, {`,
        `        seen.add(m.name);`,
        `        ms.add(m.name.asString);`,
        `      });`,
        `    };`,
        `  });`,
        `  if(ms.size > 0, { out = out ++ owner ++ ":" ++ ms.sort.join(",") ++ ";" });`,
        `  cls = cls.superclass;`,
        `});`,
        `("${MARKER_CMTH}" ++ out ++ "${MARKER_CMTH}").postln;`,
        `}).value;`
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_CMTH, QUERY_TIMEOUT);
    if (!raw) return null;

    const tiers = parseTieredResult(raw);
    _classMethodCache.set(className, tiers);
    const total = tiers.reduce((n, t) => n + t.methods.length, 0);
    console.log(`[envil] SC completions: ${className} → ${total} class methods in ${tiers.length} tiers`);
    return tiers;
}

/**
 * Query sclang for INSTANCE methods of a class (e.g. methods you call on a UGen).
 * Walks the instance-side class hierarchy.
 * Returns tiered array: [ { owner: 'UGen', methods: [...] }, { owner: 'AbstractFunction', methods: [...] }, ... ]
 */
async function queryInstanceMethods(className) {
    if (_instanceMethodCache.has(className)) return _instanceMethodCache.get(className);

    const sc = _sc();
    if (!sc) return null;

    // Validate className
    const classes = _dynamicClasses || STATIC_CLASSES;
    if (!classes.includes(className)) return null;

    const code = [
        `({`,
        `var cls = ${className};`,
        `var out = "";`,
        `var seen = IdentitySet.new;`,
        `var owner, ms;`,
        `while({cls.notNil}, {`,
        `  owner = cls.name.asString;`,
        `  ms = List.new;`,
        `  if(cls.methods.notNil, {`,
        `    cls.methods.do{|m|`,
        `      if(seen.includes(m.name).not, {`,
        `        seen.add(m.name);`,
        `        ms.add(m.name.asString);`,
        `      });`,
        `    };`,
        `  });`,
        `  if(ms.size > 0, { out = out ++ owner ++ ":" ++ ms.sort.join(",") ++ ";" });`,
        `  cls = cls.superclass;`,
        `});`,
        `("${MARKER_IMTH}" ++ out ++ "${MARKER_IMTH}").postln;`,
        `}).value;`
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_IMTH, QUERY_TIMEOUT);
    if (!raw) return null;

    const tiers = parseTieredResult(raw);
    _instanceMethodCache.set(className, tiers);
    const total = tiers.reduce((n, t) => n + t.methods.length, 0);
    console.log(`[envil] SC completions: ${className} → ${total} instance methods in ${tiers.length} tiers`);
    return tiers;
}

/**
 * Query sclang for the runtime class of a variable expression.
 * E.g. queryVarClass('a') → 'Buffer', queryVarClass('~out') → 'NodeProxy'
 * Results are cached with a short TTL (variables can be reassigned).
 */
async function queryVarClass(varExpr) {
    // Check cache (with TTL)
    const cached = _varClassCache.get(varExpr);
    if (cached && (Date.now() - cached.ts) < VAR_CLASS_TTL) {
        return cached.cls;
    }

    const sc = _sc();
    if (!sc) return null;

    // Safety: only allow safe variable expressions
    // Single letters a-z, or ~word identifiers
    if (!/^([a-z]|~\w+)$/.test(varExpr)) return null;

    const code = `("${MARKER_VCLS}" ++ ${varExpr}.class.name.asString ++ "${MARKER_VCLS}").postln;`;
    const raw = await sc.queryCode(code, MARKER_VCLS, 1500);
    if (!raw) return null;

    const cls = raw.trim();
    // Ignore nil — means the variable isn't assigned
    if (!cls || cls === 'Nil' || cls === 'nil') return null;

    _varClassCache.set(varExpr, { cls, ts: Date.now() });
    console.log(`[envil] SC completions: ${varExpr} → ${cls}`);
    return cls;
}

/**
 * Parse tiered SC query result format:  "OwnerA:m1,m2;OwnerB:m3,m4;"
 * Returns [ { owner: 'OwnerA', methods: ['m1','m2'] }, { owner: 'OwnerB', methods: ['m3','m4'] } ]
 */
function parseTieredResult(raw) {
    const tiers = [];
    const segments = raw.split(';').filter(Boolean);
    for (const seg of segments) {
        const idx = seg.indexOf(':');
        if (idx < 0) continue;
        const owner = seg.substring(0, idx).trim();
        const methods = seg.substring(idx + 1).split(',').map(s => s.trim()).filter(Boolean);
        if (owner && methods.length > 0) {
            tiers.push({ owner, methods });
        }
    }
    return tiers;
}

// ── Polling ──────────────────────────────────────────────────────────────────

async function poll() {
    const sc = _sc();
    if (!sc) return;

    // First poll: load classes + all methods
    if (_dynamicClasses === null) {
        await queryClassList();
    }
    if (_allMethods === null) {
        // Slight delay so we don't flood sclang on startup
        setTimeout(() => queryAllMethods(), 2000);
    }
    // Subsequent polls: refresh class list (methods don't change)
    if (_dynamicClasses !== null) {
        await queryClassList();
    }
}

// ── Completion Provider ──────────────────────────────────────────────────────

class SCCompletionProvider {
    async provideCompletionItems(document, position) {
        if (document.languageId !== LANGUAGE_ID) return null;

        const lineText  = document.lineAt(position).text;
        const before    = lineText.substring(0, position.character);

        // ── Case 1: ClassName.partial  (known class → show its class methods)
        //    e.g.  SinOsc.ar  or  Buffer.re
        const classDotMatch = before.match(/\b([A-Z]\w*)\.\s*(\w*)$/);
        if (classDotMatch) {
            const className = classDotMatch[1];
            const partial   = (classDotMatch[2] || '').toLowerCase();
            return await this._classMethodCompletions(className, partial);
        }

        // ── Case 2: ~proxy.partial  (query runtime class of the proxy)
        //    e.g.  ~out.pl  or  ~synth.se
        const proxyDotMatch = before.match(/(~\w+)\.\s*(\w*)$/);
        if (proxyDotMatch) {
            const varExpr = proxyDotMatch[1];
            const partial = (proxyDotMatch[2] || '').toLowerCase();
            return await this._varMethodCompletions(varExpr, partial);
        }

        // ── Case 3: globalVar.partial  (single letter a-z, query runtime class)
        //    e.g.  a.pl  or  s.bo  or  b.numF
        const globalDotMatch = before.match(/\b([a-z])\.\s*(\w*)$/);
        if (globalDotMatch) {
            const varExpr = globalDotMatch[1];
            const partial = (globalDotMatch[2] || '').toLowerCase();
            return await this._varMethodCompletions(varExpr, partial);
        }

        // ── Case 4: ClassName.ar/kr/ir(...).partial  (UGen constructor → UGen instance methods)
        //    e.g.  SinOsc.ar(440).soft  or  LPF.ar(in, freq).ra
        //    Uses greedy match up to last ")." to handle nested parens
        const ugenCtorMatch = before.match(/\b[A-Z]\w*\.(?:ar|kr|ir)\s*\(.*\)\.\s*(\w*)$/);
        if (ugenCtorMatch) {
            const partial = (ugenCtorMatch[1] || '').toLowerCase();
            return await this._instanceMethodCompletions('UGen', partial);
        }

        // ── Case 5: .partial  (unknown receiver → show all methods)
        const dotMatch = before.match(/\.(\w*)$/);
        if (dotMatch) {
            const partial = (dotMatch[1] || '').toLowerCase();
            return this._generalMethodCompletions(partial);
        }

        // ── Case 6: Uppercase word → show classes
        const classMatch = before.match(/\b([A-Z]\w*)$/);
        if (classMatch) {
            const partial = classMatch[1].toLowerCase();
            return this._classCompletions(partial);
        }

        // Other cases (lowercase words, keywords) → handled by LSP
        return null;
    }

    /**
     * After ClassName. → show class-side methods (queried from sclang).
     */
    async _classMethodCompletions(className, partial) {
        const tiers = await queryClassMethods(className);
        if (tiers && tiers.length > 0) {
            return this._buildTieredMethodList(tiers, partial, className);
        }
        // Fallback to general methods
        return this._generalMethodCompletions(partial);
    }

    /**
     * After variable. → query its runtime class, then show instance methods.
     * Falls back to all methods if sclang isn't running or var is nil.
     */
    async _varMethodCompletions(varExpr, partial) {
        const cls = await queryVarClass(varExpr);
        if (cls) {
            const tiers = await queryInstanceMethods(cls);
            if (tiers && tiers.length > 0) {
                return this._buildTieredMethodList(tiers, partial, cls);
            }
        }
        // Fallback: show all methods
        return this._generalMethodCompletions(partial);
    }

    /**
     * After ClassName.ar/kr/ir(...). → show instance methods of a known class.
     */
    async _instanceMethodCompletions(className, partial) {
        const tiers = await queryInstanceMethods(className);
        if (tiers && tiers.length > 0) {
            return this._buildTieredMethodList(tiers, partial, className);
        }
        return this._generalMethodCompletions(partial);
    }

    /**
     * After . with unknown receiver → show all known methods, tiered by prevalence.
     */
    _generalMethodCompletions(partial) {
        if (_allMethods && _allMethods.length > 0) {
            return this._buildTieredMethodList(_allMethods, partial, null);
        }
        // Static fallback: wrap in a single tier
        return this._buildTieredMethodList(
            [{ owner: 'method', methods: STATIC_METHODS }], partial, null);
    }

    /**
     * Typing an uppercase word → show matching class names.
     */
    _classCompletions(partial) {
        const classes = _dynamicClasses || STATIC_CLASSES;
        const items = [];
        for (const cls of classes) {
            if (!cls.toLowerCase().startsWith(partial)) continue;
            items.push(new vscode.CompletionItem(cls, vscode.CompletionItemKind.Class));
        }
        return new vscode.CompletionList(items, false);
    }

    /**
     * Friendly labels for prevalence-tier owners.
     */
    static TIER_LABELS = {
        'core':   '●  core',
        'common': '○  common',
        'audio':  '♪  audio',
        'other':  '…  other',
        'method': '',
    };

    /**
     * Build a CompletionList from tiered method results.
     * Methods from tier 0 sort first, tier 1 next, etc.
     * Detail shows the owning class or prevalence category.
     */
    _buildTieredMethodList(tiers, partial, rootClass) {
        const items = [];
        for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
            const { owner, methods } = tiers[tierIdx];
            const isDirect = (tierIdx === 0);

            // Determine the detail label
            let detail;
            const friendlyLabel = SCCompletionProvider.TIER_LABELS[owner];
            if (friendlyLabel !== undefined) {
                // Prevalence tier (core/common/audio/other)
                detail = friendlyLabel;
            } else if (isDirect) {
                // Class hierarchy: direct class
                detail = owner;
            } else {
                // Class hierarchy: inherited
                detail = `${owner}  (inherited)`;
            }

            for (const m of methods) {
                if (partial && !m.toLowerCase().startsWith(partial)) continue;
                const item = new vscode.CompletionItem(m, vscode.CompletionItemKind.Method);
                // sortText: 0-padded tier index + method name → direct methods sort first
                item.sortText = String(tierIdx).padStart(3, '0') + '_' + m;
                if (detail) item.detail = detail;
                items.push(item);
            }
        }
        return new vscode.CompletionList(items, false);
    }
}
// ── Signature Help ────────────────────────────────────────────────────────────────

/**
 * Query sclang for the signature of a method on a class.
 * Tries: ClassName.findRespondingMethodFor(\methodName)
 * Returns { label: 'ClassName.method(arg1, arg2)', params: ['arg1', 'arg2'] } or null.
 */
async function queryMethodSignature(className, methodName, isMeta = true) {
    const key = `${className}:${methodName}:${isMeta ? 'c' : 'i'}`;
    if (_sigCache.has(key)) return _sigCache.get(key);

    const sc = _sc();
    if (!sc) return null;

    // Safety: className must look like an identifier starting with uppercase,
    // methodName must be a simple identifier
    if (!/^[A-Z]\w*$/.test(className)) return null;
    if (!/^\w+$/.test(methodName)) return null;

    // For class-side calls (SinOsc.ar), findRespondingMethodFor on the class object
    // searches the metaclass hierarchy for class methods.
    // For instance-side calls (~out.play), walk the class hierarchy with findMethod
    // to find instance methods.
    const findExpr = isMeta
        ? `m = cls.findRespondingMethodFor(\\${methodName});`
        : `cc = cls; while({ cc.notNil and: m.isNil }, { m = cc.findMethod(\\${methodName}); cc = cc.superclass; });`;

    const code = [
        `({`,
        `var cls = ${className};`,
        `var m = nil;`,
        `var cc;`,
        `var args, defs, parts, owner, def;`,
        findExpr,
        `if(m.notNil, {`,
        `  args = m.argNames;`,
        `  defs = m.prototypeFrame;`,
        `  parts = List.new;`,
        `  if(args.notNil, {`,
        `    args.do{|a, i|`,
        `      if(i > 0, {`,
        `        def = if(defs.notNil and: {defs[i].notNil}, { defs[i].asString }, { nil });`,
        `        if(def.notNil, {`,
        `          parts.add(a.asString ++ ":" ++ def);`,
        `        }, {`,
        `          parts.add(a.asString);`,
        `        });`,
        `      });`,
        `    };`,
        `  });`,
        `  owner = m.ownerClass.name.asString.replace("Meta_", "");`,
        `  ("${MARKER_SIG}" ++ owner ++ "." ++ "${methodName}" ++ "(" ++ parts.join(", ") ++ ")" ++ "${MARKER_SIG}").postln;`,
        `}, {`,
        `  ("${MARKER_SIG}${MARKER_SIG}").postln;`,
        `});`,
        `}).value;`
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_SIG, 2000);
    if (!raw || raw.trim().length === 0) {
        _sigCache.set(key, null);
        return null;
    }

    // Parse: "SinOsc.ar(freq: 440.0, phase: 0.0, mul: 1.0, add: 0.0)"
    const fullLabel = raw.trim();
    const parenIdx = fullLabel.indexOf('(');
    if (parenIdx < 0) {
        _sigCache.set(key, null);
        return null;
    }
    const paramsStr = fullLabel.substring(parenIdx + 1, fullLabel.lastIndexOf(')'));
    const params = paramsStr ? paramsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    const result = { label: fullLabel, params };
    _sigCache.set(key, result);
    console.log(`[envil] SC signature: ${fullLabel}`);
    return result;
}

/**
 * Search for a method by name across all SC classes (for unknown receivers).
 * Tries common base classes first, then falls back to a global search.
 * Used when the receiver type can't be determined (e.g. sig.softclip().
 */
async function queryMethodSignatureAny(methodName) {
    const key = `*:${methodName}`;
    if (_sigCache.has(key)) return _sigCache.get(key);

    const sc = _sc();
    if (!sc) return null;
    if (!/^\w+$/.test(methodName)) return null;

    const code = [
        `({`,
        `var name = \\${methodName};`,
        `var found = nil;`,
        `var args, defs, parts, owner, def;`,
        `[AbstractFunction, UGen, Object, Number, SimpleNumber, Float, Integer,`,
        ` Collection, SequenceableCollection, Array, List, String, Symbol,`,
        ` Event, Dictionary, IdentityDictionary, Server, Buffer, Bus,`,
        ` NodeProxy, Pattern, Stream, Env, SynthDef].do{|c|`,
        `  if(found.isNil, { found = c.findMethod(name) });`,
        `};`,
        `if(found.isNil, {`,
        `  Class.allClasses.do{|c|`,
        `    if(found.isNil, { found = c.findMethod(name) });`,
        `  };`,
        `});`,
        `if(found.notNil, {`,
        `  args = found.argNames;`,
        `  defs = found.prototypeFrame;`,
        `  parts = List.new;`,
        `  if(args.notNil, {`,
        `    args.do{|a, i|`,
        `      if(i > 0, {`,
        `        def = if(defs.notNil and: {defs[i].notNil}, { defs[i].asString }, { nil });`,
        `        if(def.notNil, {`,
        `          parts.add(a.asString ++ ":" ++ def);`,
        `        }, {`,
        `          parts.add(a.asString);`,
        `        });`,
        `      });`,
        `    };`,
        `  });`,
        `  owner = found.ownerClass.name.asString.replace("Meta_", "");`,
        `  ("${MARKER_SIG}" ++ owner ++ "." ++ "${methodName}" ++ "(" ++ parts.join(", ") ++ ")" ++ "${MARKER_SIG}").postln;`,
        `}, {`,
        `  ("${MARKER_SIG}${MARKER_SIG}").postln;`,
        `});`,
        `}).value;`
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_SIG, 3000);
    if (!raw || raw.trim().length === 0) {
        _sigCache.set(key, null);
        return null;
    }

    const fullLabel = raw.trim();
    const parenIdx = fullLabel.indexOf('(');
    if (parenIdx < 0) {
        _sigCache.set(key, null);
        return null;
    }
    const paramsStr = fullLabel.substring(parenIdx + 1, fullLabel.lastIndexOf(')'));
    const params = paramsStr ? paramsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    const result = { label: fullLabel, params };
    _sigCache.set(key, result);
    console.log(`[envil] SC signature (any): ${fullLabel}`);
    return result;
}

/**
 * Resolve the class name for a receiver expression before a method call.
 * Handles: ClassName.method(  ~proxy.method(  globalVar.method(  expr.method(
 */
async function resolveReceiverClass(beforeDot) {
    // ClassName.method( → class is ClassName (metaclass)
    const classDotMatch = beforeDot.match(/\b([A-Z]\w*)$/);
    if (classDotMatch) {
        return { cls: classDotMatch[1], isMeta: true };
    }
    // ~proxy.method(
    const proxyMatch = beforeDot.match(/(~\w+)$/);
    if (proxyMatch) {
        const cls = await queryVarClass(proxyMatch[1]);
        if (cls) return { cls, isMeta: false };
    }
    // single-letter global var.method(
    const globalMatch = beforeDot.match(/\b([a-z])$/);
    if (globalMatch) {
        const cls = await queryVarClass(globalMatch[1]);
        if (cls) return { cls, isMeta: false };
    }
    return null;
}

class SCSignatureHelpProvider {
    async provideSignatureHelp(document, position) {
        if (document.languageId !== LANGUAGE_ID) return null;

        // Only provide dynamic signatures when sclang is running.
        // When not running, return null so the LSP static signatures serve as fallback.
        if (!_sc()) return null;

        const text = document.getText();
        const offset = document.offsetAt(position);

        // Walk backwards to find the unmatched '(' of the current call
        let depth = 0;
        let callStart = -1;
        let activeParam = 0;

        for (let i = offset - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === ')' || ch === ']' || ch === '}') {
                depth++;
            } else if (ch === '(' || ch === '[' || ch === '{') {
                if (depth === 0) {
                    if (ch === '(') callStart = i;
                    break;
                }
                depth--;
            } else if (ch === ',' && depth === 0) {
                activeParam++;
            }
        }

        if (callStart < 0) return null;

        const before = text.substring(0, callStart);

        // Pattern: receiver.method(
        const dotMethodMatch = before.match(/(.*)\.\s*(\w+)\s*$/);
        if (dotMethodMatch) {
            const receiverText = dotMethodMatch[1];
            const methodName = dotMethodMatch[2];

            // Try to resolve receiver class
            const resolved = await resolveReceiverClass(receiverText);
            let sig = null;

            if (resolved) {
                // For class-side calls (SinOsc.ar), query on the class itself
                // For instance-side calls (~out.play), query on the instance class
                sig = await queryMethodSignature(resolved.cls, methodName, resolved.isMeta);
            }

            // If we couldn't resolve the receiver, search across all classes
            if (!sig) {
                sig = await queryMethodSignatureAny(methodName);
            }

            if (sig) {
                return this._buildResult(sig, activeParam);
            }
        }

        // Pattern: ClassName(  (constructor style)
        const ctorMatch = before.match(/\b([A-Z]\w*)\s*$/);
        if (ctorMatch) {
            const sig = await queryMethodSignature(ctorMatch[1], 'new');
            if (sig) {
                return this._buildResult(sig, activeParam);
            }
        }

        // Pattern: plain function/method without dot: methodName(
        // Search across all classes
        const bareMatch = before.match(/\b(\w+)\s*$/);
        if (bareMatch && /^[a-z]/.test(bareMatch[1])) {
            const sig = await queryMethodSignatureAny(bareMatch[1]);
            if (sig) {
                return this._buildResult(sig, activeParam);
            }
        }

        return null;
    }

    _buildResult(sig, activeParam) {
        const signatureInfo = new vscode.SignatureInformation(sig.label);
        signatureInfo.parameters = sig.params.map(p =>
            new vscode.ParameterInformation(p)
        );

        const result = new vscode.SignatureHelp();
        result.signatures = [signatureInfo];
        result.activeSignature = 0;
        result.activeParameter = Math.min(activeParam, Math.max(0, sig.params.length - 1));
        return result;
    }
}
// ── Registration ─────────────────────────────────────────────────────────────

function registerSCCompletions(context, { getSC }) {
    _getSC = getSC;

    // Suppress our markers from the Post Window
    const sc = _getSC ? _getSC() : null;
    if (sc && sc.addSuppressMarker) {
        sc.addSuppressMarker(MARKER_CLS);
        sc.addSuppressMarker(MARKER_MTH);
        sc.addSuppressMarker(MARKER_CMTH);
        sc.addSuppressMarker(MARKER_IMTH);
        sc.addSuppressMarker(MARKER_VCLS);
        sc.addSuppressMarker(MARKER_SIG);
    }

    // Register completion provider — '.' triggers it, but it also fires
    // during normal typing (for class name completions)
    const provider = vscode.languages.registerCompletionItemProvider(
        { language: LANGUAGE_ID, scheme: '*' },
        new SCCompletionProvider(),
        '.'   // trigger character
    );
    context.subscriptions.push(provider);

    // Register dynamic signature help provider (overrides static LSP signatures)
    const sigProvider = vscode.languages.registerSignatureHelpProvider(
        { language: LANGUAGE_ID, scheme: '*' },
        new SCSignatureHelpProvider(),
        { triggerCharacters: ['(', ','], retriggerCharacters: [','] }
    );
    context.subscriptions.push(sigProvider);

    // Poll periodically to keep class list fresh
    _pollTimer = setInterval(poll, POLL_INTERVAL);
    context.subscriptions.push({ dispose: () => clearInterval(_pollTimer) });

    // Also trigger an initial poll when a SC file becomes active
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === LANGUAGE_ID) {
                poll();
            }
        })
    );

    console.log('[envil] SC class/method completions registered');
}

/**
 * Force-clear caches (e.g. when sclang restarts and class library recompiles).
 */
function clearSCCompletionCaches() {
    _dynamicClasses = null;
    _classMethodCache.clear();
    _instanceMethodCache.clear();
    _varClassCache.clear();
    _sigCache.clear();
    _allMethods = null;
    console.log('[envil] SC completion caches cleared');
}

module.exports = { registerSCCompletions, clearSCCompletionCaches };
