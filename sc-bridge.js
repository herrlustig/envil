// @ts-nocheck
// sc-bridge.js
//
// SC→Hydra proxy bridge: polls scsynth control buses directly via OSC
// and forwards values to the Hydra browser page through socket.io.
//
// Architecture:
//   1) Resolve proxy bus index once:  queryCode("~out.bus.index")  → 14
//   2) Poll loop (30fps):  send /c_getn 14 2  → scsynth (UDP 57110)
//   3) Receive /c_setn 14 2 [0.73, 0.41]  → emit socket.io 'sc-proxy-update'
//   4) Browser side:  sc.out → [0.73, 0.41],  sc.out[0] → 0.73
//
// Usage in Hydra code:
//   osc(20, 0.1, () => sc.out[0])
//     .rotate(() => sc.lfo[0] * 3.14)
//     .out()

'use strict';
const osc = require('osc');

const POLL_FPS = 30;
const SCSYNTH_PORT = 57110;

let _getSC = null;          // function → sc module
let _getIO = null;          // function → socket.io server
let _log = null;            // logging function
let _pollTimer = null;      // setInterval id
let _scsynthPort = null;    // osc.UDPPort talking to scsynth

// Watched proxies:  { 'out': { busIndex: 14, numChannels: 2, values: [0,0] }, … }
const _proxies = {};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialise the bridge. Call once from extension.js activate().
 */
function initBridge({ getSC, getIO, log }) {
    _getSC = getSC;
    _getIO = getIO;
    _log = log || (() => {});
}

/**
 * Watch a SC proxy by name — resolve its bus index and start polling.
 * @param {string} name  — proxy name without ~ (e.g. 'out', 'lfo')
 * @param {number} [numChannels=1]  — expected number of channels
 * @returns {Promise<boolean>} true if resolved successfully
 */
async function watchProxy(name, numChannels) {
    const sc = _getSC ? _getSC() : null;
    if (!sc || !sc.isSclangRunning()) {
        _log(`  ⚠ sc-bridge: sclang not running, cannot watch ~${name}`);
        return false;
    }

    const marker = `<<SCB_${name}>>`;
    // Ask sclang for the bus index and channel count
    const scCode = [
        `var p = ~${name};`,
        `if(p.notNil and: { p.bus.notNil }, {`,
        `  "${marker}" ++ p.bus.index ++ "," ++ p.numChannels ++ "${marker}"`,
        `}, {`,
        `  "${marker}nil${marker}"`,
        `})`,
    ].join(' ');

    const result = await sc.queryCode(scCode, marker, 3000);
    if (!result || result.trim() === 'nil') {
        _log(`  ⚠ sc-bridge: ~${name} has no bus (proxy not initialised)`);
        return false;
    }

    const parts = result.trim().split(',');
    const busIndex = parseInt(parts[0], 10);
    const nCh = numChannels || parseInt(parts[1], 10) || 1;

    if (isNaN(busIndex)) {
        _log(`  ⚠ sc-bridge: failed to parse bus index for ~${name}: "${result}"`);
        return false;
    }

    _proxies[name] = {
        busIndex,
        numChannels: nCh,
        values: new Array(nCh).fill(0),
    };

    _log(`  🔗 sc-bridge: watching ~${name}  bus=${busIndex}  ch=${nCh}`);

    // Ensure polling is running
    ensurePolling();
    return true;
}

/**
 * Stop watching a proxy.
 */
function unwatchProxy(name) {
    delete _proxies[name];
    _log(`  🔗 sc-bridge: unwatched ~${name}`);
    if (Object.keys(_proxies).length === 0) stopPolling();
}

/**
 * Re-resolve all watched proxies (useful after scsynth reboot —
 * bus indices may change).
 */
async function refreshAll() {
    const names = Object.keys(_proxies);
    for (const name of names) {
        const old = _proxies[name];
        await watchProxy(name, old ? old.numChannels : undefined);
    }
}

/**
 * Stop polling and clean up. Call on extension deactivate.
 */
function dispose() {
    stopPolling();
    if (_scsynthPort) {
        try { _scsynthPort.close(); } catch (_) {}
        _scsynthPort = null;
    }
    for (const k of Object.keys(_proxies)) delete _proxies[k];
}

/**
 * Get list of currently watched proxy names.
 */
function getWatchedNames() {
    return Object.keys(_proxies);
}

// ─────────────────────────────────────────────────────────────────────────────
// OSC COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────

function ensureScsynthPort() {
    if (_scsynthPort) return;

    _scsynthPort = new osc.UDPPort({
        localAddress: '127.0.0.1',
        localPort: 0,          // OS picks a free port for receiving replies
        remoteAddress: '127.0.0.1',
        remotePort: SCSYNTH_PORT,
    });

    _scsynthPort.on('message', handleOSCReply);

    _scsynthPort.on('error', (err) => {
        // Suppress ECONNREFUSED when scsynth isn't running
        if (err && err.code === 'ECONNREFUSED') return;
        console.warn('[sc-bridge] OSC error:', err);
    });

    _scsynthPort.open();
}

function handleOSCReply(msg) {
    // /c_setn  busIndex  numChannels  val1  val2 ...
    // /c_set   busIndex  val
    if (msg.address === '/c_setn' && msg.args) {
        const busIdx = msg.args[0];
        const nCh    = msg.args[1];
        const vals   = msg.args.slice(2, 2 + nCh);

        // Find which proxy this belongs to
        for (const [name, info] of Object.entries(_proxies)) {
            if (info.busIndex === busIdx) {
                info.values = vals;
                emitToHydra(name, vals);
                break;
            }
        }
    } else if (msg.address === '/c_set' && msg.args) {
        const busIdx = msg.args[0];
        const val    = msg.args[1];
        for (const [name, info] of Object.entries(_proxies)) {
            if (info.busIndex === busIdx) {
                info.values = [val];
                emitToHydra(name, [val]);
                break;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POLL LOOP
// ─────────────────────────────────────────────────────────────────────────────

function ensurePolling() {
    if (_pollTimer) return;
    ensureScsynthPort();
    const interval = Math.round(1000 / POLL_FPS);
    _pollTimer = setInterval(pollOnce, interval);
}

function stopPolling() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

function pollOnce() {
    if (!_scsynthPort) return;

    for (const info of Object.values(_proxies)) {
        if (info.numChannels === 1) {
            _scsynthPort.send({
                address: '/c_get',
                args: [{ type: 'i', value: info.busIndex }],
            });
        } else {
            _scsynthPort.send({
                address: '/c_getn',
                args: [
                    { type: 'i', value: info.busIndex },
                    { type: 'i', value: info.numChannels },
                ],
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO EMISSION
// ─────────────────────────────────────────────────────────────────────────────

function emitToHydra(name, values) {
    const io = _getIO ? _getIO() : null;
    if (!io) return;
    io.sockets.emit('sc-proxy-update', { name, values });
}

module.exports = {
    initBridge,
    watchProxy,
    unwatchProxy,
    refreshAll,
    dispose,
    getWatchedNames,
};
