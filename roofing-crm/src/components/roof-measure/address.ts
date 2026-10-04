// Splits a one-line address into the CRM's street / city / state / zip fields.
// Handles Google's form ("123 Main St, Jacksonville, FL 32256, USA") and
// Esri's ("123 Main St, Jacksonville, Florida, 32256").

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const stateCode = (s: string) => (/^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : STATES[s.toLowerCase()] || null);

export interface AddressParts { address: string; city: string; state: string; zip: string }

export function splitAddress(full: string): AddressParts {
  const parts = full.split(',').map((p) => p.trim()).filter((p) => p && !/^(USA?|United States)$/i.test(p));
  const out: AddressParts = { address: parts[0] || '', city: parts[1] || '', state: 'FL', zip: '' };
  for (const p of parts.slice(2)) {
    const m = p.match(/^([A-Za-z][A-Za-z .]*?)\s*(\d{5})?(?:-\d{4})?$/);
    if (m && stateCode(m[1].trim())) { out.state = stateCode(m[1].trim())!; if (m[2]) out.zip = m[2]; continue; }
    const z = p.match(/^(\d{5})(?:-\d{4})?$/);
    if (z) out.zip = z[1];
  }
  return out;
}
