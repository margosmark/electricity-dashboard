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
  | { kind: "accepted"; url: string; detail: string }
  | { kind: "error"; status: number; url: string; detail: string };

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
    return {
      kind: "error",
      status: 0,
      url,
      detail: `resource server unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (res.status === 202) {
    const detail = (await res.text()).slice(0, 500);
    return { kind: "accepted", url, detail };
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    return { kind: "error", status: res.status, url, detail };
  }
  if (!res.body) {
    const detail = await res.text();
    return {
      kind: "error",
      status: 502,
      url,
      detail: `resource server returned an empty body (${detail.length} bytes)`,
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
    contentType: res.headers.get("content-type") || "application/atom+xml",
    body: res.body.pipeThrough(counter),
    bytes,
    url,
  };
}
