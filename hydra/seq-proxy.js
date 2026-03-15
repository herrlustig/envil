/* seq-proxy.js  —  Hydra-side proxy for sequencer step values
 *
 * Provides a global `seq` object receiving live sequencer state
 * from the touch-knobs sequencer via socket.io.
 *
 * ─── Access patterns ─────────────────────────────────────────────────
 *   seq.kick.val       → current step value (0 or 1, or any number)
 *   seq.kick.step      → current step index (0-based)
 *   seq.kick.steps     → full array [1,0,0,1,0,0,1,0]
 *   seq.kick.length    → number of steps
 *
 *   seqv('kick')       → shorthand for seq.kick.val
 *
 * ─── Example Hydra code ─────────────────────────────────────────────
 *   osc(20, 0.1, () => seq.kick.val * 2)
 *     .saturate(() => 1 + seq.hat.val * 5)
 *     .out()
 *
 * ─── Uninitialised sequencers ───────────────────────────────────────
 *   Accessing a sequencer that hasn't been created returns val=0,
 *   step=0, steps=[], length=0.  Same as SC where an uninitialised
 *   NodeProxy returns 0.
 */
'use strict';

(function () {

    // ── Internal store ─────────────────────────────────────────────────
    // { 'kick': { val: 0, step: 0, steps: [1,0,0,1,...], length: 8 }, … }
    const _store = {};

    function ensure(name) {
        if (!_store[name]) _store[name] = { val: 0, step: 0, steps: [], length: 0 };
        return _store[name];
    }

    // ── The `seq` proxy ────────────────────────────────────────────────
    window.seq = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'symbol') return undefined;
            return ensure(String(prop));
        }
    });

    // ── Shorthand ──────────────────────────────────────────────────────
    window.seqv = function (name) {
        return ensure(name).val;
    };

    // ── Update function (called from socket.io handler in index.html) ──
    window._seqStepUpdate = function (name, step, val, steps) {
        const e = ensure(name);
        e.step = step;
        e.val = val;
        if (steps) {
            e.steps = steps;
            e.length = steps.length;
        }
    };

    // ── Debug helper ───────────────────────────────────────────────────
    window.seqdump = function () {
        const lines = ['── Sequencers ──'];
        for (const [name, e] of Object.entries(_store).sort(([a],[b]) => a.localeCompare(b))) {
            const pattern = e.steps.map((v, i) => i === e.step ? `[${v}]` : String(v)).join(' ');
            lines.push(`  seq.${name}  val=${e.val}  step=${e.step}/${e.length}  ${pattern}`);
        }
        const out = lines.join('\n');
        console.log(out);
        return out;
    };

})();
