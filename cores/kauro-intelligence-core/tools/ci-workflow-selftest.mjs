#!/usr/bin/env node
/**
 * Parse the workflow's job fields and evaluate its actual Actions expressions.
 * This uses the workflow's indentation/scalar subset and the expression grammar
 * below, without adding a dependency to the kernel's fixed lockfile budget.
 * A full YAML parse is also part of the local verification of CI changes.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { jobRuns } from './ci-local.mjs';

const yaml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

// Parse mapping scalars at a given indentation, including folded block scalars.
function fields(block, indent) {
  const result = {};
  const lines = block.split('\n');
  const key = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*(.*?)\\s*$`, 'u');
  for (let i = 0; i < lines.length; i += 1) {
    const match = key.exec(lines[i]);
    if (match === null) continue;
    let value = match[2];
    if (/^[>|]-?$/u.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].startsWith(' '.repeat(indent + 1)))) parts.push(lines[++i].trim());
      value = parts.join(' ').trim();
    }
    assert.ok(!(match[1] in result), `duplicate mapping key ${match[1]}`);
    result[match[1]] = value;
  }
  return result;
}
function jobBlock(id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:|^\\S|(?![\\s\\S]))`, 'mu').exec(yaml);
  assert.ok(match, `missing job ${id}`);
  return match[1];
}
const jobs = Object.fromEntries([...yaml.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gmu)].filter((match) => match.index > yaml.indexOf('\njobs:\n')).map((match) => [match[1], fields(jobBlock(match[1]), 4)]));

// Actions expressions use operand-returning && / ||. Parse into an AST before
// evaluating, so every alternative is parsed and short-circuiting is preserved.
function expression(source, context) {
  source = source.trim().replace(/^\$\{\{\s*|\s*\}\}$/gu, '');
  const tokens = [];
  const token = /\s*(('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_.*-]*)|([0-9]+)|(&&|\|\||==|!=|[(),!]))/yu;
  let pos = 0;
  while (pos < source.length) {
    token.lastIndex = pos;
    const match = token.exec(source);
    assert.ok(match, `unsupported expression near ${source.slice(pos)}`);
    tokens.push(match[1]);
    pos = token.lastIndex;
  }
  let next = 0;
  const take = (value) => tokens[next] === value && (++next > 0);
  const primary = () => {
    if (take('!')) return ['!', primary()];
    if (take('(')) { const node = binary(0); assert.ok(take(')'), 'expected )'); return node; }
    const value = tokens[next++];
    assert.ok(value, 'expected an operand');
    if (value.startsWith("'")) return ['literal', value.slice(1, -1).replace(/''/gu, "'")];
    if (/^[0-9]+$/u.test(value)) return ['literal', Number(value)];
    if (['true', 'false', 'null'].includes(value)) return ['literal', JSON.parse(value)];
    if (take('(')) {
      const args = [];
      if (!take(')')) {
        do { args.push(binary(0)); } while (take(','));
        assert.ok(take(')'), 'expected ) after function arguments');
      }
      return ['call', value, args];
    }
    return ['path', value];
  };
  const levels = [['||'], ['&&'], ['==', '!=']];
  const binary = (level) => {
    if (level === levels.length) return primary();
    let node = binary(level + 1);
    while (levels[level].includes(tokens[next])) { const op = tokens[next++]; node = [op, node, binary(level + 1)]; }
    return node;
  };
  const ast = binary(0);
  assert.equal(next, tokens.length, 'unconsumed expression tokens');
  const path = (value, parts) => parts.length === 0 ? value : parts[0] === '*' ? (value ?? []).map((item) => path(item, parts.slice(1))) : path(value?.[parts[0]], parts.slice(1));
  const functions = {
    always: () => true,
    fromJSON: JSON.parse,
    contains: (array, value) => (array ?? []).includes(value),
    format: (template, ...values) => template.replace(/\{(\d+)\}/gu, (_, index) => String(values[Number(index)])),
  };
  const evaluate = ([op, a, b]) => {
    if (op === 'literal') return a;
    if (op === 'path') return path(context, a.split('.'));
    if (op === 'call') { assert.ok(functions[a], `unsupported function ${a}`); return functions[a](...b.map(evaluate)); }
    if (op === '!') return !evaluate(a);
    if (op === '&&') return evaluate(a) && evaluate(b);
    if (op === '||') return evaluate(a) || evaluate(b);
    if (op === '==') return evaluate(a) === evaluate(b);
    if (op === '!=') return evaluate(a) !== evaluate(b);
    assert.fail(`unknown operator ${op}`);
  };
  return evaluate(ast);
}
function context(event, { runner = 'self-hosted', fork = false, requested = true, reused = false, sha = 'a'.repeat(40), runId = 1 } = {}) {
  return {
    vars: { SABOTAGE_RUNNER: runner }, inputs: { sabotage: requested },
    needs: { 'sabotage-reuse': { outputs: { reused: String(reused) } } },
    github: { event_name: event, workflow: 'intelligence gate', repository: 'owner/repo', sha,
      ref: event === 'pull_request' ? 'refs/pull/1/merge' : event === 'push' ? 'refs/heads/main' : 'refs/heads/candidate', run_id: runId,
      event: { repository: { default_branch: 'main' }, pull_request: { labels: requested ? [{ name: 'run-sabotage' }] : [], head: { sha, repo: { full_name: fork ? 'fork/repo' : 'owner/repo' } } } } },
  };
}
const policyEnv = fields(jobBlock('sabotage-runner-policy'), 10);
const trusted = (ctx) => expression(policyEnv.TRUSTED, ctx);
const requested = (ctx) => expression(policyEnv.REQUESTED, ctx);

test('self-hosted selection has no hosted shard path for any event, trust, request or reuse state', () => {
  for (const event of ['push', 'workflow_dispatch', 'pull_request', 'unknown']) for (const fork of [false, true]) for (const ask of [false, true]) for (const reused of [false, true]) {
    const ctx = context(event, { fork, requested: ask, reused });
    const selected = expression(jobs['sabotage-shard']['runs-on'], ctx);
    assert.deepEqual(selected, ['self-hosted', 'linux', 'kauro-sabotage']);
    assert.equal(expression(jobs['sabotage-shard']['timeout-minutes'], ctx), 45);
    assert.equal(trusted(ctx), ['push', 'workflow_dispatch'].includes(event) || (event === 'pull_request' && !fork));
  }
  const ctx = context('pull_request', { runner: '' });
  assert.equal(expression(jobs['sabotage-shard']['runs-on'], ctx), 'ubuntu-24.04');
  assert.equal(expression(jobs['sabotage-shard']['timeout-minutes'], ctx), 120);
});

test('ineligible requests fail the policy job before shards or PR checkout', () => {
  assert.ok(jobs['sabotage-shard'].needs.includes('sabotage-runner-policy'));
  assert.equal(jobs['sabotage-shard'].if.includes('always()'), false, 'needs success must gate scheduling');
  assert.equal(jobBlock('sabotage-runner-policy').includes('uses:'), false);
  const scripts = jobRuns(yaml, 'sabotage-runner-policy');
  assert.equal(scripts.length, 1);
  const work = mkdtempSync(join(tmpdir(), 'ic-runner-policy-'));
  try {
    for (const event of ['push', 'workflow_dispatch', 'pull_request']) for (const fork of [false, true]) for (const ask of [false, true]) for (const runner of ['', 'self-hosted']) {
      const ctx = context(event, { fork, requested: ask, runner });
      const env = { ...process.env, GITHUB_STEP_SUMMARY: join(work, 'summary'), RUNNER_KIND: runner, REQUESTED: String(requested(ctx)), TRUSTED: String(trusted(ctx)) };
      const result = spawnSync('bash', ['-e', '-c', scripts[0]], { env, encoding: 'utf8' });
      assert.equal(result.error, undefined, 'the guard must actually execute');
      const rejected = runner === 'self-hosted' && requested(ctx) && !trusted(ctx);
      assert.equal(result.status, rejected ? 1 : 0, `${event} fork=${fork} request=${ask} runner=${runner}`);
      if (rejected) assert.match(result.stdout + result.stderr, /use workflow_dispatch/u);
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('the self-test runs in a cheap job and every hosted single job is pinned', () => {
  assert.ok(jobRuns(yaml, 'sabotage-selftest').includes('node tools/ci-workflow-selftest.mjs'));
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'gate' || id === 'sabotage-shard') continue;
    assert.equal(job['runs-on'], 'ubuntu-24.04', id);
  }
  assert.match(jobBlock('gate'), /os: \[ubuntu-latest, windows-latest\]/u);
  assert.equal(jobs.gate.name, 'gate (${{ matrix.os }}, node 24)');
});

test('requested concurrency is bound to the head and cannot be cancelled or replace a pending request', () => {
  const block = /^concurrency:\n([\s\S]*?)(?=^jobs:)/mu.exec(yaml)?.[1];
  assert.ok(block);
  const concurrency = fields(block, 2);
  for (const event of ['push', 'workflow_dispatch', 'pull_request']) {
    const first = context(event, { runId: 11 });
    const another = context(event, { runId: 12 });
    const newer = context(event, { sha: 'b'.repeat(40), runId: 13 });
    const key = expression(concurrency.group, first);
    assert.ok(key.includes('a'.repeat(40)), key);
    assert.notEqual(key, expression(concurrency.group, another), 'pending requests must not share a slot');
    assert.notEqual(key, expression(concurrency.group, newer));
    assert.equal(expression(concurrency['cancel-in-progress'], first), false);
    const cheap = context(event, { requested: false });
    if (!requested(cheap)) assert.notEqual(key, expression(concurrency.group, cheap), 'cheap events cannot replace requests');
  }
  const cheap = context('pull_request', { requested: false });
  const newerCheap = context('pull_request', { requested: false, sha: 'b'.repeat(40) });
  assert.equal(expression(concurrency.group, cheap), expression(concurrency.group, newerCheap));
  assert.equal(expression(concurrency['cancel-in-progress'], newerCheap), true);
});

test('every PR head event runs required checks; only label, dispatch or main push requests shards', () => {
  assert.match(yaml, /push:\n {4}branches: \[main\]/u);
  assert.match(yaml, /pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review\]/u);
  assert.match(yaml, /workflow_dispatch:\n {4}inputs:\n {6}sabotage:/u);
  for (const id of ['gate', 'dependencies', 'sabotage-anchors', 'sabotage-selftest', 'architecture-selftest', 'sabotage-request', 'sabotage-reuse', 'sabotage-runner-policy']) assert.equal(jobs[id].if, undefined, id);
  assert.equal(jobs.sabotage.name, 'sabotage (INTELLIGENCE-SABOTAGE-01)');
  assert.equal(jobs.architecture.name, 'architecture closure (INTELLIGENCE-ARCHITECTURE-01)');
  const work = mkdtempSync(join(tmpdir(), 'ic-required-checks-'));
  try {
    for (const event of ['push', 'workflow_dispatch', 'pull_request', 'unknown']) for (const ask of [true, false]) for (const reused of [true, false]) {
      const ctx = context(event, { requested: ask, reused });
      const want = event === 'push' || (['workflow_dispatch', 'pull_request'].includes(event) && ask);
      assert.equal(requested(ctx), want, `${event} requested=${ask}`);
      assert.equal(expression(jobs['sabotage-shard'].if, ctx), want && !reused);
      for (const job of ['sabotage', 'architecture']) {
        assert.equal(jobs[job].if, 'always()');
        assert.equal(expression(jobs[job].if, ctx), true);
        // Run the actual first step. No request must exit 1, before checkout.
        const envFields = fields(jobBlock(job).split('      - name:')[1], 10);
        assert.equal(expression(envFields.REQUESTED, ctx), String(want));
        const guard = jobRuns(yaml, job)[0];
        const result = spawnSync('bash', ['-e', '-c', guard], { env: { ...process.env, REQUESTED: String(want), GITHUB_STEP_SUMMARY: join(work, 'summary') }, encoding: 'utf8' });
        assert.equal(result.error, undefined, 'the request guard must actually execute');
        assert.equal(result.status, want ? 0 : 1);
        if (!want) assert.match(result.stdout + result.stderr, /NOT REQUESTED/u);
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
});
