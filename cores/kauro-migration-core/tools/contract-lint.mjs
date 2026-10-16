#!/usr/bin/env node
// Contract lint.
//
// This repository deliberately does not carry a general style linter. What it
// enforces instead are the rules that would actually make the engine unsafe:
// escape hatches out of the type system, non-determinism, silent failure,
// hidden network dependencies and unused reason codes.
//
// Most rules map to a clause of docs/CONTRACT.md; `no-legacy-names` and
// `no-model-sdk` map to the clean-room constraint instead. Only `src/` is
// scanned: a harness in `tools/` or `test/` legitimately needs the wall clock
// and randomness that the engine may not have.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];

function walk(directory, extensions) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute, extensions));
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(absolute);
  }
  return found;
}

const rel = (file) => relative(repoRoot, file).split(sep).join('/');

const SOURCE_RULES = [
  { name: 'no-any', pattern: /(:\s*any\b|\bas\s+any\b|<any>|Array<any>)/, message: 'the "any" type defeats the contracts the engine relies on' },
  { name: 'no-ts-suppression', pattern: /@ts-(ignore|expect-error|nocheck)/, message: 'suppressing a type error hides a real contract violation' },
  { name: 'no-todo', pattern: /\b(TODO|FIXME|XXX|HACK)\b/, message: 'unfinished work must not sit in the critical path' },
  { name: 'no-random', pattern: /Math\.random\s*\(/, message: 'randomness would break determinism' },
  { name: 'no-wall-clock', pattern: /(Date\.now\s*\(|new\s+Date\s*\(\s*\))/, message: 'reading the clock would make artifacts differ between runs' },
  { name: 'no-console', pattern: /\bconsole\.(log|info|warn|error|debug)\s*\(/, message: 'write to process.stdout or process.stderr explicitly' },
  { name: 'no-network', pattern: /\b(fetch\s*\(|require\s*\(\s*['"]https?|from\s+['"]node:(http|https|net|dgram|tls))/, message: 'the core runs offline' },
  { name: 'no-env', pattern: /process\.env/, message: 'behaviour comes from the configuration file, never from the environment' },
  { name: 'no-legacy-names', pattern: /\b(FORGE|PORTER|AEGIS)\b/, message: 'clean-room rule: no inherited product branding' },
  { name: 'no-model-sdk', pattern: /['"](openai|@anthropic-ai\/|@google\/gener|langchain|cohere-ai|ollama|@huggingface)/, message: 'this phase is deterministic only' },
  { name: 'no-empty-catch', pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/, message: 'an empty catch swallows a failure the caller needed to see' },
  { name: 'no-fail-open-array', pattern: /catch\s*(\([^)]*\))?\s*\{\s*return\s*\[\s*\]\s*;?\s*\}/, message: 'returning an empty result on error is fail-open behaviour' },
];

const sourceFiles = walk(join(repoRoot, 'src'), ['.ts']);
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const rule of SOURCE_RULES) {
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
      if (rule.pattern.test(line)) {
        problems.push(`${rel(file)}:${index + 1} [${rule.name}] ${rule.message}\n    ${line.trim()}`);
      }
    });
  }
  if (!text.endsWith('\n')) problems.push(`${rel(file)} [trailing-newline] file does not end with a newline`);
  if (text.includes('\r\n')) problems.push(`${rel(file)} [line-endings] file contains CRLF, which would change artifact bytes between platforms`);
  if (text.includes(String.fromCharCode(0))) {
    problems.push(`${rel(file)} [control-characters] file contains a NUL byte`);
  }
}

// Every reason code in the registry must be reachable. A code nobody emits is
// either dead or a behaviour that was never implemented.
const registryPath = join(repoRoot, 'src', 'domain', 'reason-codes.ts');
const registryText = readFileSync(registryPath, 'utf8');
const codes = [...registryText.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\{$/gm)].map((match) => match[1]);
if (codes.length === 0) problems.push('src/domain/reason-codes.ts [registry] no reason codes were found');

const otherSources = sourceFiles.filter((file) => file !== registryPath).map((file) => readFileSync(file, 'utf8')).join('\n');
for (const code of codes) {
  if (!otherSources.includes(code)) {
    problems.push(`src/domain/reason-codes.ts [unused-reason-code] ${code} is registered but never emitted`);
  }
}

// The CLI must not be importable as a side-effect-free module by mistake.
const cliText = readFileSync(join(repoRoot, 'src', 'cli', 'main.ts'), 'utf8');
if (!cliText.startsWith('#!/usr/bin/env node')) {
  problems.push('src/cli/main.ts [cli-shebang] the CLI entry point needs a shebang');
}

// package.json must keep the dependency surface small and pinned.
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
for (const [section, entries] of [['dependencies', pkg.dependencies ?? {}], ['devDependencies', pkg.devDependencies ?? {}]]) {
  for (const [name, range] of Object.entries(entries)) {
    if (!/^\d+\.\d+\.\d+$/.test(range)) {
      problems.push(`package.json [pinned-dependencies] ${section}.${name} is "${range}"; pin an exact version`);
    }
  }
}
if (Object.keys(pkg.dependencies ?? {}).length > 4) {
  problems.push('package.json [dependency-budget] more than four runtime dependencies; justify each one in docs/DECISIONS.md first');
}

if (problems.length > 0) {
  process.stderr.write(`contract lint found ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(
  `contract lint passed: ${sourceFiles.length} source files, ${codes.length} reason codes, ${SOURCE_RULES.length} rules\n`,
);
