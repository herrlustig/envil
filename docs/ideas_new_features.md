
# topic: interactive, innovative livecoding IDE

## reevaluate code blocks by click/touch
for supercollider it would be super useful to add a little button at the start and end of most outer enclosing brackets of executable code blocks. this would allow to reeavaluate with mouseclick or touchscreen as an alternative to key-shortcuts


## IDE as instrument
the knob panel should be auto initialized on startup
and be in the middle, inbetween sc file to the left, and hydra file to the right



(advanced: or maybe better. it should be remembered between sessions. (bonus: several ones possible ? big refactor needed for that ?)
)

knobs also should be buttons. when touched/clicked instead of moving the should send a signal to SC (and later on to hydra)

bonus: could midi events (or OSC events) be sent by the knob panel to supercollider ? if yes, how complicated would it be ? big refactor needed ? 
One advantage would be, to use a standard that potentially also be useful to interact with other software or even hardware hmm...
Tell me about it. summarize possible approaches.

## SC: improve autocompletion for proxyspace
in SC livecoding, the proxyspace variables are the backbone of connecting different control and audio signals etc.
It would be super need if when typing '~' the IDE would look into the current proxyspace and suggest by dropdown possible existing variables on the fly. is that doable with the vscode plugin. I think the plugin would need to communicate with sclang to get the current proxyspace variables/NodeProxies

improve the SC proxyspace autocompletition: similar then hydras autocompletition dropdown list, it should still be possible to use AI code suggestions. please make the behaviour the same from a user action flow perspective as the solution used in hydra. maybe it already works like it ? check it, if not improve it

## startup default proxy anyways

startup sc should , after reboot initialize a proxyspace and add a ~out.ar(2); ~out.play;


## more startup defaults


# HUGE FEATURE: refactor my_footpedal to make it autostartable .. waybe wrap the setup code in own function that can be triggered or so ..

...


# mouse gestures for code execution

in supercollider, the mouse/mousepad inputs could be piggy backed for some interesting and efficient interaction schemes.
e.g. the pinch gesture could be used to evaluate the block the mouse is currently on..
do you maybe have some ideas 1. what could be piggy backed without making it tedious 2. FOR what it could be used to increase ease and speed while livecoding

# misc

## IDE code styling etc

- the line numbers are much to broad, not needed, talks room for livecoding stuff

- the matching brackets are highlighted, but it's nearly invisible. make it more prominent by adding some background color while keeping the text (bracket) readable.

- suggestions by AI (or autocompletion) should also have a text background color as the rest of the code, a bit different one.. b/c the IDE has a transparent background it is a necessecity to have this for readability

- the knobs font color is still not ideal. maybe use a dark font color instead for the font inside the knob