// hydra-params.js
//
// Shared parameter name lookup table for Hydra transforms.
// Used by both hydra-language-support.js (completions/hover/sig-help)
// and peek-expressions.js (expression labeling for peek overlay).
//
// This module is vscode-free so it can be loaded from anywhere.

'use strict';

/**
 * Map of method name → array of param name strings.
 * Derived from HYDRA_SOURCES and HYDRA_METHODS.
 */
const HYDRA_PARAM_NAMES = {
    // ── Sources ──────────────────────────────────────────────────────────
    osc:        ['freq', 'sync', 'offset'],
    noise:      ['scale', 'offset'],
    voronoi:    ['scale', 'speed', 'blending'],
    gradient:   ['speed'],
    shape:      ['sides', 'radius', 'smoothing'],
    solid:      ['r', 'g', 'b', 'a'],
    src:        ['tex'],

    // ── Geometry ─────────────────────────────────────────────────────────
    rotate:     ['angle', 'speed'],
    scale:      ['amount', 'xMult', 'yMult', 'offsetX', 'offsetY'],
    pixelate:   ['pixelX', 'pixelY'],
    repeat:     ['repeatX', 'repeatY', 'offsetX', 'offsetY'],
    repeatX:    ['reps', 'offset'],
    repeatY:    ['reps', 'offset'],
    scrollX:    ['scrollX', 'speed'],
    scrollY:    ['scrollY', 'speed'],
    kaleid:     ['nSides'],

    // ── Colour ───────────────────────────────────────────────────────────
    brightness: ['amount'],
    contrast:   ['amount'],
    color:      ['r', 'g', 'b', 'a'],
    colorama:   ['amount'],
    hue:        ['hue'],
    invert:     ['amount'],
    luma:       ['threshold', 'tolerance'],
    posterize:  ['bins', 'gamma'],
    saturate:   ['amount'],
    shift:      ['r', 'g', 'b', 'a'],
    thresh:     ['threshold', 'tolerance'],
    r:          ['scale', 'offset'],
    g:          ['scale', 'offset'],
    b:          ['scale', 'offset'],
    a:          ['scale', 'offset'],

    // ── Blend ────────────────────────────────────────────────────────────
    add:              ['tex', 'amount'],
    blend:            ['tex', 'amount'],
    diff:             ['tex'],
    layer:            ['tex'],
    mask:             ['mask'],
    mult:             ['tex', 'amount'],
    sub:              ['tex', 'amount'],

    // ── Modulate ─────────────────────────────────────────────────────────
    modulate:         ['tex', 'amount'],
    modulateHue:      ['tex', 'amount'],
    modulateKaleid:   ['tex', 'nSides'],
    modulatePixelate: ['tex', 'multiple', 'offset'],
    modulateRepeat:   ['tex', 'repeatX', 'repeatY', 'offsetX', 'offsetY'],
    modulateRepeatX:  ['tex', 'reps', 'offset'],
    modulateRepeatY:  ['tex', 'reps', 'offset'],
    modulateRotate:   ['tex', 'multiple', 'offset'],
    modulateScale:    ['tex', 'multiple', 'offset'],
    modulateScrollX:  ['tex', 'scrollX', 'speed'],
    modulateScrollY:  ['tex', 'scrollY', 'speed'],

    // ── Output ───────────────────────────────────────────────────────────
    out:              ['output'],

    // ── Audio ────────────────────────────────────────────────────────────
    setBins:   ['bins'],
    setSmooth: ['smooth'],
    setCutoff: ['cutoff'],
    setScale:  ['scale'],

    // ── Source init ──────────────────────────────────────────────────────
    initCam:    ['index'],
    initScreen: [],
    init:       ['options'],
};

module.exports = { HYDRA_PARAM_NAMES };
