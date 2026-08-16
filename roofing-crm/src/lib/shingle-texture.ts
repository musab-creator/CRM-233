import * as THREE from 'three';
import type { ShinglePalette } from './roof-colors';

/**
 * Draws an architectural laminate shingle surface into canvas textures.
 *
 * The layout (course lines, tab widths, granule speckle) is generated from a
 * fixed seed, so every color produces the identical shingle pattern and only the
 * color changes. That is the whole point of the tool: when the homeowner flips
 * between two colors, nothing moves except the color.
 *
 * Returns a color map plus a bump map. The bump map is what gives the roof its
 * dimensional look — laminate shingles read as a surface because of the shadow
 * line under each course butt, not because of the color.
 */

const TILE_PX = 1024;
/** Metres of roof covered by one texture tile. Drives how big shingles look. */
export const TILE_METRES = 2.2;
/** Exposed height of one course, in metres (~5 5/8" like a real laminate). */
const COURSE_M = 0.143;
/** Nominal tab width, in metres (~12"). */
const TAB_M = 0.3;

function mulberry32(seed: number) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = parseInt(hex.replace('#', ''), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function shade(c: Rgb, amount: number): Rgb {
  const target = amount > 0 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  return mix(c, target, Math.abs(amount));
}

function css({ r, g, b }: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

/** One laminate "tab": a rectangle of blend color within a course. */
interface Tab {
  x: number;
  width: number;
  tone: number;
  weathering: number;
}

interface Course {
  y: number;
  height: number;
  tabs: Tab[];
}

/**
 * The shingle layout, generated once and reused for every color so that the
 * pattern is identical across the whole palette.
 */
function buildLayout(): Course[] {
  const random = mulberry32(20260816);
  const courseHeight = (COURSE_M / TILE_METRES) * TILE_PX;
  const courses: Course[] = [];

  for (let y = -courseHeight; y < TILE_PX + courseHeight; y += courseHeight) {
    const tabs: Tab[] = [];
    const nominal = (TAB_M / TILE_METRES) * TILE_PX;
    // Stagger each course so butt joints never stack up, like a real roof.
    let x = -nominal * (0.35 + random() * 0.5);
    while (x < TILE_PX + nominal) {
      const width = nominal * (0.72 + random() * 0.62);
      tabs.push({
        x,
        width,
        tone: random(),
        weathering: random(),
      });
      x += width;
    }
    courses.push({ y, height: courseHeight, tabs });
  }
  return courses;
}

const LAYOUT = buildLayout();

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  return canvas;
}

function drawColor(palette: ShinglePalette): HTMLCanvasElement {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d')!;

  const base = hexToRgb(palette.base);
  const light = hexToRgb(palette.light);
  const dark = hexToRgb(palette.dark);
  const accent = hexToRgb(palette.accent);

  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  for (const course of LAYOUT) {
    for (const tab of course.tabs) {
      // Multi-tonal blend: most tabs sit near the base color, a minority carry
      // the lighter and darker blend tones that give Duration its depth.
      let tone: Rgb;
      if (tab.tone < 0.18) tone = mix(base, light, 0.55 + tab.weathering * 0.45);
      else if (tab.tone < 0.36) tone = mix(base, dark, 0.5 + tab.weathering * 0.4);
      else if (tab.tone < 0.5) tone = mix(base, accent, 0.45 + tab.weathering * 0.5);
      else tone = mix(base, tab.weathering > 0.5 ? light : dark, tab.weathering * 0.22);

      ctx.fillStyle = css(tone);
      ctx.fillRect(tab.x, course.y, tab.width + 0.6, course.height + 0.6);

      // Keyway between tabs — a narrow dark slot, not a hard line.
      ctx.fillStyle = css(shade(tone, -0.45));
      ctx.fillRect(tab.x, course.y, 1.6, course.height);
    }

    // Shadow line: the course above casts onto the top of this one. This is the
    // single strongest cue that a roof is dimensional shingle and not paint.
    const shadow = ctx.createLinearGradient(0, course.y, 0, course.y + course.height * 0.42);
    shadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.fillRect(0, course.y, TILE_PX, course.height * 0.42);

    // The thick laminate butt edge catches light along the bottom of the course.
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fillRect(0, course.y + course.height - 2, TILE_PX, 2);
  }

  // Granules. Per-pixel so it reads as mineral grit rather than digital noise.
  const image = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  const data = image.data;
  const random = mulberry32(99173);
  for (let i = 0; i < data.length; i += 4) {
    const n = (random() - 0.5) * 30;
    const warm = (random() - 0.5) * 8;
    data[i] = Math.max(0, Math.min(255, data[i] + n + warm));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + n - warm));
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}

function drawBump(): HTMLCanvasElement {
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  for (const course of LAYOUT) {
    // Recess under the overlying course, then a raised butt edge.
    const recess = ctx.createLinearGradient(0, course.y, 0, course.y + course.height * 0.4);
    recess.addColorStop(0, '#1c1c1c');
    recess.addColorStop(1, '#808080');
    ctx.fillStyle = recess;
    ctx.fillRect(0, course.y, TILE_PX, course.height * 0.4);

    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, course.y + course.height - 3, TILE_PX, 3);

    for (const tab of course.tabs) {
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(tab.x, course.y, 1.8, course.height);
      // Laminate overlay patches sit slightly proud of the base shingle.
      if (tab.tone > 0.55) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(tab.x + 2, course.y + course.height * 0.42, tab.width - 4, course.height * 0.5);
      }
    }
  }

  const image = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  const data = image.data;
  const random = mulberry32(4471);
  for (let i = 0; i < data.length; i += 4) {
    const n = (random() - 0.5) * 60;
    data[i] = Math.max(0, Math.min(255, data[i] + n));
    data[i + 1] = data[i];
    data[i + 2] = data[i];
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}

let bumpTexture: THREE.CanvasTexture | null = null;

function getBumpTexture(): THREE.CanvasTexture {
  if (!bumpTexture) {
    bumpTexture = new THREE.CanvasTexture(drawBump());
    bumpTexture.wrapS = THREE.RepeatWrapping;
    bumpTexture.wrapT = THREE.RepeatWrapping;
  }
  return bumpTexture;
}

/**
 * Builds the roof material for a color. The bump map is shared across colors —
 * only the color map is redrawn — so switching colors is instant.
 */
export function createShingleMaterial(palette: ShinglePalette): THREE.MeshStandardMaterial {
  const map = new THREE.CanvasTexture(drawColor(palette));
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;

  return new THREE.MeshStandardMaterial({
    map,
    bumpMap: getBumpTexture(),
    bumpScale: 1.15,
    roughness: 0.93,
    metalness: 0,
  });
}

/** Swaps the color map on an existing roof material, keeping UVs and bump. */
export function applyShingleColor(
  material: THREE.MeshStandardMaterial,
  palette: ShinglePalette,
) {
  const previous = material.map;
  const map = new THREE.CanvasTexture(drawColor(palette));
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;
  if (previous) {
    map.repeat.copy(previous.repeat);
    map.offset.copy(previous.offset);
  }
  material.map = map;
  material.needsUpdate = true;
  previous?.dispose();
}

/** Ridge and hip caps: same blend, tighter course spacing. */
export function createRidgeMaterial(palette: ShinglePalette): THREE.MeshStandardMaterial {
  const material = createShingleMaterial(palette);
  material.bumpScale = 0.9;
  return material;
}
