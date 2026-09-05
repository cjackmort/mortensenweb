import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0c0e" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
