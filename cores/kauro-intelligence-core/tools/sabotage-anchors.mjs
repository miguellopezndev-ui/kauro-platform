#!/usr/bin/env node
/**
 * SABOTAGE-ANCHORS — the cheap half of the sabotage run: every inventory mutation's `from` text is in its file
 * exactly once, and its `to` text differs from it. A mutation whose text moved is NOT_REACHED in the full run,
 * which fails the run after hours of compute; this answers the same question in a second, before any shard starts.
 *
 *   node tools/sabotage-anchors.mjs            check the tree's inventory; exit 1 on any problem
 *   node tools/sabotage-anchors.mjs --json     machine output
 *
 * It decides nothing about kills: a mutation that passes here can still survive the suite.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInventory } from './lib/verify-sabotage-report.mjs';

export function anchorProblems(mutations, readFile, inventoryFileCount = null) {
  const problems = [];
  // An empty inventory proves nothing: zero anchors checked must never read as PASS.
  if (inventoryFileCount === 0) problems.push('no inventory files were discovered');
  if (mutations.length === 0) problems.push('no mutations in the inventory (zero anchors checked)');
  const cache = new Map();
  for (const mutation of mutations) {
    if (!cache.has(mutation.file)) cache.set(mutation.file, readFile(mutation.file));
    const text = cache.get(mutation.file);
    if (text === null) { problems.push(`${mutation.id}: ${mutation.file} does not exist`); continue; }
    if (typeof mutation.from !== 'string' || mutation.from === '') { problems.push(`${mutation.id}: empty from`); continue; }
    if (mutation.from === mutation.to) problems.push(`${mutation.id}: to equals from, the mutation changes nothing`);
    const count = text.split(mutation.from).length - 1;
    if (count === 0) problems.push(`${mutation.id}: the text to mutate is not in ${mutation.file} (stale anchor)`);
    else if (count > 1) problems.push(`${mutation.id}: the text to mutate occurs ${String(count)} times in ${mutation.file}`);
  }
  return problems;
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const inventory = await loadInventory(root);
  const read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
  const problems = anchorProblems(inventory.mutations, read, inventory.files.length);
  const result = { gate: 'SABOTAGE-ANCHORS', mutations: inventory.mutations.length, problems, ok: problems.length === 0 };
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const problem of problems) process.stderr.write(`  STALE  ${problem}\n`);
    process.stderr.write(`SABOTAGE-ANCHORS = ${result.ok ? 'PASS' : 'FAIL'} (${String(inventory.mutations.length)} mutations, ${String(problems.length)} problem(s))\n`);
  }
  process.exit(result.ok ? 0 : 1);
}
