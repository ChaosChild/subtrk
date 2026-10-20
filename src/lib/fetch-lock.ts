// fetch-lock.ts – cross-process single-flight for provider probes. Processes
// that start together on a cold (or expired) cache would each miss and probe
// the vendor; the one that creates the per-provider lock file probes and
// writes the cache, and the rest poll the cache for that write instead. The
// lock only saves vendor calls: every result a waiter serves still passes the
// cache's own TTL and stamp checks, so a lost race, a double takeover, or a
// timed-out wait costs at most an extra probe, never a wrong answer.
// Lock/stamp approach after quota-axi (MIT), github.com/kunchenguid/quota-axi.

import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export type FetchLock = { release(): void };

export type FetchTurn<T> =
  /** Another holder's probe landed in the cache; serve it. */
  | { kind: "answered"; value: T }
  /** This process holds the lock: probe, write the cache, then release. */
  | { kind: "leader"; lock: FetchLock }
  /** No answer within the wait, the holder released nothing reusable, or the lock cannot be taken here: probe anyway. */
  | { kind: "unlocked" };

export interface FetchTurnOptions {
  /** Total wait budget for a waiter (default 30s). */
  waitMs?: number;
  /** Cache poll cadence while waiting (default 100ms). */
  pollMs?: number;
  /** A lock older than this is abandoned even when its holder looks alive (default 120s). */
  staleMs?: number;
}

// Long enough to cover a probe's own 10s timeout plus process start-up, short
// enough that a wedged holder only delays a waiter once.
const WAIT_MS = 30_000;
const POLL_MS = 100;
// Longer than any single probe; a lock past this age is abandoned even when
// its pid looks alive (pid reuse, or another host sharing the state dir).
const STALE_MS = 120_000;
// A synchronous holder (cache write read-modify-write) only rewrites one file.
const SYNC_WAIT_MS = 5_000;
const SYNC_POLL_MS = 10;

interface Holder {
  pid: number;
  host: string;
  token: string;
}

/** The lock file for one provider key under the state dir. */
export function fetchLockPath(cacheDir: string, key: string): string {
  return join(cacheDir, "locks", `fetch-${key}.lock`);
}

/**
 * Take a turn at probing for the lock at `path`. `answer` is the cache lookup
 * that serves a probe another process has just written; it is consulted again
 * right after acquiring, because the previous holder may have cached a result
 * between this process's first lookup and its acquisition.
 */
export async function takeFetchTurn<T>(
  path: string,
  answer: () => T | undefined,
  { waitMs = WAIT_MS, pollMs = POLL_MS, staleMs = STALE_MS }: FetchTurnOptions = {},
): Promise<FetchTurn<T>> {
  // Monotonic, so a wall-clock jump (or a test's fake Date) cannot stall it.
  const deadline = performance.now() + waitMs;
  let waited = false;
  for (;;) {
    const lock = tryLock(path);
    if (lock === "unavailable") return { kind: "unlocked" };
    if (lock) {
      const value = answer();
      if (value !== undefined) {
        lock.release();
        return { kind: "answered", value };
      }
      if (!waited) return { kind: "leader", lock };
      // The previous holder answered nothing, so becoming leader would only
      // queue the waiters behind the same unanswerable probe one at a time.
      lock.release();
      return { kind: "unlocked" };
    }
    waited = true;
    const value = answer();
    if (value !== undefined) return { kind: "answered", value };
    if (performance.now() >= deadline) return { kind: "unlocked" };
    const state = settleHolder(path, staleMs);
    // A crashed or wedged holder answered nothing, so the taker leads.
    if (state === "abandoned") waited = false;
    if (state === "held") await sleep(pollMs);
  }
}

/**
 * Run `fn` while holding the lock at `path` – for a critical section as short
 * as a cache file's read-modify-write, so concurrent writers merge instead of
 * clobber. Takes over an abandoned lock like takeFetchTurn; when the wait runs
 * out or the lock cannot be taken here, `fn` runs unlocked (a lost merge costs
 * one future re-probe, never an error).
 */
export function withLockSync<T>(
  path: string,
  fn: () => T,
  { waitMs = SYNC_WAIT_MS, pollMs = SYNC_POLL_MS, staleMs = STALE_MS }: FetchTurnOptions = {},
): T {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const lock = tryLock(path);
    if (lock === "unavailable") return fn();
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (performance.now() >= deadline) return fn();
    if (settleHolder(path, staleMs) === "held") sleepSync(pollMs);
  }
}

/**
 * Whether a live peer holds the lock at `path` right now – a peek, never a
 * take (an abandoned lock is cleared as a side effect, like a waiter would).
 */
export function fetchLockHeld(path: string, staleMs: number = STALE_MS): boolean {
  return settleHolder(path, staleMs) === "held";
}

/**
 * Run an async `fn` while holding the lock at `path`, serialising every holder
 * across processes AND within this process (both go through the same O_EXCL
 * file, so a second local caller just polls until the first releases). Unlike
 * takeFetchTurn this is a plain mutex: there is no cache to answer from, and a
 * waiter that outlasts `waitMs` does NOT run unlocked – serialisation is the
 * point – so it resolves `undefined` and the caller decides how to fail.
 * `staleMs` must exceed the longest legitimate hold, or a slow holder gets its
 * lock taken over mid-flight by a peer.
 */
export async function withCrossProcessLock<T>(
  path: string,
  fn: () => Promise<T>,
  { waitMs = 30_000, pollMs = POLL_MS, staleMs = STALE_MS }: FetchTurnOptions = {},
): Promise<T | undefined> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const lock = tryLock(path);
    if (lock === "unavailable") return undefined;
    if (lock) {
      try {
        return await fn();
      } finally {
        lock.release();
      }
    }
    if (performance.now() >= deadline) return undefined;
    if (settleHolder(path, staleMs) === "held") await sleep(pollMs);
  }
}

/**
 * Create the lock file exclusively with O_EXCL ("wx") – atomic on every
 * platform Node supports, so exactly one process wins. `undefined` means
 * another process holds it; `"unavailable"` means no lock can be taken here.
 */
function tryLock(path: string): FetchLock | "unavailable" | undefined {
  const token = randomUUID();
  let fd: number;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    fd = openSync(path, "wx");
  } catch (error) {
    return errorCode(error) === "EEXIST" ? undefined : "unavailable";
  }
  try {
    const holder: Holder = { pid: process.pid, host: hostname(), token };
    writeSync(fd, JSON.stringify(holder));
  } catch {
    // A holder-less lock is judged by age (see holderState) – close and keep it.
  } finally {
    closeSync(fd);
  }
  return { release: () => removeIfHeldBy(path, token) };
}

function readHolder(path: string): Holder | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<Holder>;
    return typeof data.pid === "number" && typeof data.host === "string" && typeof data.token === "string"
      ? { pid: data.pid, host: data.host, token: data.token }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lock's holder state after one wait step, with an abandoned lock already
 * removed so the next attempt can take it.
 */
function settleHolder(path: string, staleMs: number): "released" | "abandoned" | "held" {
  const holder = readHolder(path);
  const state = holderState(path, holder, staleMs);
  if (state === "abandoned") removeIfHeldBy(path, holder?.token);
  return state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* not allowed on this thread – retry immediately */
  }
}

/**
 * Whether the holder released the lock, crashed or wedged, or still holds it.
 * A lock whose contents are not yet written is only its creator between two
 * syscalls, so it is judged by age. Stale rules: older than `staleMs`, holder
 * pid provably dead (ESRCH or any unexpected kill(0) error; EPERM means
 * alive-but-foreign), or a holder from a different host – its pid says nothing
 * about this machine, so it is treated as dead.
 */
function holderState(path: string, holder: Holder | undefined, staleMs: number): "released" | "abandoned" | "held" {
  let modifiedAt: number;
  try {
    modifiedAt = statSync(path).mtimeMs;
  } catch {
    return "released";
  }
  if (Date.now() - modifiedAt > staleMs) return "abandoned";
  if (!holder) return "held";
  if (holder.host !== hostname()) return "abandoned"; // foreign host – cannot be ours
  return pidAlive(holder.pid) ? "held" : "abandoned";
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, owned by another user. ESRCH and anything else: dead.
    return errorCode(err) === "EPERM";
  }
}

/**
 * Remove the lock only while it still carries `token`. The read and unlink are
 * not atomic, so two processes taking over one abandoned lock can both
 * proceed; that costs one extra probe and nothing else.
 */
function removeIfHeldBy(path: string, token: string | undefined): void {
  try {
    if (readHolder(path)?.token !== token) return;
    unlinkSync(path);
  } catch {
    return;
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
