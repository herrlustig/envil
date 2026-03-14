// @ts-nocheck
// codelens-blocks.js
// ─────────────────────────────────────────────────────────────────────────────
// Clickable ▶ Run / ▶ Eval buttons above executable code blocks.
//
// SuperCollider  – outermost  ( … )  blocks where `(` is at the start of a line
// Hydra (JS)     – semicolon-terminated statement chains
//
// The CodeLens approach gives users a click/touch-driven alternative to
// Ctrl+Enter for re-evaluating blocks during a live session.
//
// The *providers* live here (pure parsing, no runtime state).
// The *commands* are registered in extension.js where `io` and `_sc` live.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const vscode = require('vscode');

// ── Command IDs (exported so extension.js can reference them) ──────────────────

const CMD_RUN_SC_BLOCK    = 'envil.runSCBlock';
const CMD_RUN_HYDRA_BLOCK = 'envil.runHydraBlock';

// ── SuperCollider CodeLens provider ────────────────────────────────────────────

class SCBlockCodeLensProvider {
    provideCodeLenses(document) {
        const lenses   = [];
        const text     = document.getText();
        const stripped = stripCommentsAndStrings(text);
        const lines    = stripped.split('\n');
        let offset     = 0;

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const lineText = lines[lineNum];
            const trimmed  = lineText.trimStart();

            if (trimmed.startsWith('(')) {
                const parenCol = lineText.indexOf('(');
                const parenOff = offset + parenCol;
                const closeOff = findMatchingClose(stripped, parenOff);

                if (closeOff !== -1) {
                    const closePos  = document.positionAt(closeOff);
                    const blockCode = text.substring(parenOff, closeOff + 1);

                    // ▶ Run at the opening paren
                    const openRange = new vscode.Range(lineNum, 0, lineNum, 0);
                    lenses.push(new vscode.CodeLens(openRange, {
                        title:     '  ▶  𝗥𝘂𝗻  ━━━━━',
                        tooltip:   'Execute this SC block  (≈ Ctrl+Enter)',
                        command:   CMD_RUN_SC_BLOCK,
                        arguments: [blockCode]
                    }));

                    // ▶ Run at the closing paren (if on a different line)
                    if (closePos.line !== lineNum) {
                        const closeRange = new vscode.Range(closePos.line, 0, closePos.line, 0);
                        lenses.push(new vscode.CodeLens(closeRange, {
                            title:     '  ▶  𝗥𝘂𝗻  ━━━━━',
                            tooltip:   'Execute this SC block  (≈ Ctrl+Enter)',
                            command:   CMD_RUN_SC_BLOCK,
                            arguments: [blockCode]
                        }));
                    }
                }
            }
            offset += lineText.length + 1;   // +1 for the \n
        }

        return lenses;
    }
}

// ── Hydra CodeLens provider ────────────────────────────────────────────────────

class HydraBlockCodeLensProvider {
    provideCodeLenses(document) {
        const lenses = [];
        const text   = document.getText();
        const lines  = text.split('\n');

        // Hydra statements are semicolon-terminated chains that may span
        // multiple lines.  Collect non-comment, non-empty lines into a
        // running accumulator and emit a block whenever we hit `;`.

        let blockLines = [];   // { lineNum, text }
        let blockStart = -1;

        for (let i = 0; i < lines.length; i++) {
            const raw     = lines[i];
            const trimmed = raw.trim();

            // skip blank and comment-only lines outside a block
            if (trimmed === '' || trimmed.startsWith('//')) {
                if (blockLines.length === 0) continue;
                if (trimmed.startsWith('//')) continue;
                continue;
            }

            if (blockStart === -1) blockStart = i;
            blockLines.push({ lineNum: i, text: raw });

            if (trimmed.endsWith(';')) {
                // Complete statement found — create lenses
                if (blockLines.length > 0) {
                    const code = blockLines.map(b => b.text).join('\n');

                    const range = new vscode.Range(blockStart, 0, blockStart, 0);
                    lenses.push(new vscode.CodeLens(range, {
                        title:     '  ▶  𝗘𝘃𝗮𝗹  ━━━━━',
                        tooltip:   'Evaluate this Hydra statement  (≈ Ctrl+Enter)',
                        command:   CMD_RUN_HYDRA_BLOCK,
                        arguments: [code]
                    }));

                    // Also at the end if multi-line
                    const lastLine = blockLines[blockLines.length - 1].lineNum;
                    if (lastLine !== blockStart) {
                        const endRange = new vscode.Range(lastLine, 0, lastLine, 0);
                        lenses.push(new vscode.CodeLens(endRange, {
                            title:     '  ▶  𝗘𝘃𝗮𝗹  ━━━━━',
                            tooltip:   'Evaluate this Hydra statement  (≈ Ctrl+Enter)',
                            command:   CMD_RUN_HYDRA_BLOCK,
                            arguments: [code]
                        }));
                    }
                }
                blockLines = [];
                blockStart = -1;
            }
        }

        return lenses;
    }
}

// ── Helpers (mini SC comment/string stripper – mirrors sc.ts) ──────────────────

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

// ── Public: register providers (commands registered in extension.js) ───────────

function registerBlockCodeLens(context) {
    const scSelector = { language: 'supercollider', scheme: 'file' };
    const jsSelector = { language: 'javascript',    scheme: 'file' };

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(scSelector, new SCBlockCodeLensProvider()),
        vscode.languages.registerCodeLensProvider(jsSelector, new HydraBlockCodeLensProvider())
    );

    console.log('[envil] Block CodeLens registered for SC + Hydra');
}

module.exports = { registerBlockCodeLens, CMD_RUN_SC_BLOCK, CMD_RUN_HYDRA_BLOCK };
