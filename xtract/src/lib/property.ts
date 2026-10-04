// Property records for the "Permit history & roof age" page.
//
// Year built + parcel come from the Florida Department of Revenue statewide
// cadastral layer (all 67 county property appraisers, published by FGIO).
// Permit history has no statewide feed; it stays "not checked" unless a
// last-roof-permit year is entered on the report.

export interface PropertyRecord {
  yearBuilt?: number;
  effectiveYearBuilt?: number;
  parcelId?: string;
  county?: string;
  source: string;
  checkedAt: string;
  lastRoofPermitYear?: number;
  permitsChecked: boolean;
}

const FL_CADASTRAL =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";

// FL DOR county numbers are assigned alphabetically from Alachua = 11.
const FL_COUNTIES = [
  "Alachua", "Baker", "Bay", "Bradford", "Brevard", "Broward", "Calhoun", "Charlotte", "Citrus", "Clay",
  "Collier", "Columbia", "Miami-Dade", "DeSoto", "Dixie", "Duval", "Escambia", "Flagler", "Franklin", "Gadsden",
  "Gilchrist", "Glades", "Gulf", "Hamilton", "Hardee", "Hendry", "Hernando", "Highlands", "Hillsborough", "Holmes",
  "Indian River", "Jackson", "Jefferson", "Lafayette", "Lake", "Lee", "Leon", "Levy", "Liberty", "Madison",
  "Manatee", "Marion", "Martin", "Monroe", "Nassau", "Okaloosa", "Okeechobee", "Orange", "Osceola", "Palm Beach",
  "Pasco", "Pinellas", "Polk", "Putnam", "St. Johns", "St. Lucie", "Santa Rosa", "Sarasota", "Seminole", "Sumter",
  "Suwannee", "Taylor", "Union", "Volusia", "Wakulla", "Walton", "Washington",
];

export const PERMIT_PORTALS: Record<string, string> = {
  Duval: "https://jaxepics.coj.net/Search/SearchResults",
};

function pick(attrs: Record<string, unknown>, names: string[]): unknown {
  const lower = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const year = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1700 && n <= new Date().getFullYear() ? n : undefined;
};

/** Florida parcel lookup by point. Returns null outside Florida or on any failure. */
export async function lookupProperty(lat: number, lng: number, countyHint?: string): Promise<PropertyRecord | null> {
  if (process.env.XTRACT_PROPERTY_LOOKUP === "off") return null;
  // Rough Florida bounding box — skip the request elsewhere.
  if (lat < 24.3 || lat > 31.1 || lng < -87.7 || lng > -79.8) return null;
  const url = new URL(FL_CADASTRAL);
  url.searchParams.set("geometry", `${lng},${lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("f", "json");
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: { attributes: Record<string, unknown> }[] };
    const attrs = data.features?.[0]?.attributes;
    if (!attrs) return null;
    const coNo = Number(pick(attrs, ["CO_NO", "CNTY_NO"]));
    return {
      yearBuilt: year(pick(attrs, ["ACT_YR_BLT", "ACTYRBLT", "YR_BLT"])),
      effectiveYearBuilt: year(pick(attrs, ["EFF_YR_BLT", "EFFYRBLT"])),
      parcelId: String(pick(attrs, ["PARCEL_ID", "PARCELNO", "PARCEL"]) ?? "") || undefined,
      county: countyHint ?? (coNo >= 11 && coNo <= 77 ? FL_COUNTIES[coNo - 11] : undefined),
      source: "Florida Department of Revenue parcel roll (statewide cadastral)",
      checkedAt: new Date().toISOString(),
      permitsChecked: false,
    };
  } catch {
    return null;
  }
}

/** One-sentence roof-age statement for the cover and permit pages. */
export function roofAgeSentence(p: PropertyRecord | null | undefined, now = new Date()): string {
  if (!p) return "Year built and permit history were not available for this address. Roof age is unverified.";
  const y = now.getFullYear();
  if (p.lastRoofPermitYear) return `Last roof permit ${p.lastRoofPermitYear}; the roof is about ${y - p.lastRoofPermitYear} years old.`;
  if (p.yearBuilt) {
    const permits = p.permitsChecked ? "no roof permits on file" : "permit records not checked";
    return `Built ${p.yearBuilt}; ${permits}, so the roof could be up to ${y - p.yearBuilt} years old.`;
  }
  return "Year built is not on file. Roof age is unverified.";
}
