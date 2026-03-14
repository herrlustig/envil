// @ts-nocheck
// hover-slider.js
// ─────────────────────────────────────────────────────────────────────────────
// Interactive number hover-slider for live-coding.
// Works uniformly with Hydra (JavaScript) and SuperCollider files.
//
// • Hover over any number → visual dot-slider + clickable ± step buttons
// • Ctrl+Shift+↑↓         → keyboard nudge (coarse)
// • Ctrl+Alt+↑↓           → keyboard nudge (fine)
//
// All command links encode a `hintChar` (approximate character position) rather
// than exact start/end offsets.  The adjust handler re-discovers the actual
// number at that location, so edits that change the number's length (integer →
// float, sign changes, etc.) never cause stale-position bugs.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const vscode = require('vscode');

// ── Command IDs ────────────────────────────────────────────────────────────────

const CMD_ADJUST          = 'envil.numberAdjust';
const CMD_NUDGE_UP        = 'envil.numberNudgeUp';
const CMD_NUDGE_DOWN      = 'envil.numberNudgeDown';
const CMD_NUDGE_UP_FINE   = 'envil.numberNudgeUpFine';
const CMD_NUDGE_DOWN_FINE = 'envil.numberNudgeDownFine';

const CMD_EVAL_HYDRA = 'envil.hydra.evaluate';
const CMD_EVAL_SC    = 'envil.supercollider.executeBlock';

// ── Hover Provider ─────────────────────────────────────────────────────────────

class NumberHoverProvider {
    provideHover(document, position) {
        const range = findNumberRange(document, position);
        if (!range) return null;

        const numStr = document.getText(range);
        const value  = parseFloat(numStr);
        if (isNaN(value)) return null;

        const steps  = computeSteps(numStr, value);
        const langId = document.languageId;          // 'javascript' | 'supercollider'
        return new vscode.Hover(
            buildSliderMarkdown(numStr, value, range, steps, langId),
            range
        );
    }
}

// ── Number detection ───────────────────────────────────────────────────────────

/**
 * Find the Range of the number literal at `position`.
 * Handles integers, floats, and (contextual) negative numbers.
 */
function findNumberRange(document, position) {
    let range = document.getWordRangeAtPosition(position, /\d+(?:\.\d+)?/);
    if (!range) return null;

    // Include a leading minus when it's a negative sign (not subtraction)
    const start = range.start.character;
    if (start > 0) {
        const before = document.getText(
            new vscode.Range(range.start.line, start - 1, range.start.line, start)
        );
        if (before === '-') {
            const twoBack = start >= 2
                ? document.getText(
                      new vscode.Range(range.start.line, start - 2, range.start.line, start - 1)
                  )
                : '';
            if (twoBack === '' || /[(\[{,=+\-*/<>!&|%^~:;\s]/.test(twoBack)) {
                range = new vscode.Range(
                    range.start.line, start - 1,
                    range.end.line,   range.end.character
                );
            }
        }
    }
    return range;
}

/**
 * Re-discover the number near `hintChar` on `line`.
 * Tolerates ±6 chars of drift from edits that changed the number's length.
 */
function findNumberNear(document, line, hintChar) {
    const lineLen = document.lineAt(line).text.length;
    const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
    for (const off of offsets) {
        const ch = hintChar + off;
        if (ch < 0 || ch >= lineLen) continue;
        const range = findNumberRange(document, new vscode.Position(line, ch));
        if (range) return range;
    }
    return null;
}

// ── Step-size computation ──────────────────────────────────────────────────────

function computeSteps(numStr, value) {
    const dec = decimalCount(numStr);
    if (dec === 0) {
        const abs = Math.abs(value);
        if (abs <= 5)   return [0.1, 1, 5, 10];
        if (abs <= 20)  return [1, 5, 10, 50];
        if (abs <= 100) return [1, 10, 50, 100];
        return [10, 50, 100, 500];
    }
    if (dec >= 3) return [0.001, 0.01, 0.1, 1];
    if (dec === 2) return [0.01, 0.1, 0.5, 1];
    /* dec === 1 */   return [0.01, 0.1, 0.5, 1];
}

/** Smart default delta for keyboard nudging. */
function smartDelta(numStr, direction, fine) {
    const dec = decimalCount(numStr);
    let step;
    if (dec === 0) {
        const abs = Math.abs(parseFloat(numStr));
        step = abs <= 10 ? (fine ? 1 : 5) : (fine ? 1 : 10);
    } else if (dec >= 3) {
        step = fine ? 0.001 : 0.01;
    } else {
        step = fine ? 0.01 : 0.1;
    }
    return step * direction;
}

// ── Slider-range computation ───────────────────────────────────────────────────

/**
 * Compute an array of ~11 evenly-spaced "stop" values for the visual slider
 * bar, spanning a sensible range around `value`.
 */
function computeSliderStops(value) {
    const abs   = Math.abs(value);
    const count = 10;                           // → 11 stops (0 … count)
    let half;

    if (abs <= 1)        half = 1;
    else if (abs <= 5)   half = 5;
    else if (abs <= 10)  half = 10;
    else if (abs <= 50)  half = 50;
    else if (abs <= 100) half = 100;
    else if (abs <= 500) half = 500;
    else                 half = Math.pow(10, Math.floor(Math.log10(abs)) + 1);

    let min, max;
    if (value >= 0) { min = 0;     max = half; }
    else            { min = -half;  max = 0;    }

    const stops = [];
    for (let i = 0; i <= count; i++) {
        const v = min + (max - min) * i / count;
        stops.push(Math.round(v * 10000) / 10000);     // avoid float drift
    }
    return { stops, min, max };
}

// ── Hover markdown builder ─────────────────────────────────────────────────────

function buildSliderMarkdown(numStr, value, range, steps, langId) {
    const hintChar = Math.floor(
        (range.start.character + range.end.character) / 2
    );
    const line = range.start.line;

    // Determine which eval command to offer
    const evalCmd = langId === 'javascript'    ? CMD_EVAL_HYDRA
                  : langId === 'supercollider' ? CMD_EVAL_SC
                  : null;

    const md = new vscode.MarkdownString();
    const trustedCmds = [CMD_ADJUST];
    if (evalCmd) trustedCmds.push(evalCmd);
    md.isTrusted = { enabledCommands: trustedCmds };
    md.supportHtml = true;

    // ── Header
    md.appendMarkdown(`**🎛 \`${numStr}\`** &nbsp; hover slider\n\n`);

    // ── Visual dot-slider bar
    const { stops, min, max } = computeSliderStops(value);
    const bar = buildSliderBar(stops, value, line, hintChar);
    md.appendMarkdown(`\`${fmtVal(min)}\` ${bar} \`${fmtVal(max)}\`\n\n`);

    // ── Step buttons  ← decrease | increase →
    const neg = steps.slice().reverse()
        .map(s => stepLink(-s, line, hintChar))
        .join('&nbsp;');
    const pos = steps
        .map(s => stepLink(s, line, hintChar))
        .join('&nbsp;');
    md.appendMarkdown(`${neg} &nbsp;**│**&nbsp; ${pos}\n\n`);

    // ── Re-evaluate button
    if (evalCmd) {
        const evalLabel = langId === 'javascript' ? '▶ Eval Hydra' : '▶ Eval SC';
        md.appendMarkdown(`[**${evalLabel}**](command:${evalCmd}) &nbsp;`);
    }

    md.appendMarkdown(`---\n`);
    md.appendMarkdown(`*Ctrl+Shift+↑↓ nudge &nbsp;·&nbsp; Ctrl+Alt+↑↓ fine*`);

    return md;
}

/** Render the clickable dot-slider bar. */
function buildSliderBar(stops, currentValue, line, hintChar) {
    // Find the stop closest to the current value
    let closestIdx  = 0;
    let closestDist = Infinity;
    for (let i = 0; i < stops.length; i++) {
        const d = Math.abs(stops[i] - currentValue);
        if (d < closestDist) { closestDist = d; closestIdx = i; }
    }

    return stops.map((stop, i) => {
        const active = (i === closestIdx);
        const dot    = active ? '**⬤**' : '◦';
        const args   = encodeURIComponent(JSON.stringify({
            line, hintChar, targetValue: stop
        }));
        // tooltip shows the stop's exact value
        return `[${dot}](command:${CMD_ADJUST}?${args} "${fmtVal(stop)}")`;
    }).join('');
}

/** Format a value for display (compact, no trailing zeros). */
function fmtVal(v) {
    if (Number.isInteger(v)) return v.toString();
    return parseFloat(v.toFixed(4)).toString();
}

/** Build a command-link for a relative ±step button. */
function stepLink(delta, line, hintChar) {
    const sign  = delta > 0 ? '+' : '−';
    const label = `${sign}${Math.abs(delta)}`;
    const args  = encodeURIComponent(JSON.stringify({
        line, hintChar, delta
    }));
    return `[**${label}**](command:${CMD_ADJUST}?${args})`;
}

// ── Core edit logic ────────────────────────────────────────────────────────────

/**
 * Re-discover the number near `hintChar`, apply a delta or set an absolute
 * target value, and write the result back to the document.
 *
 * @returns {{ oldValue: number, newStr: string } | null}
 */
async function doAdjust(editor, line, hintChar, delta, targetValue) {
    const range = findNumberNear(editor.document, line, hintChar);
    if (!range) return null;

    const numStr = editor.document.getText(range);
    const oldVal = parseFloat(numStr);
    if (isNaN(oldVal)) return null;

    // Compute the actual delta and the reference decimal precision
    let actualDelta, decRef;
    if (targetValue !== undefined) {
        actualDelta = targetValue - oldVal;
        decRef      = decimalCount(fmtVal(targetValue));
    } else {
        actualDelta = delta;
        decRef      = decimalCount(Math.abs(delta).toString());
    }

    if (Math.abs(actualDelta) < 1e-10) return null;    // no change

    const newVal  = oldVal + actualDelta;
    const origDec = decimalCount(numStr);
    const newStr  = formatNumber(newVal, origDec, decRef);

    const ok = await editor.edit(eb => eb.replace(range, newStr));
    return ok ? { oldValue: oldVal, newStr } : null;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

/** Count decimal places in a numeric string. */
function decimalCount(numStr) {
    const s   = numStr.toString();
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Format `value` keeping at least `origDec` decimal places (so the user's
 * style is preserved), but allowing `deltaDec` when the step demands finer
 * precision.
 */
function formatNumber(value, origDec, deltaDec) {
    const maxDec  = Math.max(origDec, deltaDec);
    const factor  = Math.pow(10, maxDec);
    const rounded = Math.round(value * factor) / factor;

    if (maxDec === 0) return rounded.toString();

    let str = rounded.toFixed(maxDec);

    // Trim trailing zeros, but keep at least `origDec` decimals
    while (
        str.includes('.') &&
        str.endsWith('0') &&
        str.split('.')[1].length > origDec
    ) {
        str = str.slice(0, -1);
    }
    if (str.endsWith('.')) str = str.slice(0, -1);

    return str;
}

// ── Public: register everything ────────────────────────────────────────────────

function registerHoverSlider(context) {

    // --- Hover providers for JS (Hydra) and SuperCollider --------------------
    const jsSelector = { language: 'javascript',    scheme: 'file' };
    const scSelector = { language: 'supercollider', scheme: 'file' };

    context.subscriptions.push(
        vscode.languages.registerHoverProvider(jsSelector,  new NumberHoverProvider()),
        vscode.languages.registerHoverProvider(scSelector, new NumberHoverProvider())
    );

    // --- Adjust command (called from hover links) ----------------------------
    //     Accepts { line, hintChar, delta } or { line, hintChar, targetValue }
    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_ADJUST, async (args) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !args) return;
            const r = await doAdjust(
                editor, args.line, args.hintChar, args.delta, args.targetValue
            );
            if (r) {
                vscode.window.setStatusBarMessage(`🎛 ${r.oldValue} → ${r.newStr}`, 2000);
            }
        })
    );

    // --- Keyboard nudge commands ---------------------------------------------
    const registerNudge = (cmdId, direction, fine) =>
        vscode.commands.registerTextEditorCommand(cmdId, async (editor) => {
            const pos   = editor.selection.active;
            const range = findNumberRange(editor.document, pos);
            if (!range) {
                vscode.window.setStatusBarMessage('🎛 no number under cursor', 1500);
                return;
            }
            const numStr   = editor.document.getText(range);
            const delta    = smartDelta(numStr, direction, fine);
            const hintChar = Math.floor(
                (range.start.character + range.end.character) / 2
            );
            const r = await doAdjust(
                editor, range.start.line, hintChar, delta, undefined
            );
            if (r) {
                vscode.window.setStatusBarMessage(`🎛 ${r.oldValue} → ${r.newStr}`, 2000);
            }
        });

    context.subscriptions.push(
        registerNudge(CMD_NUDGE_UP,        +1, false),
        registerNudge(CMD_NUDGE_DOWN,      -1, false),
        registerNudge(CMD_NUDGE_UP_FINE,   +1, true),
        registerNudge(CMD_NUDGE_DOWN_FINE, -1, true)
    );

    console.log('[envil] Hover-slider registered for JS + SuperCollider');
}

module.exports = { registerHoverSlider };
