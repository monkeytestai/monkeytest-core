/**
 * Crawl depth presets.
 *
 * The SaaS calls the free run `basic` and labels it "Quick pass"
 * (`depthLabel` in mtaiclient). `standard` and `deep` match the broader
 * passes. `shallow` remains the smaller smoke preset from the cost guide.
 *
 * `--depth` on the CLI and `resolveDepthPreset` are the same table.
 * `focus: 'forms-search-cta'` is how Quick pass biases the planner.
 */

export type DepthPresetName = 'basic' | 'standard' | 'deep' | 'shallow';

export type PlanFocus = 'forms-search-cta';

export interface DepthPreset {
  /** Machine id. Quick pass is `basic`, which is what the SaaS already stores. */
  id: DepthPresetName;
  /** Human label. */
  label: string;
  maxPages: number;
  maxFlows: number;
  /** Set for Quick pass. Omit on the other presets so planning stays unchanged. */
  focus?: PlanFocus;
}

export const DEPTH_PRESETS: Record<DepthPresetName, DepthPreset> = {
  basic: {
    id: 'basic',
    label: 'Quick pass',
    maxPages: 6,
    maxFlows: 4,
    focus: 'forms-search-cta',
  },
  standard: {
    id: 'standard',
    label: 'Broader pass',
    maxPages: 8,
    maxFlows: 6,
  },
  deep: {
    id: 'deep',
    label: 'Deeper dig',
    maxPages: 16,
    maxFlows: 10,
  },
  shallow: {
    id: 'shallow',
    label: 'Shallow',
    maxPages: 4,
    maxFlows: 3,
  },
};

const ALIASES: Record<string, DepthPresetName> = {
  basic: 'basic',
  'quick-pass': 'basic',
  quickpass: 'basic',
  quick: 'basic',
  standard: 'standard',
  'broader-pass': 'standard',
  deep: 'deep',
  'deeper-dig': 'deep',
  shallow: 'shallow',
};

export function resolveDepthPreset(name: string): DepthPreset {
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const id = ALIASES[key];
  if (!id) {
    throw new Error(
      `Unknown depth preset "${name}". Use basic (Quick pass), standard, deep, or shallow.`,
    );
  }
  return DEPTH_PRESETS[id];
}

/**
 * Apply a preset to page and flow caps. An explicit `--max` or `--flows`
 * wins over the preset so a caller can widen one knob.
 */
export function applyDepthPreset(
  name: string,
  limits: { maxPages: number; maxFlows: number; maxPagesSet?: boolean; maxFlowsSet?: boolean },
): { maxPages: number; maxFlows: number; focus?: PlanFocus; preset: DepthPreset } {
  const preset = resolveDepthPreset(name);
  return {
    maxPages: limits.maxPagesSet ? limits.maxPages : preset.maxPages,
    maxFlows: limits.maxFlowsSet ? limits.maxFlows : preset.maxFlows,
    focus: preset.focus,
    preset,
  };
}
