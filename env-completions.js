// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Environment / Dictionary key autocompletion for SuperCollider
//
// When sclang is running, detects variables that hold Environments or
// Dictionaries and offers their keys as completions.
// e.g. typing  e[\  shows all keys of the `e` Environment.
//
// Strategy to minimise sclang calls:
//   - Only queries when the user actually types `varName[\` (on-demand)
//   - Caches results per variable with a TTL (default 8s)
//   - A single lightweight sclang query per variable
// ─────────────────────────────────────────────────────────────────────────────
const vscode = require('vscode');

const LANGUAGE_ID    = 'supercollider';
const MARKER         = '___ENVIL_ENVKEYS___';
const QUERY_TIMEOUT  = 2500;
const CACHE_TTL_MS   = 8000;   // cache keys for 8 seconds

// ── State ────────────────────────────────────────────────────────────────────

let _getSC = null;

// Cache: Map<varName, { keys: string[], ts: number }>
const _keyCache = new Map();

// ── SC query ─────────────────────────────────────────────────────────────────

/**
 * Build SC code that checks if `varName` is an Environment or Dictionary
 * and prints its keys between markers.
 */
function buildKeysQuery(varName) {
    // Safety: only allow simple identifiers to avoid code injection
    return [
        `{`,
        `  var v = ${varName};`,
        `  if(v.isKindOf(Dictionary), {`,
        `    var out = "${MARKER}";`,
        `    v.keys.asSortedList.do{|k|`,
        `      out = out ++ k.asString ++ "\\n";`,
        `    };`,
        `    out = out ++ "${MARKER}";`,
        `    out.postln;`,
        `  }, {`,
        `    ("${MARKER}" ++ "${MARKER}").postln;`,
        `  });`,
        `}.value`,
    ].join(' ');
}

/**
 * Query sclang for the keys of a variable. Returns string[] or null.
 */
async function fetchKeys(varName) {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning() || !sc.queryCode) return null;

    if (sc.addSuppressMarker) sc.addSuppressMarker(MARKER);

    const raw = await sc.queryCode(buildKeysQuery(varName), MARKER, QUERY_TIMEOUT);
    if (raw === null) return null;

    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.length > 0 ? lines.map(l => l.trim()).filter(Boolean) : null;
}

/**
 * Get keys for a variable, using cache when fresh enough.
 */
async function getKeys(varName) {
    const cached = _keyCache.get(varName);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return cached.keys;
    }
    const keys = await fetchKeys(varName);
    if (keys) {
        _keyCache.set(varName, { keys, ts: Date.now() });
    }
    return keys || (cached ? cached.keys : null);
}

// ── Completion Provider ──────────────────────────────────────────────────────

class EnvKeyCompletionProvider {
    async provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text;
        const lineUpToCursor = lineText.substring(0, position.character);

        // Match patterns like:  e[\   or  e[   or  myEnv[\   or  myEnv[
        // Captures: varName, optional backslash, partial key text
        const match = lineUpToCursor.match(/\b([a-zA-Z_]\w*)\[\\?(\w*)$/);
        if (!match) return null;

        const varName = match[1];
        const partial = match[2].toLowerCase();

        // Skip single-char loop variables that are almost never Dictionaries.
        // Keep common env names like e, d, q, etc. available.
        const skipVars = new Set(['i', 'j', 'k', 'n', 'x', 'y', 'z']);
        if (varName.length === 1 && skipVars.has(varName)) return null;

        const keys = await getKeys(varName);
        if (!keys || keys.length === 0) return null;

        // Determine insert range — replace everything after [
        const bracketPos = lineUpToCursor.lastIndexOf('[');

        const items = keys.map(key => {
            const lowerKey = key.toLowerCase();
            if (partial && !lowerKey.startsWith(partial)) return null;

            const item = new vscode.CompletionItem(
                key,
                vscode.CompletionItemKind.Field
            );

            // Replace everything after [ with \key]
            item.range = new vscode.Range(
                position.line, bracketPos + 1,
                position.line, position.character
            );
            item.insertText = '\\' + key + ']';

            item.detail = `${varName}[\\${key}]`;
            item.documentation = new vscode.MarkdownString(
                `Key **\\${key}** in \`${varName}\``
            );
            item.sortText = key;
            // Don't trigger parameterHints after
            item.command = undefined;

            return item;
        }).filter(Boolean);

        return new vscode.CompletionList(items, /* isIncomplete */ false);
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerEnvCompletions(context, { getSC }) {
    _getSC = getSC;

    const sc = _getSC ? _getSC() : null;
    if (sc && sc.addSuppressMarker) sc.addSuppressMarker(MARKER);

    const provider = vscode.languages.registerCompletionItemProvider(
        { language: LANGUAGE_ID, scheme: '*' },
        new EnvKeyCompletionProvider(),
        '[',    // trigger on opening bracket
        '\\'    // trigger on backslash (for e[\  )
    );
    context.subscriptions.push(provider);

    console.log('[envil] Environment/Dictionary key completions registered');
}

/**
 * Clear the key cache (e.g. on sclang restart).
 */
function clearEnvKeyCache() {
    _keyCache.clear();
}

module.exports = { registerEnvCompletions, clearEnvKeyCache };
