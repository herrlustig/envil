# Post-mortem: Post Window froze mid-jam (but audio kept playing)

**Date of incident:** 2026-10-02, second jam of the evening
**Date of analysis:** 2026-10-03
**Analyst:** AI pair (Copilot) + user
**Status:** Root cause identified with log evidence. Prioritized fixes + two
TODO lists (error-fix and logging/anti-blind-spot) in [§8](#8-prioritized-todo-lists);
nothing applied yet — awaiting your decision.

---

## 0. TL;DR

After ~1–2 h of jamming, the **SuperCollider Post Window stopped updating** and
re-evaluating code appeared to do nothing — **yet the sound kept playing, MIDI
mappings (`~l_c49.kr` etc.) kept working, and audio inputs kept working.** Both
`supernova` and `sclang` processes were still alive afterward.

**This was not an sclang crash and not a server crash.** `sclang` and `scsynth`
(supernova) kept running fine the whole time. The freeze was in the **VS Code
extension's stdout display pipeline** — specifically a **marker-desync bug** in
`client/src/sc.ts`'s `filterMarkers()`.

The trigger is in the log: at `20:20:50` an autocomplete query for an **undefined
variable `dsd`** errored. SuperCollider **echoed the failed source code back to
stdout**, and that echoed source contained ENVIL's internal "suppress marker"
sentinel (`___ENVIL_ENVKEYS___`). The error echo was **truncated by sclang**
mid-way, leaving an **odd/unpaired marker** in the stream. From that moment on,
`filterMarkers()` treated *everything* after it as "inside a pending suppressed
block" and **silently swallowed all further Post Window + log output** for the
rest of the session.

---

## 1. Symptom recap (as reported)

| Observation | Still working? |
|---|---|
| SuperCollider Post Window updates | ❌ frozen |
| Re-evaluating code produces visible result | ❌ nothing happened |
| Sound from active ProxySpace nodes | ✅ kept playing |
| MIDI-mapped control (`~l_c49.kr` via mapped device) | ✅ worked |
| Audio inputs (microphone etc.) | ✅ worked |
| `supernova` process alive afterward | ✅ yes |
| `sclang` process alive afterward | ✅ yes |

This specific pattern — **display dead, but DSP + MIDI + control all alive** — is
the key diagnostic fingerprint. See [§5](#5-why-each-symptom-is-explained).

---

## 2. Where are the logs? (so you can analyse yourself)

ENVIL is a multi-part system. Each part writes to a different place. Here is the
**complete map of log sinks**, which part owns them, and how to read them.

### 2.1 SuperCollider Post Window → file mirror ⭐ most important here

- **File:** `<workspace>/.envil/sc-post.log` (+ rotated `sc-post.log.1` at 512 KB)
- **For your repo:** `~/Desktop/00_band_repo/.envil/sc-post.log`
- **Written by:** `client/src/sc.ts` → `appendScLog()` (lines ~115–133)
- **Contains:** everything sclang prints to stdout/stderr — your `.postln`,
  `.poll`, warnings, errors, boot messages — **after** it passes through the
  `filterMarkers()` suppression filter. Each line is prefixed with an ISO-UTC
  timestamp like `[2026-10-02T20:20:50.962Z]`.
- **Gotcha discovered here:** because output is filtered *before* being logged,
  **a bug in the filter makes the log go silent too** — which is exactly what
  happened (see [§4](#4-root-cause)). So the log's *silence* is itself evidence.
- **Timezone note:** timestamps are **UTC** (`Z`). You are in CEST (UTC+2), so
  `20:20:50Z` in the log = **22:20 your local time** — consistent with "after
  1–2 hours".

### 2.2 Live Post Window (VS Code Output panel)

- **Where:** VS Code → Output panel → channel **"SuperCollider Post Window"**.
- **Also:** channel **"SuperCollider"** = the *extension's own* lifecycle log
  (spawn path, "sclang process spawned", exit codes) — **not** sclang's output.
  This channel kept working during the freeze and is worth checking too.
- These are **not** persisted to disk by VS Code; only §2.1's file mirror is.

### 2.3 Hydra / webview (the browser UI)

- **File:** `<workspace>/.envil/webview.log` (+ `webview.log.1`)
- **Written by:** `touch-knobs.js` (log bridge, line ~382–401); the webview's
  `console.*` is forwarded to the host which appends here.
- **Also:** VS Code Output channels **"Hydra"** (`extension.js` ~488) and
  **"Envil Debug"** (`hydra-language-support.js` ~978).
- **In this incident:** `webview.log` only shows today's (Oct 3) session start —
  **the hydra/webview side was not involved** in the freeze.

### 2.4 Extension host console (the Node side of the extension)

- **Where:** VS Code → `Help ▸ Toggle Developer Tools ▸ Console`, filter `[envil]`.
- **Written by:** `console.log('[envil] …')` throughout `extension.js`
  (heartbeat ♥, heal messages, sclang start/exit).
- **Not persisted.** This is the richest real-time view of the extension's
  internal state machine, but it evaporates on reload. (See
  [§6](#6-observability-gaps) — this is a gap.)

### 2.5 The processes themselves

- `sclang` is a **child process of the extension** (`spawn` in `sc.ts`). Its
  stdout/stderr are piped into §2.1/§2.2. It has no separate log file.
- `scsynth`/`supernova` is an **independent process**. ENVIL only pings it over
  OSC (`/status` on UDP 57110) for the status bar; it does **not** capture the
  server's own console. If you booted it from your `startup.scd`, its stdout
  goes wherever sclang's post window goes (so, §2.1).

### 2.6 Quick reference

| Part | Channel / file | Persisted? | Owner source |
|---|---|---|---|
| sclang stdout/stderr | `.envil/sc-post.log`, Output "SuperCollider Post Window" | ✅ file | `client/src/sc.ts` |
| extension ↔ sclang lifecycle | Output "SuperCollider" | ❌ | `client/src/sc.ts` |
| hydra webview console | `.envil/webview.log`, Output "Hydra"/"Envil Debug" | ✅ file | `touch-knobs.js`, `hydra-language-support.js` |
| extension host internals | DevTools Console `[envil]` | ❌ | `extension.js` et al. |
| scsynth/supernova | (only `/status` OSC ping) | ❌ | `extension.js` `pingScsynthOSC` |

---

## 3. What the logs actually show (the evidence)

Tail of `~/Desktop/00_band_repo/.envil/sc-post.log`:

```
[2026-10-02T20:20:49.287Z] UGen Array [0]: 0.683333
[2026-10-02T20:20:50.284Z] UGen Array [0]: 0.683333      ← last normal line
[2026-10-02T20:20:50.962Z] ERROR: Variable 'dsd' not defined.
[2026-10-02T20:20:50.962Z]   in interpreted text
[2026-10-02T20:20:50.962Z]   line 1 char 15:
[2026-10-02T20:20:50.962Z]
[2026-10-02T20:50:34.522Z]   {   var v = dsd;   if(v.isKindOf(Dictionary), {
    var out = "";     out.postln;   }, {     ("──── sclang exited (code null) ────
```

Three decisive facts:

1. **A ~1 Hz poll was streaming** (`UGen Array [0]: 0.683333`, one per second —
   this is a `.poll(1)` in your jam code). It stops **dead** at `20:20:50.284`.
2. **The very next event is an error** for an **undefined variable `dsd`** at
   `20:20:50.962`, with SuperCollider echoing the offending source
   (`{ var v = dsd; if(v.isKindOf(Dictionary), ...`).
3. **Then a 30-minute hole.** The next timestamp is `20:50:34.522Z` — and it is
   the `──── sclang exited ────` marker (you ending the session), with the
   *previously-buffered* `dsd` echo flushed out in front of it.

The echoed source text the log managed to emit **ends exactly at `}, {     ("`** —
i.e. right at the opening of the `("MARKER" ++ "MARKER")` else-branch. That cut
point is the fingerprint of the bug (see next section). Note also that the echo
shows `var out = "";` with the marker text *already stripped out* — proof that
the filter was actively pairing/removing markers from the echoed source.

> The source query — `{ var v = dsd; if(v.isKindOf(Dictionary), { var out =
> "___ENVIL_ENVKEYS___"; … }, { ("___ENVIL_ENVKEYS___" ++ "___ENVIL_ENVKEYS___")
> .postln; }) }.value` — is built verbatim by
> [`env-completions.js`](../../env-completions.js) `buildKeysQuery()` (lines 34–50).
> It fires when you type `<varName>[\` to offer Dictionary/Environment key
> completions. Here `<varName>` was `dsd`, which was not defined.

---

## 4. Root cause

### 4.1 The mechanism: suppress-marker desync in `filterMarkers()`

ENVIL runs many **background queries** against sclang (completions, signature
help, the 3 s heartbeat, the SC→Hydra bridge). To keep their machine-readable
replies out of your Post Window, each wraps its payload in a **sentinel string**
and registers it via `addSuppressMarker()`. `filterMarkers()` in
[`client/src/sc.ts`](../../client/src/sc.ts) (lines ~60–83) strips every
`MARKER … MARKER` block before the text reaches the Post Window and the log.

It keeps a **module-global accumulator** `_stdoutBuf`. When it sees an **opening
marker with no closing marker yet**, it assumes the closing half is still coming,
emits only the clean prefix, and **holds the rest in `_stdoutBuf`**:

```js
if (endIdx === -1) {
    // Partial — wait for more data.  Return everything before the marker.
    const clean = _stdoutBuf.substring(0, startIdx);
    _stdoutBuf = _stdoutBuf.substring(startIdx);
    return clean;              // ← everything from the marker onward is withheld
}
```

That design is correct **only if markers always arrive in balanced pairs**.
They do not, because of one overlooked path:

> **SuperCollider echoes failed source code back to stdout on a compile error —
> and that echoed source can contain the marker sentinel.**

### 4.2 The exact chain of events

1. You were typing; the text under the cursor matched `dsd[\` (or similar), so
   `env-completions.js` fired `buildKeysQuery("dsd")`. That query string
   contains the `___ENVIL_ENVKEYS___` sentinel **four times**.
2. `dsd` was undefined → **compile error**. sclang prints
   `ERROR: Variable 'dsd' not defined.` **and echoes the source** — including the
   sentinels — to stdout.
3. SuperCollider **truncates** long error echoes. The echo emitted the first two
   sentinels (paired → removed cleanly, leaving the `var out = "";` we see) and
   then the **third** sentinel at the start of the else-branch
   `("___ENVIL_ENVKEYS___" …` — **but was cut off before the fourth**.
4. `filterMarkers()` now holds an **unpaired opening marker**. It flips into
   "pending partial" mode and **returns `""` for every subsequent chunk**,
   appending each new chunk to `_stdoutBuf` while waiting for a closing
   `___ENVIL_ENVKEYS___` that will never come.
5. Result: **Post Window + `sc-post.log` go permanently silent.** sclang keeps
   running and keeps producing output — it is all being buffered and discarded by
   the extension, not shown.

### 4.3 Why it never recovered

The sentinel is a **constant** (same string for every variable's key query), so
in principle typing *any* `otherVar[\` again would emit the marker twice and
re-pair/flush. In a live panic that did not happen — and if a retrigger also hit
an undefined variable, it would **re-truncate and re-stick**. So the session
stayed frozen until you killed sclang at `20:50`.

---

## 5. Why each symptom is explained

| Symptom | Explanation |
|---|---|
| Post Window frozen | `filterMarkers()` swallowed all stdout after the desync. |
| `sc-post.log` frozen | The log is written *after* the filter, so it went silent too. |
| Re-eval "did nothing" | Most likely your code **was** sent and **did** run, but the `-> result` echo + any `.postln` were swallowed, so it *looked* dead. **This is inference, not logged fact** — see [§6](#6-did-the-interpreter-zombify-send-path--liveness). |
| Sound kept playing | DSP runs in **scsynth/supernova** (separate process) — untouched. |
| MIDI `~l_c49.kr` worked | `MIDIdef` runs inside the **living** sclang and writes the control bus; display being swallowed doesn't stop it. **Key liveness clue** — see §6. |
| Audio inputs worked | Server-side signal path — untouched. |
| Both processes alive | Correct — nothing crashed; only the extension's *view* broke. |

Everything is consistent with **"sclang + server fully alive, extension display
pipeline desynced."** The one honest caveat — whether a *second*, coincident
fault could have blocked code evaluation — is examined next.

---

## 6. Did the interpreter zombify? (send-path & liveness)

A fair challenge was raised: *the Post Window went silent, but are we sure code
evaluation still worked? Could sclang have stalled/"zombified" — alive enough to
keep running the existing MIDIdef→proxy chain, but unable to interpret new
`MIDIdef` / `~test3.kr` / `~noise21.ar` definitions?* This section weighs that
honestly and marks what is **proven** vs **inferred**.

### 6.1 The send path is architecturally separate from the broken filter — **proven**

`sendCode()` in [`client/src/sc.ts`](../../client/src/sc.ts) does essentially two
things:

```js
sclangProcess.stdin.write(cleanCode + '\x0c');  // the actual eval — the whole job
postWindowOutput.show(true);                     // just reveals the panel
```

It touches **`stdin.write`** and nothing else. The broken `filterMarkers()` lives
only on the **receive** side (`stdout.on('data')`). A receive-side desync
**cannot** block a stdin write. So the freeze could not have *stopped* sends.

### 6.2 The extension never lost its channel to sclang — **proven (code), unlogged (runtime)**

The stdout handler forwards to `queryCode` listeners **before** the filter runs:

```js
const filtered = filterMarkers(text);
if (filtered) { postWindowOutput.append(filtered); appendScLog(filtered); }
for (const fn of stdoutListeners) fn(text);   // ← RAW text, pre-filter
```

So the 3 s heartbeat `queryCode` round-trips read **raw** stdout and were
**immune** to the desync. Consequence: if sclang was alive, the heartbeat kept
talking to it the whole time; if sclang had truly zombified, those queries would
have **timed out**. Either way the display stays frozen — but the distinction is
exactly what we'd want recorded. **We have no persisted record of those
round-trips** (they're silent + marker-suppressed), so this is proven in *code*
but not *logged* for that session. (This is Blind-spot #1 below.)

### 6.3 Why a "selective zombie" is very unlikely — **architecture**

The zombie hypothesis needs sclang to run the *old* MIDIdef but refuse *new*
definitions. Both go through the **same single interpreter**:

- sclang is **single-threaded for all interpreted code**: stdin evals, Routines,
  clock tasks, OSCfunc **and** MIDIdef callbacks are serialized onto one language
  thread behind one interpreter lock. MIDI bytes arrive on a separate OS thread,
  but the MIDIdef **function body** only runs once it holds that lock.
- So a moved knob producing sound proves the MIDIdef callback **acquired the
  interpreter lock, ran, and released it** — repeatedly. That is the *same* lock a
  stdin eval of `~noise21.ar = {...}` needs.
- If the interpreter had deadlocked or spun in an infinite loop, the MIDIdef
  callback would have **blocked on that lock and the knob would have gone
  silent too.** It did not.

Creating a new `MIDIdef`/proxy is "just interpret a line" on the very thread that
was demonstrably free enough to service your MIDI callbacks. The realistic
failure mode of an *overwhelmed* single thread is **lag** (evals land seconds
late as they queue behind heavy work), i.e. degradation — not a clean split where
old responders live and new definitions silently fail. Your recollection was
"worked fine," not "laggy," which argues against even the lag case.

### 6.4 No known SC bug matches this — **web search**

- No SuperCollider issue / forum report describes "sclang alive for MIDI but dead
  for stdin" — the state doesn't map to the engine's design, so it isn't a known
  bug class.
- Closest hit, [supercollider#4214 "IDE stuck at Sending request…"](https://github.com/supercollider/supercollider/issues/4214),
  is a **Windows-only stdin handshake hang fixed in 2020** (PR #4646). You're on
  Linux — not applicable.
- The real "overwhelm" failure in this stack is the **supernova segfault under
  sustained SendReply/OSC traffic** — but that is a **server crash**, and your
  server stayed up (audio kept playing). Different failure, not this one.

### 6.5 Honest verdict

**Very likely display-only; not provable to 100 % from logs.** The architecture
makes the selective-zombie scenario implausible, and the MIDI-alive evidence
actively points to a live interpreter. But because send-side activity and
heartbeat round-trips were never persisted, we **cannot timestamp-prove** that a
specific eval of yours was transmitted and ran during the 30-minute window. This
missing evidence — not any doubt about the filter bug — is the real gap, and it
is exactly what the logging TODOs in [§8](#8-prioritized-todo-lists) close.

---

## 7. Observability gaps (what logging was missing)

These made the incident harder to diagnose than it should have been:

1. **The filter has no "stuck marker" safety valve / telemetry.** When
   `_stdoutBuf` holds a pending marker for more than a few hundred ms or grows
   past a few KB, nothing warns, times out, or force-flushes. A single log line
   like `[envil] ⚠ suppress-marker desync, force-flushing N bytes` would have
   made this instantly obvious.
2. **No bound on `_stdoutBuf`.** It can grow without limit. With your ~1 Hz (and
   elsewhere up to 30 Hz) polls, 30 min of swallowed output accumulated in one
   ever-growing JS string, and the per-chunk `for (marker) indexOf` loop over it
   is **O(n²)** — a slow CPU creep in the extension host on top of the freeze.
3. **No send-side log at all.** The extension logs what sclang *prints back*, but
   **never logs what it sends**. So for the frozen 30 min there is zero record of
   whether you evaluated anything or whether it was transmitted — which is why
   [§6](#6-did-the-interpreter-zombify-send-path--liveness) can't be closed to
   100 %. This is the single highest-value missing log.
4. **Heartbeat round-trips are invisible.** The 3 s `queryCode` calls are silent
   + marker-suppressed, so even a *healthy* round-trip leaves no line. A
   persisted "query #N ok at T" counter would prove interpreter liveness (or pin
   the exact stall moment) — the other half of answering §6.
5. **Extension-host `[envil]` logs are not persisted.** The heartbeat and heal
   messages that would corroborate "sclang still alive, queries still firing"
   vanish on reload. A rotating `.envil/extension-host.log` would help.
6. **No marker nonce.** Because markers are constant, a desync can't be
   attributed to a specific query, and a stale marker can collide with a later
   identical one.
7. **`appendScLog()` line-buffer can hold a partial line indefinitely** (here,
   30 min — the `dsd` echo sat in `_scLogLineBuf` until the exit flush). Minor,
   but it means the file log can lag arbitrarily behind reality.
8. **No event-loop stall guard.** The `O(n²)` scan over an unbounded `_stdoutBuf`
   could, under faster output, starve the single-threaded extension host and make
   *commands themselves* sluggish — with nothing logged to reveal it.

---

## 8. Prioritized TODO lists

Two independent tracks. **List 1** kills the bug at hand (and its trigger).
**List 2** attacks the information blind-spots so the *next* weird freeze is a
ten-second log read instead of a forensic dig. Each item has a rough
effort/risk tag: 🟢 small/low-risk, 🟡 medium, 🔴 larger/needs care. Detailed
implementation sketches for the `Fix *` items live in
[§9](#9-fix-details-implementation-sketches).

### List 1 — the error at hand (Post Window freeze)

Ordered by value-per-effort; do them top-down.

1. 🟢 **Fix A — make `filterMarkers()` fail-*open*.** Cap the pending buffer by
   **size (~64 KB)** and **age (~750 ms)**; on breach, force-flush everything to
   the Post Window + log, reset state, and emit one `⚠ suppress-marker desync`
   warning. *Directly prevents recurrence.* Single function, `client/src/sc.ts`.
2. 🟢 **Fix D(partial) — reset `_stdoutBuf` + pending state on sclang start/exit.**
   A fresh session should never inherit a stuck buffer. Few lines, same file.
3. 🟡 **Fix B — stop undefined-identifier queries from being echoed.** In
   `env-completions.js`, pre-check the identifier resolves (or use an `.at(\key)`
   runtime lookup) so a half-typed `dsd[\` never triggers a **compile-error
   echo** carrying the marker. *Removes the specific trigger.*
4. 🟡 **Fix C — per-query marker nonce.** Append a counter/random suffix
   (`___ENVIL_ENVKEYS_7f3a___`) so a stale marker can never re-pair with a later
   query, echoed source rarely collides, and force-flush warnings can name the
   culprit. Localized to `queryCode` + `addSuppressMarker` call sites.
5. 🟢 **Reproduce + regression-test.** In a dev host: start sclang, type `zzz[\`
   (undefined), confirm the Post Window can wedge *before* Fix A and
   self-recovers with a warning *after*. Keep a tiny scripted repro.
6. 🟢 **Guard the `O(n²)` scan.** Once Fix A caps the buffer this is mostly moot,
   but cap the per-chunk marker scan too (bounded window) so a pathological burst
   can't spike extension-host CPU.
7. 🟢 **Hygiene (your side).** Prefer temporary / slower `.poll` (or the VU meter)
   in long sets; know that the `Envil: Start/Stop SCLang` toggle is the
   instant recovery (server + audio survive). See [§10](#10-code-hygiene--live-coding-notes-your-side).

### List 2 — logging / anti-blind-spot (system-health insight, incl. live warnings)

Ordered so the highest-diagnostic-value, lowest-effort logs come first. The goal
is **zero silent failure modes**: every freeze/stall should leave a timestamped
trail, and the worst ones should *warn the user mid-session*.

1. 🟢 **Send-side log.** One line per transmitted eval — `ts, byteCount,
   firstLine|hash, silent?` — to a rotating `.envil/sc-send.log` (or tagged
   `>> SENT` in `sc-post.log`). **Closes the #1 blind spot**: proves a given
   eval was actually sent during a freeze. Trivial addition in `sendCode()`.
2. 🟢 **Heartbeat round-trip counter (liveness proof).** Persist a monotonic
   `query #N ok @ T (rtt Xms)` each successful 3 s `queryCode`. If it keeps
   climbing during a freeze → sclang stdin interpretation is **provably alive**
   (freeze = display-only). If it stalls at `THH:MM` → that timestamps a real
   interpreter stall. Answers [§6](#6-did-the-interpreter-zombify-send-path--liveness) definitively next time.
3. 🟢 **Filter-health telemetry (Fix A's warning, persisted).** Log every
   force-flush, pending-buffer high-water mark, and desync event. A quiet log
   should *say why* it went quiet.
4. 🟡 **Persist extension-host `[envil]` log.** Mirror the DevTools `[envil]`
   stream (heartbeat ♥, heals, start/exit) to a rotating
   `.envil/extension-host.log` so it survives reloads. This is the narrative that
   corroborates "sclang alive, queries firing."
5. 🟡 **Live user-facing health warnings.** Surface a status-bar signal when
   something is wrong *now*, e.g.:
   - `sclang ♥` tick that flips each successful heartbeat — a frozen tick =
     "queries being swallowed / interpreter stalled."
   - toast/status when a heartbeat `queryCode` **times out N× in a row** ("sclang
     not responding — evals may be silently failing").
   - toast when Fix A force-flushes ("Post Window output pipeline recovered —
     some output may have been shown raw").
6. 🟡 **Event-loop stall guard.** If a single `stdout.on('data')` handler call
   exceeds ~50 ms, log it with the chunk size — directly catches the `O(n²)`
   starvation path and any future hot-loop in the receive pipe.
7. 🟡 **Round-trip / RTT trend in the heartbeat.** Record `queryCode` latency over
   time; a creeping RTT is an early-warning of interpreter saturation **before**
   it becomes a freeze — could drive a gentle "sclang getting busy" hint.
8. 🟢 **Fix the `appendScLog()` partial-line lag.** Flush a held partial line
   after a short idle (or on a timer) so the file log can't lag 30 min behind
   reality again.
9. 🟢 **Document the log map** (already in [§2](#2-where-are-the-logs-so-you-can-analyse-yourself))
   in the repo README / `.ai-docs` so future-you (and the AI) knows every sink at
   a glance.
10. 🔴 **Optional: a one-key "health snapshot" command.** `Envil: Dump Health`
    writes sclang/scsynth liveness, last N sends, heartbeat counter, pending
    buffer size, and proxy/queue stats to a timestamped file — one click to
    capture state the moment something feels wrong on stage.

> Suggested first cut (biggest safety gain, least code): **List 1 #1–#2** +
> **List 2 #1–#3**. Together they both *prevent* the freeze and make any future
> occurrence self-explanatory (send log + liveness counter + desync warning).

---

## 9. Fix details (implementation sketches)

### Fix A — make `filterMarkers()` desync-proof ⭐ (addresses root cause)

In [`client/src/sc.ts`](../../client/src/sc.ts) `filterMarkers()`:

- **Cap the pending buffer.** If `_stdoutBuf` exceeds, say, 64 KB *or* a pending
  marker is older than ~750 ms, **give up, force-flush the whole buffer to the
  Post Window/log, and clear state.** A late-arriving suppressed reply showing up
  raw is a cosmetic nuisance; a permanent freeze is a session-ender. Fail *open*,
  never *closed*.
- **Emit a one-line warning** on force-flush so it's visible next time.
- Optionally track an **age timestamp** when a partial is first held.

Sketch:

```js
let _pendingSince = 0;
const MAX_PENDING_BYTES = 64 * 1024;
const MAX_PENDING_MS = 750;

function forceFlush() {
    const dump = _stdoutBuf; _stdoutBuf = ''; _pendingSince = 0;
    return dump;
}
// inside the endIdx === -1 branch, before returning `clean`:
if (!_pendingSince) _pendingSince = Date.now();
if (_stdoutBuf.length > MAX_PENDING_BYTES ||
    Date.now() - _pendingSince > MAX_PENDING_MS) {
    console.warn(`[envil] ⚠ suppress-marker desync — force-flushing ${_stdoutBuf.length}B`);
    return forceFlush();     // show everything; better raw than hidden
}
```

(When a block is fully paired and removed, reset `_pendingSince = 0`.)

### Fix B — don't let marker-bearing queries get echoed on error

In [`env-completions.js`](../../env-completions.js) (and any provider that
interpolates a user token into a query):

- **Pre-validate the variable exists before sending the keys query**, e.g. wrap
  in `thisProcess.interpreter.compileString` / a guarded lookup, or gate on
  `currentEnvironment`/declared vars so an undefined identifier never reaches a
  `var v = <ident>;` compile. This removes the *trigger*.
- Prefer **`environmentVar.at(\key)`-style runtime lookups** that return `nil`
  instead of a bare identifier that throws a **compile** error (compile errors
  are what get echoed verbatim).

### Fix C — use a unique per-query marker nonce

Append a short random/counter nonce to every marker
(`___ENVIL_ENVKEYS_7f3a___`). Then: (a) a stale stuck marker can never be
re-paired with an unrelated later query, (b) force-flush logs can name the
culprit, (c) markers in echoed source are far less likely to coincide. Requires
threading the nonce through `queryCode` + `addSuppressMarker` (they already take
the marker string as a parameter, so this is localized).

### Fix D — bound and self-heal `_stdoutBuf` growth

Covered partly by Fix A's byte cap. Also consider resetting `_stdoutBuf` on
`sclang` start/exit (fresh session = fresh buffer).

### Fix E — observability

- Persist `[envil]` host logs to a rotating `.envil/extension-host.log`.
- Add the Fix A warning line.
- Consider a status-bar tick that flips (e.g. `sclang ♥`) each time a heartbeat
  query **round-trips successfully** — a dead tick would have visibly signalled
  "queries are being swallowed" during the jam.
- See [§8 List 2](#8-prioritized-todo-lists) for the full logging roadmap
  (send log, heartbeat counter, live warnings, stall guard).

---

## 10. Code-hygiene / live-coding notes (your side)

Not causes, but amplifiers and good habits:

- **Heavy `.poll(1)` usage.** The jam code has several polls
  (`Amplitude.ar(sig2).poll(1)`, `~t.kr.poll(1)`, `LFNoise0.ar(~t.kr.poll(1)…)`).
  These produced **1,339 `UGen Array` lines in a single 512 KB log rotation** and
  continuously feed the stdout pipeline — which is exactly what piled up in the
  stuck `_stdoutBuf`. For live sets prefer **temporary** polls you remove quickly,
  a slower `.poll(0.25)`, or a dedicated meter (`s.meter`, scope, or the panel VU)
  instead of streaming text. Less post-window spam = smaller blast radius if the
  pipeline ever hiccups.
- **Undefined-variable completions.** Typing `dsd[\` where `dsd` isn't defined is
  what lit the fuse. Nothing you did *wrong* — the extension should tolerate it —
  but being aware that **autocomplete fires live queries against sclang** is
  useful: half-typed identifiers can trigger error echoes. Fix B makes this safe.
- When the Post Window ever freezes again mid-set, the **fastest recovery** is
  the `Envil: Start/Stop SCLang` toggle (restart sclang) — the server and audio
  survive, and a fresh sclang resets `_stdoutBuf`. Knowing it's a *display*
  freeze (not a crash) means you can keep playing and restart the language when
  convenient.

---

## 11. Appendix — key source locations

| Concern | File | Approx. lines |
|---|---|---|
| `filterMarkers()` (the bug) | `client/src/sc.ts` | 60–83 |
| stdout handler → filter → log | `client/src/sc.ts` | ~247–255 |
| `appendScLog()` + rotation + line-buffer | `client/src/sc.ts` | 103–133 |
| `queryCode()` marker protocol | `client/src/sc.ts` | ~340–368 |
| env-keys query builder (the trigger) | `env-completions.js` | 34–50 |
| marker registration (completions) | `sc-completions.js` | 141–144, 951–957 |
| heartbeat + `ensureProxyRegisters` | `extension.js` | 1455–1560 |
| SC→Hydra bridge markers | `sc-bridge.js` | 60–95 |

> Note: the shipped extension runs the **compiled** `client/out/sc.js`; edits to
> `client/src/sc.ts` require a rebuild (`./rebuild-install.sh`) + window reload.
