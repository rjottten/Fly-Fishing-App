/* Reseals the Content-Security-Policy against index.html.
 *
 *   npm run seal        — rewrite netlify.toml's script-src hash
 *   npm run seal -- -c  — check only, exit 1 if it has drifted
 *
 * index.html carries its script inline, so the deploy has two ways to
 * allow it: 'unsafe-inline', which allows every other inline script too —
 * including one injected through the OpenStreetMap data the app reads —
 * or the hash of this exact script and nothing else. It is the second.
 *
 * The cost is that the hash must follow the file. `npm test` checks it,
 * so a forgotten reseal fails CI rather than serving a blank page.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = resolve(ROOT, "index.html");
const TOML  = resolve(ROOT, "netlify.toml");

/* The browser hashes the element's text content, so this must capture
   exactly what sits between the tags — no trimming, no normalising. */
export function scriptHash(html = readFileSync(INDEX, "utf8")) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one inline <script>, found ${blocks.length}. `
      + `Every inline script needs its own hash in the policy.`);
  }
  return "sha256-" + createHash("sha256").update(blocks[0][1], "utf8").digest("base64");
}

export function policyHash(toml = readFileSync(TOML, "utf8")) {
  const m = toml.match(/script-src [^;"]*'(sha256-[A-Za-z0-9+/=]+)'/);
  return m ? m[1] : null;
}

/* Importing this file (run.mjs does, to check the seal) must not reseal
   anything — only running it directly does. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const want = scriptHash(), have = policyHash();

  if (process.argv.includes("-c") || process.argv.includes("--check")) {
    if (want === have) { console.log(`  \u2713 CSP script hash matches index.html (${want.slice(0, 20)}\u2026)`); process.exit(0); }
    console.error(`  \u2717 CSP script hash has drifted.\n      policy: ${have}\n      actual: ${want}\n`
      + `    Run 'npm run seal' in test/ and commit netlify.toml.`);
    process.exit(1);
  }

  if (want === have) { console.log(`Already sealed: ${want}`); process.exit(0); }
  const toml = readFileSync(TOML, "utf8");
  const next = have
    ? toml.replace(have, want)
    : toml.replace(/(script-src 'self' )'unsafe-inline'/, `$1'${want}'`);
  if (next === toml) throw new Error("could not find the script-src directive to reseal in netlify.toml");
  writeFileSync(TOML, next);
  console.log(`Resealed netlify.toml\n  was: ${have || "'unsafe-inline'"}\n  now: ${want}`);
}
