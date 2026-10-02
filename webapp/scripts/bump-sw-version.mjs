#!/usr/bin/env node
/**
 * Wave G item 5 — bump the service-worker cache version on every build.
 *
 * Why: an installed PWA only re-installs its worker when /sw.js comes back
 * byte-different. With a hardcoded `const VERSION = 'oeo-v1'` the script never
 * changed, so deployed bundle updates could sit behind an old cached shell
 * until the user cleared site data.
 *
 * This runs from the `prebuild` npm lifecycle (so `npm run build` — the path
 * used by CI, the Dockerfile and the deploy script — always stamps a fresh
 * version), rewriting exactly one line in public/sw.js:
 *
 *   const VERSION = 'oeo-v1-local';   →   const VERSION = 'oeo-v1-lxk3p9q2';
 *
 * `oeo-v1` stays the prefix so the HTTP smoke check (and any cache-name
 * reasoning) can still recognise the marker; the suffix is what changes per
 * deploy. The activate handler drops every cache whose name does not start
 * with the new VERSION, so old shell/runtime caches are cleaned up.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// SW_JS_PATH lets the test run this against a copy instead of the real file.
const target =
  process.env.SW_JS_PATH ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js');
const source = readFileSync(target, 'utf8');
const PATTERN = /^const VERSION = ['"][^'"]*['"];$/m;

if (!PATTERN.test(source)) {
  console.error(`bump-sw-version: no VERSION declaration found in ${target}`);
  process.exit(1);
}

const build = Date.now().toString(36);
const stamped = source.replace(PATTERN, `const VERSION = 'oeo-v1-${build}';`);

if (stamped === source) {
  // Same millisecond as the file's current stamp — nothing to do.
  console.log('bump-sw-version: version unchanged');
} else {
  writeFileSync(target, stamped);
  console.log(`bump-sw-version: public/sw.js -> oeo-v1-${build}`);
}
