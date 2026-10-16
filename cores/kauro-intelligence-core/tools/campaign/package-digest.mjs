// The content digest of a packed npm package (validity v4, mandate 4.5, S044): sha256 over the sorted list of every regular file the
// `npm pack` tarball carries, each as its path and the sha256 of its bytes. The tarball's own sha256 also carries file modes, which
// differ for the same tree between a checkout on NTFS read through WSL (0700) and a native one (0644); the content digest does not, so
// one tree is one package wherever it is packed, and one changed byte is another package.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (block, start, length) => { const raw = block.subarray(start, start + length); const end = raw.indexOf(0); return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8'); };
const octal = (block, start, length) => { const value = text(block, start, length).trim(); return value === '' ? 0 : Number.parseInt(value, 8); };

/** Every regular file of a gzip'd tar (ustar, with pax extended headers), as { path, sha256 }. Anything it cannot read throws. */
export function filesOfTarball(path) {
  const tar = gunzipSync(readFileSync(path));
  const files = [];
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error(`${path}: truncated tar entry`);
    const prefix = text(header, 345, 155);
    const name = paxPath ?? (prefix === '' ? text(header, 0, 100) : `${prefix}/${text(header, 0, 100)}`);
    if (type === 'x') {
      // A pax record: "<len> path=<value>\n"; only the path of the next entry is read from it.
      const found = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'));
      paxPath = found === null ? null : (found[1] ?? null);
    } else {
      if (type === '0' || type === '\0') files.push({ path: name, sha256: sha256(body) });
      else if (type !== '5' && type !== 'g') throw new Error(`${path}: tar entry ${name} of type ${type} is not a file or a directory`);
      paxPath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The content digest of a packed package: path and file sha256 of every file, sorted, digested. */
export function packageDigestOfTarball(path) {
  const files = filesOfTarball(path);
  if (files.length === 0) throw new Error(`${path}: the tarball carries no file`);
  return sha256(files.map((file) => `${file.sha256}  ${file.path}\n`).join(''));
}

/** `npm pack` of a directory into a destination directory; the path of the one tarball it wrote. */
export function packTree(dir, destination) {
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', destination], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
  if (packed.status !== 0) throw new Error(`npm pack exited ${String(packed.status)}: ${String(packed.stderr).slice(-400)}`);
  const tarballs = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`npm pack left ${String(tarballs.length)} tarballs in ${destination}`);
  return join(destination, tarballs[0]);
}

/** The sha256 of a file's bytes (the Migration Core release tarball is bound by its own bytes: it is the published asset). */
export const fileSha256 = (path) => sha256(readFileSync(path));
