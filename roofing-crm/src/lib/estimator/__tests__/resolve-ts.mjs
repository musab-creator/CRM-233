// Module resolve hook so the estimator's TypeScript runs directly under
// `node --experimental-strip-types`: maps the "@/..." alias to src/ and adds
// the ".ts" (or "/index.ts") extension the bundler resolution leaves off.
// Test files register it before dynamically importing the code under test.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = new URL('../../../', import.meta.url); // roofing-crm/src/

function withExtension(url) {
  const path = fileURLToPath(url);
  if (existsSync(path) && statSync(path).isFile()) return url;
  for (const candidate of [path + '.ts', path + '.tsx', path + '/index.ts']) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return url;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    return { url: withExtension(new URL(specifier.slice(2), SRC).href), shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL).href;
    if (!/\.[cm]?[jt]sx?$/.test(specifier)) return { url: withExtension(url), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
