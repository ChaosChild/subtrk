// sqlite-import.ts – the shared, memoized node:sqlite loader. Extracted so
// store readers (track-harvest, antigravity-store, usage) don't import each
// other just for this.
//
// node:sqlite is experimental on the Node versions we support and prints an
// ExperimentalWarning on load. Removing 'warning' listeners does NOT
// suppress it – Node prints to stderr whenever the event fires with zero
// listeners, so the event must never fire: patch process.emitWarning across
// the import (restore one immediate later, in case of a deferred call site),
// memoized so concurrent callers can't double-patch. Unavailable → no data.
let sqlitePromise: Promise<typeof import("node:sqlite") | null> | null = null;

export function importSqlite(): Promise<typeof import("node:sqlite") | null> {
  sqlitePromise ??= (async () => {
    const origEmitWarning = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      const mod = await import("node:sqlite");
      setImmediate(() => {
        process.emitWarning = origEmitWarning;
      });
      return mod;
    } catch {
      process.emitWarning = origEmitWarning;
      return null;
    }
  })();
  return sqlitePromise;
}
