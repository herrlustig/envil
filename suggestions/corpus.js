// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Corpus builder for the offline suggestion system.
//
// Walks a list of root directories, finds SuperCollider source files, splits
// each file into top-level  ( … )  blocks (the same unit the CodeLens
// "▶ Run" buttons use), extracts tokens + tags, and persists the index to
// `data/suggestions-index.json`.
//
// No external dependencies.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    tokenize, uniqueTokens, extractTags, inferKind, dateHintFromFilename,
} = require('./tokenize');

const DEFAULT_EXTS = new Set(['.sc', '.scd']);
const MAX_FILE_BYTES = 1000000;        // skip >1MB files (probably not source)
const MIN_BLOCK_LEN  = 20;             // ignore trivially small blocks
const MAX_BLOCK_LEN  = 6000;           // clamp huge blocks
const MAX_BLOCKS_PER_FILE = 500;

const INDEX_VERSION = 1;

// ── SC comment/string stripper (copy from codelens-blocks.js) ────────────────

function stripCommentsAndStrings(text) {
    const out = text.split('');
    let i = 0;
    while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
        } else if (text[i] === '/' && text[i + 1] === '*') {
            let depth = 1;
            out[i] = ' '; out[i + 1] = ' '; i += 2;
            while (i < text.length && depth > 0) {
                if (text[i] === '/' && text[i + 1] === '*') {
                    out[i] = ' '; out[i + 1] = ' '; i += 2; depth++;
                } else if (text[i] === '*' && text[i + 1] === '/') {
                    out[i] = ' '; out[i + 1] = ' '; i += 2; depth--;
                } else {
                    if (text[i] !== '\n') out[i] = ' '; i++;
                }
            }
        } else if (text[i] === '"') {
            out[i] = ' '; i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') { out[i] = ' '; i++; }
                if (i < text.length && text[i] !== '\n') out[i] = ' '; i++;
            }
            if (i < text.length) { out[i] = ' '; i++; }
        } else {
            i++;
        }
    }
    return out.join('');
}

function findMatchingClose(stripped, startIndex) {
    let depth = 0;
    for (let i = startIndex; i < stripped.length; i++) {
        if (stripped[i] === '(') depth++;
        else if (stripped[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

// ── Directory walk ───────────────────────────────────────────────────────────

function walkDir(root, { maxDepth = 12, exts = DEFAULT_EXTS, skipDirs } = {}) {
    const out = [];
    const skip = skipDirs || new Set([
        'node_modules', '.git', '.vscode', 'dist', 'build', 'out',
        'zz_recordings', 'zz_recordings_sc_dir', '.cache',
    ]);
    function recurse(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch (_e) { return; }
        for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (skip.has(e.name)) continue;
                recurse(full, depth + 1);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (exts.has(ext)) out.push(full);
            }
        }
    }
    recurse(root, 0);
    return out;
}

// ── Block extraction per file ────────────────────────────────────────────────

function extractBlocksFromFile(file, sourceLabel) {
    let buf;
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) return [];
        buf = fs.readFileSync(file, 'utf8');
    } catch (_e) { return []; }

    const stripped = stripCommentsAndStrings(buf);
    const lines = stripped.split('\n');
    const textLines = buf.split('\n');

    const blocks = [];
    let offset = 0;
    const dateHint = dateHintFromFilename(file);

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const lineText = lines[lineNum];
        const trimmed  = lineText.trimStart();

        if (trimmed.startsWith('(')) {
            const parenCol = lineText.indexOf('(');
            const parenOff = offset + parenCol;
            const closeOff = findMatchingClose(stripped, parenOff);
            if (closeOff !== -1) {
                const blockText = buf.substring(parenOff, closeOff + 1);
                if (blockText.length >= MIN_BLOCK_LEN && blockText.length <= MAX_BLOCK_LEN) {
                    // Find end line
                    let cum = 0, endLine = lineNum;
                    for (let i = 0; i < textLines.length; i++) {
                        cum += textLines[i].length + 1;
                        if (cum > closeOff) { endLine = i; break; }
                    }
                    const tokens = tokenize(blockText);
                    const tags = extractTags(blockText);
                    const kind = inferKind(blockText, tags);
                    const id = crypto.createHash('sha1')
                        .update(sourceLabel + '#' + lineNum + '#' + blockText).digest('hex').slice(0, 12);
                    blocks.push({
                        id,
                        file,
                        sourceLabel,
                        dateHint,
                        startLine: lineNum,
                        endLine,
                        kind,
                        text: blockText,
                        tokens,
                        uniqueTokens: uniqueTokens(tokens),
                        tags,
                    });
                    if (blocks.length >= MAX_BLOCKS_PER_FILE) break;
                }
            }
        }
        offset += lineText.length + 1;
    }
    return blocks;
}

// ── Full-corpus build ────────────────────────────────────────────────────────

function buildCorpus(roots, { label = 'user', exts = DEFAULT_EXTS } = {}) {
    const all = [];
    const filesSeen = new Set();
    for (const root of roots) {
        if (!root) continue;
        let resolved;
        try { resolved = fs.realpathSync(root); } catch (_e) { continue; }
        const files = walkDir(resolved, { exts });
        for (const f of files) {
            if (filesSeen.has(f)) continue;
            filesSeen.add(f);
            const relLabel = `${label}:${path.relative(resolved, f)}`;
            const blocks = extractBlocksFromFile(f, relLabel);
            all.push(...blocks);
        }
    }
    return all;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function indexFilePath(cacheDir) {
    return path.join(cacheDir, 'suggestions-index.json');
}

function saveIndex(cacheDir, blocks, meta) {
    const file = indexFilePath(cacheDir);
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {}
    const payload = {
        version: INDEX_VERSION,
        builtAt: new Date().toISOString(),
        meta: meta || {},
        blocks,
    };
    fs.writeFileSync(file, JSON.stringify(payload));
    return file;
}

function loadIndex(cacheDir) {
    const file = indexFilePath(cacheDir);
    if (!fs.existsSync(file)) return null;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        if (data.version !== INDEX_VERSION) return null;
        return data;
    } catch (_e) { return null; }
}

module.exports = {
    buildCorpus,
    extractBlocksFromFile,
    walkDir,
    saveIndex,
    loadIndex,
    indexFilePath,
    INDEX_VERSION,
};
