s.reboot;

p = ProxySpace().push;

p.fadeTime = 0.5;
~out.clear; ~out.ar(2); ~out.play;

(
    var bla=0;
    (       
        ~freq = {MouseX.kr(10, 200, 1).lag(0.1); };
    );
    ( 
        
        ~out     = {
        var sig = Saw.ar(freq: [1000.rand,~freq]+[0,1,5]+LFNoise0.ar(0.2,mul:10).lag(3), 
        numharm: 3, phase: 0, mul: 1).mean;

        sig = sig.clip2(0.9);
        sig = RLPF.ar(sig, 600, 0.8);
        sig.dup;
    }
    )

)

LFTri

s.scope
thisProcess.nowExecutingPath
thisProcess.nowExecutingPath = "banana"; 
thisProcess.nowExecutingPath.postln;

a = 3
a.postln;