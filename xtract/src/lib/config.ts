// Single source for pricing, brand and integration switches.

export interface PriceTier {
  name: string;
  min: number; // reports this calendar month, inclusive
  max: number | null;
  cents: number;
  blurb: string;
}

// Volume pricing from the Xtract pricing page: the rate drops automatically
// once an account passes 25 and 100 reports in a calendar month.
export const PRICE_TIERS: PriceTier[] = [
  { name: "Standard", min: 1, max: 24, cents: 1200, blurb: "For individual reports and smaller teams." },
  { name: "Volume", min: 25, max: 99, cents: 1000, blurb: "For a recurring estimating workload." },
  { name: "Fleet", min: 100, max: null, cents: 800, blurb: "For operations with higher report volume." },
];

/** Tier for the Nth report of the month (1-based). */
export function tierFor(nth: number): PriceTier {
  return [...PRICE_TIERS].reverse().find((t) => nth >= t.min) ?? PRICE_TIERS[0];
}

/** Monthly estimate where each report is priced by its position in the month. */
export function monthlyEstimate(count: number) {
  const n = Math.max(0, Math.floor(count));
  let total = 0;
  for (let i = 1; i <= n; i++) total += tierFor(i).cents;
  return { count: n, totalCents: total, tier: tierFor(Math.max(1, n)), avgCents: n ? Math.round(total / n) : 0 };
}

export const REPORT_PAGES = [
  ["Cover", "Aerial image, totals and roof-age summary"],
  ["Diagram", "Every roof facet, to scale"],
  ["Lengths", "Color-coded eaves, rakes, ridges, hips, valleys, flashing"],
  ["Area", "Per-facet areas and roof totals"],
  ["Pitch & direction", "Slope and downslope direction of each facet"],
  ["Summary", "Measurements, area by pitch and waste table"],
  ["Permit history & roof age", "Year built, parcel and permit status"],
  ["Materials", "IKO, CertainTeed, GAF, Owens Corning and Atlas quantities"],
] as const;

export const BRAND = {
  name: "Xtract",
  full: "Xtract Roof Reports",
  operator: "Diversity Roofing",
  supportEmail: process.env.XTRACT_SUPPORT_EMAIL || "musab@diversity-roofing.com",
  phone: "(904) 979-0556",
  phoneHref: "tel:+19049790556",
  city: "Jacksonville, Florida",
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

/** Demo sign-in shows the magic link on screen. Never in production unless forced. */
export function demoSignInAllowed(): boolean {
  if (process.env.SMTP_HOST) return false;
  return process.env.NODE_ENV !== "production" || process.env.XTRACT_DEMO_LOGIN === "1";
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}
