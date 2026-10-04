// Node resolve hook for the engine tests: the engine imports its own files without an extension (as Next.js
// does), so try "<specifier>.ts" when a relative import does not resolve as written, and map the CRM's "@/"
// alias to src/.
const SRC = new URL('../../../', import.meta.url); // roofing-crm/src/

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) specifier = new URL(specifier.slice(2), SRC).href;
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:');
    if (relative && !/\.[cm]?[jt]s$/.test(specifier)) return next(specifier + '.ts', context);
    throw err;
  }
}
