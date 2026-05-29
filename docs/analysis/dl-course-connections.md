# Deep Learning Course ↔ Envil Suggestions: Connections, Depth, Exercises

> Workspace: Envil VS Code extension (SuperCollider + Hydra live coding).
> Course: *ACLS Deep Learning*, ZHAW (Dr. M. Schüle), FS2026. Textbook: Chollet,
> *Deep Learning with Python* (2nd / 3rd ed.).
> Scope: maps your offline suggestion system onto the course topics, estimates
> exam depth, and gives practice exercises + solutions.

---

## Part 1 — Why the Envil plugin *is* the course (and should make you care)

You already built a small but honest-to-god deep-learning application. Every
capital-letter buzzword in the syllabus shows up concretely in the plugin. That
is rare — most students only meet these ideas as formulas. You can touch them.

### 1.1 The full stack, labelled with course weeks

The semester plan (`ACLS_DL_Course_Plan.pdf`) goes:

| Week | Date     | Topic                               | Envil touchpoint                                   |
|------|----------|-------------------------------------|----------------------------------------------------|
| 13   | 24.3     | Intro DL + CNN I                    | MLP fundamentals — same linear algebra used everywhere |
| 14   | 31.3     | Autoencoders + RNN I                | Autoencoders ≈ *embedding models* used for semantic RAG |
| 15   | 7.4      | RNN II                              | Sequence modelling — historical predecessor of the model you run |
| 16   | 14.4     | NLP I (tokenisation, text prep)     | Tokenisation literally lives in [suggestions/tokenize.js](../../suggestions/tokenize.js) |
| 17   | 21.4     | NLP II (embeddings)                 | Embeddings = next-upgrade-path for your BM25 retriever (Tier 2) |
| 18   | 28.4     | **Transformers I**                  | Qwen 2.5 Coder is literally a Transformer decoder    |
| 19   | 5.5      | **Transformers II**                 | Attention, positional encoding, KV cache — what Ollama runs |
| 20   | 12.5     | Pre-trained models / best practices | LoRA fine-tuning, quantisation (Q4_K_M), FIM training |
| 21   | 19.5     | Ethics / group work                 | Local models = privacy; corpus provenance; model cards |
| 22   | 26.5     | Group work discussion               | The plugin itself is textbook group-work material   |

This is not a coincidence. The course marches from MLP → CNN → RNN → NLP →
Transformers → pre-trained models, which is exactly the chronological lineage
of how we got to Qwen-Coder-3B sitting in your dock bar.

### 1.2 Things in the plugin you can point a finger at

- **Tokenisation** (week 16): `tokenize("SynthDef kick sine")` → `['synthdef','kick','sine']`
  in [tokenize.js](../../suggestions/tokenize.js). This is step 2 of the pipeline Chollet
  shows on slide "Text Preprocessing / Preprocessing Steps".
- **Vocabulary & indexing** (week 16): BM25 builds a `df` map (`this.df` in
  [bm25.js](../../suggestions/bm25.js)) — that *is* a vocabulary mapping terms
  to document statistics.
- **BM25 / TF-IDF** (week 17): the lexical retriever. Plain linear algebra,
  no learning. Good baseline.
- **Embeddings** (week 17, upgrade path): the planned Tier 2 swap from BM25 to
  `nomic-embed-text` or similar → cosine similarity in a learned vector space.
- **Decoder-only Transformer** (weeks 18–19): `qwen2.5-coder:3b-base`. 3 billion
  parameters, self-attention + FFN blocks × 36, RoPE positional encoding,
  SwiGLU activation.
- **Pre-training objective** (week 20): Qwen is pre-trained on trillions of
  tokens of code with a mix of standard next-token and **FIM (Fill-in-the-Middle)**
  objective — the same `<|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>` tokens
  my [ollama.js](../../suggestions/ollama.js) emits.
- **Transfer learning / fine-tuning** (week 20): LoRA is how you'd specialise
  Qwen on your jams corpus without retraining 3 B parameters.
- **Quantisation** (week 20): Q4_K_M turns 16-bit weights into 4-bit → 3 B × 4 bit ≈ 2 GB.
  Without this trick Ollama cannot fit alongside SuperCollider.
- **Ethics / privacy** (week 21): everything runs on `localhost:11434`. Your jams
  never leave the laptop. That is a *design decision* you can defend in the
  ethics week.

### 1.3 Motivation hooks

Tell yourself one of these every time you open the lecture slides:

1. **"The math on this slide is what Ollama runs 40 times per keystroke."**
   A `Ctrl+Alt+Space` completion fires ~200 forward passes through a
   36-layer Transformer. The attention matrix math you'll do by hand in the
   exam (Q6 / Q12 of the 2024 exam) is that same math at `d_model = 2048`.
2. **"Every exam question I solve is an ablation I could actually run."**
   Temperature sweep, embedding swap, LoRA rank — all wired into settings you
   already control.
3. **"My thesis project could be this, polished."** Group work in week 22 wants
   a presentable ML project. You already have one; the lecture content tells
   you how to describe it properly.

### 1.4 Concrete "next step after each week"

| Week topic        | 30-minute follow-up inside Envil                                     |
|-------------------|---------------------------------------------------------------------|
| CNN               | None directly (CNNs aren't in the audio-coding path) — but the same Conv2D code reads Chollet's MNIST example. |
| RNN / LSTM        | Read the `freq_lm.py` from week 6; compare to how Transformers beat it. |
| Tokenisation      | Open [tokenize.js](../../suggestions/tokenize.js), add a bigram option, re-run the BM25 smoke test. |
| Embeddings        | Add an `envil.suggestions.retriever = "embeddings"` mode that calls `/api/embeddings` on Ollama. |
| Transformers      | Write the attention formula on paper for one Envil prompt token. |
| Pre-trained models| Run one LoRA epoch on the corpus (QLoRA notebook, 30 min on a T4).  |
| Ethics            | Draft the data-provenance paragraph: whose SC code is in the corpus, under what licence. |

Bottom line: you don't need extra projects to practise the course. You have
this one.

---

## Part 2 — Session-by-session learning guide

This part walks through every session of the course in the order it was
delivered, plus the upcoming ones inferred from the plan + Chollet book. For
each topic you get:

- **Concept** — the 3-sentence essence.
- **Worked example** — numbers plugged in by hand.
- **Guided exercise** — a second small problem, walked through step by step so
  you learn the *procedure* (unlike Part 3, where you solve from scratch).
- **Envil tie-in** — where this same idea shows up in your SuperCollider plugin.

The exam-depth calibration that used to live here is kept as a short intro
(§ 2.0) so you know what "good enough" looks like while you read.

### 2.0 Intro: exam-depth calibration (read this first)

Evidence reviewed: `ACLS_DL_Course_Plan.pdf`, slides for weeks 13–22,
`DL_Exam_2024.pdf` (60 min, 13 Q, ~26 pts, formula sheet for sigmoid + MSE
at the back), `Online_Mock_Exam_Solutions.pdf` (45 min, 11 Q, ~17 pts — OCR
from handwritten solutions), `DL_Exam_2020_Solutions.pdf` (45 min, 13 Q, ~17
pts — same), Chollet 2E/3E.

**Observed exam patterns across the three papers:**

- **Every paper** asks at least one perceptron-design-by-hand question (NAND,
  NOR, classify (0,0,0) vs (1,1,1), separate 2D point clouds).
- **Every paper** has a convolution-with-tiny-kernel + max-pool by hand.
- **2 of 3** have a manual forward-pass / backprop / SGD-step problem.
- **2 of 3** ask about autoencoders (anomaly detection, image compression,
  limits of linear autoencoders).
- **2 of 3** ask to design / annotate an RNN (the 2020 "green-frog counter"
  even asks you to *invent the weights* for an RNN that counts events).
- **2 of 3** test word embeddings: pros vs one-hot, pre-trained pros/cons.
- **2024 only** has self-attention by hand and a Transformer concept question.
- **Recurring meta-skills:** PyTorch tensor indexing, code annotation, shape
  arithmetic in a CNN, cosine similarity, eigenvalue / PCA link.

| Question class                             | Time  | Seen in            | What's actually tested                                   |
|--------------------------------------------|-------|--------------------|----------------------------------------------------------|
| Biological neuron ↔ perceptron motivation  | 2 min | 2024, 2020         | 2–3 bullet differences / mapping                         |
| "Design a perceptron for NAND/OR/NOR"      | 3 min | 2024, mock, 2020   | integer weights, check truth table                       |
| Cosine similarity, 3D vectors              | 3 min | 2024               | dot product / product of norms                           |
| Eigenvalues of 2×2 matrix                  | 3 min | mock               | $\det(A - \lambda I) = 0$, factor quadratic              |
| PyTorch tensor slicing `t[i, j, :]`        | 2 min | 2024               | read 3-D nested tensor, give row                         |
| Full FNN forward + MSE + one SGD step      | 10 min| 2024, 2020         | 2-layer sigmoid, $\eta$ given, ~3 numbers to compute     |
| Convolution + max-pool by hand             | 6 min | 2024, mock, 2020   | small input × 2×2 kernel, padding/stride spec varies     |
| Conv / autoencoder code-bug fix            | 3 min | 2020               | spot wrong arg, units, loss; rewrite the line            |
| Concept (batch-norm, dropout, autoencoder) | 3 min | 2024, mock         | 3–5 sentences, formula if natural                        |
| CNN shape fill-the-blank `Linear(?, n)`    | 4 min | 2024               | output size after conv/pool stack                        |
| RNN: list dataset hyperparameters          | 3 min | 2024               | window len, stride, split, batch, normalisation, ...     |
| RNN: design tiny one by hand               | 4 min | 2020               | choose weights so output counts / mirrors / sums         |
| Word-embedding pros vs one-hot             | 2 min | mock, 2020         | density, semantic similarity, pretrained transfer        |
| Attention $\text{softmax}(QK^\top/\sqrt d)V$ | 6 min | 2024            | 2×2 / 3×2 matrix multiply, softmax by hand              |
| Self-attention pros/cons                   | 3 min | 2024               | parallelism + range vs $O(n^2)$ + no order               |
| Architecture choice for a dataset image    | 3 min | mock, 2020         | pick #inputs, #hidden, #outputs, activations, loss       |
| Ethics / DL-vs-conventional, GAN forgery   | 2 min | 2020, week 21      | one-liner pro/con, name the right model family           |

**Three-rule cheat sheet:**

1. **Formulas** — know each formula well enough to apply it to a 2×2 / 3×3
   numeric example by hand without notes.
2. **Shapes** — know channel-and-spatial arithmetic well enough to spot the
   bug in 30 lines of PyTorch (`Conv2d → MaxPool2d → Linear(?, n)`).
3. **Concepts** — each concept = a 3-sentence answer, plus *one* concrete
   example. No more.

**Predicted blueprint for FS2026** (~26 pts, 60 min, mirrors 2024 but with the
second Transformer week now folded in):

- ~6 pts: perceptron / FNN forward+backward (mandatory every year)
- ~4 pts: CNN — conv-by-hand *and* shape fill-the-blank
- ~3 pts: regularisation / batch norm / dropout (concept)
- ~3 pts: autoencoder — anomaly detection or code bug-fix
- ~3 pts: RNN/LSTM — hyperparameters, gate roles, or design-by-hand
- ~4 pts: Transformer — attention matrix problem + one concept
- ~3 pts: NLP — tokenisation, embeddings, cosine similarity
- ~1–2 pts: ethics / pre-trained model use / hallucination

≈ 26 points, 60 min, same shape as 2024.

---

### 2.0.1 Math toolkit — the seven things you must do by hand

Every one of these has appeared on at least one of the three papers. Practise
them until each takes < 90 seconds.

#### (a) Cosine similarity (2024-Q2)

$$
\cos(a, b) = \frac{a \cdot b}{\|a\| \, \|b\|}.
$$

*Worked.* $a = (1,1,0)$, $b = (0,1,1)$.
Dot $= 0 + 1 + 0 = 1$. $\|a\| = \|b\| = \sqrt 2$. $\cos = 1/2 = 0.5$.

Gotchas: zero vector → undefined. Use the *unnormalised* dot for raw
attention scores; cosine for similarity reporting.

#### (b) Eigenvalues of a 2×2 (mock-Q2)

- Characteristic polynomial: $\det(A - \lambda I) = 0$.
- For $A = \begin{pmatrix} a & b \\ c & d \end{pmatrix}$:
  $\lambda^2 - (a + d)\lambda + (ad - bc) = 0$.
- Solve with the quadratic formula or by inspection.

*Worked.* $A = \begin{pmatrix} 1 & -2 \\ -2 & 1 \end{pmatrix}$.
$\text{tr} = 2$, $\det = 1 - 4 = -3$.
$\lambda^2 - 2\lambda - 3 = 0 \Rightarrow (\lambda - 3)(\lambda + 1) = 0$
→ $\lambda_1 = 3$, $\lambda_2 = -1$.

#### (c) PCA in one breath (2020-Q4)

- Centre data → covariance matrix $C = \tfrac1n X^\top X$.
- **Eigendecomposition** of $C$: $C = U \Lambda U^\top$.
- Columns of $U$ are **principal components** (orthonormal directions of
  variance). Eigenvalues $\lambda_i$ on the diagonal = amount of variance
  captured by each PC.
- Project onto top $k$ PCs to reduce dimension.
- A **linear autoencoder** with bottleneck $k$ and MSE loss converges to the
  same subspace PCA finds. PCA = closed-form linear AE.

#### (d) PyTorch tensor indexing (2024-Q3)

Think of a tensor as nested lists. `t[i, j, k]` selects depth-$i$ block,
row-$j$, column-$k$. A `:` selects the whole axis.

*Worked.* `t.shape = (3, 2, 3)`, values
$\big[[[1,2,3],[4,5,6]], [[7,8,9],[10,11,12]], [[13,14,15],[16,17,18]]\big]$.
- `t[0, 1, :]` → block 0, row 1, all cols → `[4, 5, 6]`.
- `t[:, 0, 0]` → first element of each block → `[1, 7, 13]`.
- `t[1, :, 2]` → last column of block 1 → `[9, 12]`.

Rule: write the shape, count `:` axes → result has that many dims.

#### (e) Softmax of a small vector

$$\text{softmax}(z)_i = \frac{e^{z_i}}{\sum_j e^{z_j}}.$$

- Subtract $\max(z)$ from all entries first (numerical stability, doesn't
  change the output).
- For $z = (1, 0)$: $(e/(e+1),\ 1/(e+1)) \approx (0.731,\ 0.269)$.
- For $z = (2, 2)$: equal logits → $(0.5, 0.5)$.
- For $z = (a, a, a)$: uniform $(1/3, 1/3, 1/3)$ regardless of $a$.

#### (f) CNN shape arithmetic (2024-Q8)

For each conv/pool:
$$H_{\text{out}} = \left\lfloor \frac{H_{\text{in}} + 2p - k}{s} \right\rfloor + 1.$$

Walk through every layer, write the running $(C, H, W)$ to the right.
Flattened size before `Linear(?, n)` is $C \cdot H \cdot W$.

*Worked (drill).* Input $(3, 28, 28)$ → `Conv2d(3, 64, k=3, p=1)` →
$(64, 28, 28)$. MaxPool2d(2) → $(64, 14, 14)$. `Conv2d(64, 32, k=3, p=1)`
→ $(32, 14, 14)$. MaxPool2d(2) → $(32, 7, 7)$. Flatten = $32 \cdot 7 \cdot 7
= 1568$. → `nn.Linear(1568, 32)`.

#### (g) One backprop step "in your head" with sigmoid + MSE

Reusable recipe (matches 2024-Q5 and 2020-Q6):

1. Forward: compute $z^{(l)} = W^{(l)} a^{(l-1)}$, $a^{(l)} = \sigma(z^{(l)})$.
2. Output error: $\delta^{(L)} = (\hat y - y) \cdot \sigma'(z^{(L)}) = (\hat y - y) \hat y (1 - \hat y)$.
3. Hidden error: $\delta^{(l)} = (W^{(l+1)\top} \delta^{(l+1)}) \odot \sigma'(z^{(l)})$.
4. Weight gradient: $\nabla W^{(l)} = \delta^{(l)} (a^{(l-1)})^\top$.
5. Update: $W^{(l)} \leftarrow W^{(l)} - \eta \nabla W^{(l)}$.

Keep $(\hat y - y)$ and $\sigma'(z)$ factored; *do not* multiply them out
before you know which weights you're updating — you'll need them again
upstream.

---

### 2.0.2 Pattern bank — the exam in 12 reusable answers

If you can answer all 12 of these in your sleep, you're at exam pace.

1. *"Three differences biological neuron vs perceptron"*: continuous firing
   rate vs binary spike train; weighted sum vs dendritic temporal integration;
   learned by gradient descent vs Hebbian plasticity; activation function vs
   action-potential threshold dynamics.
2. *"Cosine similarity of $a$ and $b$"*: $a \cdot b / (\|a\|\|b\|)$, divide.
3. *"Eigenvalues of 2×2 $A$"*: solve $\lambda^2 - \text{tr}(A)\lambda + \det(A) = 0$.
4. *"NAND/NOR/AND/OR perceptron"*: see boolean-gate table in §2.1.1.
5. *"Forward pass + SGD step"*: layer-by-layer pass, MSE derivative, recipe (g).
6. *"Convolution + max-pool"*: write the kernel positions on graph paper.
7. *"Batch norm"*: per-batch normalise then affine $\gamma\hat x + \beta$, three benefits.
8. *"Autoencoder for anomaly detection"*: train on normal, threshold on reconstruction error.
9. *"RNN dataset hyperparameters"*: window len, stride, horizon, split, batch, norm.
10. *"PyTorch model annotation"*: name each layer's I/O shape, then state the task.
11. *"Attention by hand"*: $QK^\top$, divide $\sqrt{d_k}$, softmax rowwise, multiply $V$.
12. *"Self-attention pros/cons"*: parallelism + range; $O(n^2)$ + needs PE.

---

### 2.1 Week 13 (24.3) — Introduction to Deep Learning & CNN I

**Sub-topics delivered** (from `MLP_CNN_recap_ACLS.pdf`, `CNN_1_ACLS.pdf`):
perceptron recap, FNN with sigmoid/ReLU, loss functions (MSE, cross-entropy),
gradient descent, intro to 2D convolution, padding + stride, pooling layers.

Code files delivered: `MNIST_FNN_torch.py`, `housing_FNN_torch.py`,
`iris_FNN_torch.py`, `iris_multiperceptron.py`, `simple_CNN_torch.py`,
`conv_pool_layer_torch.py`, `structured_data_classification_torch.py`.

#### 2.1.1 Perceptron & MLP — the atom

**Boolean-gate design quick-table** (memorise; appears on every exam):

| Gate | $w_1$ | $w_2$ | $b$ | Truth check |
|------|------:|------:|----:|-------------|
| AND  | 1     | 1     | $-1.5$ | only $(1,1) \to 0.5 > 0 \to 1$ |
| OR   | 1     | 1     | $-0.5$ | $(0,0) \to -0.5 \to 0$; rest positive |
| NAND | $-1$  | $-1$  | $1.5$  | $(1,1) \to -0.5 \to 0$; rest positive |
| NOR  | $-1$  | $-1$  | $0.5$  | only $(0,0) \to 0.5 \to 1$ |
| NOT $x_1$ | $-1$ | 0 | $0.5$ | $x_1 = 0 \to 0.5 \to 1$; $x_1 = 1 \to -0.5 \to 0$ |
| XOR  | — | — | — | **not linearly separable** — needs an MLP (1 hidden layer with 2 units) |

Rule of thumb: write $w = \pm 1$, then pick $b$ so the *only* truth row that
should fire lands just above zero. Threshold activation $\sigma(z) = [z \ge 0]$
is the exam default unless sigmoid is given.

*Why XOR matters.* Minsky & Papert 1969 used it to show perceptrons can't
separate non-linearly. The fix — stack two perceptrons — is the historical
origin of MLPs and the whole DL field.

**Concept.** A perceptron computes $y = \sigma(w^\top x + b)$ where $\sigma$ is
a non-linear activation (step, sigmoid, ReLU). Stacking layers of perceptrons
with non-linear activations lets the network approximate non-linear functions
(universal-approximation theorem). Without non-linearity the whole stack
collapses to a single linear map.

**Worked example: AND gate.**
Pick $w = (1, 1)$, $b = -1.5$, step activation.

| $x_1$ | $x_2$ | $z = w^\top x + b$ | $\sigma(z)$ |
|:---:|:---:|:---:|:---:|
| 0 | 0 | −1.5 | 0 |
| 1 | 0 | −0.5 | 0 |
| 0 | 1 | −0.5 | 0 |
| 1 | 1 |  0.5 | 1 |

✔ AND implemented.

**Guided exercise: NOR gate.**

> *Design a perceptron computing NOR (output 1 iff both inputs are 0).*

Step 1 — write out the truth table you want to match:

| $x_1$ | $x_2$ | target |
|:---:|:---:|:---:|
| 0 | 0 | 1 |
| 1 | 0 | 0 |
| 0 | 1 | 0 |
| 1 | 1 | 0 |

Step 2 — ask: "what's the decision boundary?" We want $z \ge 0$ only for
$(0,0)$. So $z = b$ must be $\ge 0$ for the first row, and $z < 0$ otherwise.

Step 3 — set $b = 0.5$ (so $z = 0.5 \ge 0$ for $(0,0)$ ✔), and pick negative
weights so adding any $x_i = 1$ pushes $z$ below zero. Try $w_1 = w_2 = -1$.

Step 4 — verify on the remaining rows:
- $(1,0): -1 + 0 + 0.5 = -0.5 < 0 \to 0$ ✔
- $(0,1): 0 - 1 + 0.5 = -0.5 < 0 \to 0$ ✔
- $(1,1): -1 - 1 + 0.5 = -1.5 < 0 \to 0$ ✔

**Answer:** $w = (-1, -1)$, $b = 0.5$.

**Envil tie-in.** Same principle lives under the hood of every gate in
qwen-coder's MLP blocks. Concretely, in [bm25.js](../../suggestions/bm25.js)
the decision "is this term in doc $i$?" is a linear threshold — the simplest
possible perceptron, no training required, and it's what gates whether the
term contributes to the score.

#### 2.1.2 Activation functions

**Concept.** Without a non-linearity, $y = W_2(W_1 x) = (W_2 W_1) x$ collapses
to one matrix. The non-linear activation breaks that collapse.

- **Sigmoid** $\sigma(z) = 1/(1+e^{-z})$, derivative $\sigma'(z) = \sigma(z)(1-\sigma(z))$.
  Outputs in $(0,1)$. Problem: saturates for large $|z|$ → vanishing gradient.
- **Tanh**: symmetric sigmoid in $(-1, 1)$. Same saturation problem.
- **ReLU** $\max(0, z)$. No saturation on the positive side, cheap, default
  for hidden layers in CNNs/FNNs.
- **Softmax** (output layer, multi-class): $p_i = e^{z_i}/\sum_j e^{z_j}$.

**Worked example.** $z = -0.5$: $\sigma(z) = 1/(1 + e^{0.5}) \approx 1/2.6487
\approx 0.3775$. $\sigma'(z) = 0.3775 \cdot 0.6225 \approx 0.2350$. Notice the
derivative peaks at $0.25$ when $z = 0$ and shrinks quickly — this is why deep
sigmoid stacks hurt.

**Guided exercise.** Given $z = (1, 2, -1)$, compute $\mathrm{softmax}(z)$.

Step 1 — for numerical stability subtract the max: $z' = z - \max(z) = (-1, 0, -3)$.
Step 2 — exponentiate: $(e^{-1}, e^{0}, e^{-3}) \approx (0.368, 1.000, 0.050)$.
Step 3 — sum: $0.368 + 1.000 + 0.050 = 1.418$.
Step 4 — divide: $(0.259, 0.705, 0.035)$. Check: sums to 1. ✔

**Envil tie-in.** When the LLM generates the next token, the last layer
outputs logits over ~150 000 vocabulary entries, softmax turns them into a
probability distribution, and `temperature` in [ollama.js](../../suggestions/ollama.js)
scales the logits *before* the softmax: $p_i = \mathrm{softmax}(z_i / T)$.
$T \to 0$: argmax (deterministic). $T \to 1$: nominal. $T > 1$: flatter dist,
more variety.

#### 2.1.3 Loss functions

**Concept.** The loss $\mathcal{L}(y, \hat y)$ measures how wrong the prediction
is. Training = minimising $\mathbb{E}_{(x,y)} \mathcal{L}(y, f_\theta(x))$ via
gradient descent.

- **MSE** (regression): $\tfrac12 (y - \hat y)^2$. Gradient w.r.t. $\hat y$
  is simply $(\hat y - y)$.
- **Binary cross-entropy**: $-[y \log \hat y + (1-y)\log(1-\hat y)]$ with $\hat y$
  from a sigmoid. Combined with sigmoid the gradient also simplifies to $(\hat y - y)$.
- **Categorical cross-entropy**: $-\sum_i y_i \log \hat y_i$ with softmax output.

**Worked example.** $y = 1$, $\hat y = 0.8$.
- MSE: $\tfrac12 (1 - 0.8)^2 = 0.02$.
- BCE: $-[1 \cdot \log 0.8 + 0 \cdot \log 0.2] = -\log 0.8 \approx 0.223$.
Cross-entropy punishes confident wrong answers much harder than MSE does —
that's why it's preferred for classification.

**Guided exercise.** You predict $\hat y = 0.1$ for true $y = 1$. Compute MSE,
BCE, and their gradients w.r.t. $\hat y$.

Step 1 — MSE: $\tfrac12 (1-0.1)^2 = 0.405$.
Step 2 — BCE: $-\log 0.1 \approx 2.303$. Five-times higher than MSE in the same
situation.
Step 3 — $\partial \text{MSE}/\partial \hat y = \hat y - y = -0.9$.
Step 4 — $\partial \text{BCE}/\partial \hat y = -1/\hat y = -10$.
BCE's gradient **explodes** near the wrong extreme → fast learning signal.

**Envil tie-in.** The perplexity reported when you evaluate a language model
is $e^{\text{BCE}}$. Lower perplexity on your SC corpus means the model is
less "surprised" by your code style — a direct number to optimise toward
with fine-tuning.

#### 2.1.4 Gradient descent & backprop

**Concept.** Update rule: $\theta \leftarrow \theta - \eta \nabla_\theta \mathcal{L}$.
Backprop is just the chain rule applied through the computation graph.

**Worked example: one weight.**
$\mathcal{L} = \tfrac12(\hat y - y)^2$, $\hat y = \sigma(w x)$, $x=1, y=0.5, w=0.5$.

$\hat y = \sigma(0.5) \approx 0.6225$. $\mathcal{L} \approx 0.0075$.
$\frac{\partial \mathcal{L}}{\partial w} = (\hat y - y) \cdot \sigma'(wx) \cdot x
= 0.1225 \cdot 0.2350 \cdot 1 \approx 0.0288$.
With $\eta = 1$: $w \leftarrow 0.5 - 0.0288 \approx 0.4712$.

**Guided exercise.** Same setup, but after one update compute the new loss.
Does it go down?

Step 1 — new $\hat y = \sigma(0.4712) \approx 0.6157$.
Step 2 — new $\mathcal{L} = \tfrac12 (0.6157 - 0.5)^2 \approx 0.00669$.
Step 3 — 0.00669 < 0.0075 ✔. Loss decreased → direction was correct.

**Envil tie-in.** The entire LoRA fine-tuning path in the Tier-3 plan of §1
runs this exact update on ~200 million adapter parameters for ~3 hours; the
math on one weight is the same as on 200 million.

#### 2.1.5 2D convolution, padding, stride

**Concept.** A conv layer slides a small filter $K$ of shape $(k_h, k_w)$
across the input with a given **stride** $s$ and **padding** $p$; output
spatial size is

$$
H_{\text{out}} = \left\lfloor \tfrac{H_{\text{in}} + 2p - k_h}{s} \right\rfloor + 1.
$$

**Worked example.** Input $3\times 3$:
$X = \begin{pmatrix} 1&2&0\\1&1&0\\0&2&1 \end{pmatrix}$,
kernel $K = \begin{pmatrix} 1&0\\0&-1 \end{pmatrix}$, valid convolution
(no padding, stride 1). Output size $= (3-2)/1 + 1 = 2$, so $2\times 2$:

- $(0,0)$: $1\cdot 1 + 2\cdot 0 + 1\cdot 0 + 1\cdot(-1) = 0$
- $(0,1)$: $2\cdot 1 + 0\cdot 0 + 1\cdot 0 + 0\cdot(-1) = 2$
- $(1,0)$: $1\cdot 1 + 1\cdot 0 + 0\cdot 0 + 2\cdot(-1) = -1$
- $(1,1)$: $1\cdot 1 + 0\cdot 0 + 2\cdot 0 + 1\cdot(-1) = 0$

Output: $\begin{pmatrix} 0 & 2 \\ -1 & 0 \end{pmatrix}$.

**Guided exercise.** Same $X$, same $K$, **stride 2**, no padding.
Output size $= (3-2)/2 + 1 = 1$ → 1×1. Only the top-left window gets evaluated:
$0$. Output: $\begin{pmatrix} 0 \end{pmatrix}$.

**Envil tie-in.** Convolution isn't in the SC audio path right now, but your
spectrograms (`20260219_spectrogram.scd` in the band repo) are 2D, and if you
wanted to train an audio-event classifier on them this is exactly the
operation.

#### 2.1.6 Pooling

- Down-samples each feature map → smaller spatial size, more receptive field per pixel later.
- **Max-pool**: take max over each window. Translation-invariant, sharp.
- **Avg-pool**: mean. Smoother, used in some classification heads.
- Output size: $\lfloor (H_{\text{in}} - k)/s \rfloor + 1$ (no padding).
- No learnable parameters.

*Worked.* Input $(64,28,28)$, MaxPool2d(2) → $(64,14,14)$.

*Guided.* Input $(32,30,30)$ through MaxPool2d(3, stride=2): $\lfloor (30-3)/2 \rfloor + 1 = 14$ → $(32,14,14)$.

#### 2.1.7 Weight initialisation

- Bad init → exploding/vanishing activations from layer 1.
- **Xavier/Glorot** (sigmoid/tanh): $\text{Var}(W) = 2/(n_{\text{in}} + n_{\text{out}})$.
- **He** (ReLU): $\text{Var}(W) = 2/n_{\text{in}}$. Larger because ReLU kills half the activations.
- PyTorch defaults: He for `nn.Linear`/`nn.Conv2d`.

*Envil tie-in.* Mentioned in 2024-Q11 source: `nn.init.xavier_uniform_(self.embedding.weight)` — Xavier on the embedding matrix is a common pattern.

#### 2.1.8 FNN architecture knobs

- **Depth** (more layers): more abstraction, harder to train.
- **Width** (more units/layer): more capacity, more parameters.
- **Activation**: ReLU for hidden, sigmoid/softmax for output (task-dep).
- **Output units**: 1 + sigmoid (binary), $C$ + softmax (multi-class), $1$ linear (regression).
- **Loss**: BCE / CE / MSE matching the above.

#### Quick-ref card — Week 13

| Concept | Formula / shape rule | Default value |
|---|---|---|
| Sigmoid | $1/(1+e^{-z})$, $\sigma' = \sigma(1-\sigma)$ | — |
| ReLU | $\max(0, z)$ | hidden layers |
| Softmax | $e^{z_i}/\sum_j e^{z_j}$ | output multi-class |
| MSE | $\tfrac12(y-\hat y)^2$ | regression |
| BCE | $-y\log\hat y - (1-y)\log(1-\hat y)$ | binary class |
| Conv output | $\lfloor (H + 2p - k)/s \rfloor + 1$ | — |
| Pool output | $\lfloor (H - k)/s \rfloor + 1$ | — |
| He init Var | $2/n_{\text{in}}$ | ReLU layers |
| SGD step | $\theta \leftarrow \theta - \eta \nabla \mathcal L$ | $\eta = 10^{-3}$ |

---

### 2.2 Week 14 (31.3) — Autoencoders & Recurrent NNs I

**Sub-topics delivered** (from `CNN_2_ACLS.pdf`): AlexNet/VGG, Inception, data
augmentation, transfer learning, batch norm, ResNets. *Autoencoders proper*
aren't in the week-14 slides but are referenced (and were Q9 of the 2024 exam).

#### 2.2.1 Batch normalisation

**Concept.** For each mini-batch and each activation channel, normalise:

$$
\hat x = \frac{x - \mu_B}{\sqrt{\sigma_B^2 + \epsilon}}, \quad y = \gamma \hat x + \beta
$$

where $\gamma, \beta$ are learnable. Placed after the linear op, before the
non-linearity (for FNNs/CNNs).

**Why it helps.** Reduces "internal covariate shift" (downstream layers see
roughly stationary statistics), allows higher learning rates, adds mild
regularisation.

**Worked example.** Batch activations (one feature): $(1, 3, 5, 7)$.
$\mu = 4$, $\sigma^2 = 5$, $\sigma \approx 2.236$.
$\hat x \approx (-1.342, -0.447, 0.447, 1.342)$. With $\gamma=1, \beta=0$ (initial),
output = $\hat x$.

**Guided exercise.** Same batch, but $\gamma=2, \beta=1$. Compute $y$.

Step 1 — normalise: $(-1.342, -0.447, 0.447, 1.342)$ (as above).
Step 2 — scale: $(-2.684, -0.894, 0.894, 2.684)$.
Step 3 — shift: $(-1.684, 0.106, 1.894, 3.684)$.

**Envil tie-in.** Transformer blocks use **LayerNorm** (same idea, but
normalising across features for a single token, not across the batch) before
each attention/FFN sub-layer. This is why qwen-coder trains stably at
2048-d embedding size.

#### 2.2.2 Transfer learning

**Concept.** Take a network pre-trained on a huge dataset (ImageNet for CNNs,
trillion-token crawl for LLMs), replace the last layer with a task-specific
head, and either (a) freeze all earlier layers and train only the head
(*feature extraction*) or (b) allow some/all earlier layers to update with a
lower learning rate (*fine-tuning*).

**Envil tie-in.** This is *exactly* the Tier-3 path of §1: Qwen is pre-trained
on code; LoRA adapters are the specialised head + a few extra low-rank updates
inside the attention matrices.

#### 2.2.3 Classic CNN architectures (one-line each)

- **LeNet-5** (1998): conv-pool-conv-pool-fc-fc, MNIST. The blueprint.
- **AlexNet** (2012): 8 layers, ReLU, dropout, GPU training. Ignited the DL boom.
- **VGG-16/19** (2014): only 3×3 convs stacked deep. Simple, parameter-heavy.
- **Inception/GoogLeNet** (2014): parallel 1×1, 3×3, 5×5 convs in one block; 1×1 convs for cheap channel mixing.
- **ResNet** (2015): residual connections $y = F(x) + x$. Lets you train 100+ layers without vanishing gradients.
- **DenseNet** (2017): each layer sees concatenated outputs of all previous layers.

#### 2.2.4 Residual connection — the trick that scales

- Block: $y = F(x; \theta) + x$. Identity path bypasses the learned function.
- Gradient: $\partial \mathcal L / \partial x = \partial \mathcal L / \partial y \cdot (1 + \partial F / \partial x)$. The `+1` keeps gradient signal alive even if $\partial F / \partial x$ vanishes.
- Used in: ResNet, every Transformer block (incl. qwen-coder).

#### 2.2.5 Dropout

- During training: zero each activation with prob $p$, scale survivors by $1/(1-p)$.
- At inference: identity (no dropout, no scaling).
- Acts as ensemble of $2^N$ thinned subnetworks.
- Typical $p$: 0.1–0.5. PyTorch: `nn.Dropout(p=0.3)`.
- Not used inside Transformer attention as much these days (replaced by good regularisation via scale).

*Worked.* Activation $a = 4$, $p = 0.5$. Training: with prob 0.5 → 0; with prob 0.5 → $4 / 0.5 = 8$. Expectation $= 4$ (preserved).

#### 2.2.6 Data augmentation

- Cheap regulariser: random crop, flip, rotation, colour jitter, mixup, cutout.
- Audio analog: time-stretch, pitch-shift, additive noise, SpecAugment (mask freq/time bins on a spectrogram).
- Always applied to **training set only**, never to val/test.

*Envil tie-in.* For LoRA training on your SC corpus, augmentation = random FIM split points (cut blocks at different positions) → multiplies effective dataset 5–10×.

#### 2.2.7 Autoencoder (exam topic)

**Concept.** Encoder $E: \mathbb{R}^d \to \mathbb{R}^k$ with $k \ll d$, decoder
$D: \mathbb{R}^k \to \mathbb{R}^d$. Loss $\| x - D(E(x)) \|^2$. Learns a
compressed bottleneck representation.

**Anomaly detection recipe.** Train only on normal data. At test time, compute
reconstruction error; if it exceeds a threshold, flag as anomaly (the decoder
has never learned to reproduce that thing).

**Guided exercise.** Sketch the shapes for an autoencoder of 28×28 MNIST
images with bottleneck 16.
- Input $(B, 1, 28, 28)$ → flatten $(B, 784)$.
- Encoder: `Linear(784, 128) → ReLU → Linear(128, 16)` → bottleneck $(B, 16)$.
- Decoder: `Linear(16, 128) → ReLU → Linear(128, 784) → Sigmoid` → $(B, 784)$.
- Reshape to $(B, 1, 28, 28)$. Loss: MSE between input and reconstruction.

**Envil tie-in.** A *text* autoencoder is almost what a sentence-embedding
model is (encoder half only, trained with contrastive not reconstructive
loss). Upgrading Envil's retriever from BM25 to embeddings is spiritually the
same move.

#### 2.2.8 GANs (briefly — appeared on 2020 exam)

- Two networks playing a minimax game:
  - **Generator** $G$ maps random noise $z \sim \mathcal{N}(0, I)$ to fake samples $G(z)$.
  - **Discriminator** $D$ tries to tell real $x$ from fake $G(z)$.
- Loss: $\min_G \max_D \mathbb{E}_x[\log D(x)] + \mathbb{E}_z[\log(1 - D(G(z)))]$.
- At equilibrium $D = 0.5$ everywhere → $G$ has matched the data distribution.
- **Use cases:** image synthesis, super-resolution, **handwriting forgery**
  (2020-Q9), deepfakes, audio synthesis (WaveGAN, GAN-based vocoders).
- **Pitfalls:** mode collapse (G covers only part of the data), training
  instability. Largely superseded by **diffusion models** for image
  generation, but still appears on exams as a representative *generative*
  architecture.
- **Sketch of a forgery setup** (model answer pattern):
  1. Collect dataset of the victim's handwriting samples (1000+ images).
  2. Train conditional GAN: $G(z, \text{target text}) \to$ handwriting image.
  3. Discriminator scores realism + style match against the dataset.
  4. Inference: provide forgery text + sampled noise → generate image.

#### Quick-ref card — Week 14

| Concept | Key fact |
|---|---|
| BatchNorm | normalise per-batch, then $\gamma\hat x + \beta$ |
| LayerNorm | normalise per-token (used in Transformers) |
| Dropout | training only; scale survivors by $1/(1-p)$ |
| Residual | $y = F(x) + x$; gradient gains a `+1` |
| Transfer learning | freeze base, train head, optionally unfreeze later with low lr |
| Augmentation | training set only, virtually multiplies data |
| Autoencoder | $\|x - D(E(x))\|^2$; bottleneck $k \ll d$ |
| Anomaly via AE | high reconstruction error → anomaly |

---

### 2.3 Week 15 (7.4) — Recurrent NN II

**Sub-topics** (from `Chapter_5_DL_ACLS.pdf`): sequential data, time series,
simple RNN cell, backprop through time, vanishing gradient, LSTM, GRU.

Code: `simple_RNN_torch.py`, `simple_time_series_forecasting_torch.py`.

#### 2.3.1 Simple RNN cell

**Concept.** A hidden state $h_t$ depends on previous state + current input:

$$
h_t = \tanh(W_{xh} x_t + W_{hh} h_{t-1} + b_h), \quad y_t = W_{hy} h_t + b_y.
$$

Unrolled over time, backprop becomes **backprop through time** (BPTT) — the
same chain rule, but multiplied $T$ times; gradient magnitudes tend to 0 or
infinity.

**Worked example.** $x_1 = 1$, $x_2 = 2$, $W_{xh} = 0.5$, $W_{hh} = 0.5$, $b_h=0$,
$h_0 = 0$, and use **linear** activation (to keep arithmetic clean).

$h_1 = 0.5 \cdot 1 + 0.5 \cdot 0 = 0.5$.
$h_2 = 0.5 \cdot 2 + 0.5 \cdot 0.5 = 1.25$.

**Guided exercise.** Extend to $x_3 = 3$ with the same weights.

Step 1 — apply recurrence: $h_3 = 0.5 \cdot 3 + 0.5 \cdot h_2 = 1.5 + 0.625 = 2.125$.
Step 2 — observation: each step's contribution persists with a decay factor of
$0.5$. In real RNNs this decay ($<1$) destroys long-range gradients.

**Envil tie-in.** Decoder-only Transformers replaced RNNs for language precisely
because attention offers $O(1)$ "hops" between any two positions, while an RNN
needs $T$ hops. Your Qwen model sees the whole prefix in one shot — no BPTT.

#### 2.3.2 LSTM gates

**Concept.** LSTM adds a **cell state** $c_t$ (long-term memory) alongside
$h_t$, and three gates that decide what to forget/write/read:

$$
\begin{aligned}
f_t &= \sigma(W_f [h_{t-1}, x_t] + b_f) & \text{forget gate} \\
i_t &= \sigma(W_i [h_{t-1}, x_t] + b_i) & \text{input gate} \\
\tilde c_t &= \tanh(W_c [h_{t-1}, x_t] + b_c) & \text{candidate} \\
c_t &= f_t \odot c_{t-1} + i_t \odot \tilde c_t & \text{new cell state} \\
o_t &= \sigma(W_o [h_{t-1}, x_t] + b_o) & \text{output gate} \\
h_t &= o_t \odot \tanh(c_t) &
\end{aligned}
$$

$\odot$ is element-wise multiply. The additive update $f_t \odot c_{t-1} + \ldots$
is the trick that lets gradients flow across many steps.

**Worked example** (scalars): $c_{t-1} = 2$, $f_t = 0.9$, $i_t = 0.3$, $\tilde c_t = 1$.
$c_t = 0.9 \cdot 2 + 0.3 \cdot 1 = 2.1$. Cell state kept almost all of the past
and nudged slightly by the new candidate.

**Guided exercise.** Same $c_{t-1}$, $\tilde c_t$, but $f_t = 0.1$, $i_t = 0.8$.

Step 1 — forget almost everything: $0.1 \cdot 2 = 0.2$.
Step 2 — write new: $0.8 \cdot 1 = 0.8$.
Step 3 — $c_t = 1.0$. Interpretation: network decided the old memory was no
longer relevant and has mostly replaced it.

**Envil tie-in.** The `sentiment_classification_LSTM_torch.ipynb` delivered in
week 6 is a direct Envil-adjacent experiment: train it on SuperCollider
comments (`// loud`, `// mellow`) to classify block *mood*, then boost BM25
rankings by matching mood tags. Real project idea.

#### 2.3.3 Sequential data taxonomy

- **One-to-one**: image classification (no time dim).
- **One-to-many**: image captioning (one img → sentence).
- **Many-to-one**: sentiment classification, time-series → next-value.
- **Many-to-many (aligned)**: POS tagging, frame-by-frame.
- **Many-to-many (seq2seq)**: translation, summarisation.

*Envil context.* Live-coding completion is **many-to-one** at the token level (read 1000 tokens → emit one) repeated thousands of times.

#### 2.3.4 Vanishing/exploding gradient — by number

- BPTT through $T$ steps multiplies $T$ Jacobians.
- If each Jacobian has spectral norm $\rho$: gradient magnitude scales as $\rho^T$.
- $\rho = 0.9$, $T = 50$: $0.9^{50} \approx 0.005$ → vanish.
- $\rho = 1.1$, $T = 50$: $1.1^{50} \approx 117$ → explode.
- LSTM's additive cell-state update keeps the *effective* $\rho$ near 1 along the cell-state path.

#### 2.3.5 GRU (Gated Recurrent Unit)

- Simpler than LSTM: 2 gates instead of 3, no separate cell state.
- $z_t$ (update gate), $r_t$ (reset gate).
- $h_t = (1 - z_t) \odot h_{t-1} + z_t \odot \tilde h_t$.
- Comparable performance to LSTM on most tasks, ~25% fewer parameters.

#### 2.3.6 1D conv for sequences (alternative to RNN)

- Slide a 1D kernel along time axis.
- Parallelisable (no recurrence) → fast on GPU.
- Receptive field grows linearly with depth (use dilations to grow exponentially → WaveNet).
- Replaced by attention for most NLP, still strong for audio (raw waveform models).

#### Quick-ref card — Week 15

| Concept | Formula / fact |
|---|---|
| RNN cell | $h_t = \tanh(W_{xh}x_t + W_{hh}h_{t-1} + b)$ |
| Vanishing | grad $\sim \rho^T$, $\rho < 1$ |
| LSTM gates | forget $f$, input $i$, output $o$; cell state $c$ |
| LSTM update | $c_t = f \odot c_{t-1} + i \odot \tilde c_t$ |
| GRU gates | update $z$, reset $r$ (no cell state) |
| Use case | seq → seq with order matters and length varies |

---

### 2.4 Week 16 (14.4) — NLP I: text preprocessing

**Sub-topics** (from `Chapter_6_DL.pdf`): strings, loading text, tokenisation
(bag-of-words, whitespace, subword), vocabulary building, special tokens
(`<pad>`, `<bos>`, `<eos>`, `<unk>`), numerical encoding.

Code: `text_preprocessing_example_torch.py`, `_2_torch.py`, `_3_torch.py`.

#### 2.4.1 Tokenisation

**Concept.** A **tokeniser** maps a raw string to a list of tokens (integers
later). Flavours:

- **Word-level**: split on whitespace/punctuation. Simple but vocabulary blows
  up; unknown words → `<unk>`.
- **Character-level**: tiny vocab, long sequences, no unknown-word problem.
- **Subword (BPE / WordPiece / SentencePiece)**: learns merges on the training
  corpus. What qwen-coder actually uses (~150 K vocab).

**Worked example** (word-level): `"SynthDef kick plays"` → `['synthdef', 'kick', 'plays']`
(lowercased) — exactly what [tokenize.js](../../suggestions/tokenize.js) does.

**Guided exercise.** Given the documents
`D1 = "kick plays loud"` and `D2 = "bass plays soft"`, build a word-level
vocabulary and produce the integer-encoded sequences.

Step 1 — collect unique tokens in order of first appearance:
`['kick','plays','loud','bass','soft']`.
Step 2 — assign ids: `kick→0, plays→1, loud→2, bass→3, soft→4`.
Step 3 — encode D1: `[0, 1, 2]`; D2: `[3, 1, 4]`.
Step 4 — typically reserve `0` for `<pad>` in practice; push all others up by 1.

**Envil tie-in.** [tokenize.js](../../suggestions/tokenize.js) does step 1
(lowercase + split on non-word chars + stopword removal). Your BM25 index then
does step 2–3 implicitly via its `tf`/`df` maps.

#### 2.4.2 Building a vocabulary

**Concept.** Keep the $V$ most frequent tokens; everything else → `<unk>`.
Add `<pad>` for padding shorter sequences to a common length, `<bos>`/`<eos>`
for sequence boundaries.

**Worked example.** Counts over your jams corpus (from the smoke test):
`synthdef: 151, pbind: 133, sine: 0 (lowercased to 'sinosc' probably)`.
Keep top $V=1000$ → your tokeniser.

**Guided exercise.** You want to feed padded batches to an LSTM. Given
sequences of lengths $[3, 5, 2]$ and `<pad>=0`, build the padded batch.

Step 1 — max length 5. Pad on the right.
Step 2 — `[[a,b,c,0,0], [d,e,f,g,h], [i,j,0,0,0]]`.
Step 3 — typically pair with a boolean mask to tell the model which positions
are real.

**Envil tie-in.** Your corpus stays tokenised in memory (`blocks[i].tokens`).
For LoRA training you'd pad/truncate to a fixed 2048-token window, same shape
every batch.

#### 2.4.3 Bag-of-words & TF-IDF (pre-step to embeddings)

**Concept.** Represent a document as a vector of token counts (bag-of-words)
or weighted counts (TF-IDF). Lose word order, keep frequencies. Good baseline
for classification.

**Worked example.** TF-IDF for `"kick"` in your corpus:
tf = 133 (it appears in 133 of 1218 blocks), df = same, N = 1218.
$\text{idf} = \log(1218/133) \approx 2.21$.
$\text{tf-idf} \approx$ contribution of `kick` to any matching block's score.

**Guided exercise.** Compute the BM25 IDF for `"sinosc"` (df = 0 in the jam
corpus) and for `"pbind"` (df = 133 of N = 1218). Use
$\text{IDF}(t) = \ln\!\left(1 + \tfrac{N - \text{df} + 0.5}{\text{df} + 0.5}\right)$.

Step 1 — `sinosc` df=0: $\ln(1 + 1218.5/0.5) = \ln(2438) \approx 7.80$. Very high
(term is unique) but there's nothing to match against → doesn't fire.
Step 2 — `pbind` df=133: $\ln(1 + 1085.5/133.5) = \ln(9.13) \approx 2.21$.
Step 3 — `pbind` matches will score ~2.21 × (tf scaling) per query-hit.

**Envil tie-in.** This is literally the IDF map built in
[bm25.js#L38-L42](../../suggestions/bm25.js#L38-L42).

#### 2.4.4 N-grams

- An n-gram is a contiguous run of $n$ tokens.
- Unigram = single token. Bigram = pair. Trigram = triple.
- Captures local order that bag-of-words throws away.
- Cost: vocabulary size grows roughly $V^n$.
- Often used as features alongside unigrams (BM25 with bigrams).

*Worked.* `"kick plays loud"` bigrams: `(kick, plays)`, `(plays, loud)`.

#### 2.4.5 Special tokens (vocabulary)

- `<pad>`: pad shorter sequences to common length, masked from loss.
- `<unk>`: any token not in vocab.
- `<bos>`/`<eos>`: begin/end of sequence (used for generation stop).
- `<cls>`/`<sep>`: BERT-style classification + segment separation.
- `<|fim_prefix|>` `<|fim_suffix|>` `<|fim_middle|>`: FIM markers in code LLMs.
- IDs for these are usually low (0–4) and reserved.

#### 2.4.6 Stopwords

- Common words that carry little discriminating information: `the, is, of, a, and, …`
- Removed before BM25 to reduce noise and speed up indexing.
- Modern Transformers do **not** strip stopwords — attention can decide.
- Code-specific stopwords for SC: `var, arg, do, if` (already in [tokenize.js](../../suggestions/tokenize.js)).

#### 2.4.7 Embedding lookup as matrix product

- One-hot vector $x \in \{0,1\}^V$, embedding matrix $E \in \mathbb{R}^{V \times d}$.
- $\text{lookup}(x) = x^\top E$ → just the row of $E$ for the active index.
- `nn.Embedding` is the efficient (sparse) implementation of this matrix product.
- During training, gradient flows only into the rows actually used in the batch.

#### Quick-ref card — Week 16

| Step | What | Output type |
|---|---|---|
| 1. Load | text → string | `str` |
| 2. Tokenise | string → tokens | `list[str]` |
| 3. Vocab | tokens → ids | `dict[str, int]` |
| 4. Encode | ids → tensor | `LongTensor (B, L)` |
| 5. Pad | align lengths | `LongTensor (B, L_max)` + mask |
| 6. Embed | ids → vectors | `FloatTensor (B, L_max, d)` |

---

### 2.5 Week 17 (21.4) — NLP II: embeddings

**Sub-topics** (upcoming; inferred from course plan + Chollet 3E Ch.11):
word2vec (CBOW, skip-gram), GloVe, learned embeddings in supervised tasks,
evaluation with cosine similarity, transferring pre-trained embeddings.

Code landed 21.4: `training_embedding_torch.py`, `freq_lm.py`,
`SMILES_FNN_Model.ipynb`, `sentiment_classification_LSTM_torch.ipynb`.

#### 2.5.1 Word embeddings

**Concept.** Instead of one-hot vectors (orthogonal, no semantics), map each
token id to a dense vector in $\mathbb{R}^d$ ($d$ typically 50–300 classically,
2048 in qwen-coder). Vectors are *learned* by a pretext task:

- **CBOW**: predict centre word from context.
- **Skip-gram**: predict context from centre word.
- **Supervised embeddings**: just an `nn.Embedding(V, d)` layer trained jointly
  with downstream classifier.

The resulting vectors cluster semantically: `cos(E("king") - E("man") + E("woman"), E("queen"))` ≈ 1.

**Worked example.**
$e_{\text{king}} = (1, 1)$, $e_{\text{man}} = (1, 0)$, $e_{\text{woman}} = (0, 1)$.
$e_{\text{king}} - e_{\text{man}} + e_{\text{woman}} = (0, 2)$.
If $e_{\text{queen}} = (0, 1)$: $\cos = \frac{2}{\sqrt 4 \cdot \sqrt 1} = 1$. ✔

**Guided exercise.** Two code-snippet embeddings: $e_{\text{sinosc}} = (1, 0, 0)$,
$e_{\text{saw}} = (0.9, 0.1, 0)$, $e_{\text{reverb}} = (0, 0, 1)$. You query
with "bright oscillator" encoded as $q = (0.8, 0.2, 0)$. Which of the three
does dense retrieval return?

Step 1 — normalise each vector (cosine needs unit-length).
$\|e_{\text{sinosc}}\| = 1$, $\|e_{\text{saw}}\| \approx 0.906$,
$\|e_{\text{reverb}}\| = 1$, $\|q\| \approx 0.825$.
Step 2 — $\cos(q, e_{\text{sinosc}}) = 0.8 / (0.825 \cdot 1) \approx 0.970$.
Step 3 — $\cos(q, e_{\text{saw}}) = (0.8 \cdot 0.9 + 0.2 \cdot 0.1) / (0.825 \cdot 0.906)
\approx 0.74/0.747 \approx 0.991$.
Step 4 — $\cos(q, e_{\text{reverb}}) = 0 / \ldots = 0$.
Step 5 — top hit: **saw** — even though the query used the word "oscillator"
(not "saw"), the embedding space captured the semantic neighbourhood.

**Envil tie-in.** This is precisely why Tier-2 (embedding-based RAG) would
beat BM25 for queries like "reverbed bass" where the snippet uses `FreeVerb`
without the word "reverb". You'd replace [bm25.js](../../suggestions/bm25.js)
with a call to Ollama's `/api/embeddings` endpoint + cosine-similarity search.

#### 2.5.2 `nn.Embedding` in PyTorch

**Concept.** A trainable lookup table: `emb = nn.Embedding(V, d)` stores a
$V \times d$ matrix. `emb(ids)` with `ids` of shape `(B, L)` returns `(B, L, d)`.

**Worked example.** `V=5, d=3`, `ids = [[1, 3]]`. The embedding returns rows 1
and 3 of the $5 \times 3$ matrix, shape `(1, 2, 3)`.

**Guided exercise.** Annotate the shapes through this snippet (from the 2024
exam Q11):

```python
self.embedding = nn.Embedding(vocab_size, embedding_dim)       # (V, d)
self.flatten   = nn.Flatten()
self.fc        = nn.Linear(embedding_dim * max_length, 1)

def forward(self, x):                # x: (B, L) int ids
    x = self.embedding(x)            # (B, L, d)
    x = self.flatten(x)              # (B, L*d)
    x = self.fc(x)                   # (B, 1) logit
    return torch.sigmoid(x)          # (B, 1) probability
```

Task: **binary text classification** over fixed-length token windows (e.g.
sentiment).

**Envil tie-in.** Every token ID that qwen sees goes through an `nn.Embedding`
of shape $(150\,000, 2048)$ as its very first step. The 3 B parameter count of
the model is dominated by this embedding matrix plus the 36 attention blocks.

#### 2.5.3 word2vec — CBOW vs Skip-gram

- **CBOW (Continuous Bag-of-Words)**: predict centre word from its context window. Faster, better for frequent words.
- **Skip-gram**: predict context words from the centre word. Slower, better for rare words.
- Trained with **negative sampling**: for each true (centre, context) pair, sample $k$ random words as negatives, classify true vs fake.
- Output: a $V \times d$ matrix you can use as starting embedding.

#### 2.5.4 GloVe (Global Vectors)

- Trained on the global word-word co-occurrence matrix.
- Loss minimises $\sum_{i,j} f(X_{ij}) \big(w_i^\top \tilde w_j + b_i + \tilde b_j - \log X_{ij}\big)^2$.
- Pre-trained vectors (50d, 100d, 200d, 300d) downloadable from Stanford NLP.
- Often compared to word2vec; in practice similar quality.

#### 2.5.5 Analogy arithmetic (the famous trick)

- $E(\text{king}) - E(\text{man}) + E(\text{woman}) \approx E(\text{queen})$.
- Works because embeddings encode latent factors as linear directions (gender, plurality, tense).
- Limited beyond the demo; modern contextual embeddings (BERT, qwen) do this implicitly per-context.

#### 2.5.6 Cosine vs Euclidean

- **Cosine similarity** ignores vector magnitude → only direction matters. Good for embeddings (magnitude is often a frequency artefact).
- **Euclidean** counts magnitude. Used inside k-means after normalising.
- For unit-normalised vectors, they're monotonically related: $\|a-b\|^2 = 2(1 - \cos\theta)$.

#### 2.5.7 Pre-trained embeddings — freeze or fine-tune?

- **Freeze** (`embedding.weight.requires_grad = False`): start with GloVe, never update. Best when small downstream dataset.
- **Fine-tune**: allow updates. Best when large downstream dataset.
- Compromise: freeze for first $k$ epochs, then unfreeze with low lr.
- Same logic applies to Transformer LoRA (you freeze 99.5% of the model).

#### Quick-ref card — Week 17

| Concept | Key fact |
|---|---|
| One-hot vs embedding | $V$-dim sparse vs $d$-dim dense |
| `nn.Embedding(V, d)` | trainable lookup table $V \times d$ |
| Skip-gram | predict context from centre |
| CBOW | predict centre from context |
| GloVe | factorise log co-occurrence matrix |
| Cosine | $\cos\theta = a \cdot b / (\|a\|\|b\|)$ |
| Analogy | linear direction = semantic factor |

---

### 2.6 Week 18 (28.4) — Transformers I (upcoming)

**Sub-topics** (inferred from plan + Chollet 3E Ch.12): self-attention, the
$\text{softmax}(QK^\top / \sqrt{d_k}) V$ formula, query/key/value projections,
multi-head attention, positional encodings, encoder vs decoder blocks.

#### 2.6.1 Scaled dot-product attention

**Concept.** Given a sequence of token embeddings stacked as rows of a matrix
$X$, project to three views: $Q = XW^Q$, $K = XW^K$, $V = XW^V$.

$$
\text{Attention}(Q, K, V) = \text{softmax}\!\left(\tfrac{QK^\top}{\sqrt{d_k}}\right) V.
$$

Intuition: each row of $Q$ asks "who should I pay attention to?"; dot products
with $K$ rows measure similarity; softmax turns them into weights; the
weighted sum of $V$ rows is the output.

The $\sqrt{d_k}$ divisor keeps dot-product magnitudes bounded so softmax doesn't
saturate at high $d_k$.

**Worked example.** Two tokens ($n=2$), $d_k=2$.
$Q = K = V = \begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}$.

$QK^\top = I$. Divide by $\sqrt 2$: $\begin{pmatrix} 0.707 & 0 \\ 0 & 0.707 \end{pmatrix}$.
Row-wise softmax: row 1 = $(e^{0.707}, e^0)/(\ldots) \approx (0.670, 0.330)$;
row 2 = $(0.330, 0.670)$.
Multiply by $V = I$: output $= \begin{pmatrix} 0.670 & 0.330 \\ 0.330 & 0.670 \end{pmatrix}$.

Each token kept ~67% of itself and borrowed ~33% from the other — a soft
mixing governed by similarity.

**Guided exercise.** Same $Q, V$, but now $K = \begin{pmatrix} 1 & 1 \\ 1 & 1 \end{pmatrix}$
(both keys identical).

Step 1 — $QK^\top = \begin{pmatrix} 1\cdot 1+0\cdot 1 & 1\cdot 1+0\cdot 1 \\ 0\cdot 1+1\cdot 1 & 0\cdot 1+1\cdot 1 \end{pmatrix} = \begin{pmatrix} 1 & 1 \\ 1 & 1 \end{pmatrix}$.
Step 2 — divide by $\sqrt 2$: $\begin{pmatrix} 0.707 & 0.707 \\ 0.707 & 0.707 \end{pmatrix}$.
Step 3 — row-wise softmax: each row = $(0.5, 0.5)$.
Step 4 — multiply by $V = I$: output $= \begin{pmatrix} 0.5 & 0.5 \\ 0.5 & 0.5 \end{pmatrix}$.
Interpretation: when keys carry no discriminating info, attention collapses to
uniform averaging.

**Envil tie-in.** Every `Ctrl+Alt+Space` runs ~40 attention matrices per
layer × 36 layers × ~200 generated tokens. The 2×2 arithmetic you just did
*is* what's being done — at shape $(\text{prefix length} \times 2048)$.

#### 2.6.2 Multi-head attention

**Concept.** Run $h$ independent attention heads in parallel on different
sub-projections, concat, project back. Each head can specialise (short-range
vs long-range, syntax vs semantics).

qwen-coder-3B: 16 heads, $d_k = 128$ per head, total $d_{\text{model}} = 2048$.

**Envil tie-in.** Empirically, one or two heads in code-LLMs end up as
"matching-bracket trackers" — they learn to attend from `(` to the matching `)`.
Directly relevant to SC's `( … )` block convention!

#### 2.6.3 Positional encoding

**Concept.** Attention is permutation-invariant: shuffle the tokens, same
attention. To inject order, add (or rotate) position-dependent vectors.

- **Sinusoidal** (original "Attention is All You Need"):
  $PE_{(p, 2i)} = \sin(p / 10000^{2i/d})$,
  $PE_{(p, 2i+1)} = \cos(p / 10000^{2i/d})$.
- **RoPE** (Rotary Positional Embedding; what qwen uses): rotate the Q, K
  vectors by an angle proportional to position. Extends to long contexts
  without retraining and generalises better.

**Worked example.** Sinusoidal with $d=4$, $p=0$: $(\sin 0, \cos 0, \sin 0, \cos 0) = (0, 1, 0, 1)$.
$p=1$: with the classical $10000^{i/2}$ schedule at $d=4$:
position 1 → $(\sin 1, \cos 1, \sin(1/100), \cos(1/100)) \approx (0.841, 0.540, 0.010, 1.000)$.

**Envil tie-in.** The 32 K-token context window of qwen-coder-3B is RoPE-scaled.
That's why it can "see" the whole `00_band_repo/libs/` folder if you injected it.

#### 2.6.4 Why divide by $\sqrt{d_k}$?

- Q and K rows are roughly i.i.d. with variance 1.
- Their dot product has variance $d_k$ (sum of $d_k$ independent products).
- Without scaling, large $d_k$ → huge logits → softmax saturates (almost-one-hot) → vanishing gradient.
- Dividing by $\sqrt{d_k}$ keeps logit variance ≈ 1 regardless of $d_k$.

#### 2.6.5 Causal (autoregressive) mask

- Decoder-only Transformers must not let position $i$ peek at position $j > i$.
- Add a mask $M$ to logits before softmax: $M_{ij} = -\infty$ for $j > i$, $0$ otherwise.
- Softmax of $-\infty$ → 0 → future tokens contribute nothing.
- Looks like an upper-triangular wall of $-\infty$.

#### 2.6.6 Single-head shapes

For input $X \in \mathbb{R}^{B \times L \times d_{\text{model}}}$ with $h$ heads, $d_k = d_{\text{model}}/h$:

- $W^Q, W^K, W^V \in \mathbb{R}^{d_{\text{model}} \times d_{\text{model}}}$.
- After projecting and reshaping: $Q, K, V \in \mathbb{R}^{B \times h \times L \times d_k}$.
- Scores $QK^\top \in \mathbb{R}^{B \times h \times L \times L}$.
- Output $\in \mathbb{R}^{B \times h \times L \times d_k}$ → concat heads → $(B, L, d_{\text{model}})$.

#### Quick-ref card — Week 18

| Concept | Key fact |
|---|---|
| Self-attention | $\text{softmax}(QK^\top/\sqrt{d_k}) V$ |
| Q, K, V | linear projections of same input $X$ |
| Multi-head | $h$ heads, each $d_k = d/h$, then concat |
| Causal mask | $-\infty$ above diagonal |
| Sinusoidal PE | $\sin/\cos$ at multi-scale frequencies |
| RoPE | rotate Q,K by angle $\propto$ position |
| Permutation invariance | broken by PE, not by attention itself |

---

### 2.7 Week 19 (5.5) — Transformers II (upcoming)

**Sub-topics** (inferred): encoder-only (BERT) vs decoder-only (GPT/qwen) vs
encoder-decoder (T5, translation); training objectives (MLM, causal LM, span
corruption, FIM); transformer blocks (attention + FFN + LayerNorm + residual);
KV cache for inference.

#### 2.7.1 Encoder / decoder / encoder-decoder

| Variant | Example | Attention mask | Typical use |
|---|---|---|---|
| Encoder-only | BERT | bidirectional | classification, embedding |
| Decoder-only | GPT, qwen-coder | causal (triangular) | generation |
| Encoder-decoder | T5, mT5 | encoder=bi, decoder=causal + cross | translation, summarisation |

**Envil tie-in.** qwen-coder is **decoder-only** — it can only see past tokens.
FIM gets around this by **rearranging** prefix/suffix so the "middle" becomes
a natural tail: `<|fim_prefix|> PREFIX <|fim_suffix|> SUFFIX <|fim_middle|> …`
The model never needs bidirectional attention; it just has to generate what
comes after `<|fim_middle|>`.

#### 2.7.2 Transformer block

**Concept.** Each block:
```
h = x + Attention(LayerNorm(x))           # residual + pre-norm
h = h + FFN(LayerNorm(h))                 # residual + pre-norm
```
where `FFN(x) = W_2 · σ(W_1 x)` with a hidden dim typically 4× $d_{\text{model}}$.

The residuals are what let gradients flow across 36 layers (same trick as
ResNet, from week 14).

**Worked example of one block — shapes only.**
Input: $(B, L, d)$ = $(1, 64, 2048)$ for a 64-token prompt.
- LayerNorm: same shape.
- Q/K/V projections: $(1, 64, 2048)$ each (then split into heads).
- Attention scores: $(1, 16, 64, 64)$.
- Attention output: $(1, 64, 2048)$. Add residual.
- FFN: expand to $(1, 64, 8192)$, back to $(1, 64, 2048)$. Add residual.

36 blocks, one after another, same shape in → same shape out.

**Guided exercise.** If qwen-coder-3B has $d=2048$, 16 heads, FFN hidden $4d$,
count parameters in **one** attention block (ignore norms, biases).

Step 1 — Q, K, V projections: 3 × $d \times d = 3 \cdot 2048^2 = 12.6\,$M.
Step 2 — output projection: $d \times d = 4.2\,$M.
Step 3 — FFN: $d \times 4d + 4d \times d = 2 \cdot 2048 \cdot 8192 = 33.6\,$M.
Step 4 — per block: ~50.4 M.
Step 5 — 36 blocks: ~1.8 B. Add the embedding matrix (~0.3 B) and you're near
the 3 B total. ✔

#### 2.7.3 KV cache

**Concept.** During autoregressive generation, you re-feed the whole prefix at
each step. But $K, V$ for already-generated tokens don't change → cache them.
Each new step only computes attention from the *new* $Q$ row to the cached
$K, V$. Inference becomes $O(L)$ per token instead of $O(L^2)$.

**Envil tie-in.** This is how Ollama sustains ~30 tokens/sec on CPU for a 3 B
model. The first token is slow (prefill); subsequent tokens are fast (cached).
Observable: `ollama run qwen2.5-coder:3b-base --verbose`.

#### 2.7.4 LayerNorm vs BatchNorm

- **BatchNorm**: normalise across the *batch dimension* per feature. Bad for variable-length sequences.
- **LayerNorm**: normalise across the *feature dimension* per token. No batch dependence → works for any sequence length, online.
- All modern Transformers use LayerNorm (or RMSNorm — even cheaper).
- Placement: **pre-norm** (LayerNorm before attention/FFN, residual outside) is the modern default — more stable training.

#### 2.7.5 FFN block as "key-value memory"

- $\text{FFN}(x) = W_2 \sigma(W_1 x)$ with hidden dim $4 d$.
- Geva et al. 2021 interpretation: rows of $W_1$ act as keys, rows of $W_2$ as values; the activation $\sigma(W_1 x)$ is the soft lookup.
- This is where most of the model's *factual knowledge* is stored. Attention routes; FFN remembers.

#### 2.7.6 FIM training objective

- Pre-training corpus has random documents.
- For a fraction (say 50%) of documents: pick a random middle span, move it after the suffix, wrap with FIM tokens:
  - Input: `<|fim_prefix|> PREFIX <|fim_suffix|> SUFFIX <|fim_middle|> MIDDLE`
- Standard next-token loss on the whole sequence (the model learns both standard left-to-right *and* the FIM permutation).
- At inference: feed up to `<|fim_middle|>`, model generates the missing middle.
- Why it matters: lets a decoder-only model do *insertion* without changing the architecture.

#### 2.7.7 Residual stream picture

- Each token has a $d$-dim vector that flows through all layers.
- Each block *adds* to that vector: $x_{l+1} = x_l + \text{Attn}(x_l) + \text{FFN}(x_l)$ (with norms).
- The residual stream is a shared bus that any block can read from / write to.
- Useful intuition for mechanistic interpretability and for thinking about LoRA placement.

#### Quick-ref card — Week 19

| Concept | Key fact |
|---|---|
| Encoder-only | bidirectional, BERT, embedding |
| Decoder-only | causal, GPT/qwen, generation |
| Enc-dec | T5, translation |
| Pre-norm | LayerNorm before attn/FFN, more stable |
| LayerNorm | per-token, no batch dep |
| FFN dim | typically $4 d_{\text{model}}$ |
| Residual | additive, enables deep stacking |
| KV cache | $O(L)$ generation per token |
| FIM | rearrange P/S/M with special tokens |

---

### 2.8 Week 20 (12.5) — Working with pre-trained models (upcoming)

**Sub-topics** (inferred): finding models (HF Hub, Ollama), model cards,
zero-shot / few-shot prompting, fine-tuning vs feature extraction, PEFT/LoRA,
quantisation.

#### 2.8.1 Pre-training vs fine-tuning

**Concept.** Already covered in § 2.2.2 for CNNs. For LLMs, pre-training is
next-token prediction on a giant web crawl. Fine-tuning is supervised
continued training on a smaller, curated dataset.

**Full fine-tuning** updates all parameters. Cost for a 3 B model: ~24 GB VRAM
for gradients + optimiser state at fp16, more at fp32.

**PEFT** = **P**arameter-**E**fficient **F**ine-**T**uning. Family of methods.

#### 2.8.2 LoRA

**Concept.** Freeze $W$. Learn $\Delta W = BA$ where $B \in \mathbb{R}^{d\times r}$,
$A \in \mathbb{R}^{r\times k}$, with rank $r \ll \min(d, k)$ (often $r = 8$ or
$16$). Forward: $(W + \alpha BA/r) x$. Backward: only $A, B$ receive gradients.

**Parameter count.** For a $2048 \times 2048$ projection: full = 4.2 M, LoRA
rank 8 = $2 \cdot 2048 \cdot 8 = 32\,768$, i.e. **0.8%** of the full matrix.

**Worked example.** 3 B model, apply LoRA to Q and V projections of all 36
layers, rank 8: $36 \cdot 2 \cdot 32\,768 \approx 2.4\,$M trainable parameters.
Fits on a T4 (16 GB VRAM) at int4-base + fp16 adapters.

**Guided exercise.** You want rank $r = 16$ on *all four* attention
projections (Q, K, V, O). How many trainable parameters?

Step 1 — per projection at rank 16: $2 \cdot 2048 \cdot 16 = 65\,536$.
Step 2 — 4 projections per layer: $262\,144$.
Step 3 — 36 layers: $9.4\,$M. Still under 0.4% of the base.

**Envil tie-in.** Tier-3 plan from §1. Realistic target: your corpus of 1 414
blocks → expand to ~10 000 FIM triples by cutting each block at random
positions → one LoRA epoch on a T4 in ~30 min. Resulting ~200 MB adapter
merged into a GGUF via `ollama create envil-bass -f Modelfile`.

#### 2.8.3 Quantisation

**Concept.** Represent weights with fewer bits:

| Name | Bits | Storage per 3 B model | Quality (perplexity ↑) |
|---|---|---|---|
| fp16 | 16 | 6 GB | baseline |
| int8 | 8  | 3 GB | +0.1% |
| Q5_K_M | ~5.5 | 2.1 GB | +0.3% |
| Q4_K_M | ~4.5 | 1.8 GB | +1–2% |
| int4 | 4 | 1.5 GB | +3–5% |

K-quants (Q4_K_M etc.) group weights into small blocks with per-block scales,
preserving much more than naive uniform int4.

**Envil tie-in.** `ollama pull qwen2.5-coder:3b-base` grabs Q4_K_M by default —
that's how the model fits in 2 GB RAM alongside scsynth.

#### 2.8.4 Few-shot / in-context learning

- Show the model 2–5 (input → output) examples in the prompt.
- Model picks up the pattern *without* parameter updates.
- Works because pre-training already encoded the concept; few-shot is retrieval at the prompt level.
- Limit: prompt size and consistency of the format.

#### 2.8.5 Prompt engineering — the cheap version of fine-tuning

- System prompt (role + constraints).
- Format examples ("Answer in bullet points").
- Chain-of-thought ("think step by step") for reasoning.
- Stop sequences to prevent run-on output.
- For code: include type hints, expected return shape, and 1 example call.

#### 2.8.6 Catastrophic forgetting

- Fine-tuning on a narrow distribution can erase pre-trained knowledge.
- Symptoms: the LoRA-tuned model becomes worse at general code, only good at *your* SC.
- Mitigations: small learning rate, low LoRA rank, mix general code into the fine-tune data, use replay buffers.

#### 2.8.7 QLoRA — the standard recipe today

- **Q**uantised + **LoRA**.
- Base weights stored in **NF4** (a 4-bit format optimised for normally-distributed weights).
- LoRA adapters in fp16 (small, no accuracy loss).
- **Double quantisation**: also quantise the per-block scales of NF4 → ~0.5 bit further.
- **Paged optimiser**: spill optimiser state to CPU when VRAM is low.
- Net effect: fine-tune a 7B model on a single 16 GB GPU.
- Library: `bitsandbytes` + `peft` + `transformers`.

#### 2.8.8 Fine-tuning + RAG together

Style comes from weights (LoRA); freshness comes from retrieval (RAG). The
two are complementary. This is the combination Copilot-style products converge
on internally.

#### Quick-ref card — Week 20

| Concept | Key fact |
|---|---|
| Pre-training | self-supervised, huge corpus |
| Fine-tuning | supervised, small corpus |
| Feature extraction | freeze base, train head |
| LoRA | $\Delta W = BA$, rank $r \ll d$ |
| QLoRA | NF4 base + fp16 adapters |
| Q4_K_M | ~4.5 bits/weight, group-quantised |
| Few-shot | $k$ examples in prompt, no training |
| Catastrophic forgetting | narrow tune erases broad skill |

---

### 2.9 Week 21 (19.5) — Ethics & Philosophy of AI

**Sub-topics** (inferred): data provenance, bias, privacy, compute/energy,
model cards, dual-use, open vs closed weights.

**Envil-relevant angles** (useful for group work / exam concept questions):

- **Privacy by local inference.** No prompts leave `localhost`.
- **Data provenance.** Whose SC code is in `sources[]`? Is it licensed
  compatibly with redistribution of the index?
- **Reproducibility.** The corpus index is a JSON, versioned, checksummed.
- **Carbon.** One Ollama generate: ~0.01 Wh. One Copilot call: comparable, but
  it traverses a data centre. Back-of-envelope only, but a real topic.
- **Model bias.** qwen-coder was pre-trained on public-GitHub code → biases
  toward common conventions, under-represents SC/live-coding style (hence
  your LoRA plan).

#### 2.9.1 Hallucination

- LLMs generate plausible but false statements with confidence.
- Cause: trained to maximise likelihood, not truthfulness; no internal model of "I don't know".
- Code-specific: invents non-existent UGens, wrong argument names. Mitigation: RAG anchors to real corpus.
- Honesty work: methods like *constrained decoding*, *self-consistency*, *retrieval grounding*.

#### 2.9.2 Alignment / RLHF / DPO

- Pre-trained model = next-token machine, no notion of "helpful" or "safe".
- **RLHF** (Reinforcement Learning from Human Feedback): humans rank pairs of responses → train a *reward model* → fine-tune the LLM with PPO to maximise reward.
- **DPO** (Direct Preference Optimisation): skip the reward model, optimise preference directly. Simpler, similar quality.
- Side-effect: alignment-tuned (`-instruct`) models often refuse to do FIM properly. Use `-base` for code completion.

#### 2.9.3 Open weights vs open source vs API

- **API** (GPT-4, Claude): you don't see the model. Pay per call. Easy.
- **Open weights** (qwen, llama, mistral): you can run the model yourself. May or may not include training data / training code.
- **Open source** (genuinely): weights + training data + training code under permissive licence. Rare.
- For your SC plugin: open weights (qwen) is the sweet spot — runnable locally, modifiable via LoRA, no vendor lock-in.

#### 2.9.4 Model cards & data sheets

- Standard documentation for ML artefacts (Mitchell et al. 2019).
- Sections: intended use, training data, evaluation, ethical considerations, limitations.
- For Envil: write a 1-pager describing the corpus (which folders, who wrote them, licence) — this is what a project reviewer expects.

#### Quick-ref card — Week 21

| Concept | Key fact |
|---|---|
| Hallucination | confident but false; mitigated by RAG |
| RLHF | reward model + PPO on preferences |
| DPO | preference optimisation w/o reward model |
| Open weights | runnable, modifiable, no API lock-in |
| Model card | mandatory ML artefact documentation |
| Local inference | privacy by design |
| Carbon | 1 generate ≈ 0.01 Wh on consumer GPU |

---

### 2.10 Week 22 (26.5) — Group work discussion

The plugin itself makes a defensible group-work project. Structure a 15-min
presentation as:

1. **Problem** (2 min): live-coders lack offline suggestions.
2. **Data & pipeline** (3 min): corpus, tokenisation, BM25, optional Ollama.
3. **Model** (4 min): qwen-coder-3B Q4_K_M, FIM prompting, LoRA future work.
4. **Results** (3 min): block counts, retrieval latency, tokens/sec.
5. **Ethics** (2 min): local inference, provenance.
6. **Outlook** (1 min): embeddings (Tier 2) + LoRA (Tier 3).

Every section cites a course week. You can even *live-demo* it in VS Code.

---

### 2.11 Deep dive — RAG and dense embeddings (exam-grade)

This section anchors three things you'll see on the exam (embeddings, attention
encoders, transfer learning) by tracing them through the *exact* feature you
might build into the Envil plugin next: replacing BM25 with semantic
retrieval. Worth reading even if you skip everything else.

#### 2.11.1 RAG (Retrieval-Augmented Generation) — the pattern

RAG is **not** a model. It is a three-step glue pattern around any generative
model:

1. **Retrieve** — given a query, fetch top-*k* documents from a local store.
2. **Augment** — concatenate those documents into the LLM's prompt as
   reference material (usually as comments / quoted blocks).
3. **Generate** — call the LLM; it produces output conditioned on both the
   user's prompt *and* the injected documents.

**Why it exists.** An LLM's parameters are frozen after pre-training. RAG is
how you inject *knowledge it never saw* (your private code, today's news,
internal docs) at *inference time* — no fine-tuning needed.

**Three things RAG fixes that fine-tuning doesn't:**

- **Freshness** — you can update the document store every minute; you can't
  retrain a 7 B model every minute.
- **Citations** — you can show the user *which* documents were used, so
  trust is verifiable.
- **Cheap** — no GPU training, no labelled data, just an index.

**Three things fine-tuning fixes that RAG doesn't:**

- **Style** (you write SC in a peculiar dialect — RAG won't make the model
  emit your style, only your snippets).
- **Vocabulary** — RAG can't teach the tokeniser new tokens.
- **Skill** (RAG can show examples but can't make the model *better* at
  composing).

In practice the two are combined: **LoRA for style, RAG for content**. That's
the architecture every "Copilot-for-X" product converges on.

**Envil today (concrete).** `envil.corpusSuggestor.composeAtCursor` is a
minimal RAG pipeline:

```
prefix + suffix (cursor context)
        │
        ▼
[BM25 over 1414 SC blocks]   ← retriever
        │
        ▼
top-3 blocks
        │
        ▼
prompt = "// from foo.sc\n<block>\n\n// from bar.sc\n<block>\n\n" + FIM(prefix, suffix)
        │
        ▼
[Ollama /api/generate, qwen2.5-coder:3b-base]
        │
        ▼
generated middle code
```

Tomorrow: swap BM25 for a learned **embedding** retriever and the pipeline
still works — only step 2's mechanism changes.

#### 2.11.2 What "dense embedding" actually means

A **dense embedding** is a learned function

$$E: \text{text} \to \mathbb R^d$$

mapping any piece of text to a $d$-dimensional vector ($d$ typically
128–1024) such that **semantically similar texts land geometrically close in
$\mathbb R^d$**.

- **Dense** because every coordinate is a meaningful float (vs. **sparse**
  BoW or one-hot, where almost all coordinates are zero).
- **Learned** because $E$ is a neural network whose weights are trained on a
  similarity-preserving objective.
- **Distributed** representation in the Hinton / Bengio sense — each axis
  encodes a soft feature, no axis is "the SynthDef axis".

**Why this matters for retrieval.** With BM25, *"rumble"* matches a block
only if the block literally contains the word *"rumble"*. With embeddings,
*"rumble"* lands near *"deep sub-bass thump"* in $\mathbb R^d$ because they
co-occur in millions of training documents — so the block that contains
*"deep sub-bass thump"* is retrieved even though it shares no word with the
query.

**Cheat-sheet contrast** (matches §2.5.6 exam patterns):

| Property | One-hot / BoW | TF-IDF / BM25 | Dense embedding |
|---|---|---|---|
| Dimension | $|V|$ (huge) | $|V|$ (huge) | $d$ (small, 128–1024) |
| Sparsity | sparse | sparse | dense |
| Trained? | no | no | yes (contrastive loss) |
| Captures meaning? | no | partial (via term rarity) | **yes** |
| Out-of-vocab handling | drops it | drops it | tokeniser handles via subwords |
| Storage / block | KB (sparse) | KB (sparse) | ≈ $4d$ bytes (384 → 1.5 KB) |

#### 2.11.3 Step-by-step: building & using embeddings (the whole pipeline)

**Step 0 — choose an encoder.** Any small bi-directional Transformer
encoder pre-trained with a sentence-similarity objective. Defaults that
work today:

- `sentence-transformers/all-MiniLM-L6-v2` — 6 layers, $d = 384$, 22 M params, ~80 MB.
- `BAAI/bge-small-en-v1.5` — 12 layers, $d = 384$, 33 M params, top of MTEB leaderboard for its size.
- Ollama's `nomic-embed-text` — 137 M params, $d = 768$, multilingual.

**Step 1 — tokenise.** Same BPE / WordPiece tokeniser the encoder was
trained with (lives next to the model file). Input text → list of integer
IDs of length $L$.

**Step 2 — forward through the encoder.**

```
                  input IDs, shape (L,)
                            │
                            ▼
              [ token embedding ]   shape (L, d_model)
                            │
                            ▼
   [ N × Transformer encoder block ]      ← learned weights
   │         │                            ← bi-directional (no causal mask)
   │         ├── multi-head self-attention
   │         └── FFN + residual + LayerNorm
   ▼
   hidden states, shape (L, d_model)
```

This is the architecture from §2.6–2.7 minus the causal mask. Because the
mask is gone, every token attends to every other token in both directions
(that's what *bi-directional* means).

**Step 3 — pool to one vector per text.** Three common choices, all
training-time decisions:

- **Mean pooling** (default): average the $L$ token vectors.
- **`[CLS]` token**: pre-pend a special `[CLS]` ID, use its hidden state.
- **Max pooling**: element-wise max over the $L$ vectors.

Result: one $d$-vector for the whole text.

**Step 4 — L2-normalise.** Divide by $\|\cdot\|_2$. After this, cosine
similarity equals plain dot product:
$\cos(a, b) = a \cdot b$ when $\|a\| = \|b\| = 1$. Faster, simpler.

**Step 5 — index your corpus** (do once):

```python
for block in corpus:                          # 1414 blocks
    ids  = tokenizer.encode(block.text)       # (L,)
    h    = encoder(ids)                       # (L, 384)
    vec  = h.mean(dim=0)                      # (384,)
    vec  = vec / vec.norm()                   # L2-normalise
    store(block.id, block.text, vec, block.meta)
```

Total cost: ~5 s for 1414 blocks on a modest CPU. Result on disk:
1414 vectors × 384 floats × 4 bytes ≈ **2.2 MB**.

**Step 6 — query** (every time the user invokes RAG):

```python
q_ids = tokenizer.encode(query)
q_vec = encoder(q_ids).mean(0); q_vec /= q_vec.norm()

scores = corpus_vecs @ q_vec        # (1414,) dot products
top_k  = scores.topk(3)
```

Linear scan over 1414 vectors of 384 floats: ~0.5 ms. For 100 000+ blocks
you'd switch to an approximate nearest-neighbour index (HNSW, FAISS) but
for our scale a dot-product loop is fine.

#### 2.11.4 How is the encoder trained? (the contrastive trick)

This is the part you'll be asked about in an exam.

**Goal.** Produce $E$ such that *semantically similar* texts have
$\cos(E(a), E(b)) \to 1$ and *dissimilar* texts have $\cos \to 0$.

**Training data.** Hundreds of millions of *pairs* mined from the web:

- (question, answer) from Stack Overflow / Quora,
- (sentence, paraphrase) from Wikipedia revisions,
- (caption, image-caption-variant) from MS-COCO,
- (title, body) from Reddit,
- (forward translation, back-translation),
- etc.

A "positive" pair $(a, b^+)$ is a semantically related text pair. A
"negative" pair $(a, b^-)$ is a randomly sampled unrelated text.

**Loss (InfoNCE / contrastive).** For a batch of $N$ pairs:

$$
\mathcal L = - \sum_{i=1}^{N} \log \frac{\exp\!\big(\cos(E(a_i), E(b_i^+)) / \tau\big)}{\sum_{j=1}^{N} \exp\!\big(\cos(E(a_i), E(b_j)) / \tau\big)}
$$

- numerator: similarity of the true pair
- denominator: similarity to every other example in the batch (negatives)
- $\tau$: temperature (typ. 0.05). Lower $\tau$ → sharper softmax → harder negatives.

This is exactly **softmax cross-entropy where the "class" is the index of
the true positive** in the batch. Every other batch element is a free
in-batch negative. That's why batches are big (1024+) — more negatives
→ harder learning signal.

**Geometric interpretation.** Each step (i) pulls $E(a_i)$ and $E(b_i^+)$
together, (ii) pushes $E(a_i)$ away from every other vector in the batch.
After millions of steps, the unit sphere $S^{d-1}$ is partitioned into
neighbourhoods of related meanings.

#### 2.11.5 How "rumble" finds "deep sub-bass" — the worked example

Suppose your corpus has one block tagged `// deep sub-bass thump` containing
a `SinOsc.ar(40)` + `EnvGen.kr(Env.perc)` SynthDef. You type a `//? rumble`
query.

1. **Tokenise both:** `rumble` → `[rum, ble]`. The block → `[//, deep, sub, -, bass, thump, SynthDef, …]`.
2. **Encode both:** each goes through the *same* MiniLM. The query produces $q \in \mathbb R^{384}$. The block produces $b \in \mathbb R^{384}$.
3. **The encoder has never seen your SC code.** But during training it saw
   millions of (rumble, deep bass), (rumble, low frequency), (sub-bass, thump) co-occurrences. So the *direction* assigned to "rumble" and the *direction* assigned to "deep sub-bass thump" are nearly parallel in $\mathbb R^{384}$.
4. **Score:** $\cos(q, b) \approx 0.78$ (high). Another block tagged `// shimmer pad` gets $\cos \approx 0.15$ (low).
5. **Return the rumble-adjacent block** even though the query and the block share zero word stems. *That's the win over BM25.*

#### 2.11.6 Where the network came from (transfer learning recap)

- Pre-trained on a generic corpus (Wikipedia + BookCorpus + web).
- Fine-tuned with contrastive loss on similarity datasets.
- Released as open weights.
- You download once (~80 MB), run forward passes locally, **never train it**.

This is the *Tier 2* path of §1.2 made concrete. Same playbook as using
`qwen2.5-coder` for code — you inherit a pre-trained model and only adapt it
to your data through the input (RAG) or via tiny adapters (LoRA).

#### 2.11.7 How we'd plug it into Envil — three options

| Option | Encoder lives where | Pros | Cons |
|---|---|---|---|
| **A. Ollama `/api/embeddings`** | the user's existing Ollama daemon | zero new deps; GPU-accelerated; we already speak Ollama HTTP | requires Ollama running |
| **B. `transformers.js`** (`Xenova/all-MiniLM-L6-v2`) | bundled into the extension, runs in Node with WASM/ONNX | works without Ollama; pure JS | +25 MB extension; first-use model download |
| **C. `node-llama-cpp`** native FFI | bundled native binary | fastest | breaks pure-JS portability |

Recommended (matches the Roadmap entry in [README.md](../../README.md)):
ship **A** first; fall back to **B** if Ollama isn't installed. Same
retriever interface either way:

```js
async function retrieveTopK(query, k) {
    const qVec = await embed(query);           // A or B
    const scored = corpus.map(b => ({
        block: b, score: dot(qVec, b.vec),
    }));
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, k);
}
```

Drop-in replacement for [suggestions/index.js#L184](../../suggestions/index.js#L184).

#### 2.11.8 Hybrid retrieval — the production answer

In practice nobody ships *only* embeddings. You ship **both**, and combine:

$$
\text{score}(q, b) = \alpha \cdot \text{BM25}(q, b) + (1 - \alpha) \cdot \cos(E(q), E(b))
$$

- BM25 dominates on *rare exact tokens* (`~mcr_3`, `SynthDef(\specific_name)`).
- Embeddings dominate on *concept queries* (`rumble`, `glitchy texture`).
- $\alpha \approx 0.4$ is a typical starting weight.

This is what Elasticsearch (`rank_features`), Vespa, Weaviate, and
Pinecone's hybrid mode all do.

#### 2.11.9 Exam-style summary card — RAG + embeddings

| Concept | One-line answer |
|---|---|
| RAG | Retrieve top-*k* docs from a local store, paste into LLM prompt, generate. |
| Why RAG | Inject knowledge the LLM was not trained on, without fine-tuning. |
| Embedding $E$ | Learned $\text{text} \to \mathbb R^d$ s.t. similar texts → close vectors. |
| Encoder architecture | Bi-directional Transformer (no causal mask), mean-pool, L2-normalise. |
| Training objective | Contrastive (InfoNCE): pull positive pairs together, push negatives apart. |
| Similarity metric | Cosine (= dot product after L2-normalisation). |
| Indexing cost | One forward pass per document, ~ms each. |
| Query cost | One forward pass + one matmul vs all stored vectors. |
| Storage | $d$ floats per document, ≈ $4d$ bytes. |
| Sparse vs dense | BM25 = lexical, sparse. Embeddings = semantic, dense. |
| Hybrid | $\alpha\text{BM25} + (1-\alpha)\cos$; best of both. |
| RAG vs fine-tune | RAG = content/freshness; LoRA = style/skill. Combine them. |

#### 2.11.10 Quick exercise (self-check)

You have 3 documents, all 384-d L2-normalised vectors:

- $d_1 = $ "low rumble synth bass"
- $d_2 = $ "shimmer pad sweep"
- $d_3 = $ "SynthDef(\\kick) with sub bass"

Their pairwise dot products with the query $q = $ "deep sub bass" are
$0.82, 0.11, 0.79$ respectively. With BM25 only $d_3$ would score
non-zero (it shares the literal tokens "sub" and "bass"). Which retriever
returns the better top-2 for the query, and which top-2 would the
**hybrid** with $\alpha = 0.4$ return if the BM25 scores normalised to
$(0.0, 0.0, 0.6)$?

*Hint.* Hybrid score = $\alpha \cdot \text{BM25} + (1 - \alpha) \cdot \cos$.

(Answer: embeddings return $\{d_1, d_3\}$ — better, recovers the
semantically-related rumble block. Pure BM25 returns only $d_3$.
Hybrid: $d_1 = 0.4 \cdot 0 + 0.6 \cdot 0.82 = 0.49$,
$d_2 = 0.07$, $d_3 = 0.4 \cdot 0.6 + 0.6 \cdot 0.79 = 0.71$. Top-2 = $\{d_3, d_1\}$.)

---

## Part 3 — Exercises (at the predicted difficulty)

Two exercises per topic. All runnable with pen + paper + the sigmoid formula.
Solutions in Part 4.

### T1 — Perceptrons & forward pass

**E1.1** Design a perceptron (weights + bias, integers OK) implementing the
logical **OR** of two binary inputs with step activation
$\sigma(z) = 1$ if $z \ge 0$ else $0$.

**E1.2** Given inputs $x = (2, -1)$, weights $w = (0.5, 1.0)$, bias $b = -0.5$,
and sigmoid activation, compute the perceptron output. Then compute the
gradient $\partial a / \partial w_1$ at this point (symbolic then numeric).

### T2 — FNN forward + one SGD step

**E2.1** Same architecture as 2024-Q5 (2 → 2 → 1, sigmoid, no bias), but with

$$
W^{(1)} = \begin{pmatrix} 0.2 & 0.3 \\ 0.4 & 0.1 \end{pmatrix}, \quad
W^{(2)} = (0.5,\ 0.7), \quad
x = (1, 0)^\top, \quad y = 1, \quad \eta = 0.5.
$$

Compute (a) the prediction, (b) the MSE loss $\mathcal{L} = \tfrac12(\hat y - y)^2$,
(c) the updated $W^{(2)}$ after one SGD step.

**E2.2** For the same network, write the chain-rule expression for
$\partial \mathcal{L} / \partial W^{(1)}_{1,1}$ (symbolic, no numbers), naming
each factor.

### T3 — Convolution & pooling by hand

**E3.1** Input $X = \begin{pmatrix} 1&2&0\\3&1&2\\0&1&3 \end{pmatrix}$,
kernel $K = \begin{pmatrix} 1&0\\0&-1 \end{pmatrix}$. Compute the 2D *valid*
convolution (no padding, stride 1). Then apply $2\times 2$ max-pool with
stride 1.

**E3.2** An image has shape $(3, 64, 64)$. It passes through:
`Conv2d(3, 16, kernel_size=5, padding=2, stride=1)` → `MaxPool2d(2)` →
`Conv2d(16, 32, kernel_size=3, padding=0, stride=1)` → `MaxPool2d(2)`.
What is the output shape going into the first fully-connected layer?

### T4 — Regularisation concepts (short answer)

**E4.1** Batch norm: state the operation (formula) and two benefits.

**E4.2** Dropout at training vs inference time — what exactly differs, and why?

### T5 — Autoencoders & embeddings

**E5.1** Describe in 3 sentences how an autoencoder can flag anomalies in
spectrograms of your live-coded SuperCollider output.

**E5.2** Given two word embeddings
$e_a = (1, 0, 1)$ and $e_b = (0.5, 0.5, 1)$, compute cosine similarity.
Which is more similar to $e_c = (1, 1, 0)$ — $e_a$ or $e_b$?

### T6 — RNN / LSTM

**E6.1** You want to predict the next audio-buffer amplitude from the previous
512 samples. List all hyperparameters you must fix to *set up the dataset for
training* (not the model).

**E6.2** In one sentence each, say what the **forget gate**, **input gate**,
and **output gate** of an LSTM cell do.

### T7 — Tokenisation & vocabulary

**E7.1** Given the corpus of two "documents":
`"SynthDef kick plays"` and `"kick plays loud"`, build (a) the vocabulary,
(b) one-hot vectors for each token, (c) a bag-of-words vector for each
document.

**E7.2** Why does BM25 rank "kick" above "plays" for the query `"kick"`, even
though both words appear in both documents? Refer to the IDF factor.

### T8 — Attention mechanism

**E8.1** Given

$$
Q = \begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}, \quad
K = \begin{pmatrix} 1 & 1 \\ 0 & 1 \end{pmatrix}, \quad
V = \begin{pmatrix} 2 & 0 \\ 0 & 3 \end{pmatrix}, \quad d_k = 2.
$$

Compute $\text{Attention}(Q, K, V) = \text{softmax}\left(\tfrac{QK^\top}{\sqrt{d_k}}\right) V$.

**E8.2** State two advantages and two disadvantages of self-attention vs
recurrent networks for long sequences.

### T9 — Pre-trained models & fine-tuning

**E9.1** Define, in one sentence each: (a) pre-training, (b) fine-tuning,
(c) LoRA, (d) quantisation.

**E9.2** You have `qwen2.5-coder:3b-base` (pre-trained) and a corpus of 1 400
SuperCollider code blocks. You want it to learn your dialect (variable names
like `~i0`, macro style `~mcr_N`). Should you (i) retrain from scratch,
(ii) full-parameter fine-tune, (iii) LoRA fine-tune, or (iv) use RAG only?
Justify in 3 sentences.

### T10 — Code reading

**E10.1** Annotate each line:

```python
class TextModel(nn.Module):
    def __init__(self, vocab, dim, L):
        super().__init__()
        self.emb  = nn.Embedding(vocab, dim)
        self.flat = nn.Flatten()
        self.fc   = nn.Linear(dim * L, 1)
    def forward(self, x):
        x = self.emb(x)
        x = self.flat(x)
        return torch.sigmoid(self.fc(x))
```

What task is this model for?

**E10.2** A PyTorch CNN for MNIST ends with `self.fc = nn.Linear(shape, 10)`.
The layers before are `Conv2d(1, 32, 3, padding=1)` → `MaxPool2d(2)` →
`Conv2d(32, 64, 3, padding=1)` → `MaxPool2d(2)`, input `(1, 28, 28)`. What
is `shape`?

### T11 — Boolean perceptrons & eigenvalues (math drills)

**E11.1** Design a perceptron (with threshold activation) implementing
**NAND**. Verify on all 4 input rows.

**E11.2** Compute the eigenvalues of
$A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}$.
Then state — in one sentence — what PCA would do with the covariance matrix
$A$ if it represented a 2-D dataset.

### T12 — RNN by hand (counter)

**E12.1** A camera classifier emits one binary label per frame
$x_t \in \{0, 1\}$ (1 = "event detected"). Design a *simple* RNN that
outputs $y_t = $ total number of 1s seen *so far*. State:

- input weight $u$, recurrent weight $w$, output weight $v$,
- hidden activation,
- initial state $h_0$,
- output activation.

Verify on the input sequence $(1, 0, 1, 1, 0)$.

**E12.2** Tensor indexing. Given
```python
t = torch.tensor([[[1, 2, 3],
                   [4, 5, 6]],
                  [[7, 8, 9],
                   [10, 11, 12]]])
```
Give the values of `t[1, 0, :]`, `t[:, 1, 2]`, and `t[0, :, 1]`.

### T13 — Generative models & ethics

**E13.1** Sketch (in 4 numbered steps) a deep-learning approach to forge a
short handwritten signature — architecture family, dataset, training
objective, inference. Then name two defences against such forgeries.

**E13.2** *Concept.* A friend claims their `qwen2.5-coder` answers are
"always factually correct because LLMs were trained on the internet."
In 3–4 sentences, explain *hallucination*, why it happens by construction,
and one practical mitigation you have already shipped in the Envil plugin.

---

## Part 4 — Solutions

### S1

**S1.1** One valid choice: $w_1 = 1$, $w_2 = 1$, $b = -0.5$. Check:
$(0,0) \to -0.5 \to 0$; $(1,0) \to 0.5 \to 1$; $(0,1) \to 0.5 \to 1$;
$(1,1) \to 1.5 \to 1$. ✔

**S1.2** $z = w \cdot x + b = 0.5 \cdot 2 + 1.0 \cdot (-1) - 0.5 = -0.5$.
$a = \sigma(-0.5) = \frac{1}{1 + e^{0.5}} \approx \frac{1}{1 + 1.6487} \approx 0.3775$.
$\frac{\partial a}{\partial w_1} = \sigma'(z) \cdot x_1 = a(1-a) \cdot x_1
\approx 0.3775 \cdot 0.6225 \cdot 2 \approx 0.470$.

### S2

**S2.1** Hidden input $h_{\text{in}} = W^{(1)} x = (0.2, 0.4)^\top$.
Hidden activation $h = (\sigma(0.2), \sigma(0.4)) \approx (0.5498, 0.5987)$.
Output input $o_{\text{in}} = W^{(2)} h = 0.5 \cdot 0.5498 + 0.7 \cdot 0.5987
\approx 0.2749 + 0.4191 = 0.6940$.
Prediction $\hat y = \sigma(0.6940) \approx 0.6668$.
Loss $\mathcal{L} = \tfrac12 (0.6668 - 1)^2 \approx 0.0555$.
Error at output $\delta^{(2)} = (\hat y - y) \cdot \sigma'(o_{\text{in}})
= -0.3332 \cdot 0.6668 \cdot 0.3332 \approx -0.0740$.
Gradient $\frac{\partial \mathcal{L}}{\partial W^{(2)}_j} = \delta^{(2)} \cdot h_j$.
$\nabla W^{(2)} \approx (-0.0740 \cdot 0.5498,\ -0.0740 \cdot 0.5987)
\approx (-0.0407,\ -0.0443)$.
Updated $W^{(2)} \leftarrow W^{(2)} - \eta \nabla W^{(2)}
= (0.5, 0.7) - 0.5 \cdot (-0.0407, -0.0443) \approx (0.5204, 0.7222)$.

**S2.2**
$$
\frac{\partial \mathcal{L}}{\partial W^{(1)}_{1,1}}
= \underbrace{(\hat y - y)}_{\text{loss grad}}
\cdot \underbrace{\sigma'(o_{\text{in}})}_{\text{output act}}
\cdot \underbrace{W^{(2)}_1}_{\text{upstream weight}}
\cdot \underbrace{\sigma'(h_{\text{in},1})}_{\text{hidden act}}
\cdot \underbrace{x_1}_{\text{input}}.
$$

### S3

**S3.1** Valid convolution (output $2\times 2$):
- $(0,0)$: $1\cdot 1 + 2\cdot 0 + 3\cdot 0 + 1\cdot(-1) = 0$
- $(0,1)$: $2\cdot 1 + 0\cdot 0 + 1\cdot 0 + 2\cdot(-1) = 0$
- $(1,0)$: $3\cdot 1 + 1\cdot 0 + 0\cdot 0 + 1\cdot(-1) = 2$
- $(1,1)$: $1\cdot 1 + 2\cdot 0 + 1\cdot 0 + 3\cdot(-1) = -2$

Conv output $= \begin{pmatrix} 0 & 0 \\ 2 & -2 \end{pmatrix}$.
$2{\times}2$ max-pool on a $2{\times}2$ map with stride 1 gives a scalar: $\max = 2$.

**S3.2**
- After conv1 (k=5, p=2, s=1): $(16, 64, 64)$.
- After pool (2): $(16, 32, 32)$.
- After conv2 (k=3, p=0, s=1): $(32, 30, 30)$.
- After pool (2): $(32, 15, 15)$.

Flattened size $= 32 \cdot 15 \cdot 15 = 7200$.

### S4

**S4.1** For a mini-batch activation $x$ with mean $\mu_B$ and variance
$\sigma_B^2$: $\hat x = \frac{x - \mu_B}{\sqrt{\sigma_B^2 + \epsilon}}$,
then $y = \gamma \hat x + \beta$ with learnable $\gamma, \beta$.
Benefits: (i) reduces internal covariate shift → allows higher learning
rates; (ii) mild regulariser; (iii) faster / more stable convergence.

**S4.2** During training, dropout randomly zeroes each activation with prob
$p$ and scales the surviving ones by $1/(1-p)$ (inverted dropout). At
inference it is the identity (all units active, no scaling). The reason: at
test time we want the full ensemble; the $1/(1-p)$ training scale keeps the
expected activation magnitude identical across the two regimes, so no
re-calibration is needed.

### S5

**S5.1** Train the autoencoder on spectrograms of *clean / normal* playback.
It learns to reconstruct them with low error. At inference, feed a new
spectrogram: if the reconstruction error (e.g. MSE on the mel bins) exceeds
a threshold, flag it as anomalous — clicks, dropouts, or CPU-spike glitches
reconstruct poorly because the decoder has never seen them.

**S5.2** $\cos(e_a, e_b) = \frac{1\cdot 0.5 + 0 + 1}{\sqrt 2 \cdot \sqrt{1.5}}
= \frac{1.5}{1.732} \approx 0.866$.
$\cos(e_a, e_c) = \frac{1+0+0}{\sqrt 2 \cdot \sqrt 2} = 0.5$.
$\cos(e_b, e_c) = \frac{0.5 + 0.5 + 0}{\sqrt{1.5} \cdot \sqrt 2}
= \frac{1}{1.732} \approx 0.577$.
→ $e_b$ is more similar to $e_c$ than $e_a$ is.

### S6

**S6.1** Dataset hyperparameters (model architecture *excluded*):
- input window length (e.g. 512 samples)
- prediction horizon (1 sample, $n$ samples)
- sampling rate of the signal
- stride between consecutive training windows
- train/val/test split ratio and split *method* (random vs temporal)
- batch size
- shuffling policy (no shuffling across time if temporal)
- normalisation / standardisation scheme
- (optional) target smoothing, data augmentation

**S6.2**
- **Forget gate** $f_t$: decides *how much of the previous cell state to keep*.
- **Input gate** $i_t$: decides *how much of the new candidate information
  to write into the cell state*.
- **Output gate** $o_t$: decides *how much of the (updated) cell state to
  expose as the hidden output* at this time step.

### S7

**S7.1**
- Vocabulary $V = \{\text{SynthDef}, \text{kick}, \text{plays}, \text{loud}\}$,
  size 4 — indices e.g. 0..3.
- One-hot (length 4):
  `SynthDef = (1,0,0,0)`, `kick = (0,1,0,0)`, `plays = (0,0,1,0)`, `loud = (0,0,0,1)`.
- Bag-of-words (counts):
  Doc 1 `"SynthDef kick plays"` → $(1,1,1,0)$.
  Doc 2 `"kick plays loud"` → $(0,1,1,1)$.

**S7.2** IDF rewards rarity. Both *kick* and *plays* have document frequency 2
in a corpus of size 2 → IDF of both is near zero for *this* toy corpus, so
they'd actually tie. But in your real jams corpus, *plays* is common across
thousands of blocks (low IDF) while *kick* is rarer (high IDF). BM25's score
includes the factor $\log\!\left(1 + \frac{N - \text{df} + 0.5}{\text{df} + 0.5}\right)$ —
rarer term → higher IDF → higher BM25 score when it matches the query.

### S8

**S8.1**
$QK^\top = \begin{pmatrix} 1 & 0 \\ 0 & 1 \end{pmatrix}
\begin{pmatrix} 1 & 0 \\ 1 & 1 \end{pmatrix}
= \begin{pmatrix} 1 & 0 \\ 1 & 1 \end{pmatrix}.$
Divide by $\sqrt{d_k} = \sqrt 2 \approx 1.414$:
$\tfrac{QK^\top}{\sqrt{d_k}} \approx \begin{pmatrix} 0.707 & 0 \\ 0.707 & 0.707 \end{pmatrix}.$
Row-wise softmax:
- Row 1: $\frac{(e^{0.707}, e^{0})}{e^{0.707}+e^{0}}
  = \frac{(2.028, 1)}{3.028} \approx (0.670, 0.330)$.
- Row 2: both entries equal $0.707$ → softmax $= (0.5, 0.5)$.
Multiply by $V = \begin{pmatrix} 2 & 0 \\ 0 & 3 \end{pmatrix}$:
- Row 1: $0.670 \cdot (2,0) + 0.330 \cdot (0,3) = (1.340,\ 0.990)$.
- Row 2: $0.5 \cdot (2,0) + 0.5 \cdot (0,3) = (1.000,\ 1.500)$.

$$
\text{Attention}(Q,K,V) \approx \begin{pmatrix} 1.340 & 0.990 \\ 1.000 & 1.500 \end{pmatrix}.
$$

**S8.2**
Advantages: (i) fully parallel over the sequence (no recurrence) →
trains much faster on GPUs; (ii) direct access from any position to any
other position (no signal decay), so long-range dependencies are captured.
Disadvantages: (i) $O(n^2)$ memory and compute in sequence length $n$ →
doesn't scale naïvely to very long sequences; (ii) has no built-in
notion of order → needs positional encodings bolted on.

### S9

**S9.1**
- **Pre-training**: self-supervised training of a generic model on a huge,
  broad dataset (e.g. next-token prediction on trillions of tokens).
- **Fine-tuning**: continuing to train a pre-trained model on a smaller,
  task-specific dataset to specialise it.
- **LoRA**: a parameter-efficient fine-tuning method that freezes the base
  weights $W$ and learns a low-rank update $\Delta W = BA$ with
  $\operatorname{rank}(BA) \ll \operatorname{rank}(W)$.
- **Quantisation**: representing weights (and sometimes activations) with
  fewer bits than the training precision (e.g. 4-bit instead of 16-bit) to
  save memory and often speed up inference.

**S9.2** **LoRA fine-tune is the best fit.** (i) Training from scratch is
infeasible — 3 B parameters need trillions of tokens and enterprise
hardware. (ii) Full fine-tuning a 3 B model needs ~30 GB VRAM and lots of
data to avoid catastrophic forgetting. (iii) RAG alone works but keeps
your dialect *outside* the weights — the model has to re-discover it each
prompt. LoRA on ~1 400 blocks (expanded with FIM augmentation to ~10 000
training samples) runs in a few hours on a mid-range GPU, produces ~200 MB
of adapters, and bakes the naming/idiom conventions into the model itself.
RAG on top of LoRA is then additive: style from weights, novelty from
retrieval.

### S10

**S10.1** Annotated:
```python
class TextModel(nn.Module):
    def __init__(self, vocab, dim, L):
        super().__init__()                        # PyTorch module init
        self.emb  = nn.Embedding(vocab, dim)      # lookup: token id → dim-vector
        self.flat = nn.Flatten()                  # reshape (B, L, dim) → (B, L*dim)
        self.fc   = nn.Linear(dim * L, 1)         # single logit output
    def forward(self, x):                         # x: (B, L) integer token ids
        x = self.emb(x)                           # (B, L, dim)
        x = self.flat(x)                          # (B, L*dim)
        return torch.sigmoid(self.fc(x))          # (B, 1) in (0,1)
```
A single-logit sigmoid output over a fixed-length token window → **binary
text classification** (e.g. sentiment, spam/not-spam, toxic/not-toxic).

**S10.2** Input `(1, 28, 28)` → conv1 (k=3, p=1) keeps 28×28 → 32 channels:
`(32, 28, 28)`. Pool (2): `(32, 14, 14)`. Conv2 (k=3, p=1) keeps 14×14 → 64
channels: `(64, 14, 14)`. Pool (2): `(64, 7, 7)`. After flatten:
$64 \cdot 7 \cdot 7 = \boxed{3136}$.

### S11

**S11.1** NAND: $w_1 = -1$, $w_2 = -1$, $b = 1.5$.
Threshold $\sigma(z) = 1$ if $z \ge 0$.

| $x_1$ | $x_2$ | $z = w_1 x_1 + w_2 x_2 + b$ | $\sigma(z)$ |
|------:|------:|----------------------------:|------------:|
| 0 | 0 | $1.5$  | 1 |
| 0 | 1 | $0.5$  | 1 |
| 1 | 0 | $0.5$  | 1 |
| 1 | 1 | $-0.5$ | 0 |

Matches NAND truth table. ✔

**S11.2** $A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}$,
$\text{tr} = 4$, $\det = 3$.
$\lambda^2 - 4\lambda + 3 = 0 \Rightarrow (\lambda - 1)(\lambda - 3) = 0$
→ $\lambda_1 = 3$, $\lambda_2 = 1$.

PCA on a 2-D dataset with this covariance would identify the direction of
the eigenvector for $\lambda = 3$ (the diagonal $(1,1)/\sqrt 2$) as PC1 —
capturing 75 % of total variance ($3 / (3+1)$) — and the orthogonal
direction as PC2.

### S12

**S12.1** Pick:
- $u = 1$ (input contributes its value),
- $w = 1$ (carry the running count forward),
- $v = 1$ (pass count to output),
- hidden activation: linear (identity),
- $h_0 = 0$,
- output activation: linear.

Recurrence $h_t = u \cdot x_t + w \cdot h_{t-1} = x_t + h_{t-1}$.

Trace on $(1, 0, 1, 1, 0)$:

| $t$  | $x_t$ | $h_t$ | $y_t = v h_t$ |
|------|------:|------:|--------------:|
| 1    | 1     | 1     | 1             |
| 2    | 0     | 1     | 1             |
| 3    | 1     | 2     | 2             |
| 4    | 1     | 3     | 3             |
| 5    | 0     | 3     | 3             |

Matches the cumulative-count specification. ✔
(2020-Q11's "green-frog counter" uses the same trick with $u = w = v = 1$;
a *sum-of-last-two* RNN would use $w = 0$ and a 2-step input window.)

**S12.2** With `t.shape = (2, 2, 3)`:
- `t[1, 0, :]` → block 1, row 0, all cols → `[7, 8, 9]`.
- `t[:, 1, 2]` → for each block, row 1, col 2 → `[6, 12]`.
- `t[0, :, 1]` → block 0, all rows, col 1 → `[2, 5]`.

### S13

**S13.1** Forgery sketch:

1. **Architecture:** conditional GAN (or modern diffusion model conditioned
   on text) — generator $G(z, c)$ where $c$ encodes target text.
2. **Dataset:** ≥ 1 000 images of the victim's handwriting, labelled with
   the written content, normalised for stroke width and slant.
3. **Training:** alternate updates of $G$ and discriminator $D$; adversarial
   loss plus perceptual loss against handwriting features (stroke geometry).
4. **Inference:** sample $z \sim \mathcal N(0, I)$, feed forgery text as $c$,
   pick the most realistic of $k$ candidates.

*Defences:* (i) train a forensic classifier on real-vs-GAN handwriting
(GAN outputs have characteristic frequency-domain artefacts);
(ii) embed cryptographic / steganographic provenance signatures in genuine
documents; (iii) require physical pen-pressure / motion-capture metadata
that raster GANs can't replicate.

**S13.2** LLMs are trained to maximise the likelihood of the next token, not
to track truth — they have no internal "I don't know" signal, so when the
weights have weak evidence they emit the *most plausible-looking* string
rather than abstaining. This is hallucination *by construction*, not a bug.
The Envil plugin mitigates it by retrieving real code blocks from the user's
own corpus (BM25 over [00_band_repo](../../../00_band_repo)) and injecting
them into the prompt, so the model is asked to *adapt* known-correct snippets
rather than invent UGen names from scratch. RAG anchors generation to a
verified knowledge base.

---

## Appendix — Quick study plan (2 weeks, ~6 h/week)

| Day | Focus | Deliverable |
|-----|-------|-------------|
| 1 | Re-derive FNN forward+backward on paper, using 2024-Q5 numbers | handwritten page |
| 2 | Redo Part 3 T1–T3 without peeking | check against S1–S3 |
| 3 | Read Chollet 3E Ch.11 (text + embeddings) | margin notes |
| 4 | T5 + T7 + open [tokenize.js](../../suggestions/tokenize.js) | add a unit test |
| 5 | Read Chollet 3E Ch.12 (attention + transformers) | hand-draw the architecture |
| 6 | Redo T8 from scratch with new numbers you invent | self-checked |
| 7 | Rest / integration ride-along: run `Ctrl+Alt+Space` in 3 jam files and note what you'd change about the prompt | journal entry |
| 8 | Read Chollet 3E Ch.12 (pre-trained, fine-tuning) | margin notes |
| 9 | T9 + read one LoRA paper abstract (Hu et al. 2021) | one-page summary |
| 10| Full mock: redo the whole 2024 exam in 60 min | score yourself |
| 11| Address weakest 3 questions, redo drills on them | 2nd handwritten page |
| 12| Sketch exam answers for ethics/week 21 topic | 3-bullet draft |

Good luck — you're closer to the material than you think.
