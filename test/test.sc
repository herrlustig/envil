s.reboot;

p = ProxySpace().push;

p.fadeTime = 4;
~out.ar(2); ~out.play;

(
    ~freq = {MouseX.kr(20, 200, 1).lag(0.1).poll(0.1)};
)
( ~out = {
    var sig = Blip.ar(freq: [20,50,60,~freq]+[0,1,5]+LFNoise0.ar(0.2,mul:10).lag(3), 
    numharm: 3, phase: 0, mul: 1).mean;

    sig = sig.clip2(0.5);
    sig.dup;
})


LFTri

