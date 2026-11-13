import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { BUILD_SHA } from '@/lib/buildInfo';

/**
 * `GET /api/version` — what this container says it is.
 *
 * WHY IT EXISTS: deploy verification (t_5b968b78, t_94b28843) had to prove the
 * running app equalled a merge SHA by hashing every emitted JS chunk against a
 * fresh local build of the candidate commit. That is a multi-minute substitute
 * for reading one value the build already knows. After this route,
 * `curl -s http://<host>:3939/api/version` answers it directly.
 *
 * WHAT IT IS: a pure read of two build constants — the commit the image was
 * built from (`BUILD_SHA`; set from the `GIT_SHA` build arg, see
 * src/lib/buildInfo.ts and the Dockerfile's two stages) and Next's own build id
 * for that build (`readBuildId()`, below). No secrets, no state, no user data,
 * nothing derived from the request. The zero-backend invariant is intact: this
 * endpoint reads a constant, it does not DO anything.
 *
 * The SECOND field is not decoration. `BUILD_SHA` cannot distinguish two builds
 * of the SAME commit — a rebuild with no source change, or a deploy that left
 * the old container running — and `BUILD_ID` cannot be compared against a
 * commit. Together they answer both "which commit?" and "is this the process
 * that commit was built into?".
 *
 * WHAT IT MUST NOT DO: reveal anything else, or be cacheable. A stamped
 * identity served from a cache names the build that was cached, which is the
 * exact lie the route exists to prevent — hence `force-dynamic` plus an
 * explicit `no-store`, rather than Next's static-handler caching default. The
 * service worker's fetch handler only intercepts navigations, `/api/rates` and
 * the immutable static prefixes (`public/sw.js`), so this path falls to the
 * browser default and is never precached or stored — pinned by
 * `src/lib/security.test.tsx`.
 */
export const dynamic = 'force-dynamic';

/**
 * Next's build id for this build, from the `_next/BUILD_ID` the build itself
 * wrote. Read at request time rather than inlined because Next generates the
 * id DURING the build, after this module is compiled.
 *
 * The path is relative to the process's working directory — the standalone
 * root in the container (`/app`, where `server.js` runs), `webapp/` under
 * `next start`. Both hold `.next/BUILD_ID` (verified in the deployed
 * container). Any failure degrades to `'unknown'`: a missing file must never
 * 500 a diagnostics route.
 */
export function readBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function GET() {
  return NextResponse.json(
    { sha: BUILD_SHA, buildId: readBuildId() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
