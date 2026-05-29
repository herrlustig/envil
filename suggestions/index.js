// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Entry point for the offline suggestion system.
//
// Wires:
//   - corpus indexing (build, load, reindex command)
//   - completion + inline providers
//   - optional Ollama-backed "compose at cursor" command (FIM)
//   - status-bar indicator
//
// Enable via  envil.corpusSuggestor.enabled  (default: true).
// Directories to index are listed in  envil.corpusSuggestor.sources  (paths or globs).
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vscode = require('vscode');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const corpus = require('./corpus');
const providers = require('./providers');
const ollama = require('./ollama');

let _statusBar = null;
let _cacheDir = null;

function getCfg() { return vscode.workspace.getConfiguration('envil.corpusSuggestor'); }

// ── Source resolution ────────────────────────────────────────────────────────
//
// Default sources = every open workspace folder. Extra paths can be added via
// the `envil.corpusSuggestor.sources` setting; `~` and env vars are expanded.

function expandPath(p) {
    if (!p) return p;
    let out = p;
    if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
    out = out.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] || '');
    return out;
}

function resolveSources() {
    const cfg = getCfg();
    const extra = (cfg.get('sources', []) || []).map(expandPath).filter(Boolean);
    const workspaceRoots = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const seen = new Set();
    const out = [];
    for (const p of [...workspaceRoots, ...extra]) {
        if (!p || seen.has(p)) continue;
        if (!fs.existsSync(p)) continue;
        seen.add(p);
        out.push(p);
    }
    return out;
}

// Also try to locate the SuperCollider help/examples dir
function resolveSCHelpSources() {
    const cfg = getCfg();
    if (!cfg.get('includeSCHelp', true)) return [];
    const explicit = expandPath(cfg.get('scHelpPath', ''));
    const candidates = [
        explicit,
        '/usr/share/SuperCollider/HelpSource',
        '/usr/local/share/SuperCollider/HelpSource',
        '/usr/share/SuperCollider/SCClassLibrary',
        '/usr/local/share/SuperCollider/SCClassLibrary',
        path.join(os.homedir(), '.local/share/SuperCollider/Extensions'),
    ].filter(Boolean);
    return candidates.filter(p => fs.existsSync(p));
}

// ── Status bar ───────────────────────────────────────────────────────────────

function createStatusBar(context) {
    _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9000);
    _statusBar.command = 'envil.corpusSuggestor.reindex';
    _statusBar.tooltip = 'Envil offline suggestions — click to rebuild the index';
    context.subscriptions.push(_statusBar);
    updateStatusBar('idle', 0);
    _statusBar.show();
}

function updateStatusBar(state, n) {
    if (!_statusBar) return;
    if (state === 'indexing')      _statusBar.text = `$(sync~spin) envil-corpus indexing…`;
    else if (state === 'loaded')   _statusBar.text = `$(lightbulb) envil-corpus ${n}`;
    else if (state === 'idle')     _statusBar.text = `$(lightbulb) envil-corpus 0`;
    else if (state === 'llm')      _statusBar.text = `$(sync~spin) envil-corpus LLM…`;
    else                           _statusBar.text = `$(lightbulb) envil-corpus`;
}

// ── Indexing ─────────────────────────────────────────────────────────────────

async function reindex() {
    if (!_cacheDir) return { ok: false, count: 0 };
    updateStatusBar('indexing', 0);
    return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Envil: indexing suggestion corpus' },
        async () => {
            try {
                const userRoots = resolveSources();
                const helpRoots = resolveSCHelpSources();
                const cfg = getCfg();
                const includeHidden = cfg.get('includeHiddenJamsDirs', true);

                const blocks = [];
                blocks.push(...corpus.buildCorpus(userRoots, { label: 'user' }));
                if (helpRoots.length) {
                    blocks.push(...corpus.buildCorpus(helpRoots, { label: 'sc-help' }));
                }

                corpus.saveIndex(_cacheDir, blocks, {
                    sources: userRoots, helpSources: helpRoots, includeHidden,
                });
                providers.engine.load({ blocks, version: corpus.INDEX_VERSION });
                updateStatusBar('loaded', blocks.length);
                return { ok: true, count: blocks.length };
            } catch (e) {
                console.error('[envil-corpus] reindex failed:', e);
                vscode.window.showErrorMessage(`Envil corpus: reindex failed: ${e.message}`);
                updateStatusBar('idle', 0);
                return { ok: false, count: 0, error: e };
            }
        }
    );
}

function loadPersistedIndex() {
    const data = corpus.loadIndex(_cacheDir);
    if (data) {
        const n = providers.engine.load(data);
        updateStatusBar('loaded', n);
        return n;
    }
    return 0;
}

// ── Compose at cursor (Ollama FIM) ───────────────────────────────────────────

async function composeAtCursor() {
    const cfg = getCfg();
    if (!cfg.get('llm.enabled', false)) {
        vscode.window.showInformationMessage(
            'Envil LLM is disabled. Set "envil.corpusSuggestor.llm.enabled" to true and run an Ollama server.'
        );
        return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'supercollider') return;

    const endpoint = cfg.get('llm.endpoint', 'http://localhost:11434');
    const model    = cfg.get('llm.model', 'qwen2.5-coder:3b-base');

    updateStatusBar('llm', 0);
    const available = await ollama.isAvailable(endpoint);
    if (!available) {
        updateStatusBar('loaded', providers.engine.blocks.length);
        vscode.window.showErrorMessage(
            `Ollama not reachable at ${endpoint}. Start it or set "envil.corpusSuggestor.llm.endpoint".`
        );
        return;
    }

    const doc = editor.document;
    const pos = editor.selection.active;
    const fullText = doc.getText();
    const offset   = doc.offsetAt(pos);
    const maxCtx   = cfg.get('llm.contextChars', 4000);
    const prefix   = fullText.slice(Math.max(0, offset - maxCtx), offset);
    const suffix   = fullText.slice(offset, Math.min(fullText.length, offset + maxCtx));

    // Build RAG context from the corpus: query with prefix+suffix, take top-3
    let ragContext = '';
    if (cfg.get('llm.useRAG', true) && providers.engine.ready) {
        const hits = providers.engine.query(prefix + ' ' + suffix, 3);
        ragContext = hits.map(h => {
            const b = h.block;
            const tag = `// from ${b.sourceLabel}${b.dateHint ? ' (' + b.dateHint + ')' : ''}`;
            return `${tag}\n${b.text}`;
        }).join('\n\n');
    }

    try {
        // If the current line is a //? comment, route to chat mode (explicit prompt)
        const line = doc.lineAt(pos.line).text;
        const promptMatch = line.match(/^\s*\/\/\s*\?{1,2}\s*(.*)$/);

        let code = '';
        if (promptMatch && promptMatch[1].trim()) {
            // Replace the //? line with generated code
            const prompt = promptMatch[1].trim();
            code = await ollama.generateChat({
                endpoint, model, prompt, ragContext,
                temperature: cfg.get('llm.temperature', 0.3),
                numPredict:  cfg.get('llm.numPredict', 400),
            });
            if (!code) throw new Error('empty response');
            await editor.edit(e => {
                const lineRange = doc.lineAt(pos.line).range;
                e.replace(lineRange, code);
            });
        } else {
            // FIM at cursor
            code = await ollama.generateFIM({
                endpoint, model, prefix, suffix, ragContext,
                temperature: cfg.get('llm.temperature', 0.2),
                numPredict:  cfg.get('llm.numPredict', 256),
            });
            if (!code) throw new Error('empty response');
            await editor.edit(e => e.insert(pos, code));
        }

        updateStatusBar('loaded', providers.engine.blocks.length);
    } catch (e) {
        updateStatusBar('loaded', providers.engine.blocks.length);
        // Graceful fallback: paste the top BM25 hit from the corpus so the
        // user still gets something useful when Ollama is unreachable / slow.
        const fallbackInserted = await tryBM25Fallback(editor, doc, pos);
        if (fallbackInserted) {
            vscode.window.showWarningMessage(
                `Envil LLM failed (${e.message}). Pasted top corpus match instead.`
            );
        } else {
            vscode.window.showErrorMessage(`Envil LLM compose failed: ${e.message}`);
        }
    }
}

// Drop in the top BM25 hit at the cursor as a graceful fallback.
async function tryBM25Fallback(editor, doc, pos) {
    try {
        if (!providers.engine.ready) return false;
        const line = doc.lineAt(pos.line).text;
        const promptMatch = line.match(/^\s*\/\/\s*\?{1,2}\s*(.*)$/);
        const queryText = promptMatch && promptMatch[1].trim()
            ? promptMatch[1].trim()
            : doc.getText(new vscode.Range(
                  new vscode.Position(Math.max(0, pos.line - 40), 0), pos));
        const hits = providers.engine.query(queryText || ' ', 1);
        if (!hits.length) return false;
        const block = hits[0].block;
        await editor.edit(e => {
            if (promptMatch) {
                e.replace(doc.lineAt(pos.line).range, block.text);
            } else {
                e.insert(pos, block.text);
            }
        });
        return true;
    } catch (_e) { return false; }
}

// ── Public: activate ─────────────────────────────────────────────────────────

function activate(context) {
    // Always use global storage. The corpus is shared across every workspace
    // so that opening a small/new SC project still benefits from the user's
    // accumulated body of code. See README § Experimental features.
    _cacheDir = context.globalStorageUri.fsPath;
    try { fs.mkdirSync(_cacheDir, { recursive: true }); } catch (_e) {}

    // One-shot migration: drop any legacy caches.
    //   - old location: <ext>/data/suggestions-index.json (pre-storageUri)
    //   - intermediate: context.storageUri (per-workspace; fragmented)
    try {
        const legacy = path.join(context.extensionPath, 'data', 'suggestions-index.json');
        if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    } catch (_e) { /* ignore */ }
    try {
        if (context.storageUri) {
            const ws = path.join(context.storageUri.fsPath, 'suggestions-index.json');
            if (fs.existsSync(ws)) fs.unlinkSync(ws);
        }
    } catch (_e) { /* ignore */ }

    createStatusBar(context);

    // Load any persisted index immediately (fast)
    loadPersistedIndex();

    // Register providers
    providers.register(context);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('envil.corpusSuggestor.reindex', async () => {
            const r = await reindex();
            if (r.ok) {
                vscode.window.showInformationMessage(`Envil corpus: indexed ${r.count} blocks.`);
            }
        }),

        vscode.commands.registerCommand('envil.corpusSuggestor.showStats', () => {
            const n = providers.engine.blocks.length;
            const kinds = {};
            for (const b of providers.engine.blocks) kinds[b.kind] = (kinds[b.kind] || 0) + 1;
            const kindStr = Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(', ');
            vscode.window.showInformationMessage(
                `Envil corpus: ${n} blocks. ${kindStr || '(none)'}`
            );
        }),

        vscode.commands.registerCommand('envil.corpusSuggestor.composeAtCursor', composeAtCursor),

        vscode.commands.registerCommand('envil.corpusSuggestor.triggerInline', async () => {
            await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        }),

        vscode.commands.registerCommand('envil.corpusSuggestor.revealCache', async () => {
            if (!_cacheDir) {
                vscode.window.showWarningMessage('Envil corpus: cache directory not initialised yet.');
                return;
            }
            try { fs.mkdirSync(_cacheDir, { recursive: true }); } catch (_e) {}
            const indexFile = path.join(_cacheDir, 'suggestions-index.json');
            const target = fs.existsSync(indexFile)
                ? vscode.Uri.file(indexFile)
                : vscode.Uri.file(_cacheDir);
            await vscode.commands.executeCommand('revealFileInOS', target);
        }),
    );

    // Auto-index on first activation if the index is empty
    if (!providers.engine.ready) {
        const cfg = getCfg();
        if (cfg.get('indexOnStartup', true)) {
            // Fire-and-forget; don't block activation
            setTimeout(() => { reindex(); }, 2000);
        }
    }

    // Re-index on workspace folder changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { reindex(); }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('envil.corpusSuggestor.sources') ||
                e.affectsConfiguration('envil.corpusSuggestor.includeSCHelp') ||
                e.affectsConfiguration('envil.corpusSuggestor.scHelpPath')) {
                reindex();
            }
        }),
    );

    console.log('[envil-corpus] suggestion system activated.');
}

function deactivate() { /* nothing persistent to clean */ }

module.exports = { activate, deactivate, reindex };
