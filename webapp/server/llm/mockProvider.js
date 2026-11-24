// Mock adapter: canned plans, for tests and for trying the UI with no LLM running
// (config: "llm": { "enabled": true, "provider": "mock" }).
//
// Test hooks (constructor options, not config): delayMs (number or fn(callIndex, ctx) -> ms),
// fail (fn(callIndex, ctx) -> boolean | Error), reply (fn(callIndex, ctx) -> object|string).
// ctx.userText lets a test key behaviour off the photo being analysed.

const DEFAULT_REPLY = {
  scene: 'landscape',
  lighting: 'daylight_harsh',
  issues: ['flat'],
  adjustments: {
    exposure: 0, highlights: 1, shadows: 1, contrast: 0, clarity: 1, dehaze: 0, saturation: 0, warmth: 0, tint: 0,
  },
  notes: 'Mock provider: small highlight/shadow recovery and a little clarity.',
  sceneTags: {
    setting: 'other', subject: 'other', light: 'daylight_harsh', caption: 'mock caption',
  },
};

// Answers in the shape the caller's schema asks for, so the UI can be tried end to end:
// scene grouping (text-only) -> one named group per day; tags-only -> sceneTags; else a plan.
function defaultReplyFor(ctx = {}) {
  const props = (ctx.jsonSchema && ctx.jsonSchema.properties) || {};
  if (props.groups) {
    const n = ((ctx.userText || '').match(/^Segment \d+:/gm) || []).length;
    return { groups: [{ segments: Array.from({ length: n }, (_, k) => k), name: 'Mock scene' }], splits: [] };
  }
  if (props.sceneTags && !props.adjustments) return { sceneTags: DEFAULT_REPLY.sceneTags };
  if (props.sameScene) return { sameScene: true };
  return DEFAULT_REPLY;
}

function createMockProvider(cfg = {}, hooks = {}) {
  let calls = 0;
  const pick = (v, i, ctx) => (typeof v === 'function' ? v(i, ctx) : v);

  async function respond(ctx) {
    const i = calls;
    calls += 1;
    const delay = pick(hooks.delayMs ?? cfg.mockDelayMs ?? 0, i, ctx) || 0;
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        if (ctx.signal) {
          ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(ctx.signal.reason || new Error('aborted')); }, { once: true });
        }
      });
    }
    const failure = pick(hooks.fail, i, ctx);
    if (failure) throw failure instanceof Error ? failure : new Error('mock provider failure');
    const reply = pick(hooks.reply, i, ctx) ?? defaultReplyFor(ctx);
    return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), usage: null, model: 'mock' };
  }

  return {
    name: 'mock',
    model: 'mock',
    isLocal: true,
    get calls() { return calls; },
    analyzeImage(ctx) { return respond(ctx); },
    completeText(ctx) { return respond(ctx); },
    async checkHealth() { return { status: 'reachable', detail: 'mock provider' }; },
  };
}

module.exports = { createMockProvider, DEFAULT_REPLY };
