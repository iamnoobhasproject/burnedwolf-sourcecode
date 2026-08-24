// ==========================================================================
// --- BURNEDWOLF AI — WIRE PROTOCOLS ---
// ==========================================================================
// Every vendor is reduced to three shapes on the wire:
//   openai     /chat/completions      (OpenAI, xAI, Groq, DeepSeek, Mistral,
//                                      OpenRouter, Cohere-compat, Ollama, custom)
//   anthropic  /messages
//   gemini     /v1beta/models/{m}:generateContent
//
// Everything above this file speaks ONE normalised format:
//   message  { role:'system'|'user'|'assistant'|'tool', content, toolCalls[], toolCallId, name }
//   toolCall { id, name, args }
//   tool     { name, description, parameters }   ← plain JSON Schema
//   reply    { text, toolCalls[], usage:{in,out}, rateLimit, finish }
//
// No SDKs: raw node http/https only, so the packed app carries no extra deps
// and works behind the same DPI bypass the rest of the program provides.

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { CURRENT_VERSION } = require('../constants');

const UA = `BurnedWolf/${CURRENT_VERSION}`;

// ---------------------------------------------------------------- transport
function request(url, { method = 'GET', headers = {}, body = null, timeout = 120000 } = {}) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(url); } catch (e) { resolve({ ok: false, status: 0, error: 'bad_url' }); return; }
        const lib = u.protocol === 'http:' ? http : https;
        const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
        const req = lib.request({
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'http:' ? 80 : 443),
            path: u.pathname + u.search,
            method,
            timeout,
            headers: Object.assign({
                'User-Agent': UA,
                'Accept': 'application/json',
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
            }, headers)
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) { /* keep raw */ }
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json,
                    text: data,
                    headers: res.headers
                });
            });
        });
        req.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, status: 0, error: 'timeout' }); });
        if (payload) req.write(payload);
        req.end();
    });
}

// Providers advertise their remaining quota in headers; surfacing it is what
// makes the in-app "AI limit" gauge real instead of decorative.
function readRateLimit(h) {
    if (!h) return null;
    const pick = (...names) => { for (const n of names) if (h[n] != null) return h[n]; return null; };
    const out = {
        requestsRemaining: pick('x-ratelimit-remaining-requests', 'x-ratelimit-remaining-requests-day', 'ratelimit-remaining'),
        tokensRemaining:   pick('x-ratelimit-remaining-tokens'),
        requestsLimit:     pick('x-ratelimit-limit-requests', 'ratelimit-limit'),
        tokensLimit:       pick('x-ratelimit-limit-tokens'),
        reset:             pick('x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'ratelimit-reset', 'retry-after')
    };
    return Object.values(out).some(v => v != null) ? out : null;
}

// Vendors disagree on error shapes; users only care about the sentence.
function errorMessage(res) {
    if (!res) return 'unknown_error';
    if (res.error) return res.error;
    const j = res.json;
    if (j) {
        if (typeof j.error === 'string') return j.error;
        if (j.error && j.error.message) return j.error.message;
        if (j.message) return j.message;
        if (j.detail) return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    }
    if (res.text) return String(res.text).slice(0, 300);
    return `HTTP ${res.status}`;
}

function baseUrl(cfg) {
    return String(cfg.endpoint || '').replace(/\/+$/, '');
}

// ==========================================================================
// OPENAI-COMPATIBLE
// ==========================================================================
function openaiHeaders(cfg) {
    const h = {};
    if (cfg.apiKey) h['Authorization'] = `Bearer ${cfg.apiKey}`;
    if (cfg.providerId === 'openrouter') {
        // OpenRouter attributes traffic with these; without them free models
        // get deprioritised.
        h['HTTP-Referer'] = 'https://github.com/iamnoobhasproject';
        h['X-Title'] = 'BurnedWolf';
    }
    return h;
}

function toOpenAiMessages(messages) {
    return messages.map(m => {
        if (m.role === 'tool') {
            return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
            return {
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
                }))
            };
        }
        return { role: m.role, content: String(m.content ?? '') };
    });
}

async function openaiChat(cfg, { messages, tools, temperature, maxTokens }) {
    const body = {
        model: cfg.model,
        messages: toOpenAiMessages(messages),
        temperature: temperature != null ? temperature : 0.35,
        max_tokens: maxTokens || 1600
    };
    if (tools && tools.length) {
        body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        body.tool_choice = 'auto';
    }
    const res = await request(`${baseUrl(cfg)}/chat/completions`, { method: 'POST', headers: openaiHeaders(cfg), body });
    if (!res.ok) return { ok: false, status: res.status, error: errorMessage(res) };

    const choice = res.json && res.json.choices && res.json.choices[0];
    const msg = (choice && choice.message) || {};
    const toolCalls = (msg.tool_calls || []).map(tc => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = { _raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, args };
    });
    const u = (res.json && res.json.usage) || {};
    return {
        ok: true,
        text: typeof msg.content === 'string' ? msg.content : '',
        toolCalls,
        finish: choice && choice.finish_reason,
        usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
        rateLimit: readRateLimit(res.headers)
    };
}

async function openaiModels(cfg) {
    const res = await request(`${baseUrl(cfg)}/models`, { headers: openaiHeaders(cfg), timeout: 15000 });
    if (!res.ok) return { ok: false, error: errorMessage(res) };
    const list = (res.json && (res.json.data || res.json.models)) || [];
    return {
        ok: true,
        models: list.map(m => {
            const id = m.id || m.name;
            if (!id) return null;
            const out = { id, label: m.name && m.name !== id ? m.name : undefined };
            // OpenRouter publishes real per-model pricing as USD-per-token
            // strings. That is the authoritative answer to "is this free?", so
            // convert it to the catalog's per-1M-token shape.
            if (m.pricing && m.pricing.prompt != null) {
                const inTok = Number(m.pricing.prompt);
                const outTok = Number(m.pricing.completion);
                if (Number.isFinite(inTok) && Number.isFinite(outTok)) {
                    out.price = { in: inTok * 1e6, out: outTok * 1e6 };
                }
            }
            const ctx = m.context_length || m.context_window || (m.top_provider && m.top_provider.context_length);
            if (ctx) out.ctx = ctx;
            return out;
        }).filter(Boolean)
    };
}

// ==========================================================================
// ANTHROPIC
// ==========================================================================
function anthropicHeaders(cfg) {
    return {
        'x-api-key': cfg.apiKey || '',
        'anthropic-version': '2023-06-01'
    };
}

function toAnthropic(messages) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            // Tool results ride on a user turn; merge consecutive ones.
            const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
            const last = out[out.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every(c => c.type === 'tool_result')) last.content.push(block);
            else out.push({ role: 'user', content: [block] });
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
            const content = [];
            if (m.content) content.push({ type: 'text', text: String(m.content) });
            for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
            out.push({ role: 'assistant', content });
            continue;
        }
        out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') });
    }
    return { system, messages: out };
}

async function anthropicChat(cfg, { messages, tools, temperature, maxTokens }) {
    const { system, messages: msgs } = toAnthropic(messages);
    const body = {
        model: cfg.model,
        max_tokens: maxTokens || 1600,
        temperature: temperature != null ? temperature : 0.35,
        messages: msgs
    };
    if (system) body.system = system;
    if (tools && tools.length) {
        body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const res = await request(`${baseUrl(cfg)}/messages`, { method: 'POST', headers: anthropicHeaders(cfg), body });
    if (!res.ok) return { ok: false, status: res.status, error: errorMessage(res) };

    const blocks = (res.json && res.json.content) || [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
    const u = (res.json && res.json.usage) || {};
    return {
        ok: true,
        text,
        toolCalls,
        finish: res.json && res.json.stop_reason,
        usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 },
        rateLimit: readRateLimit(res.headers)
    };
}

async function anthropicModels(cfg) {
    const res = await request(`${baseUrl(cfg)}/models?limit=100`, { headers: anthropicHeaders(cfg), timeout: 15000 });
    if (!res.ok) return { ok: false, error: errorMessage(res) };
    const list = (res.json && res.json.data) || [];
    return { ok: true, models: list.filter(m => m.id).map(m => ({ id: m.id, label: m.display_name || undefined })) };
}

// ==========================================================================
// GOOGLE GEMINI
// ==========================================================================
function toGemini(messages) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const contents = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'tool') {
            let parsed;
            try { parsed = JSON.parse(m.content); } catch (e) { parsed = { result: String(m.content ?? '') }; }
            contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response: (parsed && typeof parsed === 'object') ? parsed : { result: parsed } } }] });
            continue;
        }
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length) {
            const parts = [];
            if (m.content) parts.push({ text: String(m.content) });
            for (const tc of m.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
            contents.push({ role: 'model', parts });
            continue;
        }
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content ?? '') }] });
    }
    return { system, contents };
}

// Gemini rejects the JSON-Schema keywords it doesn't implement, so strip them.
function geminiSchema(s) {
    if (!s || typeof s !== 'object') return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
        if (k === 'additionalProperties' || k === '$schema' || k === 'default' || k === 'examples') continue;
        if (k === 'properties' && v && typeof v === 'object') {
            out.properties = {};
            for (const [pk, pv] of Object.entries(v)) out.properties[pk] = geminiSchema(pv);
        } else if (k === 'items') {
            out.items = geminiSchema(v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

async function geminiChat(cfg, { messages, tools, temperature, maxTokens }) {
    const { system, contents } = toGemini(messages);
    const body = {
        contents,
        generationConfig: {
            temperature: temperature != null ? temperature : 0.35,
            maxOutputTokens: maxTokens || 1600
        }
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools && tools.length) {
        body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
    }
    const url = `${baseUrl(cfg)}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`;
    const res = await request(url, { method: 'POST', body });
    if (!res.ok) return { ok: false, status: res.status, error: errorMessage(res) };

    const cand = res.json && res.json.candidates && res.json.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.filter(p => p.text).map(p => p.text).join('');
    const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
        id: `gem_${Date.now()}_${i}`,
        name: p.functionCall.name,
        args: p.functionCall.args || {}
    }));
    const u = (res.json && res.json.usageMetadata) || {};
    return {
        ok: true,
        text,
        toolCalls,
        finish: cand && cand.finishReason,
        usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 },
        rateLimit: readRateLimit(res.headers)
    };
}

async function geminiModels(cfg) {
    const res = await request(`${baseUrl(cfg)}/v1beta/models?key=${encodeURIComponent(cfg.apiKey || '')}&pageSize=200`, { timeout: 15000 });
    if (!res.ok) return { ok: false, error: errorMessage(res) };
    const list = (res.json && res.json.models) || [];
    return {
        ok: true,
        models: list
            .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
            .map(m => {
                const id = String(m.name || '').replace(/^models\//, '');
                if (!id) return null;
                return { id, label: m.displayName || undefined, ctx: m.inputTokenLimit || undefined };
            })
            .filter(Boolean)
    };
}

// ==========================================================================
// DISPATCH
// ==========================================================================
// cfg = { providerId, protocol, endpoint, apiKey, model }
function chat(cfg, opts) {
    switch (cfg.protocol) {
        case 'anthropic': return anthropicChat(cfg, opts);
        case 'gemini':    return geminiChat(cfg, opts);
        default:          return openaiChat(cfg, opts);
    }
}

function listModels(cfg) {
    switch (cfg.protocol) {
        case 'anthropic': return anthropicModels(cfg);
        case 'gemini':    return geminiModels(cfg);
        default:          return openaiModels(cfg);
    }
}

module.exports = { chat, listModels, request };
