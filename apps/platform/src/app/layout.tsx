import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mortensen Web Co. — Portal",
  description: "Client and administration portal.",
  // The portal must never be indexed.
  robots: { index: false, follow: false },
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
