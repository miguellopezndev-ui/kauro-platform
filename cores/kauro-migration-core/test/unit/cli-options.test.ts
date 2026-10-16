import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/harness.js';

/**
 * The command line is strict.
 *
 * The parser used to accept any `--name value`, so a misspelt option ran the
 * command without it, a switch followed by a stray word took the word as a
 * value, and a repeated option silently kept the last one. Each of those is a
 * run that did something other than what was typed, and the operator found
 * out later or not at all. A command line this program does not understand
 * now exits with EX_USAGE (64), names every problem, and does nothing else.
 */

const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the command line refuses what it does not understand', () => {
  it('an unknown option', () => {
    const result = invoke('verify', '--package', 'x', '--bogus', 'y');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /unknown option --bogus/u);
    assert.match(result.stderr, /"code": "USAGE"/u);
  });

  it('a misspelt option is not silently dropped', () => {
    const result = invoke('run', '--input', '.', '--config', 'c.json', '--out', 'o', '--source-profil', 'p.json');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /unknown option --source-profil/u);
  });

  it('an option without a value', () => {
    const result = invoke('verify', '--package');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /--package needs a value/u);
  });

  it('a repeated option', () => {
    const result = invoke('verify', '--package', 'a', '--package', 'b');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /--package is given more than once/u);
  });

  it('a switch given a value, and a stray argument', () => {
    const result = invoke('run', '--input', '.', '--config', 'c.json', '--out', 'o', '--force=yes', 'stray');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /--force takes no value/u);
    assert.match(result.stderr, /unexpected argument "stray"/u);
  });

  it('a missing required option, reported together with the rest', () => {
    const result = invoke('run', '--input', '.');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /--config is required/u);
    assert.match(result.stderr, /--out is required/u);
  });

  it('an unknown command', () => {
    const result = invoke('frobnicate');
    assert.equal(result.status, 64);
    assert.match(result.stderr, /unknown command "frobnicate"/u);
  });

  it('accepts the documented forms, including --name=value', () => {
    // A digest of a directory that does not exist fails for its own reason,
    // not for a usage reason: the parser accepted the line.
    const result = invoke('digest', '--package=does-not-exist');
    assert.notEqual(result.status, 64);
    assert.doesNotMatch(result.stderr, /"code": "USAGE"/u);
  });
});
