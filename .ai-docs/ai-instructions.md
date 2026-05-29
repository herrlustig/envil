# AI assistant instructions (envil)

These instructions apply to any AI coding assistant working in this
repository. Load this file in your VS Code workspace via
`.vscode/settings.json` (see `github.copilot.chat.codeGeneration.instructions`).

## Scratch / temporary files

- **Always use the repo-local `tmp/` folder** for any temporary files you
  create while debugging (generated SC code dumps, sandbox JS, parser
  output, throwaway scripts, etc.).
- **Do NOT use `/tmp`** on the host system — it's hard for the user to find
  and clutters the OS.
- `tmp/` is git-ignored. Create it if it doesn't exist (`mkdir -p tmp`).
- Example: write generated SC for inspection to `tmp/snap.sc`, sandbox
  drivers to `tmp/dbg.js`, etc.

## Debugging the VS Code extension

- The webview console output is mirrored to `<workspace>/.envil/webview.log`
  (configured in `touch-knobs.js`). Read this file directly instead of
  asking the user to copy-paste from devtools.
- The previous session is preserved as `webview.log.1`.
- SuperCollider post-window output lives in a VS Code OutputChannel the AI
  cannot read directly — ask the user to paste SC errors when needed.

## SuperCollider code emission rules

When generating SC code from JavaScript that gets sent to sclang via
`sendCode` / `.join(' ')`:

- **NEVER use `//` line-comments inside the emitted SC strings.** The whole
  payload is joined into a single line, and sclang's `//` swallows
  everything to end-of-line — which is end-of-input — silently truncating
  all trailing closing brackets and breaking parsing.
- Keep comments on the JS side only.
- Block comments `/* ... */` are safe if you really need an inline note.
- `currentEnvironment[\\foo] = bar` inside a `ProxySpace` auto-wraps `bar`
  as a `NodeProxy`. For non-audio state (Floats, Buffers, flags), use
  `Library.put(\\envil, \\foo, bar)` / `Library.at(\\envil, \\foo)` instead.
- `Server.default.sync` requires a `Routine` context.

## File / path conventions

- Workspace-local config goes in `.envil/` at the user's workspace root
  (not in the extension dir).
- Extension source paths use forward slashes; normalise on Windows.

## Build & test

- Rebuild + install: `./rebuild-install.sh`
- User reloads the VS Code window manually after install.
