/**
 * ESPI resource fetch for the Green Button CMD shim.
 *
 * The chain is BatchList → UsagePoint → MeterReading → IntervalBlock, but the
 * custodian hands us the batch URI in the token response (`resourceURI`), and
 * every other resource is a relative suffix beneath it — so the shim never
 * needs to walk the tree itself. It fetches one URI and pipes the body
 * through byte for byte; the browser's existing `parseGreenButtonUsagePoints`
 * does the tree walk in `webapp/src/lib/energy.ts`.
 *
 * SECURITY: the base URI comes from the token store, never from the request.
 * The caller may only name a *relative* ESPI suffix (OGB learned this the
 * hard way — accepting an absolute URL here would turn the endpoint into an
 * authenticated SSRF gadget, because we attach the user's access token to
 * whatever we fetch).
 */

const RESOURCE_PATH_REGEX =
  /^[A-Za-z][A-Za-z0-9]{0,31}(?:\/[A-Za-z0-9][A-Za-z0-9-]{0,63}){0,3}$/;

/** `UsagePoint`, `UsagePoint/<uuid>/MeterReading` … — nothing else. */
export function isSafeResourcePath(path: string | null | undefined): boolean {
  return path === null || path === undefined || path === "" || RESOURCE_PATH_REGEX.test(path);
}

export type ResourceRequest = {
  accessToken: string;
  subscriptionUri: string;
  /** Optional relative ESPI suffix (null = the subscription itself). */
  resourcePath?: string | null;
  /** ESPI `published-min` (epoch seconds). */
  publishedMin?: number;
  /** ESPI `published-max` (epoch seconds); clamped to "now" before sending. */
  publishedMax?: number;
  /** Called once the body has fully flowed through (byte count in hand). */
  onComplete?: (bytes: number) => void;
};

export type ResourceResult =
  | {
      kind: "stream";
      status: number;
      contentType: string;
      /** Live upstream body — never buffered, never written anywhere. */
      body: ReadableStream<Uint8Array>;
      /** Increments as bytes flow; resolves when the stream ends. */
      bytes: { value: number };
      url: string;
    }
  | { kind: "accepted"; url: string }
  | {
      kind: "error";
      status: number;
      url: string;
      /** Stable breadcrumb (phase + status number) — never an exception's
       * message and never a response body; those go to the log. Pinned by
       * greenbutton/recovery.test.ts, because this field can reach a reader. */
      detail: string;
      /**
       * The 401/403 arrived AFTER fetch followed a redirect to another
       * origin, which strips the Authorization header by design — so the
       * rejection proves nothing about the grant and must not revoke it.
       */
      redirectedCrossOrigin?: boolean;
    };

/**
 * True when fetch followed this response through a redirect to a different
 * origin (scheme/host/port). Cross-origin follows never carry credentials
 * (fetch spec), so a 401 on the far side is an artefact of the hop, not a
 * verdict on the token.
 */
export function isCrossOriginRedirect(requestUrl: string, res: Response): boolean {
  if (!res.redirected || !res.url) return false;
  try {
    return new URL(res.url).origin !== new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Build the resource URL.
 *
 * Whole-second precision on purpose: some platforms reject a published-max
 * carrying milliseconds with a bare 400.
 */
export function buildResourceUrl(req: ResourceRequest, now = Date.now()): string {
  const base = req.resourcePath
    ? `${req.subscriptionUri.replace(/\/+$/, "")}/${req.resourcePath}`
    : req.subscriptionUri;
  const url = new URL(base);
  if (req.publishedMin !== undefined) url.searchParams.set("published-min", iso(req.publishedMin));
  if (req.publishedMax !== undefined) {
    // No custodian publishes future-dated readings; asking for some is a 400.
    const clamped = Math.min(req.publishedMax, Math.floor(now / 1000));
    url.searchParams.set("published-max", iso(clamped));
  }
  return url.toString();
}

function iso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * GET the resource. Returns a stream for 200, or a classified status for
 * anything else — the caller decides what a 401 means (expired token vs.
 * revoked grant), because only the retry outcome can tell those apart.
 */
export async function fetchResource(
  req: ResourceRequest,
): Promise<ResourceResult> {
  const url = buildResourceUrl(req);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        Accept: "application/atom+xml, application/xml",
      },
      cache: "no-store",
      redirect: "follow",
    });
  } catch (e) {
    // The exception's own words (ECONNREFUSED, a host:port, an fs path)
    // stay in the LOG as an object. `detail` is a stable breadcrumb that
    // can ride a JSON error body to a reader, so it never quotes the
    // exception — the reader's sentence comes from the catalog instead
    // (greenbutton/recovery.test.ts's contract).
    console.warn("[greenbutton] resource fetch failed", e);
    return {
      kind: "error",
      status: 0,
      url,
      detail: "resource server unreachable",
    };
  }

  if (res.status === 202) {
    // The 202 body is the CUSTODIAN's prose — text this app does not
    // control and must not forward. It is read only to drain the socket
    // and reported as a byte count; `data_pending` reaches the reader as
    // catalog copy (sync.ts attaches no detail to it).
    const pending = await res.text();
    console.warn(`[greenbutton] resource 202 Accepted (${pending.length} bytes) — batch pending`);
    return { kind: "accepted", url };
  }
  if (!res.ok) {
    // Same rule as the 202: their body can echo anything, so the log
    // gets the status and the size only, and `detail` gets the status
    // number — never their prose. (`sync.ts` composes its own
    // `resource server ${status}` line from the status anyway.)
    const size = (await res.text()).length;
    console.warn(`[greenbutton] resource ${res.status} (${size} bytes)`);
    return {
      kind: "error",
      status: res.status,
      url,
      detail: `resource server ${res.status}`,
      redirectedCrossOrigin: isCrossOriginRedirect(url, res),
    };
  }
  if (!res.body) {
    const size = (await res.text()).length;
    return {
      kind: "error",
      status: 502,
      url,
      detail: `resource server returned an empty body (${size} bytes)`,
    };
  }

  // Count bytes as they flow so the completion log can report size without
  // ever holding the payload.
  const bytes = { value: 0 };
  const onComplete = req.onComplete;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      bytes.value += chunk.byteLength;
      ctrl.enqueue(chunk);
    },
    flush() {
      onComplete?.(bytes.value);
    },
  });

  return {
    kind: "stream",
    status: res.status,
    // NOT passed through verbatim. `/greenbutton/usage` answers with
    // `X-Content-Type-Options: nosniff`, so whatever the custodian declares
    // is what the browser honours — and if it ever answered `text/html`, the
    // ESPI body would render as HTML on OUR origin, next to the readings in
    // localStorage. The client ignores the header anyway (it calls
    // `res.text()`), so pinning it costs nothing and removes the vector.
    contentType: "application/xml",
    body: res.body.pipeThrough(counter),
    bytes,
    url,
  };
}
