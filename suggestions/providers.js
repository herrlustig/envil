// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Completion + Inline providers for the offline suggestion system.
//
// Triggers (SuperCollider files only):
//
//   1) CompletionItemProvider — shown in the normal dropdown
//        • typing  `_TPL_`   → offers top corpus blocks (unfiltered)
//        • typing  `//?`     → treats the rest of the line as a query
//        • typing  `//??`    → same, but aggressive (lower score floor)
//
//   2) InlineCompletionItemProvider — Copilot-style ghost text
//        • same `//?` lines — up to N variants cyclable with Alt-] / Alt-[
//        • explicit Alt-/ trigger anywhere in the file
//        Note: when GitHub Copilot is installed and active, Copilot wins the
//        primary ghost-text slot. Cycle with Alt-] / Alt-[ to see Envil's
//        variants, or disable Copilot for SuperCollider via
//        `github.copilot.enable: { "supercollider": false }`.
//
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode = require('vscode');

const LANGUAGE_ID = 'supercollider';

const { BM25 } = require('./bm25');
const { tokenize } = require('./tokenize');

// ── Local helpers ────────────────────────────────────────────────────────────

function getCfg() {
    return vscode.workspace.getConfiguration('envil.corpusSuggestor');
}

// Build a query from either the comment text or the surrounding buffer
function buildQueryFromLine(line, doc, pos) {
    const trimmed = line.trimStart();
    // // ? / // ?? comment lines
    const m = trimmed.match(/^\/\/\s*\?{1,2}\s*(.*)$/);
    if (m) return { source: 'comment', text: m[1].trim(), boost: 1.0 };

    // _TPL_ trigger
    if (trimmed.includes('_TPL_') || trimmed.includes('_TEMPLATE_') || trimmed.includes('_SUGGEST_')) {
        // Use the previous 20 lines as context
        const start = Math.max(0, pos.line - 20);
        const ctx = doc.getText(new vscode.Range(start, 0, pos.line, pos.character));
        return { source: 'template', text: ctx, boost: 0.5 };
    }
    return null;
}

function kindIcon(kind) {
    switch (kind) {
        case 'synthdef':  return '🎹';
        case 'pbind':     return '🎼';
        case 'nodeproxy': return '🔀';
        case 'ndef':      return '📦';
        case 'pdef':      return '📦';
        case 'iodef':     return '🎛';
        case 'routine':   return '↻';
        default:          return '▶';
    }
}

// ── Main provider state ──────────────────────────────────────────────────────

class SuggestionEngine {
    constructor() {
        this.blocks = [];
        this.bm25 = new BM25([]);
        this.ready = false;
    }

    load(indexPayload) {
        if (!indexPayload || !Array.isArray(indexPayload.blocks)) {
            this.blocks = [];
            this.bm25 = new BM25([]);
            this.ready = false;
            return 0;
        }
        this.blocks = indexPayload.blocks;
        // BM25 uses the uniqueTokens for compactness + stop-word filtering
        this.bm25 = new BM25(this.blocks.map(b => ({ id: b.id, tokens: b.uniqueTokens })));
        this.ready = this.blocks.length > 0;
        return this.blocks.length;
    }

    query(text, k = 8) {
        if (!this.ready) return [];
        const tokens = tokenize(text).filter(t => t.length >= 2);
        const hits = this.bm25.search(tokens, k);
        return hits.map(h => ({ block: this.blocks[h.index], score: h.score }));
    }
}

const engine = new SuggestionEngine();

// ── Classic CompletionItemProvider ───────────────────────────────────────────

class TplCompletionProvider {
    provideCompletionItems(document, position) {
        const cfg = getCfg();
        if (!cfg.get('enabled', true)) return undefined;
        if (!engine.ready) return undefined;

        const line = document.lineAt(position.line).text;
        const q = buildQueryFromLine(line, document, position);
        if (!q) return undefined;

        // Aggressive mode with ?? — lower score floor, more items
        const isDouble = /\/\/\s*\?\?/.test(line);
        const max = isDouble ? 12 : (cfg.get('dropdown.maxItems', 6));

        let hits = engine.query(q.text || ' ', Math.max(max * 2, 12));
        if (hits.length === 0 && q.source === 'template') {
            // Fall back: take the most recent N blocks by dateHint
            hits = [...engine.blocks]
                .sort((a, b) => (b.dateHint || '').localeCompare(a.dateHint || ''))
                .slice(0, max)
                .map(b => ({ block: b, score: 0 }));
        }
        hits = hits.slice(0, max);

        const items = hits.map((h, i) => {
            const b = h.block;
            const label = `${kindIcon(b.kind)} ${labelFor(b)}`;
            const item = new vscode.CompletionItem(
                { label, description: b.dateHint || '' },
                vscode.CompletionItemKind.Snippet,
            );
            item.detail = `${b.kind} · ${b.sourceLabel.split(':').slice(1).join(':') || b.sourceLabel}`;
            item.documentation = new vscode.MarkdownString()
                .appendCodeblock(b.text, 'supercollider');
            // Replace the whole line (the trigger + query) with the block
            const lineStart = new vscode.Position(position.line, 0);
            const lineEnd   = new vscode.Position(position.line, document.lineAt(position.line).text.length);
            item.range = new vscode.Range(lineStart, lineEnd);
            item.insertText = b.text;
            item.sortText = String(i).padStart(3, '0');
            item.preselect = i === 0;
            return item;
        });
        return new vscode.CompletionList(items, true);
    }
}

function labelFor(b) {
    if (b.tags.synthDefs && b.tags.synthDefs.length) return `SynthDef(\\${b.tags.synthDefs[0]})`;
    if (b.kind === 'pbind')     return `Pbind { ${(b.tags.pbindKeys || []).slice(0, 3).map(k => '\\' + k).join(' ')} }`;
    if (b.kind === 'nodeproxy' && b.tags.proxies.length) return `~${b.tags.proxies[0]} = { … }`;
    if (b.kind === 'ndef')      return 'Ndef(…)';
    if (b.kind === 'pdef')      return 'Pdef(…)';
    if (b.kind === 'iodef')     return 'OSCdef/MIDIdef(…)';
    // fallback: first non-empty line trimmed
    const firstLine = b.text.split('\n').find(l => l.trim()) || '';
    return firstLine.trim().slice(0, 60);
}

// ── InlineCompletionItemProvider (ghost text, cyclable) ──────────────────────

class TplInlineProvider {
    provideInlineCompletionItems(document, position, ctx) {
        const cfg = getCfg();
        if (!cfg.get('enabled', true)) return;
        if (!cfg.get('inline.enabled', true)) return;
        if (!engine.ready) return;

        const line = document.lineAt(position.line).text;
        // Only fire after //? triggers (to avoid fighting the user) unless
        // the user explicitly invoked the trigger command.
        const q = buildQueryFromLine(line, document, position);
        const invoked = ctx && ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
        if (!q && !invoked) return;

        let searchText = q ? q.text : '';
        if (!searchText) {
            // Use last ~40 lines as context for invoked mode
            const start = Math.max(0, position.line - 40);
            searchText = document.getText(new vscode.Range(start, 0, position.line, position.character));
        }

        const max = cfg.get('inline.maxItems', 3);
        const hits = engine.query(searchText || ' ', max);
        if (hits.length === 0) return;

        const replaceRange = q
            ? new vscode.Range(position.line, 0, position.line, line.length)
            : new vscode.Range(position, position);

        const items = hits.map(h => {
            const b = h.block;
            const item = new vscode.InlineCompletionItem(b.text, replaceRange);
            item.filterText = line;
            return item;
        });
        return { items };
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

let _registered = false;
let _disposables = [];

function register(context) {
    if (_registered) return;
    _registered = true;

    const sel = { language: LANGUAGE_ID, scheme: 'file' };

    _disposables.push(
        vscode.languages.registerCompletionItemProvider(
            sel, new TplCompletionProvider(),
            '?', '_',  // trigger chars that appear in _TPL_ / //?
        ),
        vscode.languages.registerInlineCompletionItemProvider(
            sel, new TplInlineProvider(),
        ),
    );

    for (const d of _disposables) context.subscriptions.push(d);
}

module.exports = { register, engine, TplCompletionProvider, TplInlineProvider };
