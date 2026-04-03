import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Apex Roofing CRM | Storm Restoration & Retail Management",
  description:
    "Complete CRM for roofing companies - insurance claims, retail jobs, inspections, and marketing",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
