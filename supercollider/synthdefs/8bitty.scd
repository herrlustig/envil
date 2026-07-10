// envil default SynthDefs — 8bitty family
// (ported from 00_jams/20260708_8bitty_pbinds.sc, 20260410_solo_ex.sc,
//  20260417_band_1.sc)
// Loaded automatically on every server boot. Edit + run
// "Envil: Reload Default SynthDefs" to apply live.

SynthDef(\bitlead, { |out=0, freq=440, amp=0.3, dur=0.2, bits=4, srate=8000|
	var env = EnvGen.kr(Env.perc(0.001, dur, curve: -8), doneAction: 2);
	var sig = Pulse.ar(freq, width: 0.5) + Pulse.ar(freq*1.005, width: 0.25, mul: 0.5);
	sig = Latch.ar(sig, Impulse.ar(srate));                  // srate crush
	sig = (sig * (2**bits)).round / (2**bits);               // bit crush
	Out.ar(out, (sig * env * amp).dup);
}).add;

SynthDef(\bitbass, { |out=0, freq=55, amp=0.5, dur=0.4|
	var env = EnvGen.kr(Env.perc(0.001, dur, curve: -4), doneAction: 2);
	var sig = LFTri.ar(freq) + Pulse.ar(freq/2, 0.5, 0.4);
	sig = Latch.ar(sig, Impulse.ar(3000));
	sig = sig.fold2(0.7).tanh;
	Out.ar(out, (sig * env * amp).dup);
}).add;

SynthDef(\bitnoise, { |out=0, amp=0.4, dur=0.08, srate=4000|
	var env = EnvGen.kr(Env.perc(0.001, dur, curve: -12), doneAction: 2);
	var sig = Latch.ar(WhiteNoise.ar, Impulse.ar(srate));    // NES hihat/snare
	Out.ar(out, (sig * env * amp).dup);
}).add;

SynthDef(\bitarp, { |out=0, freq=440, amp=0.25, dur=0.1|
	var env = EnvGen.kr(Env.perc(0.001, dur), doneAction: 2);
	var sig = Pulse.ar(freq * [1, 2, 1.5].wchoose([0.6, 0.3, 0.1]), width: 0.125);
	sig = Latch.ar(sig, Impulse.ar(6000));
	Out.ar(out, (sig * env * amp).dup);
}).add;

SynthDef(\kick8bit, { |out=0, freq=60, sustain=0.2, amp=0.8|
	var crush = 2;
	var sig = LFSaw.ar(freq, mul: amp);
	sig = (sig * crush).round / crush;                       // 8 bitty bitcrush
	sig = Latch.ar(sig, Impulse.ar(2000));                   // latch trick
	sig = RLPF.ar(sig, 5000);
	sig = sig * EnvGen.kr(Env.perc(0.01, sustain), doneAction: 2);
	Out.ar(out, sig.dup);
}).add;

SynthDef(\bitty, { |out=0, freq=440, sustain=0.5, amp=0.5, otherArg=0, pseudoBase=0|
	var sig = Blip.ar(freq, mul: amp, numharm: \numharm.kr(5));
	sig = sig + PinkNoise.ar(otherArg * amp).tanh;
	sig = sig * EnvGen.kr(Env.perc(0.01, sustain), doneAction: 2);
	// pseudo bass with its own env
	sig = sig + (SinOsc.ar(freq * [0.5, 0.25] * [1, 1.05], mul: amp * 0.5 * pseudoBase)
		* EnvGen.kr(Env.perc(0.01, sustain*2), doneAction: 2)).tanh;
	Out.ar(out, sig.dup);
}).add;
