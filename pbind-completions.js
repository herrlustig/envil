// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Pbind / Event key autocompletion and hover tooltips for SuperCollider
//
// Provides:
//   1) Completions: when typing `\` inside a Pbind/Pmono/PmonoArtic/Pbindef,
//      shows common Event keys + SynthDef args from loaded SynthDescs
//   2) SynthDef name dropdown when typing \instrument, \
//   3) Pdef/Tdef/Ndef name dropdown when typing Pdef(\ etc.
//   4) Hover: when hovering over `\keyName`, shows Event key tooltip
//
// SynthDef data comes from live sclang queries (SynthDescLib.global).
// Event key data is static (from SC Event documentation).
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');

const LANGUAGE_ID = 'supercollider';

// ── Event key database ───────────────────────────────────────────────────────
// Source: SuperCollider Event documentation + common usage
// Categories help organise the completion list

const EVENT_KEYS = [
    // ── Pitch ────────────────────────────────────────────────────────────
    { key: 'freq',      cat: 'Pitch',      detail: 'Frequency in Hz (overrides midinote/degree)',
      doc: 'Frequency in Hz. If set, overrides `midinote` and `degree`. Default: derived from `midinote`.' },
    { key: 'midinote',  cat: 'Pitch',      detail: 'MIDI note number (0–127)',
      doc: 'MIDI note number (0–127). Overrides `degree`. Default: derived from `(degree + mtranspose).degreeToKey(scale, stepsPerOctave) + gtranspose + root` then `* octaveRatio + ctranspose`.' },
    { key: 'degree',    cat: 'Pitch',      detail: 'Scale degree (0 = root)',
      doc: 'Scale degree (0-based). Combined with `scale`, `root`, `octave`, and transposition keys to produce `midinote`. Default: 0.' },
    { key: 'note',      cat: 'Pitch',      detail: 'Chromatic note (0–11) within octave',
      doc: 'Chromatic note value within the octave (0–11). Intermediate step between `degree` and `midinote`.' },
    { key: 'octave',    cat: 'Pitch',      detail: 'Octave number (default 5 → middle C)',
      doc: 'Octave number. Middle C (MIDI 60) is octave 5. Default: 5.' },
    { key: 'root',      cat: 'Pitch',      detail: 'Root note of the scale (semitones, default 0)',
      doc: 'Chromatic offset of the scale root in semitones. Default: 0 (C).' },
    { key: 'scale',     cat: 'Pitch',      detail: 'Scale as array of semitone intervals',
      doc: 'Array of semitone values defining the scale. Default: `Scale.major.semitones` → `[0,2,4,5,7,9,11]`. Use `Scale.minor`, `Scale.dorian`, etc.' },
    { key: 'stepsPerOctave', cat: 'Pitch', detail: 'Steps per octave (default 12)',
      doc: 'Number of equal-tempered steps per octave. Default: 12. Change for microtonal work.' },
    { key: 'detune',    cat: 'Pitch',      detail: 'Detune in Hz added to freq',
      doc: 'Detuning offset in Hz, added to the calculated frequency. Default: 0.' },
    { key: 'harmonic',  cat: 'Pitch',      detail: 'Harmonic ratio multiplied with freq',
      doc: 'Harmonic ratio multiplied with the frequency. Default: 1. E.g. 2 = one octave up.' },
    { key: 'mtranspose', cat: 'Pitch',     detail: 'Modal transposition (scale degrees)',
      doc: 'Transposition in scale degrees (modal). Added to `degree` before scale lookup. Default: 0.' },
    { key: 'gtranspose', cat: 'Pitch',     detail: 'Gamut transposition (semitones, post-scale)',
      doc: 'Transposition in semitones applied after scale-degree-to-note conversion. Default: 0.' },
    { key: 'ctranspose', cat: 'Pitch',     detail: 'Chromatic transposition added to midinote',
      doc: 'Chromatic transposition in semitones. Added to `midinote`. Default: 0.' },
    { key: 'octaveRatio', cat: 'Pitch',    detail: 'Frequency ratio of an octave (default 2)',
      doc: 'Frequency ratio for one octave. Default: 2.0. Change for stretched/compressed tunings.' },

    // ── Duration / Rhythm ────────────────────────────────────────────────
    { key: 'dur',       cat: 'Duration',   detail: 'Duration until next event (beats)',
      doc: 'Time until the next event in beats. Default: 1. This is the inter-onset interval, not the note length.' },
    { key: 'delta',     cat: 'Duration',   detail: 'Override for inter-onset time (beats)',
      doc: 'If set, overrides `dur * stretch` as the actual inter-onset time.' },
    { key: 'stretch',   cat: 'Duration',   detail: 'Stretch factor multiplied with dur',
      doc: 'Multiplier for `dur`. Actual delta = `dur * stretch`. Default: 1.' },
    { key: 'legato',    cat: 'Duration',   detail: 'Note length as fraction of dur (default 0.8)',
      doc: 'Note sustain as a fraction of `dur`. `sustain = dur * legato`. Default: 0.8.' },
    { key: 'sustain',   cat: 'Duration',   detail: 'Absolute note sustain time (beats)',
      doc: 'Absolute sustain time in beats. If set, overrides `dur * legato`. The synth receives this as the `sustain` arg.' },
    { key: 'tempo',     cat: 'Duration',   detail: 'Set TempoClock tempo (beats/sec)',
      doc: 'If set, changes the TempoClock tempo to this value (beats per second) at each event.' },

    // ── Amplitude ────────────────────────────────────────────────────────
    { key: 'amp',       cat: 'Amplitude',  detail: 'Amplitude (0–1, linear)',
      doc: 'Linear amplitude (0.0–1.0). Converted to `db` if needed. Default: 0.1.' },
    { key: 'db',        cat: 'Amplitude',  detail: 'Amplitude in dB (overrides amp)',
      doc: 'Amplitude in decibels. If set, overrides `amp`. `amp = db.dbamp`.' },
    { key: 'velocity',  cat: 'Amplitude',  detail: 'MIDI velocity (mapped to amp)',
      doc: 'Velocity (typically 0–127). Maps to `amp = velocity / 127`. Used by MIDI event types.' },
    { key: 'pan',       cat: 'Amplitude',  detail: 'Pan position (−1 left, +1 right)',
      doc: 'Stereo pan position. −1 = left, 0 = center, +1 = right. Default: 0.' },
    { key: 'trig',      cat: 'Amplitude',  detail: 'Trigger value (1 = normal, 0 = silent event)',
      doc: 'Trigger value. When < 0.5, the synth plays silently (rest). Default: 1.' },

    // ── Instrument / SynthDef ────────────────────────────────────────────
    { key: 'instrument', cat: 'Instrument', detail: 'SynthDef name (Symbol or String)',
      doc: 'Name of the SynthDef to play. Default: `\\default`. Can be a Symbol or String.' },
    { key: 'synthLib',  cat: 'Instrument',  detail: 'SynthDescLib to look up SynthDef',
      doc: 'The SynthDescLib used to look up the SynthDef. Default: `SynthDescLib.global`.' },

    // ── Server / Output ──────────────────────────────────────────────────
    { key: 'out',       cat: 'Output',     detail: 'Output bus index (default 0)',
      doc: 'Output bus index for the synth. Default: 0 (hardware output).' },
    { key: 'group',     cat: 'Output',     detail: 'Target Group / Node ID',
      doc: 'The Group (or node ID) in which to create the synth. Default: `server.defaultGroup`.' },
    { key: 'addAction',  cat: 'Output',    detail: 'Node placement (0=head, 1=tail, …)',
      doc: 'Node add action: 0 = addToHead, 1 = addToTail, 2 = addBefore, 3 = addAfter, 4 = addReplace. Default: 0.' },
    { key: 'server',    cat: 'Output',     detail: 'Target Server instance',
      doc: 'The Server to play on. Default: `Server.default`.' },

    // ── MIDI Event type ──────────────────────────────────────────────────
    { key: 'type',      cat: 'Event Type', detail: 'Event type (\\note, \\midi, \\rest, …)',
      doc: 'The event type. Common values: `\\note` (default — plays a synth), `\\midi` (sends MIDI), `\\rest` (silence), `\\set` (set synth args), `\\monoNote`, `\\group`.' },
    { key: 'midiout',   cat: 'MIDI',       detail: 'MIDIOut instance for \\midi type',
      doc: 'A `MIDIOut` instance used when `type: \\midi`. Required for MIDI event playback.' },
    { key: 'chan',       cat: 'MIDI',       detail: 'MIDI channel (0–15)',
      doc: 'MIDI channel (0–15). Used with `type: \\midi`. Default: 0.' },

    // ── Envelope / Gate ──────────────────────────────────────────────────
    { key: 'gate',      cat: 'Envelope',   detail: 'Gate signal (1 = on, 0 = release)',
      doc: 'Gate signal for the synth envelope. Set to 1 at note-on, 0 at note-off. Normally managed automatically.' },
    { key: 'attack',    cat: 'Envelope',   detail: 'Attack time (for default SynthDef)',
      doc: 'Attack time in seconds. Used by the `\\default` SynthDef and others that read an `attack` arg.' },
    { key: 'release',   cat: 'Envelope',   detail: 'Release time (for default SynthDef)',
      doc: 'Release time in seconds. Used by the `\\default` SynthDef. Default: varies by instrument.' },

    // ── Effect / Filter args (common SynthDef args) ──────────────────────
    { key: 'ffreq',     cat: 'Filter',     detail: 'Filter frequency (common SynthDef arg)',
      doc: 'Filter cutoff frequency — a commonly used custom SynthDef argument name. Not a built-in Event key.' },

    // ── Pattern infrastructure ───────────────────────────────────────────
    { key: 'strum',     cat: 'Timing',     detail: 'Strum delay between chord notes (sec)',
      doc: 'Time offset between notes of a chord (seconds). Creates a strumming effect. Default: 0.' },
    { key: 'lag',       cat: 'Timing',     detail: 'Message lag / latency (sec)',
      doc: 'Latency added to OSC message scheduling (seconds). Default: `Server.default.latency` (typically 0.2).' },
    { key: 'timingOffset', cat: 'Timing',  detail: 'Timing offset added to event time',
      doc: 'Additional time offset (beats) added to the event scheduling time. Default: 0.' },

    // ── Callbacks ────────────────────────────────────────────────────────
    { key: 'callback',  cat: 'Callback',   detail: 'Function called after event plays',
      doc: 'A Function called after each event plays. Receives the event as argument. Useful for side effects / monitoring.' },
    { key: 'finish',    cat: 'Callback',   detail: 'Function called to finalise event',
      doc: 'A Function called during event preparation, after pitch/duration calculation. Can modify the event before it plays.' },

    // ── Buf / Sample ─────────────────────────────────────────────────────
    { key: 'bufnum',    cat: 'Buffer',     detail: 'Buffer number for sample playback',
      doc: 'Buffer number (integer) passed to the synth. Used by SynthDefs that play samples (`PlayBuf`, `BufRd`, etc.).' },
    { key: 'buf',       cat: 'Buffer',     detail: 'Buffer number (alias for bufnum)',
      doc: 'Alias for `bufnum`. Some SynthDefs use `buf` instead of `bufnum` as the argument name.' },
    { key: 'rate',      cat: 'Buffer',     detail: 'Playback rate for buffers',
      doc: 'Playback rate for sample-based SynthDefs. 1 = original speed, 2 = double speed, 0.5 = half speed.' },
    { key: 'startPos',  cat: 'Buffer',     detail: 'Start position in buffer (frames)',
      doc: 'Start position in the buffer (in frames). Used by sample-based SynthDefs.' },
    { key: 'loop',      cat: 'Buffer',     detail: 'Loop buffer playback (1 = on, 0 = off)',
      doc: 'Whether to loop buffer playback. 1 = loop, 0 = no loop. Default: 0.' },

    // ── Misc ─────────────────────────────────────────────────────────────
    { key: 'args',      cat: 'Misc',       detail: 'Array of arg names to send to synth',
      doc: 'An Array of argument name symbols specifying which Event keys to send to the synth. Normally auto-detected from SynthDesc.' },
    { key: 'isPlaying',  cat: 'State',     detail: 'Whether the synth is currently playing',
      doc: 'Boolean flag indicating whether the synth node is still running. Set by node watcher.' },
    { key: 'isRest',    cat: 'State',      detail: 'Whether this event is a rest',
      doc: 'Returns true if the event is a rest (no sound). Can be set explicitly or determined from `trig` or `Rest()` values.' },
    { key: 'id',        cat: 'Node',       detail: 'Synth node ID(s)',
      doc: 'Node ID (or array of IDs) for the synth(s) created by this event. Normally auto-assigned.' },
    { key: 'msgFunc',   cat: 'Advanced',   detail: 'Function generating the OSC message',
      doc: 'A Function that returns the OSC message array for synth creation. Advanced — overrides the default message builder.' },
];

// Build lookup map for hover
const _keyMap = new Map();
for (const entry of EVENT_KEYS) {
    _keyMap.set(entry.key, entry);
}

// ── sclang access ────────────────────────────────────────────────────────────

const MARKER_SDARGS = '___ENVIL_SDARGS___';
const MARKER_SDLIST = '___ENVIL_SDLIST___';
const MARKER_DEFS   = '___ENVIL_DEFS___';

let _getSC = null;
function _sc() {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning || !sc.isSclangRunning() || !sc.queryCode) return null;
    return sc;
}

// ── Pattern call detection ───────────────────────────────────────────────────

// Pattern classes with alternating \key, value structure:
//   Pbind(\key, val, \key, val, ...)            — all args are key/val
//   Pbindf(source, \key, val, \key, val, ...)   — 1st arg is source pattern, rest key/val
//   Pmono(\synthName, \key, val, ...)            — 1st arg is instrument name, rest key/val
//   PmonoArtic(\synthName, \key, val, ...)       — same as Pmono
//   Pbindef(\defName, \key, val, ...)            — 1st arg is def name, rest key/val
const PATTERN_CLASSES = ['Pbind', 'Pmono', 'PmonoArtic', 'Pbindef', 'Pbindf'];
const FIRST_ARG_SPECIAL = new Set(['Pmono', 'PmonoArtic', 'Pbindef', 'Pbindf']);
const PATTERN_RE = new RegExp(`\\b(${PATTERN_CLASSES.join('|')})\\s*\\(`);

// Def-style classes: Pdef(\name, ...), Tdef(\name, ...), Ndef(\name, ...), etc.
const DEF_CLASSES = ['Pdef', 'Tdef', 'Ndef', 'Fdef', 'MIDIdef', 'OSCdef'];
const DEF_RE = new RegExp(`\\b(${DEF_CLASSES.join('|')})\\s*\\(`);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Walk backwards from `offset` to find the unmatched `(` of the enclosing call.
 * Matches against the given regex. Returns { className, parenOffset } or null.
 */
function findEnclosingCall(text, offset, classRE) {
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ')' || ch === ']' || ch === '}') depth++;
        else if (ch === '(' || ch === '[' || ch === '{') {
            if (depth === 0) {
                if (ch !== '(') return null;
                const before = text.substring(Math.max(0, i - 40), i + 1);
                const m = before.match(classRE);
                if (m) {
                    return { className: m[1], parenOffset: i };
                }
                return null;
            }
            depth--;
        }
    }
    return null;
}

/**
 * Count comma-separated arg position at `offset` inside parens at `parenOffset`.
 * Returns 0-based index.
 */
function getArgPosition(text, parenOffset, offset) {
    let depth = 0;
    let argIdx = 0;
    for (let i = parenOffset + 1; i < offset; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ',' && depth === 0) argIdx++;
    }
    return argIdx;
}

/**
 * Is cursor at a "key" position in a Pbind-style pattern?
 */
function isAtKeyPosition(className, argIdx) {
    if (FIRST_ARG_SPECIAL.has(className)) {
        // Position 0 is special. Keys at 1, 3, 5, ...
        return argIdx > 0 && (argIdx % 2) === 1;
    }
    // Pbind: keys at 0, 2, 4, ...
    return (argIdx % 2) === 0;
}

/**
 * Is cursor at the value position right after \instrument?
 * Also handles Pmono/PmonoArtic where position 0 IS the instrument.
 */
function isAtInstrumentValuePosition(className, argIdx, text, parenOffset) {
    if ((className === 'Pmono' || className === 'PmonoArtic') && argIdx === 0) {
        return true;
    }
    // Check if the preceding key is \instrument
    let keyArgIdx;
    if (FIRST_ARG_SPECIAL.has(className)) {
        // value positions: 2, 4, 6, ...
        if (argIdx > 0 && (argIdx % 2) === 0) keyArgIdx = argIdx - 1;
        else return false;
    } else {
        // Pbind: value positions: 1, 3, 5, ...
        if (argIdx > 0 && (argIdx % 2) === 1) keyArgIdx = argIdx - 1;
        else return false;
    }
    // Walk to the arg at keyArgIdx and check if it's \instrument
    let depth = 0, currentArg = 0, argStart = parenOffset + 1;
    for (let i = parenOffset + 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
        else if (ch === ',' && depth === 0) {
            if (currentArg === keyArgIdx) {
                return text.substring(argStart, i).trim() === '\\instrument';
            }
            currentArg++;
            argStart = i + 1;
        }
    }
    return false;
}

/**
 * Extract the \instrument value from a Pbind-like call.
 */
function findInstrumentName(text, className, parenOffset) {
    if (className === 'Pmono' || className === 'PmonoArtic') {
        const after = text.substring(parenOffset + 1, parenOffset + 200);
        const m = after.match(/^\s*(?:\\(\w+)|'(\w+)'|"(\w+)")/);
        if (m) return m[1] || m[2] || m[3];
        return null;
    }
    const endSearch = Math.min(text.length, parenOffset + 2000);
    const inside = text.substring(parenOffset + 1, endSearch);
    const m = inside.match(/\\instrument\s*,\s*(?:\\(\w+)|'(\w+)'|"(\w+)")/);
    if (m) return m[1] || m[2] || m[3];
    return null;
}

// ── sclang queries ───────────────────────────────────────────────────────────

/**
 * Query sclang for the controls of a loaded SynthDef.
 * Always fresh — no caching (live coding: things change fast).
 * Returns [{ name, default }] or null.
 */
async function querySynthDefArgs(synthName) {
    const sc = _sc();
    if (!sc) return null;
    if (!/^\w+$/.test(synthName)) return null;

    const code = [
        `({`,
        `var sd = SynthDescLib.global[\\${synthName}];`,
        `if(sd.notNil, {`,
        `  var out = sd.controls.select{|c|`,
        `    [\\out, \\i_out, \\gate, \\doneAction].includes(c.name).not`,
        `  }.collect{|c| c.name.asString ++ "=" ++ c.defaultValue.asString }.join(",");`,
        `  ("${MARKER_SDARGS}" ++ out ++ "${MARKER_SDARGS}").postln;`,
        `}, {`,
        `  ("${MARKER_SDARGS}${MARKER_SDARGS}").postln;`,
        `});`,
        `}).value;`,
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_SDARGS, 2000);
    if (!raw || raw.trim().length === 0) return null;

    const args = [];
    for (const part of raw.trim().split(',')) {
        const t = part.trim();
        if (!t) continue;
        const eq = t.indexOf('=');
        if (eq >= 0) args.push({ name: t.substring(0, eq), default: t.substring(eq + 1) });
        else args.push({ name: t, default: null });
    }
    return args.length > 0 ? args : null;
}

/**
 * Query sclang for all loaded SynthDef names + arg summaries.
 * Returns [{ name, args }] or null.
 */
async function queryLoadedSynthDefs() {
    const sc = _sc();
    if (!sc) return null;

    const code = [
        `({`,
        `var out = "";`,
        `SynthDescLib.global.synthDescs.keysValuesDo{|name, desc|`,
        `  if(name.asString.beginsWith("system_").not, {`,
        `    var args = desc.controls.select{|c|`,
        `      [\\out, \\i_out, \\gate, \\doneAction].includes(c.name).not`,
        `    }.collect{|c| c.name.asString }.join(", ");`,
        `    out = out ++ name.asString ++ "(" ++ args ++ ");";`,
        `  });`,
        `};`,
        `("${MARKER_SDLIST}" ++ out ++ "${MARKER_SDLIST}").postln;`,
        `}).value;`,
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_SDLIST, 3000);
    if (!raw || raw.trim().length === 0) return null;

    const result = [];
    for (const entry of raw.trim().split(';')) {
        const t = entry.trim();
        if (!t) continue;
        const pIdx = t.indexOf('(');
        if (pIdx < 0) continue;
        result.push({ name: t.substring(0, pIdx), args: t.substring(pIdx + 1, t.length - 1) });
    }
    return result.length > 0 ? result : null;
}

/**
 * Query sclang for existing Pdef/Tdef/Ndef/etc names.
 * Returns string[] or null.
 */
async function queryDefNames(defClass) {
    const sc = _sc();
    if (!sc) return null;
    if (!/^[A-Z]\w*$/.test(defClass)) return null;

    const code = [
        `({`,
        `if(${defClass}.respondsTo(\\all), {`,
        `  var names = ${defClass}.all.keys.asArray.sort.collect(_.asString).join(",");`,
        `  ("${MARKER_DEFS}" ++ names ++ "${MARKER_DEFS}").postln;`,
        `}, {`,
        `  ("${MARKER_DEFS}${MARKER_DEFS}").postln;`,
        `});`,
        `}).value;`,
    ].join(' ');

    const raw = await sc.queryCode(code, MARKER_DEFS, 2000);
    if (!raw || raw.trim().length === 0) return null;

    const names = raw.trim().split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    return names.length > 0 ? names : null;
}

// ── Completion Provider ──────────────────────────────────────────────────────

class PbindKeyCompletionProvider {
    async provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text;
        const lineUpToCursor = lineText.substring(0, position.character);

        // Trigger on `\` — check we're typing a symbol key
        const symbolMatch = lineUpToCursor.match(/\\(\w*)$/);
        if (!symbolMatch) return null;

        const partial = symbolMatch[1].toLowerCase();
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const backslashPos = position.character - symbolMatch[0].length;

        // ── Check: Pdef(\, Tdef(\, Ndef(\ etc — show existing def names ──
        const defCall = findEnclosingCall(fullText, offset, DEF_RE);
        if (defCall) {
            const argIdx = getArgPosition(fullText, defCall.parenOffset, offset);
            if (argIdx === 0) {
                return await this._defNameCompletions(defCall.className, partial, position, backslashPos);
            }
        }

        // ── Check: inside a Pbind-like call ──
        const patternCall = findEnclosingCall(fullText, offset, PATTERN_RE);
        if (!patternCall) return null;

        const argIdx = getArgPosition(fullText, patternCall.parenOffset, offset);

        // ── At instrument VALUE position → show loaded SynthDef names ──
        if (isAtInstrumentValuePosition(patternCall.className, argIdx, fullText, patternCall.parenOffset)) {
            return await this._synthDefNameCompletions(partial, position, backslashPos);
        }

        // ── Only show key completions at KEY positions ──
        if (!isAtKeyPosition(patternCall.className, argIdx)) return null;

        // ── Build Event key completions ──
        const items = EVENT_KEYS.map(function(entry) {
            if (partial && !entry.key.toLowerCase().startsWith(partial)) return null;

            const item = new vscode.CompletionItem(
                '\\' + entry.key, vscode.CompletionItemKind.Property);
            item.range = new vscode.Range(position.line, backslashPos, position.line, position.character);
            item.insertText = '\\' + entry.key;
            item.detail = '[' + entry.cat + '] ' + entry.detail;
            item.documentation = new vscode.MarkdownString(
                '**\\' + entry.key + '** — ' + entry.cat + '\n\n' + entry.doc);
            item.sortText = entry.cat.padEnd(20) + entry.key;
            return item;
        }).filter(Boolean);

        // ── Add SynthDef arg completions (from loaded SynthDesc) ──
        const synthName = findInstrumentName(fullText, patternCall.className, patternCall.parenOffset);
        if (synthName) {
            const synthArgs = await querySynthDefArgs(synthName);
            if (synthArgs) {
                for (var i = 0; i < synthArgs.length; i++) {
                    var arg = synthArgs[i];
                    if (partial && !arg.name.toLowerCase().startsWith(partial)) continue;
                    if (_keyMap.has(arg.name)) continue;  // skip standard Event keys

                    var item = new vscode.CompletionItem(
                        '\\' + arg.name, vscode.CompletionItemKind.Variable);
                    item.range = new vscode.Range(position.line, backslashPos, position.line, position.character);
                    item.insertText = '\\' + arg.name;

                    var defStr = arg.default != null ? ' (default: ' + arg.default + ')' : '';
                    item.detail = '🎛  SynthDef \\' + synthName + ' arg' + defStr;
                    item.documentation = new vscode.MarkdownString(
                        '**\\' + arg.name + '** — SynthDef \\\\' + synthName + ' argument' + defStr +
                        '\n\nLoaded in `SynthDescLib.global`.');
                    item.sortText = 'A_syntharg_' + arg.name;
                    items.push(item);
                }
            }
        }

        return new vscode.CompletionList(items, false);
    }

    /**
     * Show all loaded SynthDef names for \instrument value position.
     */
    async _synthDefNameCompletions(partial, position, backslashPos) {
        var synthDefs = await queryLoadedSynthDefs();
        if (!synthDefs) return null;

        var items = [];
        for (var i = 0; i < synthDefs.length; i++) {
            var sd = synthDefs[i];
            if (partial && !sd.name.toLowerCase().startsWith(partial)) continue;

            var item = new vscode.CompletionItem(
                '\\' + sd.name, vscode.CompletionItemKind.Enum);
            item.range = new vscode.Range(position.line, backslashPos, position.line, position.character);
            item.insertText = '\\' + sd.name;
            item.detail = sd.args ? '🎹  (' + sd.args + ')' : '🎹  SynthDef';
            item.documentation = new vscode.MarkdownString(
                '**\\' + sd.name + '** — loaded SynthDef\n\n' +
                (sd.args ? 'Arguments: `' + sd.args + '`' : 'No custom arguments.'));
            item.sortText = '000_' + sd.name;
            items.push(item);
        }
        return new vscode.CompletionList(items, false);
    }

    /**
     * Show existing Pdef/Tdef/Ndef names.
     */
    async _defNameCompletions(defClass, partial, position, backslashPos) {
        var names = await queryDefNames(defClass);
        if (!names) return null;

        var items = [];
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (partial && !name.toLowerCase().startsWith(partial)) continue;

            var item = new vscode.CompletionItem(
                '\\' + name, vscode.CompletionItemKind.Reference);
            item.range = new vscode.Range(position.line, backslashPos, position.line, position.character);
            item.insertText = '\\' + name;
            item.detail = '📎  existing ' + defClass;
            item.documentation = new vscode.MarkdownString(
                '**\\' + name + '** — registered in `' + defClass + '.all`');
            item.sortText = '000_' + name;
            items.push(item);
        }
        return items.length > 0 ? new vscode.CompletionList(items, false) : null;
    }
}

// ── Hover Provider ───────────────────────────────────────────────────────────

class PbindKeyHoverProvider {
    provideHover(document, position) {
        const lineText = document.lineAt(position).text;
        const charIdx = position.character;

        let start = charIdx;
        while (start > 0 && /\w/.test(lineText[start - 1])) start--;
        if (start > 0 && lineText[start - 1] === '\\') start--;
        else return null;

        let end = start + 1;
        while (end < lineText.length && /\w/.test(lineText[end])) end++;

        const keyName = lineText.substring(start + 1, end);
        if (!keyName) return null;

        const entry = _keyMap.get(keyName);
        if (!entry) return null;

        const md = new vscode.MarkdownString();
        md.appendMarkdown('### \\' + entry.key + '  `[' + entry.cat + ']`\n\n');
        md.appendMarkdown(entry.doc + '\n\n');

        const examples = {
            freq:       'Pbind(\\freq, Pseq([440, 550, 660], inf))',
            degree:     'Pbind(\\degree, Pseq([0, 2, 4, 7], inf))',
            dur:        'Pbind(\\dur, Pseq([0.25, 0.5, 0.25], inf))',
            amp:        'Pbind(\\amp, Pwhite(0.05, 0.3))',
            instrument: 'Pbind(\\instrument, \\mySynth)',
            scale:      'Pbind(\\scale, Scale.minor)',
            legato:     'Pbind(\\legato, 0.3)',
            pan:        'Pbind(\\pan, Pwhite(-1.0, 1.0))',
            octave:     'Pbind(\\octave, Prand([4, 5, 6], inf))',
            type:       'Pbind(\\type, \\midi, \\midiout, m)',
            strum:      'Pbind(\\degree, [0, 2, 4], \\strum, 0.1)',
            out:        'Pbind(\\out, ~myBus.index)',
            sustain:    'Pbind(\\sustain, 2)',
        };
        if (examples[entry.key]) {
            md.appendCodeblock(examples[entry.key], 'supercollider');
        }

        return new vscode.Hover(md, new vscode.Range(position.line, start, position.line, end));
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerPbindCompletions(context, opts) {
    if (opts && opts.getSC) _getSC = opts.getSC;

    const selector = { language: LANGUAGE_ID, scheme: '*' };

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector, new PbindKeyCompletionProvider(), '\\')
    );
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            selector, new PbindKeyHoverProvider())
    );

    // Suppress markers from Post Window
    var sc = _getSC ? _getSC() : null;
    if (sc && sc.addSuppressMarker) {
        sc.addSuppressMarker(MARKER_SDARGS);
        sc.addSuppressMarker(MARKER_SDLIST);
        sc.addSuppressMarker(MARKER_DEFS);
    }

    console.log('[envil] Pbind/Event key completions + hover registered');
}

module.exports = { registerPbindCompletions };
