# Offline / Local Code Suggestions for Envil — Analysis & Phase Plan

_Date: 2026-04-21_

Context: online AI inline suggestions (Copilot etc.) are very valuable during
live coding (speed, ideas, less typing) but disappear when offline. This
document analyses how to build an offline-capable suggestion system for the
Envil VS Code extension, tailored to SuperCollider + Hydra live coding.

---

## 1. Use-case analysis

Derived from the existing jams (`00_band_repo/00_jams/`) and the extension
code:

- The user mostly **recombines known patterns**: `Pbind(…)`, `SynthDef(\x, { … }).add`,
  `~out = { … }`, `Ndef`, `~mcr_N.kr.linlin(…)`, `Decimator / PitchShift / GVerb`
  chains, etc.
- A lot of typed text is **boilerplate** repeated every session (e.g. the
  `SoundIn → LeakDC → Compander` proxy scaffold in `extension.js`).
- The best “prompts” already live **in the local repo**: `00_jams/`, `libs/`,
  `std_jammy_simple.sc`, `my_footcontroller.sc`, etc.
- Goal on stage = **speed + serendipity** (ideas), not correctness review.

So the target is: _given what I’m typing right now, show me something I (or
the SC help files) already wrote that fits_ — offline, low-latency.

---

## 2. What goes away when going offline

| Online feature | Offline equivalent |
|---|---|
| Ghost inline completion | Snippet / template with tab-stops |
| Multi-choice cycling (Alt-] / Alt-[) | `InlineCompletionItemProvider` returning multiple items |
| Semantic awareness of surroundings | Embedding-based retrieval from a local corpus |
| Comment → code | Trigger phrase (`_TPL_`, `//?`) + retrieval / local LLM |

---

## 3. What already exists in Envil to build on

- Full completion architecture: `sc-completions.js`, `pbind-completions.js`,
  `proxy-completions.js`, `env-completions.js`.
- Live sclang bridge — can pull SC help/examples on demand.
- `data/` directory already used for persisted JSON → good home for an index.
- `codelens-blocks.js` has block detection that can be reused to split corpora
  into self-contained runnable chunks.

---

## 4. Feasible techniques (ranked by effort / value)

### A. Snippet / template library — lowest effort, big win
Plain VS Code snippets + a dynamic `CompletionItemProvider` reading from:
- Hand-curated `~/.envil/snippets/*.scd`.
- Auto-harvested top-level `( … )` blocks from the jams dir.
- `Examples` / `code::` blocks parsed from SC `.schelp` files.

Trigger: normal typing + explicit `_TPL_` / `//?` that forces the full list.

**Pros:** deterministic, instant, no ML, native multi-item list.
**Cons:** pure text match; no “comment → code”.

### B. Local retrieval over the corpus (“grep++”)
Block-level chunks with metadata (file, date, vars, SynthDef names, UGens).
Query with BM25 / tf-idf on tokens in the last ~40 lines of the buffer —
pure JS via `lunr` or `flexsearch` (~100 KB, offline).

Present results as an `InlineCompletionItemProvider`, cyclable with Alt-].

**Pros:** reuses real code the user wrote → stylistically correct.
**Cons:** literal match only.

### C. Local embeddings + semantic retrieval
Embed each block with a small model (e.g. `all-MiniLM-L6-v2` via
`@xenova/transformers`, ~25 MB, CPU). Cosine top-k at query time.
- Rebuild command: `envil.suggest.reindex`.
- Incremental on save.
- Configurable sources (`envil.suggest.sources`).

**Pros:** handles paraphrases / intent; works with `//? …` comments.
**Cons:** ~200 ms first query, ~25 MB model download.

### D. Local LLM via Ollama / llama.cpp
Small coding model (`qwen2.5-coder:1.5b`, `deepseek-coder:1.3b`) via Ollama’s
HTTP API, with a RAG context built from B/C. Similar approach to the
**Continue** extension.

**Pros:** real generative “comment → code”; offline; N variations.
**Cons:** 1–2 s latency on CPU, bigger install.

### E. Hybrid (recommended end-state)
Tiered suggester:
1. **Fast tier** — snippet + retrieval (A+B), <20 ms, always on.
2. **Smart tier** — embeddings (C), kicks in on pause >300 ms or `_TPL_`.
3. **Generative tier** — local LLM (D), explicit hotkey only.

---

## 5. How other projects do this in VS Code

- **Continue** — RAG + local Ollama; good reference for provider structure (MIT).
- **Tabby** — self-hosted code model, VS Code client.
- **Cody (Sourcegraph)** — context fetcher / embeddings pattern worth borrowing.
- **TabNine** — historical local transformer mode.
- **FauxPilot / llama.cpp-vscode** — minimal integrations.
- Pure-retrieval precedents: classic snippets, Emmet, Tabnine local.

Relevant VS Code APIs:
- `registerCompletionItemProvider` — dropdown list, multi-item.
- `registerInlineCompletionItemProvider` — ghost text; returning an array
  gives native Alt-] / Alt-[ cycling (same UX as Copilot).

---

## 6. Phase plan

### Phase 0 — Infrastructure & corpus (1–2 days)
- `suggestions/corpus.js`: walk configured roots, split `.sc/.scd/.schelp`
  into blocks (reuse `codelens-blocks.js`), extract metadata
  (SynthDefs, UGens, Pbind keys, `~proxy` names, date from filename).
- Persist to `data/suggestions-index.json`.
- Commands: `envil.suggest.reindex`, `envil.suggest.addSource`.
- Settings: `envil.suggest.sources`, `envil.suggest.includeHelp`.

### Phase 1 — Snippet / template provider (1 day)
- `CompletionItemProvider` serving corpus blocks as `SnippetString`s with
  `$1` tab-stops around numbers and `\symbols`.
- Trigger characters: `(`, `~`; explicit triggers `_TPL_` / `//?`.
- Curated hand-written snippets in `snippets/supercollider.code-snippets`
  for the ~20 canonical patterns (proxy scaffold, Pbind skeleton,
  `SynthDef` + `Env.perc`, `s.boot`, `s.scope`, …).

### Phase 2 — Inline multi-variant suggester (1–2 days)
- `InlineCompletionItemProvider` returning top-3 blocks scored by BM25
  over tokens in the last ~40 lines.
- Debounce 200 ms; per-buffer cache.
- Status-bar indicator with suggestion count.

### Phase 3 — Semantic retrieval (2–3 days)
- Add `@xenova/transformers` (MiniLM). Embed corpus on reindex; store
  `Float32Array` in compact binary.
- Query: embed cursor window, cosine top-k, fuse with BM25 via
  reciprocal-rank fusion.
- `//? free-text query` trigger treats the comment as the query.

### Phase 4 — Optional local LLM (2–3 days, opt-in)
- Detect Ollama (`http://localhost:11434/api/tags`).
- Command `Envil: Compose at Cursor` (hotkey), prompt template injects
  top-k retrieved blocks + 20 lines of context.
- Stream into a ghost decoration; accept with Tab.

### Phase 5 — UX polish
- Right-click “Save block as template” → appends to user snippet file.
- Peek-style window showing all candidates with source file & date.
- Per-session “favourite” boost for accepted blocks.

---

## 7. Bonus ideas to truly help live coding

1. **Style profile** — weight suggestions by the user’s idioms
   (e.g. boost blocks referencing `~mcr_N` macros).
2. **Context-aware splitting** — inside `Pbind(…)` suggest _keys_; after
   `SynthDef(\` suggest _skeletons_; after top-level `~` suggest
   _proxy-assignment templates_. Extend what `pbind-completions.js` already
   does.
3. **“Vary this” command** — select a block → 3 alternatives retrieved by
   embedding similarity of the block itself. Great on-stage button.
4. **Parameter-sweep templating** — selected number → wrapping suggestions
   (`rrand(x,y)`, `LFNoise1.kr(…).range(x,y)`, `~mcr_N.kr.linlin(…)`). Zero
   AI, huge time-saver.
5. **Session memory** — record every evaluated block during a session (the
   extension already sees them via sc-bridge) and feed them back to the
   index with a strong recency boost → the suggester “learns the set” live.
6. **Dated filename heuristic** — jam filenames encode dates; display e.g.
   _“from 2025-12-15”_ next to a suggestion to recognise the vibe.
7. **Scale to Hydra** — the same pipeline applies to `.js` Hydra blocks.
8. **Offline SC help integration** — index `SCClassLibrary/**/*.schelp`
   examples once; instantly yields a large, high-quality corpus without any
   AI.
9. **Chord trigger over typed keyword** — a shortcut like `Ctrl+;` pops a
   QuickPick filtered by cursor context. Fewer keystrokes on stage than
   `_TPL_`.
10. **Negative triggers** — suppress ghost text while a block is executing
    (known via sc-bridge) so suggestions never fight a running jam.

---

## 8. Minimal recommendation

If doing only one thing: **Phase 0 + 1 + 2** — pure retrieval, no ML.
That gives:

- Offline, <20 ms, deterministic.
- Past-session code + SC help examples surfaced as inline suggestions with
  multi-variant cycling.
- Explicit `//?` / `_TPL_` triggers for on-demand template invocation.

Covers roughly 80 % of what online Copilot brings for this style of coding,
and is a clean base for embeddings (Phase 3) and a local LLM (Phase 4)
without throwing anything away.

---

## 9. ML models — size, bundling & licensing

### 9.1 Size overview

| Model | Purpose | Disk (quantised) | RAM at runtime | CPU latency |
|---|---|---|---|---|
| **all-MiniLM-L6-v2** (embeddings, Xenova ONNX) | Phase 3 retrieval | ~23 MB (int8) / ~90 MB (fp32) | ~100 MB | ~5–20 ms / query |
| **bge-small-en-v1.5** (embeddings) | better retrieval | ~33 MB (int8) | ~130 MB | ~10–30 ms |
| **nomic-embed-text-v1.5** | strong retrieval, 8k ctx | ~80 MB (int8) | ~250 MB | ~30–60 ms |
| **qwen2.5-coder:0.5b** (Ollama) | tiny local LLM | ~400 MB (Q4) | ~700 MB | 0.5–1 s/line (CPU) |
| **deepseek-coder:1.3b** | small local LLM | ~800 MB (Q4) | ~1.5 GB | 1–2 s/line (CPU) |
| **qwen2.5-coder:1.5b** | sweet spot | ~1 GB (Q4) | ~2 GB | 1–2 s/line (CPU) |
| **qwen2.5-coder:3b** | noticeably smarter | ~2 GB (Q4) | ~3.5 GB | 2–4 s/line (CPU), fast on GPU |
| **qwen2.5-coder:7b** | Copilot-like | ~4.5 GB (Q4) | ~8 GB | GPU effectively required |

### 9.2 Can we bundle them in the plugin repo?

**Embeddings (MiniLM / bge-small): technically yes, but don’t.**

- VS Code Marketplace hard limit is **50 MB per VSIX**; a MiniLM int8 fits,
  bge-small barely, anything bigger doesn’t.
- Git / GitHub: files >100 MB require LFS; the repo bloats and every
  `git clone` pays the cost.
- npm registry allows up to 250 MB but pulling ~25 MB on every install is
  still ugly.

**Generation models (≥ 0.5 B): no.** Way over Marketplace / npm / GitHub
limits. Must live outside the extension.

### 9.3 Recommended distribution pattern

Mirrors what **Continue**, **Tabby**, **Cody** do:

1. **Ship no weights in the VSIX.**
2. On first activation (or on `envil.suggest.reindex`):
   - Download the embedding model via `@xenova/transformers` — it fetches
     from HuggingFace into `~/.cache/huggingface/` automatically, with a
     local cache. Offline after the first run.
   - Show a progress notification; opt-out via
     `envil.suggest.embeddings.enabled`.
3. **Offer a pre-downloaded path setting** (`envil.suggest.modelPath`) for
   fully air-gapped users — they drop the ONNX file there manually.
4. For LLMs: **don’t bundle**, just detect **Ollama**
   (`http://localhost:11434`) or **llama.cpp server**. User installs the
   model themselves (`ollama pull qwen2.5-coder:1.5b`). The extension only
   needs a small HTTP client.

Effect: extension stays small (<1 MB), every model is an optional add-on.

### 9.4 Licensing

Short version: for an **open-source plugin (GPL-3.0 as Envil is) that only
*loads* a model at runtime**, none of the options below block you. The
nuance is about **shipping the weights** inside the VSIX.

| Model | License | Shippable inside a GPL-3 VSIX? | Commercial use? |
|---|---|---|---|
| **all-MiniLM-L6-v2** (sentence-transformers) | **Apache-2.0** | **yes** yes | **yes** yes |
| **Xenova/all-MiniLM-L6-v2** (ONNX port) | Apache-2.0 (inherits) | **yes** yes | **yes** yes |
| **bge-small-en-v1.5** (BAAI) | **MIT** | **yes** yes | **yes** yes |
| **nomic-embed-text-v1.5** | **Apache-2.0** | **yes** yes | **yes** yes |
| **qwen2.5-coder 0.5 / 1.5 / 3 / 7 B** | **Apache-2.0** | **yes** yes (if it fit) | **yes** yes |
| **qwen2.5-coder 14 / 32 B** | **Qwen Research License** (non-commercial clauses) | **caveat** restrictions | **no** only with permission |
| **deepseek-coder 1.3 / 6.7 B** | **DeepSeek License** (custom, permits commercial + redistribution with conditions) | **caveat** must ship the license file & respect use restrictions | **yes** yes, with conditions |
| **Code Llama / Llama 3** | **Llama Community License** (custom, >700 M MAU restrictions, acceptable-use policy) | **caveat** must ship license; not OSI-approved | **yes** yes |
| **StarCoder2** | **BigCode OpenRAIL-M** | **caveat** “responsible AI” use-restrictions apply | **yes** yes |
| **@xenova/transformers** (runtime) | **Apache-2.0** | **yes** yes | **yes** yes |
| **Ollama** (external binary) | **MIT** | N/A (not bundled) | **yes** yes |
| **llama.cpp** | **MIT** | N/A | **yes** yes |

Key points:

- **Apache-2.0 / MIT** (MiniLM, bge, nomic, Qwen ≤ 7 B, llama.cpp, Ollama,
  transformers.js) are the cleanest. Compatible with GPL-3, redistributable,
  no field-of-use limits. Include `NOTICE` / `LICENSE` alongside weights if
  bundled.
- **DeepSeek / Llama / OpenRAIL-M** add extra use restrictions (no military,
  no illegal use, etc.) which are technically **not OSI-open-source**.
  Loading them at runtime is fine; **bundling** obliges you to propagate
  the license text and respect the restrictions — some Linux distros
  (Debian) explicitly reject these. Avoid bundling for a purely FOSS plugin.
- **Qwen ≥ 14 B** is non-commercial — don’t default-recommend.
- GPL-3 of the extension itself only covers *your code*; model weights are
  considered data, so mixing licenses at runtime does not “infect” them.

### 9.5 Concrete recommendation

1. **Embeddings (Phase 3):** use **bge-small-en-v1.5** or **MiniLM-L6-v2**
   via `@xenova/transformers`. Download on first use; don’t bundle.
   MIT / Apache-2.0 → zero legal friction.
2. **Generation (Phase 4):** don’t ship weights. Detect Ollama and
   default-recommend **qwen2.5-coder:1.5b** (Apache-2.0, ~1 GB). Document
   `ollama pull qwen2.5-coder:1.5b` in the README.
3. **Air-gapped mode:** provide `envil.suggest.modelPath` + a short doc
   explaining how to place the ONNX file manually; no network needed after
   that.
4. Keep the VSIX itself **under ~5 MB** — models live in user cache /
   Ollama, never in the extension.

Net effect: full offline capability, minimal repo bloat, no licensing
landmines.
