/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: run with `node scripts/…`, not bundled. */
/**
 * Wave I helper — deterministic CLS probe for the PREPARING OPTIMIZER splash
 * -> dashboard swap (Wave H measured 0.134 there; the stock Lighthouse run
 * only catches it when the swap happens to land after first paint, so this
 * forces the race with CPU + network throttling and records attribution).
 *
 * Usage: node scripts/cls-probe.cjs [baseURL] [outJson]
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:3199';
const OUT = process.argv[3] || '/tmp/cls-probe.json';

const HOOK = `
  window.__cls = { total: 0, shifts: [] };
  const desc = (n) => {
    if (!n) return null;
    if (n.nodeType !== 1) return n.nodeName;
    let d = n.tagName.toLowerCase();
    if (n.id) d += '#' + n.id;
    if (typeof n.className === 'string' && n.className.trim()) {
      d += '.' + n.className.trim().split(/\\s+/).slice(0, 5).join('.');
    }
    const t = n.getAttribute && n.getAttribute('data-testid');
    if (t) d += '[' + t + ']';
    return d;
  };
  const rect = (r) => r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__cls.total += e.value;
      window.__cls.shifts.push({
        value: e.value, time: Math.round(e.startTime),
        sources: (e.sources || []).map((s) => ({ node: desc(s.node), prev: rect(s.previousRect), cur: rect(s.currentRect) })),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
`;

(async () => {
  const cpu = Number(process.env.CPU_RATE || 4);
  const latency = Number(process.env.LATENCY_MS || 400);
  const down = Number(process.env.DOWN_BPS || 500e3 / 8);

  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency, downloadThroughput: down, uploadThroughput: down / 4,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.addInitScript(HOOK);

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  const cls = await page.evaluate(() => window.__cls);
  await page.screenshot({ path: OUT.replace(/\.json$/, '.png') });
  await browser.close();

  fs.writeFileSync(OUT, JSON.stringify(cls, null, 2));
  console.log(`CLS=${cls.total.toFixed(4)} over ${cls.shifts.length} shifts (cpu=${cpu}x latency=${latency}ms down=${down * 8}bps)`);
  for (const s of cls.shifts) {
    console.log(`  ${s.value.toFixed(4)} @${s.time}ms`);
    for (const src of s.sources.slice(0, 4)) {
      console.log(`     ${src.node}\n        ${JSON.stringify(src.prev)} -> ${JSON.stringify(src.cur)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
