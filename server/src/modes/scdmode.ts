/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CompletionItem,
	CompletionItemKind,
	CompletionList,
	Hover,
	MarkupKind,
	Position,
	SignatureHelp,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languagemodes';

// SuperCollider keywords
const SC_KEYWORDS = [
	'var', 'arg', 'classvar', 'const',
	'if', 'while', 'for', 'forBy', 'do', 'loop',
	'case', 'switch',
	'collect', 'select', 'reject', 'detect', 'any', 'every',
	'true', 'false', 'nil', 'inf', 'pi',
	'this', 'super', 'thisProcess', 'thisThread', 'thisFunction', 'thisFunctionDef', 'thisMethod'
];

// Documentation for keywords
const KEYWORD_DOCS: { [key: string]: string } = {
	'var': '**var** - Declare a local variable\n\n```supercollider\nvar freq = 440, amp = 0.5;\n```',
	'arg': '**arg** - Declare a function argument\n\n```supercollider\n{ arg freq = 440, amp = 0.5; ... }\n```',
	'classvar': '**classvar** - Declare a class variable (shared across all instances)\n\n```supercollider\nclassvar <>default;\n```',
	'const': '**const** - Declare a constant value',
	'if': '**if** - Conditional expression\n\n```supercollider\nif(condition, { trueFunc }, { falseFunc })\n```',
	'while': '**while** - While loop\n\n```supercollider\nwhile({ condition }, { body })\n```',
	'for': '**for** - For loop over integer range\n\n```supercollider\nfor(start, end, { |i| ... })\n```',
	'forBy': '**forBy** - For loop with step\n\n```supercollider\nforBy(start, end, step, { |i| ... })\n```',
	'do': '**do** - Iterate over collection\n\n```supercollider\ncollection.do { |item, index| ... }\n```',
	'loop': '**loop** - Infinite loop\n\n```supercollider\nloop { ... }\n```',
	'case': '**case** - Multiple condition branching\n\n```supercollider\ncase\n  { cond1 } { result1 }\n  { cond2 } { result2 }\n```',
	'switch': '**switch** - Value-based branching\n\n```supercollider\nswitch(value,\n  val1, { result1 },\n  val2, { result2 }\n)\n```',
	'collect': '**collect** - Transform each element\n\n```supercollider\n[1,2,3].collect { |x| x * 2 } // [2,4,6]\n```',
	'select': '**select** - Filter elements matching condition\n\n```supercollider\n[1,2,3,4].select { |x| x.even } // [2,4]\n```',
	'reject': '**reject** - Filter elements not matching condition\n\n```supercollider\n[1,2,3,4].reject { |x| x.even } // [1,3]\n```',
	'detect': '**detect** - Find first matching element\n\n```supercollider\n[1,2,3,4].detect { |x| x > 2 } // 3\n```',
	'any': '**any** - Check if any element matches\n\n```supercollider\n[1,2,3].any { |x| x > 2 } // true\n```',
	'every': '**every** - Check if all elements match\n\n```supercollider\n[1,2,3].every { |x| x > 0 } // true\n```',
	'true': '**true** - Boolean true value',
	'false': '**false** - Boolean false value',
	'nil': '**nil** - Represents no value / null',
	'inf': '**inf** - Positive infinity (Float)',
	'pi': '**pi** - Mathematical constant π (3.14159...)',
	'this': '**this** - Reference to current instance',
	'super': '**super** - Reference to superclass',
	'thisProcess': '**thisProcess** - Current interpreter process',
	'thisThread': '**thisThread** - Current thread / routine',
	'thisFunction': '**thisFunction** - Current function being executed',
	'thisFunctionDef': '**thisFunctionDef** - Current function definition',
	'thisMethod': '**thisMethod** - Current method being executed'
};

// Documentation for classes
const CLASS_DOCS: { [key: string]: string } = {
	// Oscillators
	'SinOsc': '**SinOsc** - Sine wave oscillator\n\n```supercollider\nSinOsc.ar(freq: 440, phase: 0, mul: 1, add: 0)\nSinOsc.kr(freq: 1, phase: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - Frequency in Hz\n- `phase` - Initial phase (0-2π)\n- `mul` - Output multiplier\n- `add` - Value added to output',
	'Saw': '**Saw** - Band-limited sawtooth oscillator\n\n```supercollider\nSaw.ar(freq: 440, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - Frequency in Hz\n- `mul` - Output multiplier\n- `add` - Value added to output',
	'Pulse': '**Pulse** - Band-limited pulse wave oscillator\n\n```supercollider\nPulse.ar(freq: 440, width: 0.5, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - Frequency in Hz\n- `width` - Pulse width (0-1)\n- `mul` - Output multiplier',
	'LFSaw': '**LFSaw** - Non-band-limited sawtooth (for LFO use)\n\n```supercollider\nLFSaw.ar(freq: 440, iphase: 0, mul: 1, add: 0)\n```',
	'LFPulse': '**LFPulse** - Non-band-limited pulse wave (for LFO use)\n\n```supercollider\nLFPulse.ar(freq: 440, iphase: 0, width: 0.5, mul: 1, add: 0)\n```',
	'LFNoise0': '**LFNoise0** - Step noise (sample & hold)\n\n```supercollider\nLFNoise0.ar(freq: 500, mul: 1, add: 0)\n```',
	'LFNoise1': '**LFNoise1** - Linear interpolated noise\n\n```supercollider\nLFNoise1.ar(freq: 500, mul: 1, add: 0)\n```',
	'LFNoise2': '**LFNoise2** - Quadratic interpolated noise\n\n```supercollider\nLFNoise2.ar(freq: 500, mul: 1, add: 0)\n```',
	'Blip': '**Blip** - Band-limited impulse train (harmonic series)\n\n```supercollider\nBlip.ar(freq: 440, numharm: 200, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - Frequency in Hz\n- `numharm` - Number of harmonics',
	'Formant': '**Formant** - Formant oscillator\n\n```supercollider\nFormant.ar(fundfreq: 200, formfreq: 800, bwfreq: 400, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `fundfreq` - Fundamental frequency\n- `formfreq` - Formant frequency\n- `bwfreq` - Bandwidth frequency',
	'Klang': '**Klang** - Bank of sine oscillators\n\n```supercollider\nKlang.ar(specificationsArrayRef, freqscale: 1, freqoffset: 0, phasescale: 0)\n```',
	'VOsc': '**VOsc** - Variable wavetable oscillator\n\n```supercollider\nVOsc.ar(bufpos: 0, freq: 440, mul: 1, add: 0)\n```',
	'VOsc3': '**VOsc3** - Three variable wavetable oscillators\n\n```supercollider\nVOsc3.ar(bufpos: 0, freq1: 440, freq2: 441, freq3: 442, mul: 1, add: 0)\n```',
	'FSinOsc': '**FSinOsc** - Fast sine oscillator\n\n```supercollider\nFSinOsc.ar(freq: 440, iphase: 0, mul: 1, add: 0)\n```',
	'PMOsc': '**PMOsc** - Phase modulation oscillator\n\n```supercollider\nPMOsc.ar(carfreq: 440, modfreq: 200, pmindex: 0, modphase: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `carfreq` - Carrier frequency\n- `modfreq` - Modulator frequency\n- `pmindex` - Phase modulation index',
	'COsc': '**COsc** - Chorused wavetable oscillator\n\n```supercollider\nCOsc.ar(bufnum: 0, freq: 440, beats: 0.5, mul: 1, add: 0)\n```',
	'Gendy1': '**Gendy1** - Dynamic stochastic synthesis\n\n```supercollider\nGendy1.ar(ampdist: 1, durdist: 1, adparam: 1, ddparam: 1, minfreq: 20, maxfreq: 1000, ampscale: 0.5, durscale: 0.5, initCPs: 12, knum: 12, mul: 1, add: 0)\n```',
	'Gendy2': '**Gendy2** - Dynamic stochastic synthesis (improved)\n\n```supercollider\nGendy2.ar(ampdist: 1, durdist: 1, adparam: 1, ddparam: 1, minfreq: 20, maxfreq: 1000, ampscale: 0.5, durscale: 0.5, initCPs: 12, knum: 12, mul: 1, add: 0)\n```',
	'Gendy3': '**Gendy3** - Dynamic stochastic synthesis (memory)\n\n```supercollider\nGendy3.ar(ampdist: 1, durdist: 1, adparam: 1, ddparam: 1, minfreq: 20, maxfreq: 1000, ampscale: 0.5, durscale: 0.5, initCPs: 12, knum: 12, mul: 1, add: 0)\n```',

	// Noise
	'WhiteNoise': '**WhiteNoise** - White noise generator\n\n```supercollider\nWhiteNoise.ar(mul: 1, add: 0)\n```',
	'PinkNoise': '**PinkNoise** - Pink noise (1/f spectrum)\n\n```supercollider\nPinkNoise.ar(mul: 1, add: 0)\n```',
	'BrownNoise': '**BrownNoise** - Brown noise (1/f² spectrum)\n\n```supercollider\nBrownNoise.ar(mul: 1, add: 0)\n```',
	'ClipNoise': '**ClipNoise** - Clipped noise (random -1 or +1)\n\n```supercollider\nClipNoise.ar(mul: 1, add: 0)\n```',
	'GrayNoise': '**GrayNoise** - Gray noise (random -1 to +1)\n\n```supercollider\nGrayNoise.ar(mul: 1, add: 0)\n```',
	'Dust': '**Dust** - Random impulses (0 to +1)\n\n```supercollider\nDust.ar(density: 1, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `density` - Average impulses per second',
	'Dust2': '**Dust2** - Random impulses (-1 to +1)\n\n```supercollider\nDust2.ar(density: 1, mul: 1, add: 0)\n```',
	'Crackle': '**Crackle** - Chaotic noise generator\n\n```supercollider\nCrackle.ar(chaosParam: 1.5, mul: 1, add: 0)\n```',
	'Logistic': '**Logistic** - Chaotic map generator\n\n```supercollider\nLogistic.ar(chaosParam: 3, freq: 1000, init: 0.5, mul: 1, add: 0)\n```',
	'Impulse': '**Impulse** - Non-band-limited impulse oscillator\n\n```supercollider\nImpulse.ar(freq: 440, phase: 0, mul: 1, add: 0)\n```',

	// Triggers (from Trig.sc)
	'Stepper': '**Stepper** - Trigger-based counter\n\n```supercollider\nStepper.ar(trig, reset: 0, min: 0, max: 7, step: 1, resetval: 0)\nStepper.kr(trig, reset: 0, min: 0, max: 7, step: 1, resetval: 0)\n```\n\n**Arguments:**\n- `trig` - Trigger signal (increments counter)\n- `reset` - Reset trigger (resets to resetval)\n- `min` - Minimum value\n- `max` - Maximum value\n- `step` - Step size (default: 1)\n- `resetval` - Value to reset to (default: 0)',
	'PulseDivider': '**PulseDivider** - Divide trigger stream\n\n```supercollider\nPulseDivider.ar(trig, div: 2, start: 0)\nPulseDivider.kr(trig, div: 2, start: 0)\n```\n\n**Arguments:**\n- `trig` - Input trigger signal\n- `div` - Division factor (output every nth trigger)\n- `start` - Starting count value (default: 0)',
	'Trig1': '**Trig1** - Trigger hold (1 sample)\n\n```supercollider\nTrig1.ar(in, dur: 0.1)\nTrig1.kr(in, dur: 0.1)\n```',
	'TDelay': '**TDelay** - Trigger delay\n\n```supercollider\nTDelay.ar(trig, delaytime: 0.1)\nTDelay.kr(trig, delaytime: 0.1)\n```',
	'TDuty': '**TDuty** - Time-based duty cycle\n\n```supercollider\nTDuty.ar(dur: 0.1, reset: 0, level: 1, doneAction: 0, gapFirst: 0)\nTDuty.kr(dur: 0.1, reset: 0, level: 1, doneAction: 0, gapFirst: 0)\n```',
	'SendTrig': '**SendTrig** - Send trigger to client\n\n```supercollider\nSendTrig.ar(in, id: 0, value: 0)\nSendTrig.kr(in, id: 0, value: 0)\n```',
	'Latch': '**Latch** - Sample and hold\n\n```supercollider\nLatch.ar(in, trig)\nLatch.kr(in, trig)\n```',
	'Gate': '**Gate** - Gate signal\n\n```supercollider\nGate.ar(in, gate: 1)\nGate.kr(in, gate: 1)\n```',
	'Trig': '**Trig** - Trigger hold\n\n```supercollider\nTrig.ar(in, dur: 0.1)\nTrig.kr(in, dur: 0.1)\n```',
	'Timer': '**Timer** - Time since last trigger\n\n```supercollider\nTimer.ar(trig)\nTimer.kr(trig)\n```',
	'Sweep': '**Sweep** - Triggered linear ramp\n\n```supercollider\nSweep.ar(trig, rate: 1)\nSweep.kr(trig, rate: 1)\n```',
	'Phasor': '**Phasor** - Phase ramp generator\n\n```supercollider\nPhasor.ar(trig: 0, rate: 1, start: 0, end: 1, resetPos: 0)\nPhasor.kr(trig: 0, rate: 1, start: 0, end: 1, resetPos: 0)\n```',
	'Peak': '**Peak** - Track peak amplitude\n\n```supercollider\nPeak.ar(in, trig: 0)\nPeak.kr(in, trig: 0)\n```',
	'RunningMin': '**RunningMin** - Track minimum value\n\n```supercollider\nRunningMin.ar(in, trig: 0)\nRunningMin.kr(in, trig: 0)\n```',
	'RunningMax': '**RunningMax** - Track maximum value\n\n```supercollider\nRunningMax.ar(in, trig: 0)\nRunningMax.kr(in, trig: 0)\n```',

	// Filters
	'LPF': '**LPF** - 2nd order Butterworth low pass filter\n\n```supercollider\nLPF.ar(in, freq: 440, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - Input signal\n- `freq` - Cutoff frequency in Hz',
	'HPF': '**HPF** - 2nd order Butterworth high pass filter\n\n```supercollider\nHPF.ar(in, freq: 440, mul: 1, add: 0)\n```',
	'BPF': '**BPF** - 2nd order Butterworth band pass filter\n\n```supercollider\nBPF.ar(in, freq: 440, rq: 1, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - Input signal\n- `freq` - Center frequency\n- `rq` - Reciprocal of Q (bandwidth/centerFreq)',
	'RLPF': '**RLPF** - Resonant low pass filter\n\n```supercollider\nRLPF.ar(in, freq: 440, rq: 1, mul: 1, add: 0)\n```',
	'RHPF': '**RHPF** - Resonant high pass filter\n\n```supercollider\nRHPF.ar(in, freq: 440, rq: 1, mul: 1, add: 0)\n```',
	'Resonz': '**Resonz** - Resonant filter\n\n```supercollider\nResonz.ar(in, freq: 440, bwr: 1, mul: 1, add: 0)\n```',
	'BRF': '**BRF** - 2nd order Butterworth band reject filter\n\n```supercollider\nBRF.ar(in, freq: 440, rq: 1, mul: 1, add: 0)\n```',
	'Ringz': '**Ringz** - Ringing filter\n\n```supercollider\nRingz.ar(in, freq: 440, decaytime: 1, mul: 1, add: 0)\n```',
	'Formlet': '**Formlet** - Formant filter\n\n```supercollider\nFormlet.ar(in, freq: 440, attacktime: 1, decaytime: 1, mul: 1, add: 0)\n```',
	'Median': '**Median** - Median filter\n\n```supercollider\nMedian.ar(length: 3, in, mul: 1, add: 0)\n```',

	'MoogFF': '**MoogFF** - Moog-style low pass filter\n\n```supercollider\nMoogFF.ar(in, freq: 440, gain: 2, reset: 0, mul: 1, add: 0)\n```',
	'DFM1': '**DFM1** *(sc3-plugins)* - Digitally modeled analog filter (12dB/oct LP or 6dB/oct HP)\n\n```supercollider\nDFM1.ar(in, freq: 1000, res: 0.1, inputgain: 1, type: 0, noiselevel: 0.0003)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - cutoff frequency\n- `res` - resonance (>1 may self-oscillate)\n- `inputgain` - input gain (drive for distortion)\n- `type` - 0=lowpass, 1=highpass\n- `noiselevel` - internal noise level',
	'FOS': '**FOS** - First order section filter\n\n```supercollider\nFOS.ar(in, a0: 0, a1: 0, b1: 0, mul: 1, add: 0)\n```',
	'SOS': '**SOS** - Second order section filter\n\n```supercollider\nSOS.ar(in, a0: 0, a1: 0, a2: 0, b1: 0, b2: 0, mul: 1, add: 0)\n```',
	'TwoPole': '**TwoPole** - Two pole filter\n\n```supercollider\nTwoPole.ar(in, freq: 440, radius: 0.8, mul: 1, add: 0)\n```',
	'TwoZero': '**TwoZero** - Two zero filter\n\n```supercollider\nTwoZero.ar(in, freq: 440, radius: 0.8, mul: 1, add: 0)\n```',
	'OnePole': '**OnePole** - One pole filter\n\n```supercollider\nOnePole.ar(in, coef: 0.5, mul: 1, add: 0)\n```',
	'OneZero': '**OneZero** - One zero filter\n\n```supercollider\nOneZero.ar(in, coef: 0.5, mul: 1, add: 0)\n```',
	'Integrator': '**Integrator** - Leaky integrator\n\n```supercollider\nIntegrator.ar(in, coef: 1, mul: 1, add: 0)\n```',
	'LeakDC': '**LeakDC** - Remove DC offset\n\n```supercollider\nLeakDC.ar(in, coef: 0.995, mul: 1, add: 0)\n```',

	// Reverb & Delay
	'FreeVerb': '**FreeVerb** - Schroeder reverb\n\n```supercollider\nFreeVerb.ar(in, mix: 0.33, room: 0.5, damp: 0.5, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - Input signal\n- `mix` - Dry/wet mix (0-1)\n- `room` - Room size (0-1)\n- `damp` - High frequency damping (0-1)',
	'DelayN': '**DelayN** - Simple delay (no interpolation)\n\n```supercollider\nDelayN.ar(in, maxdelaytime: 0.2, delaytime: 0.2, mul: 1, add: 0)\n```',
	'DelayL': '**DelayL** - Delay with linear interpolation\n\n```supercollider\nDelayL.ar(in, maxdelaytime: 0.2, delaytime: 0.2, mul: 1, add: 0)\n```',
	'CombN': '**CombN** - Comb delay (feedback delay)\n\n```supercollider\nCombN.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'AllpassN': '**AllpassN** - Allpass delay (for diffusion)\n\n```supercollider\nAllpassN.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'DelayC': '**DelayC** - Delay with cubic interpolation\n\n```supercollider\nDelayC.ar(in, maxdelaytime: 0.2, delaytime: 0.2, mul: 1, add: 0)\n```',
	'AllpassL': '**AllpassL** - Allpass delay with linear interpolation\n\n```supercollider\nAllpassL.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'AllpassC': '**AllpassC** - Allpass delay with cubic interpolation\n\n```supercollider\nAllpassC.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'CombL': '**CombL** - Comb delay with linear interpolation\n\n```supercollider\nCombL.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'CombC': '**CombC** - Comb delay with cubic interpolation\n\n```supercollider\nCombC.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'GVerb': '**GVerb** - GVerb reverb\n\n```supercollider\nGVerb.ar(in, roomsize: 10, revtime: 3, damping: 0.5, inputbw: 0.5, spread: 15, drylevel: 1, earlyreflevel: 0.7, taillevel: 0.5, maxroomsize: 300, mul: 1, add: 0)\n```',
	'PitchShift': '**PitchShift** - Pitch shifter\n\n```supercollider\nPitchShift.ar(in, windowSize: 0.2, pitchRatio: 1, pitchDispersion: 0, timeDispersion: 0, mul: 1, add: 0)\n```',
	'Pitch': '**Pitch** - Pitch tracker [2 outputs: freq, hasFreq]\n\n```supercollider\nPitch.kr(in, initFreq: 440, minFreq: 60, maxFreq: 4000, execFreq: 100, maxBinsPerOctave: 16, median: 1, ampThreshold: 0.01, peakThreshold: 0.5, downSample: 1, clar: 0)\n```',
	'FreqShift': '**FreqShift** - Frequency shifter\n\n```supercollider\nFreqShift.ar(in, freq: 0, phase: 0, mul: 1, add: 0)\n```',
	'PV_MagAbove': '**PV_MagAbove** - FFT magnitude threshold\n\n```supercollider\nPV_MagAbove(buffer, threshold: 0)\n```',
	'PV_MagBelow': '**PV_MagBelow** - FFT magnitude threshold (below)\n\n```supercollider\nPV_MagBelow(buffer, threshold: 0)\n```',
	'PV_MagClip': '**PV_MagClip** - Clip FFT magnitude\n\n```supercollider\nPV_MagClip(buffer, threshold: 0)\n```',
	'PV_MagSmooth': '**PV_MagSmooth** - Smooth FFT magnitude\n\n```supercollider\nPV_MagSmooth(buffer, factor: 0.5)\n```',
	'PV_MagMul': '**PV_MagMul** - Multiply FFT magnitudes\n\n```supercollider\nPV_MagMul(bufferA, bufferB)\n```',
	'PV_MagDiv': '**PV_MagDiv** - Divide FFT magnitudes\n\n```supercollider\nPV_MagDiv(bufferA, bufferB)\n```',
	'PV_PhaseShift90': '**PV_PhaseShift90** - Phase shift by 90 degrees\n\n```supercollider\nPV_PhaseShift90(buffer)\n```',
	'PV_PhaseShift270': '**PV_PhaseShift270** - Phase shift by 270 degrees\n\n```supercollider\nPV_PhaseShift270(buffer)\n```',
	'PV_BinShift': '**PV_BinShift** - Shift FFT bins\n\n```supercollider\nPV_BinShift(buffer, stretch: 1, shift: 0)\n```',
	'PV_BinScramble': '**PV_BinScramble** - Scramble FFT bins\n\n```supercollider\nPV_BinScramble(buffer, wipe: 0, width: 0.2, trig: 0)\n```',
	'PV_BrickWall': '**PV_BrickWall** - Zero bins above threshold\n\n```supercollider\nPV_BrickWall(buffer, wipe: 0)\n```',
	'PV_MagSquared': '**PV_MagSquared** - Square FFT magnitude\n\n```supercollider\nPV_MagSquared(buffer)\n```',
	'PV_MagNoise': '**PV_MagNoise** - Add noise to FFT magnitude\n\n```supercollider\nPV_MagNoise(buffer, amount: 0)\n```',
	'PV_RandComb': '**PV_RandComb** - Random comb filter\n\n```supercollider\nPV_RandComb(buffer, wipe: 0, trig: 0)\n```',
	'PV_RectComb': '**PV_RectComb** - Rectangular comb filter\n\n```supercollider\nPV_RectComb(buffer, numTeeth: 0, phase: 0, width: 0.5)\n```',
	'PV_RectComb2': '**PV_RectComb2** - Rectangular comb filter (2)\n\n```supercollider\nPV_RectComb2(bufferA, bufferB, numTeeth: 0, phase: 0, width: 0.5)\n```',
	'PV_CopyPhase': '**PV_CopyPhase** - Copy phase from one FFT to another\n\n```supercollider\nPV_CopyPhase(bufferA, bufferB)\n```',
	'PV_Max': '**PV_Max** - Maximum of two FFTs\n\n```supercollider\nPV_Max(bufferA, bufferB)\n```',
	'PV_Min': '**PV_Min** - Minimum of two FFTs\n\n```supercollider\nPV_Min(bufferA, bufferB)\n```',
	'PV_Add': '**PV_Add** - Add two FFTs\n\n```supercollider\nPV_Add(bufferA, bufferB)\n```',
	'PV_Mul': '**PV_Mul** - Multiply two FFTs\n\n```supercollider\nPV_Mul(bufferA, bufferB)\n```',
	'PV_Div': '**PV_Div** - Divide two FFTs\n\n```supercollider\nPV_Div(bufferA, bufferB)\n```',
	'FFT': '**FFT** - Fast Fourier Transform\n\n```supercollider\nFFT(buffer, in, hop: 0.5, wintype: 0, active: 1, winsize: 0)\n```',
	'IFFT': '**IFFT** - Inverse Fast Fourier Transform\n\n```supercollider\nIFFT.ar(buffer, wintype: 0, winsize: 0)\n```',

	// Panning
	'Pan2': '**Pan2** - Stereo panner\n\n```supercollider\nPan2.ar(in, pos: 0, level: 1)\n```\n\n**Arguments:**\n- `in` - Input signal (mono)\n- `pos` - Pan position (-1 left, 0 center, +1 right)\n- `level` - Output amplitude',
	'Splay': '**Splay** - Spread channels across stereo field\n\n```supercollider\nSplay.ar(inArray, spread: 1, level: 1, center: 0, levelComp: true)\n```',
	'Balance2': '**Balance2** - Stereo balancer\n\n```supercollider\nBalance2.ar(left, right, pos: 0, level: 1)\n```',
	'LinPan2': '**LinPan2** - Linear stereo panner\n\n```supercollider\nLinPan2.ar(in, pos: 0, level: 1)\n```',
	'Pan4': '**Pan4** - Four channel panner\n\n```supercollider\nPan4.ar(in, xpos: 0, ypos: 0, level: 1)\n```',
	'PanAz': '**PanAz** - Ambisonic panner\n\n```supercollider\nPanAz.ar(numChans: 4, in, pos: 0, level: 1, width: 2, orientation: 0.5)\n```',
	'Rotate2': '**Rotate2** - Rotate two channels\n\n```supercollider\nRotate2.ar(x, y, pos: 0)\n```',
	'XFade2': '**XFade2** - Crossfade between two signals\n\n```supercollider\nXFade2.ar(inA, inB, pan: 0, level: 1)\n```',

	// Envelopes
	'EnvGen': '**EnvGen** - Envelope generator\n\n```supercollider\nEnvGen.ar(envelope, gate: 1, levelScale: 1, levelBias: 0, timeScale: 1, doneAction: 0)\nEnvGen.kr(envelope, gate: 1, levelScale: 1, levelBias: 0, timeScale: 1, doneAction: 0)\n```\n\n**Arguments:**\n- `envelope` - An Env instance\n- `gate` - Trigger/gate signal\n- `doneAction` - Action when envelope completes (2 = free synth)',
	'Env': '**Env** - Envelope specification\n\n```supercollider\nEnv.new(levels, times, curves)\nEnv.perc(attackTime: 0.01, releaseTime: 1, level: 1, curve: -4)\nEnv.adsr(attackTime: 0.01, decayTime: 0.3, sustainLevel: 0.5, releaseTime: 1)\nEnv.asr(attackTime: 0.01, sustainLevel: 1, releaseTime: 1)\nEnv.linen(attackTime: 0.01, sustainTime: 1, releaseTime: 1, level: 1)\n```',
	'Line': '**Line** - Line generator\n\n```supercollider\nLine.ar(start: 0, end: 1, dur: 1, mul: 1, add: 0, doneAction: 0)\n```',
	'XLine': '**XLine** - Exponential line generator\n\n```supercollider\nXLine.ar(start: 1, end: 2, dur: 1, mul: 1, add: 0, doneAction: 0)\n```',
	'Linen': '**Linen** - Linear envelope\n\n```supercollider\nLinen.ar(gate: 1, attackTime: 0.01, sustainLevel: 1, releaseTime: 1, doneAction: 0)\n```',

	'VarLag': '**VarLag** - Variable lag\n\n```supercollider\nVarLag.ar(in, time: 0.1, curvature: 0, warp: 5, startVal: 0)\nVarLag.kr(in, time: 0.1, curvature: 0, warp: 5, startVal: 0)\n```',

	// Buffers
	'Buffer': '**Buffer** - Buffer for audio data\n\n```supercollider\nBuffer.alloc(server, numFrames, numChannels: 1, completionMessage)\nBuffer.read(server, path, startFrame: 0, numFrames: -1, action, bufnum)\n```',
	'PlayBuf': '**PlayBuf** - Play audio from buffer\n\n```supercollider\nPlayBuf.ar(numChannels, bufnum: 0, rate: 1, trigger: 1, startPos: 0, loop: 0, doneAction: 0)\n```',
	'RecordBuf': '**RecordBuf** - Record audio to buffer\n\n```supercollider\nRecordBuf.ar(inputArray, bufnum: 0, offset: 0, recLevel: 1, preLevel: 0, run: 1, loop: 1, trigger: 1, doneAction: 0)\n```',
	'BufRd': '**BufRd** - Read from buffer\n\n```supercollider\nBufRd.ar(numChannels: 1, bufnum: 0, phase: 0, loop: 1, interpolation: 2)\n```',
	'BufWr': '**BufWr** - Write to buffer\n\n```supercollider\nBufWr.ar(inputArray, bufnum: 0, phase: 0, loop: 1)\n```',
	'BufDelayN': '**BufDelayN** - Buffer delay (no interpolation)\n\n```supercollider\nBufDelayN.ar(bufnum: 0, in, delaytime: 0.2, mul: 1, add: 0)\n```',
	'BufDelayL': '**BufDelayL** - Buffer delay (linear interpolation)\n\n```supercollider\nBufDelayL.ar(bufnum: 0, in, delaytime: 0.2, mul: 1, add: 0)\n```',
	'BufDelayC': '**BufDelayC** - Buffer delay (cubic interpolation)\n\n```supercollider\nBufDelayC.ar(bufnum: 0, in, delaytime: 0.2, mul: 1, add: 0)\n```',
	'BufCombN': '**BufCombN** - Buffer comb filter\n\n```supercollider\nBufCombN.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'BufCombL': '**BufCombL** - Buffer comb filter (linear)\n\n```supercollider\nBufCombL.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'BufCombC': '**BufCombC** - Buffer comb filter (cubic)\n\n```supercollider\nBufCombC.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'BufAllpassN': '**BufAllpassN** - Buffer allpass filter\n\n```supercollider\nBufAllpassN.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'BufAllpassL': '**BufAllpassL** - Buffer allpass filter (linear)\n\n```supercollider\nBufAllpassL.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'BufAllpassC': '**BufAllpassC** - Buffer allpass filter (cubic)\n\n```supercollider\nBufAllpassC.ar(bufnum: 0, in, delaytime: 0.2, decaytime: 1, mul: 1, add: 0)\n```',
	'GrainBuf': '**GrainBuf** - Granular synthesis from buffer\n\n```supercollider\nGrainBuf.ar(numChannels: 1, trigger: 0, dur: 0.1, sndbuf: 0, rate: 1, pos: 0, interp: 2, pan: 0, envbufnum: -1, mul: 1, add: 0)\n```',
	'GrainIn': '**GrainIn** - Granular synthesis from input\n\n```supercollider\nGrainIn.ar(numChannels: 1, trigger: 0, dur: 0.1, in, pan: 0, envbufnum: -1, mul: 1, add: 0)\n```',
	'Warp1': '**Warp1** - Warp granular synthesis\n\n```supercollider\nWarp1.ar(numChannels: 1, bufnum: 0, pointer: 0, freqScale: 1, windowSize: 0.2, envbufnum: -1, overlaps: 8, windowRandRatio: 0, interp: 1, mul: 1, add: 0)\n```',
	'VOSIM': '**VOSIM** *(sc3-plugins)* - Voice simulation (pulse train with formant)\n\n```supercollider\nVOSIM.ar(trig, freq: 400, nCycles: 3, decay: 0.9)\n```\n\n**Arguments:**\n- `trig` - trigger\n- `freq` - formant frequency\n- `nCycles` - number of cycles per pulse\n- `decay` - decay factor per cycle',
	'Shaper': '**Shaper** - Waveshaper using buffer\n\n```supercollider\nShaper.ar(bufnum: 0, in, mul: 1, add: 0)\n```',
	'Convolution': '**Convolution** - Convolution reverb\n\n```supercollider\nConvolution.ar(in, kernel: 0, framesize: 512, mul: 1, add: 0)\n```',
	'Convolution2': '**Convolution2** - Convolution reverb (2)\n\n```supercollider\nConvolution2.ar(in, kernel: 0, trigger: 0, framesize: 512, mul: 1, add: 0)\n```',
	'Convolution3': '**Convolution3** - Convolution reverb (3)\n\n```supercollider\nConvolution3.ar(in, kernel: 0, trigger: 0, framesize: 512, mul: 1, add: 0)\n```',
	'PartConv': '**PartConv** - Partitioned convolution\n\n```supercollider\nPartConv.ar(in, fftsize: 2048, irbufnum: 0, mul: 1, add: 0)\n```',

	// I/O
	'Out': '**Out** - Write signal to bus\n\n```supercollider\nOut.ar(bus, channelsArray)\nOut.kr(bus, channelsArray)\n```\n\n**Arguments:**\n- `bus` - Bus index to write to\n- `channelsArray` - Signal or array of signals',
	'In': '**In** - Read signal from bus\n\n```supercollider\nIn.ar(bus, numChannels: 1)\nIn.kr(bus, numChannels: 1)\n```',
	'LocalIn': '**LocalIn** - Read from local bus (for feedback)\n\n```supercollider\nLocalIn.ar(numChannels: 1, default: 0)\n```',
	'LocalOut': '**LocalOut** - Write to local bus (for feedback)\n\n```supercollider\nLocalOut.ar(channelsArray)\n```',
	'ReplaceOut': '**ReplaceOut** - Replace bus contents\n\n```supercollider\nReplaceOut.ar(bus, channelsArray)\nReplaceOut.kr(bus, channelsArray)\n```',
	'XOut': '**XOut** - Crossfade output\n\n```supercollider\nXOut.ar(bus, xfade: 0, channelsArray)\nXOut.kr(bus, xfade: 0, channelsArray)\n```',
	'OffsetOut': '**OffsetOut** - Offset output\n\n```supercollider\nOffsetOut.ar(bus, channelsArray)\nOffsetOut.kr(bus, channelsArray)\n```',
	'CheckBadValues': '**CheckBadValues** - Check for NaN/Inf\n\n```supercollider\nCheckBadValues.ar(in, id: 0, post: 2)\nCheckBadValues.kr(in, id: 0, post: 2)\n```',
	'Poll': '**Poll** - Poll UGen values\n\n```supercollider\nPoll.ar(trig: 0, in, label: "", trigid: -1)\nPoll.kr(trig: 0, in, label: "", trigid: -1)\n```',
	'ScopeOut': '**ScopeOut** - Write to scope buffer\n\n```supercollider\nScopeOut.ar(inputArray, bufnum: 0)\n```',
	'ScopeOut2': '**ScopeOut2** - Write to scope buffer (2)\n\n```supercollider\nScopeOut2.ar(inputArray, bufnum: 0)\n```',

	// Server & Synths
	'Server': '**Server** - Represents a SuperCollider server\n\n```supercollider\nServer.default\nServer.local\ns.boot\ns.quit\n```',
	'SynthDef': '**SynthDef** - Synth definition\n\n```supercollider\nSynthDef(\\name, { arg out = 0, freq = 440;\n    var sig = SinOsc.ar(freq);\n    Out.ar(out, sig);\n}).add;\n```',
	'Synth': '**Synth** - Create a synth instance\n\n```supercollider\nSynth(\\defName, [\\param, value, ...])\nSynth(\\defName, [\\param, value], target, addAction)\n```',
	'Group': '**Group** - Container for synths\n\n```supercollider\nGroup.new(target, addAction: \\addToHead)\n```',
	'Bus': '**Bus** - Audio or control bus\n\n```supercollider\nBus.audio(server, numChannels: 1)\nBus.control(server, numChannels: 1)\n```',

	// Patterns
	'Pbind': '**Pbind** - Bind keys to value patterns\n\n```supercollider\nPbind(\n    \\instrument, \\default,\n    \\degree, Pseq([0, 2, 4, 5, 7], inf),\n    \\dur, 0.25\n).play;\n```',
	'Pseq': '**Pseq** - Sequential pattern\n\n```supercollider\nPseq(list, repeats: 1, offset: 0)\n```\n\n**Arguments:**\n- `list` - Array of values\n- `repeats` - Number of times to repeat (inf for infinite)',
	'Prand': '**Prand** - Random selection from list\n\n```supercollider\nPrand(list, repeats: 1)\n```',
	'Pxrand': '**Pxrand** - Random selection, never repeating\n\n```supercollider\nPxrand(list, repeats: 1)\n```',
	'Pwrand': '**Pwrand** - Weighted random selection\n\n```supercollider\nPwrand(list, weights, repeats: 1)\n```',
	'Pwhite': '**Pwhite** - White noise pattern (uniform distribution)\n\n```supercollider\nPwhite(lo: 0, hi: 1, length: inf)\n```',
	'Pexprand': '**Pexprand** - Exponential random pattern\n\n```supercollider\nPexprand(lo: 0.01, hi: 1, length: inf)\n```',
	'Pn': '**Pn** - Repeat a pattern n times\n\n```supercollider\nPn(pattern, repeats: inf, key)\n```',
	'Pdef': '**Pdef** - Pattern definition (live-codable)\n\n```supercollider\nPdef(\\name, pattern)\nPdef(\\name).play\nPdef(\\name).stop\n```',
	'Routine': '**Routine** - Pauseable function\n\n```supercollider\nRoutine({ loop { 1.yield; "tick".postln } }).play;\n```',
	'Task': '**Task** - Pauseable process\n\n```supercollider\nTask({ loop { 1.wait; "tick".postln } }).play;\n```',

	// Collections
	'Array': '**Array** - Ordered collection\n\n```supercollider\nArray.new(size)\nArray.fill(size, function)\n[1, 2, 3, 4, 5]\n```',
	'List': '**List** - Growable ordered collection\n\n```supercollider\nList.new\nList[1, 2, 3]\n```',
	'Dictionary': '**Dictionary** - Key-value collection\n\n```supercollider\nDictionary.new\nDictionary[\\key -> value]\n```',
	'Event': '**Event** - Dictionary with default values\n\n```supercollider\n(freq: 440, amp: 0.5).play\n```',
	'Environment': '**Environment** - Named variable space\n\n```supercollider\n~myVar = 440;\ncurrentEnvironment;\n```',

	// Clocks
	'TempoClock': '**TempoClock** - Tempo-based scheduler\n\n```supercollider\nTempoClock.default.tempo = 2; // 120 BPM\nTempoClock.new(tempo: 1, beats: 0, seconds)\n```',
	'SystemClock': '**SystemClock** - System scheduler (seconds)\n\n```supercollider\nSystemClock.sched(delay, function)\n```',
	'AppClock': '**AppClock** - Application scheduler (for GUI)\n\n```supercollider\nAppClock.sched(delay, function)\n```',

	// GUI
	'Window': '**Window** - GUI window\n\n```supercollider\nWindow.new("Title", Rect(100, 100, 400, 300)).front;\n```',
	'Slider': '**Slider** - GUI slider\n\n```supercollider\nSlider(parent, bounds).action_({ |sl| sl.value.postln });\n```',
	'Button': '**Button** - GUI button\n\n```supercollider\nButton(parent, bounds).states_([[\"Off\"], [\"On\"]]).action_({ |b| b.value.postln });\n```',
	'Knob': '**Knob** - GUI rotary knob\n\n```supercollider\nKnob(parent, bounds).action_({ |k| k.value.postln });\n```',

	// MIDI & OSC
	'MIDIClient': '**MIDIClient** - MIDI system interface\n\n```supercollider\nMIDIClient.init;\nMIDIClient.sources;\nMIDIClient.destinations;\n```',
	'MIDIIn': '**MIDIIn** - MIDI input\n\n```supercollider\nMIDIIn.connectAll;\n```',
	'MIDIFunc': '**MIDIFunc** - MIDI responder function\n\n```supercollider\nMIDIFunc.noteOn({ |vel, note| [note, vel].postln });\nMIDIFunc.cc({ |val, num| [num, val].postln });\n```',
	'NetAddr': '**NetAddr** - Network address for OSC\n\n```supercollider\nNetAddr("127.0.0.1", 57120)\nNetAddr.localAddr\n```',
	'OSCFunc': '**OSCFunc** - OSC responder function\n\n```supercollider\nOSCFunc({ |msg| msg.postln }, \'/address\');\n```',

	// Control
	'Lag': '**Lag** - Exponential lag (smoothing)\n\n```supercollider\nLag.ar(in, lagTime: 0.1)\nLag.kr(in, lagTime: 0.1)\n```',
	'Lag2': '**Lag2** - Exponential lag (2nd order)\n\n```supercollider\nLag2.ar(in, lagTime: 0.1)\nLag2.kr(in, lagTime: 0.1)\n```',
	'Lag3': '**Lag3** - Exponential lag (3rd order)\n\n```supercollider\nLag3.ar(in, lagTime: 0.1)\nLag3.kr(in, lagTime: 0.1)\n```',
	'Mix': '**Mix** - Mix array of channels to mono\n\n```supercollider\nMix.ar(array)\nMix.fill(n, function)\n```',
	'Limiter': '**Limiter** - Limiter\n\n```supercollider\nLimiter.ar(in, level: 1, dur: 0.01, mul: 1, add: 0)\n```',
	'Compander': '**Compander** - Compressor/expander\n\n```supercollider\nCompander.ar(in, control: in, thresh: 0.5, slopeBelow: 1, slopeAbove: 1, clampTime: 0.01, relaxTime: 0.01, mul: 1, add: 0)\n```',
	'Normalizer': '**Normalizer** - Normalize amplitude\n\n```supercollider\nNormalizer.ar(in, level: 1, dur: 0.01, mul: 1, add: 0)\n```',
	'CompanderD': '**CompanderD** - Compander (ducking)\n\n```supercollider\nCompanderD.ar(in, thresh: 0.5, slopeBelow: 1, slopeAbove: 1, clampTime: 0.01, relaxTime: 0.01, mul: 1, add: 0)\n```',

	'AmpComp': '**AmpComp** - Amplitude compensation\n\n```supercollider\nAmpComp.ar(freq: 1000, root: 0, exp: 0.3333, mul: 1, add: 0)\n```',
	'AmpCompA': '**AmpCompA** - Amplitude compensation (A-weighting)\n\n```supercollider\nAmpCompA.ar(freq: 1000, root: 0, minAmp: 0.32, rootAmp: 1, mul: 1, add: 0)\n```',
	'MouseX': '**MouseX** - Mouse X position\n\n```supercollider\nMouseX.kr(minval: 0, maxval: 1, warp: 0, lag: 0.2)\n```',
	'MouseY': '**MouseY** - Mouse Y position\n\n```supercollider\nMouseY.kr(minval: 0, maxval: 1, warp: 0, lag: 0.2)\n```',
	'MouseButton': '**MouseButton** - Mouse button state\n\n```supercollider\nMouseButton.kr(minval: 0, maxval: 1, warp: 0, lag: 0.2)\n```',
	'KeyState': '**KeyState** - Keyboard key state\n\n```supercollider\nKeyState.kr(keycode: 0, minval: 0, maxval: 1, lag: 0.2, mul: 1, add: 0)\n```',
	'Free': '**Free** - Free synth\n\n```supercollider\nFree.ar(trig: 0)\nFree.kr(trig: 0)\n```',
	'FreeSelf': '**FreeSelf** - Free self\n\n```supercollider\nFreeSelf.ar(trig: 0)\nFreeSelf.kr(trig: 0)\n```',
	'FreeSelfWhenDone': '**FreeSelfWhenDone** - Free self when done\n\n```supercollider\nFreeSelfWhenDone.ar(trig: 0)\nFreeSelfWhenDone.kr(trig: 0)\n```',
	'PauseSelf': '**PauseSelf** - Pause self\n\n```supercollider\nPauseSelf.ar(trig: 0)\nPauseSelf.kr(trig: 0)\n```',
	'SetResetFF': '**SetResetFF** - Set-reset flip-flop\n\n```supercollider\nSetResetFF.ar(trig: 0, reset: 0)\nSetResetFF.kr(trig: 0, reset: 0)\n```',
	'Schmidt': '**Schmidt** - Schmidt trigger\n\n```supercollider\nSchmidt.ar(in, lo: 0, hi: 1)\nSchmidt.kr(in, lo: 0, hi: 1)\n```',
	'Hertz': '**Hertz** - Frequency to Hertz converter\n\n```supercollider\nHertz.ar(in, mul: 1, add: 0)\nHertz.kr(in, mul: 1, add: 0)\n```',
	'Midicps': '**Midicps** - MIDI note to frequency\n\n```supercollider\nMidicps.ar(in, mul: 1, add: 0)\nMidicps.kr(in, mul: 1, add: 0)\n```',
	'Cpsmidi': '**Cpsmidi** - Frequency to MIDI note\n\n```supercollider\nCpsmidi.ar(in, mul: 1, add: 0)\nCpsmidi.kr(in, mul: 1, add: 0)\n```',
	'Octcps': '**Octcps** - Octave to frequency\n\n```supercollider\nOctcps.ar(in, mul: 1, add: 0)\nOctcps.kr(in, mul: 1, add: 0)\n```',
	'Cpsoct': '**Cpsoct** - Frequency to octave\n\n```supercollider\nCpsoct.ar(in, mul: 1, add: 0)\nCpsoct.kr(in, mul: 1, add: 0)\n```',
	'Ratio': '**Ratio** - Ratio converter\n\n```supercollider\nRatio.ar(in, mul: 1, add: 0)\nRatio.kr(in, mul: 1, add: 0)\n```',
	'Dbamp': '**Dbamp** - Decibels to amplitude\n\n```supercollider\nDbamp.ar(in, mul: 1, add: 0)\nDbamp.kr(in, mul: 1, add: 0)\n```',
	'Ampdb': '**Ampdb** - Amplitude to decibels\n\n```supercollider\nAmpdb.ar(in, mul: 1, add: 0)\nAmpdb.kr(in, mul: 1, add: 0)\n```',
	'Squared': '**Squared** - Square value\n\n```supercollider\nSquared.ar(in, mul: 1, add: 0)\nSquared.kr(in, mul: 1, add: 0)\n```',
	'Cubed': '**Cubed** - Cube value\n\n```supercollider\nCubed.ar(in, mul: 1, add: 0)\nCubed.kr(in, mul: 1, add: 0)\n```',
	'Sqrt': '**Sqrt** - Square root\n\n```supercollider\nSqrt.ar(in, mul: 1, add: 0)\nSqrt.kr(in, mul: 1, add: 0)\n```',
	'Exp': '**Exp** - Exponential\n\n```supercollider\nExp.ar(in, mul: 1, add: 0)\nExp.kr(in, mul: 1, add: 0)\n```',
	'Log': '**Log** - Natural logarithm\n\n```supercollider\nLog.ar(in, mul: 1, add: 0)\nLog.kr(in, mul: 1, add: 0)\n```',
	'Log2': '**Log2** - Base 2 logarithm\n\n```supercollider\nLog2.ar(in, mul: 1, add: 0)\nLog2.kr(in, mul: 1, add: 0)\n```',
	'Log10': '**Log10** - Base 10 logarithm\n\n```supercollider\nLog10.ar(in, mul: 1, add: 0)\nLog10.kr(in, mul: 1, add: 0)\n```',
	'Sin': '**Sin** - Sine\n\n```supercollider\nSin.ar(in, mul: 1, add: 0)\nSin.kr(in, mul: 1, add: 0)\n```',
	'Cos': '**Cos** - Cosine\n\n```supercollider\nCos.ar(in, mul: 1, add: 0)\nCos.kr(in, mul: 1, add: 0)\n```',
	'Tan': '**Tan** - Tangent\n\n```supercollider\nTan.ar(in, mul: 1, add: 0)\nTan.kr(in, mul: 1, add: 0)\n```',
	'Asin': '**Asin** - Arc sine\n\n```supercollider\nAsin.ar(in, mul: 1, add: 0)\nAsin.kr(in, mul: 1, add: 0)\n```',
	'Acos': '**Acos** - Arc cosine\n\n```supercollider\nAcos.ar(in, mul: 1, add: 0)\nAcos.kr(in, mul: 1, add: 0)\n```',
	'Atan': '**Atan** - Arc tangent\n\n```supercollider\nAtan.ar(in, mul: 1, add: 0)\nAtan.kr(in, mul: 1, add: 0)\n```',
	'Sinh': '**Sinh** - Hyperbolic sine\n\n```supercollider\nSinh.ar(in, mul: 1, add: 0)\nSinh.kr(in, mul: 1, add: 0)\n```',
	'Cosh': '**Cosh** - Hyperbolic cosine\n\n```supercollider\nCosh.ar(in, mul: 1, add: 0)\nCosh.kr(in, mul: 1, add: 0)\n```',
	'Tanh': '**Tanh** - Hyperbolic tangent\n\n```supercollider\nTanh.ar(in, mul: 1, add: 0)\nTanh.kr(in, mul: 1, add: 0)\n```',
	'Distort': '**Distort** - Distortion\n\n```supercollider\nDistort.ar(in, mul: 1, add: 0)\nDistort.kr(in, mul: 1, add: 0)\n```',
	'SoftClip': '**SoftClip** - Soft clipping\n\n```supercollider\nSoftClip.ar(in, mul: 1, add: 0)\nSoftClip.kr(in, mul: 1, add: 0)\n```',
	'Clip': '**Clip** - Clip signal\n\n```supercollider\nClip.ar(in, lo: -1, hi: 1, mul: 1, add: 0)\nClip.kr(in, lo: -1, hi: 1, mul: 1, add: 0)\n```',
	'Fold': '**Fold** - Fold signal\n\n```supercollider\nFold.ar(in, lo: -1, hi: 1, mul: 1, add: 0)\nFold.kr(in, lo: -1, hi: 1, mul: 1, add: 0)\n```',
	'Wrap': '**Wrap** - Wrap signal\n\n```supercollider\nWrap.ar(in, lo: -1, hi: 1, mul: 1, add: 0)\nWrap.kr(in, lo: -1, hi: 1, mul: 1, add: 0)\n```',
	'UnaryOpUGen': '**UnaryOpUGen** - Unary operation UGen\n\n```supercollider\nUnaryOpUGen.ar(in, mul: 1, add: 0)\nUnaryOpUGen.kr(in, mul: 1, add: 0)\n```',
	'BinaryOpUGen': '**BinaryOpUGen** - Binary operation UGen\n\n```supercollider\nBinaryOpUGen.ar(inA, inB, mul: 1, add: 0)\nBinaryOpUGen.kr(inA, inB, mul: 1, add: 0)\n```',
	'MulAdd': '**MulAdd** - Multiply and add\n\n```supercollider\nMulAdd.ar(in, mul: 1, add: 0)\nMulAdd.kr(in, mul: 1, add: 0)\n```',
	'Sum3': '**Sum3** - Sum three signals\n\n```supercollider\nSum3.ar(in1, in2, in3, mul: 1, add: 0)\nSum3.kr(in1, in2, in3, mul: 1, add: 0)\n```',
	'Sum4': '**Sum4** - Sum four signals\n\n```supercollider\nSum4.ar(in1, in2, in3, in4, mul: 1, add: 0)\nSum4.kr(in1, in2, in3, in4, mul: 1, add: 0)\n```',
	'DifSqr': '**DifSqr** - Difference of squares\n\n```supercollider\nDifSqr.ar(inA, inB, mul: 1, add: 0)\nDifSqr.kr(inA, inB, mul: 1, add: 0)\n```',
	'SumSqr': '**SumSqr** - Sum of squares\n\n```supercollider\nSumSqr.ar(inA, inB, mul: 1, add: 0)\nSumSqr.kr(inA, inB, mul: 1, add: 0)\n```',
	'SqrSum': '**SqrSum** - Square of sum\n\n```supercollider\nSqrSum.ar(inA, inB, mul: 1, add: 0)\nSqrSum.kr(inA, inB, mul: 1, add: 0)\n```',
	'SqrDif': '**SqrDif** - Square of difference\n\n```supercollider\nSqrDif.ar(inA, inB, mul: 1, add: 0)\nSqrDif.kr(inA, inB, mul: 1, add: 0)\n```',
	'AbsDif': '**AbsDif** - Absolute difference\n\n```supercollider\nAbsDif.ar(inA, inB, mul: 1, add: 0)\nAbsDif.kr(inA, inB, mul: 1, add: 0)\n```',
	'Thresh': '**Thresh** - Threshold\n\n```supercollider\nThresh.ar(in, thresh: 0, mul: 1, add: 0)\nThresh.kr(in, thresh: 0, mul: 1, add: 0)\n```',
	'SCurve': '**SCurve** - S-curve\n\n```supercollider\nSCurve.ar(in, mul: 1, add: 0)\nSCurve.kr(in, mul: 1, add: 0)\n```',
	'A2K': '**A2K** - Audio to control rate\n\n```supercollider\nA2K.ar(in)\n```',
	'K2A': '**K2A** - Control to audio rate\n\n```supercollider\nK2A.ar(in, mul: 1, add: 0)\n```',
	'T2A': '**T2A** - Trigger to audio rate\n\n```supercollider\nT2A.ar(trig: 0, offset: 0)\n```',
	'T2K': '**T2K** - Trigger to control rate\n\n```supercollider\nT2K.kr(trig: 0, offset: 0)\n```',
	'DC': '**DC** - DC offset\n\n```supercollider\nDC.ar(in: 0, mul: 1, add: 0)\nDC.kr(in: 0, mul: 1, add: 0)\n```',
	'Silent': '**Silent** - Silent signal\n\n```supercollider\nSilent.ar(numChannels: 1)\n```',
	'Clear': '**Clear** - Clear signal\n\n```supercollider\nClear.ar(in, mul: 1, add: 0)\nClear.kr(in, mul: 1, add: 0)\n```',

	// ── Patterns: Function / Routine ──────────────────────────────────────
	'Pfunc': '**Pfunc** - Function pattern: returns values from nextFunc\n\n```supercollider\nPfunc(nextFunc, resetFunc)\n```\n\n**Arguments:**\n- `nextFunc` - stream function, receives current Event as argument\n- `resetFunc` - function called when stream is reset',
	'Prout': '**Prout** - Routine pattern: embeds a routine function as a pattern\n\n```supercollider\nProut(routineFunc)\n```\n\n**Arguments:**\n- `routineFunc` - routine function (use .yield to return values)',
	'Plazy': '**Plazy** - Evaluates a function that returns a pattern, then embeds it\n\n```supercollider\nPlazy(func)\n```\n\n**Arguments:**\n- `func` - a Function that returns a pattern or valid pattern input',

	// ── Patterns: List ────────────────────────────────────────────────────
	'Pshuf': '**Pshuf** - Sequentially embed values in a list in constant but random order\n\n```supercollider\nPshuf(list, repeats: 1)\n```\n\n**Arguments:**\n- `list` - list of values\n- `repeats` - number of times to repeat the shuffled list',
	'Place': '**Place** - Interlaced embedding of subarrays: steps through sub-elements on each pass\n\n```supercollider\nPlace(list, repeats: 1, offset: 0)\n```\n\n**Arguments:**\n- `list` - list of values or arrays\n- `repeats` - number of repeats\n- `offset` - starting offset',
	'Ppatlace': '**Ppatlace** - Interlace streams: outputs one value from each pattern in turn\n\n```supercollider\nPpatlace(list, repeats: 1, offset: 0)\n```\n\n**Arguments:**\n- `list` - array of patterns or streams\n- `repeats` - number of repeats\n- `offset` - starting offset',
	'Pswitch': '**Pswitch** - Embed values from a list by index; fully embeds sub-patterns\n\n```supercollider\nPswitch(list, which: 0)\n```\n\n**Arguments:**\n- `list` - array of values or patterns\n- `which` - pattern of indices selecting from list',
	'Pswitch1': '**Pswitch1** - Embed one value at a time from list by index\n\n```supercollider\nPswitch1(list, which: 0)\n```\n\n**Arguments:**\n- `list` - array of values or patterns\n- `which` - pattern of indices',
	'Pwalk': '**Pwalk** - Random walk over a list of values\n\n```supercollider\nPwalk(list, stepPattern, directionPattern: 1, startPos: 0)\n```\n\n**Arguments:**\n- `list` - the items to walk over\n- `stepPattern` - pattern returning step sizes (integers)\n- `directionPattern` - 1 wraps, Pseq([1,-1],inf) bounces\n- `startPos` - starting index in list',

	// ── Patterns: Random / Distribution ───────────────────────────────────
	'Pgauss': '**Pgauss** - Random values following a Gaussian distribution\n\n```supercollider\nPgauss(mean: 0.0, dev: 1, length: inf)\n```\n\n**Arguments:**\n- `mean` - mean of the distribution\n- `dev` - standard deviation\n- `length` - number of values produced',
	'Pbrown': '**Pbrown** - Brownian motion pattern\n\n```supercollider\nPbrown(lo: 0.0, hi: 1.0, step: 0.125, length: inf)\n```\n\n**Arguments:**\n- `lo` - lower boundary\n- `hi` - upper boundary\n- `step` - maximum change per step\n- `length` - number of values produced',
	'Pgbrown': '**Pgbrown** - Geometric brownian motion pattern\n\n```supercollider\nPgbrown(lo: 0.0, hi: 1.0, step: 0.125, length: inf)\n```\n\n**Arguments:**\n- `lo` - lower boundary\n- `hi` - upper boundary\n- `step` - maximum multiplication factor per step\n- `length` - number of values produced',
	'Pcauchy': '**Pcauchy** - Random values following a Cauchy distribution\n\n```supercollider\nPcauchy(mean: 0.0, spread: 1.0, length: inf)\n```\n\n**Arguments:**\n- `mean` - mean of distribution\n- `spread` - horizontal dispersion\n- `length` - number of values produced',
	'Pbeta': '**Pbeta** - Random values following a Beta distribution\n\n```supercollider\nPbeta(lo: 0.0, hi: 1.0, prob1: 1, prob2: 1, length: inf)\n```\n\n**Arguments:**\n- `lo` - lower boundary\n- `hi` - upper boundary\n- `prob1` - shape parameter near lo\n- `prob2` - shape parameter near hi\n- `length` - number of values produced',
	'Ppoisson': '**Ppoisson** - Random positive integer values following a Poisson distribution\n\n```supercollider\nPpoisson(mean: 1, length: inf)\n```\n\n**Arguments:**\n- `mean` - mean of distribution\n- `length` - number of values produced',

	// ── Patterns: Series ──────────────────────────────────────────────────
	'Pseries': '**Pseries** - Arithmetic series pattern\n\n```supercollider\nPseries(start: 0, step: 1, length: inf)\n```\n\n**Arguments:**\n- `start` - start value\n- `step` - addition factor\n- `length` - number of values produced',
	'Pgeom': '**Pgeom** - Geometric series pattern\n\n```supercollider\nPgeom(start: 1, grow: 2, length: inf)\n```\n\n**Arguments:**\n- `start` - start value\n- `grow` - multiplication factor\n- `length` - number of values produced',

	// ── Patterns: Parallel ────────────────────────────────────────────────
	'Ppar': '**Ppar** - Embed event streams in parallel\n\n```supercollider\nPpar(list, repeats: 1)\n```\n\n**Arguments:**\n- `list` - list of patterns or streams\n- `repeats` - repeat the whole pattern n times',
	'Ptpar': '**Ptpar** - Embed event streams in parallel with time offsets\n\n```supercollider\nPtpar(list, repeats: 1)\n```\n\n**Arguments:**\n- `list` - list of [time, pattern, time, pattern ...] pairs\n- `repeats` - repeat the whole pattern n times',

	// ── Patterns: Composition ─────────────────────────────────────────────
	'Pchain': '**Pchain** - Chain event patterns: pattern1 overrides pattern2 (like <>)\n\n```supercollider\nPchain(... patterns)\n```\n\n**Arguments:**\n- `... patterns` - patterns to chain (first overrides subsequent)',
	'Pbindf': '**Pbindf** - Add or override key-value pairs on an existing event pattern\n\n```supercollider\nPbindf(pattern, ... pairs)\n```\n\n**Arguments:**\n- `pattern` - the input event pattern\n- `... pairs` - alternating keys and value patterns',

	// ── Patterns: Event ───────────────────────────────────────────────────
	'Pkey': '**Pkey** - Access a key in the current event stream\n\n```supercollider\nPkey(key, repeats)\n```\n\n**Arguments:**\n- `key` - the event key to read from\n- `repeats` - number of values (nil = infinite)',
	'Pmono': '**Pmono** - Monophonic event stream: one synth, changing parameters\n\n```supercollider\nPmono(name, ... pairs)\n```\n\n**Arguments:**\n- `name` - SynthDef name (Symbol)\n- `... pairs` - alternating keys and value patterns',
	'PmonoArtic': '**PmonoArtic** - Monophonic event stream with re-articulation support\n\n```supercollider\nPmonoArtic(name, ... pairs)\n```\n\n**Arguments:**\n- `name` - SynthDef name (Symbol)\n- `... pairs` - alternating keys and value patterns (legato < 1 re-articulates)',
	'Pbindef': '**Pbindef** - Incremental event pattern reference (live-codeable Pbind)\n\n```supercollider\nPbindef(key, ... pairs)\n```\n\n**Arguments:**\n- `key` - global key for the pattern\n- `... pairs` - alternating keys and value patterns',

	// ── Patterns: Filter ──────────────────────────────────────────────────
	'Pfset': '**Pfset** - Set default event values via environment before evaluating pattern\n\n```supercollider\nPfset(func, pattern, cleanupFunc)\n```\n\n**Arguments:**\n- `func` - function using ~key = value syntax to set defaults\n- `pattern` - the event pattern\n- `cleanupFunc` - optional cleanup function on stop',
	'Pset': '**Pset** - Set one key in an event stream\n\n```supercollider\nPset(name, value, pattern)\n```\n\n**Arguments:**\n- `name` - the key\n- `value` - value or pattern\n- `pattern` - the event pattern to filter',
	'Pstutter': '**Pstutter** - Repeat each element n times\n\n```supercollider\nPstutter(n, pattern)\n```\n\n**Arguments:**\n- `n` - number of repeats per element (can be a pattern)\n- `pattern` - the pattern to repeat',
	'Pclump': '**Pclump** - Group pattern values into arrays of size n\n\n```supercollider\nPclump(n, pattern)\n```\n\n**Arguments:**\n- `n` - clump size (integer or pattern)\n- `pattern` - the source pattern',
	'Pfin': '**Pfin** - Limit number of events from a pattern\n\n```supercollider\nPfin(count, pattern)\n```\n\n**Arguments:**\n- `count` - maximum number of elements\n- `pattern` - the source pattern',
	'Pfindur': '**Pfindur** - Limit total duration of events in a stream\n\n```supercollider\nPfindur(dur, pattern, tolerance: 0.001)\n```\n\n**Arguments:**\n- `dur` - maximum duration in beats\n- `pattern` - the event pattern\n- `tolerance` - timing tolerance',
	'Pstretch': '**Pstretch** - Stretch event durations by a factor\n\n```supercollider\nPstretch(value, pattern)\n```\n\n**Arguments:**\n- `value` - stretch factor (or pattern)\n- `pattern` - the event pattern',
	'Pcollect': '**Pcollect** - Apply a function to each value (like .collect)\n\n```supercollider\nPcollect(func, pattern)\n```\n\n**Arguments:**\n- `func` - function to apply to each value\n- `pattern` - the source pattern',
	'Pselect': '**Pselect** - Filter pattern: keep values where func returns true\n\n```supercollider\nPselect(func, pattern)\n```\n\n**Arguments:**\n- `func` - function returning boolean\n- `pattern` - the source pattern',
	'Preject': '**Preject** - Filter pattern: reject values where func returns true\n\n```supercollider\nPreject(func, pattern)\n```\n\n**Arguments:**\n- `func` - function returning boolean\n- `pattern` - the source pattern',

	// ── Patterns: Control ─────────────────────────────────────────────────
	'Pif': '**Pif** - Pattern-based conditional expression\n\n```supercollider\nPif(condition, iftrue, iffalse, default)\n```\n\n**Arguments:**\n- `condition` - pattern returning Boolean\n- `iftrue` - stream evaluated when true\n- `iffalse` - stream evaluated when false\n- `default` - value returned if iftrue/iffalse return nil',
	'Penvir': '**Penvir** - Use an environment when embedding the pattern in a stream\n\n```supercollider\nPenvir(envir, pattern, independent: true)\n```\n\n**Arguments:**\n- `envir` - an environment\n- `pattern` - pattern or stream\n- `independent` - if true, each stream gets its own copy',

	// ── Patterns: Time ────────────────────────────────────────────────────
	'Pseg': '**Pseg** - Timed envelope-like interpolation of values\n\n```supercollider\nPseg(levels, durs: 1, curves: \\lin, repeats: 1)\n```\n\n**Arguments:**\n- `levels` - pattern of levels (first is initial value)\n- `durs` - pattern of segment durations in beats\n- `curves` - \\\\lin, \\\\exp, \\\\sin, \\\\wel, \\\\step, or Float\n- `repeats` - number of repeats',
	'Pstep': '**Pstep** - Timed sample-and-hold: hold each level for a duration\n\n```supercollider\nPstep(levels, durs: 1, repeats: 1)\n```\n\n**Arguments:**\n- `levels` - pattern of levels\n- `durs` - pattern of durations in beats\n- `repeats` - number of repeats',
	'Ptime': '**Ptime** - Returns elapsed time in beats from moment of embedding\n\n```supercollider\nPtime(repeats: inf)\n```\n\n**Arguments:**\n- `repeats` - number of values produced',

	// ── Patterns: Debug ───────────────────────────────────────────────────
	'Ptrace': '**Ptrace** - Print stream results while passing them through\n\n```supercollider\nPtrace(pattern, key, printStream, prefix: "")\n```\n\n**Arguments:**\n- `pattern` - the pattern to trace\n- `key` - when streaming events, post only this key\n- `printStream` - output stream (default: Post)\n- `prefix` - string prefix for printout',
	'Pgate': '**Pgate** - Gated stream: advances subpattern only when event key is true\n\n```supercollider\nPgate(pattern, repeats: inf, key)\n```\n\n**Arguments:**\n- `pattern` - source pattern\n- `repeats` - number of repeats\n- `key` - event key that gates advancement',

	// ── Demand-rate UGens ─────────────────────────────────────────────────
	'Demand': '**Demand** - Demand values from demand-rate UGens on trigger\n\n```supercollider\nDemand.ar(trig, reset, demandUGens)\nDemand.kr(trig, reset, demandUGens)\n```\n\n**Arguments:**\n- `trig` - trigger (non-positive to positive transition)\n- `reset` - trigger to reset demand UGens\n- `demandUGens` - list of demand-rate UGens',
	'Duty': '**Duty** - Demand results at timed intervals\n\n```supercollider\nDuty.ar(dur: 1.0, reset: 0, level: 1.0, doneAction: 0)\nDuty.kr(dur: 1.0, reset: 0, level: 1.0, doneAction: 0)\n```\n\n**Arguments:**\n- `dur` - time values (demand UGen or signal)\n- `reset` - trigger or reset time values\n- `level` - demand UGen providing output values\n- `doneAction` - action when duration stream ends',
	'Dseq': '**Dseq** - Demand rate sequence generator\n\n```supercollider\nDseq(list, repeats: 1)\n```\n\n**Arguments:**\n- `list` - array of values or UGens\n- `repeats` - number of repeats',
	'Drand': '**Drand** - Demand rate random sequence generator\n\n```supercollider\nDrand(list, repeats: 1)\n```\n\n**Arguments:**\n- `list` - array of values or UGens\n- `repeats` - number of values to return',
	'Dwhite': '**Dwhite** - Demand rate white noise random generator\n\n```supercollider\nDwhite(lo: 0.0, hi: 1.0, length: inf)\n```\n\n**Arguments:**\n- `lo` - minimum value\n- `hi` - maximum value\n- `length` - number of values to create',
	'Dbrown': '**Dbrown** - Demand rate brownian motion generator\n\n```supercollider\nDbrown(lo: 0.0, hi: 1.0, step: 0.01, length: inf)\n```\n\n**Arguments:**\n- `lo` - minimum value\n- `hi` - maximum value\n- `step` - maximum step per value\n- `length` - number of values',
	'Dseries': '**Dseries** - Demand rate arithmetic series\n\n```supercollider\nDseries(start: 1, step: 1, length: inf)\n```\n\n**Arguments:**\n- `start` - start value\n- `step` - step value\n- `length` - number of values',
	'Dgeom': '**Dgeom** - Demand rate geometric series\n\n```supercollider\nDgeom(start: 1, grow: 2, length: inf)\n```\n\n**Arguments:**\n- `start` - start value\n- `grow` - multiplication factor\n- `length` - number of values',
	'Dswitch1': '**Dswitch1** - Demand rate switch between inputs (one value per demand)\n\n```supercollider\nDswitch1(list, index)\n```\n\n**Arguments:**\n- `list` - array of values or UGens\n- `index` - which input to return',
	'Dswitch': '**Dswitch** - Demand rate switch: fully embeds sub-sequences before switching\n\n```supercollider\nDswitch(list, index)\n```\n\n**Arguments:**\n- `list` - array of values or UGens\n- `index` - which input to return',
	'Dbufrd': '**Dbufrd** - Demand rate buffer reader\n\n```supercollider\nDbufrd(bufnum: 0, phase: 0.0, loop: 1.0)\n```\n\n**Arguments:**\n- `bufnum` - buffer number\n- `phase` - index into buffer\n- `loop` - loop when exceeding frames (1=loop)',
	'Dbufwr': '**Dbufwr** - Demand rate buffer writer\n\n```supercollider\nDbufwr(input: 0.0, bufnum: 0, phase: 0.0, loop: 1.0)\n```\n\n**Arguments:**\n- `input` - single channel input\n- `bufnum` - buffer number\n- `phase` - index into buffer\n- `loop` - loop when exceeding frames (1=loop)',
	'Dstutter': '**Dstutter** - Demand rate value repeater\n\n```supercollider\nDstutter(n, in)\n```\n\n**Arguments:**\n- `n` - number of repeats (can be demand UGen)\n- `in` - input UGen',
	'Dunique': '**Dunique** - Ensure each demand stream gets unique values from source\n\n```supercollider\nDunique(source, maxBufferSize: 1024, protected: true)\n```\n\n**Arguments:**\n- `source` - demand UGen source\n- `maxBufferSize` - internal buffer size\n- `protected` - if true, catches overflows by ending series',

	// ── Disk I/O ──────────────────────────────────────────────────────────
	'DiskIn': '**DiskIn** - Stream audio from disk (constant rate)\n\n```supercollider\nDiskIn.ar(numChannels, bufnum, loop: 0)\n```\n\n**Arguments:**\n- `numChannels` - number of channels (must match buffer)\n- `bufnum` - buffer number (power-of-two frames, ≥65536)\n- `loop` - 1 = loop, 0 = no loop',
	'DiskOut': '**DiskOut** - Record audio to disk via buffer\n\n```supercollider\nDiskOut.ar(bufnum, channelsArray)\n```\n\n**Arguments:**\n- `bufnum` - buffer number\n- `channelsArray` - array of channels to write',

	// ── Select UGens ──────────────────────────────────────────────────────
	'Select': '**Select** - Select one output from an array of inputs by index\n\n```supercollider\nSelect.ar(which, array)\nSelect.kr(which, array)\n```\n\n**Arguments:**\n- `which` - integer index\n- `array` - input array of signals',
	'SelectX': '**SelectX** - Mix from array with equal-power crossfade between adjacent channels\n\n```supercollider\nSelectX.ar(which, array, wrap: 1)\nSelectX.kr(which, array, wrap: 1)\n```\n\n**Arguments:**\n- `which` - fractional index\n- `array` - input array\n- `wrap` - wrap mode',
	'LinSelectX': '**LinSelectX** - Mix from array with linear interpolation\n\n```supercollider\nLinSelectX.ar(which, array, wrap: 1)\nLinSelectX.kr(which, array, wrap: 1)\n```\n\n**Arguments:**\n- `which` - fractional index\n- `array` - input array\n- `wrap` - wrap mode',
	'SelectXFocus': '**SelectXFocus** - Mix from array with adjustable focus width\n\n```supercollider\nSelectXFocus.ar(which, array, focus: 1, wrap: false)\nSelectXFocus.kr(which, array, focus: 1, wrap: false)\n```\n\n**Arguments:**\n- `which` - index (center of selection)\n- `array` - input array\n- `focus` - larger = less adjacent mixing\n- `wrap` - wrap index around array',

	// ── Analysis ──────────────────────────────────────────────────────────
	'DetectSilence': '**DetectSilence** - Detect when input falls below amplitude threshold\n\n```supercollider\nDetectSilence.ar(in: 0.0, amp: 0.0001, time: 0.1, doneAction: 0)\nDetectSilence.kr(in: 0.0, amp: 0.0001, time: 0.1, doneAction: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `amp` - amplitude threshold\n- `time` - minimum silence duration\n- `doneAction` - action when silence detected',
	'Amplitude': '**Amplitude** - Amplitude follower (envelope follower)\n\n```supercollider\nAmplitude.ar(in: 0.0, attackTime: 0.01, releaseTime: 0.01)\nAmplitude.kr(in: 0.0, attackTime: 0.01, releaseTime: 0.01)\n```\n\n**Arguments:**\n- `in` - input signal\n- `attackTime` - 20dB convergence time for attacks\n- `releaseTime` - 20dB convergence time for decays',
	'SendReply': '**SendReply** - Send array of values from server to clients via OSC\n\n```supercollider\nSendReply.ar(trig, cmdName: \'/reply\', values, replyID: -1)\nSendReply.kr(trig, cmdName: \'/reply\', values, replyID: -1)\n```\n\n**Arguments:**\n- `trig` - trigger (non-positive to positive)\n- `cmdName` - OSC message name\n- `values` - array of UGen values\n- `replyID` - integer ID',
	'SendPeakRMS': '**SendPeakRMS** - Track peak and RMS power, send to clients\n\n```supercollider\nSendPeakRMS.ar(sig, replyRate: 20.0, peakLag: 3, cmdName: \'/reply\', replyID: -1)\nSendPeakRMS.kr(sig, replyRate: 20.0, peakLag: 3, cmdName: \'/reply\', replyID: -1)\n```\n\n**Arguments:**\n- `sig` - input signal\n- `replyRate` - replies per second\n- `peakLag` - lag time for peak values\n- `cmdName` - OSC address\n- `replyID` - integer ID',
	'Tartini': '**Tartini** - Real-time monophonic pitch tracker (sc3-plugins)\n\n```supercollider\nTartini.kr(in: 0.0, threshold: 0.93, n: 2048, k: 0, overlap: 1024, smallCutoff: 0.5)\n```\n\n**Arguments:**\n- `in` - audio input\n- `threshold` - confidence threshold\n- `n` - FFT size\n- `k` - mode\n- `overlap` - overlap size\n- `smallCutoff` - cutoff',

	// ── Buffer info UGens ─────────────────────────────────────────────────
	'BufFrames': '**BufFrames** - Current number of frames in buffer\n\n```supercollider\nBufFrames.kr(bufnum)\nBufFrames.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',
	'BufDur': '**BufDur** - Current duration of buffer in seconds\n\n```supercollider\nBufDur.kr(bufnum)\nBufDur.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',
	'BufRateScale': '**BufRateScale** - Buffer playback rate scale relative to server sample rate\n\n```supercollider\nBufRateScale.kr(bufnum)\nBufRateScale.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',
	'BufSampleRate': '**BufSampleRate** - Buffer sample rate\n\n```supercollider\nBufSampleRate.kr(bufnum)\nBufSampleRate.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',
	'BufChannels': '**BufChannels** - Current number of channels in buffer\n\n```supercollider\nBufChannels.kr(bufnum)\nBufChannels.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',
	'BufSamples': '**BufSamples** - Current number of samples in buffer (frames × channels)\n\n```supercollider\nBufSamples.kr(bufnum)\nBufSamples.ir(bufnum)\n```\n\n**Arguments:**\n- `bufnum` - buffer index',

	// ── Server info UGens ─────────────────────────────────────────────────
	'SampleRate': '**SampleRate** - Server sample rate\n\n```supercollider\nSampleRate.ir\n```',
	'ControlRate': '**ControlRate** - Server control rate\n\n```supercollider\nControlRate.ir\n```',
	'NumOutputBuses': '**NumOutputBuses** - Number of output buses\n\n```supercollider\nNumOutputBuses.ir\n```',
	'NumInputBuses': '**NumInputBuses** - Number of input buses\n\n```supercollider\nNumInputBuses.ir\n```',

	// ── Oscillators (additional) ──────────────────────────────────────────
	'LFTri': '**LFTri** - Non-band-limited triangle oscillator\n\n```supercollider\nLFTri.ar(freq: 440, iphase: 0, mul: 1, add: 0)\nLFTri.kr(freq: 440, iphase: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - frequency in Hz\n- `iphase` - initial phase (0..4)',
	'LFCub': '**LFCub** - Non-band-limited cubic oscillator (smoother than LFPar)\n\n```supercollider\nLFCub.ar(freq: 440, iphase: 0, mul: 1, add: 0)\nLFCub.kr(freq: 440, iphase: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - frequency in Hz\n- `iphase` - initial phase (0..2)',
	'LFPar': '**LFPar** - Non-band-limited parabolic oscillator\n\n```supercollider\nLFPar.ar(freq: 440, iphase: 0, mul: 1, add: 0)\nLFPar.kr(freq: 440, iphase: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - frequency in Hz\n- `iphase` - initial phase (0..4)',
	'VarSaw': '**VarSaw** - Variable duty saw oscillator\n\n```supercollider\nVarSaw.ar(freq: 440, iphase: 0, width: 0.5, mul: 1, add: 0)\nVarSaw.kr(freq: 440, iphase: 0, width: 0.5, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `freq` - frequency in Hz\n- `iphase` - initial phase\n- `width` - duty cycle (0..1)',
	'SyncSaw': '**SyncSaw** - Hard sync sawtooth oscillator\n\n```supercollider\nSyncSaw.ar(syncFreq: 440, sawFreq: 440, mul: 1, add: 0)\nSyncSaw.kr(syncFreq: 440, sawFreq: 440, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `syncFreq` - sync frequency (resets saw)\n- `sawFreq` - sawtooth frequency',
	'Vibrato': '**Vibrato** - Vibrato oscillator for pitch modulation\n\n```supercollider\nVibrato.ar(freq: 440, rate: 6, depth: 0.02, delay: 0, onset: 0, rateVariation: 0.04, depthVariation: 0.1, iphase: 0, trig: 0)\n```\n\n**Arguments:**\n- `freq` - base frequency\n- `rate` - vibrato rate in Hz\n- `depth` - vibrato depth (fraction of freq)\n- `delay` - delay before onset\n- `onset` - transition time to full vibrato',
	'LFGauss': '**LFGauss** - Non-band-limited Gaussian function oscillator\n\n```supercollider\nLFGauss.ar(duration: 1, width: 0.1, iphase: 0, loop: 1, doneAction: 0)\nLFGauss.kr(duration: 1, width: 0.1, iphase: 0, loop: 1, doneAction: 0)\n```\n\n**Arguments:**\n- `duration` - duration of one cycle\n- `width` - relative width of gaussian (0..1)\n- `iphase` - initial phase\n- `loop` - loop (1) or not (0)\n- `doneAction` - action at end',

	// ── Physical models ───────────────────────────────────────────────────
	'Spring': '**Spring** - Physical model of a resonating spring\n\n```supercollider\nSpring.ar(in: 0, spring: 1, damp: 0)\nSpring.kr(in: 0, spring: 1, damp: 0)\n```\n\n**Arguments:**\n- `in` - input force\n- `spring` - spring constant\n- `damp` - damping',
	'Ball': '**Ball** - Physical model of a bouncing ball\n\n```supercollider\nBall.ar(in: 0, g: 1, damp: 0, friction: 0.01)\nBall.kr(in: 0, g: 1, damp: 0, friction: 0.01)\n```\n\n**Arguments:**\n- `in` - modulated surface height\n- `g` - gravity\n- `damp` - damping on each bounce\n- `friction` - friction',
	'TBall': '**TBall** - Physical model of a triggered bouncing ball\n\n```supercollider\nTBall.ar(in: 0, g: 10, damp: 0, friction: 0.01)\nTBall.kr(in: 0, g: 10, damp: 0, friction: 0.01)\n```\n\n**Arguments:**\n- `in` - trigger / surface\n- `g` - gravity\n- `damp` - damping\n- `friction` - friction',
	'Pluck': '**Pluck** - Karplus-Strong plucked string synthesis\n\n```supercollider\nPluck.ar(in, trig: 1, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, coef: 0.5)\n```\n\n**Arguments:**\n- `in` - excitation signal\n- `trig` - trigger for pluck\n- `maxdelaytime` - max delay time\n- `delaytime` - delay time (1/freq)\n- `decaytime` - decay time\n- `coef` - feedback coefficient (-1..1)',

	// ── Filters (additional) ──────────────────────────────────────────────
	'Decay': '**Decay** - Exponential decay (triggered by impulses)\n\n```supercollider\nDecay.ar(in: 0, decayTime: 1, mul: 1, add: 0)\nDecay.kr(in: 0, decayTime: 1, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - input signal (trigger)\n- `decayTime` - 60dB decay time in seconds',
	'Decay2': '**Decay2** - Exponential decay with attack (difference of two Decays)\n\n```supercollider\nDecay2.ar(in: 0, attackTime: 0.01, decayTime: 1, mul: 1, add: 0)\nDecay2.kr(in: 0, attackTime: 0.01, decayTime: 1, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `attackTime` - 60dB attack time\n- `decayTime` - 60dB decay time',
	'Klank': '**Klank** - Bank of fixed-frequency resonators (ring filter)\n\n```supercollider\nKlank.ar(specificationsArrayRef, input, freqscale: 1, freqoffset: 0, decayscale: 1)\n```\n\n**Arguments:**\n- `specificationsArrayRef` - \\`[freqs, amps, ringtimes]\n- `input` - excitation signal\n- `freqscale` - frequency scale factor\n- `freqoffset` - frequency offset\n- `decayscale` - ring time scale factor',
	'DynKlank': '**DynKlank** - Bank of resonators with modulatable parameters\n\n```supercollider\nDynKlank.ar(specificationsArrayRef, input, freqscale: 1, freqoffset: 0, decayscale: 1)\n```\n\n**Arguments:**\n- `specificationsArrayRef` - \\`[freqs, amps, ringtimes] (can be UGens)\n- `input` - excitation signal\n- `freqscale` - frequency scale\n- `freqoffset` - frequency offset\n- `decayscale` - ring time scale',
	'DynKlang': '**DynKlang** - Bank of sine oscillators with modulatable parameters\n\n```supercollider\nDynKlang.ar(specificationsArrayRef, freqscale: 1, freqoffset: 0)\n```\n\n**Arguments:**\n- `specificationsArrayRef` - \\`[freqs, amps, phases] (can be UGens)\n- `freqscale` - frequency scale\n- `freqoffset` - frequency offset',
	'Ramp': '**Ramp** - Linear lag (break signal into linearly interpolated segments)\n\n```supercollider\nRamp.ar(in: 0, lagTime: 0.1)\nRamp.kr(in: 0, lagTime: 0.1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `lagTime` - ramp time in seconds',
	'Slew': '**Slew** - Slew rate limiter\n\n```supercollider\nSlew.ar(in: 0, up: 1, dn: 1)\nSlew.kr(in: 0, up: 1, dn: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `up` - max upward slope (per second)\n- `dn` - max downward slope (per second)',
	'Slope': '**Slope** - Slope of a signal (rate of change)\n\n```supercollider\nSlope.ar(in: 0)\nSlope.kr(in: 0)\n```\n\n**Arguments:**\n- `in` - input signal',
	'Changed': '**Changed** - Detect when signal changes value\n\n```supercollider\nChanged.ar(input, threshold: 0)\nChanged.kr(input, threshold: 0)\n```\n\n**Arguments:**\n- `input` - input signal\n- `threshold` - minimum change to detect',
	'InRange': '**InRange** - Test if signal is within a range (outputs 1 or 0)\n\n```supercollider\nInRange.ar(in: 0, lo: 0, hi: 1)\nInRange.kr(in: 0, lo: 0, hi: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `lo` - lower bound\n- `hi` - upper bound',
	'LinExp': '**LinExp** - Map a linear range to an exponential range\n\n```supercollider\nLinExp.ar(in, srclo: 0, srchi: 1, dstlo: 1, dsthi: 2)\nLinExp.kr(in, srclo: 0, srchi: 1, dstlo: 1, dsthi: 2)\n```\n\n**Arguments:**\n- `in` - input signal\n- `srclo` - source range low\n- `srchi` - source range high\n- `dstlo` - destination range low (must be nonzero)\n- `dsthi` - destination range high (must be nonzero)',
	'LinLin': '**LinLin** - Map a linear range to another linear range\n\n```supercollider\nLinLin.ar(in, srclo: 0, srchi: 1, dstlo: 1, dsthi: 2)\nLinLin.kr(in, srclo: 0, srchi: 1, dstlo: 1, dsthi: 2)\n```\n\n**Arguments:**\n- `in` - input signal\n- `srclo` - source range low\n- `srchi` - source range high\n- `dstlo` - destination range low\n- `dsthi` - destination range high',

	// ── Envelopes (additional) ────────────────────────────────────────────
	'DemandEnvGen': '**DemandEnvGen** - Demand rate envelope generator\n\n```supercollider\nDemandEnvGen.ar(level, dur, shape: 1, curve: 0, gate: 1, reset: 1, levelScale: 1, levelBias: 0, timeScale: 1, doneAction: 0)\nDemandEnvGen.kr(level, dur, shape: 1, curve: 0, gate: 1, reset: 1, levelScale: 1, levelBias: 0, timeScale: 1, doneAction: 0)\n```\n\n**Arguments:**\n- `level` - demand UGen for levels\n- `dur` - demand UGen for durations\n- `shape` - envelope shape (1=lin, 2=exp, etc.)\n- `curve` - curve factor\n- `gate` - gate signal\n- `reset` - reset trigger\n- `doneAction` - action at end',

	// ── Granular (additional) ─────────────────────────────────────────────
	'TGrains': '**TGrains** - Buffer granulator triggered by external signal\n\n```supercollider\nTGrains.ar(numChannels, trigger, bufnum, rate: 1, centerPos: 0, dur: 0.1, pan: 0, amp: 0.1, interp: 4)\n```\n\n**Arguments:**\n- `numChannels` - number of output channels\n- `trigger` - trigger signal\n- `bufnum` - buffer number\n- `rate` - playback rate\n- `centerPos` - grain center position in seconds\n- `dur` - grain duration\n- `pan` - pan position\n- `amp` - amplitude\n- `interp` - interpolation (1,2,4)',
	'GrainSin': '**GrainSin** - Granular synthesis with sine grains\n\n```supercollider\nGrainSin.ar(numChannels: 1, trigger: 0, dur: 1, freq: 440, pan: 0, envbufnum: -1, maxGrains: 512)\n```\n\n**Arguments:**\n- `numChannels` - number of output channels\n- `trigger` - trigger signal\n- `dur` - grain duration\n- `freq` - grain frequency\n- `pan` - pan position\n- `envbufnum` - grain envelope buffer (-1 = Hann)\n- `maxGrains` - max simultaneous grains',
	'GrainFM': '**GrainFM** - Granular synthesis with FM grains\n\n```supercollider\nGrainFM.ar(numChannels: 1, trigger: 0, dur: 1, carfreq: 440, modfreq: 200, index: 1, pan: 0, envbufnum: -1, maxGrains: 512)\n```\n\n**Arguments:**\n- `numChannels` - number of output channels\n- `trigger` - trigger signal\n- `dur` - grain duration\n- `carfreq` - carrier frequency\n- `modfreq` - modulator frequency\n- `index` - FM index\n- `pan` - pan position\n- `envbufnum` - grain envelope buffer\n- `maxGrains` - max simultaneous grains',

	// ── Random UGens ──────────────────────────────────────────────────────
	'ExpRand': '**ExpRand** - Random float on exponential distribution (per synth)\n\n```supercollider\nExpRand(lo: 0.01, hi: 1.0)\n```\n\n**Arguments:**\n- `lo` - lower bound (nonzero, same sign as hi)\n- `hi` - upper bound',
	'IRand': '**IRand** - Random integer value (per synth)\n\n```supercollider\nIRand(lo: 0, hi: 127)\n```\n\n**Arguments:**\n- `lo` - lower bound\n- `hi` - upper bound',
	'NRand': '**NRand** - Sum of N uniform random numbers (approx normal for large N)\n\n```supercollider\nNRand(lo: 0, hi: 1, n: 0)\n```\n\n**Arguments:**\n- `lo` - lower bound\n- `hi` - upper bound\n- `n` - number of random values to sum',
	'LinRand': '**LinRand** - Linearly distributed random value\n\n```supercollider\nLinRand(lo: 0, hi: 1, minmax: 0)\n```\n\n**Arguments:**\n- `lo` - lower bound\n- `hi` - upper bound\n- `minmax` - 0=toward lo, 1=toward hi, 2=toward center',
	'TRand': '**TRand** - Triggered random float between lo and hi\n\n```supercollider\nTRand.ar(lo: 0, hi: 1, trig)\nTRand.kr(lo: 0, hi: 1, trig)\n```\n\n**Arguments:**\n- `lo` - lower bound\n- `hi` - upper bound\n- `trig` - trigger signal',
	'TExpRand': '**TExpRand** - Triggered exponentially distributed random value\n\n```supercollider\nTExpRand.ar(lo: 0.01, hi: 1, trig)\nTExpRand.kr(lo: 0.01, hi: 1, trig)\n```\n\n**Arguments:**\n- `lo` - lower bound (nonzero)\n- `hi` - upper bound\n- `trig` - trigger signal',
	'TIRand': '**TIRand** - Triggered random integer between lo and hi\n\n```supercollider\nTIRand.ar(lo: 0, hi: 127, trig)\nTIRand.kr(lo: 0, hi: 127, trig)\n```\n\n**Arguments:**\n- `lo` - lower bound\n- `hi` - upper bound\n- `trig` - trigger signal',
	'Hasher': '**Hasher** - Map input to pseudorandom output via hash function\n\n```supercollider\nHasher.ar(in: 0, mul: 1, add: 0)\nHasher.kr(in: 0, mul: 1, add: 0)\n```\n\n**Arguments:**\n- `in` - input signal',
	'MantissaMask': '**MantissaMask** - Reduce mantissa bits for lo-fi effect\n\n```supercollider\nMantissaMask.ar(in: 0, bits: 3)\nMantissaMask.kr(in: 0, bits: 3)\n```\n\n**Arguments:**\n- `in` - input signal\n- `bits` - number of mantissa bits to preserve (0-23)',

	// ── JITLib ─────────────────────────────────────────────────────────────
	'NodeProxy': '**NodeProxy** - A reference on a server representing a bus for JITLib live coding\n\n```supercollider\nNodeProxy.new(server, rate, numChannels)\n```\n\n**Arguments:**\n- `server` - Server instance\n- `rate` - \\\\audio or \\\\control\n- `numChannels` - number of channels',
	'Ndef': '**Ndef** - Named NodeProxy for global live-coding references\n\n```supercollider\nNdef(key, object)\n```\n\n**Arguments:**\n- `key` - Symbol key\n- `object` - function, pattern, or other valid source',
	'ProxySpace': '**ProxySpace** - An Environment of NodeProxies for live coding\n\n```supercollider\nProxySpace.new(server, name, clock)\n```\n\n**Arguments:**\n- `server` - Server instance\n- `name` - optional name\n- `clock` - optional TempoClock',

	// ── MIDI / OSC (additional) ───────────────────────────────────────────
	'MIDIOut': '**MIDIOut** - Send MIDI messages to external devices\n\n```supercollider\nMIDIOut.new(port, uid)\n```\n\n**Arguments:**\n- `port` - MIDI port index\n- `uid` - unique device identifier',
	'MIDIdef': '**MIDIdef** - Named, persistent MIDI responder\n\n```supercollider\nMIDIdef(key, func, msgNum, chan, msgType, srcID)\n```\n\n**Arguments:**\n- `key` - Symbol key for this responder\n- `func` - response function\n- `msgNum` - MIDI note/CC number(s) to match\n- `chan` - MIDI channel(s)\n- `msgType` - \\\\noteOn, \\\\noteOff, \\\\cc, \\\\bend, etc.\n- `srcID` - source device UID',
	'OSCdef': '**OSCdef** - Named, persistent OSC responder\n\n```supercollider\nOSCdef(key, func, path, srcID, recvPort, argTemplate)\n```\n\n**Arguments:**\n- `key` - Symbol key\n- `func` - response function\n- `path` - OSC address path to match\n- `srcID` - source NetAddr\n- `recvPort` - listening port\n- `argTemplate` - template for argument matching',

	// ── Scales / Tuning ───────────────────────────────────────────────────
	'Scale': '**Scale** - Musical scale definition\n\n```supercollider\nScale.new(degrees, pitchesPerOctave, tuning, name)\nScale.major  Scale.minor  Scale.dorian  Scale.chromatic\n```\n\n**Arguments:**\n- `degrees` - array of integers or scale name symbol\n- `pitchesPerOctave` - pitches per octave\n- `tuning` - Tuning instance or symbol\n- `name` - scale name string',
	'Tuning': '**Tuning** - Tuning specification\n\n```supercollider\nTuning.new(tuning, octaveRatio: 2.0, name)\nTuning.et(pitchesPerOctave: 12)\n```\n\n**Arguments:**\n- `tuning` - array of semitone values\n- `octaveRatio` - frequency ratio of octave\n- `name` - tuning name',

	// ── Concurrency ───────────────────────────────────────────────────────
	'Condition': '**Condition** - Synchronization primitive: wait/signal for routines\n\n```supercollider\nCondition.new(test: false)\n```\n\n**Arguments:**\n- `test` - initial test value (Boolean or Function)',
	'Semaphore': '**Semaphore** - Concurrency control: limit concurrent threads\n\n```supercollider\nSemaphore.new(count: 1)\n```\n\n**Arguments:**\n- `count` - max simultaneous running threads',

	// ── Server ─────────────────────────────────────────────────────────────
	'ServerOptions': '**ServerOptions** - Server boot configuration\n\n```supercollider\nServerOptions.new\n```\n\nKey instance variables set before boot:\n- `numOutputBusChannels`, `numInputBusChannels`\n- `memSize`, `numBuffers`, `maxNodes`\n- `sampleRate`, `blockSize`, `device`',
	'EventStreamPlayer': '**EventStreamPlayer** - Plays event streams (created by Pattern.play)\n\n```supercollider\nEventStreamPlayer(stream, event)\n```\n\n**Arguments:**\n- `stream` - the stream to play\n- `event` - prototype event\n\nNote: usually created via `Pattern.play`, not directly',

	// ══════════════════════════════════════════════════════════════════════
	// ── sc3-plugins ───────────────────────────────────────────────────────
	// ══════════════════════════════════════════════════════════════════════

	// ── DEINDUGens (Reverbs) *(sc3-plugins)* ──────────────────────────────
	'JPverb': '**JPverb** *(sc3-plugins)* - Lush algorithmic reverb\n\n```supercollider\nJPverb.ar(in, t60: 1, damp: 0, size: 1, earlyDiff: 0.707, modDepth: 0.1, modFreq: 2, low: 1, mid: 1, high: 1, lowcut: 500, highcut: 2000)\n```\n\n**Arguments:**\n- `in` - input signal (mono or stereo)\n- `t60` - approximate reverberation time in seconds\n- `damp` - high-frequency damping (0-1)\n- `size` - room size (0.5-5)\n- `earlyDiff` - early reflection shape\n- `modDepth` - modulation depth\n- `modFreq` - modulation frequency',
	'Greyhole': '**Greyhole** *(sc3-plugins)* - Diffuse delay/reverb with feedback\n\n```supercollider\nGreyhole.ar(in, delayTime: 2, damp: 0, size: 1, diff: 0.707, feedback: 0.9, modDepth: 0.1, modFreq: 2)\n```\n\n**Arguments:**\n- `in` - input signal (mono or stereo)\n- `delayTime` - approximate delay time in seconds\n- `damp` - damping (0-1)\n- `size` - diffusion size\n- `diff` - diffusion amount\n- `feedback` - feedback amount\n- `modDepth` - modulation depth\n- `modFreq` - modulation frequency',

	// ── NHUGens (Reverb) *(sc3-plugins)* ──────────────────────────────────
	'NHHall': '**NHHall** *(sc3-plugins)* - Stereo algorithmic hall reverb\n\n```supercollider\nNHHall.ar(in, rt60: 1, stereo: 0.5, lowFreq: 200, lowRatio: 0.5, hiFreq: 4000, hiRatio: 0.5, earlyDiffusion: 0.5, lateDiffusion: 0.5, modRate: 0.2, modDepth: 0.3)\n```\n\n**Arguments:**\n- `in` - input signal (stereo)\n- `rt60` - reverb time in seconds\n- `stereo` - stereo spread (0-1)\n- `lowFreq` - crossover frequency for low EQ\n- `lowRatio` - low frequency RT60 ratio\n- `hiFreq` - crossover frequency for high EQ\n- `hiRatio` - high frequency RT60 ratio\n- `earlyDiffusion` - early reflection diffusion\n- `lateDiffusion` - late diffusion\n- `modRate` - modulation rate\n- `modDepth` - modulation depth',

	// ── DistortionUGens *(sc3-plugins)* ───────────────────────────────────
	'CrossoverDistortion': '**CrossoverDistortion** *(sc3-plugins)* - Crossover distortion simulation\n\n```supercollider\nCrossoverDistortion.ar(in, amp: 0.5, smooth: 0.5)\n```\n\n**Arguments:**\n- `in` - input signal\n- `amp` - distortion amount\n- `smooth` - smoothing amount',
	'Decimator': '**Decimator** *(sc3-plugins)* - Sample rate and bit depth reducer\n\n```supercollider\nDecimator.ar(in, rate: 44100, bits: 24)\n```\n\n**Arguments:**\n- `in` - input signal\n- `rate` - sample rate to reduce to\n- `bits` - bit depth to reduce to',
	'SmoothDecimator': '**SmoothDecimator** *(sc3-plugins)* - Smooth sample rate reducer\n\n```supercollider\nSmoothDecimator.ar(in, rate: 44100, smoothing: 0.5)\n```\n\n**Arguments:**\n- `in` - input signal\n- `rate` - sample rate\n- `smoothing` - smoothing amount',
	'SineShaper': '**SineShaper** *(sc3-plugins)* - Sine waveshaper\n\n```supercollider\nSineShaper.ar(in, limit: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `limit` - shaping limit',
	'Disintegrator': '**Disintegrator** *(sc3-plugins)* - Probabilistic sample disintegrator\n\n```supercollider\nDisintegrator.ar(in, probability: 0.5, multiplier: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `probability` - probability of passing sample through\n- `multiplier` - multiplier for rejected samples',

	// ── MCLDUGens *(sc3-plugins)* ─────────────────────────────────────────
	'Crest': '**Crest** *(sc3-plugins)* - Crest factor (peak-to-RMS ratio)\n\n```supercollider\nCrest.kr(in, numsamps: 400, gate: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `numsamps` - number of samples to average\n- `gate` - gate (1=measure, 0=hold)',
	'WaveLoss': '**WaveLoss** *(sc3-plugins)* - Drop chunks of audio\n\n```supercollider\nWaveLoss.ar(in, drop: 20, outof: 40, mode: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `drop` - number of chunks to drop\n- `outof` - total number of chunks\n- `mode` - 1=random, 2=sequential',
	'Squiz': '**Squiz** *(sc3-plugins)* - Waveset squeezing/stretching\n\n```supercollider\nSquiz.ar(in, pitchratio: 2, zcperchunk: 1, memlen: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `pitchratio` - pitch ratio (integer, >=2)\n- `zcperchunk` - zero-crossings per chunk\n- `memlen` - memory length in seconds',
	'InsideOut': '**InsideOut** *(sc3-plugins)* - Inside-out waveshaper\n\n```supercollider\nInsideOut.ar(in)\n```\n\n**Arguments:**\n- `in` - input signal',
	'Friction': '**Friction** *(sc3-plugins)* - Physical friction model as filter\n\n```supercollider\nFriction.ar(in, friction: 0.5, spring: 0.414, damp: 0.313, mass: 0.1, beltmass: 1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `friction` - friction coefficient\n- `spring` - string stiffness\n- `damp` - damping\n- `mass` - mass\n- `beltmass` - belt mass',

	// ── BerlachUGens (Filters) *(sc3-plugins)* ────────────────────────────
	'LPF18': '**LPF18** *(sc3-plugins)* - 3-pole low-pass filter with resonance and distortion\n\n```supercollider\nLPF18.ar(in, freq: 100, res: 1, dist: 0.4)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - cutoff frequency\n- `res` - resonance\n- `dist` - distortion amount',
	'PeakEQ4': '**PeakEQ4** *(sc3-plugins)* - Peaking 4th-order parametric EQ section\n\n```supercollider\nPeakEQ4.ar(in, freq: 1200, rs: 1, db: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - center frequency\n- `rs` - bandwidth ratio\n- `db` - boost/cut in dB',
	'PeakEQ2': '**PeakEQ2** *(sc3-plugins)* - Peaking 2nd-order parametric EQ section\n\n```supercollider\nPeakEQ2.ar(in, freq: 1200, rs: 1, db: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - center frequency\n- `rs` - bandwidth ratio\n- `db` - boost/cut in dB',

	// ── BlackrainUGens *(sc3-plugins)* ────────────────────────────────────
	'BMoog': '**BMoog** *(sc3-plugins)* - Moog-style filter\n\n```supercollider\nBMoog.ar(in, freq: 440, q: 0.5, mode: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - cutoff frequency\n- `q` - resonance (0-1)\n- `mode` - 0=LP, 1=HP, 2=BP',

	// ── MdaUGens (Piano) *(sc3-plugins)* ──────────────────────────────────
	'MdaPiano': '**MdaPiano** *(sc3-plugins)* - Piano physical model (mda)\n\n```supercollider\nMdaPiano.ar(freq: 440, gate: 1, vel: 100, decay: 0.8, release: 0.8, hard: 0.8, velhard: 0.8, muffle: 0.8, velmuff: 0.8, velcurve: 0.8, stereo: 0.2, tune: 0.5, random: 0.1, stretch: 0.1, sustain: 0)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `gate` - gate (1=on, 0=off)\n- `vel` - velocity (0-127)\n- `decay` - decay amount\n- `release` - release amount\n- `hard` - hardness\n- `velhard` - velocity-to-hardness\n- `muffle` - muffling amount\n- `velmuff` - velocity-to-muffle\n- `stereo` - stereo width\n- `tune` - tuning\n- `sustain` - sustain pedal (0/1)',

	// ── OteyPianoUGens *(sc3-plugins)* ────────────────────────────────────
	'OteyPiano': '**OteyPiano** *(sc3-plugins)* - Piano physical model (based on Otey)\n\n```supercollider\nOteyPiano.ar(freq: 440, vel: 1, t_gate: 0, rmin: 0.35, rmax: 2, rampl: 4, rampr: 8, rcore: 1, lmin: 0.07, lmax: 1.4, lampl: 4, lampr: 4, rho: 1, e: 1, zb: 1, zh: 0, mh: 1, k: 0.2, alpha: 3, p: 2, hpos: 0.142, loss: 1, detune: 0.0003, hammer_type: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `vel` - strike velocity\n- `t_gate` - trigger',

	// ── DWGUGens (Waveguide physical models) *(sc3-plugins)* ──────────────
	'DWGPlucked': '**DWGPlucked** *(sc3-plugins)* - Waveguide plucked string\n\n```supercollider\nDWGPlucked.ar(freq: 440, amp: 0.5, gate: 1, pos: 0.14, c1: 1, c3: 30, inp: 0, release: 0.1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `amp` - amplitude\n- `gate` - gate\n- `pos` - pluck position (0-1)\n- `c1` - filter coefficient 1\n- `c3` - filter coefficient 3\n- `inp` - external input\n- `release` - release time',
	'DWGBowed': '**DWGBowed** *(sc3-plugins)* - Waveguide bowed string\n\n```supercollider\nDWGBowed.ar(freq: 440, velb: 0.5, force: 1, gate: 1, pos: 0.14, release: 0.1, c1: 1, c3: 3, impZ: 0.55, fB: 2)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `velb` - bow velocity\n- `force` - bow force\n- `gate` - gate\n- `pos` - bow position\n- `release` - release time\n- `c1` / `c3` - filter coefficients\n- `impZ` - impedance\n- `fB` - bow friction parameter',
	'DWGBowedSimple': '**DWGBowedSimple** *(sc3-plugins)* - Simplified waveguide bowed string\n\n```supercollider\nDWGBowedSimple.ar(freq: 440, velb: 0.5, force: 1, gate: 1, pos: 0.14, release: 0.1, c1: 1, c3: 30)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `velb` - bow velocity\n- `force` - bow force\n- `gate` - gate\n- `pos` - bow position\n- `release` - release time\n- `c1` / `c3` - filter coefficients',
	'DWGBowedTor': '**DWGBowedTor** *(sc3-plugins)* - Waveguide bowed string with torsional waves\n\n```supercollider\nDWGBowedTor.ar(freq: 440, velb: 0.5, force: 1, gate: 1, pos: 0.14, release: 0.1, c1: 1, c3: 3, impZ: 0.55, fB: 2, mistune: 5.2, c1tor: 1, c3tor: 3000, iZtor: 1.8)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `velb` - bow velocity\n- `force` - bow force\n- `gate` - gate\n- `pos` - bow position\n- `mistune` - torsional wave mistuning\n- `c1tor` / `c3tor` - torsional filter coefficients',
	'DWGSoundBoard': '**DWGSoundBoard** *(sc3-plugins)* - Waveguide soundboard model\n\n```supercollider\nDWGSoundBoard.ar(inp: 0, c1: 20, c3: 20, mix: 0.8, d1: 199, d2: 211, d3: 223, d4: 227, d5: 229, d6: 233, d7: 239, d8: 241)\n```\n\n**Arguments:**\n- `inp` - input signal\n- `c1` / `c3` - filter coefficients\n- `mix` - mix amount\n- `d1`-`d8` - delay lengths (prime numbers)',

	// ── MembraneUGens *(sc3-plugins)* ─────────────────────────────────────
	'MembraneCircle': '**MembraneCircle** *(sc3-plugins)* - Circular membrane physical model\n\n```supercollider\nMembraneCircle.ar(excitation, tension: 0.05, loss: 0.99999)\n```\n\n**Arguments:**\n- `excitation` - excitation signal\n- `tension` - membrane tension (0-1)\n- `loss` - energy loss (0-1)',
	'MembraneHexagon': '**MembraneHexagon** *(sc3-plugins)* - Hexagonal membrane physical model\n\n```supercollider\nMembraneHexagon.ar(excitation, tension: 0.05, loss: 0.99999)\n```\n\n**Arguments:**\n- `excitation` - excitation signal\n- `tension` - membrane tension (0-1)\n- `loss` - energy loss (0-1)',

	// ── StkUGens (STK physical models) *(sc3-plugins)* ────────────────────
	'StkPluck': '**StkPluck** *(sc3-plugins)* - STK plucked string\n\n```supercollider\nStkPluck.ar(freq: 440, decay: 0.99)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `decay` - decay time',
	'StkFlute': '**StkFlute** *(sc3-plugins)* - STK flute model\n\n```supercollider\nStkFlute.ar(freq: 440, jetDelay: 49, noisegain: 0.15, jetRatio: 0.32)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `jetDelay` - jet delay\n- `noisegain` - noise gain\n- `jetRatio` - jet ratio',
	'StkBowed': '**StkBowed** *(sc3-plugins)* - STK bowed string model\n\n```supercollider\nStkBowed.ar(freq: 220, bowpressure: 64, bowposition: 64, vibfreq: 64, vibgain: 64, loudness: 64, gate: 1, attackrate: 1, decayrate: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `bowpressure` - bow pressure (0-128)\n- `bowposition` - bow position (0-128)\n- `vibfreq` - vibrato frequency\n- `vibgain` - vibrato gain\n- `loudness` - loudness\n- `gate` - gate\n- `attackrate` / `decayrate` - envelope rates',
	'StkMandolin': '**StkMandolin** *(sc3-plugins)* - STK mandolin model\n\n```supercollider\nStkMandolin.ar(freq: 520, bodysize: 64, pickposition: 64, stringdamping: 69, stringdetune: 10, aftertouch: 64, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `bodysize` - body size\n- `pickposition` - pick position\n- `stringdamping` - string damping\n- `stringdetune` - string detune\n- `aftertouch` - aftertouch\n- `trig` - trigger',
	'StkSaxofony': '**StkSaxofony** *(sc3-plugins)* - STK saxophone model\n\n```supercollider\nStkSaxofony.ar(freq: 220, reedstiffness: 64, reedaperture: 64, noisegain: 20, blowposition: 26, vibratofrequency: 20, vibratogain: 20, breathpressure: 128, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `reedstiffness` - reed stiffness\n- `reedaperture` - reed aperture\n- `noisegain` - noise gain\n- `blowposition` - blow position\n- `breathpressure` - breath pressure\n- `trig` - trigger',
	'StkClarinet': '**StkClarinet** *(sc3-plugins)* - STK clarinet model\n\n```supercollider\nStkClarinet.ar(freq: 440, reedstiffness: 64, noisegain: 4, vibfreq: 64, vibgain: 11, breathpressure: 64, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `reedstiffness` - reed stiffness\n- `noisegain` - noise gain\n- `vibfreq` - vibrato frequency\n- `vibgain` - vibrato gain\n- `breathpressure` - breath pressure\n- `trig` - trigger',
	'StkBlowHole': '**StkBlowHole** *(sc3-plugins)* - STK clarinet with tone-hole/register\n\n```supercollider\nStkBlowHole.ar(freq: 440, reedstiffness: 64, noisegain: 20, tonehole: 64, register: 11, breathpressure: 64)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `reedstiffness` - reed stiffness\n- `noisegain` - noise gain\n- `tonehole` - tone-hole size\n- `register` - register key\n- `breathpressure` - breath pressure',
	'StkModalBar': '**StkModalBar** *(sc3-plugins)* - STK modal bar percussion model\n\n```supercollider\nStkModalBar.ar(freq: 440, instrument: 0, stickhardness: 64, stickposition: 64, vibratogain: 20, vibratofreq: 20, directstickmix: 64, volume: 64, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `instrument` - instrument preset (0-8)\n- `stickhardness` - stick hardness\n- `stickposition` - stick position\n- `vibratogain` / `vibratofreq` - vibrato\n- `directstickmix` - direct/stick mix\n- `trig` - trigger',
	'StkShakers': '**StkShakers** *(sc3-plugins)* - STK shaker percussion models\n\n```supercollider\nStkShakers.ar(instr: 0, energy: 64, decay: 64, objects: 64, resfreq: 64)\n```\n\n**Arguments:**\n- `instr` - instrument number (0-22)\n- `energy` - shaking energy\n- `decay` - system decay\n- `objects` - number of objects\n- `resfreq` - resonance frequency',
	'StkBandedWG': '**StkBandedWG** *(sc3-plugins)* - STK banded waveguide (glass/metal bars)\n\n```supercollider\nStkBandedWG.ar(freq: 440, instr: 0, bowpressure: 0, bowmotion: 0, integration: 0, modalresonance: 64, bowvelocity: 0, setstriking: 0, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `instr` - instrument preset (0-3)\n- `bowpressure` - bow pressure\n- `bowmotion` - bow motion\n- `modalresonance` - modal resonance\n- `trig` - trigger',
	'StkVoicForm': '**StkVoicForm** *(sc3-plugins)* - STK vocal formant model\n\n```supercollider\nStkVoicForm.ar(freq: 440, vuvmix: 64, vowelphon: 64, vibfreq: 64, vibgain: 20, loudness: 64, trig: 1)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `vuvmix` - voiced/unvoiced mix\n- `vowelphon` - vowel/phoneme selection\n- `vibfreq` - vibrato frequency\n- `vibgain` - vibrato gain\n- `loudness` - loudness\n- `trig` - trigger',

	// ── AYUGens *(sc3-plugins)* ───────────────────────────────────────────
	'AY': '**AY** *(sc3-plugins)* - Emulation of AY-3-8910 chip (ZX Spectrum sound)\n\n```supercollider\nAY.ar(tonea: 10, toneb: 10, tonec: 10, noise: 10, control: 7, vola: 15, volb: 15, volc: 15, envfreq: 4, envstyle: 1, chiptype: 0)\n```\n\n**Arguments:**\n- `tonea` / `toneb` / `tonec` - tone periods (0-4095)\n- `noise` - noise period (0-31)\n- `control` - enable flags (bitfield)\n- `vola` / `volb` / `volc` - volumes (0-15, 16=envelope)\n- `envfreq` - envelope frequency\n- `envstyle` - envelope shape\n- `chiptype` - 0=AY, 1=YM',

	// ── LoopBufUGens *(sc3-plugins)* ──────────────────────────────────────
	'LoopBuf': '**LoopBuf** *(sc3-plugins)* - Buffer player with crossfade looping\n\n```supercollider\nLoopBuf.ar(numChannels, bufnum: 0, rate: 1, gate: 1, startPos: 0, startLoop: 0, endLoop: 0, interpolation: 2)\n```\n\n**Arguments:**\n- `numChannels` - number of channels\n- `bufnum` - buffer number\n- `rate` - playback rate\n- `gate` - gate (1=play, 0=stop)\n- `startPos` - start position in frames\n- `startLoop` - loop start in frames\n- `endLoop` - loop end in frames (0=end of buffer)\n- `interpolation` - 1=none, 2=linear, 4=cubic',

	// ── VBAPUGens *(sc3-plugins)* ─────────────────────────────────────────
	'VBAP': '**VBAP** *(sc3-plugins)* - Vector Base Amplitude Panning\n\n```supercollider\nVBAP.ar(numChans, in, bufnum, azimuth: 0, elevation: 0, spread: 0)\n```\n\n**Arguments:**\n- `numChans` - number of output channels\n- `in` - input signal\n- `bufnum` - speaker layout buffer (from VBAPSpeakerArray)\n- `azimuth` - azimuth angle in degrees\n- `elevation` - elevation angle\n- `spread` - spread (0-100)',

	// ── BatUGens (Analysis) *(sc3-plugins)* ───────────────────────────────
	'Coyote': '**Coyote** *(sc3-plugins)* - Onset detector\n\n```supercollider\nCoyote.kr(in, trackFall: 0.2, slowLag: 0.2, fastLag: 0.01, fastMul: 0.5, thresh: 0.05, minDur: 0.1)\n```\n\n**Arguments:**\n- `in` - audio input\n- `trackFall` - tracking fall rate\n- `slowLag` - slow envelope lag\n- `fastLag` - fast envelope lag\n- `fastMul` - fast multiplier\n- `thresh` - detection threshold\n- `minDur` - minimum inter-onset time',
	'WAmp': '**WAmp** *(sc3-plugins)* - Windowed amplitude follower\n\n```supercollider\nWAmp.kr(in, winSize: 0.1)\n```\n\n**Arguments:**\n- `in` - input signal\n- `winSize` - window size in seconds',

	// ── BhobUGens (Chaos) *(sc3-plugins)* ─────────────────────────────────
	'Henon2DN': '**Henon2DN** *(sc3-plugins)* - Henon 2D chaotic map (no interpolation)\n\n```supercollider\nHenon2DN.ar(minfreq: 11025, maxfreq: 22050, a: 1.4, b: 0.3, x0, y0)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `a` / `b` - Henon parameters\n- `x0` / `y0` - initial conditions',
	'Henon2DL': '**Henon2DL** *(sc3-plugins)* - Henon 2D chaotic map (linear interpolation)\n\n```supercollider\nHenon2DL.ar(minfreq: 11025, maxfreq: 22050, a: 1.4, b: 0.3, x0, y0)\n```',
	'Henon2DC': '**Henon2DC** *(sc3-plugins)* - Henon 2D chaotic map (cubic interpolation)\n\n```supercollider\nHenon2DC.ar(minfreq: 11025, maxfreq: 22050, a: 1.4, b: 0.3, x0, y0)\n```',
	'Gbman2DN': '**Gbman2DN** *(sc3-plugins)* - Gingerbreadman 2D chaotic map (no interpolation)\n\n```supercollider\nGbman2DN.ar(minfreq: 11025, maxfreq: 22050, x0: 1.2, y0: 2.1)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `x0` / `y0` - initial conditions',
	'Gbman2DL': '**Gbman2DL** *(sc3-plugins)* - Gingerbreadman 2D chaotic map (linear interp)\n\n```supercollider\nGbman2DL.ar(minfreq: 11025, maxfreq: 22050, x0: 1.2, y0: 2.1)\n```',
	'Gbman2DC': '**Gbman2DC** *(sc3-plugins)* - Gingerbreadman 2D chaotic map (cubic interp)\n\n```supercollider\nGbman2DC.ar(minfreq: 11025, maxfreq: 22050, x0: 1.2, y0: 2.1)\n```',
	'Standard2DN': '**Standard2DN** *(sc3-plugins)* - Standard map 2D chaotic oscillator (no interpolation)\n\n```supercollider\nStandard2DN.ar(minfreq: 11025, maxfreq: 22050, k: 1.4, x0, y0)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `k` - perturbation amount\n- `x0` / `y0` - initial conditions',
	'Latoocarfian2DN': '**Latoocarfian2DN** *(sc3-plugins)* - Latoocarfian 2D chaotic oscillator (no interp)\n\n```supercollider\nLatoocarfian2DN.ar(minfreq: 11025, maxfreq: 22050, a: 1, b: 3, c: 0.5, d: 0.5, x0, y0)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `a` / `b` / `c` / `d` - equation parameters\n- `x0` / `y0` - initial conditions',
	'Latoocarfian2DC': '**Latoocarfian2DC** *(sc3-plugins)* - Latoocarfian 2D chaotic oscillator (cubic interp)\n\n```supercollider\nLatoocarfian2DC.ar(minfreq: 11025, maxfreq: 22050, a: 1, b: 3, c: 0.5, d: 0.5, x0, y0)\n```',
	'Lorenz2DN': '**Lorenz2DN** *(sc3-plugins)* - Lorenz 2D chaotic oscillator (no interp)\n\n```supercollider\nLorenz2DN.ar(minfreq: 11025, maxfreq: 22050, s: 10, r: 28, b: 2.667, h: 0.02, x0, y0, z0)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `s` / `r` / `b` - Lorenz parameters\n- `h` - integration step size\n- `x0` / `y0` / `z0` - initial conditions',
	'Lorenz2DC': '**Lorenz2DC** *(sc3-plugins)* - Lorenz 2D chaotic oscillator (cubic interp)\n\n```supercollider\nLorenz2DC.ar(minfreq: 11025, maxfreq: 22050, s: 10, r: 28, b: 2.667, h: 0.02, x0, y0, z0)\n```',
	'Fhn2DN': '**Fhn2DN** *(sc3-plugins)* - FitzHugh-Nagumo 2D chaotic oscillator (no interp)\n\n```supercollider\nFhn2DN.ar(minfreq: 11025, maxfreq: 22050, urate: 0.1, wrate: 0.1, b0: 0.6, b1: 0.8, i: 0, u0: 0, w0: 0)\n```\n\n**Arguments:**\n- `minfreq` / `maxfreq` - frequency range\n- `urate` / `wrate` - integration rates\n- `b0` / `b1` - equation parameters\n- `i` - external input current\n- `u0` / `w0` - initial conditions',
	'Fhn2DC': '**Fhn2DC** *(sc3-plugins)* - FitzHugh-Nagumo 2D chaotic oscillator (cubic interp)\n\n```supercollider\nFhn2DC.ar(minfreq: 11025, maxfreq: 22050, urate: 0.1, wrate: 0.1, b0: 0.6, b1: 0.8, i: 0, u0: 0, w0: 0)\n```',

	// ── BhobUGens (Noise/Generators) *(sc3-plugins)* ──────────────────────
	'GaussTrig': '**GaussTrig** *(sc3-plugins)* - Gaussian-distributed trigger\n\n```supercollider\nGaussTrig.ar(freq: 440, dev: 0.3)\n```\n\n**Arguments:**\n- `freq` - average trigger frequency\n- `dev` - deviation (0-1)',
	'LFBrownNoise0': '**LFBrownNoise0** *(sc3-plugins)* - Brownian noise (step, with distribution control)\n\n```supercollider\nLFBrownNoise0.ar(freq: 20, dev: 1, dist: 0)\n```\n\n**Arguments:**\n- `freq` - frequency of new values\n- `dev` - deviation / step size\n- `dist` - distribution (0=linear, 1=cauchy, 2=logistic, 3=hyperbcos, 4=arcsine, 5=expon, 6=sinus)',
	'LFBrownNoise1': '**LFBrownNoise1** *(sc3-plugins)* - Brownian noise (linear interp, with distribution)\n\n```supercollider\nLFBrownNoise1.ar(freq: 20, dev: 1, dist: 0)\n```',
	'LFBrownNoise2': '**LFBrownNoise2** *(sc3-plugins)* - Brownian noise (quadratic interp, with distribution)\n\n```supercollider\nLFBrownNoise2.ar(freq: 20, dev: 1, dist: 0)\n```',
	'Gendy4': '**Gendy4** *(sc3-plugins)* - Dynamic stochastic synthesis (cubic interpolation)\n\n```supercollider\nGendy4.ar(ampdist: 1, durdist: 1, adparam: 1, ddparam: 1, minfreq: 440, maxfreq: 660, ampscale: 0.5, durscale: 0.5, initCPs: 12, knum)\n```\n\n**Arguments:**\n- `ampdist` - amplitude distribution\n- `durdist` - duration distribution\n- `adparam` / `ddparam` - distribution parameters\n- `minfreq` / `maxfreq` - frequency range\n- `ampscale` / `durscale` - scaling\n- `initCPs` - number of control points\n- `knum` - active control points (defaults to initCPs)',
	'Gendy5': '**Gendy5** *(sc3-plugins)* - Dynamic stochastic synthesis (no interpolation)\n\n```supercollider\nGendy5.ar(ampdist: 1, durdist: 1, adparam: 1, ddparam: 1, minfreq: 440, maxfreq: 660, ampscale: 0.5, durscale: 0.5, initCPs: 12, knum)\n```',

	// ── SLUGens (Dynamical systems) *(sc3-plugins)* ───────────────────────
	'DoubleWell': '**DoubleWell** *(sc3-plugins)* - Forced double-well oscillator [2 outputs]\n\n```supercollider\nDoubleWell.ar(reset: 0, ratex: 0.01, ratey: 0.01, f: 1, w: 0.001, delta: 1, initx: 0, inity: 0)\n```\n\n**Arguments:**\n- `reset` - reset trigger\n- `ratex` / `ratey` - integration rates\n- `f` - external forcing\n- `w` - forcing frequency\n- `delta` - nonlinearity\n- `initx` / `inity` - initial conditions',
	'DoubleWell3': '**DoubleWell3** *(sc3-plugins)* - Forced double-well oscillator (variant)\n\n```supercollider\nDoubleWell3.ar(reset: 0, rate: 0.01, f: 0, delta: 0.25, initx: 0, inity: 0)\n```',
	'Brusselator': '**Brusselator** *(sc3-plugins)* - Brusselator chemical reaction oscillator [2 outputs]\n\n```supercollider\nBrusselator.ar(reset: 0, rate: 0.01, mu: 1, gamma: 1, initx: 0.5, inity: 0.5)\n```\n\n**Arguments:**\n- `reset` - reset trigger\n- `rate` - integration rate\n- `mu` / `gamma` - reaction parameters\n- `initx` / `inity` - initial concentrations',
	'FitzHughNagumo': '**FitzHughNagumo** *(sc3-plugins)* - FitzHugh-Nagumo neuron model [2 outputs]\n\n```supercollider\nFitzHughNagumo.ar(reset: 0, rateu: 0.01, ratew: 0.01, b0: 1, b1: 1, initu: 0, initw: 0)\n```\n\n**Arguments:**\n- `reset` - reset trigger\n- `rateu` / `ratew` - integration rates\n- `b0` / `b1` - equation parameters\n- `initu` / `initw` - initial conditions',

	// ── MCLDUGens (Chaos) *(sc3-plugins)* ─────────────────────────────────
	'RosslerL': '**RosslerL** *(sc3-plugins)* - Rössler attractor chaotic oscillator [3 outputs]\n\n```supercollider\nRosslerL.ar(freq: 22050, a: 0.2, b: 0.2, c: 5.7, h: 0.05, xi: 0.1, yi: 0, zi: 0)\n```\n\n**Arguments:**\n- `freq` - sample rate\n- `a` / `b` / `c` - Rössler parameters\n- `h` - integration step\n- `xi` / `yi` / `zi` - initial conditions',
	'Perlin3': '**Perlin3** *(sc3-plugins)* - 3D Perlin noise\n\n```supercollider\nPerlin3.ar(x, y, z)\n```\n\n**Arguments:**\n- `x` / `y` / `z` - spatial coordinates',

	// ── BhobUGens (Filters) *(sc3-plugins)* ───────────────────────────────
	'MoogLadder': '**MoogLadder** *(sc3-plugins)* - Moog ladder low-pass filter\n\n```supercollider\nMoogLadder.ar(in, freq: 440, res: 0)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - cutoff frequency\n- `res` - resonance (0-1)',
	'NestedAllpassN': '**NestedAllpassN** *(sc3-plugins)* - Nested allpass filter\n\n```supercollider\nNestedAllpassN.ar(in, delay1: 0.03, delay2: 0.01, gain1: 0.4, gain2: 0.1)\n```',
	'DoubleNestedAllpassN': '**DoubleNestedAllpassN** *(sc3-plugins)* - Double-nested allpass filter\n\n```supercollider\nDoubleNestedAllpassN.ar(in, delay1: 0.03, delay2: 0.01, delay3: 0.005, gain1: 0.4, gain2: 0.1, gain3: 0.05)\n```',

	// ── BlackrainUGens *(sc3-plugins)* ────────────────────────────────────
	'SVF': '**SVF** *(sc3-plugins)* - State Variable Filter (lowpass, highpass, bandpass, notch, peak)\n\n```supercollider\nSVF.ar(signal, cutoff: 2200, res: 0.1, lowpass: 1, bandpass: 0, highpass: 0, notch: 0, peak: 0)\n```\n\n**Arguments:**\n- `signal` - input signal\n- `cutoff` - cutoff frequency\n- `res` - resonance (0-1)\n- `lowpass`..`peak` - mix of filter outputs (0-1)',

	// ── DEINDUGens *(sc3-plugins)* ────────────────────────────────────────
	'ComplexRes': '**ComplexRes** *(sc3-plugins)* - Complex resonator (bandpass with precise frequency)\n\n```supercollider\nComplexRes.ar(in, freq: 100, decay: 0.2)\n```\n\n**Arguments:**\n- `in` - input signal (impulse excitation works well)\n- `freq` - resonant frequency\n- `decay` - 60dB decay time in seconds',
	'RMS': '**RMS** *(sc3-plugins)* - RMS amplitude follower\n\n```supercollider\nRMS.ar(in, lpFreq: 40)\n```\n\n**Arguments:**\n- `in` - input signal\n- `lpFreq` - lowpass frequency for smoothing',

	// ── MCLDUGens (Oscillators) *(sc3-plugins)* ───────────────────────────
	'SawDPW': '**SawDPW** *(sc3-plugins)* - Band-limited saw via DPW (Differentiated Parabolic Wave)\n\n```supercollider\nSawDPW.ar(freq: 440)\n```\n\n**Arguments:**\n- `freq` - frequency',
	'PulseDPW': '**PulseDPW** *(sc3-plugins)* - Band-limited pulse via DPW\n\n```supercollider\nPulseDPW.ar(freq: 440, width: 0.5)\n```\n\n**Arguments:**\n- `freq` - frequency\n- `width` - pulse width (0-1)',

	// ── SLUGens (more dynamical systems) *(sc3-plugins)* ──────────────────
	'GravityGrid': '**GravityGrid** *(sc3-plugins)* - Gravity simulation on 2D grid [2 outputs]\n\n```supercollider\nGravityGrid.ar(reset: 0, rate: 0.01, newx: 0, newy: 0, bufnum)\n```\n\n**Arguments:**\n- `reset` - reset trigger\n- `rate` - integration rate\n- `newx` / `newy` - gravitational attractor position\n- `bufnum` - buffer of mass positions',
	'TermanWang': '**TermanWang** *(sc3-plugins)* - Terman-Wang neuronal oscillator [2 outputs]\n\n```supercollider\nTermanWang.ar(reset: 0, ratex: 0.01, ratey: 0.01, alpha: 1, beta: 1, eta: 1, initx: 0.5, inity: 0.5)\n```',
	'WeaklyNonlinear': '**WeaklyNonlinear** *(sc3-plugins)* - Weakly nonlinear oscillator (Duffing-like)\n\n```supercollider\nWeaklyNonlinear.ar(reset: 0, ratex: 0.01, ratey: 0.01, freq: 1, initx: 0, inity: 0, alpha: 0, xexponent: 0, beta: 0, yexponent: 0)\n```',

	// ── DWGUGens (more digital waveguide) *(sc3-plugins)* ─────────────────
	'DWGPluckedStiff': '**DWGPluckedStiff** *(sc3-plugins)* - Digital waveguide plucked string with stiffness\n\n```supercollider\nDWGPluckedStiff.ar(freq: 440, amp: 0.5, gate: 1, pos: 0.14, c1: 1, c3: 30, inp: 0, release: 0.1, fB: 2, mistune: 1.008)\n```\n\n**Arguments:**\n- `freq` - pitch\n- `amp` - pluck amplitude\n- `gate` - play trigger\n- `pos` - pick position (0-1)\n- `c1` / `c3` - damping coefficients\n- `fB` - inharmonicity factor\n- `mistune` - detuning between two coupled strings',
	'DWGPlucked2': '**DWGPlucked2** *(sc3-plugins)* - Digital waveguide plucked (coupled strings)\n\n```supercollider\nDWGPlucked2.ar(freq: 440, amp: 0.5, gate: 1, pos: 0.14, c1: 1, c3: 30, inp: 0, release: 0.1, mistune: 1.008, mp: 0.55, gc: 0.01)\n```',

	// ── JoshUGens *(sc3-plugins)* ─────────────────────────────────────────
	'MoogVCF': '**MoogVCF** *(sc3-plugins)* - Moog VCF emulation (4-pole ladder)\n\n```supercollider\nMoogVCF.ar(in, freq: 100, gain: 2)\n```\n\n**Arguments:**\n- `in` - input signal\n- `freq` - cutoff frequency\n- `gain` - resonance/feedback (0-4, self-oscillates near 4)',
	'CombLP': '**CombLP** *(sc3-plugins)* - Comb filter with low-pass in feedback loop\n\n```supercollider\nCombLP.ar(in, maxdelaytime: 0.2, delaytime: 0.2, decaytime: 1, coef: 0.5)\n```\n\n**Arguments:**\n- `in` - input signal\n- `maxdelaytime` / `delaytime` - delay times\n- `decaytime` - 60dB decay time\n- `coef` - lowpass coefficient (0-1)',
	'TGrains2': '**TGrains2** *(sc3-plugins)* - Buffer granulator (trigger-based, with att/dec)\n\n```supercollider\nTGrains2.ar(numChannels: 2, trigger, bufnum, rate: 1, centerPos: 0, dur: 0.1, pan: 0, amp: 0.1, att: 0.5, dec: 0.5, interp: 4)\n```\n\n**Arguments:**\n- `trigger` - grain trigger\n- `bufnum` - buffer to granulate\n- `rate` - playback rate\n- `centerPos` - grain center in buffer (seconds)\n- `dur` - grain duration\n- `pan` / `amp` - spatialization and amplitude\n- `att` / `dec` - envelope attack/decay shape',
	'TGrains3': '**TGrains3** *(sc3-plugins)* - Buffer granulator (trigger-based, enhanced)\n\n```supercollider\nTGrains3.ar(numChannels: 2, trigger, bufnum, rate: 1, centerPos: 0, dur: 0.1, pan: 0, amp: 0.1, att: 0.5, dec: 0.5, interp: 4)\n```',

	// ── NCAnalysisUGens *(sc3-plugins)* ───────────────────────────────────
	'Qitch': '**Qitch** *(sc3-plugins)* - Constant-Q pitch tracker\n\n```supercollider\nQitch.kr(in, databufnum, ampThreshold: 0.01, algoflag: 1)\n```\n\n**Arguments:**\n- `in` - audio input\n- `databufnum` - analysis data buffer\n- `ampThreshold` - minimum amplitude to track\n- `algoflag` - algorithm selection',
	'LPCAnalyzer': '**LPCAnalyzer** *(sc3-plugins)* - Real-time LPC (Linear Predictive Coding) analysis\n\n```supercollider\nLPCAnalyzer.ar(input, source, n: 256, p: 10, testE: 0, delta: 0.999)\n```\n\n**Arguments:**\n- `input` - signal to analyze\n- `source` - excitation signal for resynthesis\n- `n` - FFT frame size\n- `p` - number of poles\n- `testE` - error testing flag\n- `delta` - stability factor',

	// ── QuantityUGens *(sc3-plugins)* ─────────────────────────────────────
	'MovingAverage': '**MovingAverage** *(sc3-plugins)* - Moving average filter\n\n```supercollider\nMovingAverage.ar(in, length: 10)\n```\n\n**Arguments:**\n- `in` - input signal\n- `length` - averaging window length in samples',
};

// Documentation for methods
const METHOD_DOCS: { [key: string]: string } = {
	'play': '**play** - Start playing\n\n```supercollider\n{ SinOsc.ar(440) }.play;      // Play function as synth\nPbind(...).play;               // Play pattern\nRoutine({ ... }).play;         // Play routine\n```',
	'stop': '**stop** - Stop playing\n\n```supercollider\nx.stop;  // Stop a playing object\n```',
	'free': '**free** - Free a synth/node\n\n```supercollider\nx.free;  // Free synth x\n```',
	'release': '**release** - Release with envelope\n\n```supercollider\nx.release(releaseTime);  // Release synth over time\n```',
	'set': '**set** - Set synth parameters\n\n```supercollider\nx.set(\\freq, 880, \\amp, 0.5);\n```',
	'get': '**get** - Get synth parameter value\n\n```supercollider\nx.get(\\freq, { |val| val.postln });\n```',
	'ar': '**ar** - Audio rate (sample rate)\n\n```supercollider\nSinOsc.ar(440)  // 44100 Hz sample rate\n```',
	'kr': '**kr** - Control rate (audio rate / 64)\n\n```supercollider\nSinOsc.kr(1)  // ~689 Hz for modulation\n```',
	'ir': '**ir** - Initialization rate (once at start)\n\n```supercollider\nRand.ir(0, 1)  // Random value set once\n```',
	'new': '**new** - Create new instance\n\n```supercollider\nArray.new(10);\nSynth.new(\\synthName);\n```',
	'add': '**add** - Add to collection / Add SynthDef to server\n\n```supercollider\nlist.add(item);\nSynthDef(\\name, {...}).add;\n```',
	'do': '**do** - Iterate over collection\n\n```supercollider\n[1,2,3].do { |item, i| item.postln };\n10.do { |i| i.postln };\n```',
	'collect': '**collect** - Transform each element\n\n```supercollider\n[1,2,3].collect { |x| x * 2 }  // [2,4,6]\n```',
	'select': '**select** - Filter matching elements\n\n```supercollider\n[1,2,3,4].select { |x| x.even }  // [2,4]\n```',
	'reject': '**reject** - Filter non-matching elements\n\n```supercollider\n[1,2,3,4].reject { |x| x.even }  // [1,3]\n```',
	'midicps': '**midicps** - MIDI note to frequency (Hz)\n\n```supercollider\n69.midicps  // 440.0 (A4)\n60.midicps  // 261.6256 (C4)\n```',
	'cpsmidi': '**cpsmidi** - Frequency (Hz) to MIDI note\n\n```supercollider\n440.cpsmidi  // 69.0 (A4)\n```',
	'linlin': '**linlin** - Linear to linear mapping\n\n```supercollider\nvalue.linlin(inMin, inMax, outMin, outMax)\n0.5.linlin(0, 1, 100, 200)  // 150\n```',
	'linexp': '**linexp** - Linear to exponential mapping\n\n```supercollider\nvalue.linexp(inMin, inMax, outMin, outMax)\n0.5.linexp(0, 1, 20, 20000)  // 632.5\n```',
	'explin': '**explin** - Exponential to linear mapping\n\n```supercollider\nvalue.explin(inMin, inMax, outMin, outMax)\n```',
	'clip': '**clip** - Constrain to range\n\n```supercollider\nvalue.clip(min, max)\n150.clip(0, 100)  // 100\n```',
	'wrap': '**wrap** - Wrap value to range\n\n```supercollider\nvalue.wrap(min, max)\n5.wrap(0, 4)  // 1\n```',
	'fold': '**fold** - Fold value at boundaries\n\n```supercollider\nvalue.fold(min, max)\n5.fold(0, 4)  // 3\n```',
	'rand': '**rand** - Random value from 0 to receiver\n\n```supercollider\n100.rand  // Random 0-99\n1.0.rand  // Random 0.0-1.0\n```',
	'rrand': '**rrand** - Random in range\n\n```supercollider\nrrand(10, 20)  // Random 10-20\n```',
	'postln': '**postln** - Post to console with newline\n\n```supercollider\n"Hello".postln;\nvalue.postln;\n```',
	'wait': '**wait** - Wait seconds in Routine/Task\n\n```supercollider\nRoutine({ 1.wait; "done".postln }).play;\n```',
	'yield': '**yield** - Yield value from Routine\n\n```supercollider\nRoutine({ 1.yield; 2.yield }).nextN(2)  // [1, 2]\n```',
	'value': '**value** - Evaluate function\n\n```supercollider\n{ |x| x * 2 }.value(5)  // 10\n```',
	'dup': '**dup** - Duplicate n times\n\n```supercollider\n5.dup(3)  // [5, 5, 5]\nSinOsc.ar(440).dup  // Stereo\n```',
	'scope': '**scope** - Show oscilloscope\n\n```supercollider\n{ SinOsc.ar(440) }.scope;\n```',
	'plot': '**plot** - Plot signal/array\n\n```supercollider\n{ SinOsc.ar(440) }.plot(0.01);\n[1,2,3,2,1].plot;\n```',
	'asStream': '**asStream** - Convert pattern to stream\n\n```supercollider\nPseq([1,2,3]).asStream.next  // 1\n```',
	'next': '**next** - Get next value from stream\n\n```supercollider\nstream.next\nstream.next(inval)\n```',
	'reset': '**reset** - Reset stream to beginning\n\n```supercollider\nstream.reset;\n```',
	'size': '**size** - Number of elements\n\n```supercollider\n[1,2,3].size  // 3\n```',
	'first': '**first** - First element\n\n```supercollider\n[1,2,3].first  // 1\n```',
	'last': '**last** - Last element\n\n```supercollider\n[1,2,3].last  // 3\n```',
	'sum': '**sum** - Sum of elements\n\n```supercollider\n[1,2,3].sum  // 6\n```',
	'mean': '**mean** - Average of elements\n\n```supercollider\n[1,2,3].mean  // 2.0\n```',
	'sort': '**sort** - Sort elements\n\n```supercollider\n[3,1,2].sort  // [1,2,3]\n```',
	'reverse': '**reverse** - Reverse order\n\n```supercollider\n[1,2,3].reverse  // [3,2,1]\n```',
	'softclip': '**softclip** - Distortion: keeps signal below 1, rounds off above 0.5\n\n```supercollider\nsig.softclip   // soft saturation\n```',
	'distort': '**distort** - Non-linear distortion mapping: x / (1 + abs(x))\n\n```supercollider\nsig.distort\n```',
	'tanh': '**tanh** - Hyperbolic tangent saturation\n\n```supercollider\n(sig * drive).tanh\n```',
	'squared': '**squared** - Square the value (x * x)\n\n```supercollider\n3.squared  // 9\n```',
	'reciprocal': '**reciprocal** - 1 / x\n\n```supercollider\n4.reciprocal  // 0.25\n```',
	'lag': '**lag** - Exponential lag (smoothing)\n\n```supercollider\nsig.lag(lagTime)\n```',
	'range': '**range** - Scale bipolar signal to range\n\n```supercollider\nSinOsc.kr(1).range(200, 800)  // 200-800\n```',
	'exprange': '**exprange** - Scale bipolar signal to exponential range\n\n```supercollider\nSinOsc.kr(1).exprange(200, 800)\n```',
	'unipolar': '**unipolar** - Scale bipolar (-1..1) to unipolar (0..mul)\n\n```supercollider\nSinOsc.kr(1).unipolar  // 0..1\n```',
	'bipolar': '**bipolar** - Scale unipolar (0..1) to bipolar (-mul..mul)\n\n```supercollider\nLFNoise0.kr(1).bipolar  // -1..1\n```',
	'poll': '**poll** - Print signal values to post window\n\n```supercollider\nSinOsc.kr(1).poll(10, "val");\n```',
	'mold': '**mold** - Set number of channels and rate of a NodeProxy\n\n```supercollider\n~proxy.mold(numChannels, rate)\n~proxy.mold(2, \\audio)\n```',
	'isNil': '**isNil** - Test if object is nil\n\n```supercollider\nnil.isNil   // true\n1.isNil     // false\n```',
	'notNil': '**notNil** - Test if object is not nil\n\n```supercollider\n1.notNil  // true\n```',
	'choose': '**choose** - Pick a random element\n\n```supercollider\n[1,2,3].choose  // random\n```',
	'scramble': '**scramble** - Randomize order\n\n```supercollider\n[1,2,3,4].scramble  // e.g. [3,1,4,2]\n```',
	'normalize': '**normalize** - Scale to 0..1 (or min..max)\n\n```supercollider\n[3,1,5].normalize  // [0.5, 0, 1]\n```',
};

// Common SuperCollider classes (audio, patterns, collections, etc.)
const SC_CLASSES = [
	// Oscillators
	'SinOsc', 'Saw', 'Pulse', 'LFSaw', 'LFPulse', 'LFNoise0', 'LFNoise1', 'LFNoise2',
	'Blip', 'Formant', 'Klang', 'VOsc', 'VOsc3', 'FSinOsc', 'PMOsc', 'COsc',
	'Gendy1', 'Gendy2', 'Gendy3',
	// Noise
	'WhiteNoise', 'PinkNoise', 'BrownNoise', 'ClipNoise', 'GrayNoise',
	'Dust', 'Dust2', 'Impulse', 'Crackle', 'Logistic',
	// Triggers
	'Stepper', 'PulseDivider', 'Trig1', 'TDelay', 'TDuty', 'SendTrig', 'Latch', 'Gate',
	'Trig', 'Timer', 'Sweep', 'Phasor', 'Peak', 'RunningMin', 'RunningMax',
	// Filters
	'LPF', 'HPF', 'BPF', 'BRF', 'RLPF', 'RHPF', 'Resonz', 'Ringz', 'Formlet',
	'Median', 'MoogFF', 'DFM1', 'FOS', 'SOS', 'TwoPole', 'TwoZero',
	'OnePole', 'OneZero', 'Integrator', 'LeakDC',
	// Reverb & Delay
	'FreeVerb', 'GVerb', 'AllpassN', 'AllpassL', 'AllpassC',
	'CombN', 'CombL', 'CombC', 'DelayN', 'DelayL', 'DelayC',
	'PitchShift', 'Pitch', 'FreqShift',
	// FFT
	'PV_MagAbove', 'PV_MagBelow', 'PV_MagClip', 'PV_MagSmooth', 'PV_MagMul', 'PV_MagDiv',
	'PV_PhaseShift90', 'PV_PhaseShift270', 'PV_BinShift', 'PV_BinScramble', 'PV_BrickWall',
	'PV_MagSquared', 'PV_MagNoise', 'PV_RandComb', 'PV_RectComb', 'PV_RectComb2',
	'PV_CopyPhase', 'PV_Max', 'PV_Min', 'PV_Add', 'PV_Mul', 'PV_Div', 'FFT', 'IFFT',
	// Panning
	'Pan2', 'Balance2', 'LinPan2', 'Splay', 'Pan4', 'PanAz', 'Rotate2', 'XFade2',
	// Envelopes
	'EnvGen', 'Env', 'Line', 'XLine', 'Linen', 'VarLag',
	// Buffers
	'PlayBuf', 'RecordBuf', 'BufRd', 'BufWr', 'Buffer',
	'BufDelayN', 'BufDelayL', 'BufDelayC', 'BufCombN', 'BufCombL', 'BufCombC',
	'BufAllpassN', 'BufAllpassL', 'BufAllpassC',
	'GrainBuf', 'GrainIn', 'Warp1', 'VOSIM', 'Shaper',
	'Convolution', 'Convolution2', 'Convolution3', 'PartConv',
	// I/O
	'Out', 'In', 'LocalIn', 'LocalOut', 'ReplaceOut', 'XOut', 'OffsetOut',
	'CheckBadValues', 'Poll', 'ScopeOut', 'ScopeOut2',
	// Control
	'Mix', 'Limiter', 'Compander', 'Normalizer', 'CompanderD',
	'AmpComp', 'AmpCompA',
	'MouseX', 'MouseY', 'MouseButton', 'KeyState',
	'Lag', 'Lag2', 'Lag3', 'Ramp', 'VarLag', 'Decay', 'Decay2',
	// Math operations
	'Hertz', 'Midicps', 'Cpsmidi', 'Octcps', 'Cpsoct', 'Ratio', 'Dbamp', 'Ampdb',
	'Squared', 'Cubed', 'Sqrt', 'Exp', 'Log', 'Log2', 'Log10',
	'Sin', 'Cos', 'Tan', 'Asin', 'Acos', 'Atan', 'Sinh', 'Cosh', 'Tanh',
	'Distort', 'SoftClip', 'Clip', 'Fold', 'Wrap',
	'UnaryOpUGen', 'BinaryOpUGen', 'MulAdd', 'Sum3', 'Sum4',
	'DifSqr', 'SumSqr', 'SqrSum', 'SqrDif', 'AbsDif', 'Thresh', 'SCurve',
	// Rate conversion
	'A2K', 'K2A', 'T2A', 'T2K', 'DC', 'Silent', 'Clear',
	// Synth control
	'Free', 'FreeSelf', 'PauseSelf', 'Done', 'FreeSelfWhenDone', 'PauseSelfWhenDone',
	'Pause', 'SetResetFF', 'Schmidt',
	'Server', 'ServerOptions', 'SynthDef', 'Synth', 'Group', 'Bus',
	'Pbind', 'Pseq', 'Prand', 'Pxrand', 'Pwrand', 'Pshuf',
	'Pwhite', 'Pexprand', 'Pgauss', 'Plprand', 'Phprand', 'Pmeanrand',
	'Pn', 'Pdef', 'Ppar', 'Ptpar', 'Pgpar', 'Pchain', 'Pkey',
	'Pfunc', 'Prout', 'Plazy', 'Pcollect', 'Pselect', 'Preject',
	'Pstutter', 'Pdup', 'Place', 'Ppatlace', 'Pswitch', 'Pswitch1',
	'EventStreamPlayer', 'Routine', 'Task',
	'Array', 'List', 'LinkedList', 'Set', 'IdentitySet', 'Dictionary', 'IdentityDictionary',
	'Event', 'Environment', 'TempoClock', 'SystemClock', 'AppClock',
	'Window', 'View', 'Slider', 'Knob', 'Button', 'TextField', 'StaticText', 'NumberBox',
	'FreqScope', 'Stethoscope', 'ServerMeter',
	'MIDIClient', 'MIDIIn', 'MIDIOut', 'MIDIFunc', 'MIDIdef',
	'NetAddr', 'OSCFunc', 'OSCdef',
	'String', 'Symbol', 'Float', 'Integer', 'Boolean', 'Nil', 'Object', 'Function', 'Class',
	'Signal', 'Wavetable', 'FloatArray', 'Int8Array', 'Int16Array', 'Int32Array',
	'File', 'PathName', 'Platform', 'Archive', 'Score',
	'Point', 'Rect', 'Color', 'Pen',
	'Condition', 'Semaphore', 'FlowLayout', 'VLayout', 'HLayout',
	// sc3-plugins
	'JPverb', 'Greyhole', 'NHHall',
	'CrossoverDistortion', 'Decimator', 'SmoothDecimator', 'SineShaper', 'Disintegrator',
	'Crest', 'WaveLoss', 'Squiz', 'InsideOut', 'Friction', 'Perlin3', 'RosslerL',
	'LPF18', 'PeakEQ4', 'PeakEQ2', 'BMoog',
	'MdaPiano', 'OteyPiano',
	'DWGPlucked', 'DWGBowed', 'DWGBowedSimple', 'DWGBowedTor', 'DWGSoundBoard',
	'MembraneCircle', 'MembraneHexagon',
	'StkPluck', 'StkFlute', 'StkBowed', 'StkMandolin', 'StkSaxofony', 'StkClarinet',
	'StkBlowHole', 'StkModalBar', 'StkShakers', 'StkBandedWG', 'StkVoicForm',
	'AY', 'LoopBuf', 'VBAP', 'Coyote', 'WAmp',
	'Henon2DN', 'Henon2DL', 'Henon2DC', 'Gbman2DN', 'Gbman2DL', 'Gbman2DC',
	'Standard2DN', 'Latoocarfian2DN', 'Latoocarfian2DC',
	'Lorenz2DN', 'Lorenz2DC', 'Fhn2DN', 'Fhn2DC',
	'GaussTrig', 'LFBrownNoise0', 'LFBrownNoise1', 'LFBrownNoise2',
	'Gendy4', 'Gendy5',
	'DoubleWell', 'DoubleWell3', 'Brusselator', 'FitzHughNagumo',
	'MoogLadder', 'NestedAllpassN', 'DoubleNestedAllpassN', 'SVF',
	'ComplexRes', 'RMS', 'SawDPW', 'PulseDPW',
	'GravityGrid', 'TermanWang', 'WeaklyNonlinear',
	'DWGPluckedStiff', 'DWGPlucked2',
	'MoogVCF', 'CombLP', 'TGrains2', 'TGrains3',
	'Qitch', 'LPCAnalyzer', 'MovingAverage',
];

// Common methods
const SC_METHODS = [
	'play', 'stop', 'free', 'release', 'set', 'get',
	'ar', 'kr', 'ir', 'tr',
	'new', 'newClear', 'newFrom', 'copy', 'deepCopy',
	'add', 'addAll', 'remove', 'removeAt', 'pop', 'push',
	'at', 'put', 'atFail', 'first', 'last', 'size', 'isEmpty',
	'do', 'collect', 'select', 'reject', 'detect', 'any', 'every',
	'sum', 'mean', 'maxItem', 'minItem', 'sort', 'reverse',
	'midicps', 'cpsmidi', 'midiratio', 'ratiomidi', 'ampdb', 'dbamp',
	'linlin', 'linexp', 'explin', 'expexp', 'lincurve', 'curvelin',
	'clip', 'wrap', 'fold', 'round', 'trunc', 'ceil', 'floor', 'abs', 'neg',
	'rand', 'rand2', 'rrand', 'exprand', 'bilinrand', 'linrand',
	'wait', 'yield', 'value', 'valueEnvir', 'valueArray',
	'postln', 'post', 'postf', 'debug', 'trace',
	'asString', 'asSymbol', 'asInteger', 'asFloat', 'asArray',
	'dup', 'blend', 'series', 'geom',
	'scope', 'plot', 'gui',
	'asStream', 'embedInStream', 'reset', 'next', 'nextN', 'all',
	// unary math / signal ops
	'softclip', 'distort', 'tanh', 'reciprocal', 'squared', 'cubed', 'sqrt',
	'sign', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
	'sinh', 'cosh', 'isPositive', 'isNegative', 'isStrictlyPositive',
	'coin', 'degrad', 'raddeg', 'frac',
	// binary math / signal ops
	'pow', 'min', 'max', 'mod', 'div', 'lcm', 'gcd', 'thresh',
	'atan2', 'hypot', 'ring1', 'ring2', 'ring3', 'ring4',
	'sumsqr', 'difsqr', 'sqrsum', 'sqrdif', 'absdif',
	'amclip', 'scaleneg', 'clip2', 'wrap2', 'fold2', 'excess',
	// range / mapping
	'range', 'exprange', 'unipolar', 'bipolar', 'lag', 'lag2', 'lag3',
	'lagud', 'lag2ud', 'lag3ud', 'varlag',
	// multichannel
	'flop', 'flat', 'clump', 'reshape', 'stutter',
	// buffer / bus
	'numFrames', 'numChannels', 'duration', 'sampleRate', 'bufnum',
	'read', 'write', 'loadToFloatArray', 'getToFloatArray',
	// patterns
	'asPattern', 'embedInStream', 'stutter', 'finDur', 'fin',
	// node
	'run', 'map', 'unmap', 'setn', 'getn', 'fill', 'moveBefore', 'moveAfter',
	'moveToHead', 'moveToTail', 'isPlaying', 'isRunning',
	// env / spec
	'asSpec', 'asEnv', 'normalize', 'asSignal',
	// general
	'printOn', 'storeOn', 'cs', 'class', 'dump', 'inspect',
	'respondsTo', 'isKindOf', 'isNil', 'notNil',
	'if', 'while', 'switch', 'case', 'for', 'forBy',
	'reverseDo', 'pairsDo', 'keysValuesDo',
	'includes', 'indexOf', 'indexOfEqual',
	'keep', 'drop', 'copyRange', 'copyToEnd', 'copyFromStart',
	'wrapAt', 'clipAt', 'foldAt', 'wrapPut', 'clipPut',
	'normalize', 'normalizeSum', 'integrate', 'differentiate',
	'scramble', 'choose', 'wchoose', 'rotate', 'mirror', 'mirror1',
	'pyramid', 'slide', 'lace', 'permute', 'powerset',
	'bubble', 'unbubble', 'curdle', 'flop',
	'poll', 'dpoll', 'checkBadValues',
	'mold', 'source', 'clear', 'bus', 'index',
	'fadeTime', 'quant', 'reshape',
	'numOutputs', 'numInputs', 'rate'
];

// ── Signature Help Data ──────────────────────────────────────────────────────
interface ParamInfo { label: string; name: string }
interface MethodSig { label: string; params: ParamInfo[] }
type ClassSigs = { [method: string]: MethodSig };
const SIGNATURE_DATA: { [className: string]: ClassSigs } = {};

function parseParamNames(paramsStr: string): ParamInfo[] {
	if (!paramsStr.trim()) return [];
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of paramsStr) {
		if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; }
		else if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; }
		else if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
		else { current += ch; }
	}
	if (current.trim()) parts.push(current.trim());
	// label = full param text ("freq: 440") → bolded in tooltip
	// name  = just the identifier ("freq") → used for arg completions & named-arg matching
	return parts.map(p => ({ label: p.trim(), name: p.split(/[:\s=]/)[0].trim() }));
}

(function buildSignatureData() {
	for (const [className, doc] of Object.entries(CLASS_DOCS)) {
		const sigs: ClassSigs = {};
		for (const line of doc.split('\n')) {
			const t = line.trim();
			// ClassName.method(params)
			const dm = t.match(/^(\w+)\.(\w+)\(([^)]*)\)\s*;?\s*$/);
			if (dm && dm[1] === className) {
				const params = parseParamNames(dm[3]);
				sigs[dm[2]] = { label: `${className}.${dm[2]}(${dm[3]})`, params };
				// Mirror across rate methods so .ar/.kr/.ir all provide signature help
				if (dm[2] === 'ar' || dm[2] === 'kr' || dm[2] === 'ir') {
					for (const rate of ['ar', 'kr', 'ir']) {
						if (!sigs[rate]) {
							sigs[rate] = { label: `${className}.${rate}(${dm[3]})`, params };
						}
					}
				}
				continue;
			}
			// ClassName(params) — stored as 'new'
			const nm = t.match(/^(\w+)\(([^)]*)\)\s*;?\s*$/);
			if (nm && nm[1] === className && !sigs['new']) {
				sigs['new'] = { label: `${className}(${nm[2]})`, params: parseParamNames(nm[2]) };
			}
		}
		if (Object.keys(sigs).length) SIGNATURE_DATA[className] = sigs;
	}
})();

function getWordAtPosition(document: TextDocument, position: Position): { word: string; start: number; end: number } {
	const text = document.getText();
	const offset = document.offsetAt(position);

	let start = offset;
	while (start > 0 && /[a-zA-Z0-9_~]/.test(text.charAt(start - 1))) {
		start--;
	}

	let end = offset;
	while (end < text.length && /[a-zA-Z0-9_]/.test(text.charAt(end))) {
		end++;
	}

	const word = text.substring(start, end);
	return { word, start, end };
}

export function getSuperColliderMode(): LanguageMode {
	return {
		getId() {
			return 'supercollider';
		},
		doComplete(document: TextDocument, position: Position): CompletionList {
			const text = document.getText();
			const { word, start } = getWordAtPosition(document, position);
			const items: CompletionItem[] = [];
			const wordLower = word.toLowerCase();

			// After a "." → classes/methods are handled by the client-side
			// sc-completions.js provider (dynamic sclang queries).
			// The LSP only provides keywords (never valid after a dot).
			const charBefore = start > 0 ? text.charAt(start - 1) : '';
			if (charBefore === '.') {
				return CompletionList.create([], false);
			}

			// ── Arg-name completions inside function calls ─────────────────
			// When typing a lowercase word after ( or , inside a known call,
			// offer matching parameter names with ':' suffix.
			// e.g. Pitch.kr(in, m → minFreq:, maxFreq:, median:, ...
			if (word && /^[a-z]/.test(word)) {
				const offset = document.offsetAt(position);
				let depth = 0;
				let callStart = -1;
				let paramIdx = 0;
				for (let i = start - 1; i >= 0; i--) {
					const ch = text[i];
					if (ch === ')' || ch === ']' || ch === '}') depth++;
					else if (ch === '[' || ch === '{') { if (depth === 0) break; depth--; }
					else if (ch === '(') {
						if (depth === 0) { callStart = i; break; }
						depth--;
					} else if (ch === ',' && depth === 0) {
						paramIdx++;
					}
				}
				if (callStart >= 0) {
					const beforeParen = text.substring(0, callStart);
					let sig: MethodSig | undefined;
					const dotM = beforeParen.match(/(\w+)\.(\w+)\s*$/);
					if (dotM) {
						sig = SIGNATURE_DATA[dotM[1]]?.[dotM[2]];
					} else {
						const bareM = beforeParen.match(/(\w+)\s*$/);
						if (bareM) {
							const classSigs = SIGNATURE_DATA[bareM[1]];
							if (classSigs) sig = classSigs['new'] ?? Object.values(classSigs)[0];
						}
					}
					if (sig) {
						for (let i = 0; i < sig.params.length; i++) {
							const p = sig.params[i];
							if (p.name.toLowerCase().startsWith(wordLower)) {
								items.push({
									label: p.name + ':',
									kind: CompletionItemKind.Field,
									detail: '⬡  arg ' + p.label,
									sortText: '000_' + p.name,
									insertText: p.name + ': ',
									filterText: p.name
								});
							}
						}
					}
				}
			}

			// Add matching keywords
			for (const kw of SC_KEYWORDS) {
				if (kw.toLowerCase().startsWith(wordLower)) {
					items.push({
						label: kw,
						kind: CompletionItemKind.Keyword,
						detail: 'SuperCollider keyword',
						documentation: KEYWORD_DOCS[kw]
					});
				}
			}

			return CompletionList.create(items, false);
		},
		doHover(document: TextDocument, position: Position): Hover | null {
			const { word, start, end } = getWordAtPosition(document, position);

			if (!word) {
				return null;
			}

			// Check keywords
			if (KEYWORD_DOCS[word]) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: KEYWORD_DOCS[word]
					},
					range: {
						start: document.positionAt(start),
						end: document.positionAt(end)
					}
				};
			}

			// Check classes
			if (CLASS_DOCS[word]) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: CLASS_DOCS[word]
					},
					range: {
						start: document.positionAt(start),
						end: document.positionAt(end)
					}
				};
			}

			// Check methods
			if (METHOD_DOCS[word]) {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: METHOD_DOCS[word]
					},
					range: {
						start: document.positionAt(start),
						end: document.positionAt(end)
					}
				};
			}

			return null;
		},
		doSignatureHelp(document: TextDocument, position: Position): SignatureHelp | null {
			const text = document.getText();
			const offset = document.offsetAt(position);

			// Walk backwards from cursor to find the unmatched '(' of the current call
			let depth = 0;
			let callStart = -1;
			let activeParam = 0;

			for (let i = offset - 1; i >= 0; i--) {
				const ch = text[i];
				if (ch === ')' || ch === ']' || ch === '}') {
					depth++;
				} else if (ch === '(' || ch === '[' || ch === '{') {
					if (depth === 0) {
						if (ch === '(') callStart = i;
						break;
					}
					depth--;
				} else if (ch === ',' && depth === 0) {
					activeParam++;
				}
			}

			if (callStart < 0) return null;

			const before = text.substring(0, callStart);

			// Try ClassName.method( pattern first
			const dotMatch = before.match(/(\w+)\.(\w+)\s*$/);
			if (dotMatch) {
				const sig = SIGNATURE_DATA[dotMatch[1]]?.[dotMatch[2]];
				if (sig) {
					// Check for SC named argument (keyword: value) near cursor
					const insideCall = text.substring(callStart + 1, offset);
					const namedMatch = insideCall.match(/\b(\w+)\s*:\s*[^,:)]*$/);
					if (namedMatch) {
						const idx = sig.params.findIndex((p: ParamInfo) => p.name === namedMatch[1]);
						if (idx >= 0) activeParam = idx;
					}
					return {
						signatures: [{ label: sig.label, parameters: sig.params }],
						activeSignature: 0,
						activeParameter: Math.min(activeParam, Math.max(0, sig.params.length - 1))
					};
				}
			}

			// Try ClassName( pattern (constructor style, e.g. FFT, Synth, Pbind)
			const bareMatch = before.match(/(\w+)\s*$/);
			if (bareMatch) {
				const classSigs = SIGNATURE_DATA[bareMatch[1]];
				if (classSigs) {
					const sig = classSigs['new'] ?? Object.values(classSigs)[0];
					if (sig) {
						const insideCall = text.substring(callStart + 1, offset);
						const namedMatch = insideCall.match(/\b(\w+)\s*:\s*[^,:)]*$/);
						if (namedMatch) {
							const idx = sig.params.findIndex((p: ParamInfo) => p.name === namedMatch[1]);
							if (idx >= 0) activeParam = idx;
						}
						return {
							signatures: [{ label: sig.label, parameters: sig.params }],
							activeSignature: 0,
							activeParameter: Math.min(activeParam, Math.max(0, sig.params.length - 1))
						};
					}
				}
			}

			return null;
		},
		onDocumentRemoved(_document: TextDocument) { /* nothing to do */ },
		dispose() { /* nothing to do */ }
	};
}
