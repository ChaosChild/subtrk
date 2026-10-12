// cli-contract.test.ts – the CLI surface contract (status/usage/track read
// paths) driven through main(argv, deps) with a sanitized environment: temp
// HOME, stripped provider secrets, temp subtrk dirs. No network, no real user
// files. Env overrides land BEFORE the dynamic src imports below so core's
// SUBTRK_DIR (computed at module load) also points at the temp home.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ProviderModule, ProviderResult } from "../src/core.ts";

const tempHome = mkdtempSync(join(tmpdir(), "subtrk-clihome-"));
const SAVED_ENV = new Map<string, string | undefined>();
const ISOLATE_KEYS = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"];
const SECRET_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "KIMI_CLIENT_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ANTIGRAVITY_CLIENT_ID",
  "ANTIGRAVITY_CLIENT_SECRET",
  "ZCODE_CREDENTIAL_SECRET",
];
for (const k of [...ISOLATE_KEYS, ...SECRET_KEYS]) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.APPDATA = join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
for (const k of SECRET_KEYS) delete process.env[k];
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Dynamic import: every src module in this graph must evaluate under the
// overridden environment above.
const { main } = await import("../src/cli.ts");

interface Captured {
  out: string[];
  err: string[];
  restore: () => void;
}

function captureConsole(): Captured {
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
  return mkdtempSync(join(tmpdir(), "subtrk-cli-"));
}

function iso(msAhead: number): string {
  return new Date(Date.now() + msAhead).toISOString();
}

function okModule(
  id: ProviderResult["id"],
  over: Partial<ProviderResult> = {},
  counter = { n: 0 },
): ProviderModule & { counter: { n: number } } {
  return {
    id,
    counter,
    ttlMs: 300_000,
    probe: async () => {
      counter.n += 1;
      return {
        id,
        ok: true,
        stale: false,
        fetchedAt: new Date().toISOString(),
        windows: [
          { kind: "5h", usedPercent: 13, resetsAt: iso(5 * 3600_000) },
          { kind: "7d", usedPercent: 89, resetsAt: iso(5 * 86400_000) },
        ],
        ...over,
      };
    },
  };
}

function failingModule(
  id: ProviderResult["id"],
  over: Partial<ProviderResult> = {},
): ProviderModule & { counter: { n: number } } {
  const counter = { n: 0 };
  return {
    id,
    counter,
    ttlMs: 300_000,
    probe: async () => {
      counter.n += 1;
      return {
        id,
        ok: false,
        stale: false,
        fetchedAt: new Date().toISOString(),
        error: { kind: "no-credentials", message: "not set up", hint: "run subtrk init" },
        ...over,
      };
    },
  };
}

describe("status --json schema", () => {
  it("schemaVersion 1, ISO stamps, recheckAfter not before checkedAt, well-formed windows", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--json"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]);
      assert.equal(parsed.schemaVersion, 1);
      assert.match(parsed.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(parsed.recheckAfter, /Z$/);
      assert.ok(Date.parse(parsed.recheckAfter) >= Date.parse(parsed.checkedAt));
      assert.ok(Array.isArray(parsed.providers));
      const p = parsed.providers[0];
      assert.equal(p.id, "claude");
      assert.equal(p.ok, true);
      assert.equal(p.stale, false);
      assert.match(p.fetchedAt, /Z$/);
      for (const w of p.windows) {
        assert.equal(typeof w.resetsAt, "string");
        assert.ok(Number.isFinite(Date.parse(w.resetsAt)), `resetsAt must parse: ${w.resetsAt}`);
        assert.ok(
          typeof w.usedPercent === "number" || typeof w.remainingFraction === "number",
          "every window carries usedPercent or remainingFraction",
        );
      }
    } finally {
      cap.restore();
    }
  });

  it("nextEvent is the earliest window reset with type/at/atMs", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--json"], {
        providers: [okModule("glm")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]);
      assert.equal(parsed.nextEvent.providerId, "glm");
      assert.equal(parsed.nextEvent.type, "window-reset");
      assert.match(parsed.nextEvent.at, /Z$/);
      assert.equal(parsed.nextEvent.atMs, Date.parse(parsed.nextEvent.at));
      assert.ok(parsed.nextEvent.atMs > Date.now());
    } finally {
      cap.restore();
    }
  });

  it("failed providers carry error kind/message and never a windows field", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--json"], {
        providers: [failingModule("openrouter")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const p = JSON.parse(cap.out[0]).providers[0];
      assert.equal(p.ok, false);
      assert.equal(p.error.kind, "no-credentials");
      assert.ok(p.error.message.length > 0);
      assert.equal(p.windows, undefined);
      assert.equal(p.credits, undefined);
    } finally {
      cap.restore();
    }
  });

  it("remainingFraction windows (google shape) satisfy the window contract too", async () => {
    const cap = captureConsole();
    try {
      const mod = okModule("google", {
        windows: [{ kind: "5h", scope: "gemini-models", remainingFraction: 0.38, resetsAt: iso(3600_000) }],
      });
      const code = await main(["status", "--json"], { providers: [mod], dirs: { subtrk: tempSubtrkDir() } });
      assert.equal(code, 0);
      const w = JSON.parse(cap.out[0]).providers[0].windows[0];
      assert.equal(w.remainingFraction, 0.38);
      assert.equal(w.scope, "gemini-models");
    } finally {
      cap.restore();
    }
  });
});

describe("--provider repeatable filter", () => {
  it("keeps only the requested providers, in registry order; others are never probed", async () => {
    const cap = captureConsole();
    try {
      const claude = okModule("claude");
      const glm = okModule("glm");
      const alibaba = okModule("alibaba");
      const code = await main(["status", "--json", "--provider", "glm", "--provider", "claude"], {
        providers: [claude, glm, alibaba],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      assert.deepEqual(
        JSON.parse(cap.out[0]).providers.map((p: { id: string }) => p.id),
        ["claude", "glm"],
        "selected keeps registry order regardless of flag order",
      );
      assert.equal(claude.counter.n, 1);
      assert.equal(glm.counter.n, 1);
      assert.equal(alibaba.counter.n, 0, "unrequested providers must not probe");
    } finally {
      cap.restore();
    }
  });

  it("a repeated --provider id collapses to one entry", async () => {
    const cap = captureConsole();
    try {
      const glm = okModule("glm");
      const code = await main(["status", "--json", "--provider", "glm", "--provider", "glm"], {
        providers: [glm],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const ids = JSON.parse(cap.out[0]).providers.map((p: { id: string }) => p.id);
      assert.deepEqual(ids, ["glm"]);
      assert.equal(glm.counter.n, 1, "deduplicated before probing");
    } finally {
      cap.restore();
    }
  });

  it("a valid --provider id absent from the stub registry exits 1 (runtime failure)", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--provider", "google"], {
        providers: [okModule("claude")],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 1);
      assert.match(cap.err.join("\n"), /no providers selected/);
    } finally {
      cap.restore();
    }
  });
});

describe("--fields text filter", () => {
  // One provider that has windows AND credits AND an error AND a hint – the
  // stale-on-error shape – plus a healthy one with windows + credits.
  function mixedRegistry(): { modules: ProviderModule[]; failing: ProviderModule & { counter: { n: number } } } {
    const failing = failingModule("glm", {
      stale: true,
      windows: [{ kind: "5h", usedPercent: 40, resetsAt: iso(3600_000) }],
      credits: { total: 50, remaining: 40, unit: "credits", cycleEndsAt: iso(86_400_000), source: "derived" },
      error: { kind: "rate-limited", message: "rate limited (429)", hint: "wait a minute" },
    });
    const ok = okModule("claude", {
      credits: { total: 50, remaining: 40, unit: "credits", source: "derived" },
    });
    return { modules: [ok, failing], failing };
  }

  it("default fields: windows + credits + error segment, hint withheld", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status"], { providers: mixedRegistry().modules, dirs: { subtrk: tempSubtrkDir() } });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.match(text, /^claude\s+5h 13% .*7d 89%/m);
      assert.match(text, /credits 40\/50/);
      assert.match(text, /glm\s+5h 40% .* · error: rate-limited – rate limited \(429\)/m);
      assert.ok(!text.includes("hint:"), "hints are opt-in via --fields hints");
    } finally {
      cap.restore();
    }
  });

  it("windows only: credits and the error segment are filtered out", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fields", "windows"], {
        providers: mixedRegistry().modules,
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.match(text, /^claude\s+5h 13%/m);
      assert.ok(!text.includes("credits 40/50"), "credits filtered");
      assert.ok(!text.includes("error:"), "error segment filtered");
      assert.ok(!text.includes("hint:"), "hints filtered");
    } finally {
      cap.restore();
    }
  });

  it("credits only: windows filtered, credits shown", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fields", "credits"], {
        providers: mixedRegistry().modules,
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.ok(!text.includes("5h 13%"), "windows filtered");
      assert.match(text, /^claude\s+credits 40\/50/m);
      assert.ok(!text.includes("error:"), "error segment filtered while credits shown");
    } finally {
      cap.restore();
    }
  });

  it("errors,hints: the failure line keeps its hint tail and drops windows", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["status", "--fields", "errors,hints"], {
        providers: mixedRegistry().modules,
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.ok(!text.includes("5h 40%"), "windows filtered");
      // with no visible segments the error line is the whole line: the hint in
      // parens rides along, then --fields hints appends the explicit tail.
      assert.match(text, /error: rate-limited – rate limited \(429\).*– hint: wait a minute/);
    } finally {
      cap.restore();
    }
  });
});

describe("--strict and exit codes", () => {
  it("exit 3 when any provider failed, 0 when all ok", async () => {
    const cap = captureConsole();
    try {
      const dirs = { subtrk: tempSubtrkDir() };
      assert.equal(await main(["status", "--strict"], { providers: [okModule("kimi")], dirs }), 0);
      assert.equal(
        await main(["status", "--strict"], { providers: [failingModule("kimi")], dirs: { subtrk: tempSubtrkDir() } }),
        3,
      );
      // mixed: one ok one failed -> still 3
      assert.equal(
        await main(["status", "--strict"], {
          providers: [okModule("claude"), failingModule("glm")],
          dirs: { subtrk: tempSubtrkDir() },
        }),
        3,
      );
    } finally {
      cap.restore();
    }
  });

  it("exit 0 on a plain successful status", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["status"], { providers: [okModule("claude")], dirs: { subtrk: tempSubtrkDir() } }), 0);
    } finally {
      cap.restore();
    }
  });

  it("usage errors exit 2 (unknown flags/commands, bad --days, bad --provider)", async () => {
    const cap = captureConsole();
    const dirs = () => ({ subtrk: tempSubtrkDir() });
    try {
      for (const argv of [
        ["status", "--nope"],
        ["status", "--provider", "nope"],
        ["status", "--fields", "bogus"],
        ["frobnicate"],
        ["auth"],
        ["track"],
        ["track", "bogus"],
        ["usage", "--days", "0"],
        ["usage", "--days", "366"],
        ["usage", "--days", "abc"],
        ["usage", "--provider", "nope"],
        ["track", "list", "--days", "x"],
      ]) {
        cap.out.length = 0;
        cap.err.length = 0;
        const code = await main(argv, { providers: [okModule("claude")], dirs: dirs() });
        assert.equal(code, 2, `argv ${JSON.stringify(argv)} must exit 2`);
        assert.ok(cap.err.length > 0, `argv ${JSON.stringify(argv)} must explain on stderr`);
        assert.equal(cap.out.filter((l) => !l.startsWith("help:")).length, 0, "no stdout payload on usage errors");
      }
    } finally {
      cap.restore();
    }
  });
});

describe("usage command shapes", () => {
  function seedUsage(dir: string, store: Record<string, unknown>): void {
    writeFileSync(join(dir, "usage.json"), JSON.stringify({ schemaVersion: 1, ...store }));
  }

  it("empty store --json: schemaVersion/granularity/from(month-to-date)/providers {}", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["usage", "--json"], { providers: [], dirs: { subtrk: tempSubtrkDir() } });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]);
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.granularity, "day");
      const now = new Date();
      assert.equal(parsed.from, new Date(now.getFullYear(), now.getMonth(), 1).toISOString());
      assert.match(parsed.to, /Z$/);
      assert.deepEqual(parsed.providers, {});
    } finally {
      cap.restore();
    }
  });

  it("--days 7 shifts the window start; --hour flips granularity", async () => {
    const cap = captureConsole();
    try {
      const now = new Date();
      const code = await main(["usage", "--days", "7", "--json"], {
        providers: [],
        dirs: { subtrk: tempSubtrkDir() },
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(cap.out[0]);
      assert.equal(parsed.from, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).toISOString());

      const cap2 = captureConsole();
      try {
        const code2 = await main(["usage", "--hour", "--json"], { providers: [], dirs: { subtrk: tempSubtrkDir() } });
        assert.equal(code2, 0);
        assert.equal(JSON.parse(cap2.out[0]).granularity, "hour");
      } finally {
        cap2.restore();
      }
    } finally {
      cap.restore();
    }
  });

  it("empty store text: the no-data line plus the usage help line, exit 0", async () => {
    const cap = captureConsole();
    try {
      const code = await main(["usage"], { providers: [], dirs: { subtrk: tempSubtrkDir() } });
      assert.equal(code, 0);
      const text = cap.out.join("\n");
      assert.match(text, /no usage recorded yet/);
      assert.match(text, /^help: subtrk usage --json/m);
    } finally {
      cap.restore();
    }
  });

  it("seeded window samples render the %-history-only line and JSON samples", async () => {
    const dir = tempSubtrkDir();
    seedUsage(dir, {
      samples: { claude: [{ t: Date.now(), k: "5h", u: 13, r: new Date().toISOString() }] },
    });
    const cap = captureConsole();
    try {
      const code = await main(["usage"], { providers: [], dirs: { subtrk: dir } });
      assert.equal(code, 0);
      assert.match(cap.out.join("\n"), /claude\s+% history only \(no vendor token counts\) · latest 5h 13%/);
    } finally {
      cap.restore();
    }

    const cap2 = captureConsole();
    try {
      const code = await main(["usage", "--json", "--provider", "claude"], { providers: [], dirs: { subtrk: dir } });
      assert.equal(code, 0);
      const u = JSON.parse(cap2.out[0]).providers.claude;
      assert.equal(u.samples.length, 1);
      assert.equal(u.samples[0].k, "5h");
      assert.equal(u.samples[0].u, 13);
    } finally {
      cap2.restore();
    }
  });

  it("seeded token rows render tok/in/cached/hit/out columns and JSON totals", async () => {
    const dir = tempSubtrkDir();
    const today = new Date().toISOString().slice(0, 10);
    seedUsage(dir, { daily: { claude: { [today]: { "claude-x": { in: 100, cr: 10, out: 50 } } } } });
    const cap = captureConsole();
    try {
      const code = await main(["usage", "--days", "3"], { providers: [], dirs: { subtrk: dir } });
      assert.equal(code, 0);
      assert.match(
        cap.out.join("\n"),
        /claude\s+160 tok · in 100 · cached 10 · hit 9% · out 50/,
        "cacheHit = cached/(in+cached) renders as a percent",
      );
      assert.match(cap.out.join("\n"), /^totals\s+160 tok · in 100 · cached 10 · out 50$/m);
    } finally {
      cap.restore();
    }

    const cap2 = captureConsole();
    try {
      const code = await main(["usage", "--days", "3", "--json"], { providers: [], dirs: { subtrk: dir } });
      assert.equal(code, 0);
      const u = JSON.parse(cap2.out[0]).providers.claude;
      assert.equal(u.in, 100);
      assert.equal(u.cr, 10);
      assert.equal(u.out, 50);
    } finally {
      cap2.restore();
    }
  });
});

describe("track status/list on an empty store", () => {
  it("track status: 'no open tracks' text and empty JSON shape, exit 0", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["track", "status"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /^no open tracks$/m);
      assert.match(
        cap.out.join("\n"),
        /^help: subtrk track start\|stop\|status\|list\|stats\|estimate\|prune --help$/m,
      );
    } finally {
      cap.restore();
    }

    const cap2 = captureConsole();
    try {
      assert.equal(await main(["track", "status", "--json"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      const parsed = JSON.parse(cap2.out[0]);
      assert.equal(parsed.schemaVersion, 1);
      assert.deepEqual(parsed.markers, []);
      assert.deepEqual(parsed.pending, []);
    } finally {
      cap2.restore();
    }
  });

  it("track list: 'no tracked tasks' text and { days, records: [] } JSON, exit 0", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["track", "list"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /no tracked tasks in the last 30d/);
    } finally {
      cap.restore();
    }

    const cap2 = captureConsole();
    try {
      assert.equal(
        await main(["track", "list", "--days", "7", "--json"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }),
        0,
      );
      const parsed = JSON.parse(cap2.out[0]);
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.days, 7);
      assert.deepEqual(parsed.records, []);
    } finally {
      cap2.restore();
    }
  });
});

describe("help, version and bare invocation", () => {
  it("--help prints the full usage screen to stdout with exit 0", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["--help"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      const text = cap.out.join("\n");
      assert.match(text, /usage:/);
      assert.match(text, /--strict\s+exit 3 if any provider failed/);
      assert.match(text, /exit codes: 0 ran · 1 runtime failure · 2 usage error · 3 --strict violation/);
      assert.equal(cap.err.length, 0);
    } finally {
      cap.restore();
    }
  });

  it("verb-scoped help: serve and init screens", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["serve", "--help"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /subtrk serve – local web console \(loopback only\)/);
      assert.equal(await main(["init", "--help"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0);
      assert.match(cap.out.join("\n"), /subtrk init – one-time interactive setup/);
    } finally {
      cap.restore();
    }
  });

  it("--version/-v/version print the package version and exit 0", async () => {
    for (const argv of [["--version"], ["-v"], ["version"]]) {
      const cap = captureConsole();
      try {
        assert.equal(await main(argv, { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 0, argv.join(" "));
        assert.match(cap.out[0], /^\d+\.\d+\.\d+/);
        assert.equal(cap.err.length, 0);
      } finally {
        cap.restore();
      }
    }
  });

  it("bare subtrk is status, never help", async () => {
    const cap = captureConsole();
    try {
      const code = await main([], { providers: [okModule("claude")], dirs: { subtrk: tempSubtrkDir() } });
      assert.equal(code, 0);
      assert.match(cap.out.join("\n"), /^claude\s+5h 13%/m);
    } finally {
      cap.restore();
    }
  });

  it("unknown command after the verb: auth alone and track bogus exit 2 with the fix on stderr", async () => {
    const cap = captureConsole();
    try {
      assert.equal(await main(["auth"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 2);
      assert.match(cap.err.join("\n"), /unknown command 'auth'/);
      assert.equal(await main(["track", "bogus"], { providers: [], dirs: { subtrk: tempSubtrkDir() } }), 2);
      assert.match(cap.err.join("\n"), /unknown command 'track bogus'/);
      assert.equal(cap.out.length, 0);
    } finally {
      cap.restore();
    }
  });
});
