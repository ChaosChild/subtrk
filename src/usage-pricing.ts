// usage-pricing.ts – static fallback pricing for the API-equivalent cost
// estimate. The canonical source is OpenRouter's public /api/v1/models list,
// refreshed into usage.json weekly (it covers anthropic, openai, google,
// z-ai, moonshotai, qwen and more). This table only fills gaps: vendor slugs
// with no OpenRouter equivalent, and the first run before a refresh lands.
// Values are USD per 1M tokens, converted to per-token on load. Sources:
// docs.z.ai/guides/overview/pricing (GLM, verified 2026-09) and
// alibabacloud.com/help/en/model-studio/model-pricing (qwen international,
// ≤32K tier, cache write = 125% of input / cache hit = 10%, verified 2026-09).
// Vendor families whose prices we could NOT verify are deliberately absent –
// they resolve through the OpenRouter list or stay honestly unpriced.

export interface Price1M {
  in: number;
  out: number;
  cr?: number; // cache read
  cw?: number; // cache write
}

export const PRICE_FALLBACK_PER_1M: Record<string, Price1M> = {
  // z.ai GLM (docs.z.ai) – no separate cache-write price published; writes
  // price at the input rate in the estimate.
  "glm-5.3": { in: 1.4, out: 4.4, cr: 0.26 },
  "glm-5.2": { in: 1.4, out: 4.4, cr: 0.26 },
  "glm-5.1": { in: 1.4, out: 4.4, cr: 0.26 },
  "glm-5": { in: 1.0, out: 3.2, cr: 0.2 },
  "glm-4.7": { in: 0.6, out: 2.2, cr: 0.11 },
  "glm-4.6": { in: 0.6, out: 2.2, cr: 0.11 },
  "glm-4.5": { in: 0.6, out: 2.2, cr: 0.11 },
  "glm-5.3-flash": { in: 0.15, out: 0.5, cr: 0.03 },
  "glm-5.3-flashx": { in: 0.37, out: 1.25, cr: 0.075 },
  "glm-4.7-flashx": { in: 0.07, out: 0.4, cr: 0.01 },
  "glm-4.5-air": { in: 0.2, out: 1.1, cr: 0.03 },
  "glm-4.5-x": { in: 2.2, out: 8.9, cr: 0.45 },
  "glm-4.5-airx": { in: 1.1, out: 4.5, cr: 0.22 },
  // Alibaba Model Studio international, ≤32K input tier (tiered models price
  // at the cheapest tier here – the drill-down labels every estimate).
  "qwen3-max": { in: 1.2, out: 6.0, cr: 0.12, cw: 1.5 },
  "qwen3.8-max": { in: 2.0, out: 6.0, cr: 0.2, cw: 2.5 },
  "qwen3-coder-plus": { in: 1.0, out: 5.0, cr: 0.1, cw: 1.25 },
  "qwen-plus": { in: 0.4, out: 1.2, cr: 0.04, cw: 0.5 },
  "qwen-flash": { in: 0.05, out: 0.4, cr: 0.005, cw: 0.0625 },
  "qwen-turbo": { in: 0.05, out: 0.2, cr: 0.005, cw: 0.0625 },
};

// Vendor model keys -> canonical fallback keys (normalized: lowercase, dots and
// runs of dashes collapsed). OpenRouter prefix hints live in usage.ts.
export function normalizeModelKey(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/[.\s_]+/g, "-")
    .replace(/-+/g, "-");
}

// Pure: the fallback price for a vendor model key, or null. Table keys are
// matched through the same normalization as the query, so dotted ("GLM-5.3",
// "qwen3.8-max") and slugged ("glm-5-3", "qwen3-8-max") spellings resolve to
// the same entry regardless of how many dots/dashes the name mixes.
const FALLBACK_NORMALIZED: Record<string, Price1M> = Object.fromEntries(
  Object.entries(PRICE_FALLBACK_PER_1M).map(([k, v]) => [normalizeModelKey(k), v]),
);

export function fallbackPriceFor(model: string): Price1M | null {
  return FALLBACK_NORMALIZED[normalizeModelKey(model)] ?? null;
}

// USD per 1M -> USD per token.
export function perToken(p: Price1M): { in: number; out: number; cr?: number; cw?: number } {
  return {
    in: p.in / 1e6,
    out: p.out / 1e6,
    ...(p.cr !== undefined ? { cr: p.cr / 1e6 } : {}),
    ...(p.cw !== undefined ? { cw: p.cw / 1e6 } : {}),
  };
}
