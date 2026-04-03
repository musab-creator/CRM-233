import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StormShield Roofing CRM",
  description: "Complete CRM for roofing companies - Insurance & Retail job management",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
