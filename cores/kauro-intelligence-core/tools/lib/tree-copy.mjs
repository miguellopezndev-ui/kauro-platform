/**
 * A disposable copy of this tree with a git subject of its own.
 *
 * The self-tests and the chain rehearsal need a checkout they can dirty,
 * recommit and break without touching the real one. The copy carries the
 * working files (not the history), links node_modules by junction so nothing
 * is reinstalled, and is committed once so that `git rev-parse HEAD` in it
 * answers with a real, clean subject. Everything about that subject says
 * REHEARSAL or SELFTEST; it is never the subject CI decides on.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TREE_ENTRIES = Object.freeze(['src', 'test', 'tools', 'vendor', 'docs', 'corpus', '.github', 'package.json', 'package-lock.json', 'tsconfig.json', '.npmrc', '.gitignore', 'README.md', 'LICENSE']);

/** git with a fixed identity and no signing: the commit exists to be hashed, not to be trusted. */
export function git(cwd, args) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'kauro-selftest', GIT_AUTHOR_EMAIL: 'selftest@kauro.invalid', GIT_COMMITTER_NAME: 'kauro-selftest', GIT_COMMITTER_EMAIL: 'selftest@kauro.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${String(result.status)}: ${(result.stderr || result.stdout).trim().slice(-400)}`);
  return result.stdout.trim();
}

export function linkNodeModules(root, dest) {
  spawnSync(process.platform === 'win32' ? 'cmd' : 'ln', process.platform === 'win32' ? ['/c', 'mklink', '/J', join(dest, 'node_modules'), join(root, 'node_modules')] : ['-s', join(root, 'node_modules'), join(dest, 'node_modules')], { encoding: 'utf8' });
  if (!existsSync(join(dest, 'node_modules', 'typescript'))) throw new Error(`could not link node_modules into ${dest}`);
}

/** Copies the tree to dest, links node_modules, commits once; returns the copy's subject. */
export function copyTree(root, dest, label) {
  rmSync(dest, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(dest, { recursive: true });
  for (const entry of TREE_ENTRIES) if (existsSync(join(root, entry))) cpSync(join(root, entry), join(dest, entry), { recursive: true });
  // The copy's own tmp/ and dist/ must never come from the source.
  rmSync(join(dest, 'tmp'), { recursive: true, force: true });
  linkNodeModules(root, dest);
  writeFileSync(join(dest, 'SUBJECT_LABEL'), `${label}\n`);
  git(dest, ['init', '-q']);
  git(dest, ['add', '-A']);
  git(dest, ['commit', '-q', '-m', `${label} copy of the tree`]);
  return { dest, commit: git(dest, ['rev-parse', 'HEAD']), tree: git(dest, ['rev-parse', 'HEAD^{tree}']) };
}

/** Removes the copy; the junction goes with it and the real node_modules stays. */
export function removeTree(dest) {
  rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return !existsSync(dest);
}
