// status-pace.test.ts – the schemaVersion 2 pace/runway integration: what
// collectStatus attaches to `subtrk status` output (JSON add-only fields) and
// how the text renders it. Driven through main(argv, deps) with stub provider
// registries (same seam as cli-contract.test.ts), temp HOME + temp subtrk dirs;
// no network, no real user files.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderModule, ProviderResult, Window } from "../src/core.ts";
import { windowSecondsFromKind } from "../src/core.ts";

const tempHome = mkdtempSync(join(tmpdir(), "subtrk-pacehome-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"];
for (const k of ISOLATE_KEYS) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.APPDATA = join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Dynamic import after the env overrides, like cli-contract.test.ts.
const { main } = await import("../src/cli.ts");

function captureConsole(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function tempSubtrkDir(): string {
  return mkdtempSync(join(tmpdir(), "subtrk-pace-"));
}

function iso(msAhead: number): string {
  return new Date(Date.now() + msAhead).toISOString();
}

// Stub module returning exactly the given result shape; the caller keeps a
// reference to the windows to compare against the serialized output.
function probeModule(id: ProviderResult["id"], base: Omit<ProviderResult, "id" | "fetchedAt">): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({ ...base, id, fetchedAt: new Date().toISOString() }),
  };
}

// Structural views of the parsed status JSON (the tests only read these).
interface PaceJson {
  status: string;
  reason?: string;
  cycleBasis: string;
  cycleSeconds?: number;
  elapsedPercent?: number;
  projectedExhaustedAt?: string;
  projectionConfidence?: string;
  startsAt?: string;
}
interface WindowJson {
  kind: string;
  scope?: string;
  usedPercent?: number;
  remainingFraction?: number;
  resetsAt: string;
  pace?: PaceJson;
  startsAt?: string;
}
interface RunwayJson {
  status: string;
  usableRunwaySeconds?: number;
  projectedExhaustedAt?: string;
  limitingWindowId?: string;
  projectionConfidence?: string;
  unmeasurableWindowIds?: string[];
}
interface ProviderJson {
  id: string;
  ok: boolean;
  stale: boolean;
  fetchedAt: string;
  windows?: WindowJson[];
  runway?: RunwayJson;
  error?: { kind: string; message: string };
}
interface StatusJson {
  schemaVersion: number;
  providers: ProviderJson[];
}

async function statusJson(providers: ProviderModule[]): Promise<{ parsed: StatusJson; code: number }> {
  const cap = captureConsole();
  try {
    const code = await main(["status", "--json"], { providers, dirs: { subtrk: tempSubtrkDir() } });
    return { parsed: JSON.parse(cap.out[0]) as StatusJson, code };
  } finally {
    cap.restore();
  }
}

async function statusText(providers: ProviderModule[]): Promise<string> {
  const cap = captureConsole();
  try {
    const code = await main(["status"], { providers, dirs: { subtrk: tempSubtrkDir() } });
    assert.equal(code, 0);
    return cap.out.join("\n");
  } finally {
    cap.restore();
  }
}

// Mid-cycle windows with deterministic semantics: the 5h window is half
// elapsed with 13% used (behind, slow burn); the 7d window is 5 of 7 days in
// with 89% used (ahead, fast burn, projection lands before its reset).
function twoWindowModule(): ProviderModule {
  const windows: Window[] = [
    { kind: "5h", usedPercent: 13, resetsAt: iso(2.5 * 3600_000) },
    { kind: "7d", usedPercent: 89, resetsAt: iso(2 * 86_400_000) },
  ];
  return probeModule("claude", { ok: true, stale: false, windows });
}

describe("windowSecondsFromKind (kind → cycle seconds)", () => {
  it("maps duration-suffixed kinds back to seconds", () => {
    assert.equal(windowSecondsFromKind("5h"), 18_000);
    assert.equal(windowSecondsFromKind("7d"), 604_800);
    assert.equal(windowSecondsFromKind("30d"), 2_592_000);
    assert.equal(windowSecondsFromKind("14d"), 1_209_600);
    assert.equal(windowSecondsFromKind("1d"), 86_400);
    assert.equal(windowSecondsFromKind("2w"), 1_209_600); // glm multi-week
    assert.equal(windowSecondsFromKind("90m"), 5_400);
    assert.equal(windowSecondsFromKind("45s"), 45);
  });

  it("maps the fixed semantic names", () => {
    assert.equal(windowSecondsFromKind("session"), 18_000); // claude OAuth 5h session
    assert.equal(windowSecondsFromKind("weekly"), 604_800);
    assert.equal(windowSecondsFromKind("monthly"), 2_592_000);
    assert.equal(windowSecondsFromKind("daily"), 86_400);
  });

  it("returns undefined for semantic/unknown kinds – never a guessed cycle", () => {
    assert.equal(windowSecondsFromKind("MCP"), undefined); // glm tool quota
    assert.equal(windowSecondsFromKind("bundle"), undefined); // zcode one_time
    assert.equal(windowSecondsFromKind("gemini-models"), undefined);
    assert.equal(windowSecondsFromKind(""), undefined);
    assert.equal(windowSecondsFromKind("5x"), undefined);
    assert.equal(windowSecondsFromKind("0h"), undefined); // no zero-length cycle
  });
});

describe("status --json pace/runway (schemaVersion 2, add-only)", () => {
  it("duration-kind windows get non-unknown pace and the provider gets runway", async () => {
    const { parsed, code } = await statusJson([twoWindowModule()]);
    assert.equal(code, 0);
    assert.equal(parsed.schemaVersion, 2);
    const p = parsed.providers[0];

    // 5h: cycle derived from the kind (reset − 5h), half elapsed, 13% used.
    const w5 = p.windows?.[0]?.pace;
    assert.ok(w5);
    assert.equal(w5.status, "behind"); // 87% quota left over 50% of the clock
    assert.equal(w5.cycleBasis, "window_seconds");
    assert.equal(w5.cycleSeconds, 18_000);
    assert.ok(Math.abs((w5.elapsedPercent ?? 0) - 50) < 0.5);
    assert.match(w5.projectedExhaustedAt ?? "", /Z$/);
    assert.equal(w5.projectionConfidence, "established");

    // 7d: 5 of 7 days gone with only 11% left – burning faster than the clock.
    const w7 = p.windows?.[1]?.pace;
    assert.ok(w7);
    assert.equal(w7.status, "ahead");
    assert.equal(w7.cycleBasis, "window_seconds");
    assert.equal(w7.cycleSeconds, 604_800);

    // Runway: the 5h projection lands after its own reset; the 7d one (~14.8h)
    // lands before it – the 7d window limits.
    const runway = p.runway;
    assert.ok(runway);
    assert.equal(runway.status, "projected_exhaustion");
    assert.equal(runway.limitingWindowId, "7d");
    assert.ok((runway.usableRunwaySeconds ?? 0) > 40_000 && (runway.usableRunwaySeconds ?? 0) < 60_000);
    assert.equal(runway.projectionConfidence, "established");
  });

  it("is add-only: original window/provider fields keep their values, no startsAt fabricated", async () => {
    const windows: Window[] = [{ kind: "5h", usedPercent: 13, resetsAt: iso(2.5 * 3600_000) }];
    const { parsed } = await statusJson([probeModule("claude", { ok: true, stale: false, windows })]);
    const p = parsed.providers[0];
    const w = p.windows?.[0];
    assert.ok(w);
    // Every pre-v2 field survives untouched…
    assert.equal(p.id, "claude");
    assert.equal(p.ok, true);
    assert.equal(p.stale, false);
    assert.match(p.fetchedAt, /Z$/);
    assert.deepEqual({ kind: w.kind, usedPercent: w.usedPercent, resetsAt: w.resetsAt }, windows[0]);
    // …pace is strictly an added key, and no cycle start was invented.
    assert.ok(typeof w.pace === "object");
    assert.ok(Object.keys(w).includes("pace"));
    assert.equal(w.startsAt, undefined);
    assert.equal(w.pace?.startsAt, undefined);
    assert.equal(w.resetsAt, windows[0].resetsAt);
  });

  it("semantic kind: pace unknown/missing_cycle, runway unknown with the unmeasurable id", async () => {
    const windows: Window[] = [{ kind: "MCP", scope: "MCP", usedPercent: 10, resetsAt: iso(3600_000) }];
    const { parsed } = await statusJson([probeModule("glm", { ok: true, stale: false, windows })]);
    const p = parsed.providers[0];
    assert.ok(p.windows);
    assert.deepEqual(p.windows[0].pace, { status: "unknown", reason: "missing_cycle", cycleBasis: "none" });
    assert.deepEqual(p.runway, { status: "unknown", unmeasurableWindowIds: ["MCP:MCP"] });
  });

  it("exhausted window: runway exhausted_now with the limiting id", async () => {
    const windows: Window[] = [{ kind: "5h", usedPercent: 100, resetsAt: iso(2 * 3600_000) }];
    const { parsed } = await statusJson([probeModule("claude", { ok: true, stale: false, windows })]);
    const p = parsed.providers[0];
    const pace = p.windows?.[0]?.pace;
    assert.ok(pace);
    assert.match(pace.projectedExhaustedAt ?? "", /Z$/);
    assert.ok(p.runway);
    assert.equal(p.runway.status, "exhausted_now");
    assert.equal(p.runway.usableRunwaySeconds, 0);
    assert.equal(p.runway.limitingWindowId, "5h");
  });

  it("stale-while-revalidate results pace as stale and carry no runway", async () => {
    const windows: Window[] = [{ kind: "5h", usedPercent: 13, resetsAt: iso(2.5 * 3600_000) }];
    const { parsed } = await statusJson([probeModule("claude", { ok: true, stale: true, windows })]);
    const p = parsed.providers[0];
    assert.ok(p.windows);
    assert.deepEqual(p.windows[0].pace, { status: "unknown", reason: "stale", cycleBasis: "none" });
    assert.equal(p.runway, undefined);
  });

  it("failed providers stay exactly as before: no windows, no runway", async () => {
    const { parsed } = await statusJson([
      probeModule("openrouter", {
        ok: false,
        stale: false,
        error: { kind: "no-credentials", message: "not set up" },
      }),
    ]);
    const p = parsed.providers[0];
    assert.equal(p.ok, false);
    assert.equal(p.windows, undefined);
    assert.equal(p.runway, undefined);
  });
});

describe("status text pace markers", () => {
  it("known pace adds compact markers plus a runway segment", async () => {
    const text = await statusText([twoWindowModule()]);
    assert.match(
      text,
      /5h 13% \(reset \d\d:\d\d\) · behind – projected empty in \d+h \d+m · 7d 89% \(reset \d\d:\d\d\) · ahead/,
    );
    assert.match(text, /runway: projected empty in \d+h \d+m \(7d window\)/);
  });

  it("on-pace windows say so; unknown pace and unknown runway stay silent", async () => {
    // 49% used half-ish through the 5h cycle sits inside the ±1 deadband; the
    // MCP window has no derivable cycle and must add no marker at all.
    const windows: Window[] = [
      { kind: "5h", usedPercent: 49, resetsAt: iso(2.6 * 3600_000) },
      { kind: "MCP", scope: "MCP", usedPercent: 90, resetsAt: iso(3600_000) },
    ];
    const text = await statusText([probeModule("glm", { ok: true, stale: false, windows })]);
    assert.match(text, /5h 49% \(reset \d\d:\d\d\) · on pace/);
    assert.ok(!text.includes("behind"), "unknown pace prints no marker");
    assert.ok(!text.includes("ahead"), "unknown pace prints no marker");
    assert.ok(!text.includes("runway:"), "unknown runway prints nothing");
  });

  it("exhausted runway reads 'runway: exhausted now'", async () => {
    const windows: Window[] = [{ kind: "5h", usedPercent: 100, resetsAt: iso(2 * 3600_000) }];
    const text = await statusText([probeModule("claude", { ok: true, stale: false, windows })]);
    assert.match(text, /runway: exhausted now/);
  });
});
