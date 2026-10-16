import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { repoRoot, scratchDir } from '../support/harness.js';

/**
 * The package tarball is the same bytes on every host (tools/pack.mjs).
 *
 * A candidate was once refused as not reproducible from its commit although
 * both sides built byte-identical dist/: `npm pack` copied member modes from
 * the checkout (0640 under umask 027, 0644 under 022). The packer takes npm's
 * file list and writes the container itself.
 */

interface Packed {
  readonly filename: string;
  readonly path: string;
  readonly sha256: string;
  readonly entryCount: number;
}
interface Packer {
  packPackage(input: { root: string; outDir: string }): Packed;
  writeTarGz(files: { path: string; bytes: Buffer }[], options?: { mtime?: number }): Buffer;
}

const packer = async (): Promise<Packer> => (await import(pathToFileURL(join(repoRoot(), 'tools', 'pack.mjs')).href)) as Packer;

/** Every member of a gzip'd ustar archive: name, mode, uid, gid, mtime, bytes. */
function members(gz: Buffer): { name: string; mode: number; uid: number; gid: number; mtime: number; type: string; bytes: Buffer }[] {
  const tar = gunzipSync(gz);
  const out = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
    const size = parseInt(field(124, 12).trim(), 8);
    const prefix = field(345, 155);
    const name = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    out.push({
      name,
      mode: parseInt(field(100, 8).trim(), 8),
      uid: parseInt(field(108, 8).trim(), 8),
      gid: parseInt(field(116, 8).trim(), 8),
      mtime: parseInt(field(136, 12).trim(), 8),
      type: field(156, 1),
      bytes: Buffer.from(tar.subarray(offset + 512, offset + 512 + size)),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('the package tarball is reproducible', () => {
  it('two packs of one tree are byte-identical', async () => {
    const { packPackage } = await packer();
    const first = packPackage({ root: repoRoot(), outDir: scratchDir('pack', 'first') });
    const second = packPackage({ root: repoRoot(), outDir: scratchDir('pack', 'second') });
    assert.equal(first.sha256, second.sha256);
    assert.equal(sha(readFileSync(first.path)), first.sha256);
  });

  it('carries no host in its container: mode 0644, uid and gid 0, a fixed mtime, gzip mtime 0 and OS byte 3', async () => {
    const { packPackage } = await packer();
    const packed = packPackage({ root: repoRoot(), outDir: scratchDir('pack', 'container') });
    const gz = readFileSync(packed.path);
    assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0], 'gzip mtime');
    assert.equal(gz[9], 3, 'gzip OS byte');
    const listed = members(gz);
    assert.equal(listed.length, packed.entryCount);
    for (const member of listed) {
      assert.ok(member.name.startsWith('package/'), member.name);
      assert.equal(member.type, '0', member.name);
      assert.equal(member.mode, 0o644, member.name);
      assert.equal(member.uid, 0);
      assert.equal(member.gid, 0);
      assert.equal(member.mtime, 499162500);
    }
    const names = listed.map((member) => member.name);
    assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'members in code-unit order');
  });

  it('carries exactly the files and bytes `npm pack` would', async () => {
    const { packPackage } = await packer();
    const ours = packPackage({ root: repoRoot(), outDir: scratchDir('pack', 'ours') });
    const theirsDir = scratchDir('pack', 'npm');
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npm = existsSync(cli)
      ? spawnSync(process.execPath, [cli, 'pack', '--ignore-scripts', '--pack-destination', theirsDir], { cwd: repoRoot(), encoding: 'utf8' })
      : spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', theirsDir], { cwd: repoRoot(), encoding: 'utf8', shell: process.platform === 'win32' });
    assert.equal(npm.status, 0, npm.stderr);
    const inventory = (path: string): string[] =>
      members(readFileSync(path))
        .filter((member) => member.type === '0' || member.type === '')
        .map((member) => `${member.name} ${sha(member.bytes)}`)
        .sort();
    assert.deepEqual(inventory(ours.path), inventory(join(theirsDir, ours.filename)));
  });

  it('is independent of the order and the modes it was handed', async () => {
    const { writeTarGz } = await packer();
    const files = [
      { path: 'package/b.txt', bytes: Buffer.from('b') },
      { path: 'package/a.txt', bytes: Buffer.from('a') },
    ];
    assert.equal(sha(writeTarGz(files)), sha(writeTarGz([...files].reverse())));
  });
});
