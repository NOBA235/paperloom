import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaperLoom",
  description: "Cryptographic physical-to-cloud knowledge nodes for secure student learning.",
  metadataBase: new URL("https://paperloom.local"),
  openGraph: {
    title: "PaperLoom",
    description: "Scan a physical note, mint a cryptographic workspace, and learn from AI-curated gaps.",
    type: "website"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
