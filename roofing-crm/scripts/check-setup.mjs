#!/usr/bin/env node
/**
 * Prove the CRM is ready for n8n, and name the exact thing that is wrong when
 * it is not.
 *
 * Usage:
 *   npm run check:setup                        # against http://localhost:3000
 *   npm run check:setup -- https://your-host   # against a deployment
 *
 * Reads SOCIAL_AUTOMATION_KEY from the environment. On a deployment that is the
 * same string you put in n8n's "DR CRM Automation Key" credential.
 */

const base = (process.argv[2] ?? process.env.CRM_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const key = process.env.SOCIAL_AUTOMATION_KEY ?? '';

let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`  \x1b[32mok\x1b[0m    ${msg}`);
const fail = (msg, detail) => {
  failures += 1;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}`);
  if (detail) console.log(`        ${detail}`);
};
const warn = (msg, detail) => {
  warnings += 1;
  console.log(`  \x1b[33mwarn\x1b[0m  ${msg}`);
  if (detail) console.log(`        ${detail}`);
};

async function req(path, { method = 'GET', body, withKey = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (withKey && key) headers['x-automation-key'] = key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON — status alone is the signal */
  }
  return { status: res.status, json };
}

console.log(`\nChecking ${base}\n`);

// 1. Reachable and configured -------------------------------------------------
let health;
try {
  health = await req('/api/health', { withKey: false });
} catch (err) {
  fail('CRM is not reachable', `${err.message}. Is it running, and is the URL right?`);
  console.log('\nNothing else can be checked until the CRM answers.\n');
  process.exit(1);
}

if (health.status !== 200) {
  fail(`/api/health returned ${health.status}`, 'Expected 200.');
} else {
  pass('CRM is reachable');
  const s = health.json?.social ?? {};
  if (s.automationKeySet) pass('SOCIAL_AUTOMATION_KEY is set on the server');
  else fail('SOCIAL_AUTOMATION_KEY is not set on the server', 'In production every automation endpoint returns 503.');

  if (s.licenseNumberSet) pass('DR_LICENSE_NUMBER is set');
  else fail('DR_LICENSE_NUMBER is not set', 'The compliance gate blocks every post without it.');

  for (const problem of health.json?.problems ?? []) {
    if (!/SOCIAL_AUTOMATION_KEY|DR_LICENSE_NUMBER is unset/.test(problem)) warn(problem);
  }
}

// 2. The key you hold matches the server's ------------------------------------
if (!key) {
  warn('SOCIAL_AUTOMATION_KEY is not set in this shell', 'Export it to check the key end to end.');
} else {
  const wrong = await fetch(`${base}/api/social/queue`, {
    headers: { 'x-automation-key': 'definitely-not-the-key' },
  });
  if (wrong.status === 401) pass('a wrong key is rejected with 401');
  else if (wrong.status === 503) fail('endpoints are disabled (503)', 'SOCIAL_AUTOMATION_KEY is unset on the server.');
  else warn(`a wrong key returned ${wrong.status}`, 'Expected 401.');

  const queue = await req('/api/social/queue');
  if (queue.status === 200) pass('your key is accepted — this is the value n8n needs');
  else if (queue.status === 401) fail('your key was rejected (401)', 'The key here differs from the one on the server.');
  else fail(`/api/social/queue returned ${queue.status}`);
}

// 3. The compliance gate actually blocks --------------------------------------
const blocked = await req('/api/social/compliance-check', {
  method: 'POST',
  body: { platform: 'facebook', caption: 'We waive your deductible!', hasImage: true },
});
if (blocked.status !== 200) {
  fail(`compliance-check returned ${blocked.status}`, 'Expected 200 with a verdict in the body.');
} else if (blocked.json?.status === 'blocked') {
  pass('deductible-waiver caption is blocked');
} else {
  fail(`deductible-waiver caption was NOT blocked (got "${blocked.json?.status}")`,
       'This is the rule that carries a $10,000-per-violation penalty. Do not publish until it blocks.');
}

const clean = await req('/api/social/compliance-check', {
  method: 'POST',
  body: {
    platform: 'facebook',
    caption: 'We replaced a wind-damaged roof in Orange Park this week.',
    hasImage: true,
  },
});
if (clean.status === 200 && clean.json?.status === 'pass') {
  pass('an ordinary caption passes');
} else if (clean.status === 200 && clean.json?.status === 'blocked') {
  const codes = (clean.json.findings ?? []).map((f) => f.code).join(', ');
  fail(`an ordinary caption was blocked (${codes})`,
       codes.includes('LICENSE_MISSING') ? 'Set DR_LICENSE_NUMBER.' : 'Unexpected — check the findings.');
} else if (clean.status === 200) {
  warn(`an ordinary caption came back "${clean.json?.status}"`);
}

// ---------------------------------------------------------------------------
console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} check(s) failed\x1b[0m${warnings ? `, ${warnings} warning(s)` : ''}. Fix the failures before pointing n8n at this.\n`);
  process.exit(1);
}
console.log(`\x1b[32mAll checks passed\x1b[0m${warnings ? ` (${warnings} warning(s))` : ''}. Point n8n's Config node at ${base}\n`);
