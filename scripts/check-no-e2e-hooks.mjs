#!/usr/bin/env node
// Guards the claim in README's "Known caveats" / `shared/identity/e2e.ts`:
// `__importIdentity`/`__exportIdentity` (private-key-handling DEV console
// tooling) must never ship in a production bundle. Run against a `dist/`
// produced by a plain `pnpm build` (no VITE_E2E=1 — that flag intentionally
// keeps them in for the e2e-mode build Playwright spins up separately).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST_ASSETS = join(process.cwd(), "dist", "assets");
const FORBIDDEN = ["__importIdentity", "__exportIdentity"];

function listJsFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith(".js"));
}

let files;
try {
  files = listJsFiles(DIST_ASSETS);
} catch (error) {
  console.error(`Could not read ${DIST_ASSETS} — run "pnpm build" first.`, error);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No .js files found under ${DIST_ASSETS} — run "pnpm build" first.`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const needle of FORBIDDEN) {
    if (content.includes(needle)) {
      hits.push({ file, needle });
    }
  }
}

if (hits.length > 0) {
  console.error("Found e2e-only identity hooks in a production build:");
  for (const { file, needle } of hits) {
    console.error(`  ${needle} in ${file}`);
  }
  console.error(
    "These handle private key material and must be dead-code-eliminated when VITE_E2E is unset.",
  );
  process.exit(1);
}

console.log(`OK: ${FORBIDDEN.join(", ")} not found in ${files.length} production bundle file(s).`);
