// createProvider(cfg.llm) picks the adapter by cfg.llm.provider.
// Phase 7 (cloud: openai-compat, anthropic) is ON HOLD; those names report "not available".
const { createOllamaProvider } = require('./ollamaProvider');
const { createMockProvider } = require('./mockProvider');
const { llmConfig } = require('./provider');

const PLANNED_PROVIDERS = ['openai-compat', 'anthropic'];

function createProvider(rawLlmCfg, hooks) {
  const cfg = llmConfig(rawLlmCfg);
  switch (cfg.provider) {
    case 'ollama': return createOllamaProvider(cfg, hooks);
    case 'mock': return createMockProvider(cfg, hooks);
    default: {
      const why = PLANNED_PROVIDERS.includes(cfg.provider)
        ? `provider "${cfg.provider}" is planned for Version 2 Phase 7 (on hold) and not built yet`
        : `unknown llm.provider "${cfg.provider}" (use "ollama" or "mock")`;
      return {
        name: cfg.provider,
        model: cfg.model,
        isLocal: false,
        unavailable: why,
        analyzeImage: async () => { throw new Error(why); },
        completeText: async () => { throw new Error(why); },
        checkHealth: async () => ({ status: 'unreachable', detail: why }),
      };
    }
  }
}

module.exports = { createProvider };
