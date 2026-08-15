#!/usr/bin/env node
/**
 * Vendors the shingle color renders used by /visualizer into public/roof-colors
 * so the app stops depending on the Higgsfield CDN at request time.
 *
 *   npm run fetch:roof-images
 *
 * Then point `image` in src/lib/roof-colors.ts at `/roof-colors/<id>.jpg`
 * (pass --rewrite to have this script do that edit for you) and drop the
 * `images.remotePatterns` entry from next.config.ts.
 *
 * Requires `sharp` for downscaling; without it the originals are saved as-is
 * (they are ~8 MB PNGs each, so installing sharp is strongly recommended:
 * `npm i -D sharp`).
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'roof-colors');
const SOURCE = join(ROOT, 'src', 'lib', 'roof-colors.ts');
const WIDTH = 1600;
const QUALITY = 82;

async function loadPalette() {
  const src = await readFile(SOURCE, 'utf8');
  const cdn = src.match(/const CDN = '([^']+)'/)?.[1];
  if (!cdn) throw new Error('Could not find the CDN constant in roof-colors.ts');

  const entries = [];
  const re = /id: '([^']+)',[\s\S]*?image: `\$\{CDN\}\/([^`]+)`/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    entries.push({ id: match[1], url: `${cdn}/${match[2]}` });
  }
  if (!entries.length) throw new Error('No colors found in roof-colors.ts');
  return entries;
}

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    console.warn('! sharp is not installed — saving full-size originals instead.');
    console.warn('  Install it with `npm i -D sharp` and re-run for much smaller files.\n');
    return null;
  }
}

async function main() {
  const [palette, sharp] = await Promise.all([loadPalette(), loadSharp()]);
  await mkdir(OUT_DIR, { recursive: true });

  for (const { id, url } of palette) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${id}: ${res.status} ${res.statusText} for ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    if (sharp) {
      const out = join(OUT_DIR, `${id}.jpg`);
      await sharp(buffer).resize({ width: WIDTH }).jpeg({ quality: QUALITY }).toFile(out);
      console.log(`✓ ${id}.jpg`);
    } else {
      await writeFile(join(OUT_DIR, `${id}.png`), buffer);
      console.log(`✓ ${id}.png (full size)`);
    }
  }

  if (process.argv.includes('--rewrite')) {
    const ext = sharp ? 'jpg' : 'png';
    let result = await readFile(SOURCE, 'utf8');
    for (const { id } of palette) {
      result = result.replace(
        new RegExp(`(id: '${id}',[\\s\\S]*?image: )\`\\$\\{CDN\\}/[^\`]+\``),
        `$1'/roof-colors/${id}.${ext}'`,
      );
    }
    await writeFile(SOURCE, result);
    console.log('\n✓ Rewrote src/lib/roof-colors.ts to use local paths.');
    console.log('  Remember to drop images.remotePatterns from next.config.ts.');
  }

  console.log(`\nDone — ${palette.length} renders in public/roof-colors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
