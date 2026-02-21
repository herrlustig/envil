// this is hydra audiovisual scripting language test file

// 1. variable evaluation
feedbackIntensity = 1;

// 2. source initialization
s1.initImage('local/files/my_image.jpg');

// 3. microphone audio setup
// a.fft[0] = bass, a.fft[1] = low-mid, a.fft[2] = high-mid, a.fft[3] = treble
a.setBins(4);
//a.setSmooth(0.8);
a.setCutoff(2);
a.setScale(8);

// 4. script evaluation — scale and colorama react to mic bass (fft[0])
src(o0)
  .colorama(() => feedbackIntensity/10 + a.fft[0] * 0.3)
  //.modulatePixelate(osc())
  .scale(() => 0.96 + a.fft[0] * 0.08)
  .layer(noise().luma(() => 0.1 + a.fft[1] * 0.2))
  .out();
