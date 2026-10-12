// Build step: serve.ts reads the console shell from its own directory at
// runtime (new URL("./console.html", import.meta.url)), so dist/ must carry a
// copy — tsc only compiles .ts and the packaged tarball ships dist/ only.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });
copyFileSync(`${root}src/console.html`, `${root}dist/console.html`);
