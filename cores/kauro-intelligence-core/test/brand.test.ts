/**
 * Amendment A2: the product is Kauro and no file, identifier or text of this
 * tree carries the retired brand word. The one admitted exception is the
 * vendored Migration Core release itself: its npm name and its asset file name
 * are facts of an immutable release (`vendor/MANIFEST.json`), and they change
 * only when a renamed Migration Core release is vendored. The word is built
 * from its code points so that this file does not carry it either.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RETIRED = String.fromCodePoint(107, 97, 118, 111);
const ENTRIES = ['src', 'test', 'tools', 'docs', '.github', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', '.git']);

interface VendoredManifest { readonly name: string; readonly file: string }
interface LockEntry { readonly bin?: Readonly<Record<string, string>> }
const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8')) as VendoredManifest;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { readonly packages: Readonly<Record<string, LockEntry>> };
/**
 * The spellings of the vendored release's own identity — its npm name, its
 * asset file name and the executables its package.json declares, as the
 * lockfile copies them; nothing else may carry the word.
 */
const RELEASE_FACTS = [manifest.name, basename(manifest.file), ...Object.keys(lock.packages[`node_modules/${manifest.name}`]?.bin ?? {})];

const files: string[] = [];
const walk = (path: string): void => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return;
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(basename(path))) return;
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else files.push(path);
};
for (const entry of ENTRIES) walk(join(root, entry));

/** Every occurrence of the retired word in `text` that is not inside a release fact. */
const strayOccurrences = (text: string): number[] => {
  const lower = text.toLowerCase();
  const covered = new Set<number>();
  for (const fact of RELEASE_FACTS) {
    const needle = fact.toLowerCase();
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      for (let offset = lower.indexOf(RETIRED, at); offset !== -1 && offset < at + needle.length; offset = lower.indexOf(RETIRED, offset + 1)) covered.add(offset);
    }
  }
  const stray: number[] = [];
  for (let at = lower.indexOf(RETIRED); at !== -1; at = lower.indexOf(RETIRED, at + 1)) if (!covered.has(at)) stray.push(at);
  return stray;
};

describe('BRAND-A2: the retired brand word', () => {
  it('BRAND-A2: no file of the tree carries the retired brand word outside the vendored Migration Core release identity', () => {
    assert.ok(files.length > 50, `the walk found the tree (${String(files.length)} files)`);
    const findings: string[] = [];
    for (const file of files) {
      const path = relative(root, file).split(sep).join('/');
      if (strayOccurrences(path).length > 0) findings.push(`${path}: file name`);
      if (path.endsWith('.tgz')) continue;
      const text = readFileSync(file, 'utf8');
      for (const at of strayOccurrences(text)) {
        const line = text.slice(0, at).split('\n').length;
        findings.push(`${path}:${String(line)}`);
      }
    }
    assert.deepEqual(findings, [], `retired brand word found:\n${findings.join('\n')}`);
  });

  it('BRAND-A2: the package, its description and the prompt role name Kauro Intelligence Core', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; description: string };
    assert.equal(pkg.name, 'kauro-intelligence-core');
    assert.match(pkg.description, /^Kauro Intelligence Core\b/u);
    const gateway = readFileSync(join(root, 'src', 'gateway', 'model-gateway.ts'), 'utf8');
    assert.match(gateway, /semantic interpreter of Kauro Intelligence Core\./u);
  });
});
