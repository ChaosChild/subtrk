// input-trace.ts – cache identity stamps (wrong-account protection). A probe
// runs inside withInputTrace(); every credential file it opens calls
// traceInput(path) BEFORE the read and every credential env var it consults
// calls traceEnv(name, value). The recorder snapshots identity stats only
// (dev/ino/size/mtimes – never file contents) and one-way env value digests
// (values are hashed, never stored), so core.ts can stamp the cache record and
// later re-verify cheaply: any change to a traced file's identity or any traced
// env value makes the recorded digest stale and forces a re-probe instead of
// answering with the previous account's data.
// Lock/stamp approach after quota-axi (MIT), github.com/kunchenguid/quota-axi.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, scryptSync } from "node:crypto";
import { statSync } from "node:fs";

interface TraceStore {
  files: Map<string, string>; // path -> identity state at trace time
  env: Map<string, string>; // name -> one-way digest of the value at trace time
}

const trace = new AsyncLocalStorage<TraceStore>();

/** What a probe traced: sorted paths/names plus the digests computed from them. */
export interface TracedInputs {
  /** Every traced file path, sorted. */
  paths: string[];
  /** Every traced env var name, sorted. */
  envNames: string[];
  /** Identity states aligned with `paths` (sorted order). */
  fileStates: string[];
  /** [name, envValueDigest(value)] pairs sorted by name – values never appear. */
  envPairs: [string, string][];
  /** sha256 of the sorted, path-labeled stat list plus the env digest pairs. */
  digest: string;
}

/**
 * Record that the current probe is about to consult `path`, present or not.
 * Its identity is captured now, before the read, so a credential file
 * rewritten while the probe is still in flight can never be vouched for by it.
 * No-op outside withInputTrace.
 */
export function traceInput(path: string): void {
  const store = trace.getStore();
  if (!store) return;
  store.files.set(path, fileState(path));
}

/**
 * Record that the current probe consulted env var `name` and resolved it to
 * `value` (whatever the caller will actually use – process.env first, then
 * ~/.subtrk/env). Only sha256(value) is kept. No-op outside withInputTrace.
 */
export function traceEnv(name: string, value: string | undefined): void {
  const store = trace.getStore();
  if (!store) return;
  store.env.set(name, envValueDigest(value));
}

/** Run `fn` and return what it produced plus every input it traced. */
export async function withInputTrace<T>(fn: () => Promise<T>): Promise<{ value: T; inputs: TracedInputs }> {
  const store: TraceStore = { files: new Map(), env: new Map() };
  const value = await trace.run(store, fn);
  const paths = [...store.files.keys()].sort();
  const envNames = [...store.env.keys()].sort();
  const fileStates = paths.map((p) => store.files.get(p) as string);
  const envPairs = envNames.map((n) => [n, store.env.get(n) as string] as [string, string]);
  return {
    value,
    inputs: { paths, envNames, fileStates, envPairs, digest: inputsDigest(fileStates, envPairs) },
  };
}

/**
 * Identity state of `path` right now: dev, ino, size, mtimeMs, ctimeMs under
 * the path label – or the errno when absent. Contents are never read, so a
 * credential file's bytes never enter the digest.
 */
export function fileState(path: string): string {
  try {
    const s = statSync(path);
    return [path, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
  } catch (err) {
    const code =
      err !== null && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "unreadable";
    return `${path}:${code}`;
  }
}

/**
 * One-way digest of an env value – the value itself is never stored. Derived
 * with scrypt (not a fast hash) because the digest persists on disk in
 * cache.json: an offline attacker holding the file must brute-force through a
 * slow KDF per guess, which matters if a traced value is ever low-entropy.
 * Cost is ~45ms per derivation, worst-case ~0.75s per status across all
 * providers' traced envs – acceptable for a network-bound CLI.
 */
export function envValueDigest(value: string | undefined): string {
  return scryptSync(value ?? "", "subtrk-env-stamp-v1", 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}

/** sha256 of the sorted file-state list and the sorted [name, valueDigest] pairs. */
export function inputsDigest(fileStates: readonly string[], envPairs: readonly [string, string][]): string {
  return createHash("sha256")
    .update(JSON.stringify(["subtrk-inputs-v1", [...fileStates], [...envPairs]]))
    .digest("hex");
}

/** The stamp digest: sha256 over [provider, env NAMES+value-digests, input stat digests]. */
export function stampDigest(
  provider: string,
  fileStates: readonly string[],
  envPairs: readonly [string, string][],
): string {
  return createHash("sha256")
    .update(JSON.stringify(["subtrk-stamp-v1", provider, [...envPairs], [...fileStates]]))
    .digest("hex");
}
