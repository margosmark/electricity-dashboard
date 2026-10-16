// @vitest-environment node
import { describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidHelo } from "./config";
import { recoveryEmail, registrationEmail } from "./email";
import { sendTransactionalEmail, SmtpDeliveryError, type TransactionalMessage } from "./smtp";

const message: TransactionalMessage = { to: "owner@example.test", subject: "test", text: "text", html: "<p>text</p>" };

function smtpConfig(port: number, tlsMode: "implicit" | "starttls") {
  return {
    enabled: true,
    dbPath: ":memory:",
    publicOrigin: "https://electricity.markarslan.ca",
    sessionTtlMs: 1,
    maxSyncBytes: 1,
    vapid: null,
    internalToken: "",
    ratesUrl: "",
    ratesPollMs: 1,
    maxAccounts: 1,
    emailVerificationEnabled: true,
    smtp: {
      host: "127.0.0.1",
      port,
      tlsMode,
      username: "",
      password: "",
      helo: "relay.example.test",
      from: "accounts@electricity.markarslan.ca",
      replyTo: "support@electricity.markarslan.ca",
      timeoutMs: 1_000,
      eventsSecret: "s",
    },
  };
}

async function listening<T extends net.Server>(server: T): Promise<{ server: T; port: number }> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

describe("SMTP HELO validation", () => {
  it("puts verification bearers in fragments, never query strings", () => {
    const cfg = { publicOrigin: "https://electricity.markarslan.ca" } as Parameters<typeof registrationEmail>[0];
    const registration = registrationEmail(cfg, "owner@example.test", "registration-token");
    const recovery = recoveryEmail(cfg, "owner@example.test", "recovery-token");
    expect(registration.text).toContain("/account/verify#token=registration-token");
    expect(registration.text).not.toContain("/account/verify?token=");
    expect(recovery.text).toContain("/account/recover/verify#token=recovery-token");
    expect(recovery.text).not.toContain("/account/recover/verify?token=");
  });

  it.each([
    "electricity.markarslan.ca",
    "localhost",
    "relay-1.example.test",
  ])("accepts hostname syntax: %s", (helo) => {
    expect(isValidHelo(helo)).toBe(true);
  });

  it.each([
    "relay.example.test\r\nMAIL FROM:<attacker@example.test>",
    "-relay.example.test",
    "relay..example.test",
    "relay-.example.test",
    "a".repeat(254),
  ])("rejects invalid or injectable HELO values", (helo) => {
    expect(isValidHelo(helo)).toBe(false);
  });

  it("rejects before opening a socket or constructing EHLO", async () => {
    const cfg = smtpConfig(1, "starttls");
    cfg.smtp.helo = "relay.example.test\r\nMAIL FROM:<attacker@example.test>";
    cfg.smtp.username = "u";
    cfg.smtp.password = "p";
    await expect(sendTransactionalEmail(cfg, message)).rejects.toMatchObject({ permanent: true });
  });

  it("uses implicit TLS and rejects an untrusted certificate rather than falling back to plaintext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smtp-cert-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
    const server = tls.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) });
    server.on("tlsClientError", () => undefined);
    const active = await listening(server);
    try {
      await expect(sendTransactionalEmail(smtpConfig(active.port, "implicit"), message)).rejects.toBeInstanceOf(SmtpDeliveryError);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when STARTTLS is required but the server does not advertise it", async () => {
    const server = net.createServer((socket) => {
      socket.write("220 test.example.test ESMTP\\r\\n");
      socket.on("data", (chunk) => {
        if (chunk.toString().startsWith("EHLO ")) socket.write("250-test.example.test\\r\\n250 AUTH PLAIN\\r\\n");
      });
    });
    const active = await listening(server);
    try {
      await expect(sendTransactionalEmail(smtpConfig(active.port, "starttls"), message)).rejects.toBeInstanceOf(SmtpDeliveryError);
    } finally {
      server.close();
    }
  });
});