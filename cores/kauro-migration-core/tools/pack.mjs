#!/usr/bin/env node
/**
 * The package tarball, the same bytes on every machine.
 *
 * `npm pack` decides which files a package carries, and its answer is the one
 * a consumer's `npm install` agrees with, so it is asked. What it does not
 * decide reproducibly is the container: it copies each file's mode from the
 * checkout, so a checkout made under umask 027 packs members as 0640 where one
 * made under 022 packs 0644, and the gzip stream is whatever the zlib linked
 * into that Node writes. The same commit, built to byte-identical `dist/`,
 * therefore packed to two different tarballs on two hosts — which is how a
 * candidate of this repository was once refused as "not reproducible from the
 * commit" with equal dist digests on both sides.
 *
 * So the file list comes from `npm pack --dry-run --json`, the bytes come from
 * the checkout, and the container is written here: POSIX ustar, members under
 * `package/` in code-unit order, mode 0644, uid and gid 0, no owner names,
 * mtime fixed, no directory entries; compressed by fflate (a pinned, pure
 * JavaScript deflate, so no platform zlib is involved) at level 9 with a zero
 * gzip mtime. Two checkouts of one commit produce one tarball.
 *
 *   node tools/pack.mjs [--out <dir>]      write <name>-<version>.tgz, print its identity as JSON
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'fflate';

export const PACK_FORMAT_VERSION = '1.0.0';

/** npm's own fixed member time, 1985-10-26T08:15:00Z, kept so the tarball reads like any npm tarball. */
const MEMBER_MTIME = 499162500;

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function npmInvocation() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli], shell: false };
  return { command: 'npm', prefix: [], shell: process.platform === 'win32' };
}

/**
 * What npm would put in the package, by path, as npm reports it.
 *
 * @param {string} root the package directory
 * @returns {{name: string, version: string, filename: string, paths: string[]}}
 */
export function packList(root = defaultRoot) {
  const npm = npmInvocation();
  const listed = spawnSync(npm.command, [...npm.prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: npm.shell,
  });
  if (listed.status !== 0) throw new Error(`npm pack --dry-run exited ${String(listed.status)}: ${String(listed.stderr ?? '').trim().slice(-300)}`);
  const report = JSON.parse(listed.stdout)[0];
  if (report === undefined || !Array.isArray(report.files)) throw new Error('npm pack --dry-run reported no file list');
  const paths = report.files.map((file) => String(file.path).split('\\').join('/'));
  return { name: String(report.name), version: String(report.version), filename: String(report.filename), paths };
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/**
 * A ustar archive of `files`, each `{path, bytes}`, sorted by code units.
 *
 * @param {Array<{path: string, bytes: Buffer}>} files
 * @param {{mtime?: number}} [options]
 * @returns {Buffer}
 */
export function writeTar(files, options = {}) {
  const mtime = options.mtime ?? 0;
  const blocks = [];
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].path === sorted[index - 1].path) throw new Error(`${sorted[index].path} is listed twice`);
  }
  for (const file of sorted) {
    const header = Buffer.alloc(512, 0);
    let name = file.path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 100);
      if (cut === -1 || Buffer.byteLength(name.slice(cut + 1)) > 100 || Buffer.byteLength(name.slice(0, cut)) > 155) {
        throw new Error(`${name} does not fit a ustar header`);
      }
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    header.write(name, 0, 100, 'utf8');
    header.write(octal(0o644, 8), 100, 8, 'utf8');
    header.write(octal(0, 8), 108, 8, 'utf8');
    header.write(octal(0, 8), 116, 8, 'utf8');
    header.write(octal(file.bytes.length, 12), 124, 12, 'utf8');
    header.write(octal(mtime, 12), 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    header.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, file.bytes, Buffer.alloc((512 - (file.bytes.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** Gzip with no platform in it: fflate, level 9, gzip mtime 0 (the header's OS byte is fflate's constant). */
export function gzipDeterministic(bytes) {
  return Buffer.from(gzipSync(bytes, { level: 9, mtime: 0 }));
}

/** A gzip'd ustar archive of `files`, identical for identical input on every host. */
export function writeTarGz(files, options = {}) {
  return gzipDeterministic(writeTar(files, options));
}

/**
 * Pack the package at `root` into `outDir`.
 *
 * @returns {{filename: string, path: string, bytes: number, sha256: string, integrity: string, entryCount: number, packFormatVersion: string}}
 */
export function packPackage({ root = defaultRoot, outDir }) {
  const list = packList(root);
  const files = list.paths.map((path) => ({ path: `package/${path}`, bytes: readFileSync(join(root, ...path.split('/'))) }));
  const tarball = writeTarGz(files, { mtime: MEMBER_MTIME });
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, list.filename);
  writeFileSync(path, tarball);
  return {
    filename: list.filename,
    path,
    bytes: tarball.length,
    sha256: createHash('sha256').update(tarball).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
    entryCount: files.length,
    packFormatVersion: PACK_FORMAT_VERSION,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  const unknown = args.filter((arg, index) => !(arg === '--out' || (at !== -1 && index === at + 1)));
  if (unknown.length > 0 || (at !== -1 && args[at + 1] === undefined)) {
    process.stderr.write('usage: node tools/pack.mjs [--out <dir>]\n');
    process.exit(64);
  }
  const outDir = resolve(at === -1 ? process.cwd() : args[at + 1]);
  const packed = packPackage({ root: defaultRoot, outDir });
  process.stdout.write(`${JSON.stringify(packed, null, 2)}\n`);
}
