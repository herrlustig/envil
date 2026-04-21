# ignore this, just prompts, ideas etc






# 21.4.2026 suggestion system , IN PROGRESS 

local better suggestions, vscode plugin suggestion:
if offline (no internet), the code suggestions , that are really worthwhile especially during livecoding to get some ideas, less typing etc, do not work logically.

could you give me some options how to build such a system.
sources to for code examples to base the suggestions from could be:
- code examples of the supercollider help files
- local repo directories like jams dir etc that represent past sessions, tricks and setups from there etc
- could include other directories (maybe could be added on purpose to be parsed for the suggestor during boot up (if it does not take to much time .. , or rebuild with a plugin command or so ))

techniques for the suggestions I see:
- like a local 'templates'/suggestion lookup base 
- a local AI model that is aware of the resources


interaction with it, possibilities:
- inline suggestion like now when online 
- inline suggestions, but with options for different possibilities
- (explicit) template invokation with some special typing (e.g. _TPL_, _TEMPLATE_, _SUGGEST_) or hotkey

what you should do:
- analys the use case
- look at the existing resource
- look at what current online suggestions do
- look at feasiable techniques fitting the use case
    - how do other people/projects do that (in vscode specifically )?
- create a phase plan of how to setup such a system
- bonus: suggest own ideas to cover the main goal of this (live coding, ideas and less typing)
(- dont do anything for now, just analyse and suggest.. (maybe if necessary test a technique to evaluate it better if needed ))