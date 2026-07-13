/* sc-like-alias.js  —  SC-style names inside Hydra via the `_s` proxy.
 *
 *   _s.mcr_1       macro 1        (~mcr_1)     → .val
 *   _s.v_c61       knob 61        (~v_c61)     → .x   (_s.v_c61[1] → .y)
 *   _s.v_n61       knob 61 tap    (~v_n61)     → .val
 *   _s.seq_kick    sequencer      (~seq_kick)  → .val
 *   _s.out         sc bridge bus  (~out)       → channel 0 (_s.out[1] → ch 1)
 *
 * Uniform rules:
 *   _s.name        auto-coerces to a number in arithmetic — no Number() needed
 *   _s.name[i]     channel/value i     (also _s.name(i))
 *   _s.name.val    explicit first value; knobs also expose .x/.y,
 *                  macros .pos/.playing/.loop, seqs .step/.steps
 *
 * Every read looks up LIVE state — aliases can safely be stored in consts:
 *   const m1 = _s.mcr_1;   // stays live forever
 */
'use strict';

(function () {

    function num(v) {
        return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
    }

    // read(i) → number for channel i; prop(name) → extra named field or undefined
    function makeAccessor(read, prop) {
        const fn = function (i) { return num(read(num(i))); };
        fn.valueOf = () => num(read(0));
        fn.toString = () => String(num(read(0)));
        fn[Symbol.toPrimitive] = () => num(read(0));

        return new Proxy(fn, {
            get(target, p, receiver) {
                if (typeof p === 'symbol') return Reflect.get(target, p, receiver);
                if (/^\d+$/.test(p)) return num(read(Number(p)));
                if (p === 'val') return num(read(0));
                const extra = prop ? prop(p) : undefined;
                if (extra !== undefined) return extra;
                return Reflect.get(target, p, receiver);
            },
            apply(_t, _this, args) {
                return num(read(num(args && args[0])));
            }
        });
    }

    // ── live lookups (evaluated on EVERY read, never captured) ──────────

    function macroAccessor(n) {
        const entry = () => (typeof window._macroByNum === 'function' ? window._macroByNum(n) : null);
        return makeAccessor(
            (i) => { const e = entry(); return (e && i === 0) ? e.val : 0; },
            (p) => { const e = entry(); return (e && p in e) ? e[p] : undefined; }
        );
    }

    function knobAccessor(n) {
        const entry = () => (window.v ? window.v['c' + n] : null);
        return makeAccessor(
            (i) => { const e = entry(); return e ? (i === 0 ? e.x : (i === 1 ? e.y : 0)) : 0; },
            (p) => { const e = entry(); return (e && (p === 'x' || p === 'y')) ? num(e[p]) : undefined; }
        );
    }

    function noteAccessor(key) {
        const entry = () => (window.v ? window.v[key] : null);
        return makeAccessor(
            (i) => { const e = entry(); return (e && i === 0) ? e.val : 0; }
        );
    }

    function seqAccessor(name) {
        const entry = () => (window.seq ? window.seq[name] : null);
        return makeAccessor(
            (i) => { const e = entry(); return (e && i === 0) ? e.val : 0; },
            (p) => { const e = entry(); return (e && p in e) ? e[p] : undefined; }
        );
    }

    function scAccessor(name) {
        const arr = () => (window.sc && Array.isArray(window.sc[name])) ? window.sc[name] : null;
        return makeAccessor(
            (i) => { const a = arr(); return (a && i < a.length) ? a[i] : 0; },
            (p) => { const a = arr(); return (a && p === 'length') ? a.length : undefined; }
        );
    }

    function resolve(name) {
        let m = name.match(/^mcr_(\d+)$/);
        if (m) return macroAccessor(Number(m[1]));

        m = name.match(/^v_c(\d+)$/);
        if (m) return knobAccessor(m[1]);

        m = name.match(/^v_n(\d+)$/);
        if (m) return noteAccessor('n' + m[1]);

        if (name === 'v_n') return noteAccessor('n');
        if (name === 'v_n_val') return noteAccessor('n_val');

        m = name.match(/^seq_(\w+)$/);
        if (m) return seqAccessor(m[1]);

        return scAccessor(name);   // ~out, ~lfo, any sc-bridge watched proxy
    }

    // Accessors are live, so cache them per name (no per-frame Proxy churn).
    const _cache = Object.create(null);

    window._s = new Proxy({}, {
        get(_t, prop) {
            if (typeof prop === 'symbol') return undefined;
            const name = String(prop);
            return _cache[name] || (_cache[name] = resolve(name));
        }
    });

})();
