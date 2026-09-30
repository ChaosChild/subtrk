import io

# ---------- 1. usage.ts: turn_context unconditional + parser version 3 ----------
p = "src/usage.ts"
t = io.open(p, encoding="utf8").read()

old = '''  if (rec.type === "turn_context" && rec.payload && typeof rec.payload.model === "string" && rec.payload.model) {
    return prev
      ? { ts: 0, model: "", row: {}, modelUpdate: rec.payload.model, nextState: prev }
      : null;
  }'''
new = '''  if (rec.type === "turn_context" && rec.payload && typeof rec.payload.model === "string" && rec.payload.model) {
    return { ts: 0, model: "", row: {}, modelUpdate: rec.payload.model, nextState: prev };
  }'''
assert old in t, "turn_context"
t = t.replace(old, new)

old = "const LOCAL_PARSER_VERSION = 2;"
new = "const LOCAL_PARSER_VERSION = 3;"
assert old in t, "pv"
t = t.replace(old, new)
io.open(p, "w", encoding="utf8").write(t)
print("usage.ts ok")

# ---------- 2. console.html ----------
p = "src/console.html"
t = io.open(p, encoding="utf8").read()

# 2a. STATUS null guard in renderProviderView
old = '''function renderProviderView() {
  const p = (STATUS.providers || []).find(x => x.id === PROVIDER_VIEW);'''
new = '''function renderProviderView() {
  // refetchUsage can beat the first /api/status round - STATUS is null then.
  const p = ((STATUS && STATUS.providers) || []).find(x => x.id === PROVIDER_VIEW);'''
assert old in t, "status guard"
t = t.replace(old, new)

# 2b. window family helper + strips grouped by family
old = '''function pctStripsHTML(u, keys, stepMs, labelStep) {
  // Group samples by WINDOW (reset instant, 30-min jitter bucket), not by the
  // raw kind string - kimi's hourly countdown kinds ("336h".."1h") are all
  // ONE two-week window, and google's rolling 5h slides the same way. The
  // strip is labeled with the newest kind observed in that window.
  const byR = new Map();
  for (const s of u.samples || []) {
    const rKey = Math.round(new Date(s.r).getTime() / 1800000);
    if (!byR.has(rKey)) byR.set(rKey, []);
    byR.get(rKey).push(s);
  }
  const kinds = [...byR.keys()].sort((a, b) => a - b);
  const kindLabel = new Map();
  for (const rKey of kinds) {
    const list = byR.get(rKey).slice().sort((a, b) => a.t - b.t);
    kindLabel.set(rKey, list[list.length - 1].k);
  }'''
new = '''// A window FAMILY is the window TYPE per scope: "5h", "7d", "5h.gemini-models"
// etc. Countdown kinds (kimi's "336h".."289h" remaining-hours labels, any
// pure Nh with N>=48) all map to one "cycle" family; every generation of the
// same 5h window belongs to the SAME strip - resets read as the level
// dropping, not as a new strip.
function windowFamily(k) {
  const dot = k.indexOf("\\u00b7");
  const base = dot >= 0 ? k.slice(0, dot) : k;
  const scope = dot >= 0 ? k.slice(dot + 1) : "";
  const m = /^(\\d+)h$/.exec(base);
  const fam = m && Number(m[1]) >= 48 ? "cycle" : base;
  return fam + (scope ? "\\u00b7" + scope : "");
}

function pctStripsHTML(u, keys, stepMs, labelStep) {
  // ONE strip per window family (5h / 7d / per-scope / kimi's cycle) - not per
  // generation and not per raw kind. Labeled with the newest raw kind seen.
  const byF = new Map();
  for (const s of u.samples || []) {
    const f = windowFamily(s.k);
    if (!byF.has(f)) byF.set(f, []);
    byF.get(f).push(s);
  }
  const kinds = [...byF.keys()].sort();
  const kindLabel = new Map();
  for (const f of kinds) {
    const list = byF.get(f).slice().sort((a, b) => a.t - b.t);
    kindLabel.set(f, list[list.length - 1].k);
  }'''
assert old in t, "strips grouping"
t = t.replace(old, new)

old = '''  let html = "";
  for (const rKey of kinds) {
    const list = byR.get(rKey);
    const kind = kindLabel.get(rKey) || "?";'''
new = '''  let html = "";
  for (const f of kinds) {
    const list = byF.get(f);
    const kind = kindLabel.get(f) || "?";'''
assert old in t, "strip loop"
t = t.replace(old, new)

# 2c. latestWindows grouped by family
old = '''function latestWindows(u) {
  // "Now" view: one row per window kind-scope (freshest live sample), then
  // collapse rows that share a reset instant (kimi's countdown kinds
  // "336h".."1h" are ONE window) and google's rolling 5h resetsAt.
  const nowMs = now();
  const byK = new Map();
  for (const s of (u && u.samples) || []) {
    if (new Date(s.r).getTime() <= nowMs) continue; // dead generation
    const cur = byK.get(s.k);
    if (!cur) byK.set(s.k, { ...s, n: 1 });
    else { cur.n++; if (s.t > cur.t) Object.assign(cur, { t: s.t, u: s.u, r: s.r, sf: s.sf, stale: s.stale }); }
  }
  const byR = new Map();
  for (const s of byK.values()) {
    const rKey = Math.round(new Date(s.r).getTime() / 1800000); // 30-min jitter collapse
    const cur = byR.get(rKey);
    if (!cur || s.t > cur.t) byR.set(rKey, s);
    else cur.n += s.n;
  }
  return [...byR.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
}'''
new = '''function latestWindows(u) {
  // "Now" view: ONE row per window family (5h / 7d / per-scope / kimi cycle),
  // freshest live sample, n = live samples behind it. Generations of the same
  // window collapse; countdown kinds collapse; rolling resetsAt irrelevant.
  const nowMs = now();
  const byF = new Map();
  for (const s of (u && u.samples) || []) {
    if (new Date(s.r).getTime() <= nowMs) continue; // dead generation
    const f = windowFamily(s.k);
    const cur = byF.get(f);
    if (!cur) byF.set(f, { ...s, n: 1 });
    else { cur.n++; if (s.t > cur.t) Object.assign(cur, { t: s.t, u: s.u, r: s.r, sf: s.sf, stale: s.stale }); }
  }
  return [...byF.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
}'''
assert old in t, "latestWindows"
t = t.replace(old, new)
io.open(p, "w", encoding="utf8").write(t)
print("console.html ok")

# ---------- 3. serve.ts: startedAt for stale-serve detection ----------
p = "src/serve.ts"
t = io.open(p, encoding="utf8").read()
old = '''              JSON.stringify({
                enabled: cfg.enabled,
                order: cfg.order ?? [],
                hidden: cfg.hidden ?? [],
                theme: cfg.theme ?? null,
                version,
              }),'''
new = '''              JSON.stringify({
                enabled: cfg.enabled,
                order: cfg.order ?? [],
                hidden: cfg.hidden ?? [],
                theme: cfg.theme ?? null,
                version,
                startedAt,
              }),'''
assert old in t, "config startedAt"
t = t.replace(old, new)

old = '''export async function startConsole(deps: ServeDeps = {}): Promise<ServeHandle> {
  const token = randomBytes(32).toString("hex"); // per run, memory only
  const version = deps.version ?? pkgVersion();'''
new = '''export async function startConsole(deps: ServeDeps = {}): Promise<ServeHandle> {
  const token = randomBytes(32).toString("hex"); // per run, memory only
  const version = deps.version ?? pkgVersion();
  const startedAt = new Date().toISOString(); // lets the footer prove WHICH process serves the page'''
assert old in t, "startedAt decl"
t = t.replace(old, new)
io.open(p, "w", encoding="utf8").write(t)
print("serve.ts ok")

# ---------- 4. console footer: show started time ----------
p = "src/console.html"
t = io.open(p, encoding="utf8").read()
old = '''        if (typeof cfg.version === "string" && cfg.version) $("servever").textContent = `subtrk serve v${cfg.version}`;'''
new = '''        if (typeof cfg.version === "string" && cfg.version) {
          const started = typeof cfg.startedAt === "string" ? ` \\u00b7 started ${new Date(cfg.startedAt).toLocaleTimeString()}` : "";
          $("servever").textContent = `subtrk serve v${cfg.version}${started}`;
        }'''
assert old in t, "footer"
t = t.replace(old, new)
io.open(p, "w", encoding="utf8").write(t)
print("footer ok")
