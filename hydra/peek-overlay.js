// peek-overlay.js
//
// Browser-side HUD overlay for monitoring Hydra arrow-function expressions.
// Receives expressions (with labels) from the extension via socket.io,
// evaluates them per-frame in a requestAnimationFrame loop, and draws
// a translucent overlay with values and mini bar-graphs.
//
// API (all on window):
//   peekSet(expressions)  — set the list of monitored expressions
//   peekShow()            — show the overlay
//   peekHide()            — hide the overlay
//   peekToggle()          — toggle visibility
//   peekClear()           — stop monitoring, clear expressions

(function () {
    'use strict';

    // ── Config ───────────────────────────────────────────────────────────
    const CFG = {
        maxHistory: 80,      // samples for sparkline
        rowHeight: 22,       // px per expression row
        barWidth: 60,        // sparkline width
        barHeight: 14,       // sparkline height
        padding: 10,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace',
        bgColor: 'rgba(0, 0, 0, 0.55)',
        labelColor: '#888',
        valueColor: '#0f0',
        barColor: '#0a0',
        barBgColor: 'rgba(255,255,255,0.08)',
        borderColor: 'rgba(255,255,255,0.15)',
    };

    // ── State ────────────────────────────────────────────────────────────
    let _expressions = [];  // { expr, label, fn, history[] }
    let _visible = false;
    let _rafId = null;
    let _canvas = null;
    let _ctx = null;

    // ── Canvas setup ─────────────────────────────────────────────────────
    function ensureCanvas() {
        if (_canvas) return;
        _canvas = document.createElement('canvas');
        _canvas.id = 'peek-overlay';
        _canvas.style.cssText = [
            'position: fixed',
            'top: 8px',
            'right: 8px',
            'z-index: 9999',
            'pointer-events: none',
            'image-rendering: auto',
        ].join(';');
        document.body.appendChild(_canvas);
        _ctx = _canvas.getContext('2d');
    }

    // ── Compile expressions into callable functions ──────────────────────
    function compileExpressions(exprs) {
        return exprs.map(e => {
            let fn;
            try {
                // The expression can reference Hydra globals: time, a, mouse, etc.
                fn = new Function('return (' + e.expr + ')');
            } catch (err) {
                console.warn('[peek] compile error for', e.expr, err);
                fn = () => '⚠ compile';
            }
            return {
                expr: e.expr,
                label: e.label || e.expr,
                fn,
                history: [],
            };
        });
    }

    // ── Draw one frame ───────────────────────────────────────────────────
    function draw() {
        if (!_visible || !_expressions.length) return;
        ensureCanvas();

        const rows = _expressions.length;
        const w = CFG.padding * 3 + 220 + CFG.barWidth;
        const h = CFG.padding * 2 + rows * CFG.rowHeight;

        // Resize canvas if needed (retina-aware)
        const dpr = window.devicePixelRatio || 1;
        if (_canvas.width !== w * dpr || _canvas.height !== h * dpr) {
            _canvas.width = w * dpr;
            _canvas.height = h * dpr;
            _canvas.style.width = w + 'px';
            _canvas.style.height = h + 'px';
            _ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // Background
        _ctx.clearRect(0, 0, w, h);
        _ctx.fillStyle = CFG.bgColor;
        _ctx.beginPath();
        roundRect(_ctx, 0, 0, w, h, 6);
        _ctx.fill();
        _ctx.strokeStyle = CFG.borderColor;
        _ctx.lineWidth = 1;
        _ctx.beginPath();
        roundRect(_ctx, 0.5, 0.5, w - 1, h - 1, 6);
        _ctx.stroke();

        _ctx.font = CFG.fontSize + 'px ' + CFG.fontFamily;
        _ctx.textBaseline = 'middle';

        for (let i = 0; i < _expressions.length; i++) {
            const e = _expressions[i];
            const y = CFG.padding + i * CFG.rowHeight;
            const cy = y + CFG.rowHeight / 2;

            // ── Sample the value ─────────────────────────────────────
            let val;
            try {
                val = e.fn();
            } catch (err) {
                val = NaN;
            }

            // Track numeric history
            const numVal = typeof val === 'number' ? val : parseFloat(val);
            if (!isNaN(numVal)) {
                e.history.push(numVal);
                if (e.history.length > CFG.maxHistory) e.history.shift();
            }

            // ── Label ────────────────────────────────────────────────
            _ctx.fillStyle = CFG.labelColor;
            const labelText = truncate(e.label, 18);
            _ctx.fillText(labelText, CFG.padding, cy);

            // ── Value ────────────────────────────────────────────────
            _ctx.fillStyle = CFG.valueColor;
            const valText = formatValue(val);
            _ctx.fillText(valText, CFG.padding + 135, cy);

            // ── Sparkline ────────────────────────────────────────────
            if (e.history.length > 1) {
                const bx = CFG.padding * 2 + 220;
                const by = y + (CFG.rowHeight - CFG.barHeight) / 2;
                drawSparkline(_ctx, e.history, bx, by, CFG.barWidth, CFG.barHeight);
            }
        }
    }

    // ── Sparkline mini chart ─────────────────────────────────────────────
    function drawSparkline(ctx, hist, x, y, w, h) {
        if (hist.length < 2) return;

        // Auto-range with some headroom
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < hist.length; i++) {
            if (hist[i] < min) min = hist[i];
            if (hist[i] > max) max = hist[i];
        }
        if (min === max) { min -= 0.5; max += 0.5; }
        const range = max - min || 1;

        // Background
        ctx.fillStyle = CFG.barBgColor;
        ctx.fillRect(x, y, w, h);

        // Line
        ctx.strokeStyle = CFG.barColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
            const px = x + (i / (hist.length - 1)) * w;
            const py = y + h - ((hist[i] - min) / range) * h;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Current value dot
        const lastPx = x + w;
        const lastPy = y + h - ((hist[hist.length - 1] - min) / range) * h;
        ctx.fillStyle = '#0f0';
        ctx.beginPath();
        ctx.arc(lastPx - 1, lastPy, 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // ── Animation loop ───────────────────────────────────────────────────
    function loop() {
        if (!_visible) return;
        draw();
        _rafId = requestAnimationFrame(loop);
    }

    function startLoop() {
        if (_rafId) return;
        _rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
        if (_rafId) {
            cancelAnimationFrame(_rafId);
            _rafId = null;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────
    function formatValue(val) {
        if (val === undefined || val === null) return '—';
        if (typeof val === 'number') {
            if (isNaN(val)) return 'NaN';
            // Compact: 3 decimal places max
            return val.toFixed(3).replace(/\.?0+$/, '') || '0';
        }
        if (typeof val === 'string') return '"' + truncate(val, 10) + '"';
        if (typeof val === 'boolean') return val ? 'true' : 'false';
        return String(val).slice(0, 12);
    }

    function truncate(str, max) {
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
    }

    // ── Public API (on window) ───────────────────────────────────────────

    window.peekSet = function (expressions) {
        _expressions = compileExpressions(expressions || []);
        if (_visible && _expressions.length) startLoop();
        console.log('[peek] monitoring', _expressions.length, 'expressions');
    };

    window.peekShow = function () {
        _visible = true;
        if (_canvas) _canvas.style.display = '';
        if (_expressions.length) startLoop();
    };

    window.peekHide = function () {
        _visible = false;
        stopLoop();
        if (_canvas) _canvas.style.display = 'none';
    };

    window.peekToggle = function () {
        if (_visible) window.peekHide();
        else window.peekShow();
    };

    window.peekClear = function () {
        _expressions = [];
        stopLoop();
        if (_ctx && _canvas) {
            _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
        }
    };

    // Start hidden by default
    _visible = false;

    console.log('[peek] overlay loaded');
})();
