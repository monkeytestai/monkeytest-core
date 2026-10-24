/**
 * Convenience helpers for building MonkeyLLMConfig objects.
 *
 * The full power-user path is:
 *
 *     new Monkey({ llm: {
 *       explorer: { provider: 'gemini', model: 'gemini-flash-lite-latest' },
 *       planner:  { provider: 'openai', model: 'gpt-4o' },
 *       runner:   { provider: 'groq',   model: 'llama-3.3-70b-versatile' },
 *     }})
 *
 * Most users don't want to think that hard for their first run. These helpers
 * give them sensible defaults that "just work" with whatever API key they've
 * already exported.
 */

import type { LLMConfig, LLMProvider, MonkeyLLMConfig } from '../types.js';

/**
 * Detect a usable provider from the process environment, in priority order
 * (cheapest known model first). Returns `undefined` if no provider key is
 * set, so the caller can fail with a helpful message.
 */
export function detectProviderFromEnv(): LLMProvider | undefined {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.MISTRAL_API_KEY) return 'mistral';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_COMPATIBLE_BASE_URL) return 'openai_compatible';
  return undefined;
}

/**
 * Recommended cheapest fast models per provider, used as defaults when the
 * caller doesn't specify one. Updated as providers ship cheaper tiers.
 */
export const CHEAP_FAST_MODEL: Record<LLMProvider, string> = {
  openai:            'gpt-4o-mini',
  gemini:            'gemini-flash-lite-latest',
  anthropic:         'claude-haiku-4-5',
  mistral:           'mistral-small-latest',
  groq:              'llama-3.3-70b-versatile',
  openai_compatible: 'gpt-4o-mini',
};

/**
 * Recommended "smart" model per provider, used for the planner tier when
 * callers ask for `quality: 'smart'`. Pick the strongest reasoning model
 * each provider offers at a reasonable price.
 */
export const SMART_MODEL: Record<LLMProvider, string> = {
  openai:            'gpt-4o',
  gemini:            'gemini-flash-latest',
  anthropic:         'claude-sonnet-4-5',
  mistral:           'mistral-large-latest',
  groq:              'llama-3.3-70b-versatile',
  openai_compatible: 'gpt-4o',
};

export interface AutoLLMOptions {
  /**
   * Force a specific provider. If omitted, we detect from env vars in the
   * order: Gemini → OpenAI → Anthropic → Mistral → Groq → openai_compatible.
   */
  provider?: LLMProvider;
  /**
   * Quality preset:
   *   - 'cheap'    — same fast/cheap model everywhere (good for CI smoke runs)
   *   - 'balanced' — cheap model for explorer + runner, smart model for planner
   *   - 'smart'    — smart model everywhere (highest signal, highest cost)
   * Default: 'balanced'.
   */
  quality?: 'cheap' | 'balanced' | 'smart';
  /** Optional per-tier overrides. Wins over the preset. */
  overrides?: Partial<MonkeyLLMConfig>;
}

/**
 * Build a `MonkeyLLMConfig` from a single quality preset and the env.
 * This is the easiest way to get a sensible setup in two lines.
 *
 *     import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytest-core';
 *     const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
 *
 * Throws if no provider can be detected.
 */
export function autoLLMConfig(opts: AutoLLMOptions = {}): MonkeyLLMConfig {

  const provider = opts.provider ?? detectProviderFromEnv();
  if (!provider){
    throw new Error(
      'No LLM provider configured. Set one of: '
      + 'GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, '
      + 'GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL — '
      + 'or pass `provider` and `apiKey` explicitly.'
    );
  }

  const quality = opts.quality ?? 'balanced';
  const cheap: LLMConfig = { provider, model: CHEAP_FAST_MODEL[provider] };
  const smart: LLMConfig = { provider, model: SMART_MODEL[provider] };

  let preset: MonkeyLLMConfig;
  switch (quality){
    case 'cheap':
      preset = { explorer: cheap, planner: cheap, runner: cheap };
      break;
    case 'smart':
      preset = { explorer: smart, planner: smart, runner: smart };
      break;
    case 'balanced':
    default:
      preset = { explorer: cheap, planner: smart, runner: cheap };
      break;
  }

  return {
    explorer: opts.overrides?.explorer ?? preset.explorer,
    planner:  opts.overrides?.planner  ?? preset.planner,
    runner:   opts.overrides?.runner   ?? preset.runner,
    triager:  opts.overrides?.triager  ?? preset.triager,
  };

}
