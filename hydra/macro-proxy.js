// @ts-nocheck
/* global window */
/* macro-proxy.js  —  Hydra-side proxy objects for macro control curves
 *
 * Provides a global `macro` object receiving live values from the touch-knobs
 * macro curve editor.
 *
 * ─── Access patterns ─────────────────────────────────────────────────
 *   macro.fade.val        → current macro value (0–1)
 *   macro.fade.pos        → current playhead position (0–1)
 *   macro.fade.playing    → playback state
 *   macro.fade.length     → stored curve resolution
 *
 *   macrov('fade')        → shorthand for macro.fade.val
 */
'use strict';

(function () {

    const _store = {};
    const _numToName = {};

    function ensure(name) {
        const key = String(name);
        if (!_store[key]) {
            _store[key] = { val: 0, pos: 0, playing: false, loop: false, length: 0, points: [] };
        }
        return _store[key];
    }

    window.macro = new Proxy({}, {
        get(_target, prop) {
            if (typeof prop === 'symbol') return undefined;
            return ensure(String(prop));
        }
    });

    window.macrov = function (name) {
        return ensure(name).val;
    };

    window._macroUpdate = function (name, pos, val, playing, length, points, loop, macroNum) {
        const entry = ensure(name);
        entry.pos = typeof pos === 'number' ? pos : entry.pos;
        entry.val = typeof val === 'number' ? val : entry.val;
        entry.playing = typeof playing === 'boolean' ? playing : entry.playing;
        entry.loop = typeof loop === 'boolean' ? loop : entry.loop;
        entry.length = typeof length === 'number' ? length : entry.length;
        if (Array.isArray(points)) entry.points = points.slice();
        if (Number.isInteger(macroNum) && macroNum > 0) {
            entry.macroNum = macroNum;
            _numToName[String(macroNum)] = String(name);
        }
    };

    window._macroRemove = function (name) {
        const entry = _store[String(name)];
        if (entry && Number.isInteger(entry.macroNum) && entry.macroNum > 0) {
            delete _numToName[String(entry.macroNum)];
        }
        delete _store[String(name)];
    };

    // Return macro entry by SC-style macro number (e.g. 1 for ~mcr_1).
    window._macroByNum = function (num) {
        const name = _numToName[String(num)];
        if (!name) return null;
        return _store[name] || null;
    };

    window.macrodump = function () {
        const lines = ['── Macros ──'];
        for (const [name, entry] of Object.entries(_store).sort(([a],[b]) => a.localeCompare(b))) {
            lines.push(`  macro.${name}  val=${entry.val.toFixed(3)}  pos=${entry.pos.toFixed(3)}  playing=${entry.playing}  loop=${entry.loop}  len=${entry.length}`);
        }
        const out = lines.join('\n');
        console.log(out);
        return out;
    };

})();
