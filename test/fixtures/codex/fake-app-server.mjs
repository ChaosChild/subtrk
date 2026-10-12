// Canned codex app-server: newline-delimited JSON-RPC over stdio. Records its
// argv to FAKE_CODEX_ARGV_OUT; FAKE_CODEX_MODE = ok | signed-out | rpc-error | hang.
import { writeFileSync } from "node:fs";

if (process.env.FAKE_CODEX_ARGV_OUT) writeFileSync(process.env.FAKE_CODEX_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
process.stdout.write("codex app-server starting (banner)\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (mode === "hang" && req.method !== "initialize") continue;
    let result = {};
    if (req.method === "account/read") {
      result = mode === "signed-out" ? { account: null } : { account: { type: "chatgpt", planType: "plus" } };
    }
    if (req.method === "account/rateLimits/read") {
      if (mode === "rpc-error") {
        process.stdout.write(`${JSON.stringify({ id: req.id, error: { code: -1, message: "nope" } })}\n`);
        continue;
      }
      result = {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1783374300 },
          secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: "2026-07-10T00:00:00Z" },
        },
        rateLimitsByLimitId: {
          codex: { limitName: null, primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1783374300 } },
          codex_spark: { limitName: "GPT-Spark", primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1783374300 } },
        },
      };
    }
    process.stdout.write(`${JSON.stringify({ method: "notice", params: {} })}\n`);
    process.stdout.write(`${JSON.stringify({ id: req.id, result })}\n`);
  }
});
