// Price table and cost arithmetic. Figures are list prices in US dollars checked on 13 November 2026.
// Sources are listed in docs/COSTS.md. Every value can be overridden with the PRICES_JSON setting.

export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
  cacheWritePerM: number;
  cacheReadPerM: number;
  /** Some models charge more once the prompt passes a size threshold. */
  longContext?: { thresholdTokens: number; multiplier: number };
}

export interface Prices {
  models: Record<string, ModelPrice>;
  /** Azure Speech neural text to speech, per one million characters. */
  ttsPerMChars: number;
  /** Azure Communication Services calling, per participant minute. */
  callingPerMinute: number;
  /**
   * Azure Communication Services closed captions meter, per minute. Microsoft does not state
   * whether this meter applies to captions that Teams generates in a Teams meeting, so the
   * budget guard assumes it does until a real invoice shows otherwise.
   */
  captionsPerMinute: number;
  /** Container compute for one worker (1 vCPU, 2 GiB) per minute. */
  workerPerMinute: number;
  /** Claude web search tool, per search. */
  webSearchEach: number;
}

export const DEFAULT_PRICES: Prices = {
  models: {
    'claude-haiku-5-5': {
      inputPerM: 0.1,
      outputPerM: 0.5,
      cacheWritePerM: 0.125,
      cacheReadPerM: 0.01,
      longContext: { thresholdTokens: 100_000, multiplier: 5 },
    },
    'claude-sonnet-5-5': { inputPerM: 2, outputPerM: 10, cacheWritePerM: 2.5, cacheReadPerM: 0.1 },
    'claude-opus-5-5': { inputPerM: 4, outputPerM: 20, cacheWritePerM: 5, cacheReadPerM: 0.2 },
  },
  ttsPerMChars: 15,
  callingPerMinute: 0.004,
  captionsPerMinute: 0.021,
  // UK South consumption rates: 60 s x (1 vCPU x 0.000034 + 2 GiB x 0.000004).
  workerPerMinute: 60 * (1 * 0.000034 + 2 * 0.000004),
  webSearchEach: 10 / 1000,
};

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  webSearches: number;
}

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 };

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    webSearches: a.webSearches + b.webSearches,
  };
}

/** Cost of one model request. Unknown models are priced as the dearest known model, to stay conservative. */
export function llmCost(model: string, usage: LlmUsage, prices: Prices = DEFAULT_PRICES): number {
  const known = prices.models[model];
  const price = known ?? Object.values(prices.models).reduce((a, b) => (b.inputPerM > a.inputPerM ? b : a));
  const promptTokens = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const factor = price.longContext && promptTokens > price.longContext.thresholdTokens ? price.longContext.multiplier : 1;
  const tokens =
    (usage.inputTokens * price.inputPerM +
      usage.outputTokens * price.outputPerM +
      usage.cacheWriteTokens * price.cacheWritePerM +
      usage.cacheReadTokens * price.cacheReadPerM) /
    1_000_000;
  return tokens * factor + usage.webSearches * prices.webSearchEach;
}

export function ttsCost(characters: number, prices: Prices = DEFAULT_PRICES): number {
  return (characters * prices.ttsPerMChars) / 1_000_000;
}

/** Calling, captions and compute for the minutes the assistant spent in a meeting. */
export function meetingCost(minutes: number, prices: Prices = DEFAULT_PRICES): number {
  return minutes * (prices.callingPerMinute + prices.captionsPerMinute + prices.workerPerMinute);
}

export function loadPrices(json: string | undefined): Prices {
  if (!json) return DEFAULT_PRICES;
  const override = JSON.parse(json) as Partial<Prices>;
  return { ...DEFAULT_PRICES, ...override, models: { ...DEFAULT_PRICES.models, ...(override.models ?? {}) } };
}
