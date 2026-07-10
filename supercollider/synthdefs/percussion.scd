// envil default SynthDefs — percussion
// (ported from my_footcontroller.sc / std jams)
// Loaded automatically on every server boot. Edit + run
// "Envil: Reload Default SynthDefs" to apply live.

SynthDef(\click, { |freq=200, dur=1, amp=1, out=0|
	var in = Pulse.ar(freq*100);
	var env = EnvGen.ar(Env.perc(releaseTime: dur), doneAction: 2);
	Out.ar(out, (in * env * amp)!2);
}).add;

SynthDef(\click2, { |freq=200, dur=1, amp=1, out=0|
	var in = Blip.ar(freq*100);
	var env = EnvGen.ar(Env.perc(releaseTime: dur), doneAction: 2);
	Out.ar(out, (in * env * amp)!2);
}).add;

SynthDef(\noiseBeat, { |freq=200, dur=1, amp=1, out=0|
	var in = WhiteNoise.ar(1);
	var env = EnvGen.ar(Env.perc(releaseTime: dur), doneAction: 2);
	Out.ar(out, (in * env * amp)!2);
}).add;

SynthDef(\noiseBass, { |freq=200, dur=1, amp=1, out=0, pitchRatio=1|
	var in = Blip.ar(10*(pitchRatio*200), numharm: 1);
	var env = EnvGen.ar(Env.perc(releaseTime: dur), doneAction: 2);
	Out.ar(out, (in * env * amp)!2);
}).add;
