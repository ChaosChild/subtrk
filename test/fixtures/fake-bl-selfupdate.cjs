// fake-bl-selfupdate.js – fixture driven by test/alibaba-selfupdate.test.ts.
// Emulates the bl behaviours the supervisor must distinguish, with timings
// scaled down from the real thing (banner -> ~1s, npm install -> 30-60s).
//
// argv: <scenario> <workfile> [statefile]
"use strict";
const fs = require("fs");
const [scenario, workfile, statefile] = process.argv.slice(2);

const BANNER = [
  "  \u26a1 Significant update detected: 2.3.3 \u2192 2.4.0",
  "  Auto-updating to keep your CLI up to date...",
].join("\n");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// "npm install": write the workfile chunk by chunk so a mid-install kill
// leaves it truncated (chunks = install progress).
async function install(chunks, delayMs, doneMarker) {
  for (let i = 0; i < chunks; i++) {
    fs.appendFileSync(workfile, "x".repeat(1000));
    await sleep(delayMs);
  }
  if (doneMarker) fs.writeFileSync(doneMarker, "done");
}

(async () => {
  if (scenario === "ok") {
    process.stdout.write('{"data":{"per1MonthPercentage":0.01}}\n');
    process.exit(0);
  }
  if (scenario === "hang") {
    await sleep(30_000); // silent; the supervisor must kill this tree
    process.exit(0);
  }
  if (scenario === "update-ok") {
    process.stderr.write(BANNER + "\n");
    await install(8, 300); // ~2.4s of "installing" – longer than the kill budget
    process.stdout.write('{"data":{"per1MonthPercentage":0.01}}\n');
    process.exit(0);
  }
  if (scenario === "update-silent") {
    // No banner (simulates a renamed/changed banner): only the update-state
    // file flips, which the supervisor must notice before killing.
    await sleep(500);
    fs.writeFileSync(statefile, JSON.stringify({ lastChecked: Date.now(), latestVersion: "2.4.0" }));
    await install(8, 300);
    process.stdout.write('{"data":{"per1MonthPercentage":0.01}}\n');
    process.exit(0);
  }
  if (scenario === "update-cap") {
    process.stderr.write(BANNER + "\n");
    await install(10, 400, workfile + ".done"); // ~4s; the test caps at 2.5s
    process.exit(0);
  }
  if (scenario === "serial") {
    fs.appendFileSync(workfile, "S");
    await sleep(300);
    fs.appendFileSync(workfile, "E");
    process.exit(0);
  }
  process.stderr.write(`unknown scenario: ${scenario}\n`);
  process.exit(2);
})();
