/**
 * Multi-provider LLM wrapper used by every phase of the engine.
 *
 * Supported providers:
 *   - openai             — OpenAI Chat Completions (JSON mode + auto prompt cache)
 *   - gemini             — Google Generative AI (JSON response MIME)
 *   - anthropic          — Anthropic Messages API (JSON via prompt + parse,
 *                          with explicit `cache_control` breakpoints)
 *   - mistral            — Mistral Chat Completions (JSON object format)
 *   - groq               — Groq (OpenAI-compatible, very fast Llama / Mixtral)
 *   - openai_compatible  — Any OpenAI-compatible endpoint via baseURL
 *                          (Ollama, vLLM, LM Studio, OpenRouter, Together, …)
 *
 * Why a wrapper:
 *   - Each phase (explorer / planner / runner / triager) can pick its own
 *     provider+model, so teams can mix a smart planner with a cheap runner.
 *   - All calls go through `generateJSON()` which parses + validates with zod,
 *     so a flaky LLM response never crashes a downstream phase.
 *   - Provider-specific quirks (markdown fences, missing JSON mode, …) are
 *     handled here once instead of in every prompt site.
 *
 * Prompt caching:
 *   - Callers indicate how a prompt is structured via `cacheable` (the long
 *     stable prefix) + `prompt` (the per-call dynamic suffix). Providers that
 *     support caching see real savings on repeat runs (planner against the
 *     same site, triager polishing the same evidence corpus).
 *   - Token + cache metrics are returned through `LLM.lastUsage` so SaaS hosts
 *     can render "saved $X via prompt cache" in their UI.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Mistral } from '@mistralai/mistralai';
import { z } from 'zod';
import type { LLMConfig } from '../types.js';

export interface GenerateJSONOptions<T> {
  /** System-level guidance prepended to every prompt. */
  system?: string;
  /**
   * The long, stable, *cacheable* prefix of the user prompt.
   *
   * This is the part that is identical across many calls — the system context,
   * the site map, the evidence corpus. Providers that support prompt caching
   * (OpenAI auto, Anthropic ephemeral) use this string as the cache key. Keep
   * it well above 1k tokens for OpenAI auto-cache hits.
   *
   * If omitted, only `prompt` is sent and no caching applies.
   */
  cacheable?: string;
  /** The dynamic per-call user prompt. Concatenated after `cacheable`. */
  prompt: string;
  /** Zod schema the response is parsed against. Throws on mismatch. */
  schema: z.ZodType<T>;
  /** Free-form key for log/error context (e.g. "explorer.summarisePage"). */
  label?: string;
}

/**
 * Token usage + cache stats from the last `generateJSON` call. Populated
 * provider-by-provider where the API exposes it. Read by hosts that want to
 * render "you saved $X by hitting the prompt cache" in their dashboards.
 */
export interface LLMUsage {
  /** Total input tokens billed for this call (provider-reported). */
  inputTokens?: number;
  /** Of `inputTokens`, how many were served from the prompt cache. */
  cachedInputTokens?: number;
  /** Output / completion tokens. */
  outputTokens?: number;
  /** Whether this call wrote new content into the prompt cache. */
  cacheWrite?: boolean;
}

export interface LLM {
  readonly providerLabel: string;
  /**
   * Token + cache stats from the last `generateJSON` call.
   * `undefined` until at least one call has completed; `{}` when the provider
   * does not expose usage.
   */
  readonly lastUsage?: LLMUsage;
  generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T>;
}

/* ── Gemini ───────────────────────────────────────────────────────────── */

class GeminiLLM implements LLM {

  readonly providerLabel: string;
  lastUsage?: LLMUsage;
  private readonly model: GenerativeModel;

  constructor(config: LLMConfig){

    const apiKey = config.apiKey
      || process.env.GEMINI_API_KEY
      || process.env.GOOGLE_API_KEY;

    if (!apiKey){
      throw new Error(
        'Gemini API key not configured. Set GEMINI_API_KEY (or GOOGLE_API_KEY), '
        + 'or pass `apiKey` in the LLMConfig.'
      );
    }

    // Default to the cheapest current-generation Flash model. Google's
    // floating "*-latest" aliases are the most reliable way for *new* keys
    // to reach a working model.
    const modelName = config.model || 'gemini-flash-lite-latest';
    this.providerLabel = `gemini:${modelName}`;
    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: config.temperature ?? 0.2,
      },
    });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, cacheable, prompt, schema, label } = opts;
    const userBody = cacheable ? `${cacheable.trim()}\n\n${prompt.trim()}` : prompt.trim();
    const fullPrompt = system ? `${system.trim()}\n\n${userBody}` : userBody;

    let raw: string;
    try {
      const res = await this.model.generateContent(fullPrompt);
      raw = res.response.text();
      // Gemini doesn't ship a managed prompt cache today; record token counts
      // when the SDK exposes them so cost dashboards still work.
      const md = (res.response as unknown as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata;
      this.lastUsage = {
        inputTokens: md?.promptTokenCount,
        outputTokens: md?.candidatesTokenCount,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/404 Not Found|is not found for API version|is not supported/i.test(msg)){
        throw new Error(
          `[${this.providerLabel}${label ? ` · ${label}` : ''}] Gemini rejected the model id. `
          + `Your API key probably doesn't have access to "${this.providerLabel.replace(/^gemini:/, '')}". `
          + `Try gemini-flash-latest, or check what's available with: `
          + `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"\n`
          + `Underlying error: ${msg}`
        );
      }
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] generateContent failed: ${msg}`
      );
    }

    return parseAndValidate(raw, schema, this.providerLabel, label);

  }

}

/* ── OpenAI / OpenAI-compatible (Groq, Ollama, vLLM, …) ───────────────── */

class OpenAILLM implements LLM {

  readonly providerLabel: string;
  lastUsage?: LLMUsage;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature: number;
  /** Some OpenAI-compatible servers don't accept response_format. */
  private readonly useJsonMode: boolean;

  constructor(config: LLMConfig, opts: {
    providerName: string;
    defaultModel: string;
    envApiKey?: string;
    baseURL?: string;
    /** Set to false for endpoints that don't support response_format. */
    useJsonMode?: boolean;
  }){

    const apiKey = config.apiKey
      || (opts.envApiKey ? process.env[opts.envApiKey] : undefined)
      || (opts.providerName === 'openai_compatible' ? 'sk-no-key-required' : undefined);

    if (!apiKey){
      throw new Error(
        `${opts.providerName} API key not configured. `
        + `Set ${opts.envApiKey || '<provider env var>'}, or pass \`apiKey\` in the LLMConfig.`
      );
    }

    const modelName = config.model || opts.defaultModel;
    this.providerLabel = `${opts.providerName}:${modelName}`;
    this.model = modelName;
    this.temperature = config.temperature ?? 0.2;
    this.useJsonMode = opts.useJsonMode ?? true;

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL || opts.baseURL,
    });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, cacheable, prompt, schema, label } = opts;

    // OpenAI prompt caching is automatic for prompts ≥1024 tokens, hashed by
    // the *prefix* of the messages array. We put the long stable parts FIRST
    // (system, then cacheable user block) and the per-call payload LAST so
    // the cached prefix is as large as possible across runs.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system?.trim()){
      messages.push({ role: 'system', content: system.trim() });
    }
    if (cacheable?.trim()){
      messages.push({ role: 'user', content: cacheable.trim() });
    }
    messages.push({ role: 'user', content: prompt.trim() });

    let raw: string;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: this.temperature,
        ...(this.useJsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      raw = res.choices[0]?.message?.content ?? '';

      const usage = res.usage as
        | (OpenAI.CompletionUsage & {
            prompt_tokens_details?: { cached_tokens?: number };
          })
        | undefined;
      this.lastUsage = {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] chat.completions failed: ${msg}`
      );
    }

    if (!raw.trim()){
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] empty model response`
      );
    }

    return parseAndValidate(raw, schema, this.providerLabel, label);

  }

}

/* ── Anthropic (Claude Messages API) ──────────────────────────────────── */

class AnthropicLLM implements LLM {

  readonly providerLabel: string;
  lastUsage?: LLMUsage;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly temperature: number;

  constructor(config: LLMConfig){

    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey){
      throw new Error(
        'Anthropic API key not configured. Set ANTHROPIC_API_KEY, '
        + 'or pass `apiKey` in the LLMConfig.'
      );
    }

    const modelName = config.model || 'claude-haiku-4-5';
    this.providerLabel = `anthropic:${modelName}`;
    this.model = modelName;
    this.temperature = config.temperature ?? 0.2;
    this.client = new Anthropic({ apiKey });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, cacheable, prompt, schema, label } = opts;

    // Claude doesn't have a native JSON mode like OpenAI's response_format,
    // so we lean on a strong system instruction and parse defensively.
    const jsonRule = 'You MUST respond with a single JSON object and nothing else. '
      + 'No prose, no code fences, no commentary.';

    // Anthropic prompt caching is opt-in per content block via
    // `cache_control: { type: 'ephemeral' }`. We add up to two breakpoints
    // (the API allows up to 4): one at the end of the system block, and one
    // at the end of the long stable user block. These are the two places
    // where the engine has long, cross-call-stable content. The dynamic
    // per-call instructions go in a separate, *uncached* user block.
    const systemBlocks: Anthropic.TextBlockParam[] = system?.trim()
      ? [
          { type: 'text', text: system.trim() },
          { type: 'text', text: jsonRule, cache_control: { type: 'ephemeral' } },
        ]
      : [{ type: 'text', text: jsonRule }];

    const userBlocks: Anthropic.TextBlockParam[] = [];
    if (cacheable?.trim()){
      userBlocks.push({
        type: 'text',
        text: cacheable.trim(),
        cache_control: { type: 'ephemeral' },
      });
    }
    userBlocks.push({ type: 'text', text: prompt.trim() });

    let raw: string;
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        temperature: this.temperature,
        system: systemBlocks,
        messages: [{ role: 'user', content: userBlocks }],
      });
      raw = res.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map(c => c.text)
        .join('\n')
        .trim();

      const usage = res.usage as Anthropic.Usage & {
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      this.lastUsage = {
        inputTokens:
          (usage.input_tokens || 0)
          + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0),
        cachedInputTokens: usage.cache_read_input_tokens,
        outputTokens: usage.output_tokens,
        cacheWrite: (usage.cache_creation_input_tokens || 0) > 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] messages.create failed: ${msg}`
      );
    }

    if (!raw){
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] empty model response`
      );
    }

    return parseAndValidate(raw, schema, this.providerLabel, label);

  }

}

/* ── Mistral ──────────────────────────────────────────────────────────── */

class MistralLLM implements LLM {

  readonly providerLabel: string;
  lastUsage?: LLMUsage;
  private readonly client: Mistral;
  private readonly model: string;
  private readonly temperature: number;

  constructor(config: LLMConfig){

    const apiKey = config.apiKey || process.env.MISTRAL_API_KEY;
    if (!apiKey){
      throw new Error(
        'Mistral API key not configured. Set MISTRAL_API_KEY, '
        + 'or pass `apiKey` in the LLMConfig.'
      );
    }

    const modelName = config.model || 'mistral-small-latest';
    this.providerLabel = `mistral:${modelName}`;
    this.model = modelName;
    this.temperature = config.temperature ?? 0.2;
    this.client = new Mistral({ apiKey });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, cacheable, prompt, schema, label } = opts;
    // Mistral has no managed prompt cache today; concatenate cacheable +
    // prompt into a single user message.
    const userBody = cacheable ? `${cacheable.trim()}\n\n${prompt.trim()}` : prompt.trim();

    let raw: string;
    try {
      const res = await this.client.chat.complete({
        model: this.model,
        temperature: this.temperature,
        responseFormat: { type: 'json_object' },
        messages: [
          ...(system?.trim() ? [{ role: 'system' as const, content: system.trim() }] : []),
          { role: 'user' as const, content: userBody },
        ],
      });
      const choice = res.choices?.[0]?.message?.content;
      raw = typeof choice === 'string' ? choice : Array.isArray(choice)
        ? choice.map(c => (typeof c === 'string' ? c : (c as { text?: string }).text || '')).join('')
        : '';

      const usage = res.usage as { promptTokens?: number; completionTokens?: number } | undefined;
      this.lastUsage = {
        inputTokens: usage?.promptTokens,
        outputTokens: usage?.completionTokens,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] chat.complete failed: ${msg}`
      );
    }

    if (!raw.trim()){
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] empty model response`
      );
    }

    return parseAndValidate(raw, schema, this.providerLabel, label);

  }

}

/* ── Factory ──────────────────────────────────────────────────────────── */

export function createLLM(config: LLMConfig): LLM {

  switch (config.provider){

    case 'gemini':
      return new GeminiLLM(config);

    case 'openai':
      return new OpenAILLM(config, {
        providerName: 'openai',
        defaultModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        envApiKey: 'OPENAI_API_KEY',
      });

    case 'anthropic':
      return new AnthropicLLM(config);

    case 'mistral':
      return new MistralLLM(config);

    case 'groq':
      return new OpenAILLM(config, {
        providerName: 'groq',
        defaultModel: 'llama-3.3-70b-versatile',
        envApiKey: 'GROQ_API_KEY',
        baseURL: 'https://api.groq.com/openai/v1',
      });

    case 'openai_compatible':
      return new OpenAILLM(config, {
        providerName: 'openai_compatible',
        defaultModel: 'gpt-4o-mini',
        envApiKey: 'OPENAI_COMPATIBLE_API_KEY',
        baseURL: config.baseURL || process.env.OPENAI_COMPATIBLE_BASE_URL,
        // Many local servers (Ollama, LM Studio) don't support response_format.
        useJsonMode: !/ollama|localhost|127\.0\.0\.1/i.test(config.baseURL || process.env.OPENAI_COMPATIBLE_BASE_URL || ''),
      });

    default: {
      const exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${exhaustive}`);
    }

  }

}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Strip an optional ```json ... ``` fence and parse + zod-validate the result.
 * Centralised so every provider gets the same defensive parsing.
 */
function parseAndValidate<T>(raw: string, schema: z.ZodType<T>, providerLabel: string, label?: string): T {

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMarkdownFence(raw));
  } catch {
    // Some models prepend an apology paragraph. Try to find the first {…}
    // or [...] block and parse just that.
    const m = raw.match(/[\{\[][\s\S]*[\}\]]/);
    if (m){
      try { parsed = JSON.parse(m[0]); }
      catch {
        throw new Error(
          `[${providerLabel}${label ? ` · ${label}` : ''}] response was not valid JSON. `
          + `Raw: ${raw.slice(0, 400)}…`
        );
      }
    } else {
      throw new Error(
        `[${providerLabel}${label ? ` · ${label}` : ''}] response was not valid JSON. `
        + `Raw: ${raw.slice(0, 400)}…`
      );
    }
  }

  const result = schema.safeParse(parsed);
  if (!result.success){
    throw new Error(
      `[${providerLabel}${label ? ` · ${label}` : ''}] response did not match schema: `
      + result.error.message
    );
  }
  return result.data;

}

function stripMarkdownFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : trimmed;
}
