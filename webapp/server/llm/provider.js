// Provider interface shared by every adapter (LLM plan §5). Callers only ever see:
//
//   provider.name, provider.model, provider.isLocal
//   provider.analyzeImage({ images: [{ base64, mediaType }], systemPrompt, userText, jsonSchema, signal })
//     -> Promise<{ text, usage: { inputTokens, outputTokens } | null, model }>
//   provider.completeText({ systemPrompt, userText, jsonSchema, signal })   // text-only (scene naming)
//     -> same shape
//   provider.checkHealth() -> Promise<{ status: 'reachable'|'unreachable'|'model_missing', detail }>
//
// `images` is an array so the refine pass can send before + after.

const DEFAULT_LLM_CONFIG = {
  enabled: false,
  provider: 'ollama',
  model: 'qwen3.5:9b',
  baseUrl: 'http://localhost:11434',
  apiKeyEnv: null,
  inputImage: 'auto', // draftRender | embedded | auto (Version 2 plan §9.3)
  refinePass: false,
  strength: 1.0,
  timeoutMs: 60000,
  planWaitMs: null, // null = timeoutMs (Phase 4 task 6)
  concurrency: 1,
  maxImagePx: 1024,
  keepAlive: '10m',
  temperature: 0.2,
  histogramStats: false, // Phase 6: needs sharp; ignored if it isn't installed
  burstReuse: true, // Phase 6: frames within 2 s with identical exposure reuse the first plan
  sendGpsToCloud: false,
};

function llmConfig(raw) {
  const c = { ...DEFAULT_LLM_CONFIG, ...((raw && typeof raw === 'object') ? raw : {}) };
  if (!['draftRender', 'embedded', 'auto'].includes(c.inputImage)) c.inputImage = 'auto';
  if (!(c.timeoutMs > 0)) c.timeoutMs = DEFAULT_LLM_CONFIG.timeoutMs;
  if (!(c.planWaitMs > 0)) c.planWaitMs = c.timeoutMs;
  if (!(c.concurrency >= 1)) c.concurrency = 1;
  c.enabled = c.enabled === true;
  return c;
}

// AbortSignal that fires after `ms` or when `outer` aborts, whichever is first.
function timeoutSignal(ms, outer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${ms} ms`)), ms);
  if (outer) {
    if (outer.aborted) ctrl.abort(outer.reason);
    else outer.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  }
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

module.exports = { DEFAULT_LLM_CONFIG, llmConfig, timeoutSignal };
