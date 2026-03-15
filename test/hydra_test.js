// this is hydra audiovisual scripting language test file

// 1. variable evaluation
feedbackIntensity = 0;

// 2. source initialization
s1.initCam(); // init webcam on s0


s1.initImage('local/files/my_image.jpg');


// 3. microphone audio setup
// a.fft[0] = bass, a.fft[1] = low-mid, a.fft[2] = high-mid, a.fft[3] = treble
a.setBins(4);
a.setSmooth(0.8);
a.setCutoff(2);

a.setScale(1);

// 4. script evaluation — scale and colorama react to mic bass (fft[0])
(src(s1)
//src(o0)                            
  //.blend(src(s1)), 1)                          // blend with feedback
  //.colorama(() => feedbackIntensity/10 + a.fft[0] * 0.3)


  //.rotate(() => a.fft[0] * 0.1)
  .scale(() => 0.9 + a.fft[2] * 0.01)
  .rotate(() => a.fft[2] * 0.00 + Math.sin(time)*0.1)
  //.layer(noise().luma(() => 0.1 + a.fft[1] * 0.2))
  .scrollX( 1, () => 0.01 + 0.000001*Math.abs(a.fft[1]))
  
  .scrollY(1, () => 0.00 + 0.000001*Math.abs(a.fft[2]))
  //.asdasd()
  //asdsd
  .color(1, 1, 1).shift(() => a.fft[2] * -0, 0.1, 1, 0, 0)
  //.brightness(() => 0.1 + a.fft[0] * 0.1)
  .pixelate(() => 10 + Math.sin(time)*100%200, () => 2000 + time%100)
  
  )
  


  //.kaleid(3)
  
  .out();

  

