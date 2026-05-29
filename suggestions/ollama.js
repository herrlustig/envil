// @ts-nocheck
// ─────────────────────────────────────────────────────────────────────────────
// Minimal Ollama HTTP client (no external deps, uses node http).
//
// Exposes:
//   - isAvailable(endpoint)   → boolean
//   - listModels(endpoint)    → string[]
//   - generateFIM({ endpoint, model, prefix, suffix, options, signal }) → Promise<string>
//
// FIM is done via the /api/generate endpoint with Qwen / DeepSeek / StarCoder
// tokens. We auto-pick the template based on the model name.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function httpJson(endpoint, body, { method = 'POST', signal, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(endpoint); } catch (e) { return reject(e); }
        const mod = u.protocol === 'https:' ? https : http;
        const payload = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method,
            headers: payload ? {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
            } : {},
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const txt = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(txt)); } catch (_e) { resolve(txt); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${txt.slice(0, 200)}`));
                }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
        if (signal) {
            const onAbort = () => { req.destroy(new Error('aborted')); };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        if (payload) req.write(payload);
        req.end();
    });
}

async function isAvailable(endpoint) {
    const url = endpoint.replace(/\/+$/, '') + '/api/tags';
    try {
        const r = await httpJson(url, null, { method: 'GET', timeoutMs: 1500 });
        return !!r;
    } catch (_e) { return false; }
}

async function listModels(endpoint) {
    const url = endpoint.replace(/\/+$/, '') + '/api/tags';
    try {
        const r = await httpJson(url, null, { method: 'GET', timeoutMs: 3000 });
        if (r && Array.isArray(r.models)) return r.models.map(m => m.name);
    } catch (_e) {}
    return [];
}

// ── FIM prompt templates ─────────────────────────────────────────────────────

function buildFIMPrompt(model, prefix, suffix, ragContext = '') {
    const name = (model || '').toLowerCase();
    const ctx = ragContext
        ? `// Reference examples from the user's past sessions and SC help:\n${ragContext}\n\n`
        : '';

    // Qwen 2.5 Coder
    if (name.includes('qwen')) {
        return `<|fim_prefix|>${ctx}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    }
    // DeepSeek Coder (v1)
    if (name.includes('deepseek')) {
        return `<｜fim▁begin｜>${ctx}${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`;
    }
    // StarCoder2 / StarCoder
    if (name.includes('starcoder')) {
        return `<fim_prefix>${ctx}${prefix}<fim_suffix>${suffix}<fim_middle>`;
    }
    // CodeLlama
    if (name.includes('codellama')) {
        return `<PRE> ${ctx}${prefix} <SUF>${suffix} <MID>`;
    }
    // CodeGemma
    if (name.includes('codegemma') || name.includes('gemma')) {
        return `<|fim_prefix|>${ctx}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    }
    // Default to Qwen template — that's our recommended model anyway
    return `<|fim_prefix|>${ctx}${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
}

function stopTokens(model) {
    const name = (model || '').toLowerCase();
    if (name.includes('qwen') || name.includes('gemma')) {
        return ['<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '<|repo_name|>'];
    }
    if (name.includes('deepseek')) return ['<｜end▁of▁sentence｜>'];
    if (name.includes('starcoder')) return ['<|endoftext|>', '<file_sep>'];
    if (name.includes('codellama')) return ['<EOT>'];
    return ['<|endoftext|>'];
}

async function generateFIM({
    endpoint, model, prefix, suffix, ragContext = '',
    temperature = 0.2, numPredict = 256, signal, timeoutMs = 20000,
}) {
    const url = endpoint.replace(/\/+$/, '') + '/api/generate';
    const body = {
        model,
        prompt: buildFIMPrompt(model, prefix, suffix, ragContext),
        stream: false,
        raw: true,
        options: {
            temperature,
            num_predict: numPredict,
            stop: stopTokens(model),
        },
    };
    const r = await httpJson(url, body, { timeoutMs, signal });
    if (r && typeof r.response === 'string') return r.response;
    return '';
}

// Plain chat (non-FIM), for explicit "//? describe what you want" compose
async function generateChat({
    endpoint, model, prompt, ragContext = '',
    temperature = 0.3, numPredict = 400, signal, timeoutMs = 30000,
}) {
    const url = endpoint.replace(/\/+$/, '') + '/api/generate';
    const system =
`You are an inline code-completion assistant for SuperCollider live coding.
Return ONLY raw SuperCollider code — no prose, no explanations, no markdown fences.
Match the user's variable and proxy names (e.g. ~out, ~mcr_N) and coding style.`;
    const fullPrompt = `${system}\n\n${ragContext ? 'Reference:\n' + ragContext + '\n\n' : ''}Request:\n${prompt}\n\nCode:\n`;
    const body = {
        model,
        prompt: fullPrompt,
        stream: false,
        options: { temperature, num_predict: numPredict },
    };
    const r = await httpJson(url, body, { timeoutMs, signal });
    if (r && typeof r.response === 'string') {
        // Strip ``` fences if the model slipped them in
        return r.response.replace(/^```[a-zA-Z]*\s*\n?|\n?```$/g, '').trim();
    }
    return '';
}

module.exports = {
    isAvailable, listModels,
    buildFIMPrompt, stopTokens,
    generateFIM, generateChat,
};
