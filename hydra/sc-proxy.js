/* sc-proxy.js  —  Hydra-side proxy objects for SuperCollider bus values
 *
 * Provides a global `sc` object that receives live control bus values
 * from scsynth via the extension's sc-bridge → socket.io pipeline.
 *
 * ─── Access patterns ─────────────────────────────────────────────────
 *   sc.out          → array of channel values, e.g. [0.73, 0.41]
 *   sc.out[0]       → first channel  (0.73)
 *   sc.out[1]       → second channel (0.41)
 *   sc.lfo[0]       → first channel of ~lfo
 *
 *   scv('out')      → shorthand for sc.out[0]  (first channel)
 *   scv('out', 1)   → shorthand for sc.out[1]  (second channel)
 *
 * ─── Example Hydra code ─────────────────────────────────────────────
 *   osc(20, 0.1, () => sc.out[0])
 *     .rotate(() => sc.lfo[0] * 3.14)
 *     .out()
 *
 * ─── Uninitialised proxies ──────────────────────────────────────────
 *   Accessing a proxy that hasn't received data yet returns [0].
 *   Indexing beyond available channels returns 0.
 *   This mirrors SC where an uninitialised NodeProxy returns 0.
 */
'use strict';

(function () {

    // ── Internal store ─────────────────────────────────────────────────
    // { 'out': [0.73, 0.41], 'lfo': [0.5], … }
    const _store = {};

    function ensure(name) {
        if (!_store[name]) _store[name] = [0];
        return _store[name];
    }

    // ── The `sc` proxy ─────────────────────────────────────────────────
    // Returns an array for each property. The array auto-creates on first
    // access so any name returns [0] by default.
    window.sc = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'symbol') return undefined;
            return ensure(String(prop));
        }
    });

    // ── Shorthand ──────────────────────────────────────────────────────
    // scv('out')     → sc.out[0]
    // scv('out', 1)  → sc.out[1]
    window.scv = function (name, ch) {
        const arr = ensure(name);
        const idx = ch || 0;
        return idx < arr.length ? arr[idx] : 0;
    };

    // ── Update function (called from socket.io handler in index.html) ──
    window._scProxyUpdate = function (name, values) {
        _store[name] = values;
    };

    // ── Debug helper ───────────────────────────────────────────────────
    window.scdump = function () {
        const lines = ['── SC proxies ──'];
        for (const [name, vals] of Object.entries(_store).sort(([a],[b]) => a.localeCompare(b))) {
            const formatted = vals.map(v => (typeof v === 'number' ? v.toFixed(4) : String(v))).join(', ');
            lines.push(`  sc.${name} = [${formatted}]`);
        }
        const out = lines.join('\n');
        console.log(out);
        return out;
    };

})();
