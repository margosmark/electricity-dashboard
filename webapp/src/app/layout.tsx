import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ServiceWorkerRegister from "@/pwa/ServiceWorkerRegister";
import AppErrorBoundary from "@/components/AppErrorBoundary";
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
  // The whole UI is white/black/yellow cards; a system-dark body would show
  // through as a black band behind them, and iOS paints the standalone
  // window from `colorScheme`. Pin it so the installed app renders exactly
  // like the page.
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* Wave H item 8: no view can blank the page — a crash lands on the
            crash screen with a copyable id instead of white space. */}
        <AppErrorBoundary>{children}</AppErrorBoundary>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
