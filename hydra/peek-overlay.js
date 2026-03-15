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

    let _toggleBtn = null;
    let _collapsed = false;    // panel hidden by user toggle (default: shown)

    // ── Canvas setup ─────────────────────────────────────────────────
    function ensureCanvas() {
        if (_canvas) return;
        _canvas = document.createElement('canvas');
        _canvas.id = 'peek-overlay';
        _canvas.style.cssText = [
            'position: fixed',
            'bottom: 8px',
            'left: 8px',
            'z-index: 9999',
            'pointer-events: none',
            'image-rendering: auto',
        ].join(';');
        document.body.appendChild(_canvas);
        _ctx = _canvas.getContext('2d');
        ensureToggleBtn();
    }

    // ── Toggle button ────────────────────────────────────────────────
    function ensureToggleBtn() {
        if (_toggleBtn) return;
        _toggleBtn = document.createElement('div');
        _toggleBtn.id = 'peek-toggle';
        _toggleBtn.title = 'Toggle value feedback';
        _toggleBtn.textContent = '\u25BE';   // ▾ = expanded by default
        _toggleBtn.style.cssText = [
            'position: fixed',
            'bottom: 8px',
            'left: 8px',
            'z-index: 10000',
            'width: 22px',
            'height: 22px',
            'display: flex',
            'align-items: center',
            'justify-content: center',
            'font-size: 13px',
            'line-height: 1',
            'cursor: pointer',
            'user-select: none',
            'background: rgba(0,0,0,0.55)',
            'border: 1px solid rgba(255,255,255,0.15)',
            'border-radius: 4px',
            'opacity: 0.7',
            'transition: opacity 0.15s',
        ].join(';');
        _toggleBtn.addEventListener('mouseenter', () => { _toggleBtn.style.opacity = '1'; });
        _toggleBtn.addEventListener('mouseleave', () => { _toggleBtn.style.opacity = '0.7'; });
        _toggleBtn.addEventListener('click', () => {
            _collapsed = !_collapsed;
            syncToggle();
        });
        document.body.appendChild(_toggleBtn);
    }

    function syncToggle() {
        if (!_toggleBtn) return;
        if (_collapsed) {
            _toggleBtn.textContent = '\u25B8';   // ▸ right-pointing triangle (collapsed)
            if (_canvas) _canvas.style.display = 'none';
        } else {
            _toggleBtn.textContent = '\u25BE';   // ▾ down-pointing triangle (expanded)
            if (_canvas) _canvas.style.display = '';
        }
        // Nudge button: when panel visible, sit just above it; when hidden, stay in corner
        _toggleBtn.style.bottom = _collapsed ? '8px' : '';
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
        const w = CFG.padding * 3 + 220 + CFG.barWidth + 22;  // +22 for Y-axis labels
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

        // If user collapsed the panel, just keep the button visible
        if (_collapsed) {
            _canvas.style.display = 'none';
            if (_toggleBtn) {
                _toggleBtn.style.display = '';
                _toggleBtn.style.bottom = '8px';
            }
            return;
        }
        _canvas.style.display = '';

        // Position toggle button above the canvas
        if (_toggleBtn) {
            _toggleBtn.style.bottom = (h + 12) + 'px';
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
        ctx.save();

        // Auto-range with some headroom
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < hist.length; i++) {
            if (hist[i] < min) min = hist[i];
            if (hist[i] > max) max = hist[i];
        }
        if (min === max) { min -= 0.5; max += 0.5; }
        const range = max - min || 1;

        // ── Y-axis labels (min / max) ────────────────────────────────
        const labelFontSize = 8;
        const labelGap = 22;           // space reserved for the labels
        ctx.font = labelFontSize + 'px ' + CFG.fontFamily;
        ctx.fillStyle = '#666';
        ctx.textBaseline = 'top';
        ctx.fillText(fmtAxis(max), x, y - 1);
        ctx.textBaseline = 'bottom';
        ctx.fillText(fmtAxis(min), x, y + h + 1);

        // Shift sparkline right so labels don't overlap the line
        const sx = x + labelGap;
        const sw = w - labelGap;

        // Background
        ctx.fillStyle = CFG.barBgColor;
        ctx.fillRect(sx, y, sw, h);

        // Line
        ctx.strokeStyle = CFG.barColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < hist.length; i++) {
            const px = sx + (i / (hist.length - 1)) * sw;
            const py = y + h - ((hist[i] - min) / range) * h;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Current value dot
        const lastPx = sx + sw;
        const lastPy = y + h - ((hist[hist.length - 1] - min) / range) * h;
        ctx.fillStyle = '#0f0';
        ctx.beginPath();
        ctx.arc(lastPx - 1, lastPy, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    /** Compact axis formatter: up to 2 decimals, strip trailing zeroes */
    function fmtAxis(v) {
        if (Math.abs(v) >= 100)  return v.toFixed(0);
        if (Math.abs(v) >= 1)    return v.toFixed(1).replace(/\.0$/, '');
        return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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
        if (_expressions.length) {
            ensureCanvas();   // also creates toggle button
            if (_toggleBtn) _toggleBtn.style.display = '';
        }
        if (_visible && _expressions.length) startLoop();
        console.log('[peek] monitoring', _expressions.length, 'expressions');
    };

    window.peekShow = function () {
        _visible = true;
        _collapsed = false;
        if (_canvas) _canvas.style.display = '';
        if (_toggleBtn) _toggleBtn.style.display = '';
        syncToggle();
        if (_expressions.length) startLoop();
    };

    window.peekHide = function () {
        _visible = false;
        stopLoop();
        if (_canvas) _canvas.style.display = 'none';
        if (_toggleBtn) _toggleBtn.style.display = 'none';
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
        if (_toggleBtn) _toggleBtn.style.display = 'none';
    };

    // Start hidden by default
    _visible = false;

    console.log('[peek] overlay loaded');
})();
