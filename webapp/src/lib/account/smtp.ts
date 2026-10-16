/**
 * Minimal SMTP transport for the account server.
 *
 * This deliberately uses Node's net/tls primitives rather than a provider SDK:
 * the selected deployment is a configurable SMTP relay, not Postmark/Resend.
 * TLS is mandatory (implicit TLS or STARTTLS), credentials come only from the
 * process environment/secret mount, and no command, response, token, address
 * or message body is logged.
 */

import net from "node:net";
import tls from "node:tls";
import type { AccountConfig } from "./config";

export type TransactionalMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export class SmtpDeliveryError extends Error {
  constructor(readonly smtpCode: number | null, readonly permanent: boolean) {
    super("transactional email delivery failed");
    this.name = "SmtpDeliveryError";
  }
}

type Socket = net.Socket | tls.TLSSocket;
type Reader = { socket: Socket; buffer: string };
type Reply = { code: number; lines: string[] };

function timeoutError(): SmtpDeliveryError {
  return new SmtpDeliveryError(null, false);
}

function waitForConnect(socket: Socket, timeoutMs: number, secure: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      socket.destroy();
      reject(timeoutError());
    }, timeoutMs);
    const done = (error?: Error) => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      socket.removeListener(secure ? "secureConnect" : "connect", onConnect);
      socket.removeListener("error", onError);
      if (error) reject(new SmtpDeliveryError(null, false));
      else resolve();
    };
    const onConnect = () => done();
    const onError = (error: Error) => done(error);
    socket.once(secure ? "secureConnect" : "connect", onConnect);
    socket.once("error", onError);
  });
}

function lineFromBuffer(reader: Reader): string | null {
  const at = reader.buffer.indexOf("\n");
  if (at < 0) return null;
  const line = reader.buffer.slice(0, at).replace(/\r$/, "");
  reader.buffer = reader.buffer.slice(at + 1);
  return line;
}

async function readReply(reader: Reader, timeoutMs: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    let code: number | null = null;
    let settled = false;
    const lines: string[] = [];
    const finish = (error?: Error, reply?: Reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.socket.removeListener("data", onData);
      reader.socket.removeListener("error", onError);
      if (error) reject(error);
      else resolve(reply!);
    };
    const consume = () => {
      for (;;) {
        const line = lineFromBuffer(reader);
        if (line === null) return;
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) return finish(new SmtpDeliveryError(null, false));
        const lineCode = Number(match[1]);
        code ??= lineCode;
        if (lineCode !== code) return finish(new SmtpDeliveryError(lineCode, lineCode >= 500));
        lines.push(match[3]);
        if (match[2] === " ") return finish(undefined, { code, lines });
      }
    };
    const onData = (chunk: Buffer | string) => {
      reader.buffer += chunk.toString("utf8");
      consume();
      // A fragmented response gets a fresh bounded wait after each fragment.
      if (!settled) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(timeoutError()), timeoutMs);
      }
    };
    const onError = () => finish(new SmtpDeliveryError(null, false));
    reader.socket.on("data", onData);
    reader.socket.once("error", onError);
    consume();
  });
}

async function command(reader: Reader, text: string, timeoutMs: number, expected: number[] = [250]): Promise<Reply> {
  reader.socket.write(`${text}\r\n`);
  const reply = await readReply(reader, timeoutMs);
  if (!expected.includes(reply.code)) throw new SmtpDeliveryError(reply.code, reply.code >= 500);
  return reply;
}

function mailbox(value: string): string {
  const match = /<([^<>\s@]+@[^<>\s@]+)>/.exec(value) ?? /^([^<>\s@]+@[^<>\s@]+)$/.exec(value.trim());
  if (!match || /[\r\n]/.test(value)) throw new Error("invalid sender mailbox");
  return match[1];
}

function header(value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new Error("invalid email header");
  return value;
}

function wireMessage(cfg: NonNullable<AccountConfig["smtp"]>, message: TransactionalMessage): string {
  const from = header(cfg.from);
  const to = header(message.to);
  const replyTo = cfg.replyTo ? `Reply-To: ${header(cfg.replyTo)}\r\n` : "";
  const body = message.text.replace(/\r?\n/g, "\r\n");
  const html = message.html.replace(/\r?\n/g, "\r\n");
  const mixed = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo.trimEnd(),
    `Subject: ${header(message.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=acct-boundary",
    "",
    "--acct-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    "--acct-boundary",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "--acct-boundary--",
    "",
  ].filter((line, index) => !(index === 2 && line === ""));
  return `${mixed.join("\r\n").replace(/^\./gm, "..")}\r\n.\r\n`;
}

async function openSocket(cfg: NonNullable<AccountConfig["smtp"]>): Promise<Socket> {
  if (cfg.tlsMode === "implicit") {
    const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: true });
    await waitForConnect(socket, cfg.timeoutMs, true);
    return socket;
  }
  const socket = net.connect({ host: cfg.host, port: cfg.port });
  await waitForConnect(socket, cfg.timeoutMs, false);
  return socket;
}

function tlsUpgrade(socket: net.Socket, cfg: NonNullable<AccountConfig["smtp"]>): Promise<tls.TLSSocket> {
  const secure = tls.connect({ socket, servername: cfg.host, rejectUnauthorized: true });
  return waitForConnect(secure, cfg.timeoutMs, true).then(() => secure);
}

/** Send one transactional message; callers decide how to persist a permanent bounce. */
export async function sendTransactionalEmail(cfg: AccountConfig, message: TransactionalMessage): Promise<void> {
  const smtp = cfg.smtp;
  if (!smtp) throw new SmtpDeliveryError(null, false);
  const to = mailbox(message.to);
  const from = mailbox(smtp.from);
  let socket: Socket | null = null;
  try {
    socket = await openSocket(smtp);
    let reader: Reader = { socket, buffer: "" };
    await readReply(reader, smtp.timeoutMs);
    let ehlo = await command(reader, `EHLO ${smtp.helo}`, smtp.timeoutMs);
    if (smtp.tlsMode === "starttls") {
      if (!ehlo.lines.some((line) => /^STARTTLS$/i.test(line.trim()))) {
        throw new SmtpDeliveryError(ehlo.code, false);
      }
      await command(reader, "STARTTLS", smtp.timeoutMs, [220]);
      socket = await tlsUpgrade(socket as net.Socket, smtp);
      reader = { socket, buffer: "" };
      ehlo = await command(reader, `EHLO ${smtp.helo}`, smtp.timeoutMs);
    }
    if (smtp.username || smtp.password) {
      if (!smtp.username || !smtp.password) throw new SmtpDeliveryError(null, false);
      await command(reader, "AUTH PLAIN", smtp.timeoutMs, [334]);
      await command(reader, Buffer.from(`\0${smtp.username}\0${smtp.password}`).toString("base64"), smtp.timeoutMs, [235]);
    }
    await command(reader, `MAIL FROM:<${from}>`, smtp.timeoutMs);
    await command(reader, `RCPT TO:<${to}>`, smtp.timeoutMs, [250, 251]);
    await command(reader, "DATA", smtp.timeoutMs, [354]);
    socket.write(wireMessage(smtp, message));
    await readReply(reader, smtp.timeoutMs);
    await command(reader, "QUIT", smtp.timeoutMs, [221, 250]);
  } catch (error) {
    if (error instanceof SmtpDeliveryError) throw error;
    throw new SmtpDeliveryError(null, false);
  } finally {
    socket?.end();
    socket?.destroy();
  }
}

export function isSafeMailbox(value: string): boolean {
  try {
    mailbox(value);
    return true;
  } catch {
    return false;
  }
}
