import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ServiceWorkerRegister from "@/pwa/ServiceWorkerRegister";
import AppErrorBoundary from "@/components/AppErrorBoundary";
import I18nProvider from "@/i18n/I18nProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ontario Energy Optimizer",
  description: "Advanced electricity usage analysis and cost optimization for Ontario homeowners.",
  manifest: "/manifest.webmanifest",
  applicationName: "Ontario Energy Optimizer",
  appleWebApp: {
    capable: true,
    title: "Ontario Energy Optimizer",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#facc15",
  width: "device-width",
  initialScale: 1,
  // Wave I item 6 — let the standalone PWA span the whole display so the
  // device's own status bar and home indicator are ours to pad around (the
  // env(safe-area-inset-*) values in globals.css are 0 without this).
  viewportFit: "cover",
  // The UI is white/black/yellow cards in LIGHT and navy cards in DARK, so
  // the document advertises both and lets the FOUC script below pick. iOS
  // paints the standalone window from `colorScheme`, and the script sets it
  // on <html> to match the resolved theme — the installed app renders
  // exactly like the page.
  colorScheme: "light dark",
};

/**
 * Dark-mode FOUC guard (spec §3.1) — the script itself lives in
 * `public/theme-boot.js`; this only links it.
 *
 * The spec asked for an inline `<script>` as the first element of <head>. Two
 * things make that impossible here, both verified against the real build:
 *
 *  1. Next's app router does not render a user-authored <head>. The inline
 *     version was silently dropped — it never reached the served HTML, so it
 *     guarded nothing and flashed white on every dark-mode load.
 *  2. `security.test.tsx` forbids raw-HTML injection sinks in source, which
 *     is the only way to inline a script from JSX. That gate is correct.
 *
 * A static file in `public/` is the route that satisfies both: it ships
 * verbatim as dependency-free ES5, contains no JSX sink, and Next hoists the
 * `<link rel="preload">` below into the real <head> — measured at offset 1271
 * of the served document, comfortably before <body> at 2431, so it still runs
 * before first paint. Without it a dark-mode user gets a white flash on every
 * cold load, and the four paths that have to land (cold dark, cold light,
 * manual override, PWA relaunch) would not.
 *
 * `colorScheme: "light dark"` above is the other half: it lets the OS paint
 * the standalone window to match before any script runs.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `suppressHydrationWarning`: the boot script sets data-theme on the
    // client, so the server's <html> and the hydrated one legitimately
    // disagree about that one attribute. Without this React warns on every
    // load; with it, only the attribute it cannot know about is silenced.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* `async`, not `defer` — this is the whole point of the file.
            `defer` executes AFTER the HTML is parsed, so the body paints
            light and the theme swaps in behind it: exactly the flash this
            guard exists to prevent. An async script in <head> runs the
            moment it downloads, while the parser is still working through
            <body>, so data-theme is set before the first frame is painted.
            It cannot be module type: that would defer it by definition. */}
        <script src="/theme-boot.js" async />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Wave U: the locale subscription wraps everything, so any surface
            below — including the crash screen — can translate. */}
        <I18nProvider>
          {/* Wave H item 8: no view can blank the page — a crash lands on the
              crash screen with a copyable id instead of white space. */}
          <AppErrorBoundary>{children}</AppErrorBoundary>
        </I18nProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
