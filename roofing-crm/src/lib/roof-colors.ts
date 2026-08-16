/**
 * Owens Corning TruDefinition(R) Duration(R) palette for the Shingle Color
 * Visualizer (/visualizer).
 *
 * Each color carries a four-tone blend rather than one flat hex, because that
 * is how these shingles actually read on a roof: a base color with lighter and
 * darker granule tones streaked through it. The 3D roof material mixes these
 * four across the tabs, so the depth you see on screen comes from the same
 * mechanism as the depth on a real roof.
 *
 * MAINTAINER NOTES
 *  - These blends are careful approximations, not certified color data. Color
 *    availability also varies by region. Always close against a physical sample
 *    board and OC's current color chart.
 *  - To adjust a color, edit its palette here — the 3D view, the swatch chips
 *    and the detail panel all read from this one place.
 *  - `swatch` is what the UI chip shows. Keep it close to `base`.
 */

export type ShingleFamily = 'black' | 'gray' | 'brown' | 'tan' | 'statement';

export type ShingleCollection = 'Duration' | 'Duration Designer';

/** The four granule tones blended across the shingle tabs. */
export interface ShinglePalette {
  /** Dominant granule color. */
  base: string;
  /** Lighter blend tone, the highlight streaks. */
  light: string;
  /** Darker blend tone, the shadow streaks. */
  dark: string;
  /** Secondary character tone that gives the blend its cast. */
  accent: string;
}

export interface RoofColor {
  id: string;
  name: string;
  collection: ShingleCollection;
  family: ShingleFamily;
  /** Chip color in the UI. */
  swatch: string;
  palette: ShinglePalette;
  /** How the granule blend reads on a roof. */
  blend: string;
  /** Exterior colors this shingle tends to sell well against. */
  pairsWith: string;
}

export const FAMILY_LABELS: Record<ShingleFamily, string> = {
  black: 'Blacks',
  gray: 'Grays & Slates',
  brown: 'Browns',
  tan: 'Tans & Neutrals',
  statement: 'Statement Colors',
};

export const FAMILY_ORDER: ShingleFamily[] = ['black', 'gray', 'tan', 'brown', 'statement'];

export const ROOF_COLORS: RoofColor[] = [
  {
    id: 'onyx-black',
    name: 'Onyx Black',
    collection: 'Duration',
    family: 'black',
    swatch: '#2b2c31',
    palette: { base: '#2b2c31', light: '#4a4c54', dark: '#151619', accent: '#343640' },
    blend: 'Deep near-black charcoal with blue-black and graphite granules and hard shadow bands.',
    pairsWith: 'White, light gray, or blue siding. The safest high-contrast choice on almost any home.',
  },
  {
    id: 'black-sable',
    name: 'Black Sable',
    collection: 'Duration Designer',
    family: 'black',
    swatch: '#332f2a',
    palette: { base: '#332f2a', light: '#4f483f', dark: '#1c1a17', accent: '#3f382f' },
    blend: 'Blackish-brown sable of espresso and near-black granules — warmer than a true black.',
    pairsWith: 'Warm stone, tan stucco, and brick. Reads black from the street, brown up close.',
  },
  {
    id: 'estate-gray',
    name: 'Estate Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#54565b',
    palette: { base: '#54565b', light: '#7a7d84', dark: '#33353a', accent: '#63666d' },
    blend: 'Dark charcoal gray with silver-gray streaking and near-black shadow bands.',
    pairsWith: 'White, light gray, sage, and blue siding. The most-requested gray in the line.',
  },
  {
    id: 'quarry-gray',
    name: 'Quarry Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#7c7f83',
    palette: { base: '#7c7f83', light: '#9fa3a8', dark: '#5a5d61', accent: '#8b8f95' },
    blend: 'Cool mid-tone stone gray of dove, stone and darker slate granules.',
    pairsWith: 'White trim with gray, white, or cool-toned siding. Lighter than Estate Gray.',
  },
  {
    id: 'colonial-slate',
    name: 'Colonial Slate',
    collection: 'Duration',
    family: 'gray',
    swatch: '#565e67',
    palette: { base: '#565e67', light: '#79838f', dark: '#373d45', accent: '#64707d' },
    blend: 'Blue-gray slate of charcoal, steel and lighter ash granules with real depth.',
    pairsWith: 'Blue, gray, and white exteriors. Gives an asphalt roof a natural slate look.',
  },
  {
    id: 'pacific-wave',
    name: 'Pacific Wave',
    collection: 'Duration Designer',
    family: 'gray',
    swatch: '#485a69',
    palette: { base: '#485a69', light: '#6c8395', dark: '#2d3b47', accent: '#54707f' },
    blend: 'Deep ocean blue-slate with silver-blue highlights — clearly blue, not neutral.',
    pairsWith: 'Coastal homes with white, gray, or navy siding.',
  },
  {
    id: 'sierra-gray',
    name: 'Sierra Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#6e6760',
    palette: { base: '#6e6760', light: '#8f867d', dark: '#4c4741', accent: '#7d746a' },
    blend: 'Warm gray-taupe with pewter and soft brown tones. Low contrast, easy to live with.',
    pairsWith: 'Tan, cream, and warm stucco exteriors that fight a cool gray roof.',
  },
  {
    id: 'antique-silver',
    name: 'Antique Silver',
    collection: 'Duration',
    family: 'gray',
    swatch: '#8d9094',
    palette: { base: '#8d9094', light: '#b2b5b9', dark: '#686b70', accent: '#9ba0a6' },
    blend: 'Light silver gray with pale ash highlights and scattered darker charcoal granules.',
    pairsWith: 'Darker siding — navy, charcoal, deep green — where a light roof lifts the elevation.',
  },
  {
    id: 'shasta-white',
    name: 'Shasta White',
    collection: 'Duration',
    family: 'tan',
    swatch: '#b2afa7',
    palette: { base: '#b2afa7', light: '#d3d0c9', dark: '#8e8b84', accent: '#c0bcb2' },
    blend: 'The brightest shingle in the line — soft white and pale gray with a faint beige cast.',
    pairsWith: 'Hot-climate homes and darker siding. The lightest roof Duration offers.',
  },
  {
    id: 'sand-dune',
    name: 'Sand Dune',
    collection: 'Duration',
    family: 'tan',
    swatch: '#a2927e',
    palette: { base: '#a2927e', light: '#c4b6a2', dark: '#7c6f5e', accent: '#b0a189' },
    blend: 'Soft sandy beige of pale tan, light warm gray and cream granules. Very low contrast.',
    pairsWith: 'Coastal and Mediterranean stucco in white, cream, or soft pastel.',
  },
  {
    id: 'desert-tan',
    name: 'Desert Tan',
    collection: 'Duration',
    family: 'tan',
    swatch: '#9a7d5f',
    palette: { base: '#9a7d5f', light: '#bd9f7c', dark: '#725b42', accent: '#a98a63' },
    blend: 'Warm tan of caramel, sandy beige and cream with soft golden-brown streaking.',
    pairsWith: 'Cream, tan, and terracotta stucco. A staple on Florida and Southwest homes.',
  },
  {
    id: 'driftwood',
    name: 'Driftwood',
    collection: 'Duration',
    family: 'tan',
    swatch: '#7b7166',
    palette: { base: '#7b7166', light: '#9d9284', dark: '#57503f', accent: '#8a7d6b' },
    blend: 'Weathered gray-brown: taupe and soft beige through warm gray, sun-bleached looking.',
    pairsWith: 'Almost anything. The pick when the homeowner is torn between gray and brown.',
  },
  {
    id: 'amber',
    name: 'Amber',
    collection: 'Duration',
    family: 'brown',
    swatch: '#8a6743',
    palette: { base: '#8a6743', light: '#ae8757', dark: '#644930', accent: '#98713d' },
    blend: 'Warm golden brown of amber, honey, chestnut and tan granules with rich streaking.',
    pairsWith: 'Cream, tan, and earth-tone siding with stone or brick accents.',
  },
  {
    id: 'summer-harvest',
    name: 'Summer Harvest',
    collection: 'Duration Designer',
    family: 'brown',
    swatch: '#8e6c46',
    palette: { base: '#8e6c46', light: '#b8905d', dark: '#664d31', accent: '#a07a3f' },
    blend: 'Multi-tonal golden wheat, amber brown and soft tan with pronounced streaking.',
    pairsWith: 'Warm stucco and stone. More movement in the blend than Amber.',
  },
  {
    id: 'brownwood',
    name: 'Brownwood',
    collection: 'Duration',
    family: 'brown',
    swatch: '#664d3a',
    palette: { base: '#664d3a', light: '#8a6b51', dark: '#433325', accent: '#75593f' },
    blend: 'Medium chocolate brown with warm tan highlights and darker coffee streaking.',
    pairsWith: 'Tan, cream, and brick exteriors. The classic brown roof.',
  },
  {
    id: 'teak',
    name: 'Teak',
    collection: 'Duration',
    family: 'brown',
    swatch: '#4d3a2c',
    palette: { base: '#4d3a2c', light: '#6b5240', dark: '#31241b', accent: '#5b4231' },
    blend: 'Deep warm brown of dark coffee, chestnut and reddish-brown granules.',
    pairsWith: 'Light stucco and stone where a dark roof is wanted without going black.',
  },
  {
    id: 'sedona-canyon',
    name: 'Sedona Canyon',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#7a4a34',
    palette: { base: '#7a4a34', light: '#a4653f', dark: '#54321f', accent: '#8c5228' },
    blend: 'Red-brown, rust orange, tan and deep brown with dramatic canyon streaking.',
    pairsWith: 'Southwest and Mediterranean elevations, especially with stone accents.',
  },
  {
    id: 'terra-cotta',
    name: 'Terra Cotta',
    collection: 'Duration',
    family: 'statement',
    swatch: '#8a4a33',
    palette: { base: '#8a4a33', light: '#b06543', dark: '#5f3122', accent: '#9c5330' },
    blend: 'Earthy brick red-brown of clay orange, terracotta and deep brown granules.',
    pairsWith: 'Stucco homes replacing a tile roof, where the clay look needs to carry over.',
  },
  {
    id: 'merlot',
    name: 'Merlot',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#592c30',
    palette: { base: '#592c30', light: '#7c3f45', dark: '#3a1c1f', accent: '#68333a' },
    blend: 'Deep wine red of burgundy, dark red-brown and near-black granules.',
    pairsWith: 'White, cream, and gray siding on traditional elevations. A true statement roof.',
  },
  {
    id: 'chateau-green',
    name: 'Chateau Green',
    collection: 'Duration',
    family: 'statement',
    swatch: '#3b4a39',
    palette: { base: '#3b4a39', light: '#57694f', dark: '#242e23', accent: '#455641' },
    blend: 'Deep forest green with dark green-black shadow bands and muted moss highlights.',
    pairsWith: 'Cream, tan, and white siding on wooded lots.',
  },
  {
    id: 'aged-copper',
    name: 'Aged Copper',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#4d6357',
    palette: { base: '#4d6357', light: '#6e8a78', dark: '#33443b', accent: '#5a7565' },
    blend: 'Verdigris copper-patina green with weathered sage and dark charcoal granules.',
    pairsWith: 'Homes with copper or bronze metalwork, and warm neutral siding.',
  },
];

export const DEFAULT_COLOR_ID = 'estate-gray';

export function getRoofColor(id: string): RoofColor | undefined {
  return ROOF_COLORS.find((c) => c.id === id);
}
