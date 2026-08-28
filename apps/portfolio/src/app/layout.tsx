import type { Metadata } from "next";
import Script from "next/script";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { SITE } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    // Page titles supply their own prefix; this keeps the brand on the end.
    template: `%s — ${SITE.name}`,
  },
  description:
    "Mortensen Web Co. builds and maintains websites for small businesses. A site designed around what you actually sell, then kept current — you request a change, we make it.",
  openGraph: {
    type: "website",
    siteName: SITE.name,
    url: SITE.url,
    title: `${SITE.name} — ${SITE.tagline}`,
    description:
      "Websites for small businesses, built and looked after. See the work and the care plans.",
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        {/* Umami Cloud — website e71828c7-4b0e-4e06-8049-bd108a3b6fab.
            `afterInteractive` so it never delays first paint. */}
        <Script
          src="https://cloud.umami.is/script.js"
          data-website-id="e71828c7-4b0e-4e06-8049-bd108a3b6fab"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
