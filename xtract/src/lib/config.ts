import type { ReportTier } from "./types";

export interface Product {
  tier: ReportTier;
  name: string;
  priceCents: number;
  tagline: string;
  includes: string[];
  popular?: boolean;
}

// Prices are the single source of truth for the site, checkout and PDFs.
// Market reference (2026): Roofr $13–19, GAF QuickMeasure $18–20,
// EagleView Premium $32.75–87.
export const PRODUCTS: Record<ReportTier, Product> = {
  quick: {
    tier: "quick",
    name: "Quick Measure",
    priceCents: 1200,
    tagline: "Fast squares for bids and ballparks",
    includes: [
      "Total roof area & squares",
      "Predominant pitch + pitch breakdown",
      "Facet count & roof complexity",
      "Waste table (0–23%)",
    ],
  },
  full: {
    tier: "full",
    name: "Full Report",
    priceCents: 1900,
    tagline: "Everything you need to order materials",
    popular: true,
    includes: [
      "Everything in Quick Measure",
      "Lengths diagram: eaves, rakes, ridges, hips, valleys",
      "Pitch & area diagrams by facet",
      "Drip edge, starter, ridge cap, leak barrier",
      "Materials order list",
    ],
  },
  claims: {
    tier: "claims",
    name: "Claims Pro",
    priceCents: 2900,
    tagline: "Adjuster-ready documentation",
    includes: [
      "Everything in Full Report",
      "Aerial imagery page with capture date",
      "Facet-by-facet measurement table",
      "Squares by pitch for estimate line items",
    ],
  },
};

export const TIERS: ReportTier[] = ["quick", "full", "claims"];

export const BRAND = {
  name: "Xtract",
  full: "Xtract Roof Reports",
  supportEmail: process.env.XTRACT_SUPPORT_EMAIL || "musab@diversity-roofing.com",
  phone: "(904) 979-0556",
  phoneHref: "tel:+19049790556",
};

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001").replace(/\/$/, "");
}

/** Which integrations are live. Anything missing falls back to demo mode. */
export function integrations() {
  return {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    google: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    email: Boolean(process.env.SMTP_HOST),
  };
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}
