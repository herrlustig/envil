// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Tokeniser + lightweight SC metadata extractor for the suggestion corpus.
// Pure JS, no deps.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// Common noise we don't want to weight heavily
const STOP = new Set([
    'var', 'if', 'nil', 'true', 'false', 'this', 'do', 'and', 'or', 'not',
    'at', 'put', 'new', 'value', 'ar', 'kr', 'ir', 'add', 'play', 'free',
    'sig', 'out', 'in', 'args', 'arg', 'the', 'a', 'an', 'is',
]);

function tokenize(text) {
    if (!text) return [];
    // Split on non-word chars, keep \symbols and ~proxies as word chars
    const out = [];
    // Replace \foo → foo, ~foo → foo, but also keep them as distinct tokens
    const re = /[A-Za-z_][A-Za-z0-9_]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const w = m[0].toLowerCase();
        if (w.length < 2) continue;
        if (/^\d/.test(w)) continue;
        out.push(w);
    }
    return out;
}

function uniqueTokens(tokens) {
    const s = new Set();
    for (const t of tokens) if (!STOP.has(t)) s.add(t);
    return [...s];
}

// Pull out things that are useful for display / filtering / scoring-boost
function extractTags(text) {
    const synthDefs = [];
    const pbindKeys = new Set();
    const ugens = new Set();
    const proxies = new Set();

    // SynthDef(\name, …)
    const sdRe = /SynthDef\s*\(\s*\\([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = sdRe.exec(text)) !== null) synthDefs.push(m[1]);

    // Pbind / Pmono / Pbindef  keys: \word
    const pbRe = /\b(?:Pbind|Pmono|PmonoArtic|Pbindef)\s*\(([\s\S]*?)\)/g;
    while ((m = pbRe.exec(text)) !== null) {
        const body = m[1];
        const keyRe = /\\([A-Za-z_][A-Za-z0-9_]*)/g;
        let k;
        while ((k = keyRe.exec(body)) !== null) pbindKeys.add(k[1]);
    }

    // UGens — heuristic: CapitalWord followed by .ar/.kr/.ir
    const ugRe = /\b([A-Z][A-Za-z0-9]+)\s*\.(ar|kr|ir)\b/g;
    while ((m = ugRe.exec(text)) !== null) ugens.add(m[1]);

    // Proxies: ~name
    const pxRe = /~([A-Za-z_][A-Za-z0-9_]*)/g;
    while ((m = pxRe.exec(text)) !== null) proxies.add(m[1]);

    return {
        synthDefs,
        pbindKeys: [...pbindKeys],
        ugens: [...ugens],
        proxies: [...proxies],
    };
}

// Infer a human-readable kind from content so we can filter / show icons.
function inferKind(text, tags) {
    if (tags.synthDefs.length > 0) return 'synthdef';
    if (/\bPbind(?:ef)?\s*\(/.test(text)) return 'pbind';
    if (/~[A-Za-z_]\w*\s*=\s*\{/.test(text)) return 'nodeproxy';
    if (/\bNdef\s*\(/.test(text)) return 'ndef';
    if (/\bPdef\s*\(/.test(text)) return 'pdef';
    if (/\bOSCdef\s*\(|\bMIDIdef\s*\(/.test(text)) return 'iodef';
    if (/\b(fork|Routine|Task)\s*\{/.test(text)) return 'routine';
    return 'block';
}

// YYYYMMDD hint at the start of a filename
function dateHintFromFilename(file) {
    const base = file.replace(/^.*[\\/]/, '');
    const m = base.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

module.exports = {
    tokenize,
    uniqueTokens,
    extractTags,
    inferKind,
    dateHintFromFilename,
    STOP,
};
