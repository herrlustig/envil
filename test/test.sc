s.reboot;

p = ProxySpace().push;

p.fadeTime = 0.5;
~out.clear; ~out.ar(2); ~out.play;

(
    var bla=0;
    (       
        ~freq = {MouseX.kr(10, 500.rand, 1).lag(0.1).poll(0.05)+100; };
    );
    ( 
        
        ~out     = {
            var sig = SinOsc.ar(
                freq: [400.rand,~freq]+[0,1,5]+LFNoise0.ar(0.2,mul:10).lag(3), 
                numharm: 3, phase: 0, mul: 1).mean;

        sig = sig.clip2(0.9);
        sig = sig + SinOsc.ar([20,50]+[0,1] + LFNoise1.ar(10, mul: 20), LFNoise1.ar(10), mul: 0.5);

        // sig = sig * Decay2.ar(Impulse.ar(5), 0.05, 0.1);
        sig = RLPF.ar(sig, 300, 0.5);
        // sig = sig + Saw.ar(20);

        sig.dup;
    }
    )

)
2 + 5
LFTri

s.scope
thisProcess.nowExecutingPath
thisProcess.nowExecutingPath = "banana"; 
thisProcess.nowExecutingPath.postln;

a = 3
a.postln;