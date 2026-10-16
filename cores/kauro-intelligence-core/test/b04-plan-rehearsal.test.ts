/**
 * B04 plan rehearsal: the pilot rehearsed through the owner's Claude subscription (`claude -p`), SIMULATED by construction.
 * The real CLI is never called here: a fake `claude` (a small node script, named by KAURO_PLAN_CLAUDE_CMD) records its argv and stdin.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const toolUrl = (name: string): string => pathToFileURL(join(root, 'tools', 'campaign', name)).href;

interface Seam { fetch: (url: string, init: { body: AsyncIterable<Uint8Array> }) => Promise<{ status: number; body: AsyncIterable<Uint8Array> }>; fidelityPath: string; logDir: string }
const seamModule = (await import(toolUrl('plan-seam.mjs'))) as { createPlanSeam: (options: Record<string, unknown>) => Seam; buildClaudeArgs: (body: unknown, model: string) => { args: string[]; stdin: string; gaps: string[] } };
const runnerModule = (await import(toolUrl('plan-rehearsal.mjs'))) as {
  rehearsalRefusals: (options: Record<string, unknown>) => { code: string; detail: string }[];
  runPlanRehearsal: (options: Record<string, unknown>) => Promise<{ ok: boolean; refusals: { code: string; detail: string }[]; outDir: string | null; evidence: string | null; fidelityPath: string | null; requests: number }>;
};
const auditModule = (await import(toolUrl('live-audit.mjs'))) as { auditLiveSuite: (suite: string, input: Record<string, unknown>) => { problems: string[] } };
const loaded = (await import(toolUrl('validity-run.mjs'))) as { loadCorpus: (dir: string) => { fixtures: { partition: string; fixture: { fixtureId: string } }[] } };

const work = mkdtempSync(join(tmpdir(), 'b04-plan-test-'));
after(() => { rmSync(work, { recursive: true, force: true }); });

const FAKE = join(work, 'fake-claude.mjs');
writeFileSync(FAKE, [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  "const stdin = readFileSync(0, 'utf8');",
  "appendFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify({ argv, stdin, cwd: process.cwd() }) + '\\n');",
  "const model = argv[argv.indexOf('--model') + 1];",
  "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{\"ok\":true}', structured_output: { ok: true }, usage: { input_tokens: 2, cache_creation_input_tokens: 900, cache_read_input_tokens: 10, output_tokens: 7 }, modelUsage: { [model]: {} } }));",
  '',
].join('\n'));
const capture = join(work, 'capture.jsonl');
process.env['FAKE_CLAUDE_CAPTURE'] = capture;
const fakeCommand = [process.execPath, FAKE];
const captured = (): { argv: string[]; stdin: string; cwd: string }[] => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { argv: string[]; stdin: string; cwd: string }) : []);

const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const bodyOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ anthropic_version: 'vertex-2023-10-16', max_tokens: 8192, system: 'SYSTEM PROMPT\nline two', messages: [{ role: 'user', content: 'the user turn' }], output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'high' }, tools: [], ...extra });
const urlOf = (model: string): string => `https://aiplatform.us.rep.googleapis.com/v1/projects/plan-rehearsal/locations/us/publishers/anthropic/models/${model}:rawPredict`;
const post = async (seam: Seam, url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
  const stream = (async function* () { yield Buffer.from(JSON.stringify(body)); })();
  const response = await seam.fetch(url, { body: stream });
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return { status: response.status, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> };
};

describe('B04 plan rehearsal: the seam builds the claude call', () => {
  it('passes the system prompt whole, disables every tool, MCP, setting source and session, maps the model, effort and schema, and sends the user turn on stdin from an empty cwd', async () => {
    const seam = seamModule.createPlanSeam({ command: fakeCommand, logDir: join(work, 'logs-a'), fidelityPath: join(work, 'fidelity-a.json') });
    const answered = await post(seam, urlOf('claude-opus-5-5'), bodyOf());
    assert.equal(answered.status, 200);
    const call = captured().slice(-1)[0];
    assert.ok(call !== undefined);
    const value = (flag: string): string | undefined => call.argv[call.argv.indexOf(flag) + 1];
    assert.equal(value('--system-prompt'), 'SYSTEM PROMPT\nline two');
    assert.equal(value('--tools'), '');
    assert.ok(call.argv.includes('--strict-mcp-config'));
    assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
    assert.equal(value('--setting-sources'), '');
    for (const flag of ['--no-session-persistence', '--exclude-dynamic-system-prompt-sections', '--disable-slash-commands', '-p']) assert.ok(call.argv.includes(flag), flag);
    assert.equal(value('--output-format'), 'json');
    assert.equal(value('--model'), 'claude-opus-5-5');
    assert.equal(value('--effort'), 'high');
    assert.deepEqual(JSON.parse(value('--json-schema') ?? 'null'), SCHEMA);
    assert.equal(call.stdin, 'the user turn');
    assert.ok(!call.argv.includes('--allowedTools') && !call.argv.includes('--dangerously-skip-permissions'));
    assert.ok(!call.cwd.startsWith(root) && !existsSync(call.cwd), 'an empty temporary cwd outside the repository, removed after the call');
    // The response is Vertex-shaped and prefixed; usage folds cache tokens into input (the gateway refuses cache fields).
    assert.match(answered.json['id'] as string, /^plan-rehearsal-/u);
    assert.equal(answered.json['model'], 'claude-opus-5-5');
    assert.deepEqual(answered.json['content'], [{ type: 'text', text: '{"ok":true}' }]);
    assert.deepEqual(answered.json['usage'], { input_tokens: 912, output_tokens: 7 });
    assert.ok(readdirSync(join(work, 'logs-a')).some((name) => name.startsWith('plan-rehearsal-')), 'the raw CLI JSON of each call is logged');
  });

  it('refuses a body it cannot carry (tools, several messages, a URL naming another model) with a 400, never silently', async () => {
    const seam = seamModule.createPlanSeam({ command: fakeCommand, logDir: join(work, 'logs-b'), fidelityPath: join(work, 'fidelity-b.json') });
    const before = captured().length;
    assert.equal((await post(seam, urlOf('claude-sonnet-5-5'), bodyOf({ tools: [{ name: 'x' }] }))).status, 400);
    assert.equal((await post(seam, urlOf('claude-sonnet-5-5'), bodyOf({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] }))).status, 400);
    assert.equal((await post(seam, urlOf('claude-haiku-5-5'), bodyOf())).status, 400);
    assert.equal(captured().length, before, 'the CLI was not called for any of them');
  });

  it('writes the fidelity record beside the run: SIMULATED, not qualification, max_tokens requested versus observed, and every standing gap', async () => {
    const path = join(work, 'fidelity-c.json');
    const seam = seamModule.createPlanSeam({ command: fakeCommand, logDir: join(work, 'logs-c'), fidelityPath: path });
    await post(seam, urlOf('claude-sonnet-5-5'), bodyOf({ max_tokens: 4096 }));
    const fidelity = JSON.parse(readFileSync(path, 'utf8')) as { evidence: string; countsAsQualification: boolean; requests: number; requested: { maxTokens: number[]; models: string[] }; observed: { servedModels: string[]; maxOutputTokens: number; overMaxTokens: number }; standingGaps: { member: string }[] };
    assert.equal(fidelity.evidence, 'SIMULATED');
    assert.equal(fidelity.countsAsQualification, false);
    assert.equal(fidelity.requests, 1);
    assert.deepEqual(fidelity.requested, { maxTokens: [4096], models: ['claude-sonnet-5-5'] });
    assert.deepEqual(fidelity.observed, { servedModels: ['claude-sonnet-5-5'], maxOutputTokens: 7, overMaxTokens: 0 });
    for (const member of ['max_tokens', 'anthropic_version', 'tools', 'output_config.format', 'usage', 'stop_reason', 'provider']) assert.ok(fidelity.standingGaps.some((gap) => gap.member === member), `gap ${member} is listed`);
    const gaps = seamModule.buildClaudeArgs(bodyOf({ output_config: { format: { type: 'text' }, effort: 'turbo' } }), 'claude-sonnet-5-5').gaps;
    assert.equal(gaps.length, 2, 'an effort or format the CLI cannot set is a per-request gap');
    const withMeta = seamModule.buildClaudeArgs(bodyOf({ output_config: { format: { type: 'json_schema', schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...SCHEMA } }, effort: 'high' } }), 'claude-sonnet-5-5');
    assert.deepEqual(JSON.parse(withMeta.args[withMeta.args.indexOf('--json-schema') + 1] ?? 'null'), SCHEMA, 'only the $schema member is removed');
    assert.ok(withMeta.gaps.some((gap) => /\$schema/u.test(gap)), 'and the removal is listed');
  });
});

describe('B04 plan rehearsal: the runner', () => {
  it('refuses any partition but PILOT and any fixture outside it, before anything is sent', async () => {
    const corpusDir = join(root, 'corpus');
    assert.deepEqual(runnerModule.rehearsalRefusals({ candidate: 'SONNET_5_5_US', corpusDir }), []);
    assert.ok(runnerModule.rehearsalRefusals({ candidate: 'SONNET_5_5_US', partition: 'FINAL', corpusDir }).some((r) => r.code === 'PARTITION_NOT_PILOT'));
    assert.ok(runnerModule.rehearsalRefusals({ candidate: 'HAIKU', corpusDir }).some((r) => r.code === 'UNKNOWN_CANDIDATE'));
    const final = loaded.loadCorpus(corpusDir).fixtures.find((entry) => entry.partition === 'FINAL');
    assert.ok(final !== undefined);
    assert.ok(runnerModule.rehearsalRefusals({ candidate: 'SONNET_5_5_US', fixtures: [final.fixture.fixtureId], corpusDir }).some((r) => r.code === 'FIXTURE_NOT_PILOT'));
    const before = captured().length;
    const refused = await runnerModule.runPlanRehearsal({ candidate: 'SONNET_5_5_US', partition: 'FINAL', out: join(work, 'out-refused'), claudeCommand: fakeCommand });
    assert.equal(refused.ok, false);
    assert.equal(refused.outDir, null);
    assert.equal(captured().length, before, 'nothing was sent');
  });

  it('runs the pilot path over the fake CLI: SIMULATED run labels, a fidelity record beside the output, and the live audits refuse it', { timeout: 900_000 }, async () => {
    const out = join(work, 'out-run');
    const result = await runnerModule.runPlanRehearsal({ candidate: 'SONNET_5_5_US', limit: 1, out, claudeCommand: fakeCommand });
    assert.deepEqual(result.refusals, []);
    assert.equal(result.evidence, 'SIMULATED');
    assert.ok(result.requests > 0 && captured().length >= result.requests, 'every request went through the CLI seam');
    assert.ok(captured().every((call) => call.argv.includes('--system-prompt') && call.argv[call.argv.indexOf('--tools') + 1] === ''));
    assert.ok(result.outDir !== null);
    const pass = join(result.outDir as string, 'SONNET_5_5_US', 'pass-1');
    const run = JSON.parse(readFileSync(join(pass, 'run.json'), 'utf8')) as { evidence: string; reportMode: string };
    assert.equal(run.evidence, 'SIMULATED');
    assert.notEqual(run.reportMode, 'QUALIFICATION');
    // The one funded wire is Amazon Bedrock (A9): every request the stage wrote went to the InvokeModel URL of the Sonnet 5.5 profile.
    const receiptLines = readFileSync(join(result.outDir as string, 'SONNET_5_5_US', 'receipts.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string; url?: string });
    const sent = receiptLines.filter((receipt) => receipt.kind === 'REQUEST');
    assert.ok(sent.length > 0 && sent.every((receipt) => /^https:\/\/bedrock-runtime\.us-(east|west)-[12]\.amazonaws\.com\/model\/us\.anthropic\.claude-sonnet-5-5\/invoke$/u.test(decodeURIComponent(receipt.url ?? ''))), JSON.stringify(sent.slice(0, 2)));
    const marker = JSON.parse(readFileSync(join(out, 'PLAN_REHEARSAL.json'), 'utf8')) as { evidence: string; countsAsQualification: boolean; partition: string };
    assert.deepEqual([marker.evidence, marker.countsAsQualification, marker.partition], ['SIMULATED', false, 'PILOT']);
    const selection = JSON.parse(readFileSync(join(pass, 'selection.json'), 'utf8')) as { partition: string }[];
    assert.ok(selection.length === 1 && selection.every((entry) => entry.partition === 'PILOT'));
    const fidelity = JSON.parse(readFileSync(join(out, 'fidelity.json'), 'utf8')) as { requests: number; standingGaps: unknown[] };
    assert.ok(fidelity.requests >= result.requests && fidelity.standingGaps.length > 0);
    const scores = JSON.parse(readFileSync(join(pass, 'scores.json'), 'utf8')) as unknown[];
    for (const suite of ['IC-05', 'S036', 'R2-027']) assert.ok(auditModule.auditLiveSuite(suite, { evidence: run.evidence, corpusFixtures: selection, scores, receipts: [] }).problems.some((p) => /not EXECUTED_PROVIDER/u.test(p)), `${suite}: refused as live evidence`);
  });
});
