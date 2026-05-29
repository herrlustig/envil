<div align="center">

# ENVIL 💀

</div>

![ENVIL](resources/envil.png)

ENVIL is a [Visual Studio Code](https://code.visualstudio.com/) extension which provides a A/V live-coding environment using [SuperCollider](https://supercollider.github.io/) and [Hydra](https://hydra.ojack.xyz/).

This setup provides every convenient feature of vscode, overlaying it on top of your favorite browser.

## Requirements

- [SuperCollider](https://supercollider.github.io/downloads)
- Any [Chromium based](https://en.wikipedia.org/wiki/Chromium_(web_browser)#Browsers_based_on_Chromium) Web Browser

## Getting started

### ENVIL setup

1. Install this vscode extension
   - You may be prompted to install the HyperScope and Custom UI Style vscode extensions, allow it.
2. Open the Command Palette (Mac: <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>, Windows: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>)
3. Type `Envil: Open environment` to enable ENVIL commands (vscode restart required)
4. Setup the environment:
   - Now full-screen mode cannot be used into vscode due to some tweaks in the electron configuration
   - Overlap the transparent vscode window on the browser, leaving it slightly visible resizing vscode
   - Set the browser to full-screen mode and switch back to the vscode window
5. You can close the ENVIL environment using the `Envil: Close environment` command (vscode restart required)

### HYDRA
1. Create a JavaScript file inserting a hydra script and evaluate it using the `Envil: Evaluate - Hydra` command

### SUPERCOLLIDER

1. Start sclang interpreter using the `Envil: Start/Stop SCLang - Supercollider` command or the `sclang ⭕` toggle in the status bar
   - This command will automatically boot the scsynth server
   - In the Output panel you can select the channel ***ENVIL - SC PostWindow*** to check the supercollider PostWindow logs
   - <ins>WARNING</ins>: the sclang and scsynth startup may be delayed or fail due to SW like Windows Defender. In this case try to restart sclang or check SC PostWindow logs for more informations
2. Create a SCD file inserting a supercollider script and evaluate it using the `Envil: Evaluate - Supercollider` command
3. To Hush the supercollider server use the `Envil: Hush - Supercollider` command
4. (*optional*) Configure the location of your sclang instance in your vscode *'settings.json'*:
   - example: `"envil.supercollider.sclang.cmd": "/Applications/SuperCollider.app/Contents/MacOS/sclang"`

## Features

### ENVIL

- Open the environment (vscode restart required)
  - Configures vscode to make it transparent
  - Opens your default browser to the local hydra server
  - Enables the use of the following Hydra/Supercollider features
- Close the environment (vscode restart required)
  - Removes ENVIL vscode configuration
- Update the WORKSPACE *'settings.json'* to fine-tune your vscode UI adding/updating/removing your desired property
- Use vscode Snippets
  - Create a '*snippets.code-snippets*' file inside the '.vscode' WORKSPACE folder
  - Add any snippet you want to use in your live-coding setup
  - Type the snipper prefix and hit TAB in order to insert the snippet code

### HYDRA

- Evaluate `hydra` code in a JS file
  - Use `;` to delimit every hydra command you want to sequentially evaluate
  - Use `local/files` as base path to serve any local file from a folder named **public** inside your *vscode workspace folder*
  - Use `//` to add comments in your code
  ```javascript
  // 1. variable evaluation
  feedbackIntensity = .7;

  // 2. source initialization
  s1.initImage('local/files/my_image.png');

  // 3. script evaluation
  src(o0)
    .colorama(feedbackIntensity/10)
    // .modulatePixelate(osc())
    .scale(.96)
    .layer(noise().luma(.1))
    .out();
  ```

### SUPERCOLLIDER

- Handle `sclang` and `scsynth` startup/shutdown using
  - Dedicated commands
  - Dedicated status bar toggles
- Evaluate `supercollider` code in a SC/SCD file
  1. Selected text
  2. Regions between parentheses `( )`
  3. Current line where the cursor is placed
- Hush the server
- The interpreter evaluated lines are highlighted
- Sync hydra from supercollider code sending OSC messages
```javascript
// Define an OSC sender
~oscSend = NetAddr.new("localhost", 3002);
// Define a function to send OSC messages
~sendToHydra = { |command|
    ~oscSend.sendMsg("/hydra", command);
};
// Example: send a command to Hydra
~sendToHydra.value("osc(10, 0.1, 1).out()");
```
- See the Supercollider documentation inside vs code using the `Envil: Search - Supercollider` command

## Experimental features

These features are shipped behind feature flags and are **off by default**. They may change or break without notice. See the *Roadmap / TODO* section below for what's planned.

### Offline suggestions — corpus-driven completions for SuperCollider *(WIP)*

A local index of all `.sc` / `.scd` blocks found in your workspace folders + everything listed in `envil.corpusSuggestor.sources` (plus, optionally, your installed SuperCollider HelpSource). Suggestions are retrieved with **BM25** — no network, no telemetry, no LLM unless you explicitly enable it.

> **One master switch**: `envil.corpusSuggestor.enabled`. Set to `true` to turn on the *entire* feature (indexing + dropdown + status bar + commands). Set to `false` (the current default) to disable everything in one go. Sub-features (`inline.enabled`, `llm.enabled`) only have effect when the master switch is on.

**What works today** (assuming `envil.corpusSuggestor.enabled = true`)

| Surface | Trigger | State |
|---|---|---|
| IntelliSense dropdown | type `//?`, `//??` or `_TPL_` on a line in a `.sc`/`.scd` file | works — enabled when the master switch is on |
| Status-bar `💡 envil-corpus N` | always visible while feature is on; click to rebuild the index | works |
| Workspace re-index on folder / settings change | automatic | works |
| Inline ghost-text (Copilot-style) | `//?` lines, or `Alt+/` to force-invoke | works — **off by default** (`envil.corpusSuggestor.inline.enabled`) |
| Compose at cursor with local LLM (Ollama, fill-in-the-middle) | `Ctrl+Alt+Space` / `⌘+Alt+Space` | works — **off by default** (`envil.corpusSuggestor.llm.enabled`) |

When the LLM call fails (e.g. Ollama not running), the *Compose at cursor* command falls back to pasting the top BM25 hit from your corpus and shows a warning.

**Enable / disable**

Add to your *settings.json* (or use the Settings UI → search "Envil suggest"):

```jsonc
{
    // master switch — turns the WHOLE feature on/off. Default: false.
    "envil.corpusSuggestor.enabled": true,

    // ghost-text inline suggestions (off by default)
    "envil.corpusSuggestor.inline.enabled": false,

    // local LLM compose (off by default — requires Ollama, see below)
    "envil.corpusSuggestor.llm.enabled": false,
    "envil.corpusSuggestor.llm.endpoint": "http://localhost:11434",
    "envil.corpusSuggestor.llm.model":    "qwen2.5-coder:3b-base",

    // extra folders to index (workspace folders are always included)
    "envil.corpusSuggestor.sources": [
        "~/my-other-sc-jams"
    ],

    // index local SuperCollider help / class library
    "envil.corpusSuggestor.includeSCHelp": true
}
```

To turn everything off again, set `envil.corpusSuggestor.enabled` to `false` (or remove the entry — the default is `false`). No reload needed.

**Commands**

- `Envil: Corpus – Rebuild Offline Index` — force a full rescan
- `Envil: Corpus – Show Index Stats` — prints block count by kind
- `Envil: Corpus – Compose at Cursor (LLM)` — needs `llm.enabled = true`
- `Envil: Corpus – Trigger Inline Suggestion`
- `Envil: Corpus – Reveal Cache in File Manager` — opens the cache location

**Interaction with GitHub Copilot**

If Copilot is installed and signed-in, it owns the primary inline ghost-text slot by default. Envil's inline variants are still reachable via `Alt+]` / `Alt+[`. To give Envil priority for SuperCollider files, add to your *settings.json*:

```jsonc
{
    "github.copilot.enable": {
        "*": true,
        "supercollider": false,
        "scd": false
    }
}
```

The IntelliSense dropdown (`//?`, `_TPL_`) is unaffected by Copilot — both providers' items appear side-by-side.

**Optional: local LLM (Ollama)**

The "Compose at cursor" command targets a locally-running [Ollama](https://ollama.com/) server. Setup:

1. Install Ollama and start it (`ollama serve` or the system service).
2. Pull a fill-in-the-middle-capable code model, e.g.
   ```bash
   ollama pull qwen2.5-coder:3b-base
   ```
   Recommended: `qwen2.5-coder:1.5b-base` (≈3 GB RAM/VRAM), `qwen2.5-coder:3b-base` (≈4 GB), `qwen2.5-coder:7b-base` (≈6 GB).
3. Set `envil.corpusSuggestor.llm.enabled` to `true`. Use `Ctrl+Alt+Space` in a `.sc` / `.scd` file. If the cursor is on a `//? what I want` line, the model is asked to replace that line; otherwise it performs a fill-in-the-middle insertion at the cursor.

**Where the corpus cache is stored**

One global cache, shared across every workspace (open a new SC project → still benefit from your accumulated body of code). Never shipped inside the `.vsix`. Use the `Envil: Corpus – Reveal Cache in File Manager` command to open it. Default location:

- **Linux:** `~/.config/Code/User/globalStorage/inspektral.envil/suggestions-index.json`
- **macOS:** `~/Library/Application Support/Code/User/globalStorage/inspektral.envil/suggestions-index.json`
- **Windows:** `%APPDATA%\Code\User\globalStorage\inspektral.envil\suggestions-index.json`

Delete the file to force a rescan on next activation.

## Roadmap / TODO

High-level list of what is *known incomplete* and what is planned. Issues / PRs welcome.

### Offline suggestions (WIP, experimental)

- [ ] **Field testing on real live sessions** — use it on stage / in studio for several weeks before flipping the master switch default to `true`.
- [ ] **Unit tests** for `suggestions/tokenize.js`, `suggestions/bm25.js`, `suggestions/corpus.js`.
- [ ] **Streaming + cancellation** for the Ollama compose call (currently a single blocking request).
- [ ] **Freshness check** on activation: stat each indexed root's mtime, trigger a background reindex if anything changed.
- [ ] **Better ranking signals** — boost recently-edited blocks, decay old ones, weight by `kind` (SynthDef vs Pbind vs NodeProxy) by context.
- [ ] **Inline trigger on blank lines** inside a half-written block (currently inline only fires on `//?` lines or explicit `Alt+/`).
- [ ] **Optional embedding-based retrieval** (replace / augment BM25) once a small local sentence-transformer can be packaged sanely.
- [ ] **`envil.corpusSuggestor.excludeSources`** — per-workspace path globs to hide some folders from the suggestion pool.
- [ ] **LoRA fine-tuning workflow** — document how to dump the corpus to a training set + run a small adapter, so the local LLM picks up the user's dialect (variable names, macro style).
- [ ] **Documentation**: short demo screencast, FAQ, and a privacy/data-storage note in the marketplace listing.

### General

- [ ] Cross-platform CI for the extension (currently tested on Linux + Windows 10 only).
- [ ] Migrate `// @ts-nocheck` modules to proper JSDoc types so `tsc --noEmit` is meaningful.

## Troubleshooting

### vscode doesn't become transparent

1. Use the `Custom UI Style: Reload` command to apply the Custom UI Style configuration, especially useful after a vscode update
2. Check the  properties inside the GLOBAL *'settings.json'* configuration file using the `Open User Settings (JSON)`:
   - if the file has some unsaved changes save them (envil may conflict writing properties with the Custom UI Style extension) and try to close and re-open envil environment
   - if you use vscode profiles make sure that your profile is configured so that it doesn't sync the settings
  ![vscode profile configuration example](resources/profiles-config.png)
   - make sure that the extension properties are present inside the GLOBAL *'settings.json'* file and not inside a specific profile settings configuration file. The typical paths for the GLOBAL configuration file are:
     - WIN: *C:\Users\<Your Username>\AppData\Roaming\Code\User\settings.json*
     - MAC: */Users/\<Your Username>/Library/Application Support/Code/User/settings.json*
     - LINUX: */home/\<Your Username>/.config/Code/User/settings.json*

### errors with envil installation or commands

1. Use envil extension having an opened folder in the vscode workspace
2. Check your GLOBAL *'settings.json'* configuration file using the `Open User Settings (JSON)` (see point 2 in the previous section)
3. There may be some issues related to admin permissions. Check the [APC Customize UI++ extension troubleshooting page](https://github.com/drcika/apc-extension/blob/production/README.md#troubleshooting-extension-issues)


### keyboard shortcuts doesn't work

1. Open the keyboard shortcuts menu using the `Open Keyboard Shortcuts` command
2. find the envil command which doesn't get triggered, right click it and select "Change When Expression"
3. remove `config.envil.environment.active` from it

## Development Guide

1. Clone repository.
2. Run `npm install` in repo root at the command line.
3. Open `extension.js` in vscode and press `F5`. Select the option to run the "Extension Development Host."
4. You may be prompted to install the HyperScope and Custom UI Style vscode extensions, allow it.

This extension has been tested in Windows 10 only.

## Credits

All the starting Supercollider code comes from the [scvsc](https://github.com/alexander-daniel/scvsc).