import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PACKAGE_DIGEST_VERSION, packageDigest } from '../../src/artifacts/package-digest.js';
import { sha256Hex } from '../../src/util/hash.js';

/**
 * The canonical package digest.
 *
 * It exists so something outside this engine can attest to a package: a
 * signature over this number names exactly one set of bytes. That is only worth
 * anything if the number is reproducible from the directory alone and moves
 * when any byte or any path moves.
 */

function fixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kauro-digest-'));
  for (const [path, text] of Object.entries(files)) {
    const parts = path.split('/');
    if (parts.length > 1) mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...parts), Buffer.from(text, 'utf8'));
  }
  return dir;
}

describe('the canonical package digest names one set of bytes', () => {
  it('is the digest of the documented text, and nothing else', () => {
    const dir = fixture({ 'manifest.json': '{}\n', 'a.csv': 'x\n' });
    try {
      const computed = packageDigest(dir);
      const expected = sha256Hex(
        `${PACKAGE_DIGEST_VERSION}\n` +
          `a.csv ${sha256Hex(readFileSync(join(dir, 'a.csv')))}\n` +
          `manifest.json ${sha256Hex(readFileSync(join(dir, 'manifest.json')))}\n`,
      );
      assert.equal(computed.digest, expected);
      assert.equal(computed.fileCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is the same number computed twice', () => {
    const dir = fixture({ 'manifest.json': '{}\n', 'b/c.csv': 'y\n' });
    try {
      assert.equal(packageDigest(dir).digest, packageDigest(dir).digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves when a byte moves', () => {
    const one = fixture({ 'manifest.json': '{}\n', 'a.csv': 'x\n' });
    const two = fixture({ 'manifest.json': '{}\n', 'a.csv': 'y\n' });
    try {
      assert.notEqual(packageDigest(one).digest, packageDigest(two).digest);
    } finally {
      rmSync(one, { recursive: true, force: true });
      rmSync(two, { recursive: true, force: true });
    }
  });

  it('moves when a path moves, even with the same bytes', () => {
    // Otherwise a package could be reshuffled without the digest noticing.
    const one = fixture({ 'manifest.json': '{}\n', 'a.csv': 'x\n' });
    const two = fixture({ 'manifest.json': '{}\n', 'b.csv': 'x\n' });
    try {
      assert.notEqual(packageDigest(one).digest, packageDigest(two).digest);
    } finally {
      rmSync(one, { recursive: true, force: true });
      rmSync(two, { recursive: true, force: true });
    }
  });

  it('covers the manifest as well as the artifacts it lists', () => {
    const one = fixture({ 'manifest.json': '{"a":1}\n', 'a.csv': 'x\n' });
    const two = fixture({ 'manifest.json': '{"a":2}\n', 'a.csv': 'x\n' });
    try {
      assert.notEqual(packageDigest(one).digest, packageDigest(two).digest);
    } finally {
      rmSync(one, { recursive: true, force: true });
      rmSync(two, { recursive: true, force: true });
    }
  });
});
