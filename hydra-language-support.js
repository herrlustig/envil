// @ts-nocheck
// hydra-language-support.js
//
// Registers VS Code completion, hover, and signature-help providers for the
// Hydra visual-coding language (JavaScript files inside the envil environment).

'use strict';
const vscode = require('vscode');

// ─────────────────────────────────────────────────────────────────────────────
// HYDRA API DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// Each entry has:
//   detail        – one-line signature shown in the completion list
//   documentation – Markdown body shown in hover / completion detail panel
//   params        – array of 'name = default' strings (used for snippets & sig-help)

const HYDRA_SOURCES = {
    'osc': {
        detail: 'osc(freq, sync, offset) → Source',
        documentation: [
            '**osc** — Oscillator source',
            '',
            'Generates animated sinusoidal stripes.',
            '',
            '**Parameters:**',
            '- `freq` *(default 60)* — Stripe frequency',
            '- `sync` *(default 0.1)* — Animation / sync speed',
            '- `offset` *(default 0)* — Phase offset between RGB channels',
            '',
            '**Example:**',
            '```js',
            'osc(60, 0.1, 0.8).out()',
            '```',
        ].join('\n'),
        params: ['freq = 60', 'sync = 0.1', 'offset = 0'],
    },
    'noise': {
        detail: 'noise(scale, offset) → Source',
        documentation: [
            '**noise** — Perlin noise source',
            '',
            '**Parameters:**',
            '- `scale` *(default 10)* — Pattern scale',
            '- `offset` *(default 0.1)* — Animation speed',
            '',
            '**Example:**',
            '```js',
            'noise(10, 0.1).out()',
            '```',
        ].join('\n'),
        params: ['scale = 10', 'offset = 0.1'],
    },
    'voronoi': {
        detail: 'voronoi(scale, speed, blending) → Source',
        documentation: [
            '**voronoi** — Voronoi diagram source',
            '',
            '**Parameters:**',
            '- `scale` *(default 5)* — Cell scale',
            '- `speed` *(default 0.3)* — Animation speed',
            '- `blending` *(default 0.3)* — Edge blending',
            '',
            '**Example:**',
            '```js',
            'voronoi(5, 0.3).colorama(0.5).out()',
            '```',
        ].join('\n'),
        params: ['scale = 5', 'speed = 0.3', 'blending = 0.3'],
    },
    'gradient': {
        detail: 'gradient(speed) → Source',
        documentation: [
            '**gradient** — Gradient source',
            '',
            'Generates a smooth linear colour gradient.',
            '',
            '**Parameters:**',
            '- `speed` *(default 0)* — Colour-cycle speed',
            '',
            '**Example:**',
            '```js',
            'gradient(0).out()',
            '```',
        ].join('\n'),
        params: ['speed = 0'],
    },
    'shape': {
        detail: 'shape(sides, radius, smoothing) → Source',
        documentation: [
            '**shape** — Geometric shape source',
            '',
            'Generates a regular polygon.',
            '',
            '**Parameters:**',
            '- `sides` *(default 3)* — Number of sides',
            '- `radius` *(default 0.3)* — Shape radius (0–1)',
            '- `smoothing` *(default 0.01)* — Edge softness',
            '',
            '**Example:**',
            '```js',
            'shape(4, 0.5, 0.01).out()',
            '```',
        ].join('\n'),
        params: ['sides = 3', 'radius = 0.3', 'smoothing = 0.01'],
    },
    'solid': {
        detail: 'solid(r, g, b, a) → Source',
        documentation: [
            '**solid** — Solid colour source',
            '',
            '**Parameters:**',
            '- `r` *(default 0)* — Red channel (0–1)',
            '- `g` *(default 0)* — Green channel (0–1)',
            '- `b` *(default 0)* — Blue channel (0–1)',
            '- `a` *(default 1)* — Alpha channel (0–1)',
            '',
            '**Example:**',
            '```js',
            'solid(1, 0, 0, 1).out()  // red',
            '```',
        ].join('\n'),
        params: ['r = 0', 'g = 0', 'b = 0', 'a = 1'],
    },
    'src': {
        detail: 'src(tex) → Source',
        documentation: [
            '**src** — Use a texture / output buffer as source',
            '',
            '**Parameters:**',
            '- `tex` — Buffer reference (`o0`–`o3`) or source (`s0`–`s3`)',
            '',
            '**Example:**',
            '```js',
            'src(o0).scale(1.01).out(o0)  // feedback loop',
            '```',
        ].join('\n'),
        params: ['tex'],
    },
};

const HYDRA_METHODS = {
    // ── Geometry ────────────────────────────────────────────────────────────
    'rotate': {
        detail: '.rotate(angle, speed)',
        documentation: [
            '**rotate** — Rotate the texture',
            '',
            '**Parameters:**',
            '- `angle` *(default 10)* — Rotation angle in radians',
            '- `speed` *(default 0)* — Continuous rotation speed',
            '',
            '**Example:**',
            '```js',
            'osc(10).rotate(Math.PI / 4).out()',
            '```',
        ].join('\n'),
        params: ['angle = 10', 'speed = 0'],
    },
    'scale': {
        detail: '.scale(amount, xMult, yMult, offsetX, offsetY)',
        documentation: [
            '**scale** — Scale the texture',
            '',
            '**Parameters:**',
            '- `amount` *(default 1.5)* — Overall scale factor',
            '- `xMult` *(default 1)* — Horizontal multiplier',
            '- `yMult` *(default 1)* — Vertical multiplier',
            '- `offsetX` *(default 0.5)* — Horizontal pivot (0–1)',
            '- `offsetY` *(default 0.5)* — Vertical pivot (0–1)',
            '',
            '**Example:**',
            '```js',
            'osc().scale(0.5).out()',
            '```',
        ].join('\n'),
        params: ['amount = 1.5', 'xMult = 1', 'yMult = 1', 'offsetX = 0.5', 'offsetY = 0.5'],
    },
    'pixelate': {
        detail: '.pixelate(pixelX, pixelY)',
        documentation: [
            '**pixelate** — Reduce texture resolution',
            '',
            '**Parameters:**',
            '- `pixelX` *(default 20)* — Horizontal pixel size',
            '- `pixelY` *(default 20)* — Vertical pixel size',
            '',
            '**Example:**',
            '```js',
            'noise().pixelate(10, 10).out()',
            '```',
        ].join('\n'),
        params: ['pixelX = 20', 'pixelY = 20'],
    },
    'repeat': {
        detail: '.repeat(repeatX, repeatY, offsetX, offsetY)',
        documentation: [
            '**repeat** — Tile the texture',
            '',
            '**Parameters:**',
            '- `repeatX` *(default 3)* — Horizontal tiles',
            '- `repeatY` *(default 3)* — Vertical tiles',
            '- `offsetX` *(default 0)* — Horizontal offset per tile',
            '- `offsetY` *(default 0)* — Vertical offset per tile',
            '',
            '**Example:**',
            '```js',
            'shape(3).repeat(3, 3).out()',
            '```',
        ].join('\n'),
        params: ['repeatX = 3', 'repeatY = 3', 'offsetX = 0', 'offsetY = 0'],
    },
    'repeatX': {
        detail: '.repeatX(reps, offset)',
        documentation: [
            '**repeatX** — Tile horizontally',
            '',
            '**Parameters:**',
            '- `reps` *(default 3)* — Number of horizontal tiles',
            '- `offset` *(default 0)* — Vertical offset per tile',
            '',
            '**Example:**',
            '```js',
            'shape().repeatX(4, 0.5).out()',
            '```',
        ].join('\n'),
        params: ['reps = 3', 'offset = 0'],
    },
    'repeatY': {
        detail: '.repeatY(reps, offset)',
        documentation: [
            '**repeatY** — Tile vertically',
            '',
            '**Parameters:**',
            '- `reps` *(default 3)* — Number of vertical tiles',
            '- `offset` *(default 0)* — Horizontal offset per tile',
            '',
            '**Example:**',
            '```js',
            'shape().repeatY(4, 0.5).out()',
            '```',
        ].join('\n'),
        params: ['reps = 3', 'offset = 0'],
    },
    'scrollX': {
        detail: '.scrollX(scrollX, speed)',
        documentation: [
            '**scrollX** — Scroll horizontally',
            '',
            '**Parameters:**',
            '- `scrollX` *(default 0.5)* — Scroll amount (0–1)',
            '- `speed` *(default 0)* — Continuous scroll speed',
            '',
            '**Example:**',
            '```js',
            'osc().scrollX(0, 0.1).out()',
            '```',
        ].join('\n'),
        params: ['scrollX = 0.5', 'speed = 0'],
    },
    'scrollY': {
        detail: '.scrollY(scrollY, speed)',
        documentation: [
            '**scrollY** — Scroll vertically',
            '',
            '**Parameters:**',
            '- `scrollY` *(default 0.5)* — Scroll amount (0–1)',
            '- `speed` *(default 0)* — Continuous scroll speed',
            '',
            '**Example:**',
            '```js',
            'noise().scrollY(0, 0.05).out()',
            '```',
        ].join('\n'),
        params: ['scrollY = 0.5', 'speed = 0'],
    },
    'kaleid': {
        detail: '.kaleid(nSides)',
        documentation: [
            '**kaleid** — Kaleidoscope effect',
            '',
            '**Parameters:**',
            '- `nSides` *(default 4)* — Number of mirror segments',
            '',
            '**Example:**',
            '```js',
            'osc(10).kaleid(6).out()',
            '```',
        ].join('\n'),
        params: ['nSides = 4'],
    },

    // ── Colour ──────────────────────────────────────────────────────────────
    'brightness': {
        detail: '.brightness(amount)',
        documentation: [
            '**brightness** — Adjust brightness',
            '',
            '**Parameters:**',
            '- `amount` *(default 0.4)* — Brightness offset (negative = darker)',
            '',
            '**Example:**',
            '```js',
            'noise().brightness(0.5).out()',
            '```',
        ].join('\n'),
        params: ['amount = 0.4'],
    },
    'contrast': {
        detail: '.contrast(amount)',
        documentation: [
            '**contrast** — Adjust contrast',
            '',
            '**Parameters:**',
            '- `amount` *(default 1.6)* — Contrast multiplier (>1 = more contrast)',
            '',
            '**Example:**',
            '```js',
            'noise().contrast(1.5).out()',
            '```',
        ].join('\n'),
        params: ['amount = 1.6'],
    },
    'color': {
        detail: '.color(r, g, b, a)',
        documentation: [
            '**color** — Multiply each colour channel',
            '',
            '**Parameters:**',
            '- `r` *(default 1)* — Red multiplier',
            '- `g` *(default 1)* — Green multiplier',
            '- `b` *(default 1)* — Blue multiplier',
            '- `a` *(default 1)* — Alpha multiplier',
            '',
            '**Example:**',
            '```js',
            'noise().color(0, 1, 0).out()  // green tint',
            '```',
        ].join('\n'),
        params: ['r = 1', 'g = 1', 'b = 1', 'a = 1'],
    },
    'colorama': {
        detail: '.colorama(amount)',
        documentation: [
            '**colorama** — HSV colour shift',
            '',
            'Shifts pixel colours through HSV colour space based on luminance.',
            '',
            '**Parameters:**',
            '- `amount` *(default 0.005)* — Shift strength',
            '',
            '**Example:**',
            '```js',
            'osc(10).colorama(0.3).out()',
            '```',
        ].join('\n'),
        params: ['amount = 0.005'],
    },
    'hue': {
        detail: '.hue(hue)',
        documentation: [
            '**hue** — Shift hue',
            '',
            '**Parameters:**',
            '- `hue` *(default 0.4)* — Hue rotation amount (0–1)',
            '',
            '**Example:**',
            '```js',
            'gradient().hue(0.5).out()',
            '```',
        ].join('\n'),
        params: ['hue = 0.4'],
    },
    'invert': {
        detail: '.invert(amount)',
        documentation: [
            '**invert** — Invert colours',
            '',
            '**Parameters:**',
            '- `amount` *(default 1)* — Inversion amount (0 = no change, 1 = full)',
            '',
            '**Example:**',
            '```js',
            'noise().invert(1).out()',
            '```',
        ].join('\n'),
        params: ['amount = 1'],
    },
    'luma': {
        detail: '.luma(threshold, tolerance)',
        documentation: [
            '**luma** — Luma key (transparency by brightness)',
            '',
            'Makes pixels transparent below a luminance threshold.',
            '',
            '**Parameters:**',
            '- `threshold` *(default 0.5)* — Luminance cutoff',
            '- `tolerance` *(default 0.1)* — Edge softness',
            '',
            '**Example:**',
            '```js',
            'noise().luma(0.5, 0.1).out()',
            '```',
        ].join('\n'),
        params: ['threshold = 0.5', 'tolerance = 0.1'],
    },
    'posterize': {
        detail: '.posterize(bins, gamma)',
        documentation: [
            '**posterize** — Reduce colour levels',
            '',
            '**Parameters:**',
            '- `bins` *(default 3)* — Colour levels per channel',
            '- `gamma` *(default 0.6)* — Gamma correction',
            '',
            '**Example:**',
            '```js',
            'gradient().posterize(5).out()',
            '```',
        ].join('\n'),
        params: ['bins = 3', 'gamma = 0.6'],
    },
    'saturate': {
        detail: '.saturate(amount)',
        documentation: [
            '**saturate** — Adjust colour saturation',
            '',
            '**Parameters:**',
            '- `amount` *(default 2)* — Saturation multiplier (0 = greyscale)',
            '',
            '**Example:**',
            '```js',
            'noise().colorama(0.3).saturate(0.5).out()',
            '```',
        ].join('\n'),
        params: ['amount = 2'],
    },
    'shift': {
        detail: '.shift(r, g, b, a)',
        documentation: [
            '**shift** — Shift colour channels by hue',
            '',
            '**Parameters:**',
            '- `r` *(default 0.5)* — Red channel shift',
            '- `g` *(default 0)* — Green channel shift',
            '- `b` *(default 0)* — Blue channel shift',
            '- `a` *(default 0)* — Alpha channel shift',
            '',
            '**Example:**',
            '```js',
            'osc().shift(0.1, 0.2, 0.3).out()',
            '```',
        ].join('\n'),
        params: ['r = 0.5', 'g = 0', 'b = 0', 'a = 0'],
    },
    'thresh': {
        detail: '.thresh(threshold, tolerance)',
        documentation: [
            '**thresh** — Threshold / binarise',
            '',
            'Outputs 1 above threshold, 0 below.',
            '',
            '**Parameters:**',
            '- `threshold` *(default 0.5)* — Brightness threshold',
            '- `tolerance` *(default 0.04)* — Edge softness',
            '',
            '**Example:**',
            '```js',
            'noise().thresh(0.5).out()',
            '```',
        ].join('\n'),
        params: ['threshold = 0.5', 'tolerance = 0.04'],
    },

    // ── Blend ────────────────────────────────────────────────────────────────
    'add': {
        detail: '.add(tex, amount)',
        documentation: [
            '**add** — Add blend',
            '',
            'Adds two textures together.',
            '',
            '**Parameters:**',
            '- `tex` — Source texture / buffer',
            '- `amount` *(default 0.5)* — Blend strength',
            '',
            '**Example:**',
            '```js',
            'noise().add(osc(10), 0.5).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'amount = 0.5'],
    },
    'blend': {
        detail: '.blend(tex, amount)',
        documentation: [
            '**blend** — Linear blend',
            '',
            'Linear interpolation between two textures.',
            '',
            '**Parameters:**',
            '- `tex` — Source texture / buffer',
            '- `amount` *(default 0.4)* — Blend amount (0 = current, 1 = tex)',
            '',
            '**Example:**',
            '```js',
            'osc(10).blend(noise(), 0.5).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'amount = 0.4'],
    },
    'diff': {
        detail: '.diff(tex)',
        documentation: [
            '**diff** — Difference blend',
            '',
            'Absolute colour difference between two textures.',
            '',
            '**Parameters:**',
            '- `tex` — Source texture / buffer',
            '',
            '**Example:**',
            '```js',
            'osc(10).diff(osc(20)).out()',
            '```',
        ].join('\n'),
        params: ['tex'],
    },
    'layer': {
        detail: '.layer(tex)',
        documentation: [
            '**layer** — Layer with luma transparency',
            '',
            'Composites `tex` over the current texture using `tex`\'s luma as alpha.',
            '',
            '**Parameters:**',
            '- `tex` — Foreground texture / buffer',
            '',
            '**Example:**',
            '```js',
            'solid(0,0,0).layer(noise().luma(0.5)).out()',
            '```',
        ].join('\n'),
        params: ['tex'],
    },
    'mask': {
        detail: '.mask(mask)',
        documentation: [
            '**mask** — Apply luma mask',
            '',
            'Uses the luma of `mask` to mask the current texture.',
            '',
            '**Parameters:**',
            '- `mask` — Mask texture / buffer',
            '',
            '**Example:**',
            '```js',
            'osc(10).mask(shape(3)).out()',
            '```',
        ].join('\n'),
        params: ['mask'],
    },
    'mult': {
        detail: '.mult(tex, amount)',
        documentation: [
            '**mult** — Multiply blend',
            '',
            'Multiplies two textures together.',
            '',
            '**Parameters:**',
            '- `tex` — Source texture / buffer',
            '- `amount` *(default 1)* — Blend strength',
            '',
            '**Example:**',
            '```js',
            'gradient().mult(osc(10)).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'amount = 1'],
    },

    // ── Modulate ────────────────────────────────────────────────────────────
    'modulate': {
        detail: '.modulate(tex, amount)',
        documentation: [
            '**modulate** — Displace pixels using another texture',
            '',
            'Uses the RGB of `tex` as UV displacement (like a displacement map).',
            '',
            '**Parameters:**',
            '- `tex` — Displacement texture / buffer',
            '- `amount` *(default 0.1)* — Displacement strength',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulate(noise(), 0.2).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'amount = 0.1'],
    },
    'modulateHue': {
        detail: '.modulateHue(tex, amount)',
        documentation: [
            '**modulateHue** — Modulate using the hue of a texture',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `amount` *(default 1)* — Modulation strength',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateHue(gradient(), 1).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'amount = 1'],
    },
    'modulateKaleid': {
        detail: '.modulateKaleid(tex, nSides)',
        documentation: [
            '**modulateKaleid** — Modulate kaleidoscope',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `nSides` *(default 4)* — Number of segments',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateKaleid(noise(), 4).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'nSides = 4'],
    },
    'modulatePixelate': {
        detail: '.modulatePixelate(tex, multiple, offset)',
        documentation: [
            '**modulatePixelate** — Modulate pixel size',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `multiple` *(default 10)* — Pixel size multiplier',
            '- `offset` *(default 3)* — Pixel offset',
            '',
            '**Example:**',
            '```js',
            'noise().modulatePixelate(osc(10), 100, 0).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'multiple = 10', 'offset = 3'],
    },
    'modulateRepeat': {
        detail: '.modulateRepeat(tex, repeatX, repeatY, offsetX, offsetY)',
        documentation: [
            '**modulateRepeat** — Modulate repeat',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `repeatX` *(default 1.5)* — Horizontal repeat',
            '- `repeatY` *(default 1.5)* — Vertical repeat',
            '- `offsetX` *(default 0.5)* — Horizontal offset',
            '- `offsetY` *(default 0.5)* — Vertical offset',
            '',
            '**Example:**',
            '```js',
            'noise().modulateRepeat(osc(5), 3, 3).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'repeatX = 1.5', 'repeatY = 1.5', 'offsetX = 0.5', 'offsetY = 0.5'],
    },
    'modulateRepeatX': {
        detail: '.modulateRepeatX(tex, reps, offset)',
        documentation: [
            '**modulateRepeatX** — Modulate horizontal repeat',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `reps` *(default 1.5)* — Repeat count',
            '- `offset` *(default 0.5)* — Offset',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateRepeatX(noise(), 3).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'reps = 1.5', 'offset = 0.5'],
    },
    'modulateRepeatY': {
        detail: '.modulateRepeatY(tex, reps, offset)',
        documentation: [
            '**modulateRepeatY** — Modulate vertical repeat',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `reps` *(default 1.5)* — Repeat count',
            '- `offset` *(default 0.5)* — Offset',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateRepeatY(noise(), 3).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'reps = 1.5', 'offset = 0.5'],
    },
    'modulateRotate': {
        detail: '.modulateRotate(tex, multiple, offset)',
        documentation: [
            '**modulateRotate** — Modulate rotation',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `multiple` *(default 1)* — Rotation multiplier',
            '- `offset` *(default 0)* — Rotation offset',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateRotate(noise(), 2).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'multiple = 1', 'offset = 0'],
    },
    'modulateScale': {
        detail: '.modulateScale(tex, multiple, offset)',
        documentation: [
            '**modulateScale** — Modulate scale',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `multiple` *(default 1)* — Scale multiplier',
            '- `offset` *(default 1)* — Scale offset',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateScale(noise(), 2, 1).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'multiple = 1', 'offset = 1'],
    },
    'modulateScrollX': {
        detail: '.modulateScrollX(tex, scrollX, speed)',
        documentation: [
            '**modulateScrollX** — Modulate horizontal scroll',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `scrollX` *(default 0.5)* — Scroll amount',
            '- `speed` *(default 0)* — Scroll speed',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateScrollX(noise(), 0.2).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'scrollX = 0.5', 'speed = 0'],
    },
    'modulateScrollY': {
        detail: '.modulateScrollY(tex, scrollY, speed)',
        documentation: [
            '**modulateScrollY** — Modulate vertical scroll',
            '',
            '**Parameters:**',
            '- `tex` — Source texture for modulation',
            '- `scrollY` *(default 0.5)* — Scroll amount',
            '- `speed` *(default 0)* — Scroll speed',
            '',
            '**Example:**',
            '```js',
            'osc(10).modulateScrollY(noise(), 0.2).out()',
            '```',
        ].join('\n'),
        params: ['tex', 'scrollY = 0.5', 'speed = 0'],
    },

    // ── Output ───────────────────────────────────────────────────────────────
    'out': {
        detail: '.out(output)',
        documentation: [
            '**out** — Output to buffer',
            '',
            'Renders the chain to a Hydra output buffer.',
            '',
            '**Parameters:**',
            '- `output` *(default o0)* — Output buffer: `o0`, `o1`, `o2`, or `o3`',
            '',
            '**Example:**',
            '```js',
            'osc(10).out(o0)',
            '```',
        ].join('\n'),
        params: ['output = o0'],
    },
};

// Audio object + source-init methods
const HYDRA_AUDIO_METHODS = {
    'setBins': {
        detail: 'a.setBins(bins)',
        documentation: [
            '**setBins** — Set number of FFT frequency bins',
            '',
            'Divides the audio spectrum into `bins` bands, accessible via',
            '`a.fft[0]`…`a.fft[bins-1]`.',
            '',
            '**Parameters:**',
            '- `bins` — Number of frequency bands (e.g. 4)',
            '',
            '**Example:**',
            '```js',
            'a.setBins(4);',
            '// a.fft[0] = bass   a.fft[1] = low-mid',
            '// a.fft[2] = hi-mid  a.fft[3] = treble',
            '```',
        ].join('\n'),
        params: ['bins'],
    },
    'setSmooth': {
        detail: 'a.setSmooth(smooth)',
        documentation: [
            '**setSmooth** — Set FFT smoothing',
            '',
            '**Parameters:**',
            '- `smooth` — Smoothing factor (0 = none, ~0.9 = heavy)',
            '',
            '**Example:**',
            '```js',
            'a.setSmooth(0.8);',
            '```',
        ].join('\n'),
        params: ['smooth'],
    },
    'setCutoff': {
        detail: 'a.setCutoff(cutoff)',
        documentation: [
            '**setCutoff** — Set low-end noise cutoff',
            '',
            '**Parameters:**',
            '- `cutoff` — Minimum amplitude level (cuts background noise)',
            '',
            '**Example:**',
            '```js',
            'a.setCutoff(2);',
            '```',
        ].join('\n'),
        params: ['cutoff'],
    },
    'setScale': {
        detail: 'a.setScale(scale)',
        documentation: [
            '**setScale** — Scale FFT output values',
            '',
            '**Parameters:**',
            '- `scale` — Multiplier for all FFT values',
            '',
            '**Example:**',
            '```js',
            'a.setScale(5);',
            '```',
        ].join('\n'),
        params: ['scale'],
    },
    'initCam': {
        detail: 's0.initCam(index)',
        documentation: [
            '**initCam** — Initialise source from webcam',
            '',
            '**Parameters:**',
            '- `index` *(default 0)* — Camera device index',
            '',
            '**Example:**',
            '```js',
            's0.initCam();',
            'src(s0).out();',
            '```',
        ].join('\n'),
        params: ['index = 0'],
    },
    'initImage': {
        detail: 's0.initImage(url)',
        documentation: [
            '**initImage** — Load a static image as source',
            '',
            '**Parameters:**',
            '- `url` — URL or local path to the image',
            '',
            '**Example:**',
            '```js',
            's1.initImage(\'http://localhost:3000/files/my_image.jpg\');',
            'src(s1).out();',
            '```',
        ].join('\n'),
        params: ['url'],
    },
    'initVideo': {
        detail: 's0.initVideo(url)',
        documentation: [
            '**initVideo** — Load a video as source',
            '',
            '**Parameters:**',
            '- `url` — URL or local path to the video',
            '',
            '**Example:**',
            '```js',
            's0.initVideo(\'http://localhost:3000/files/my_video.mp4\');',
            'src(s0).out();',
            '```',
        ].join('\n'),
        params: ['url'],
    },
    'init': {
        detail: 's0.init(options)',
        documentation: [
            '**init** — Initialise source from a media stream',
            '',
            '**Parameters:**',
            '- `options` — Object with `src` property containing a `MediaStream`',
            '',
            '**Example:**',
            '```js',
            's0.init({ src: myStream });',
            'src(s0).out();',
            '```',
        ].join('\n'),
        params: ['options'],
    },
};

// render() global
const HYDRA_RENDER = {
    detail: 'render(output)',
    documentation: [
        '**render** — Render a buffer to the screen',
        '',
        '**Parameters:**',
        '- `output` *(default o0)* — Buffer to display: `o0`–`o3`',
        '',
        '**Example:**',
        '```js',
        'render(o0)',
        '```',
    ].join('\n'),
    params: ['output = o0'],
};

// Global variable hover docs (no params)
const HYDRA_GLOBALS_DOCS = {
    'o0': '**o0** — Hydra output buffer 0 (default output)',
    'o1': '**o1** — Hydra output buffer 1',
    'o2': '**o2** — Hydra output buffer 2',
    'o3': '**o3** — Hydra output buffer 3',
    's0': '**s0** — Hydra external source 0 (image / video / webcam)',
    's1': '**s1** — Hydra external source 1',
    's2': '**s2** — Hydra external source 2',
    's3': '**s3** — Hydra external source 3',
    'a':  '**a** — Hydra audio analyser\n\nUse `a.fft[n]` for FFT band values, and `a.setBins()`, `a.setSmooth()`, `a.setCutoff()`, `a.setScale()` to configure.',
};

// Flat lookup: name → { detail, documentation, params }
const ALL_API = {
    ...HYDRA_SOURCES,
    ...HYDRA_METHODS,
    ...HYDRA_AUDIO_METHODS,
    render: HYDRA_RENDER,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function md(text) {
    const ms = new vscode.MarkdownString(text);
    ms.isTrusted = true;
    return ms;
}

/**
 * Build a SnippetString from a param list like ['freq = 60', 'sync = 0.1'].
 * Produces `name(${1:60}, ${2:0.1})` so tab-stops land on each default value.
 */
function buildSnippet(name, params) {
    if (!params || params.length === 0) return `${name}($0)`;
    const args = params.map((p, i) => {
        const eqIdx = p.indexOf('=');
        const defaultVal = eqIdx >= 0 ? p.slice(eqIdx + 1).trim() : p.trim();
        return `\${${i + 1}:${defaultVal}}`;
    });
    return `${name}(${args.join(', ')})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

// Hydra items use sortText starting with '!' to appear above all other
// suggestions (JS built-ins, words, etc.).  The CompletionItemLabel object
// with a `description` field adds a "⬡ Hydra" tag on the right side of the
// dropdown so users can instantly tell Hydra items apart.

function hydraLabel(name, category) {
    return { label: name, description: `⬡ Hydra ${category}` };
}

function makeCompletionProvider() {
    return {
        provideCompletionItems(document, position) {
            const linePrefix = document.lineAt(position).text.slice(0, position.character);
            const afterDot   = /\.\s*\w*$/.test(linePrefix);

            // Extract the word prefix being typed for filtering
            const prefixMatch = afterDot
                ? linePrefix.match(/\.(\w*)$/)
                : linePrefix.match(/(\w+)$/);
            const typed = prefixMatch ? prefixMatch[1].toLowerCase() : '';

            // If nothing is being typed (and not after a dot), let AI take over
            if (!afterDot && typed.length === 0) return [];

            const items = [];

            if (afterDot) {
                // Method completions (chained calls)
                for (const [name, info] of Object.entries({ ...HYDRA_METHODS, ...HYDRA_AUDIO_METHODS })) {
                    if (typed.length > 0 && !name.toLowerCase().startsWith(typed)) continue;
                    const item = new vscode.CompletionItem(hydraLabel(name, 'method'), vscode.CompletionItemKind.Method);
                    item.detail        = info.detail;
                    item.documentation = md(info.documentation);
                    item.insertText    = new vscode.SnippetString(buildSnippet(name, info.params));
                    item.filterText    = name; // filter on the plain name
                    item.sortText      = '!' + name; // '!' sorts before any letter/digit
                    items.push(item);
                }
            } else {
                // Source / global completions (top of chain)
                for (const [name, info] of Object.entries(HYDRA_SOURCES)) {
                    if (!name.toLowerCase().startsWith(typed)) continue;
                    const item = new vscode.CompletionItem(hydraLabel(name, 'source'), vscode.CompletionItemKind.Function);
                    item.detail        = info.detail;
                    item.documentation = md(info.documentation);
                    item.insertText    = new vscode.SnippetString(buildSnippet(name, info.params));
                    item.filterText    = name;
                    item.sortText      = '!' + name;
                    items.push(item);
                }

                // render()
                if ('render'.startsWith(typed)) {
                    const renderItem = new vscode.CompletionItem(hydraLabel('render', 'global'), vscode.CompletionItemKind.Function);
                    renderItem.detail        = HYDRA_RENDER.detail;
                    renderItem.documentation = md(HYDRA_RENDER.documentation);
                    renderItem.insertText    = new vscode.SnippetString(buildSnippet('render', HYDRA_RENDER.params));
                    renderItem.filterText    = 'render';
                    renderItem.sortText      = '!render';
                    items.push(renderItem);
                }

                // Buffers and audio object
                for (const [name, doc] of Object.entries(HYDRA_GLOBALS_DOCS)) {
                    if (!name.toLowerCase().startsWith(typed)) continue;
                    const item = new vscode.CompletionItem(hydraLabel(name, 'buffer'), vscode.CompletionItemKind.Variable);
                    item.documentation = md(doc);
                    item.filterText    = name;
                    item.sortText      = '!' + name;
                    items.push(item);
                }
            }

            // Return a CompletionList; when empty, the suggest widget
            // closes immediately and Copilot inline suggestions can appear.
            return new vscode.CompletionList(items, false);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// HOVER PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

function makeHoverProvider() {
    return {
        provideHover(document, position) {
            const range = document.getWordRangeAtPosition(position, /\w+/);
            if (!range) return null;
            const word = document.getText(range);

            if (ALL_API[word]) {
                return new vscode.Hover(
                    [md(`\`\`\`\n${ALL_API[word].detail}\n\`\`\``), md(ALL_API[word].documentation)],
                    range
                );
            }
            if (HYDRA_GLOBALS_DOCS[word]) {
                return new vscode.Hover(md(HYDRA_GLOBALS_DOCS[word]), range);
            }
            return null;
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE HELP PROVIDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk backward from `offset` in `text` to find the innermost unclosed `(`.
 * Returns { funcName, activeParam } or null.
 */
function findSignatureContext(text, offset) {
    let depth = 0;
    let activeParam = 0;

    for (let i = offset - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === ')') {
            depth++;
        } else if (ch === '(') {
            if (depth > 0) {
                depth--;
                continue;
            }
            // Found the unmatched '(' — extract the function name before it
            const before = text.slice(0, i).match(/(\w+)\s*$/);
            if (!before) return null;
            return { funcName: before[1], activeParam };
        } else if (ch === ',' && depth === 0) {
            activeParam++;
        } else if (ch === '\n' && depth === 0) {
            // Don't look past the start of the current statement at depth 0
            break;
        }
    }
    return null;
}

function makeSignatureProvider() {
    return {
        provideSignatureHelp(document, position) {
            const text   = document.getText();
            const offset = document.offsetAt(position);
            const ctx    = findSignatureContext(text, offset);
            if (!ctx) return null;

            const info = ALL_API[ctx.funcName];
            if (!info || !info.params || info.params.length === 0) return null;

            // Build the full label, e.g. "osc(freq = 60, sync = 0.1, offset = 0)"
            const label      = info.detail.replace(/\s*→.*$/, '').trim(); // strip "→ Source"
            const parameters = info.params.map(p => ({ label: p }));

            const sig = new vscode.SignatureInformation(label, md(info.documentation));
            sig.parameters = parameters.map(p => {
                const pi = new vscode.ParameterInformation(p.label);
                return pi;
            });

            const help = new vscode.SignatureHelp();
            help.signatures    = [sig];
            help.activeSignature = 0;
            help.activeParameter = Math.min(ctx.activeParam, Math.max(0, info.params.length - 1));
            return help;
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

const JS_SELECTOR = [{ scheme: 'file', language: 'javascript' }];

function registerHydraProviders(context) {
    context.subscriptions.push(
        // Completions – triggered by '.' (methods) and normal word-start (sources)
        vscode.languages.registerCompletionItemProvider(
            JS_SELECTOR,
            makeCompletionProvider(),
            '.'
        ),

        // Hover docs on any Hydra identifier
        vscode.languages.registerHoverProvider(
            JS_SELECTOR,
            makeHoverProvider()
        ),

        // Signature / argument help – triggered by '(' and ','
        vscode.languages.registerSignatureHelpProvider(
            JS_SELECTOR,
            makeSignatureProvider(),
            '(', ','
        )
    );
    console.log('[envil] Hydra language providers registered (hover + completion + signature help)');
}

module.exports = { registerHydraProviders, findSignatureContext };
