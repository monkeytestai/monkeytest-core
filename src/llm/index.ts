/**
 * Tiny multi-provider LLM wrapper used by every phase of the engine.
 *
 * Ships Gemini (cheap default when Google keys are used) and OpenAI (stable
 * under load — Google's Flash Lite alias occasionally returns 503 capacity).
 * Anthropic is still a stub until we need it.
 *
 * Why a wrapper:
 *   - Each phase (explorer / planner / triager) can pick its own provider+model
 *   - Forces every call to go through `generateJSON()` which validates with zod,
 *     so a flaky LLM response never crashes a downstream phase
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import OpenAI from 'openai';
import { z } from 'zod';
import type { LLMConfig } from '../types.js';

export interface GenerateJSONOptions<T> {
  /** System-level guidance prepended to every prompt. */
  system?: string;
  /** The actual user/task prompt. */
  prompt: string;
  /** Zod schema the response is parsed against. Throws on mismatch. */
  schema: z.ZodType<T>;
  /** Free-form key for log/error context (e.g. "explorer.summarisePage"). */
  label?: string;
}

export interface LLM {
  readonly providerLabel: string;
  generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T>;
}

/* ── Gemini ───────────────────────────────────────────────────────────── */

class GeminiLLM implements LLM {

  readonly providerLabel: string;
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
    // floating "*-latest" aliases are the only reliable way for *new* keys to
    // reach a working model — the pinned ids (gemini-2.0-flash,
    // gemini-2.0-flash-lite, etc.) appear in ListModels but are gated to
    // legacy customers and 404 for new users. As of 2026:
    //   - gemini-flash-lite-latest  → cheapest, fastest, fine for the hot path
    //   - gemini-flash-latest       → smarter, ~2x cost
    //   - gemini-2.5-flash          → pinned current-gen, sometimes 503s
    const modelName = config.model || 'gemini-flash-lite-latest';
    this.providerLabel = `gemini:${modelName}`;
    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: modelName,
      generationConfig: {
        // We always ask for JSON; the responseMimeType nudges the model to
        // produce parseable output instead of fenced markdown.
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, prompt, schema, label } = opts;
    const fullPrompt = system ? `${system.trim()}\n\n${prompt.trim()}` : prompt.trim();

    let raw: string;
    try {
      const res = await this.model.generateContent(fullPrompt);
      raw = res.response.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Friendlier hint for the most common cause: a model id that the
      // caller's API key/region doesn't have access to.
      if (/404 Not Found|is not found for API version|is not supported/i.test(msg)){
        throw new Error(
          `[${this.providerLabel}${label ? ` · ${label}` : ''}] Gemini rejected the model id. `
          + `Your API key probably doesn't have access to "${this.providerLabel.replace(/^gemini:/, '')}". `
          + `Try --model gemini-2.0-flash, or check what's available with: `
          + `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"\n`
          + `Underlying error: ${msg}`
        );
      }
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] generateContent failed: ${msg}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFence(raw));
    } catch (err) {
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] response was not valid JSON. `
        + `Raw: ${raw.slice(0, 400)}…`
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success){
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] response did not match schema: `
        + result.error.message
      );
    }
    return result.data;

  }

}

/* ── OpenAI (Chat Completions + JSON mode) ─────────────────────────────── */

class OpenAILLM implements LLM {

  readonly providerLabel: string;
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: LLMConfig){

    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey){
      throw new Error(
        'OpenAI API key not configured. Set OPENAI_API_KEY, '
        + 'or pass `apiKey` in the LLMConfig.'
      );
    }

    const modelName = config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.providerLabel = `openai:${modelName}`;
    this.model = modelName;
    this.client = new OpenAI({ apiKey });

  }

  async generateJSON<T>(opts: GenerateJSONOptions<T>): Promise<T> {

    const { system, prompt, schema, label } = opts;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (system?.trim()){
      messages.push({ role: 'system', content: system.trim() });
    }
    messages.push({ role: 'user', content: prompt.trim() });

    let raw: string;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });
      raw = res.choices[0]?.message?.content ?? '';
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownFence(raw));
    } catch (err) {
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] response was not valid JSON. `
        + `Raw: ${raw.slice(0, 400)}…`
      );
    }

    const result = schema.safeParse(parsed);
    if (!result.success){
      throw new Error(
        `[${this.providerLabel}${label ? ` · ${label}` : ''}] response did not match schema: `
        + result.error.message
      );
    }
    return result.data;

  }

}

/* ── Stubs for the other providers (added when we need them) ──────────── */

class NotImplementedLLM implements LLM {
  readonly providerLabel: string;
  constructor(provider: string){ this.providerLabel = provider; }
  async generateJSON<T>(_opts: GenerateJSONOptions<T>): Promise<T> {
    throw new Error(
      `LLM provider "${this.providerLabel}" is not implemented yet in monkeytest-core. `
      + `Use "openai" or "gemini".`
    );
  }
}

/* ── Factory ──────────────────────────────────────────────────────────── */

export function createLLM(config: LLMConfig): LLM {

  switch (config.provider){
    case 'gemini':    return new GeminiLLM(config);
    case 'openai':    return new OpenAILLM(config);
    case 'anthropic': return new NotImplementedLLM('anthropic');
    default: {
      // Exhaustiveness check
      const exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${exhaustive}`);
    }
  }

}

/* ── Helpers ──────────────────────────────────────────────────────────── */

/**
 * Some Gemini responses still come back wrapped in ```json ... ``` despite the
 * responseMimeType hint. Be tolerant.
 */
function stripMarkdownFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1] : trimmed;
}
