/* knob-proxy.js  —  Hydra-side proxy objects for touch knobs
 *
 * Provides a global `v` object mirroring SC's ~v_* node proxies,
 * so knob values can be used as live parameters in Hydra code.
 *
 * ─── CC knobs (continuous XY) ────────────────────────────────────────
 *   v.c61.x          → X value  (0–1)
 *   v.c61.y          → Y value  (0–1)
 *   () => v.c61.x    → use in Hydra arrow functions
 *
 *   vx(61)           → shorthand for v.c61.x
 *   vy(61)           → shorthand for v.c61.y
 *
 * ─── Note events (tap / hold) ──────────────────────────────────────
 *   v.n61.val        → per-knob note value (1 = on, 0 = off)
 *   v.n.val          → last-tapped knob number
 *   v.n_val.val      → last note velocity   (1 = on, 0 = off)
 *
 *   vn(61)           → shorthand for v.n61.val
 *
 * ─── Example ─────────────────────────────────────────────────────────
 *   osc(20, 0.1, () => v.c61.x)
 *     .rotate(() => v.c61.y * 3.14)
 *     .saturate(() => 1 + vn(61) * 3)
 *     .out()
 */
'use strict';

(function () {

    // ── Internal stores ────────────────────────────────────────────────
    const _cc   = {};   // { '61': { x: 0, y: 0 }, … }
    const _note = {};   // { '61': { val: 0 }, … }
    const _lastNote    = { val: 0 };  // last-tapped knob number
    const _lastNoteVal = { val: 0 };  // last note velocity

    function ensureCC(num) {
        const k = String(num);
        if (!_cc[k]) _cc[k] = { x: 0, y: 0 };
        return _cc[k];
    }

    function ensureNote(num) {
        const k = String(num);
        if (!_note[k]) _note[k] = { val: 0 };
        return _note[k];
    }

    // ── The `v` proxy ──────────────────────────────────────────────────
    // Auto-creates entries on first access so any knob number just works.
    window.v = new Proxy({}, {
        get(_target, prop) {
            // Symbols / internal checks should pass through
            if (typeof prop === 'symbol') return undefined;
            const s = String(prop);

            // v.n_val — last note velocity  (check before v.n<num>)
            if (s === 'n_val') return _lastNoteVal;
            // v.n — last note number
            if (s === 'n')     return _lastNote;

            // v.c<num> — CC knob entry
            const ccMatch = s.match(/^c(\d+)$/);
            if (ccMatch) return ensureCC(ccMatch[1]);

            // v.n<num> — per-note entry
            const noteMatch = s.match(/^n(\d+)$/);
            if (noteMatch) return ensureNote(noteMatch[1]);

            return undefined;
        }
    });

    // ── Shorthand globals ──────────────────────────────────────────────
    window.vx = function (num) { return ensureCC(num).x; };
    window.vy = function (num) { return ensureCC(num).y; };
    window.vn = function (num) { return ensureNote(num).val; };

    // ── Update functions (called from socket.io handlers in index.html) ──
    window._vKnobUpdate = function (note, x, y) {
        const e = ensureCC(note);
        e.x = x;
        e.y = y;
    };

    window._vKnobNoteOn = function (note, val) {
        ensureNote(note).val = val;
        _lastNote.val    = note;
        _lastNoteVal.val = val;
    };

    window._vKnobNoteOff = function (note) {
        ensureNote(note).val = 0;
        _lastNoteVal.val = 0;
    };

    // ── Debug helper ───────────────────────────────────────────────────
    // Call  vdump()  in browser console or in Hydra code to inspect state
    window.vdump = function () {
        const lines = ['── knob proxies ──'];
        for (const [k, e] of Object.entries(_cc).sort(([a],[b]) => a - b)) {
            lines.push(`  v.c${k}  x: ${e.x.toFixed(3)}  y: ${e.y.toFixed(3)}`);
        }
        for (const [k, e] of Object.entries(_note).sort(([a],[b]) => a - b)) {
            lines.push(`  v.n${k}  val: ${e.val}`);
        }
        lines.push(`  v.n      val: ${_lastNote.val}`);
        lines.push(`  v.n_val  val: ${_lastNoteVal.val}`);
        const out = lines.join('\n');
        console.log(out);
        return out;
    };

})();
