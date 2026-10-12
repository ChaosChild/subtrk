// claude-env-token.test.ts – the CLAUDE_CODE_OAUTH_TOKEN lane: env precedence
// over the credential file (Claude Code's own order), the invalid-credential
// classification for non-literal env values, the no-refresh guarantee on an
// expired response, the identity split between the two lanes' cache stamps,
// the NON-SILENT rotation write-back failure, and CLAUDE_CONFIG_DIR.
// Offline: global fetch is stubbed for every call (an unrouted URL hard-fails,
// so "no request sent" is provable, not assumed); a temp HOME isolates the
// credential store; CLAUDE_* env vars are stripped at module load, before any
// src import.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// ---- environment isolation: BEFORE any src import (dynamic below) ----------
const tempHome = mkdtempSync(join(tmpdir(), "subtrk-claude-env-"));
const SAVED_ENV = new Map<string, string | undefined>();
const CLAUDE_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
const HOME_KEYS = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"];
for (const k of [...CLAUDE_KEYS, ...HOME_KEYS]) SAVED_ENV.set(k, process.env[k]);
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.APPDATA = join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(tempHome, "AppData", "Local");
for (const k of CLAUDE_KEYS) delete process.env[k];
after(() => {
  for (const [k, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const claudeMod = (await import("../src/providers/claude.ts")).default;
const { fetchProvider } = await import("../src/core.ts");

// ---- fixtures & helpers ----------------------------------------------------

const ENV_TOKEN = "env-lane-access-token";
const FILE_TOKEN = "file-lane-access-token";
const CUSTOM_TOKEN = "custom-dir-access-token";
const REFRESHED_ACCESS = "refreshed-access-token";
const REFRESHED_REFRESH = "refreshed-refresh-token";
const USAGE_BODY = {
  five_hour: { utilization: 40, resets_at: "2026-10-13T00:00:00.000Z" },
  seven_day: { utilization: 20, resets_at: "2026-10-15T00:00:00.000Z" },
};

function credsJson(accessToken: string, expiresAt: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, ...extra } });
}

interface HomeHandle {
  home: string;
  credPath: string;
  writeCreds(accessToken: string, expiresAt: number, extra?: Record<string, unknown>): void;
}

// Fresh temp home per test: the default store lives at <home>/.claude.
async function withHome(fn: (h: HomeHandle) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "subtrk-claude-home-"));
  const saved = new Map<string, string | undefined>(HOME_KEYS.map((k) => [k, process.env[k]]));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  const credPath = join(home, ".claude", ".credentials.json");
  const handle: HomeHandle = {
    home,
    credPath,
    writeCreds(accessToken: string, expiresAt: number, extra: Record<string, unknown> = {}): void {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(credPath, credsJson(accessToken, expiresAt, extra));
    },
  };
  try {
    await fn(handle);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function setEnvToken(v: string | undefined): void {
  if (v === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = v;
}

interface FetchCall {
  url: string;
  authHeader: string | undefined;
}

interface Route {
  status: number;
  body: unknown;
}

// Stub every fetch: route by URL substring; an unrouted URL hard-fails so a
// "must not reach the network" assertion can never pass by accident.
function stubFetch(
  t: { after(fn: () => unknown): unknown },
  routes: Record<string, Route>,
): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authHeader: headers.Authorization });
    for (const [needle, route] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status }));
      }
    }
    return Promise.reject(new Error(`network must not be reached: ${url}`));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

const USAGE = "api.anthropic.com/api/oauth/usage";
const REFRESH = "console.anthropic.com/v1/oauth/token";
const OK_ROUTES: Record<string, Route> = { [USAGE]: { status: 200, body: USAGE_BODY } };
const ROTATE_ROUTES: Record<string, Route> = {
  [USAGE]: { status: 200, body: USAGE_BODY },
  [REFRESH]: {
    status: 200,
    body: { access_token: REFRESHED_ACCESS, refresh_token: REFRESHED_REFRESH, expires_in: 3600 },
  },
};

const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 3_600_000;

function usageCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.includes(USAGE));
}

// ---- env-token lane ----------------------------------------------------------

describe("claude env-token lane", () => {
  it("env token wins over a valid file credential (Claude Code's own order)", async (t) => {
    await withHome(async (h) => {
      h.writeCreds(FILE_TOKEN, FUTURE);
      setEnvToken(ENV_TOKEN);
      t.after(() => setEnvToken(undefined));
      const { calls } = stubFetch(t, OK_ROUTES);
      const r = await claudeMod.probe();
      assert.equal(r.ok, true);
      assert.equal(r.windows?.length, 2);
      assert.deepEqual(
        usageCalls(calls).map((c) => c.authHeader),
        [`Bearer ${ENV_TOKEN}`],
        "the env token authenticates the usage read",
      );
      assert.ok(!calls.some((c) => c.url.includes(REFRESH)), "env tokens are never refreshed");
    });
  });

  it("blank env value is nothing selected: falls through to the file lane", async (t) => {
    await withHome(async (h) => {
      h.writeCreds(FILE_TOKEN, FUTURE);
      for (const blank of ["", "   ", "\t\r\n"]) {
        setEnvToken(blank);
        t.after(() => setEnvToken(undefined));
        const { calls } = stubFetch(t, OK_ROUTES);
        const r = await claudeMod.probe();
        assert.equal(r.ok, true, JSON.stringify(blank));
        assert.deepEqual(
          usageCalls(calls).map((c) => c.authHeader),
          [`Bearer ${FILE_TOKEN}`],
          `blank value ${JSON.stringify(blank)} must select the file credential`,
        );
      }
    });
  });

  it("non-literal env token -> INVALID credential, parse-failure, nothing sent", async (t) => {
    await withHome(async (h) => {
      h.writeCreds(FILE_TOKEN, FUTURE); // a usable file lane must NOT be consulted either
      for (const bad of ["$env-indirected", "!history-expansion", "tok\x07en"]) {
        setEnvToken(bad);
        t.after(() => setEnvToken(undefined));
        const { calls } = stubFetch(t, OK_ROUTES);
        const r = await claudeMod.probe();
        assert.equal(r.ok, false, JSON.stringify(bad));
        assert.equal(r.error?.kind, "parse-failure");
        assert.equal(
          r.error.message,
          "CLAUDE_CODE_OAUTH_TOKEN is not a literal secret (indirection) – refusing to use it",
        );
        assert.equal(calls.length, 0, "present-but-unusable is never sent");
        assert.equal(r.windows, undefined);
        if (!bad.includes("\x07")) {
          assert.ok(!JSON.stringify(r).includes(bad), "the raw value never enters the result");
        }
      }
    });
  });

  it("expired response under env token: expired-token error with a hint, NO refresh exchange", async (t) => {
    await withHome(async (h) => {
      // the file store even holds a refreshable-looking expired pair – the
      // env lane must not touch it
      h.writeCreds("expired-file-token", PAST, { refreshToken: "file-refresh-token" });
      setEnvToken(ENV_TOKEN);
      t.after(() => setEnvToken(undefined));
      const { calls } = stubFetch(t, { [USAGE]: { status: 401, body: { error: "expired" } } });
      const r = await claudeMod.probe();
      assert.equal(r.ok, false);
      assert.equal(r.error?.kind, "expired-token");
      assert.match(r.error.hint ?? "", /CLAUDE_CODE_OAUTH_TOKEN/, "the hint names the env lane");
      assert.ok(!calls.some((c) => c.url.includes(REFRESH)), "no rotation attempt in the env lane");
    });
  });
});

// ---- cache identity split -----------------------------------------------------

describe("claude cache identity split", () => {
  it("the env-lane stamp never serves the file lane (and the file stamp takes over after unset)", async (t) => {
    await withHome(async (h) => {
      h.writeCreds(FILE_TOKEN, FUTURE);
      const cachePath = join(h.home, "cache.json");
      setEnvToken(ENV_TOKEN);
      t.after(() => setEnvToken(undefined));
      const { calls } = stubFetch(t, OK_ROUTES);

      const r1 = await fetchProvider(claudeMod, { cachePath });
      assert.equal(r1.ok, true);
      assert.deepEqual(
        usageCalls(calls).map((c) => c.authHeader),
        [`Bearer ${ENV_TOKEN}`],
      );
      const entry1 = (
        JSON.parse(readFileSync(cachePath, "utf8")) as {
          claude: { stamp: { envNames: string[]; paths: string[]; digest: string } };
        }
      ).claude;
      assert.ok(entry1.stamp.envNames.includes("CLAUDE_CODE_OAUTH_TOKEN"), "the env lane traces the env var");
      assert.deepEqual(entry1.stamp.paths, [], "the env lane never reads the file – no file identity recorded");

      setEnvToken(undefined); // unset -> the file lane is now the credential
      const r2 = await fetchProvider(claudeMod, { cachePath });
      assert.equal(r2.ok, true);
      assert.deepEqual(
        usageCalls(calls).map((c) => c.authHeader),
        [`Bearer ${ENV_TOKEN}`, `Bearer ${FILE_TOKEN}`],
        "the env-selected entry must not be stamp-served for the file lane",
      );
      const entry2 = (
        JSON.parse(readFileSync(cachePath, "utf8")) as {
          claude: { stamp: { envNames: string[]; paths: string[]; digest: string } };
        }
      ).claude;
      assert.notEqual(entry1.stamp.digest, entry2.stamp.digest, "the two lanes carry different stamps");
      assert.deepEqual(entry2.stamp.envNames, entry1.stamp.envNames, "same names, different value digests");
      assert.equal(entry2.stamp.paths.length, 1, "the file lane records the credential file");

      const r3 = await fetchProvider(claudeMod, { cachePath });
      assert.equal(r3.ok, true);
      assert.equal(usageCalls(calls).length, 2, "the file-lane stamp now serves reuse");
    });
  });

  it("stamp-level: tracing the env value digest is what splits the lanes", async (t) => {
    const { envValueDigest, fileState, stampDigest } = await import("../src/lib/input-trace.ts");
    const cred = join(mkdtempSync(join(tmpdir(), "subtrk-claude-stamp-")), "x", ".credentials.json");
    t.after(() => rmSync(join(cred, "..", ".."), { recursive: true, force: true }));
    const states = [fileState(cred)]; // identical file identity on both sides
    const envLane = stampDigest("claude", states, [["CLAUDE_CODE_OAUTH_TOKEN", envValueDigest(ENV_TOKEN)]]);
    const fileLane = stampDigest("claude", states, [["CLAUDE_CODE_OAUTH_TOKEN", envValueDigest(undefined)]]);
    assert.notEqual(envLane, fileLane, "traceEnv hashing the value is the lane split");
    assert.equal(
      fileLane,
      stampDigest("claude", states, [["CLAUDE_CODE_OAUTH_TOKEN", envValueDigest(undefined)]]),
      "an unset env var keeps a stable digest – no accidental lane flipping",
    );
  });
});

// ---- rotation write-back -------------------------------------------------------

describe("claude rotation write-back", () => {
  // Deterministic, cross-platform way to break the write: the helper's
  // temp+rename writes to `<credPath>.<pid>.tmp` first – a DIRECTORY at that
  // exact path makes writeFileSync throw on both attempts.
  function breakWriteBack(h: { credPath: string }): string {
    const tmpDir = `${h.credPath}.${process.pid}.tmp`;
    mkdirSync(tmpDir);
    return tmpDir;
  }

  it("successful rotation: store updated, no note", async (t) => {
    await withHome(async (h) => {
      h.writeCreds("expired-file-token", PAST, { refreshToken: "file-refresh-token" });
      const { calls } = stubFetch(t, ROTATE_ROUTES);
      const r = await claudeMod.probe();
      assert.equal(r.ok, true);
      assert.equal(r.note, undefined, "a clean write-back adds no warning");
      const store = JSON.parse(readFileSync(h.credPath, "utf8")) as {
        claudeAiOauth: { accessToken: string; refreshToken: string };
      };
      assert.equal(store.claudeAiOauth.accessToken, REFRESHED_ACCESS, "rotated pair persisted");
      assert.equal(store.claudeAiOauth.refreshToken, REFRESHED_REFRESH);
      assert.equal(usageCalls(calls)[0]?.authHeader, `Bearer ${REFRESHED_ACCESS}`);
    });
  });

  it("failed write-back is surfaced on an ok result; the store is left untouched", async (t) => {
    await withHome(async (h) => {
      h.writeCreds("expired-file-token", PAST, { refreshToken: "file-refresh-token" });
      const { calls } = stubFetch(t, ROTATE_ROUTES);
      const tmpDir = breakWriteBack(h);
      t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
      const r = await claudeMod.probe();
      assert.equal(r.ok, true, "the usage reading itself is valid – warning, not error");
      assert.match(r.note ?? "", /credential store could not be updated/);
      assert.match(r.note ?? "", /claude \/login/);
      assert.equal(usageCalls(calls)[0]?.authHeader, `Bearer ${REFRESHED_ACCESS}`);
      const store = JSON.parse(readFileSync(h.credPath, "utf8")) as {
        claudeAiOauth: { accessToken: string; refreshToken: string };
      };
      assert.equal(store.claudeAiOauth.accessToken, "expired-file-token", "store read back unchanged");
      assert.equal(store.claudeAiOauth.refreshToken, "file-refresh-token", "the spent token is not persisted");
    });
  });

  it("the interactive refresh message carries the write-back warning too", async (t) => {
    await withHome(async (h) => {
      h.writeCreds("expired-file-token", PAST, { refreshToken: "file-refresh-token" });
      stubFetch(t, ROTATE_ROUTES);
      const tmpDir = breakWriteBack(h);
      t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
      const refresh = claudeMod.refresh;
      assert.ok(refresh, "the claude module exposes an interactive refresh");
      const rr = await refresh();
      assert.equal(rr.ok, true);
      assert.match(rr.message, /credential store could not be updated/);
    });
  });
});

// ---- CLAUDE_CONFIG_DIR ---------------------------------------------------------

describe("claude CLAUDE_CONFIG_DIR", () => {
  it("an override moves the store; the default location is ignored", async (t) => {
    await withHome(async (h) => {
      // poison the default store: if the probe consulted it, it would parse-fail
      h.writeCreds(FILE_TOKEN, FUTURE);
      writeFileSync(h.credPath, "{not json");
      const customDir = join(h.home, "claude-custom");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(join(customDir, ".credentials.json"), credsJson(CUSTOM_TOKEN, FUTURE));
      process.env.CLAUDE_CONFIG_DIR = customDir;
      t.after(() => delete process.env.CLAUDE_CONFIG_DIR);
      const { calls } = stubFetch(t, OK_ROUTES);
      const r = await claudeMod.probe();
      assert.equal(r.ok, true, "the overridden store is the one consulted");
      assert.equal(usageCalls(calls)[0]?.authHeader, `Bearer ${CUSTOM_TOKEN}`);
    });
  });

  it("a blank override falls back to ~/.claude", async (t) => {
    await withHome(async (h) => {
      h.writeCreds(FILE_TOKEN, FUTURE);
      process.env.CLAUDE_CONFIG_DIR = "   ";
      t.after(() => delete process.env.CLAUDE_CONFIG_DIR);
      const { calls } = stubFetch(t, OK_ROUTES);
      const r = await claudeMod.probe();
      assert.equal(r.ok, true);
      assert.equal(usageCalls(calls)[0]?.authHeader, `Bearer ${FILE_TOKEN}`);
    });
  });
});
