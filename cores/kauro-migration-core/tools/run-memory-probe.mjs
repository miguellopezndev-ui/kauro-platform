#!/usr/bin/env node
/**
 * Does a run's memory scale with the size of its source?
 *
 * Run as a fresh process with a heap smaller than the source it is asked to
 * migrate. An engine that decodes the bundle, keeps a draft per row and holds
 * the records it resolves needs memory proportional to the input; one that
 * reads a row, writes down what it needs and lets the row go needs a buffer.
 * The first dies, the second finishes, and there is nothing to interpret about
 * which happened.
 *
 * Not a benchmark and reports no number. It answers one question with an exit
 * code, which is what makes it immune to the noise that makes a memory
 * measurement argue with itself.
 *
 *   node --max-old-space-size=<mib> tools/run-memory-probe.mjs <inputDir> <configPath> <scratchRoot>
 *
 * Exit 0: the migration completed inside the heap it was given.
 * Exit 1: it failed for a reason that is not memory.
 * Any other exit, or a signal: it could not work in that heap.
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../dist/src/mapping/load-config.js';
import { runMigration } from '../dist/src/run/run-migration.js';
import { createFilesystemScratchStore } from '../dist/src/scratch/filesystem-scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../dist/src/domain/resource-profile.js';

const [inputDir, configPath, scratchRoot] = process.argv.slice(2);
if (inputDir === undefined || configPath === undefined || scratchRoot === undefined) {
  process.stderr.write('usage: run-memory-probe.mjs <inputDir> <configPath> <scratchRoot>\n');
  process.exit(64);
}

const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
const scratch = createFilesystemScratchStore({
  root: scratchRoot,
  runId: 'probe',
  quotaBytes: SCRATCH_BUDGET_BYTES,
});

try {
  const result = runMigration({
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
    scratch,
  });
  if (!result.reconciliation.sourceRows.equationHolds) {
    process.stderr.write('the run completed but its rows do not reconcile\n');
    process.exit(1);
  }
  process.stderr.write(`migrated ${String(result.reconciliation.sourceRows.total)} rows\n`);
  process.exit(0);
} finally {
  scratch.dispose();
}
