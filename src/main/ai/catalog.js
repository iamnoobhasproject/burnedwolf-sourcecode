// ==========================================================================
// --- BURNEDWOLF AI — PROVIDER & MODEL CATALOG ---
// ==========================================================================
// A curated, offline-available description of every AI provider the app can
// talk to: which wire protocol it speaks, where the user gets a key, whether
// there is a genuinely free tier, and reference pricing.
//
// Model line-ups and prices change constantly. This catalog is the OFFLINE
// FALLBACK; whenever the user has a working key, ai/providers.js fetches the
// live model list (with live pricing where the provider publishes it) so the
// picker never goes stale.
//
// HOW "FREE" IS DECIDED (this was wrong in 3.0.0 and is worth spelling out):
// free-ness is almost always a property of the ACCOUNT TIER, not of the model.
// On Groq, Mistral and Cohere every listed model runs at zero cost on the free
// tier — they are only billed if you upgrade. Marking such a model "Paid"
// because it has a per-token list price is simply false.
//
// So each provider declares `freeAccess`, and per-model tier is DERIVED:
//   'all'       every model is usable at zero cost (rate-limited free tier)
//   'per-model' free-ness differs per model → read it from live pricing
//               (OpenRouter: pricing.prompt === "0")
//   'none'      credit required before the first request
//   'local'     runs on the user's own machine; no key, no cost, no limit
//
// `price` is the USD-per-1M-token list price. It is what you pay AFTER the free
// tier, so a model can legitimately be both "free to use" and have a price.
// Prices move; they are labelled as reference values in the UI and every
// provider card links to its live pricing page.

const PROVIDERS = [
    {
        id: 'gemini',
        name: 'Google Gemini',
        protocol: 'gemini',
        freeAccess: 'all',          // AI Studio free tier, no card, rate-limited
        freeQuota: 'gemini',
        accent: '#5b9dff',
        keysUrl:     'https://aistudio.google.com/apikey',
        pricingUrl:  'https://ai.google.dev/pricing',
        docsUrl:     'https://ai.google.dev/gemini-api/docs',
        keyPrefix:   'AIza',
        endpoint:    'https://generativelanguage.googleapis.com',
        freeNote:    'gemini_free',          // i18n key: ai.free.<value>
        recommended: true,
        models: [
            { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      ctx: 1000000, price: { in: 0.30, out: 2.50  }, tags: ['fast', 'tools'], best: true },
            { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        ctx: 1000000, price: { in: 1.25, out: 10.00 }, tags: ['smart', 'tools'] },
            { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', ctx: 1000000, price: { in: 0.10, out: 0.40  }, tags: ['cheap', 'fast'] },
            { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash',      ctx: 1000000, price: { in: 0.10, out: 0.40  }, tags: ['fast', 'tools'] }
        ]
    },
    {
        id: 'openai',
        name: 'OpenAI · ChatGPT',
        protocol: 'openai',
        freeAccess: 'none',         // API credit is separate from ChatGPT Plus
        accent: '#10a37f',
        keysUrl:    'https://platform.openai.com/api-keys',
        pricingUrl: 'https://openai.com/api/pricing',
        docsUrl:    'https://platform.openai.com/docs',
        keyPrefix:  'sk-',
        endpoint:   'https://api.openai.com/v1',
        freeNote:   'openai_free',
        models: [
            { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', ctx: 1000000, price: { in: 0.40, out: 1.60  }, tags: ['cheap', 'tools'], best: true },
            { id: 'gpt-4.1',      label: 'GPT-4.1',      ctx: 1000000, price: { in: 2.00, out: 8.00  }, tags: ['smart', 'tools'] },
            { id: 'gpt-4o',       label: 'GPT-4o',       ctx: 128000,  price: { in: 2.50, out: 10.00 }, tags: ['tools'] },
            { id: 'gpt-4o-mini',  label: 'GPT-4o mini',  ctx: 128000,  price: { in: 0.15, out: 0.60  }, tags: ['cheap', 'fast'] },
            { id: 'o4-mini',      label: 'o4-mini',      ctx: 200000,  price: { in: 1.10, out: 4.40  }, tags: ['reasoning'] }
        ]
    },
    {
        id: 'anthropic',
        name: 'Anthropic · Claude',
        protocol: 'anthropic',
        freeAccess: 'none',         // Claude.ai subscription does not cover the API
        accent: '#d97757',
        keysUrl:    'https://console.anthropic.com/settings/keys',
        pricingUrl: 'https://www.anthropic.com/pricing#api',
        docsUrl:    'https://docs.anthropic.com',
        keyPrefix:  'sk-ant-',
        endpoint:   'https://api.anthropic.com/v1',
        freeNote:   'anthropic_free',
        models: [
            { id: 'claude-haiku-4-5',        label: 'Claude Haiku 4.5',  ctx: 200000, price: { in: 1.00, out: 5.00  }, tags: ['fast', 'tools'], best: true },
            { id: 'claude-sonnet-4-5',       label: 'Claude Sonnet 4.5', ctx: 200000, price: { in: 3.00, out: 15.00 }, tags: ['smart', 'tools'] },
            { id: 'claude-opus-4-5',         label: 'Claude Opus 4.5',   ctx: 200000, price: { in: 5.00, out: 25.00 }, tags: ['smart', 'tools'] },
            { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku',  ctx: 200000, price: { in: 0.80, out: 4.00  }, tags: ['cheap'] }
        ]
    },
    {
        id: 'xai',
        name: 'xAI · Grok',
        protocol: 'openai',
        freeAccess: 'none',         // free monthly credits appear on some accounts
        accent: '#c9ced6',
        keysUrl:    'https://console.x.ai',
        pricingUrl: 'https://docs.x.ai/docs/models',
        docsUrl:    'https://docs.x.ai',
        keyPrefix:  'xai-',
        endpoint:   'https://api.x.ai/v1',
        freeNote:   'xai_free',
        models: [
            { id: 'grok-4-fast-non-reasoning', label: 'Grok 4 Fast', ctx: 2000000, price: { in: 0.20, out: 0.50  }, tags: ['fast', 'cheap', 'tools'], best: true },
            { id: 'grok-4',      label: 'Grok 4',      ctx: 256000, price: { in: 3.00, out: 15.00 }, tags: ['smart', 'tools'] },
            { id: 'grok-3',      label: 'Grok 3',      ctx: 131072, price: { in: 3.00, out: 15.00 }, tags: ['tools'] },
            { id: 'grok-3-mini', label: 'Grok 3 mini', ctx: 131072, price: { in: 0.30, out: 0.50  }, tags: ['cheap'] }
        ]
    },
    {
        id: 'openrouter',
        name: 'OpenRouter',
        protocol: 'openai',
        freeAccess: 'per-model',    // ":free" variants cost nothing; the rest bill
        freeQuota: 'openrouter',
        accent: '#8b7cf6',
        keysUrl:    'https://openrouter.ai/keys',
        pricingUrl: 'https://openrouter.ai/models',
        docsUrl:    'https://openrouter.ai/docs',
        keyPrefix:  'sk-or-',
        endpoint:   'https://openrouter.ai/api/v1',
        freeNote:   'openrouter_free',
        recommended: true,
        models: [
            { id: 'deepseek/deepseek-chat-v3.1:free',       label: 'DeepSeek V3.1 (free)',    ctx: 163840,  price: { in: 0, out: 0 }, tags: ['free', 'tools'], best: true },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)',    ctx: 65536,   price: { in: 0, out: 0 }, tags: ['free'] },
            { id: 'google/gemini-2.0-flash-exp:free',       label: 'Gemini 2.0 Flash (free)', ctx: 1048576, price: { in: 0, out: 0 }, tags: ['free'] },
            { id: 'qwen/qwen3-coder:free',                  label: 'Qwen3 Coder (free)',      ctx: 262144,  price: { in: 0, out: 0 }, tags: ['free'] },
            { id: 'anthropic/claude-sonnet-4.5',            label: 'Claude Sonnet 4.5',       ctx: 200000,  price: { in: 3.00, out: 15.00 }, tags: ['smart', 'tools'] },
            { id: 'openai/gpt-4.1-mini',                    label: 'GPT-4.1 mini',            ctx: 1000000, price: { in: 0.40, out: 1.60 },  tags: ['tools'] }
        ]
    },
    {
        id: 'groq',
        name: 'Groq',
        protocol: 'openai',
        freeAccess: 'all',          // every listed model runs free, rate-limited
        freeQuota: 'groq',
        accent: '#f55036',
        keysUrl:    'https://console.groq.com/keys',
        pricingUrl: 'https://groq.com/pricing',
        docsUrl:    'https://console.groq.com/docs',
        keyPrefix:  'gsk_',
        endpoint:   'https://api.groq.com/openai/v1',
        freeNote:   'groq_free',
        recommended: true,
        models: [
            { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', ctx: 131072, price: { in: 0.59, out: 0.79 }, tags: ['fast', 'tools'], best: true },
            { id: 'llama-3.1-8b-instant',    label: 'Llama 3.1 8B',  ctx: 131072, price: { in: 0.05, out: 0.08 }, tags: ['fast'] },
            { id: 'openai/gpt-oss-120b',     label: 'GPT-OSS 120B',  ctx: 131072, price: { in: 0.15, out: 0.75 }, tags: ['tools'] }
        ]
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        protocol: 'openai',
        freeAccess: 'none',
        accent: '#4d6bfe',
        keysUrl:    'https://platform.deepseek.com/api_keys',
        pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        docsUrl:    'https://api-docs.deepseek.com',
        keyPrefix:  'sk-',
        endpoint:   'https://api.deepseek.com/v1',
        freeNote:   'deepseek_free',
        models: [
            { id: 'deepseek-chat',     label: 'DeepSeek Chat',     ctx: 131072, price: { in: 0.28, out: 0.42 }, tags: ['cheap', 'tools'], best: true },
            { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', ctx: 131072, price: { in: 0.28, out: 0.42 }, tags: ['reasoning'] }
        ]
    },
    {
        id: 'mistral',
        name: 'Mistral AI',
        protocol: 'openai',
        freeAccess: 'all',          // free "Experiment" plan covers every model
        freeQuota: 'mistral',
        accent: '#fa5310',
        keysUrl:    'https://console.mistral.ai/api-keys',
        pricingUrl: 'https://mistral.ai/pricing',
        docsUrl:    'https://docs.mistral.ai',
        keyPrefix:  '',
        endpoint:   'https://api.mistral.ai/v1',
        freeNote:   'mistral_free',
        models: [
            { id: 'mistral-small-latest', label: 'Mistral Small', ctx: 131072, price: { in: 0.10, out: 0.30 }, tags: ['tools'], best: true },
            { id: 'mistral-large-latest', label: 'Mistral Large', ctx: 131072, price: { in: 2.00, out: 6.00 }, tags: ['smart', 'tools'] },
            { id: 'open-mistral-nemo',    label: 'Mistral Nemo',  ctx: 131072, price: { in: 0.15, out: 0.15 }, tags: ['cheap'] }
        ]
    },
    {
        id: 'cohere',
        name: 'Cohere',
        protocol: 'openai',
        freeAccess: 'all',          // trial keys reach every model, rate-limited
        freeQuota: 'cohere',
        accent: '#39594d',
        keysUrl:    'https://dashboard.cohere.com/api-keys',
        pricingUrl: 'https://cohere.com/pricing',
        docsUrl:    'https://docs.cohere.com',
        keyPrefix:  '',
        endpoint:   'https://api.cohere.ai/compatibility/v1',
        freeNote:   'cohere_free',
        models: [
            { id: 'command-r7b-12-2024', label: 'Command R7B', ctx: 128000, price: { in: 0.04, out: 0.15  }, tags: ['cheap'], best: true },
            { id: 'command-r-plus',      label: 'Command R+',  ctx: 128000, price: { in: 2.50, out: 10.00 }, tags: ['smart'] }
        ]
    },
    {
        id: 'ollama',
        name: 'Ollama (local)',
        protocol: 'openai',
        freeAccess: 'local',
        freeQuota: 'ollama',
        accent: '#9aa4b2',
        keysUrl:    'https://ollama.com/download',
        pricingUrl: 'https://ollama.com/library',
        docsUrl:    'https://github.com/ollama/ollama/blob/main/docs/api.md',
        keyPrefix:  '',
        endpoint:   'http://localhost:11434/v1',
        noKey:      true,
        freeNote:   'ollama_free',
        recommended: true,
        // Runs entirely on the user's machine: zero cost, zero telemetry, and it
        // keeps working when the connection itself is being filtered.
        models: [
            { id: 'llama3.1:8b', label: 'Llama 3.1 8B', ctx: 131072, price: { in: 0, out: 0 }, tags: ['offline'], best: true },
            { id: 'qwen2.5:7b',  label: 'Qwen 2.5 7B',  ctx: 32768,  price: { in: 0, out: 0 }, tags: ['offline'] },
            { id: 'mistral:7b',  label: 'Mistral 7B',   ctx: 32768,  price: { in: 0, out: 0 }, tags: ['offline'] }
        ]
    },
    {
        id: 'custom',
        name: 'Custom endpoint',
        protocol: 'openai',
        freeAccess: 'per-model',
        accent: '#8b93a3',
        keysUrl:    '',
        pricingUrl: '',
        docsUrl:    '',
        keyPrefix:  '',
        endpoint:   '',
        custom:     true,
        freeNote:   'custom_free',
        models: []
    }
];

// Provider-level badge shown on the picker card. A custom endpoint is whatever
// the user points it at, so it gets its own honest "depends" badge rather than
// borrowing OpenRouter's "free tier".
const TIER_OF_ACCESS = { all: 'freemium', 'per-model': 'freemium', none: 'paid', local: 'local' };
function providerTier(p) {
    return p.custom ? 'depends' : (TIER_OF_ACCESS[p.freeAccess] || 'paid');
}

const byId = {};
for (const p of PROVIDERS) byId[p.id] = p;

function getProvider(id) { return byId[id] || null; }

// THE one place that decides whether a model costs the user anything.
// `price` (list price after the free tier) never decides this on its own —
// that is precisely the bug this replaced.
function deriveTier(provider, model) {
    if (!provider) return 'paid';
    switch (provider.freeAccess) {
        case 'local': return 'local';
        case 'all':   return 'free';
        case 'none':  return 'paid';
        case 'per-model':
        default: {
            const p = model && model.price;
            if (!p) return 'unknown';
            return (Number(p.in) === 0 && Number(p.out) === 0) ? 'free' : 'paid';
        }
    }
}

function decorate(provider, model) {
    return { ...model, tier: deriveTier(provider, model) };
}

// Everything the renderer needs to draw the picker — no secrets included.
function publicCatalog() {
    return PROVIDERS.map(p => ({
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        tier: providerTier(p),
        freeAccess: p.freeAccess,
        freeQuota: p.freeQuota || null,
        accent: p.accent,
        keysUrl: p.keysUrl,
        pricingUrl: p.pricingUrl,
        docsUrl: p.docsUrl,
        endpoint: p.endpoint,
        noKey: !!p.noKey,
        custom: !!p.custom,
        recommended: !!p.recommended,
        freeNote: p.freeNote,
        models: p.models.map(m => decorate(p, m))
    }));
}

// Merge a live model list into the curated metadata. Live entries may carry
// their own pricing (OpenRouter does), which is authoritative — a model the
// catalog never heard of is still classified correctly from it.
function mergeModels(providerId, liveModels) {
    const p = getProvider(providerId);
    const curated = p ? p.models : [];
    const known = new Map(curated.map(m => [m.id, m]));
    const out = [];
    for (const live of liveModels) {
        const id = typeof live === 'string' ? live : live.id;
        if (!id) continue;
        const base = known.get(id);
        known.delete(id);
        const merged = {
            id,
            label: (live && live.label) || (base && base.label) || id,
            ctx: (live && live.ctx) || (base && base.ctx) || null,
            // Live pricing wins; it is the only up-to-date source we have.
            price: (live && live.price) || (base && base.price) || null,
            tags: (base && base.tags) || [],
            best: !!(base && base.best),
            live: true
        };
        out.push(decorate(p, merged));
    }
    // Curated entries the live list didn't mention stay available (some
    // providers hide models from /models but still serve them).
    for (const m of known.values()) out.push({ ...decorate(p, m), live: false });

    // Free first, then best picks, then alphabetical — the ordering the picker
    // wants: what costs nothing should be impossible to miss.
    const rank = (m) => (m.tier === 'free' || m.tier === 'local' ? 0 : 1);
    out.sort((a, b) => (rank(a) - rank(b)) || (Number(b.best) - Number(a.best)) || String(a.label).localeCompare(String(b.label)));
    return out;
}

module.exports = { PROVIDERS, getProvider, publicCatalog, mergeModels, deriveTier };
