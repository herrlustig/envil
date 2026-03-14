// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// ProxySpace autocompletion for SuperCollider
//
// Queries sclang for currentEnvironment.keys when the user types '~'
// and offers them as IntelliSense suggestions.
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');

const LANGUAGE_ID = 'supercollider';
const POLL_INTERVAL_MS = 4000;          // how often to refresh the proxy list
const QUERY_TIMEOUT_MS = 1500;          // max wait for sclang response
const MARKER = '___ENVIL_PROXY_LIST___'; // stdout delimiter

// ── State ────────────────────────────────────────────────────────────────────

let _getSC = null;
let _pollTimer = null;

// Cached proxy info: Map<name, { rate, numChannels }>
let _proxyCache = new Map();

// ── SC query ─────────────────────────────────────────────────────────────────

/**
 * Ask sclang for the current ProxySpace keys + basic info.
 * Returns an array of { name, rate, numChannels } or null on failure.
 *
 * The SC code:
 *  - Guards against non-ProxySpace environments
 *  - Collects each key with its rate and numChannels
 *  - Prints the result between markers as  name|rate|numCh\n  per entry
 */
function buildQuery() {
    // SC code that prints proxy info between markers
    return [
        `if(currentEnvironment.isKindOf(ProxySpace), {`,
        `  var out = "${MARKER}";`,
        `  currentEnvironment.envir.keysValuesDo{|k,v|`,
        `    var rate = try { v.rate ? "?" } { "?" };`,
        `    var nc = try { v.numChannels ? "?" } { "?" };`,
        `    out = out ++ k ++ "|" ++ rate ++ "|" ++ nc ++ "\\n";`,
        `  };`,
        `  out = out ++ "${MARKER}";`,
        `  out.postln;`,
        `}, {`,
        `  ("${MARKER}" ++ "${MARKER}").postln;`,  // empty response
        `})`,
    ].join(' ');
}

async function pollProxies() {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning() || !sc.queryCode) return;

    // Ensure marker is suppressed from Post Window (safe to call repeatedly)
    if (sc.addSuppressMarker) sc.addSuppressMarker(MARKER);

    const raw = await sc.queryCode(buildQuery(), MARKER, QUERY_TIMEOUT_MS);
    if (raw === null) return;  // timeout or not running

    const newCache = new Map();
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 1) continue;
        const name = parts[0].trim();
        if (!name) continue;
        const rate = (parts[1] || '?').trim();
        const numChannels = (parts[2] || '?').trim();
        newCache.set(name, { rate, numChannels });
    }
    _proxyCache = newCache;
}

// ── Completion Provider ──────────────────────────────────────────────────────

class ProxyCompletionProvider {
    provideCompletionItems(document, position) {
        // Only trigger after '~' — check the text before cursor
        const lineText = document.lineAt(position).text;

        // If triggered mid-word after ~, get the partial text for filtering
        const lineUpToCursor = lineText.substring(0, position.character);
        const tildeMatch = lineUpToCursor.match(/~(\w*)$/);
        if (!tildeMatch) return new vscode.CompletionList([], false);

        const partial = tildeMatch[1].toLowerCase();

        if (_proxyCache.size === 0) {
            // Trigger an immediate poll if we have nothing cached
            pollProxies();
            return new vscode.CompletionList([], false);
        }

        const items = [];
        for (const [name, info] of _proxyCache) {
            const lowerName = name.toLowerCase();
            if (partial && !lowerName.startsWith(partial)) continue;

            const item = new vscode.CompletionItem(
                '~' + name,
                vscode.CompletionItemKind.Variable
            );

            // The text to insert (replace the ~prefix already typed)
            const tildePos = position.character - tildeMatch[0].length;
            item.range = new vscode.Range(
                position.line, tildePos,
                position.line, position.character
            );
            item.insertText = '~' + name;

            // Detail line shown next to the item
            const rateLabel = info.rate === 'control' ? 'kr'
                            : info.rate === 'audio' ? 'ar'
                            : info.rate;
            item.detail = `${rateLabel}(${info.numChannels})`;

            // Documentation shown in the detail pane
            item.documentation = new vscode.MarkdownString(
                `**~${name}** — NodeProxy\n\n` +
                `- Rate: \`${info.rate}\`\n` +
                `- Channels: \`${info.numChannels}\``
            );

            // Sort by name
            item.sortText = name;

            items.push(item);
        }

        // Return a CompletionList; when empty, the suggest widget
        // closes immediately and Copilot inline suggestions can appear.
        return new vscode.CompletionList(items, false);
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerProxyCompletions(context, { getSC }) {
    _getSC = getSC;

    // Tell sc.ts to suppress our marker from the Post Window
    const sc = _getSC ? _getSC() : null;
    if (sc && sc.addSuppressMarker) sc.addSuppressMarker(MARKER);

    // Register the completion provider for ~ trigger
    const provider = vscode.languages.registerCompletionItemProvider(
        { language: LANGUAGE_ID, scheme: '*' },
        new ProxyCompletionProvider(),
        '~'   // trigger character
    );
    context.subscriptions.push(provider);

    // Start polling once sclang is likely running (poll is safe when not running)
    _pollTimer = setInterval(pollProxies, POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(_pollTimer) });

    // Also poll immediately on certain events
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === LANGUAGE_ID) {
                pollProxies();
            }
        })
    );

    console.log('[envil] ProxySpace completions registered');
}

module.exports = { registerProxyCompletions };
