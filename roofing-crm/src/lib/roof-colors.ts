/**
 * Owens Corning TruDefinition(R) Duration(R) shingle palette used by the
 * Shingle Color Visualizer (/visualizer).
 *
 * Each entry pairs a color with a photoreal render of the SAME house, where the
 * only thing that changes between renders is the shingle color. The renders were
 * produced with Higgsfield image generation and verified so that nothing below
 * the roofline differs between colors.
 *
 * IMPORTANT for whoever maintains this:
 *  - `swatch` is sampled from the roof pixels of the render, so the chips in the
 *    UI match what the customer sees on the house rather than a hand-picked hex.
 *  - The renders are visual approximations, not certified color samples. Color
 *    availability also varies by region. Always close with a physical sample
 *    board / OC's current color chart.
 *  - To swap a render, replace `image` below. To host the images locally instead
 *    of from the Higgsfield CDN, run `npm run fetch:roof-images` (see
 *    scripts/fetch-roof-images.mjs) and point `image` at `/roof-colors/<id>.jpg`.
 */

export type ShingleFamily = 'black' | 'gray' | 'brown' | 'tan' | 'statement';

export type ShingleCollection = 'Duration' | 'Duration Designer';

export interface RoofColor {
  /** URL-safe id, also the filename stem when images are vendored locally. */
  id: string;
  name: string;
  collection: ShingleCollection;
  family: ShingleFamily;
  /** Average roof color sampled from the render. Used for the swatch chip. */
  swatch: string;
  /** How the granule blend reads on a roof. */
  blend: string;
  /** Exterior colors this shingle tends to sell well against. */
  pairsWith: string;
  /** Full-house render, 2528x1696. */
  image: string;
}

export const FAMILY_LABELS: Record<ShingleFamily, string> = {
  black: 'Blacks',
  gray: 'Grays & Slates',
  brown: 'Browns',
  tan: 'Tans & Neutrals',
  statement: 'Statement Colors',
};

/** Order the families appear in the UI. */
export const FAMILY_ORDER: ShingleFamily[] = ['black', 'gray', 'tan', 'brown', 'statement'];

const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_3HPXNchsr6yo6j5Wl0pyjFwASXk';

export const ROOF_COLORS: RoofColor[] = [
  {
    id: 'onyx-black',
    name: 'Onyx Black',
    collection: 'Duration',
    family: 'black',
    swatch: '#545458',
    blend: 'Deep near-black charcoal with blue-black and graphite granules and strong shadow bands.',
    pairsWith: 'White, light gray, or blue siding. The safest high-contrast choice on almost any home.',
    image: `${CDN}/hf_20260815_224348_8bb5fdc2-4221-4b6f-aa90-7ab532c69052.png`,
  },
  {
    id: 'black-sable',
    name: 'Black Sable',
    collection: 'Duration Designer',
    family: 'black',
    swatch: '#6a5d57',
    blend: 'Blackish-brown sable blend of espresso and near-black granules — warmer than a true black.',
    pairsWith: 'Warm stone, tan stucco, and brick. Reads black from the street with a brown undertone up close.',
    image: `${CDN}/hf_20260815_223953_285f03fe-e478-4758-a2ee-0e105f303109.png`,
  },
  {
    id: 'estate-gray',
    name: 'Estate Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#6c6a6b',
    blend: 'Dark charcoal gray with lighter silver-gray streaking and near-black shadow bands.',
    pairsWith: 'White, light gray, sage, and blue siding. The most-requested gray in the line.',
    image: `${CDN}/hf_20260815_224347_bf168835-ae6c-4a31-b471-e0c93be15525.png`,
  },
  {
    id: 'quarry-gray',
    name: 'Quarry Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#939392',
    blend: 'Cool mid-tone stone gray blended from dove gray, stone and darker slate granules.',
    pairsWith: 'White trim with gray, white, or cool-toned siding. Lighter alternative to Estate Gray.',
    image: `${CDN}/hf_20260815_224347_e07d7383-a321-41c2-be49-293b0dbc9705.png`,
  },
  {
    id: 'colonial-slate',
    name: 'Colonial Slate',
    collection: 'Duration',
    family: 'gray',
    swatch: '#74777b',
    blend: 'Blue-gray slate blend of charcoal, steel and lighter ash granules with real depth.',
    pairsWith: 'Blue, gray, and white exteriors. Gives an asphalt roof a natural slate look.',
    image: `${CDN}/hf_20260815_223928_dc39f148-567f-4b9a-a88e-c445c8abe4d2.png`,
  },
  {
    id: 'pacific-wave',
    name: 'Pacific Wave',
    collection: 'Duration Designer',
    family: 'gray',
    swatch: '#6b757d',
    blend: 'Deep ocean blue-slate with silver-blue highlights — clearly blue-toned, not neutral.',
    pairsWith: 'Coastal homes with white, gray, or navy siding.',
    image: `${CDN}/hf_20260815_224347_524191ff-b9f7-467f-96b9-df0173be9013.png`,
  },
  {
    id: 'sierra-gray',
    name: 'Sierra Gray',
    collection: 'Duration',
    family: 'gray',
    swatch: '#938980',
    blend: 'Warm gray-taupe with pewter and soft brown tones. Low contrast, easy to live with.',
    pairsWith: 'Tan, cream, and warm stucco exteriors that fight a cool gray roof.',
    image: `${CDN}/hf_20260815_224347_caa6329e-a7da-4bcb-901f-0436eb88a105.png`,
  },
  {
    id: 'antique-silver',
    name: 'Antique Silver',
    collection: 'Duration',
    family: 'gray',
    swatch: '#aeadae',
    blend: 'Light silver gray with pale ash highlights and scattered darker charcoal granules.',
    pairsWith: 'Darker siding — navy, charcoal, deep green — where a light roof lifts the whole elevation.',
    image: `${CDN}/hf_20260815_223928_b283b99d-a7a1-44a7-b027-17a290ff9e96.png`,
  },
  {
    id: 'shasta-white',
    name: 'Shasta White',
    collection: 'Duration',
    family: 'tan',
    swatch: '#bab2ae',
    blend: 'The brightest shingle in the line — soft white and pale gray with a faint beige cast.',
    pairsWith: 'Hot-climate homes and darker siding. The lightest roof Duration offers.',
    image: `${CDN}/hf_20260815_223928_c6243a97-1660-4323-8733-e33c931b00cf.png`,
  },
  {
    id: 'sand-dune',
    name: 'Sand Dune',
    collection: 'Duration',
    family: 'tan',
    swatch: '#b5a59a',
    blend: 'Soft sandy beige of pale tan, light warm gray and cream granules. Very low contrast.',
    pairsWith: 'Coastal and Mediterranean stucco in white, cream, or soft pastel.',
    image: `${CDN}/hf_20260815_223928_0b600a34-9f11-43e8-9c57-9a94ca83e12b.png`,
  },
  {
    id: 'desert-tan',
    name: 'Desert Tan',
    collection: 'Duration',
    family: 'tan',
    swatch: '#b19580',
    blend: 'Warm tan blend of caramel, sandy beige and cream with soft golden-brown streaking.',
    pairsWith: 'Cream, tan, and terracotta stucco. A staple on Florida and Southwest homes.',
    image: `${CDN}/hf_20260815_223406_1e60dea1-b60f-4135-993f-30696987a107.png`,
  },
  {
    id: 'driftwood',
    name: 'Driftwood',
    collection: 'Duration',
    family: 'tan',
    swatch: '#91847c',
    blend: 'Weathered gray-brown: taupe and soft beige through warm gray, sun-bleached looking.',
    pairsWith: 'Almost anything. The go-to when the homeowner cannot decide between gray and brown.',
    image: `${CDN}/hf_20260815_224348_7dd9fce2-11db-412a-8069-7a4828a36e93.png`,
  },
  {
    id: 'amber',
    name: 'Amber',
    collection: 'Duration',
    family: 'brown',
    swatch: '#ad886d',
    blend: 'Warm golden brown of amber, honey, chestnut and tan granules with rich streaking.',
    pairsWith: 'Cream, tan, and earth-tone siding with stone or brick accents.',
    image: `${CDN}/hf_20260815_223928_57d67303-098f-4f2b-ad9d-5bdcc7352498.png`,
  },
  {
    id: 'summer-harvest',
    name: 'Summer Harvest',
    collection: 'Duration Designer',
    family: 'brown',
    swatch: '#ae8a6e',
    blend: 'Multi-tonal golden wheat, amber brown and soft tan with pronounced streaking.',
    pairsWith: 'Warm stucco and stone. More movement in the blend than Amber.',
    image: `${CDN}/hf_20260815_223953_f357f5cf-cfb9-4276-a533-b80d0851d2cb.png`,
  },
  {
    id: 'brownwood',
    name: 'Brownwood',
    collection: 'Duration',
    family: 'brown',
    swatch: '#816c5f',
    blend: 'Medium chocolate brown with warm tan highlights and darker coffee streaking.',
    pairsWith: 'Tan, cream, and brick exteriors. The classic brown roof.',
    image: `${CDN}/hf_20260815_223928_f9142d15-2b7a-4363-8551-e72ed4624b73.png`,
  },
  {
    id: 'teak',
    name: 'Teak',
    collection: 'Duration',
    family: 'brown',
    swatch: '#705e56',
    blend: 'Deep warm brown of dark coffee, chestnut and reddish-brown granules.',
    pairsWith: 'Light stucco and stone where a dark roof is wanted without going black.',
    image: `${CDN}/hf_20260815_223928_caa4f9f3-ab74-4164-9713-8351d4eb7555.png`,
  },
  {
    id: 'sedona-canyon',
    name: 'Sedona Canyon',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#997363',
    blend: 'Red-brown, rust orange, tan and deep brown with dramatic canyon streaking.',
    pairsWith: 'Southwest and Mediterranean elevations, especially with stone accents.',
    image: `${CDN}/hf_20260815_223953_62fb5fc6-dee6-4899-a14f-ee8c09aa7abe.png`,
  },
  {
    id: 'terra-cotta',
    name: 'Terra Cotta',
    collection: 'Duration',
    family: 'statement',
    swatch: '#a0725f',
    blend: 'Earthy brick red-brown of clay orange, terracotta and deep brown granules.',
    pairsWith: 'Stucco homes replacing a tile roof, where the clay look needs to carry over.',
    image: `${CDN}/hf_20260815_223928_0c4a9dac-ad0d-40f8-bf26-e425d64c3663.png`,
  },
  {
    id: 'merlot',
    name: 'Merlot',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#735351',
    blend: 'Deep wine red of burgundy, dark red-brown and near-black granules.',
    pairsWith: 'White, cream, and gray siding on traditional elevations. A true statement roof.',
    image: `${CDN}/hf_20260815_224347_75ffaa41-9505-4121-8055-cc749ab0f292.png`,
  },
  {
    id: 'chateau-green',
    name: 'Chateau Green',
    collection: 'Duration',
    family: 'statement',
    swatch: '#626d5e',
    blend: 'Deep forest green with dark green-black shadow bands and muted moss highlights.',
    pairsWith: 'Cream, tan, and white siding on wooded lots.',
    image: `${CDN}/hf_20260815_224347_d5b35260-e550-4bc9-946d-34fef89aea09.png`,
  },
  {
    id: 'aged-copper',
    name: 'Aged Copper',
    collection: 'Duration Designer',
    family: 'statement',
    swatch: '#7c867d',
    blend: 'Verdigris copper-patina green with weathered sage and dark charcoal granules.',
    pairsWith: 'Homes with copper or bronze metalwork, and warm neutral siding.',
    image: `${CDN}/hf_20260815_224347_4d65866d-56ee-4153-bffb-79939a6d55ed.png`,
  },
];

export const DEFAULT_COLOR_ID = 'estate-gray';

export function getRoofColor(id: string): RoofColor | undefined {
  return ROOF_COLORS.find((c) => c.id === id);
}
