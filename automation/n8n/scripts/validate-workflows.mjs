#!/usr/bin/env node
// Static checks on the exported workflow JSON. Catches the things that only
// surface as a red node in the n8n editor an hour after you imported it:
// dangling connections, duplicate node names, Code nodes that do not parse,
// and env vars referenced by a workflow but missing from .env.example.
//
//   node automation/n8n/scripts/validate-workflows.mjs

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowDir = join(here, '..', 'workflows');
const envExample = join(here, '..', '.env.example');

const problems = [];
const notes = [];

function fail(file, message) {
  problems.push(`${file}: ${message}`);
}

const declaredEnv = new Set(
  (await readFile(envExample, 'utf8'))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0].trim()),
);

const files = (await readdir(workflowDir)).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) fail('workflows/', 'no workflow files found');

for (const file of files) {
  const source = await readFile(join(workflowDir, file), 'utf8');

  let wf;
  try {
    wf = JSON.parse(source);
  } catch (error) {
    fail(file, `invalid JSON — ${error.message}`);
    continue;
  }

  if (!wf.name) fail(file, 'workflow has no name');
  if (!Array.isArray(wf.nodes)) {
    fail(file, 'workflow has no nodes array');
    continue;
  }

  // --- Node names are the addressing scheme for connections and $() lookups.
  const names = new Set();
  for (const node of wf.nodes) {
    if (!node.name) fail(file, `node ${node.id ?? '(no id)'} has no name`);
    if (names.has(node.name)) fail(file, `duplicate node name "${node.name}"`);
    names.add(node.name);
    if (!node.type) fail(file, `node "${node.name}" has no type`);
    if (!Array.isArray(node.position) || node.position.length !== 2) {
      fail(file, `node "${node.name}" has no valid position`);
    }
  }

  // --- Connections must point at nodes that exist, in both directions.
  for (const [from, outputs] of Object.entries(wf.connections ?? {})) {
    if (!names.has(from)) fail(file, `connection source "${from}" is not a node`);
    for (const branch of outputs.main ?? []) {
      for (const target of branch ?? []) {
        if (!names.has(target.node)) {
          fail(file, `"${from}" connects to "${target.node}", which is not a node`);
        }
      }
    }
  }

  // --- Every non-trigger node should be reachable.
  const reachable = new Set();
  const triggers = wf.nodes
    .filter((n) => /trigger|webhook/i.test(n.type))
    .map((n) => n.name);
  const queue = [...triggers];
  while (queue.length) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const branch of wf.connections?.[current]?.main ?? []) {
      for (const target of branch ?? []) queue.push(target.node);
    }
  }
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.stickyNote') continue;
    if (!reachable.has(node.name)) fail(file, `node "${node.name}" is unreachable from any trigger`);
  }

  // --- Code nodes: parse the JS so a stray brace is caught here, not at 9am
  //     on a Monday when the publisher runs.
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const code = node.parameters?.jsCode;
    if (!code) {
      fail(file, `code node "${node.name}" has no jsCode`);
      continue;
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function(code);
    } catch (error) {
      fail(file, `code node "${node.name}" does not parse — ${error.message}`);
    }
    for (const ref of code.matchAll(/\$\('([^']+)'\)/g)) {
      if (!names.has(ref[1])) {
        fail(file, `code node "${node.name}" references $('${ref[1]}'), which is not a node`);
      }
    }
  }

  // --- Referenced env vars must be documented.
  for (const ref of source.matchAll(/\$env\.([A-Z0-9_]+)/g)) {
    if (!declaredEnv.has(ref[1])) {
      fail(file, `references $env.${ref[1]}, which is missing from .env.example`);
    }
  }

  // --- Placeholders that must be filled in after import.
  const placeholders = [...source.matchAll(/REPLACE_WITH_[A-Z0-9_]+/g)].map((m) => m[0]);
  if (placeholders.length) {
    notes.push(`${file}: fill in after import — ${[...new Set(placeholders)].join(', ')}`);
  }
}

for (const note of notes) console.log(`note   ${note}`);

if (problems.length) {
  console.error('');
  for (const problem of problems) console.error(`FAIL   ${problem}`);
  console.error(`\n${problems.length} problem(s) in ${files.length} workflow(s).`);
  process.exit(1);
}

console.log(`\nOK — ${files.length} workflow(s) validated.`);
