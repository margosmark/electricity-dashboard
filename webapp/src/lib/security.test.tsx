/**
 * Wave G item 2 — untrusted-input security pass.
 *
 * Everything this app parses (Green Button XML from a utility, a JSON backup
 * the user picked from disk) is untrusted. These tests pin the three attack
 * surfaces that actually matter here:
 *
 *  1. XSS          — no code path turns feed text into HTML, and a hostile
 *                    feed that survives parsing still renders as TEXT.
 *  2. XML attacks  — external entities are refused, entity expansion stays
 *                    bounded, and non-numeric values can never become NaN
 *                    costs.
 *  3. SW poisoning — the service worker never caches a non-GET request, a
 *                    cross-origin request, or any endpoint other than
 *                    /api/rates. Asserted by EXECUTING the worker's fetch
 *                    handler against hostile requests, not by eyeballing it.
 *
 * The checklist these tests implement lives in SECURITY.md at the repo root.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { parseGreenButtonUsagePoints } from './energy';
import { UsagePointPicker } from '@/components/UsagePointPicker';

const WEBAPP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ==========================================================================
 * 1. XSS — source-level guard
 * ========================================================================== */

describe('no HTML-injection sinks anywhere in the app source', () => {
  const FORBIDDEN: { pattern: RegExp; why: string }[] = [
    { pattern: /dangerouslySetInnerHTML/, why: 'raw JSX HTML injection' },
    { pattern: /\.innerHTML\b/, why: 'direct DOM HTML assignment' },
    { pattern: /\.outerHTML\b/, why: 'direct DOM HTML assignment' },
    { pattern: /insertAdjacentHTML/, why: 'direct DOM HTML injection' },
    { pattern: /\bdocument\.write\s*\(/, why: 'document-wide HTML write' },
    { pattern: /\beval\s*\(/, why: 'code execution from strings' },
    { pattern: /new\s+Function\s*\(/, why: 'code execution from strings' },
    { pattern: /\bsrcdoc\b/, why: 'iframe HTML injection' },
    { pattern: /createContextualFragment/, why: 'HTML fragment parsing' },
  ];

  it('never introduces an HTML sink (regression guard)', () => {
    const sources = walk(path.join(WEBAPP_ROOT, 'src')).filter(
      (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f),
    );
    expect(sources.length).toBeGreaterThan(10);

    const hits: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path.relative(WEBAPP_ROOT, file)}: ${pattern} (${why})`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('renders a hostile feed label as text, never as markup', () => {
    const hostile = '<img src=x onerror="window.__pwned=1">UsagePoint 1';
    render(
      <UsagePointPicker
        fileName="evil.xml"
        groups={[
          {
            id: hostile,
            label: `UsagePoint ${hostile.slice(0, 8)}`,
            blocks: 1,
            readings: [{ timestamp: 1704067200, usage_kwh: 1 }],
          },
        ]}
        onChoose={() => {}}
        onCancel={() => {}}
      />,
    );

    // No element was created from the feed's markup...
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    // ...and the payload shows up as literal, visible text instead.
    const picker = screen.getByTestId('usage-point-picker');
    expect(picker.textContent).toContain('<img');
    expect(picker.textContent).toContain('onerror="window.__pwned=1"');
  });
});

/* ==========================================================================
 * 2. XML pipeline — hostile documents
 * ========================================================================== */

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>${body}`;

describe('Green Button parsing of hostile XML', () => {
  it('keeps markup in text nodes as data, not as elements the app renders', () => {
    const xml = wrap(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title><script>alert(1)</script></title>
          <link href="https://evil.example/UsagePoint/&lt;svg onload=alert(1)&gt;/MeterReading/m/IntervalBlock/b" rel="self"/>
          <content>
            <IntervalBlock>
              <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>1500</value></IntervalReading>
            </IntervalBlock>
          </content>
        </entry>
      </feed>`);

    const groups = parseGreenButtonUsagePoints(xml);
    expect(groups).toHaveLength(1);
    expect(groups[0].readings).toEqual([{ timestamp: 1704067200, usage_kwh: 1.5 }]);
    // The hostile href still feeds the group id — as a string, escaped by React.
    expect(groups[0].id).toContain('<svg');
  });

  it('refuses external entities (XXE) instead of reading files', () => {
    const xml = wrap(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <feed><entry><content><IntervalBlock>
        <IntervalReading><timePeriod><start>1704067200&xxe;</start></timePeriod><value>1000</value></IntervalReading>
      </IntervalBlock></content></entry></feed>`);

    let threw: Error | null = null;
    let groups: unknown = null;
    try {
      groups = parseGreenButtonUsagePoints(xml);
    } catch (e) {
      threw = e as Error;
    }
    expect(threw, 'an XXE document must not parse').not.toBeNull();
    expect(threw!.message).toMatch(/entit/i);
    expect(groups).toBeNull();
  });

  it('bounds entity expansion instead of exploding (billion-laughs style)', () => {
    const xml = wrap(`<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
      <feed><entry><content><IntervalBlock>
        <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value>&lol2;</value></IntervalReading>
      </IntervalBlock></content></entry></feed>`);

    // Expansion is bounded: parsing stays fast and the document never turns
    // into a megabyte string.
    const groups = parseGreenButtonUsagePoints(xml);
    expect(JSON.stringify(groups).length).toBeLessThan(10_000);
  });

  it('never turns a non-numeric value into NaN (which would poison every total)', () => {
    const xml = wrap(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry><content><IntervalBlock>
          <IntervalReading><timePeriod><start>1704067200</start></timePeriod><value><nested/></value></IntervalReading>
          <IntervalReading><timePeriod><start>1704070800</start></timePeriod><value>not-a-number</value></IntervalReading>
          <IntervalReading><timePeriod><start>1704074400</start></timePeriod><value>2000</value></IntervalReading>
        </IntervalBlock></content></entry>
      </feed>`);

    const groups = parseGreenButtonUsagePoints(xml);
    const readings = groups.flatMap((g) => g.readings);
    expect(readings.length).toBeGreaterThan(0);
    for (const r of readings) {
      expect(Number.isFinite(r.timestamp)).toBe(true);
      expect(Number.isFinite(r.usage_kwh)).toBe(true);
      expect(r.usage_kwh).toBeGreaterThanOrEqual(0);
    }
    expect(readings.some((r) => r.timestamp === 1704074400 && r.usage_kwh === 2)).toBe(true);
  });
});

/* ==========================================================================
 * 3. Service worker — executed against hostile requests
 * ========================================================================== */

type FetchEvent = {
  request: { url: string; method: string; mode: string; clone?: () => unknown };
  respondWith: (p: unknown) => void;
  waitUntil: (p: unknown) => void;
};

/**
 * Evaluate public/sw.js with a scripted `self`, then dispatch synthetic fetch
 * events at it. `respondWith` being called means "the worker took ownership of
 * this request (and therefore may cache it)"; never being called means the
 * browser's default handling applies and nothing is stored.
 */
function bootServiceWorker(options: { windowClients?: unknown[] } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  // Wave N: the worker can now show notifications, so the harness has to be
  // able to observe them — a push handler nobody can assert on would be a
  // test that proves nothing.
  const showNotification = vi.fn(async (...args: unknown[]) => { void args; });
  const openWindow = vi.fn(async (...args: unknown[]) => { void args; return null; });
  const focused = vi.fn(async () => true);
  const navigated = vi.fn(async () => null);
  const cachePut = vi.fn(async (...args: unknown[]) => { void args; });
  const cacheAddAll = vi.fn(async () => {});
  const opened: string[] = [];

  const fakeCaches = {
    open: vi.fn(async (name: string) => {
      opened.push(name);
      return { addAll: cacheAddAll, put: cachePut };
    }),
    match: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };

  const fakeSelf = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    caches: fakeCaches,
    location: { origin: 'https://app.example' },
    skipWaiting: vi.fn(async () => {}),
    registration: { showNotification },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => options.windowClients ?? []),
      openWindow,
    },
  };

  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, clone: () => ({}) }));
  const src = fs.readFileSync(path.join(WEBAPP_ROOT, 'public/sw.js'), 'utf8');
  // Executing the worker's top-level code here is the point of the harness.
  new Function('self', 'fetch', 'URL', src)(fakeSelf, fetchMock, URL);

  const dispatch = (request: FetchEvent['request']): FetchEvent => {
    const event: FetchEvent = {
      request,
      respondWith: vi.fn(),
      waitUntil: vi.fn(),
    };
    (listeners.fetch as (e: unknown) => void)(event);
    return event;
  };

  /** Dispatch a `push` / `notificationclick` event at the worker. */
  const dispatchRaw = (type: string, event: unknown): unknown => {
    listeners[type](event);
    return event;
  };

  const makeWindowClient = () => ({ focus: focused, navigate: navigated });

  return { dispatch, dispatchRaw, cachePut, opened, listeners, showNotification, openWindow, focused, navigated, makeWindowClient };
}

const req = (url: string, opts: { method?: string; mode?: string } = {}) => ({
  url,
  method: opts.method ?? 'GET',
  mode: opts.mode ?? 'cors',
});

describe('service worker cache-poisoning surface', () => {
  it('loads and registers its handlers', () => {
    const { listeners } = bootServiceWorker();
    expect(Object.keys(listeners)).toEqual(expect.arrayContaining(['install', 'activate', 'fetch']));
  });

  it('never touches a non-GET request', async () => {
    const { dispatch, cachePut } = bootServiceWorker();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const event = dispatch(req(`https://app.example/api/rates`, { method }));
      expect(event.respondWith, `${method} must pass through untouched`).not.toHaveBeenCalled();
    }
    await Promise.resolve();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it('never touches a cross-origin request', () => {
    const { dispatch } = bootServiceWorker();
    const event = dispatch(req('https://evil.example/api/rates'));
    expect(event.respondWith).not.toHaveBeenCalled();
  });

  it('never caches any API endpoint other than /api/rates', async () => {
    const { dispatch, cachePut } = bootServiceWorker();

    for (const url of [
      'https://app.example/api/user',
      'https://app.example/api/backup',
      'https://app.example/api/session',
      'https://app.example/api/rates/extra',
      'https://app.example/api/rates/../../user',
    ]) {
      const event = dispatch(req(url));
      expect(event.respondWith, `${url} must pass through untouched`).not.toHaveBeenCalled();
    }

    // A query string on the rates endpoint is still the rates endpoint
    // (pathname is what the handler matches on).
    expect(dispatch(req('https://app.example/api/rates?cb=1')).respondWith).toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 0));
    expect(cachePut.mock.calls.length).toBeGreaterThan(0);
    expect(
      cachePut.mock.calls.every((c) =>
        new URL(String((c[0] as unknown as { url?: string })?.url ?? '')).pathname.includes('/api/rates'),
      ),
    ).toBe(true);
  });

  it('never handles a same-origin page/API path that is not on the allow-list', () => {
    const { dispatch } = bootServiceWorker();
    for (const url of [
      'https://app.example/private',
      'https://app.example/api/',
      'https://app.example/sw.js',
      'https://app.example/manifest.webmanifest?',
    ]) {
      const event = dispatch(req(url));
      if (url.endsWith('/sw.js') || url.endsWith('/manifest.webmanifest?')) continue; // static allow-list
      expect(event.respondWith, `${url} must pass through untouched`).not.toHaveBeenCalled();
    }
  });

  it('does not pull remote code into the worker', () => {
    const src = fs.readFileSync(path.join(WEBAPP_ROOT, 'public/sw.js'), 'utf8');
    expect(src).not.toMatch(/importScripts\s*\(/);
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\s*\(/);
  });

  it('caches only its own versioned cache names', async () => {
    const { opened } = bootServiceWorker();
    expect(opened.every((name) => /^oeo-v\d/.test(name))).toBe(true);
  });
});

/* ==========================================================================
 * 3b. Service worker push surface (Wave N) — executed, not eyeballed
 * ========================================================================== */

type PushEvent = {
  data: { json: () => unknown } | null;
  waitUntil: ReturnType<typeof vi.fn>;
};

type NotificationClickEvent = {
  notification: { close: ReturnType<typeof vi.fn>; data: unknown };
  waitUntil: ReturnType<typeof vi.fn>;
};

describe('service worker push handlers (Wave N)', () => {
  it('registers push and notificationclick next to the fetch handlers', () => {
    const { listeners } = bootServiceWorker();
    expect(Object.keys(listeners)).toEqual(expect.arrayContaining(['install', 'activate', 'fetch', 'push', 'notificationclick']));
  });

  it('shows the server-rendered title, body and same-origin target', async () => {
    const { dispatchRaw, showNotification } = bootServiceWorker();
    const event: PushEvent = {
      data: {
        json: () => ({ topic: 'oeb_rates', title: 'New electricity rates', body: 'Effective Nov 1', url: '/insights' }),
      },
      waitUntil: vi.fn(),
    };
    dispatchRaw('push', event);
    expect(event.waitUntil).toHaveBeenCalled();
    await event.waitUntil.mock.calls[0][0];
    expect(showNotification).toHaveBeenCalledWith(
      'New electricity rates',
      expect.objectContaining({ body: 'Effective Nov 1', data: { url: '/insights' }, tag: 'oeb_rates' }),
    );
  });

  it('never follows a cross-origin URL carried in a push payload', async () => {
    const { dispatchRaw, showNotification } = bootServiceWorker();
    const event: PushEvent = {
      data: { json: () => ({ title: 'x', url: 'https://evil.example/steal' }) },
      waitUntil: vi.fn(),
    };
    dispatchRaw('push', event);
    await event.waitUntil.mock.calls[0][0];
    const [, options] = showNotification.mock.calls[0] as unknown as [string, { data: { url: string } }];
    expect(options.data.url).toBe('/');
  });

  it('falls back to a neutral title when the payload is not usable JSON', async () => {
    const { dispatchRaw, showNotification } = bootServiceWorker();
    const event: PushEvent = {
      data: {
        json: () => {
          throw new Error('not json');
        },
      },
      waitUntil: vi.fn(),
    };
    dispatchRaw('push', event);
    await event.waitUntil.mock.calls[0][0];
    expect(showNotification.mock.calls[0][0]).toBe('Ontario Energy Optimizer');
  });

  it('ignores a push with no body instead of throwing', () => {
    const { dispatchRaw, showNotification } = bootServiceWorker();
    const event = { data: null, waitUntil: vi.fn() };
    dispatchRaw('push', event);
    expect(event.waitUntil).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('closes the notification, focuses an open window and navigates it', async () => {
    const client = { focus: vi.fn(async () => true), navigate: vi.fn(async () => null) };
    const { dispatchRaw } = bootServiceWorker({ windowClients: [client] });
    const close = vi.fn();
    const event: NotificationClickEvent = {
      notification: { close, data: { url: '/import' } },
      waitUntil: vi.fn(),
    };
    dispatchRaw('notificationclick', event);

    // The notification must be gone before anything else happens, or a
    // second tap stacks a duplicate behind a stale one.
    expect(close).toHaveBeenCalled();
    expect(event.waitUntil).toHaveBeenCalled();
    await event.waitUntil.mock.calls[0][0];
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith('/import');
  });

  it('opens a window when none is already open, and never leaves the origin', async () => {
    const { dispatchRaw, openWindow } = bootServiceWorker({ windowClients: [] });
    const close = vi.fn();
    const event: NotificationClickEvent = {
      notification: { close, data: { url: 'https://evil.example/' } },
      waitUntil: vi.fn(),
    };
    dispatchRaw('notificationclick', event);
    await event.waitUntil.mock.calls[0][0];
    expect(openWindow).toHaveBeenCalledWith('/');
  });
});
