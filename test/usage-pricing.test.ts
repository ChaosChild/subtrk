// usage-pricing.test.ts – the bundled vendor fallback pricing table:
// key normalization (dots/dashes/spaces collapse), dotted vs slugged spellings
// resolving to the same entry, unknown models staying honestly unpriced, and
// the USD-per-1M -> per-token conversion. Pure module – no fs, no clock.
import assert from "node:assert/strict";
import test from "node:test";
import { priceForModel } from "../src/usage.ts";
import {
  fallbackPriceFor,
  normalizeModelKey,
  PRICE_FALLBACK_PER_1M,
  type Price1M,
  perToken,
} from "../src/usage-pricing.ts";

test("normalizeModelKey: lowercase, dots/spaces/underscores to dashes, runs collapsed", () => {
  assert.equal(normalizeModelKey("GLM-5.3"), "glm-5-3");
  assert.equal(normalizeModelKey("qwen3.8-max"), "qwen3-8-max");
  assert.equal(normalizeModelKey("glm_4_5_air"), "glm-4-5-air");
  assert.equal(normalizeModelKey("GLM 5.3"), "glm-5-3");
  assert.equal(normalizeModelKey("  GLM--5...3  "), "glm-5-3");
  assert.equal(normalizeModelKey("Claude-Opus-5.5"), "claude-opus-5-5");
  assert.equal(normalizeModelKey(""), "");
});

test("fallbackPriceFor: dotted and slugged spellings hit the same table entry", () => {
  const dotted = fallbackPriceFor("GLM-5.3");
  const slugged = fallbackPriceFor("glm-5-3");
  assert.ok(dotted);
  assert.deepEqual(dotted, slugged);
  // a real table key cross-checked against the declared value
  const declared = PRICE_FALLBACK_PER_1M["glm-5.3"] as Price1M;
  assert.equal(dotted.in, declared.in);
  assert.equal(dotted.out, declared.out);
  // qwen mixes dots and dashes across spellings
  assert.deepEqual(fallbackPriceFor("Qwen3.8-Max"), fallbackPriceFor("qwen3-8-max"));
});

test("fallbackPriceFor: cache-write prices only where published (qwen), GLM omits cw", () => {
  const qwen = fallbackPriceFor("qwen3-max");
  assert.ok(qwen);
  assert.equal(qwen.cw, 1.5); // 125% of input, per the alibaba tier table
  const glm = fallbackPriceFor("glm-5.3");
  assert.ok(glm);
  assert.equal(glm.cw, undefined, "z.ai publishes no cache-write price");
  assert.ok(typeof glm.cr === "number");
});

test("fallbackPriceFor: unknown models are null – never invented pricing", () => {
  assert.equal(fallbackPriceFor("totally-made-up-model"), null);
  assert.equal(fallbackPriceFor("weird-9"), null);
  assert.equal(fallbackPriceFor(""), null);
});

test("fallbackPriceFor: prototype-chain names never resolve into a truthy non-price (regression)", () => {
  // Before the own-property check, "constructor"/"toString" resolved through
  // the prototype chain to functions – truthy, so priceForModel returned a
  // price object of NaNs instead of an honest null.
  for (const hostile of [
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    assert.equal(fallbackPriceFor(hostile), null, `${hostile} must stay unpriced`);
  }
  // spellings that survive normalization unchanged are the dangerous ones
  assert.equal(fallbackPriceFor("CONSTRUCTOR"), null);
  assert.equal(fallbackPriceFor("  toString  "), null);
  assert.equal(fallbackPriceFor("valueOf"), null);
  // "__proto__" normalizes to "-proto-" – still not a table entry either way
  assert.equal(fallbackPriceFor("__proto__"), null);
});

test("priceForModel: hostile names stay null on a pre-refresh store (empty OpenRouter list)", () => {
  const store = {
    schemaVersion: 1 as const,
    hourly: {},
    daily: {},
    localHourly: {},
    localDaily: {},
    samples: {},
    state: {},
    pricing: {}, // never refreshed – the fallback table is the only source
  };
  assert.equal(priceForModel(store, "__proto__"), null);
  assert.equal(priceForModel(store, "constructor"), null);
  assert.equal(priceForModel(store, "toString"), null);
  // sanity: the fallback tier still works through the same store
  assert.equal(priceForModel(store, "glm-5.3")?.source, "fallback");
});

test("perToken: USD per 1M converts to per token; cr/cw kept only when present", () => {
  const p = perToken({ in: 1.4, out: 4.4, cr: 0.26 });
  assert.equal(p.in, 1.4e-6);
  assert.equal(p.out, 4.4e-6);
  assert.equal(p.cr, 0.26e-6);
  assert.equal(p.cw, undefined);

  const withCw = perToken({ in: 1, out: 2, cr: 0.1, cw: 1.25 });
  assert.equal(withCw.cw, 1.25e-6);

  // a missing cr stays absent rather than reading as a free zero
  const noCr = perToken({ in: 1, out: 2 });
  assert.equal(noCr.cr, undefined);
  assert.equal(noCr.in, 1e-6);
});

test("every fallback table entry is structurally sound (positive in/out, cr < in where set)", () => {
  assert.ok(Object.keys(PRICE_FALLBACK_PER_1M).length >= 6, "table covers glm and qwen families");
  for (const [key, p] of Object.entries(PRICE_FALLBACK_PER_1M)) {
    assert.ok(p.in > 0 && p.out > 0, `${key}: in/out must be positive`);
    if (p.cr !== undefined) {
      assert.ok(p.cr > 0 && p.cr < p.in, `${key}: cache read discounts below input`);
    }
    if (p.cw !== undefined) {
      assert.ok(p.cw > p.in, `${key}: cache write surcharges above input`);
    }
    // the table must be reachable through its own normalization (no typos)
    assert.ok(fallbackPriceFor(key) !== null, `${key} resolves through fallbackPriceFor`);
  }
});
