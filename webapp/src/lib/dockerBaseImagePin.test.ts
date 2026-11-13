// @vitest-environment node
/**
 * The base image of BOTH stages is pinned to an exact Node patch release.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. On 2026-10-23 the CVE-2026-111497
 * (Node2Shell) audit found the three dashboard containers running Node 26.12.0
 * — the vulnerable line — while the Dockerfile said `FROM node:26-alpine`. The
 * floating tag happened to resolve to the patched 26.12.1 that same day, so the
 * rebuild was safe BY LUCK: a rebuild on any day between the tag's 26.12.0 bump
 * and the 26.12.1 release would have shipped a remotely-exploitable runtime with
 * no diff to show for it. A comment cannot stop that; a pin can.
 *
 * What this file holds:
 *  - both stages pin the SAME exact patch release (a patched builder with a
 *    floating runner is still a vulnerable runtime),
 *  - neither stage floats a major/minor tag again,
 *  - each pin carries the CVE reference and the date it was pinned, so the next
 *    bump is a deliberate act with a reason in the diff rather than an accident.
 *
 * The upgrade itself is a deliberate edit: bump the version, change the date,
 * and change the CVE reference in the same commit. Bumping only the tag fails
 * the "names a reason" pin below, which is the point — the diff has to say why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBAPP = join(HERE, '..', '..'); // src/lib → webapp
const dockerfile = readFileSync(join(WEBAPP, 'Dockerfile'), 'utf8');

/** The exact patch release both stages must carry. */
const PINNED = 'node:26.13.1-alpine';

/** Every `FROM` line in the file, in order. */
const fromLines = dockerfile
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('FROM '));

/** The image tag of a `FROM` line: `FROM node:26.13.1-alpine AS builder` → `node:26.13.1-alpine`. */
const tagOf = (from: string): string => from.split(' ')[1];

/** The tag without its image name: `node:26.13.1-alpine` → `26.13.1-alpine`. */
const versionOf = (from: string): string => tagOf(from).split(':').pop() ?? '';

describe('the Node base image is pinned to an exact patch release', () => {
  it('has exactly the two stages it always had', () => {
    expect(fromLines).toHaveLength(2);
    expect(fromLines[0]).toContain('AS builder');
    expect(fromLines[1]).toContain('AS runner');
  });

  it('pins BOTH stages to the same exact tag', () => {
    for (const line of fromLines) {
      expect(line, `${line} must pin ${PINNED}`).toBe(`FROM ${PINNED} AS ${line.split('AS ')[1].trim()}`);
    }
  });

  it('never floats a major/minor tag again', () => {
    // `node:26-alpine` (and any bare `node:<major>`) is what let a vulnerable
    // build ship unnoticed. The tag must carry an exact MAJOR.MINOR.PATCH.
    for (const line of fromLines) {
      const version = versionOf(line);
      expect(version, `${line} must name an exact MAJOR.MINOR.PATCH release`).toMatch(
        /^\d+\.\d+\.\d+(-alpine\d*(\.\d+)?)?$/,
      );
      expect(version).not.toBe('latest');
      expect(version).not.toBe('26');
      expect(version).not.toBe('26-alpine');
    }
  });

  it('names the CVE and the pin date above each stage', () => {
    const lines = dockerfile.split('\n');
    for (const from of fromLines) {
      const index = lines.findIndex((line) => line.trim() === from);
      expect(index, `${from} must exist in the file`).toBeGreaterThan(-1);

      // The comment block directly above the FROM (contiguous `#` lines).
      const comment: string[] = [];
      for (let i = index - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.startsWith('#')) break;
        comment.unshift(line);
      }
      const text = comment.join('\n');
      expect(text, `${from} must be justified by a CVE reference`).toMatch(/CVE-\d{4}-\d+/);
      expect(text, `${from} must be justified by the date it was pinned`).toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
    }
  });

  it('keeps the builder and the runner on the SAME patch release', () => {
    const tags = fromLines.map((line) => line.split(' ')[1]);
    expect(new Set(tags).size, 'the two stages must not drift apart').toBe(1);
  });
});
