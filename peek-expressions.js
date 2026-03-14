// @ts-nocheck
// peek-expressions.js
//
// Parses Hydra code to extract arrow-function expressions and label them
// with their method name + parameter name context.
//
// Example:
//   osc(10, 0.1, () => a.fft[0] * 2).rotate(() => time * 0.1, 0.5).out()
//
// Produces:
//   [ { expr: 'a.fft[0] * 2',  label: 'osc › offset',    code: '() => a.fft[0] * 2' },
//     { expr: 'time * 0.1',    label: 'rotate › angle',   code: '() => time * 0.1'   } ]

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PARAM NAME LOOKUP TABLE
// ─────────────────────────────────────────────────────────────────────────────
// Standalone data module — no vscode dependency, safe for testing.

const { HYDRA_PARAM_NAMES } = require('./hydra-params');

/** @type {Map<string, string[]>} method name → ['param0', 'param1', ...] */
const PARAM_TABLE = new Map(Object.entries(HYDRA_PARAM_NAMES));

// ─────────────────────────────────────────────────────────────────────────────
// ARROW-FUNCTION FINDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all arrow-function expressions in a Hydra code string.
 * Returns objects with { expr, label, code }.
 *
 * Strategy:
 * 1. Scan for `=>` tokens (outside strings)
 * 2. Walk back to find the opening `(` or `,` of the arrow param list
 * 3. Walk forward to find the arrow body expression
 * 4. Walk back further to find the enclosing `.method(` or `source(`
 * 5. Count commas to determine parameter index
 * 6. Look up method + param name in PARAM_TABLE
 */
function extractExpressions(code) {
    const results = [];

    // Remove single-line comments but preserve positions (replace with spaces)
    const cleaned = code.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));

    // Find all arrow tokens  `=>`
    const arrowRe = /=>/g;
    let match;

    while ((match = arrowRe.exec(cleaned)) !== null) {
        const arrowPos = match.index;

        // ── Extract the arrow body ──────────────────────────────────────
        let bodyStart = arrowPos + 2;
        // Skip whitespace
        while (bodyStart < cleaned.length && /\s/.test(cleaned[bodyStart])) bodyStart++;

        let bodyEnd;
        if (cleaned[bodyStart] === '{') {
            // Block body: { ... } — find matching close brace
            bodyEnd = findMatchingClose(cleaned, bodyStart, '{', '}');
            if (bodyEnd < 0) continue;
            // Extract inner content (strip braces), look for return statement
            let inner = cleaned.slice(bodyStart + 1, bodyEnd).trim();
            // Strip trailing semicolons
            if (inner.endsWith(';')) inner = inner.slice(0, -1).trim();
            // Strip `return ` prefix
            if (inner.startsWith('return ')) inner = inner.slice(7).trim();
            var exprText = inner;
            var fullCode = cleaned.slice(findArrowParamStart(cleaned, arrowPos), bodyEnd + 1).trim();
        } else {
            // Expression body: scan forward, respecting nested parens/brackets
            bodyEnd = scanExpressionEnd(cleaned, bodyStart);
            exprText = cleaned.slice(bodyStart, bodyEnd).trim();
            fullCode = cleaned.slice(findArrowParamStart(cleaned, arrowPos), bodyEnd).trim();
        }

        if (!exprText) continue;

        // ── Find enclosing method call context ──────────────────────────
        const ctx = findCallContext(cleaned, arrowPos);

        let label;
        if (ctx) {
            const paramNames = PARAM_TABLE.get(ctx.method);
            const paramName = paramNames && paramNames[ctx.argIndex]
                ? paramNames[ctx.argIndex]
                : `arg${ctx.argIndex}`;
            label = `${ctx.method} › ${paramName}`;
        } else {
            label = exprText.length > 20 ? exprText.slice(0, 18) + '…' : exprText;
        }

        results.push({ expr: exprText, label, code: fullCode });
    }

    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the start of arrow function params by walking backwards from `=>`.
 * Handles: `() =>`, `(x) =>`, `x =>`, `({time}) =>`
 */
function findArrowParamStart(code, arrowPos) {
    let i = arrowPos - 1;
    // Skip whitespace before =>
    while (i >= 0 && /\s/.test(code[i])) i--;

    if (i < 0) return arrowPos;

    if (code[i] === ')') {
        // Parenthesised params — find matching (
        let depth = 1;
        i--;
        while (i >= 0 && depth > 0) {
            if (code[i] === ')') depth++;
            else if (code[i] === '(') depth--;
            i--;
        }
        return i + 1;
    } else {
        // Bare identifier param:  x =>
        while (i >= 0 && /[\w$]/.test(code[i])) i--;
        return i + 1;
    }
}

/**
 * Find matching closing bracket starting from an opening bracket.
 */
function findMatchingClose(code, start, open, close) {
    let depth = 1;
    for (let i = start + 1; i < code.length; i++) {
        if (code[i] === open) depth++;
        else if (code[i] === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/**
 * Scan forward from `start` to find the end of an expression body.
 * Stops at `)`, `,`, or `]` at depth 0 (i.e. the enclosing call boundary).
 */
function scanExpressionEnd(code, start) {
    let depth = 0;       // () depth
    let sqDepth = 0;     // [] depth
    let brDepth = 0;     // {} depth
    let i = start;

    while (i < code.length) {
        const ch = code[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            if (depth === 0) return i; // enclosing call's closing paren
            depth--;
        }
        else if (ch === '[') sqDepth++;
        else if (ch === ']') {
            if (sqDepth === 0) return i;
            sqDepth--;
        }
        else if (ch === '{') brDepth++;
        else if (ch === '}') {
            if (brDepth === 0) return i;
            brDepth--;
        }
        else if (ch === ',' && depth === 0 && sqDepth === 0 && brDepth === 0) {
            return i;
        }
        i++;
    }
    return i;
}

/**
 * Walk backwards from an arrow-function position to find the enclosing
 * `.method(` or `source(` call, and count commas to determine arg index.
 *
 * Returns { method: string, argIndex: number } or null.
 */
function findCallContext(code, arrowPos) {
    // Walk backwards to find the opening `(` of the enclosing call
    let depth = 0;
    let commas = 0;
    let i = arrowPos - 1;

    // First skip past the arrow param list
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (i >= 0 && code[i] === ')') {
        // Skip (params)
        let d = 1;
        i--;
        while (i >= 0 && d > 0) {
            if (code[i] === ')') d++;
            else if (code[i] === '(') d--;
            i--;
        }
    } else {
        // Skip bare param identifier
        while (i >= 0 && /[\w$]/.test(code[i])) i--;
    }

    // Now walk backwards through the enclosing call args
    while (i >= 0) {
        const ch = code[i];

        if (ch === ')' || ch === ']') {
            // Skip nested call / bracket
            const close = ch;
            const open = ch === ')' ? '(' : '[';
            let d = 1;
            i--;
            while (i >= 0 && d > 0) {
                if (code[i] === close) d++;
                else if (code[i] === open) d--;
                i--;
            }
            continue;
        }

        if (ch === '(') {
            if (depth === 0) {
                // This is the opening paren of the enclosing call
                // Now extract the method name before it
                let nameEnd = i;
                i--;
                // Skip whitespace
                while (i >= 0 && /\s/.test(code[i])) i--;
                // Collect identifier
                let nameStart = i;
                while (nameStart >= 0 && /[\w$]/.test(code[nameStart])) nameStart--;
                nameStart++;
                const method = code.slice(nameStart, nameEnd).trim();
                if (method) {
                    return { method, argIndex: commas };
                }
                return null;
            }
            depth--;
            i--;
            continue;
        }

        if (ch === ')') {
            depth++;
            i--;
            continue;
        }

        if (ch === ',' && depth === 0) {
            commas++;
            i--;
            continue;
        }

        i--;
    }

    return null;
}

module.exports = { extractExpressions, PARAM_TABLE };
