// Runs every engine test: node src/lib/roof-measure/__tests__/run.mjs  (from roofing-crm/)
// The parity tests need Playwright's Chromium and the original tool at /home/user/musab-creator/roof-measure.
// Set ROOFS=<n> to change the number of random roofs in the measurement parity test (default 400).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = ['geo', 'engine', 'parity-measure', 'parity-autotrace', 'parity-commercial', 'parity-permits'];
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(here, 'register.mjs'), path.join(here, `${t}.test.mjs`)], {
    stdio: 'inherit', env: { TZ: 'America/New_York', ...process.env },
  });
  if (r.status !== 0) failed++;
}
console.log(failed ? `${failed} test file(s) failed` : 'all test files passed');
process.exitCode = failed ? 1 : 0;
