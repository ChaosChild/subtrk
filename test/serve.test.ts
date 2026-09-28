// serve.test.ts – `subtrk serve` (M2): auth, host allowlist, routing, CORS
// absence. Every request targets our own listening socket on 127.0.0.1 – no
// other network. Stub providers ride the same deps seam as the CLI tests.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProviderModule } from "../src/core.ts";
import { type ServeHandle, startConsole } from "../src/serve.ts";

interface Resp {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function get(
  port: number,
  path: string,
  opts: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function noCors(h: IncomingHttpHeaders): void {
  for (const key of Object.keys(h)) {
    assert.ok(!key.toLowerCase().startsWith("access-control-"), `unexpected CORS header ${key}`);
  }
}

function okModule(id: ProviderModule["id"]): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({
      id,
      ok: true,
      stale: false,
      fetchedAt: new Date().toISOString(),
      windows: [{ kind: "5h", usedPercent: 13, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
    }),
  };
}

function failingModule(id: ProviderModule["id"]): ProviderModule {
  return {
    id,
    ttlMs: 300_000,
    probe: async () => ({
      id,
      ok: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      error: { kind: "no-credentials", message: "no credential file found", hint: "run subtrk init" },
    }),
  };
}

async function withServer(
  deps: Parameters<typeof startConsole>[0],
  fn: (h: ServeHandle) => Promise<void>,
): Promise<void> {
  const h = await startConsole(deps);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

describe("subtrk serve", () => {
  it("401 without a token", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ providers: [okModule("claude")], subtrkDir }, async (h) => {
      const r = await get(h.port, "/api/status");
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
      noCors(r.headers);
    });
  });

  it("200 with the correct Bearer token – full StatusOutput shape, erroring provider degrades", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ providers: [okModule("claude"), failingModule("google")], subtrkDir }, async (h) => {
      const r = await get(h.port, "/api/status", {
        headers: { authorization: `Bearer ${h.token}` },
      });
      assert.equal(r.status, 200);
      assert.match(r.headers["content-type"] ?? "", /^application\/json/);
      const out = JSON.parse(r.body);
      assert.equal(out.schemaVersion, 1);
      assert.match(out.checkedAt, /Z$/);
      assert.match(out.recheckAfter, /Z$/);
      assert.equal(out.providers.length, 2);
      assert.equal(out.providers[0].id, "claude");
      assert.equal(out.providers[0].ok, true);
      assert.equal(out.providers[0].windows[0].kind, "5h");
      assert.equal(out.providers[1].id, "google");
      assert.equal(out.providers[1].ok, false);
      assert.equal(out.providers[1].error.kind, "no-credentials");
      assert.ok(out.nextEvent, "nextEvent present for the ok provider");
      assert.equal(out.nextEvent.providerId, "claude");
      assert.ok(out.nextEvent.atMs > 0);
      assert.match(out.nextEvent.at, /Z$/);
      noCors(r.headers);
    });
  });

  it("timing-safe compare survives short/long/malformed tokens – all 401", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ providers: [okModule("claude")], subtrkDir }, async (h) => {
      for (const bad of ["abc", `${h.token}ff`, "0".repeat(64), ` ${h.token}`]) {
        const r = await get(h.port, "/api/status", {
          headers: { authorization: `Bearer ${bad}` },
        });
        assert.equal(r.status, 401);
      }
      for (const broken of ["Bearer", `basic ${h.token}`, ""]) {
        const r = await get(h.port, "/api/status", { headers: { authorization: broken } });
        assert.equal(r.status, 401);
      }
      const alive = await get(h.port, "/api/status", {
        headers: { authorization: `Bearer ${h.token}` },
      });
      assert.equal(alive.status, 200, "server still healthy after malformed attempts");
    });
  });

  it("host header allowlist: evil.example → 403, 127.0.0.1:<port> and localhost:<port> pass", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ providers: [okModule("claude")], subtrkDir }, async (h) => {
      const evil = await get(h.port, "/api/status", { headers: { host: "evil.example" } });
      assert.equal(evil.status, 403);
      assert.deepEqual(JSON.parse(evil.body), { error: "forbidden host" });
      const loopback = await get(h.port, "/api/status", {
        headers: { host: `127.0.0.1:${h.port}` },
      });
      assert.equal(loopback.status, 401, "host passed; auth still applies");
      const localhost = await get(h.port, "/api/status", {
        headers: { host: `localhost:${h.port}`, authorization: `Bearer ${h.token}` },
      });
      assert.equal(localhost.status, 200);
      noCors(evil.headers);
    });
  });

  it("/ serves the shell when the file exists; 404 text when missing", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    const shellPath = join(subtrkDir, "console.html");
    writeFileSync(shellPath, "<!doctype html><title>subtrk</title>");
    await withServer({ providers: [okModule("claude")], subtrkDir, consoleHtmlPath: shellPath }, async (h) => {
      const r = await get(h.port, "/");
      assert.equal(r.status, 200);
      assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(
        r.headers["content-security-policy"],
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      );
      assert.equal(r.body, "<!doctype html><title>subtrk</title>");
      noCors(r.headers);
    });
    await withServer(
      { providers: [okModule("claude")], subtrkDir, consoleHtmlPath: join(subtrkDir, "absent.html") },
      async (h) => {
        const r = await get(h.port, "/");
        assert.equal(r.status, 404);
        assert.match(r.headers["content-type"] ?? "", /^text\/plain/);
      },
    );
  });

  it("unknown routes → 404 JSON; non-GET → 405 JSON; no CORS headers anywhere", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ providers: [okModule("claude")], subtrkDir }, async (h) => {
      const miss = await get(h.port, "/nope", { headers: { authorization: `Bearer ${h.token}` } });
      assert.equal(miss.status, 404);
      assert.deepEqual(JSON.parse(miss.body), { error: "not found" });
      const post = await get(h.port, "/api/status", { method: "POST" });
      assert.equal(post.status, 405);
      assert.deepEqual(JSON.parse(post.body), { error: "method not allowed" });
      const del = await get(h.port, "/", { method: "DELETE" });
      assert.equal(del.status, 405);
      for (const r of [miss, post, del]) noCors(r.headers);
    });
  });
});

describe("POST /api/refresh", () => {
  const seedCache = (subtrkDir: string): void => {
    writeFileSync(
      join(subtrkDir, "cache.json"),
      JSON.stringify({
        schemaVersion: 1,
        claude: {
          data: {
            id: "claude",
            ok: false,
            stale: false,
            fetchedAt: new Date().toISOString(),
            error: { kind: "no-credentials", message: "stale" },
          },
          fetchedAt: Date.now(),
          ttlMs: 300_000,
        },
      }),
    );
  };

  it("401 without a token; no refresh dep is called", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    let called = 0;
    await withServer(
      {
        subtrkDir,
        refresh: async () => {
          called += 1;
          return { ok: true, message: "x" };
        },
      },
      async (h) => {
        const r = await get(h.port, "/api/refresh?provider=claude", { method: "POST" });
        assert.equal(r.status, 401);
        assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
        assert.equal(called, 0);
        noCors(r.headers);
      },
    );
  });

  it("GET → 405 with allow: POST", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir, refresh: async () => ({ ok: true, message: "x" }) }, async (h) => {
      const r = await get(h.port, "/api/refresh?provider=claude", {
        headers: { authorization: `Bearer ${h.token}` },
      });
      assert.equal(r.status, 405);
      assert.equal(r.headers.allow, "POST");
      assert.deepEqual(JSON.parse(r.body), { error: "method not allowed" });
      noCors(r.headers);
    });
  });

  it("unknown or non-refreshable provider → 400", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir, refresh: async () => ({ ok: true, message: "x" }) }, async (h) => {
      for (const id of ["openrouter", "nope"]) {
        const r = await get(h.port, `/api/refresh?provider=${id}`, {
          method: "POST",
          headers: { authorization: `Bearer ${h.token}` },
        });
        assert.equal(r.status, 400);
        assert.deepEqual(JSON.parse(r.body), { error: "unknown or non-refreshable provider" });
        noCors(r.headers);
      }
    });
  });

  it("happy path: 200 ok:true, fixed message, status cache entry dropped", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    seedCache(subtrkDir);
    let seen = "";
    await withServer(
      {
        subtrkDir,
        refresh: async (id) => {
          seen = id;
          return { ok: true, message: "console session re-authorised" };
        },
      },
      async (h) => {
        const r = await get(h.port, "/api/refresh?provider=claude", {
          method: "POST",
          headers: { authorization: `Bearer ${h.token}` },
        });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body), { ok: true, message: "console session re-authorised" });
        assert.equal(seen, "claude");
        const cache = JSON.parse(readFileSync(join(subtrkDir, "cache.json"), "utf8"));
        assert.ok(!("claude" in cache), "successful refresh must drop the cache entry");
        noCors(r.headers);
      },
    );
  });

  it("second request while one is in flight → 409, first still completes", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await withServer(
      {
        subtrkDir,
        refresh: () => gate.then(() => ({ ok: true, message: "done" })),
      },
      async (h) => {
        const headers = { authorization: `Bearer ${h.token}` };
        const first = get(h.port, "/api/refresh?provider=claude", { method: "POST", headers });
        await new Promise((r) => setTimeout(r, 75));
        const second = await get(h.port, "/api/refresh?provider=claude", { method: "POST", headers });
        assert.equal(second.status, 409);
        assert.deepEqual(JSON.parse(second.body), { error: "refresh already running" });
        release();
        const done = await first;
        assert.equal(done.status, 200);
        assert.deepEqual(JSON.parse(done.body), { ok: true, message: "done" });
      },
    );
  });

  it("ok:false outcome → still 200, body carries the failure, cache entry kept", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    seedCache(subtrkDir);
    await withServer(
      {
        subtrkDir,
        refresh: async () => ({ ok: false, message: "console login failed – run subtrk init" }),
      },
      async (h) => {
        const r = await get(h.port, "/api/refresh?provider=claude", {
          method: "POST",
          headers: { authorization: `Bearer ${h.token}` },
        });
        assert.equal(r.status, 200);
        assert.deepEqual(JSON.parse(r.body), { ok: false, message: "console login failed – run subtrk init" });
        const cache = JSON.parse(readFileSync(join(subtrkDir, "cache.json"), "utf8"));
        assert.ok("claude" in cache, "failed refresh must keep the cache entry");
        noCors(r.headers);
      },
    );
  });
});

describe("POST /api/config", () => {
  const postConfig = (h: ServeHandle, body: string): Promise<Resp> =>
    get(h.port, "/api/config", {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body,
    });

  it("401 without a token – nothing is written", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const r = await get(h.port, "/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: ["claude"] }),
      });
      assert.equal(r.status, 401);
      assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
      assert.equal(existsSync(join(subtrkDir, "config.json")), false);
      noCors(r.headers);
    });
  });

  it("GET with a token → current display config; without → 401", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const noToken = await get(h.port, "/api/config", {});
      assert.equal(noToken.status, 401);
      assert.deepEqual(JSON.parse(noToken.body), { error: "unauthorized" });
      noCors(noToken.headers);
      const ok = await get(h.port, "/api/config", { headers: { authorization: `Bearer ${h.token}` } });
      assert.equal(ok.status, 200);
      const body = JSON.parse(ok.body) as { enabled: string[]; order: string[]; hidden: string[] };
      assert.ok(Array.isArray(body.enabled) && body.enabled.length > 0);
      assert.deepEqual(body.order, []);
      assert.deepEqual(body.hidden, []);
      noCors(ok.headers);
    });
  });

  it("400 on a non-JSON body and on a body missing both keys", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const broken = await postConfig(h, "{not json");
      assert.equal(broken.status, 400);
      assert.deepEqual(JSON.parse(broken.body), { error: "invalid config body" });
      const noKeys = await postConfig(h, JSON.stringify({ foo: ["claude"] }));
      assert.equal(noKeys.status, 400);
      assert.deepEqual(JSON.parse(noKeys.body), { error: "config body must include enabled, order or hidden" });
      noCors(broken.headers);
    });
  });

  it("400 on an unknown id in enabled and on an empty enabled", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const unknown = await postConfig(h, JSON.stringify({ enabled: ["claude", "nope"] }));
      assert.equal(unknown.status, 400);
      assert.deepEqual(JSON.parse(unknown.body), { error: "unknown provider id in enabled" });
      const empty = await postConfig(h, JSON.stringify({ enabled: [] }));
      assert.equal(empty.status, 400);
      assert.deepEqual(JSON.parse(empty.body), { error: "enabled must contain at least one provider id" });
      assert.equal(existsSync(join(subtrkDir, "config.json")), false, "rejected patches write nothing");
    });
  });

  it("200 enabled-only write lands atomically on disk with a trailing newline", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const r = await postConfig(h, JSON.stringify({ enabled: ["claude", "google"] }));
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { ok: true });
      const raw = readFileSync(join(subtrkDir, "config.json"), "utf8");
      assert.ok(raw.endsWith("\n"), "newline-terminated");
      assert.deepEqual(JSON.parse(raw), { enabled: ["claude", "google"] });
      noCors(r.headers);
    });
  });

  it("200 order-only write; duplicates in order are dropped", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const r = await postConfig(h, JSON.stringify({ order: ["kimi", "claude", "kimi"] }));
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { ok: true });
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), {
        order: ["kimi", "claude"],
      });
      noCors(r.headers);
    });
  });

  it("200 with both keys", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const r = await postConfig(h, JSON.stringify({ enabled: ["claude"], order: ["claude", "openai"] }));
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { ok: true });
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), {
        enabled: ["claude"],
        order: ["claude", "openai"],
      });
    });
  });

  it("hidden card keys: written deduped, malformed rejected, unknown prefix rejected", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    await withServer({ subtrkDir }, async (h) => {
      const ok = await postConfig(
        h,
        JSON.stringify({ hidden: ["google:gemini-models", "google:gemini-models", "claude"] }),
      );
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.body), { ok: true });
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), {
        hidden: ["google:gemini-models", "claude"],
      });

      const badSlug = await postConfig(h, JSON.stringify({ hidden: ["google:Gemini"] }));
      assert.equal(badSlug.status, 400);
      assert.deepEqual(JSON.parse(badSlug.body), { error: "invalid card key in hidden" });

      const badPrefix = await postConfig(h, JSON.stringify({ hidden: ["nope"] }));
      assert.equal(badPrefix.status, 400);
      assert.deepEqual(JSON.parse(badPrefix.body), { error: "invalid card key in hidden" });

      // a valid write followed by a rejected one keeps the earlier file intact
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), {
        hidden: ["google:gemini-models", "claude"],
      });

      const cleared = await postConfig(h, JSON.stringify({ hidden: [] }));
      assert.equal(cleared.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), { hidden: [] });

      const roundtrip = await get(h.port, "/api/config", { headers: { authorization: `Bearer ${h.token}` } });
      assert.deepEqual(JSON.parse(roundtrip.body).hidden, []);
    });
  });

  it("200 preserves an unknown pre-existing key in config.json", async () => {
    const subtrkDir = mkdtempSync(join(tmpdir(), "subtrk-serve-"));
    writeFileSync(join(subtrkDir, "config.json"), JSON.stringify({ enabled: ["claude"], custom: 42 }));
    await withServer({ subtrkDir }, async (h) => {
      const r = await postConfig(h, JSON.stringify({ order: ["google", "claude"] }));
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(subtrkDir, "config.json"), "utf8")), {
        enabled: ["claude"],
        order: ["google", "claude"],
        custom: 42,
      });
    });
  });
});
