// @vitest-environment node
/**
 * The edge router's base image is pinned to an exact nginx patch release.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT — the same failure mode as the Node
 * pin in `dockerBaseImagePin.test.ts`: `nginx:1.29-alpine` was a floating
 * *patch* tag, so a rebuild inside a window where upstream moves it ships a
 * changed router runtime with zero diff to show for it. The first pin
 * (2026-11-13, `nginx:1.29.8-alpine`) resolved to the exact image production
 * already ran — a no-op whose only job was to make the NEXT upstream move a
 * visible diff. The same day it was bumped to `nginx:1.30.6-alpine` because
 * the 1.29 line is EOL: nginx.org's advisory list (fetched 2026-11-13) put
 * 1.29.8 inside the Vulnerable range of 18 of 68 advisories — every fix for
 * those shipped only on 1.30.x/1.31.x — and 1.30.6 clears 17 of the 18 (the
 * residual CVE-2009-4487, severity none, is unfixed in every version).
 * Unlike the first pin, that bump is a real runtime change: it was validated
 * with `nginx -t` on the rendered template, the path split exercised in a
 * throwaway topology compose, and `nginx -V` module parity before merge.
 *
 * What this file holds:
 *  - the FROM pins an exact MAJOR.MINOR.PATCH (never `1.30`, `1.30-alpine`
 *    or `latest` again),
 *  - the FROM matches a PINNED constant, so a Dockerfile-only bump fails
 *    here and the constant must move in the same commit,
 *  - the comment block directly above the FROM carries the pin date and the
 *    reason (the floating-tag lesson and the advisories behind the current
 *    pin), so the next bump has to say why in the diff.
 *
 * The upgrade itself is a deliberate edit: bump PINNED and the FROM tag
 * together, and restate the reason and the date in the same commit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // src/lib → webapp → repo root
const dockerfile = readFileSync(join(REPO, 'ops', 'edge', 'Dockerfile'), 'utf8');

/** The exact tag the edge image must carry. */
const PINNED = 'nginx:1.30.6-alpine';

/** Every `FROM` line in the file, in order. */
const fromLines = dockerfile
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('FROM '));

/** The image tag of a `FROM` line: `FROM nginx:1.30.6-alpine` → `nginx:1.30.6-alpine`. */
const tagOf = (from: string): string => from.split(' ')[1];

/** The tag without its image name: `nginx:1.30.6-alpine` → `1.30.6-alpine`. */
const versionOf = (from: string): string => tagOf(from).split(':').pop() ?? '';

describe('the edge nginx base image is pinned to an exact patch release', () => {
  it('has exactly the one stage it always had', () => {
    expect(fromLines).toHaveLength(1);
  });

  it('pins the FROM to the same exact tag as PINNED', () => {
    expect(fromLines[0], `edge FROM must pin ${PINNED}`).toBe(`FROM ${PINNED}`);
  });

  it('never floats a major/minor tag again', () => {
    // `nginx:1.30-alpine` (and any bare `nginx:<major>.<minor>`) is what let
    // an upstream move ship unnoticed. The tag must carry an exact
    // MAJOR.MINOR.PATCH release.
    for (const line of fromLines) {
      const version = versionOf(line);
      expect(version, `${line} must name an exact MAJOR.MINOR.PATCH release`).toMatch(
        /^\d+\.\d+\.\d+(-alpine\d*(\.\d+)?)?$/,
      );
      expect(version).not.toBe('latest');
      expect(version).not.toBe('1.30');
      expect(version).not.toBe('1.30-alpine');
    }
  });

  it('names the pin date and the reason above the FROM', () => {
    const lines = dockerfile.split('\n');
    const index = lines.findIndex((line) => line.trim() === fromLines[0]);
    expect(index, `${fromLines[0]} must exist in the file`).toBeGreaterThan(-1);

    // The comment block directly above the FROM (contiguous `#` lines).
    const comment: string[] = [];
    for (let i = index - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line.startsWith('#')) break;
      comment.unshift(line);
    }
    const text = comment.join('\n');
    expect(text, `${fromLines[0]} must be justified by the date it was pinned`).toMatch(
      /\b20\d{2}-\d{2}-\d{2}\b/,
    );
    // The reason: the floating-tag failure mode this pin exists for, or a CVE
    // reference for the advisories behind the current pin (both apply as of
    // the 2026-11-13 bump off the EOL 1.29 line).
    expect(text, `${fromLines[0]} must be justified by a reason in the diff`).toMatch(
      /floating|CVE-\d{4}-\d+/,
    );
  });
});
