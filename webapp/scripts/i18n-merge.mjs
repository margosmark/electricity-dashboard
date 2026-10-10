/**
 * Wave U — merge `src/i18n/areas/*.json` into `en.json` + `fr.json`.
 *
 * Each translation sweep owns ONE area file ({"en": {...}, "fr": {...}}), so
 * parallel work never collides on the two runtime catalogs. This script is
 * the only writer of en.json/fr.json:
 *
 *   node scripts/i18n-merge.mjs          # merge + sort + write
 *   node scripts/i18n-merge.mjs --check  # verify catalogs are up to date
 *
 * Fails loudly on: an area whose en/fr key sets differ, duplicate keys
 * across areas (two sweeps claiming the same string), or --check finding
 * stale catalogs. Keys must be namespaced `area.something` by file name.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const areasDir = join(root, 'src', 'i18n', 'areas');
const enOut = join(root, 'src', 'i18n', 'en.json');
const frOut = join(root, 'src', 'i18n', 'fr.json');

const check = process.argv.includes('--check');

const en = {};
const fr = {};
const owners = new Map(); // key -> area file, for duplicate detection
const errors = [];

for (const file of readdirSync(areasDir).sort()) {
  if (!file.endsWith('.json')) continue;
  const area = JSON.parse(readFileSync(join(areasDir, file), 'utf8'));
  for (const locale of ['en', 'fr']) {
    if (!area[locale] || typeof area[locale] !== 'object') {
      errors.push(`${file}: missing "${locale}" object`);
      continue;
    }
    for (const [key, value] of Object.entries(area[locale])) {
      const prev = owners.get(key);
      if (prev && prev !== file) errors.push(`duplicate key "${key}" in ${file} and ${prev}`);
      owners.set(key, file);
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`${file}: "${key}" is not a non-empty string`);
      }
      (locale === 'en' ? en : fr)[key] = value;
    }
  }
  const enKeys = Object.keys(area.en ?? {}).sort().join(',');
  const frKeys = Object.keys(area.fr ?? {}).sort().join(',');
  if (enKeys !== frKeys) errors.push(`${file}: en/fr key sets differ`);
  // Placeholder parity: a translation may not drop or invent {tokens}.
  const tokens = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const key of Object.keys(area.en ?? {})) {
    if (area.fr && key in area.fr && tokens(area.en[key]) !== tokens(area.fr[key])) {
      errors.push(`${file}: placeholders of "${key}" differ between en and fr`);
    }
  }
}

if (errors.length > 0) {
  console.error('i18n merge FAILED:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

const sorted = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const dump = (obj) => JSON.stringify(sorted(obj), null, 2) + '\n';
const nextEn = dump(en);
const nextFr = dump(fr);

if (check) {
  const curEn = readFileSync(enOut, 'utf8');
  const curFr = readFileSync(frOut, 'utf8');
  if (curEn !== nextEn || curFr !== nextFr) {
    console.error('i18n catalogs are stale — run: node scripts/i18n-merge.mjs');
    process.exit(1);
  }
  console.log(`i18n catalogs up to date (${Object.keys(en).length} keys).`);
} else {
  writeFileSync(enOut, nextEn);
  writeFileSync(frOut, nextFr);
  console.log(`merged ${Object.keys(en).length} keys into en.json + fr.json`);
}
