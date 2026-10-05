/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: run with `node scripts/…`, not bundled. */
/**
 * Wave I item 6 — does the app actually present as an installable, correctly
 * dressed PWA on a phone?
 *
 * Checks, against a running origin:
 *  - /manifest.webmanifest: name/short_name, display, start/scope/id, theme and
 *    background colour, and an icon set that covers `any` AND `maskable` at the
 *    sizes Android asks for (192 + 512)
 *  - each icon really is the PNG size it claims (IHDR, not just the filename)
 *  - the document head: viewport-fit=cover (without it env(safe-area-inset-*)
 *    is 0 and every inset rule in the app is a no-op), theme-color matching the
 *    manifest, apple-touch-icon, manifest link, apple web-app meta
 *  - the browser supports the env() the overlays pad with, and the
 *    `.overlay-safe` rule is actually applied to the upload modal
 *
 * Usage: node scripts/pwa-check.cjs <baseURL> <outJson>
 */
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = (process.argv[2] || 'http://127.0.0.1:3199').replace(/\/$/, '');
const OUT = process.argv[3] || path.join(__dirname, '..', 'evidence', 'wave-i-pwa.json');

/** Read a PNG's real width/height out of its IHDR chunk. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Decode a non-interlaced 8-bit RGB/RGBA PNG and return the bounding box of
 * everything that differs from the corner pixel — i.e. where the ARTWORK sits.
 *
 * This is the only way to check the thing a maskable icon is actually graded
 * on: the launchers mask it to a circle 80% of the icon's diameter, and any
 * artwork outside that circle is simply cut off.
 */
function pngArtworkBBox(buf) {
  const size = pngSize(buf);
  if (!size) return null;
  let off = 8;
  const idat = [];
  let colorType = -1;
  let interlace = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      if (data[8] !== 8 || data[12] !== 0) return null; // bit depth 8, non-interlaced only
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (interlace !== 0 || (colorType !== 6 && colorType !== 2)) return null;
  const bpp = colorType === 6 ? 4 : 3;
  const { width: w, height: h } = size;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;

  // Undo the per-scanline filters (PNG spec §9).
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dstOff = y * stride;
    const prevOff = dstOff - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[dstOff + i - bpp] : 0;
      const b = y > 0 ? out[prevOff + i] : 0;
      const c = y > 0 && i >= bpp ? out[prevOff + i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[dstOff + i] = v & 0xff;
    }
  }

  const br = out[0];
  const bg = out[1];
  const bb = out[2];
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + x * bpp;
      const r = out[i];
      const g = out[i + 1];
      const bch = out[i + 2];
      if (Math.abs(r - br) + Math.abs(g - bg) + Math.abs(bch - bb) > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { width: w, height: h, minX, minY, maxX, maxY };
}

const results = [];
const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

async function main() {
  const res = await fetch(BASE + '/manifest.webmanifest');
  check('manifest served with 200', res.status === 200, `HTTP ${res.status}`);
  const manifest = await res.json().catch(() => null);
  check('manifest parses as JSON', !!manifest, manifest ? 'ok' : 'unparseable');

  if (manifest) {
    check('name + short_name', !!manifest.name && !!manifest.short_name, `${manifest.name} / ${manifest.short_name}`);
    check('display: standalone', manifest.display === 'standalone', String(manifest.display));
    check('start_url + scope + id', !!manifest.start_url && !!manifest.scope && !!manifest.id,
      `${manifest.start_url} scope=${manifest.scope} id=${manifest.id}`);
    check('theme_color is set', /^#[0-9a-f]{3,8}$/i.test(manifest.theme_color || ''), String(manifest.theme_color));
    check('background_color is set', !!manifest.background_color, String(manifest.background_color));

    const icons = manifest.icons || [];
    const any512 = icons.find((i) => i.sizes === '512x512' && /any/.test(i.purpose || 'any'));
    const any192 = icons.find((i) => i.sizes === '192x192' && /any/.test(i.purpose || 'any'));
    const maskable = icons.find((i) => /maskable/.test(i.purpose || ''));
    check('icon 192 for `any`', !!any192, any192 ? any192.src : 'missing');
    check('icon 512 for `any`', !!any512, any512 ? any512.src : 'missing');
    check('maskable icon present', !!maskable, maskable ? `${maskable.src} (${maskable.purpose})` : 'missing');

    for (const icon of icons) {
      const u = new URL(icon.src, BASE);
      const r = await fetch(u);
      const buf = Buffer.from(await r.arrayBuffer());
      const size = pngSize(buf);
      const claim = icon.sizes.split('x').map(Number);
      const ok = r.status === 200 && size && size.width === claim[0] && size.height === claim[1];
      check(`icon pixels match its claim (${icon.src})`, ok,
        r.status === 200 ? `${size ? `${size.width}x${size.height}` : 'not a PNG'}, claims ${icon.sizes}, ${(buf.length / 1024).toFixed(1)} KB` : `HTTP ${r.status}`);
      if (/maskable/.test(icon.purpose || '')) {
        // A maskable icon is masked to a circle 80% of its width: artwork
        // outside that circle is not "a bit close to the edge", it is cut off.
        const box = pngArtworkBBox(buf);
        if (!box) {
          check('maskable artwork inside the 80% safe circle', false, 'could not decode the PNG');
        } else {
          const cx = (box.minX + box.maxX) / 2;
          const cy = (box.minY + box.maxY) / 2;
          const halfDiag = Math.hypot((box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2);
          const safe = box.width * 0.4;
          const centred = Math.abs(cx - box.width / 2) < box.width * 0.05 && Math.abs(cy - box.height / 2) < box.height * 0.05;
          check('maskable artwork inside the 80% safe circle', halfDiag <= safe && centred,
            `bbox ${box.minX}-${box.maxX} x ${box.minY}-${box.maxY}, half-diagonal ${halfDiag.toFixed(1)}px vs safe radius ${safe.toFixed(1)}px, centre offset (${(cx - box.width / 2).toFixed(1)}, ${(cy - box.height / 2).toFixed(1)})px`);
        }
      }
    }
  }

  // The document itself.
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    ...(process.env.PW_CHROMIUM_PATH ? {} : { channel: 'chrome' }),
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: 'en-CA',
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const head = await page.evaluate(() => {
    const meta = (sel) => document.querySelector(sel);
    const m = (name) => {
      const el = meta(`meta[name="${name}"]`) || meta(`meta[name="mobile-web-app-capable"]`);
      return el ? el.getAttribute('content') : null;
    };
    return {
      viewport: m('viewport'),
      themeColor: [...document.querySelectorAll('meta[name="theme-color"]')].map((e) => e.getAttribute('content')),
      appleCapable: m('apple-mobile-web-app-capable'),
      appleStatusBar: m('apple-mobile-web-app-status-bar-style'),
      appleTitle: m('apple-mobile-web-app-title'),
      manifestHref: (meta('link[rel="manifest"]') || {}).href,
      appleTouch: (meta('link[rel="apple-touch-icon"]') || {}).href,
      supportsEnv: CSS.supports('padding-top', 'env(safe-area-inset-top)'),
      overlaySafePadding: (() => {
        const el = document.createElement('div');
        el.className = 'overlay-safe';
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { top: cs.paddingTop, right: cs.paddingRight, bottom: cs.paddingBottom, left: cs.paddingLeft };
        el.remove();
        return out;
      })(),
      bodyPadBottom: getComputedStyle(document.body).paddingBottom,
    };
  });

  check('meta viewport has viewport-fit=cover', /viewport-fit\s*=\s*cover/.test(head.viewport || ''), head.viewport);
  check('meta viewport keeps width=device-width + initial-scale',
    /width\s*=\s*device-width/.test(head.viewport || '') && /initial-scale\s*=\s*1/.test(head.viewport || ''), head.viewport);
  check('theme-color meta matches manifest', head.themeColor.includes((manifest || {}).theme_color), head.themeColor.join(','));
  check('apple-mobile-web-app-capable', head.appleCapable === 'yes', String(head.appleCapable));
  check('apple status bar style declared', !!head.appleStatusBar, String(head.appleStatusBar));
  check('manifest link tag', !!head.manifestHref, head.manifestHref);
  check('apple-touch-icon link', !!head.appleTouch, head.appleTouch);
  check('browser supports env(safe-area-inset-*)', head.supportsEnv, String(head.supportsEnv));
  check('.overlay-safe resolves real padding', /px/.test(head.overlaySafePadding.top), JSON.stringify(head.overlaySafePadding));

  // And the overlay really picks it up in situ.
  await page.waitForSelector('[data-testid=upload-modal]', { timeout: 10000 }).catch(() => {});
  const modalPad = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=upload-modal]');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { top: cs.paddingTop, bottom: cs.paddingBottom, overflowY: cs.overflowY, height: cs.height };
  });
  check('upload modal is scrollable + inset-padded', !!modalPad && modalPad.overflowY === 'auto' && /px/.test(modalPad.top),
    JSON.stringify(modalPad));

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  const doc = { url: BASE, checkedAt: new Date().toISOString(), results, passed: results.length - failed.length, failed: failed.length };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  — ${r.detail}`);
  console.log(`\n${doc.passed}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
