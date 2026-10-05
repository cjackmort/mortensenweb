import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Jost, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

/*
 * mortensenweb.com's three faces, self-hosted by next/font at build time — the
 * portal's CSP allows fonts only from itself, and a client should not wait on
 * a third-party font host to read their own dashboard.
 */
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });
const display = Jost({ subsets: ["latin"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Mortensen Web Co. — Portal",
  description: "Client and administration portal.",
  // The portal must never be indexed.
  robots: { index: false, follow: false },
  // Installable. The welcome email tells clients to add the portal to their
  // home screen; without a manifest that produced a generic browser shortcut
  // with a screenshot for an icon. With one it installs as an app: its own
  // icon, its own window, no browser chrome. Deliberately no service worker —
  // an authenticated app should never serve a cached page.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "MW Portal",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
