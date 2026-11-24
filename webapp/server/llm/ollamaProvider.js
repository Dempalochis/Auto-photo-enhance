// Ollama adapter (LLM plan §5): POST {baseUrl}/api/chat with `format: <JSON schema>`.
// Plain fetch (built into Node 18+), no dependency. think:false because Qwen3.x's thinking phase
// adds latency without helping here; keep_alive keeps the model loaded for the whole batch.
const { timeoutSignal } = require('./provider');

function createOllamaProvider(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(cfg.baseUrl || 'http://localhost:11434').replace(/\/+$/, '');

  async function chat({ messages, jsonSchema, signal }) {
    const t = timeoutSignal(cfg.timeoutMs, signal);
    try {
      const body = {
        model: cfg.model,
        messages,
        stream: false,
        think: false,
        keep_alive: cfg.keepAlive || '10m',
        options: { temperature: cfg.temperature ?? 0.2 },
      };
      if (jsonSchema) body.format = jsonSchema;
      const res = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: t.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`ollama HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }
      const data = await res.json();
      return {
        text: data.message && typeof data.message.content === 'string' ? data.message.content : '',
        usage: { inputTokens: data.prompt_eval_count ?? null, outputTokens: data.eval_count ?? null },
        model: data.model || cfg.model,
        durationMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
      };
    } finally {
      t.clear();
    }
  }

  return {
    name: 'ollama',
    model: cfg.model,
    isLocal: true,
    analyzeImage({ images, systemPrompt, userText, jsonSchema, signal }) {
      return chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText, images: (images || []).map((i) => i.base64) },
        ],
        jsonSchema,
        signal,
      });
    },
    completeText({ systemPrompt, userText, jsonSchema, signal }) {
      return chat({ messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userText }], jsonSchema, signal });
    },
    // GET /api/tags: reachable and the configured model is pulled. Accepts "name" with or
    // without the ":latest" suffix.
    async checkHealth() {
      const t = timeoutSignal(3000);
      try {
        const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: t.signal });
        if (!res.ok) return { status: 'unreachable', detail: `HTTP ${res.status}` };
        const data = await res.json();
        const names = (data.models || []).map((m) => m.name || m.model).filter(Boolean);
        const want = cfg.model;
        const found = names.some((n) => n === want || n === `${want}:latest` || n.replace(/:latest$/, '') === want);
        return found
          ? { status: 'reachable', detail: `${want} available` }
          : { status: 'model_missing', detail: `model "${want}" not pulled (have: ${names.join(', ') || 'none'}) - run: ollama pull ${want}` };
      } catch (err) {
        return { status: 'unreachable', detail: `cannot reach Ollama at ${baseUrl}: ${err.message}` };
      } finally {
        t.clear();
      }
    },
  };
}

module.exports = { createOllamaProvider };
