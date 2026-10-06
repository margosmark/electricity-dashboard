#!/usr/bin/env python3
"""Local stand-in for the Oakville Hydro Green Button portal.

Used ONLY by tests: it reproduces the unauthenticated redirect chain, the
login form shape (`#mat-input-0` / `#mat-input-1` / SIGN IN), the post-login
"Download My Data" entry point and the export download, so the whole
dmd_refresh flow — login, step engine, download capture, dedupe, exit codes —
can be exercised end to end without touching a real utility account.

MOCK_SCENARIO selects the outcome under test:

  ok          login succeeds, export downloads                -> exit 0/4
  badpass     portal rejects the credentials                  -> exit 3
  captcha     an interactive CAPTCHA appears after submit     -> exit 5
  mfa         an OTP step appears after submit                -> exit 5
  structure   logged in, but the DMD entry point is gone      -> exit 6

Run: python3 mock_portal.py [port]
"""

from __future__ import annotations

import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "greenbutton_synthetic.xml"

# Read per-request so a test can flip the scenario between runs without
# restarting the server (module-level constants would be frozen at import).
def mock_user() -> str:
    return os.environ.get("MOCK_USER", "owner@example.com")


def mock_pass() -> str:
    return os.environ.get("MOCK_PASS", "correct-horse-battery")


def scenario() -> str:
    return os.environ.get("MOCK_SCENARIO", "ok")

LOGIN_PAGE = """<!doctype html><html><head><title>Oakville Hydro</title></head><body>
<h1>LOGIN</h1>
<form class="login-form ng-untouched ng-pristine ng-invalid" action="/login" method="post">
  <label>Email Address</label>
  <input id="mat-input-0" type="text" value="">
  <label>Password</label>
  <input id="mat-input-1" type="password" value="">
  <button type="submit">SIGN IN</button>
</form>
{error}
</body></html>"""

ERROR_HTML = '<div role="alert" class="mat-error">The email or password is incorrect.</div>'

CAPTCHA_PAGE = """<!doctype html><html><head><title>Verify you are human</title></head><body>
<h1>VERIFY YOU ARE HUMAN</h1>
<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=xyz"></iframe>
</body></html>"""

MFA_PAGE = """<!doctype html><html><head><title>Two-step verification</title></head><body>
<h1>ENTER THE CODE</h1>
<input autocomplete="one-time-code" type="text">
<button type="button">Verify</button>
</body></html>"""

HOME_PAGE = """<!doctype html><html><head><title>MyOakvilleHydro</title></head><body>
<nav>
  <a href="/dmd">Download My Data</a>
  <a href="/mybills">My Bills</a>
</nav>
</body></html>"""

HOME_NO_DMD = """<!doctype html><html><head><title>MyOakvilleHydro</title></head><body>
<nav><a href="/mybills">My Bills</a></nav>
</body></html>"""

DMD_PAGE = """<!doctype html><html><head><title>Download My Data</title></head><body>
<h1>Download My Data</h1>
<label><input type="radio" name="interval" value="hourly"> Hourly</label>
<label><input type="radio" name="interval" value="fifteen"> 15-minute</label>
<label><input type="radio" name="range" value="all"> All available</label>
<a href="/export.xml" download>Download XML</a>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 — keep test output clean
        pass

    # --- helpers ---------------------------------------------------------
    def _send(self, body: bytes, ctype: str = "text/html; charset=utf-8",
              status: int = 200, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str, cookie: str | None = None) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()

    def _authed(self) -> bool:
        return "mb_session=1" in (self.headers.get("Cookie") or "")

    # --- routes ----------------------------------------------------------
    def do_GET(self):  # noqa: N802
        path = urlparse(self.path).path
        if path == "/":
            return self._redirect("/home")
        if path == "/login":
            return self._send(LOGIN_PAGE.format(error="").encode())
        if path == "/page/mfa":
            return self._send(MFA_PAGE.encode())
        if path == "/captcha":
            return self._send(CAPTCHA_PAGE.encode())
        if path == "/home":
            if not self._authed():
                return self._redirect("/login")
            body = HOME_NO_DMD if scenario() == "structure" else HOME_PAGE
            return self._send(body.encode())
        if path == "/dmd":
            if not self._authed():
                return self._redirect("/login")
            return self._send(DMD_PAGE.encode())
        if path == "/export.xml":
            if not self._authed():
                return self._redirect("/login")
            # htmlpayload: a 200 whose body is an error page wearing an XML
            # content-type — the exact shape a broken portal export takes.
            data = (b"<html><body>Export temporarily unavailable</body></html>"
                    if scenario() == "htmlpayload" else FIXTURE.read_bytes())
            return self._send(data, "application/xml", extra={
                "Content-Disposition": 'attachment; filename="greenbutton.xml"',
            })
        return self._send(b"not found", status=404)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        fields = dict(
            part.split("=", 1) for part in body.split("&") if "=" in part
        )
        password = fields.get("password", "")
        if scenario() == "badpass":
            return self._send(LOGIN_PAGE.format(error=ERROR_HTML).encode())
        if password != mock_pass() or fields.get("username") != mock_user():
            return self._send(LOGIN_PAGE.format(error=ERROR_HTML).encode())
        if scenario() == "captcha":
            return self._redirect("/captcha")
        if scenario() == "mfa":
            return self._redirect("/page/mfa", cookie="mb_session=1; Path=/")
        return self._redirect("/home", cookie="mb_session=1; Path=/")


def serve(port: int = 0) -> ThreadingHTTPServer:
    """Start the mock portal on a background thread; returns the server."""
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = serve(port)
    print(f"mock portal (scenario={scenario()}) on http://127.0.0.1:{port}/")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()
