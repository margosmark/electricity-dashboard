/**
 * Wave G item 5 — service-worker cache versioning.
 *
 * An installed PWA only re-installs its worker when /sw.js comes back
 * byte-different, and the activate handler only drops caches whose name does
 * not start with the current VERSION. So VERSION must (a) exist, (b) change
 * on every build, (c) be the single source of both cache names.
 *
 * The bump script is executed here against a copy of the real file — a test
 * that only greps for a constant would still pass if the script were broken.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const WEBAPP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_PATH = path.join(WEBAPP_ROOT, 'public', 'sw.js');
const SCRIPT = path.join(WEBAPP_ROOT, 'scripts', 'bump-sw-version.mjs');

const versionOf = (source: string): string => {
  const m = source.match(/^const VERSION = ['"]([^'"]+)['"];$/m);
  expect(m, 'sw.js must declare const VERSION').not.toBeNull();
  return m![1];
};

describe('sw.js version declaration', () => {
  it('carries a per-build suffix, not a hardcoded constant', () => {
    expect(versionOf(fs.readFileSync(SW_PATH, 'utf8'))).toMatch(/^oeo-v\d+-[a-z0-9]+$/);
  });

  it('names both caches from VERSION so activate can drop the old ones', () => {
    const src = fs.readFileSync(SW_PATH, 'utf8');
    expect(src).toMatch(/const SHELL_CACHE = `\$\{VERSION\}-shell`;/);
    expect(src).toMatch(/const RUNTIME_CACHE = `\$\{VERSION\}-runtime`;/);
    expect(src).toMatch(/!key\.startsWith\(VERSION\)/);
  });

  it('is wired into the npm build (prebuild lifecycle)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(WEBAPP_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prebuild).toBe('node scripts/bump-sw-version.mjs');
  });

  it('keeps the sw.js HTTP smoke check satisfiable', () => {
    const smoke = fs.readFileSync(path.join(WEBAPP_ROOT, 'tests', 'e2e', 'http_smoke.sh'), 'utf8');
    expect(smoke).toMatch(/oeo-v1-\[a-z0-9\]\+/);
  });
});

describe('bump-sw-version.mjs', () => {
  it('rewrites VERSION to a NEW value on every run', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'sw.js');
    const original = `/** doc */\nconst VERSION = 'oeo-v1-local';\nconst SHELL_CACHE = \`\${VERSION}-shell\`;\n`;
    fs.writeFileSync(tmp, original);

    const env = { ...process.env, SW_JS_PATH: tmp };
    execFileSync(process.execPath, [SCRIPT], { env });

    const first = versionOf(fs.readFileSync(tmp, 'utf8'));
    expect(first).toMatch(/^oeo-v\d+-[a-z0-9]+$/);
    expect(first).not.toBe('oeo-v1-local');

    // Same file, run again: another new stamp (builds are not idempotent
    // versions — every deploy must produce a byte-different script).
    execFileSync(process.execPath, [SCRIPT], { env });
    const second = versionOf(fs.readFileSync(tmp, 'utf8'));
    expect(second).not.toBe(first);

    // Everything else in the file is untouched.
    expect(fs.readFileSync(tmp, 'utf8')).toContain('const SHELL_CACHE = `${VERSION}-shell`;');
    expect(fs.readFileSync(tmp, 'utf8')).toContain('/** doc */');
  });

  it('fails loudly when the VERSION declaration is missing', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')), 'sw.js');
    fs.writeFileSync(tmp, 'const NOT_VERSION = 1;\n');
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, SW_JS_PATH: tmp } }),
    ).toThrow();
  });
});
