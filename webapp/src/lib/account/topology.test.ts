// @vitest-environment node
/**
 * Wave N — the deployment contract, asserted against the files that ship it.
 *
 * The account feature exists as a *split*: one image, three processes, and a
 * router that decides which one answers. Every part of that split that can be
 * wrong without anyone noticing lives in two text files, so this test reads
 * them instead of trusting the comments next to them:
 *
 *  - `ops/edge/default.conf.template` — which path goes where, and what the
 *    edge refuses outright. This is the class of bug that produced H1: a
 *    split that inverted while every header still claimed it was correct.
 *  - `docker-compose.yml` — which process is given which secret. The whole
 *    reason `account-server` is a separate service is that the public app
 *    must hold no verifier, no session material and no VAPID key; nothing in
 *    the running system would complain if that quietly changed.
 *
 * Live routing is proven separately (`webapp/scripts/e2e-greenbutton-topology.sh`
 * on a docker host, `tests/e2e/account_smoke.sh` against a booted container).
 * This gate is what runs everywhere, on every push, before any container
 * exists.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const edge = fs.readFileSync(path.join(REPO_ROOT, "ops", "edge", "default.conf.template"), "utf8");
const compose = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
const topologyScript = fs.readFileSync(path.join(REPO_ROOT, "webapp", "scripts", "e2e-greenbutton-topology.sh"), "utf8");

/**
 * Drop full-line comments before asserting.
 *
 * Both files are heavily commented — and a comment routinely names the very
 * thing it warns against ("no `proxy_pass` here", "the app gets no
 * `ACCT_ENABLED`"). Assertions have to run on the configuration, not on the
 * prose about it, or they test the wrong string.
 */
const stripComments = (text: string): string => text.replace(/^[ \t]*#.*$/gm, "");

/** The body of an nginx `location <pattern> { … }` block (closing brace at column 3). */
function locationBlock(pattern: string): string {
  const start = edge.indexOf(`location ${pattern} {`);
  expect(start, `the edge template must declare location ${pattern}`).toBeGreaterThan(-1);
  const end = edge.indexOf("\n  }", start);
  return stripComments(edge.slice(start, end === -1 ? edge.length : end));
}

/**
 * One service's block of docker-compose.yml, comments removed.
 *
 * A service block runs to the NEXT service key, so it also swallows the
 * comment block that introduces whatever comes next — stripping comments is
 * what keeps `greenbutton-shim` from inheriting `account-server`'s prose.
 */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `docker-compose.yml must define the ${name} service`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}[A-Za-z0-9_-]+:$/m);
  return stripComments(next === -1 ? rest : rest.slice(0, next + 1));
}

describe("the account topology gate provisions disposable storage", () => {
  it("uses a root helper container rather than host chown, and stops/cleans on failure", () => {
    expect(topologyScript).toMatch(/ACCT_DIR="\$\(mktemp -d\)"/);
    expect(topologyScript).toContain("docker run --rm --user 0 --entrypoint sh");
    expect(topologyScript).toContain("chown 1001:1001 /data && chmod 700 /data");
    expect(topologyScript).toContain('rm -rf "$TOKEN_DIR" "$ACCT_DIR"');
    expect(topologyScript).toContain("exit 1");
    expect(topologyScript).not.toMatch(/^chown 1001:1001 \"\$ACCT_DIR\"$/m);
    expect(topologyScript).toContain('GB_TOPO_PORT="$PORT" GB_TOPO_MOCK_PORT="$MOCK_PORT"');
    expect(topologyScript).toContain('GB_TOPO_APP_IMAGE="$IMAGE" GB_TOPO_ROUTER_IMAGE="$ROUTER_IMAGE"');
  });

  it("keeps the full closed-registration route sweep below the edge request rate", () => {
    const smoke = fs.readFileSync(path.join(REPO_ROOT, "webapp", "tests", "e2e", "account_smoke.sh"), "utf8");
    expect(smoke).toContain("sleep 1.1");
    expect(smoke).toContain("MATRIX_PATHS");
    expect(smoke).toContain("[signed out]");
    expect(topologyScript).toContain("--expect-registration-closed");
  });

  it("probes real-edge body, rate-limit and non-vacuous account log redaction", () => {
    expect(edge).toContain("limit_req_status 429;");
    expect(topologyScript).toContain("head -c 6291457 /dev/zero");
    expect(topologyScript).toContain('"$BODY_CODE" = 413');
    expect(topologyScript).toContain('"$CODE" = 429');
    expect(topologyScript).toContain("unique account canary request itself is present in router log");
    expect(topologyScript).toContain("query/IP/cookie canary is absent from router log");
  });
});

describe("the edge split for /account", () => {
  it("denies /account/internal outright — no upstream, no allow list", () => {
    const internal = locationBlock("/account/internal");
    expect(internal).toContain("deny all");
    expect(internal).toContain("access_log /var/log/nginx/access.log acct_safe;");
    expect(internal).toContain("error_log /var/log/nginx/error.log crit;");
    // A denied request must never reach a container: no `proxy_pass` at all,
    // and no `allow` list keyed on an address docker egress would fake.
    expect(internal).not.toContain("proxy_pass");
    expect(internal).not.toMatch(/^\s*allow\s/m);
  });

  it("routes the public account API to the account container, and labels it", () => {
    const account = locationBlock("/account");
    expect(account).toContain("proxy_pass http://$gb_account;");
    expect(account).toContain("add_header X-Edge-Location account always;");
    expect(account).toContain("client_max_body_size 6m;");
    expect(account).toContain("proxy_request_buffering on;");
    expect(account).toContain("limit_req zone=acct_public burst=20 nodelay;");
    expect(account).toContain("limit_conn acct_conn 10;");
    expect(account).toContain("access_log /var/log/nginx/access.log acct_safe;");
    expect(edge).toContain("log_format acct_safe '[$time_local] \"$request_method $uri\" $status';");
    expect(account).toContain("error_log /var/log/nginx/error.log crit;");
    expect(edge).toContain("zone=acct_public:10m rate=60r/m");
    expect(account).not.toContain("deny all");
  });

  it("declares the deny block before the public one, for whoever reads it next", () => {
    expect(edge.indexOf("location /account/internal")).toBeLessThan(edge.indexOf("location /account {"));
  });

  it("pins the upstream name to the account service", () => {
    expect(edge).toContain("set $gb_account account-server:3000;");
  });
});

describe("which process is given which secret", () => {
  it("the public dashboard gets NO ACCT_* and NO VAPID_*", () => {
    const app = service("energy-dashboard");
    expect(app).not.toMatch(/\bACCT_/);
    expect(app).not.toMatch(/\bVAPID_/);
    // …and no Green Button secrets either — the Wave K contract, restated.
    expect(app).not.toMatch(/\bGB_CLIENT_(ID|SECRET)\b/);
    expect(app).not.toContain("tokens.json");
  });

  it("the account server is the only service with the verifier + push key", () => {
    const account = service("account-server");
    expect(account).toContain("ACCT_ENABLED: ${ACCT_ENABLED:-false}"); // off until opted in
    expect(account).toContain("ACCT_DATA_DIR: /data");
    expect(account).toContain("ACCT_DATA_DIR_HOST: ${ACCT_DATA_DIR:?set ACCT_DATA_DIR");
    expect(account).toContain("ACCT_REPO_HOST_DIR: ${ACCT_REPO_HOST_DIR:-${PWD}}");
    expect(account).toContain("ACCT_DB_PATH: /data/accounts.db");
    expect(account).toContain("VAPID_PUBLIC_KEY:");
    expect(account).toContain("VAPID_PRIVATE_KEY:");
    // …and a volume, so the ciphertext survives a rebuild.
    expect(account).toMatch(/- \$\{ACCT_DATA_DIR[^}]*\}:\/data/);
    // It must not inherit the OAuth grant either: three processes, three
    // disjoint secret sets.
    expect(account).not.toMatch(/\bGB_CLIENT_(ID|SECRET)\b/);
    expect(account).not.toContain("tokens.json");
  });

  it("the shim may announce 'data changed' but holds no account database", () => {
    const shim = service("greenbutton-shim");
    expect(shim).toContain("ACCT_INTERNAL_TOKEN:");
    expect(shim).toContain("ACCT_NOTIFY_URL:");
    expect(shim).not.toContain("ACCT_DB_PATH");
    expect(shim).not.toContain("ACCT_ENABLED");
    expect(shim).not.toMatch(/\bVAPID_/);
  });

  it("all three processes run the SAME image", () => {
    const image = service("account-server").match(/^\s{4}image: (.+)$/m)?.[1];
    expect(image, "account-server must reuse the built app image").toBeTruthy();
    expect(service("energy-dashboard")).toContain(`image: ${image}`);
    expect(service("greenbutton-shim")).toContain(`image: ${image}`);
  });

  it("the router is declared to start alongside all three", () => {
    const router = service("edge-router");
    expect(router).toMatch(/^\s+- energy-dashboard$/m);
    expect(router).toMatch(/^\s+- greenbutton-shim$/m);
    expect(router).toMatch(/^\s+- account-server$/m);
  });
});

describe("edge — the OAuth referer hop (fix 7ee0375)", () => {
  it("answers the greenbutton callback with no-referrer so the ?code= URL cannot ride a Referer", () => {
    // The callback 302s to /?gb=connected. Without this header the browser
    // sends the FULL callback URL (?code=…&state=…) as `Referer` on the
    // follow-up request, and the edge's `combined` log format records
    // $http_referer — i.e. an OAuth code in the app's own access log.
    // The live hop is proven in e2e-greenbutton-topology.sh (docker-only);
    // this is the gate-side pin on the config line that closes it, so the
    // `add_header` cannot be dropped by a template edit without a red test.
    const block = locationBlock("= /greenbutton/callback");
    expect(block).toContain('add_header Referrer-Policy "no-referrer"');
  });
});
