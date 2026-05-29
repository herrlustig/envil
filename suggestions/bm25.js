// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Small BM25 ranker over the block corpus.
// Pure JS, no deps.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const K1 = 1.5;
const B  = 0.75;

class BM25 {
    /**
     * Accepts either an array of token arrays, or an array of {tokens}.
     * @param {Array<string[]>|Array<{tokens:string[]}>} docs
     */
    constructor(docs) {
        this.docs = docs;
        this.N = docs.length;

        // Document frequency (how many docs contain each term)
        this.df = new Map();
        // Term frequency per doc
        this.tfs = new Array(this.N);
        this.docLen = new Array(this.N);
        let totalLen = 0;

        for (let i = 0; i < this.N; i++) {
            const d = docs[i];
            const tokens = Array.isArray(d) ? d : (d && d.tokens) || [];
            const tf = new Map();
            for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
            this.tfs[i] = tf;
            this.docLen[i] = tokens.length;
            totalLen += tokens.length;
            for (const t of tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
        }
        this.avgLen = this.N > 0 ? totalLen / this.N : 1;

        // Precompute IDF  ln((N-df+0.5)/(df+0.5) + 1)
        this.idf = new Map();
        for (const [t, df] of this.df) {
            const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
            this.idf.set(t, idf);
        }
    }

    /**
     * @param {string[]} queryTokens
     * @param {number} k
     * @returns {Array<{index:number, score:number}>}
     */
    search(queryTokens, k = 10) {
        if (this.N === 0 || !queryTokens || queryTokens.length === 0) return [];

        // Dedupe query tokens, but keep multiplicity to a max of 2 to avoid
        // query-spam dominance
        const qCount = new Map();
        for (const t of queryTokens) qCount.set(t, Math.min(2, (qCount.get(t) || 0) + 1));

        const scores = new Float64Array(this.N);
        for (const [term, qf] of qCount) {
            const idf = this.idf.get(term);
            if (!idf) continue;
            for (let i = 0; i < this.N; i++) {
                const tf = this.tfs[i].get(term);
                if (!tf) continue;
                const dl = this.docLen[i];
                const num   = tf * (K1 + 1);
                const denom = tf + K1 * (1 - B + B * dl / this.avgLen);
                scores[i] += qf * idf * (num / denom);
            }
        }

        // Collect top-k
        const out = [];
        for (let i = 0; i < this.N; i++) {
            if (scores[i] > 0) out.push({ index: i, score: scores[i] });
        }
        out.sort((a, b) => b.score - a.score);
        return out.slice(0, k);
    }
}

module.exports = { BM25 };
