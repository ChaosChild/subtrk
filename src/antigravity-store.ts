// antigravity-store.ts – read-only reader for Antigravity's local conversation
// stores under ~/.gemini/antigravity, shared by the track window harvest and
// the usage harvest. Layout (reverse-engineered 2026-10-28 against all 59
// conversation dbs on the operator's machine; field numbers may drift with
// Antigravity updates – the per-row guards fail closed, see readUsageRows):
//   conversation_summaries.db, table conversation_summaries:
//     conversation_id (also the per-conversation db filename), workspace_uris
//     (JSON array of percent-encoded file:/// URIs), last_modified_time
//     (TEXT datetime with timezone).
//   conversations/<conversation_id>.db (WAL – a readOnly open is safe while
//   the app is running):
//     steps.metadata blob, one row per step:
//       .1  Timestamp {.1 unix seconds, .2 nanos}
//       .9  usage block, present only on steps that produced a generation:
//           {.2 UNCACHED input, .5 cache-read input, .3 output total,
//            .9 visible output, .10 thinking output, .1 model enum}
//       .11 model enum, .12 generation id
//     gen_metadata.data blob: {.4 generation id, .1.19 served model id string}
//   Accounting conventions: input is UNCACHED (Gemini implicit caching has no
//   write cost – cw is always 0) and output includes thinking (the identity
//   .3 == .9 + .10 held on every sampled row and is enforced per row).
// The blobs also carry prompts and tool args: only the numeric fields and the
// served model id are ever extracted, nothing else is retained or logged.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { importSqlite } from "./sqlite-import.ts";

export interface AntigravityConversation {
  id: string; // conversation/cascade id – doubles as the sessions-set entry
  dbPath: string;
  workspaces: string[]; // decoded workspace dirs (forward slashes, drive-letter form c:/…)
  lastModifiedMs: number | null;
}

export interface AntigravityUsageRow {
  tsMs: number;
  model: string; // served model id (gen .1.19); "gemini-unknown" when unmapped
  inTok: number; // uncached input
  cr: number; // cache-read input
  out: number; // output total, thinking included
}

// ---------- protobuf wire format, targeted decode ----------

interface Field {
  n: number; // field number
  wt: number; // wire type
  varint?: bigint;
  bytes?: Uint8Array;
}

function readVarint(b: Uint8Array, i: number): [bigint, number] | null {
  let r = 0n;
  let s = 0n;
  for (;;) {
    if (i >= b.length || s > 70n) return null;
    const x = b[i++];
    r |= BigInt(x & 127) << s;
    s += 7n;
    if ((x & 128) === 0) return [r, i];
  }
}

// One level of a protobuf message; null = malformed (the caller skips the row).
function parseFields(b: Uint8Array): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    const key = readVarint(b, i);
    if (key === null) return null;
    i = key[1];
    const n = Number(key[0] >> 3n);
    const wt = Number(key[0] & 7n);
    if (n === 0) return null;
    if (wt === 0) {
      const v = readVarint(b, i);
      if (v === null) return null;
      i = v[1];
      out.push({ n, wt, varint: v[0] });
    } else if (wt === 1) {
      if (i + 8 > b.length) return null;
      i += 8;
      out.push({ n, wt });
    } else if (wt === 5) {
      if (i + 4 > b.length) return null;
      i += 4;
      out.push({ n, wt });
    } else if (wt === 2) {
      const l = readVarint(b, i);
      if (l === null) return null;
      i = l[1];
      const len = Number(l[0]);
      if (i + len > b.length) return null;
      out.push({ n, wt, bytes: b.subarray(i, i + len) });
      i += len;
    } else {
      return null;
    }
  }
  return out;
}

function firstVarint(fields: Field[], n: number): bigint | undefined {
  for (const f of fields) {
    if (f.n === n && f.wt === 0) return f.varint;
  }
  return undefined;
}

function firstBytes(fields: Field[], n: number): Uint8Array | undefined {
  for (const f of fields) {
    if (f.n === n && f.wt === 2) return f.bytes;
  }
  return undefined;
}

function firstSub(fields: Field[], n: number): Field[] | null {
  const b = firstBytes(fields, n);
  if (b === undefined) return null;
  return parseFields(b);
}

// ---------- per-conversation usage walk ----------

// Generation id join key: varint ids compare numerically, len-delimited ids
// as strings – one gen row satisfies at most one of the two, so both a number
// and a string key are recorded.
function genKeys(fields: Field[]): (string | number)[] {
  const out: (string | number)[] = [];
  const v = firstVarint(fields, 4);
  if (v !== undefined) out.push(Number(v));
  const b = firstBytes(fields, 4);
  if (b !== undefined) out.push(new TextDecoder().decode(b));
  return out;
}

function tsMsOf(meta: Field[]): number | null {
  const ts = firstSub(meta, 1);
  if (ts === null) return null;
  const sec = firstVarint(ts, 1);
  if (sec === undefined) return null;
  const nanos = Number(firstVarint(ts, 2) ?? 0n);
  return Number(sec) * 1000 + Math.floor(nanos / 1e6);
}

// Steps with a usage block inside [fromMs, toMs]. null = db unreadable (WAL
// busy, foreign schema): the caller treats it as "no data", never as zero.
export async function readAntigravityUsage(
  dbPath: string,
  fromMs: number,
  toMs: number,
  nowMs: number,
): Promise<AntigravityUsageRow[] | null> {
  const mod = await importSqlite();
  if (mod === null) return null;
  let rows: unknown[];
  let gens: unknown[];
  try {
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db.prepare("select metadata from steps where metadata is not null").all();
      gens = db.prepare("select data from gen_metadata").all();
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  const decoder = new TextDecoder();
  // gen id -> served model id (gen .1.19); a gen row without it still maps
  // its id to the fallback so the join can't misland on another gen.
  const models = new Map<string | number, string>();
  for (const g of gens) {
    const data = (g as { data?: unknown }).data;
    if (!(data instanceof Uint8Array)) continue;
    const f = parseFields(data);
    if (f === null) continue;
    const id = firstSub(f, 1);
    const served = id === null ? undefined : firstBytes(id, 19);
    const model = served === undefined ? "gemini-unknown" : decoder.decode(served);
    for (const k of genKeys(f)) models.set(k, model);
  }
  const out: AntigravityUsageRow[] = [];
  for (const r of rows) {
    const meta = (r as { metadata?: unknown }).metadata;
    if (!(meta instanceof Uint8Array)) continue;
    const f = parseFields(meta);
    if (f === null) continue; // malformed blob – fail closed, keep neighbours
    const usage = firstSub(f, 9);
    if (usage === null) continue;
    const inTok = firstVarint(usage, 2);
    if (inTok === undefined) continue; // no usage block on this step
    const ts = tsMsOf(f);
    if (ts === null || ts < fromMs || ts > toMs || ts < 946684800000 || ts > nowMs + 86_400_000) continue;
    const outTotal = Number(firstVarint(usage, 3) ?? 0n);
    const visible = firstVarint(usage, 9);
    const thinking = Number(firstVarint(usage, 10) ?? 0n);
    // Drift guard: out total must decompose as visible + thinking when the
    // split is present. A mismatch means the field map broke – skip the row.
    if (visible !== undefined && outTotal !== Number(visible) + thinking) continue;
    let model: string | undefined;
    const genId = firstVarint(f, 12);
    if (genId !== undefined) model = models.get(Number(genId));
    if (model === undefined) {
      const b = firstBytes(f, 12);
      if (b !== undefined) model = models.get(decoder.decode(b));
    }
    out.push({
      tsMs: ts,
      model: model ?? "gemini-unknown",
      inTok: Number(inTok),
      cr: Number(firstVarint(usage, 5) ?? 0n),
      out: outTotal,
    });
  }
  return out;
}

// ---------- conversation summaries ----------

// "2026-10-27 07:13:58.1875595+00:00" (fraction and tz optional) -> epoch ms.
function parseSqliteDatetime(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (m === null) return null;
  const frac = (m[3] ?? "").slice(0, 3).padEnd(3, "0");
  let tz = m[4] ?? "+00:00";
  if (tz === "Z") tz = "+00:00";
  else if (!tz.includes(":")) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}.${frac}${tz}`);
  return Number.isNaN(ms) ? null : ms;
}

function decodeWorkspaceUris(json: string): string[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const u of arr) {
    if (typeof u !== "string" || !u.startsWith("file://")) continue;
    let p = u.slice("file://".length);
    try {
      p = decodeURIComponent(p);
    } catch {
      /* keep the raw form */
    }
    p = p.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:)/, "$1"); // file:///c%3A/… -> c:/…
    if (p !== "") out.push(p);
  }
  return out;
}

// Every conversation Antigravity has recorded locally. An unreadable or
// missing summaries db yields [] – "no data", never an error.
export async function antigravityConversations(homeDir: string): Promise<AntigravityConversation[]> {
  const root = join(homeDir, ".gemini", "antigravity");
  const mod = await importSqlite();
  if (mod === null) return [];
  let rows: unknown[];
  try {
    await stat(root);
    const db = new mod.DatabaseSync(join(root, "conversation_summaries.db"), { readOnly: true });
    try {
      rows = db.prepare("select conversation_id, workspace_uris, last_modified_time from conversation_summaries").all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  const convsDir = join(root, "conversations");
  const out: AntigravityConversation[] = [];
  for (const r of rows) {
    const rec = r as { conversation_id?: unknown; workspace_uris?: unknown; last_modified_time?: unknown };
    if (typeof rec.conversation_id !== "string" || rec.conversation_id === "") continue;
    const dbPath = join(convsDir, `${rec.conversation_id}.db`);
    if ((await stat(dbPath).catch(() => null)) === null) continue; // summary without a db – nothing to read
    const uris = typeof rec.workspace_uris === "string" ? decodeWorkspaceUris(rec.workspace_uris) : [];
    const lm = typeof rec.last_modified_time === "string" ? parseSqliteDatetime(rec.last_modified_time) : null;
    out.push({ id: rec.conversation_id, dbPath, workspaces: uris, lastModifiedMs: lm });
  }
  return out;
}

// Usage rows for every conversation whose workspace IS the project or an
// ancestor of it (a workspace deeper than the marker's dir does not match –
// same semantics as the claude launch-dir walk). Pause filtering stays with
// the caller. Conversations that yielded nothing contribute no session id.
export async function antigravityProjectUsage(
  homeDir: string,
  project: string,
  fromMs: number,
  toMs: number,
  nowMs: number,
): Promise<{ rows: AntigravityUsageRow[]; sessions: string[] }> {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const want = norm(project);
  const isAncestor = (ws: string): boolean => {
    const w = norm(ws);
    return w === want || want.startsWith(`${w}/`);
  };
  const convs = (await antigravityConversations(homeDir)).filter(
    (c) => (c.lastModifiedMs === null || c.lastModifiedMs >= fromMs) && c.workspaces.some(isAncestor),
  );
  const rows: AntigravityUsageRow[] = [];
  const sessions: string[] = [];
  for (const c of convs) {
    const r = await readAntigravityUsage(c.dbPath, fromMs, toMs, nowMs);
    if (r === null) continue; // unreadable conversation – not zero, just absent
    if (r.length === 0) continue;
    rows.push(...r);
    sessions.push(c.id);
  }
  return { rows, sessions };
}
