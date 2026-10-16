// The PLAN REHEARSAL seam (B04 design, "plan rehearsal"): stands in for the Vertex endpoint and the credential of the campaign's
// funded path (stage-child.mjs `seamModule`) by running each rawPredict body through the owner's Claude subscription: the headless
// `claude -p` CLI. A run over a seam is labelled SIMULATED by the stage and the live audits refuse it (Codex B04-R8): this is a
// development tool, never qualification evidence, and never a substitute for the funded Vertex runs.
//
// What the CLI is told, per request: the body's `system` as the WHOLE system prompt (--system-prompt replaces Claude Code's own),
// no tools (--tools ""), no MCP servers (--strict-mcp-config with an empty config), no settings, CLAUDE.md or memory
// (--setting-sources "" and an EMPTY temporary working directory outside any repository), no session on disk, the model of the
// URL, the effort of output_config, and the JSON schema of output_config.format. The one user message goes on stdin as plain text.
// What the CLI cannot reproduce is listed in the `fidelity` record (fidelity.json beside the run); nothing is dropped silently.
//
// Configuration comes from the environment, because the stage imports this module inside a child process:
//   KAURO_PLAN_CLAUDE_CMD    JSON array [command, ...leading args] of the claude CLI (default: the `claude` on PATH)
//   KAURO_PLAN_LOG_DIR       where each call's raw CLI JSON is written (default: ./plan-rehearsal-logs under the temp directory)
//   KAURO_PLAN_FIDELITY      the path of the fidelity record (default: fidelity.json in the log directory's parent)
//   KAURO_PLAN_CONCURRENCY   calls in flight at once (default 2)
//   KAURO_PLAN_TIMEOUT_MS    per call (default 300000)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export const PLAN_ID_PREFIX = 'plan-rehearsal-';
const MODELS = Object.freeze(['claude-sonnet-5-5', 'claude-opus-5-5']);
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The claude executable: the configured command, else claude.exe on PATH (or beside the npm claude.cmd shim on Windows), else `claude`. */
export function resolveClaudeCommand(env = process.env) {
  if (env.KAURO_PLAN_CLAUDE_CMD !== undefined && env.KAURO_PLAN_CLAUDE_CMD !== '') {
    const parsed = JSON.parse(env.KAURO_PLAN_CLAUDE_CMD);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part) => typeof part === 'string')) throw new Error('KAURO_PLAN_CLAUDE_CMD is not a non-empty JSON array of strings');
    return parsed;
  }
  if (process.platform === 'win32') {
    for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter((one) => one !== '')) {
      if (existsSync(join(dir, 'claude.exe'))) return [join(dir, 'claude.exe')];
      const shimmed = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(join(dir, 'claude.cmd')) && existsSync(shimmed)) return [shimmed];
    }
    const native = join(homedir(), '.local', 'bin', 'claude.exe');
    if (existsSync(native)) return [native];
  }
  return ['claude'];
}

/**
 * The model a request URL names: the Bedrock InvokeModel URL of the campaign (A9), .../model/us.anthropic.<model>/invoke with the
 * profile id percent-encoded, or the retired Vertex form .../publishers/anthropic/models/<model>:rawPredict (kept for the seam's own tests).
 */
export function modelOfUrl(url) {
  let text = String(url);
  try { text = decodeURIComponent(text); } catch { /* the text is judged as it is */ }
  const match = /\/model\/us\.anthropic\.([a-z0-9.-]+)\/invoke$/u.exec(text) ?? /\/models\/([a-z0-9.-]+):rawPredict$/u.exec(text);
  if (match === null || !MODELS.includes(match[1])) throw new Error(`the URL names no model of the campaign (${MODELS.join(', ')}): ${String(url).slice(0, 120)}`);
  return match[1];
}

/**
 * The claude argv for one Vertex body, and what the body asks for that the CLI cannot do (the per-request part of the fidelity record).
 * @returns {{ args: string[], stdin: string, gaps: string[] }}
 */
export function buildClaudeArgs(body, model) {
  if (!isRecord(body)) throw new Error('the body is not an object');
  if (typeof body.system !== 'string' || body.system === '') throw new Error('the body has no system prompt');
  if (!Array.isArray(body.messages) || body.messages.length !== 1 || !isRecord(body.messages[0]) || body.messages[0].role !== 'user' || typeof body.messages[0].content !== 'string') throw new Error('the plan transport carries exactly one plain-text user message');
  if (!Array.isArray(body.tools) || body.tools.length !== 0) throw new Error('the plan transport sends no tools: the body offers some');
  const gaps = [];
  const args = [
    '-p', '--output-format', 'json', '--input-format', 'text', '--no-session-persistence',
    '--system-prompt', body.system,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--exclude-dynamic-system-prompt-sections',
    '--disable-slash-commands',
    '--model', model,
  ];
  const config = isRecord(body.output_config) ? body.output_config : {};
  if (typeof config.effort === 'string') {
    if (EFFORTS.includes(config.effort)) args.push('--effort', config.effort);
    else gaps.push(`output_config.effort=${config.effort} is not a CLI effort level and was not set`);
  }
  const format = isRecord(config.format) ? config.format : null;
  if (format !== null && format.type === 'json_schema' && isRecord(format.schema)) {
    // The CLI validates the schema with a validator that cannot resolve the 2020-12 meta-schema: the $schema member alone is removed, and said.
    const { $schema, ...schema } = format.schema;
    if ($schema !== undefined) gaps.push(`output_config.format.schema.$schema (${String($schema)}) was removed: the CLI cannot resolve that meta-schema; every other schema member is passed unchanged`);
    args.push('--json-schema', JSON.stringify(schema));
  }
  else if (format !== null) gaps.push(`output_config.format of type ${String(format.type)} has no CLI equivalent and was not set`);
  return { args, stdin: body.messages[0].content, gaps };
}

/** What the plan transport cannot reproduce of the funded Vertex path, whatever the request: listed, never dropped silently. */
export const STANDING_GAPS = Object.freeze([
  { member: 'max_tokens', reason: 'the CLI has no per-request output cap; the value the body asked for is recorded per request and the output tokens observed are compared with it' },
  { member: 'anthropic_version', reason: 'a provider wire member (bedrock-2023-05-31); the request goes to the Anthropic first-party API through the subscription, not to Amazon Bedrock' },
  { member: 'tools', reason: 'the body offers none and --tools "" disables every built-in tool, but with --json-schema the CLI adds its own synthetic structured-output tool and takes a second turn (stop_reason tool_use, num_turns 2)' },
  { member: 'output_config.format', reason: 'the JSON schema is enforced by the CLI through that synthetic tool, not by the provider output_config; the CLI result is re-serialised as the response text' },
  { member: 'usage', reason: 'cache creation/read tokens the CLI reports (its own prompt cache) are folded into input_tokens and not reported as cache fields, because the campaign gateway treats cache fields as a broken subject' },
  { member: 'stop_reason', reason: 'synthesised (end_turn); the CLI does not return the provider stop_reason of the final message' },
  { member: 'sampling', reason: 'no temperature or other sampling member is sent (the pinned bundle sends none); the CLI session defaults apply' },
  { member: 'system', reason: 'Claude Code still adds a short billing/attribution header and its harness around the replaced system prompt; its exact bytes are not observable here' },
  { member: 'provider', reason: 'subscription first-party API: no US multi-region routing, no request-response logging read-back, no S091 privacy read-back and no IC-13 wire receipts (those exist only on Amazon Bedrock, probes P1-P6); the logging read-back the stage records is synthetic' },
  { member: 'cost', reason: 'the subscription is not metered per token; the grant of a rehearsal is notional and no money is spent' },
]);

const sleepless = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs the CLI once. Resolves { code, stdout, stderr, timedOut } and never rejects on a CLI failure. */
export function runClaude(command, args, stdin, { cwd, timeoutMs, env }) {
  return new Promise((done) => {
    const child = spawn(command[0], [...command.slice(1), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
    const timer = setTimeout(() => { timedOut = true; child.kill(); sleepless(2000).then(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin.on('error', () => { /* the CLI may exit before reading */ });
    child.stdin.end(stdin);
  });
}

/** A Bedrock-shaped answer: the token count headers of a 200 confirm its body usage, so the gateway does not read the usage as unknown. */
const reply = (status, payload) => {
  const bytes = Buffer.from(JSON.stringify(payload));
  const headers = { 'content-type': 'application/json' };
  if (status === 200 && isRecord(payload.usage)) {
    headers['x-amzn-requestid'] = String(payload.id);
    headers['x-amzn-bedrock-input-token-count'] = String(payload.usage.input_tokens);
    headers['x-amzn-bedrock-output-token-count'] = String(payload.usage.output_tokens);
  }
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null, forEach: (callback) => { for (const [key, value] of Object.entries(headers)) callback(value, key); } }, body: (async function* () { yield bytes; })() };
};

/** The CLI's JSON result as a Vertex-shaped message, or null with the reason. */
export function vertexShapedResponse(cli, id, requestedModel) {
  if (!isRecord(cli)) return { response: null, reason: 'the CLI printed no JSON object' };
  if (cli.is_error === true || cli.subtype !== 'success') return { response: null, reason: `the CLI reported ${String(cli.subtype ?? 'an error')}${typeof cli.result === 'string' ? `: ${cli.result.slice(0, 200)}` : ''}` };
  const text = cli.structured_output !== undefined && cli.structured_output !== null ? JSON.stringify(cli.structured_output) : cli.result;
  if (typeof text !== 'string') return { response: null, reason: 'the CLI result carries no text' };
  const reported = isRecord(cli.modelUsage) ? Object.keys(cli.modelUsage) : [];
  const model = reported.length === 1 ? reported[0] : reported.length === 0 ? requestedModel : `unreported-or-mixed:${reported.join('+')}`;
  const u = isRecord(cli.usage) ? cli.usage : {};
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const input = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens);
  return { response: { id, type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: count(u.output_tokens) } }, reason: null };
}

/**
 * @param {{ command?: string[], logDir?: string, fidelityPath?: string, concurrency?: number, timeoutMs?: number, env?: NodeJS.ProcessEnv }} options
 */
export function createPlanSeam(options = {}) {
  const command = options.command ?? resolveClaudeCommand();
  const logDir = resolve(options.logDir ?? join(tmpdir(), 'kauro-plan-rehearsal-logs'));
  const fidelityPath = resolve(options.fidelityPath ?? join(dirname(logDir), 'fidelity.json'));
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const timeoutMs = options.timeoutMs ?? 300_000;
  const env = { ...(options.env ?? process.env) };
  mkdirSync(logDir, { recursive: true });
  const record = { evidence: 'SIMULATED', transport: 'plan-rehearsal (claude -p over the owner subscription)', countsAsQualification: false, command: command.map((part, i) => (i === 0 ? part : part)), standingGaps: STANDING_GAPS, requests: 0, failures: 0, requested: { maxTokens: [], models: [] }, observed: { servedModels: [], maxOutputTokens: 0, overMaxTokens: 0 }, perRequestGaps: [] };
  const flush = () => writeFileSync(fidelityPath, `${JSON.stringify(record, null, 2)}\n`);
  flush();
  let n = 0;
  let active = 0;
  const waiting = [];
  const acquire = () => (active < concurrency ? (active += 1, Promise.resolve()) : new Promise((go) => waiting.push(go)));
  const release = () => { const next = waiting.shift(); if (next !== undefined) next(); else active -= 1; };

  const fetch = async (url, init) => {
    await acquire();
    n += 1;
    const callNo = n;
    const id = `${PLAN_ID_PREFIX}${String(callNo).padStart(5, '0')}`;
    const cwd = mkdtempSync(join(tmpdir(), 'kauro-plan-cwd-'));
    try {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const model = modelOfUrl(url);
      const { args, stdin, gaps } = buildClaudeArgs(body, model);
      record.requests += 1;
      if (!record.requested.maxTokens.includes(body.max_tokens)) record.requested.maxTokens.push(body.max_tokens);
      if (!record.requested.models.includes(model)) record.requested.models.push(model);
      for (const gap of gaps) if (!record.perRequestGaps.includes(gap)) record.perRequestGaps.push(gap);
      const ran = await runClaude(command, args, stdin, { cwd, timeoutMs, env });
      writeFileSync(join(logDir, `${id}.json`), `${JSON.stringify({ id, model, argvWithoutPrompt: args.map((a, i) => (args[i - 1] === '--system-prompt' ? `<system ${String(a.length)} chars>` : a)), exitCode: ran.code, timedOut: ran.timedOut, stdout: ran.stdout, stderr: ran.stderr }, null, 2)}\n`);
      if (ran.timedOut) { record.failures += 1; flush(); return reply(504, { type: 'error', error: { type: 'timeout_error', message: `the CLI call exceeded ${String(timeoutMs)} ms` } }); }
      let cli = null;
      try { cli = JSON.parse(ran.stdout); } catch { /* reported below */ }
      const shaped = ran.code === 0 ? vertexShapedResponse(cli, id, model) : { response: null, reason: `the CLI exited ${String(ran.code)}` };
      if (shaped.response === null) { record.failures += 1; flush(); return reply(502, { type: 'error', error: { type: 'api_error', message: shaped.reason } }); }
      const out = shaped.response;
      if (!record.observed.servedModels.includes(out.model)) record.observed.servedModels.push(out.model);
      record.observed.maxOutputTokens = Math.max(record.observed.maxOutputTokens, out.usage.output_tokens);
      if (typeof body.max_tokens === 'number' && out.usage.output_tokens > body.max_tokens) record.observed.overMaxTokens += 1;
      flush();
      return reply(200, out);
    } catch (error) {
      record.failures += 1;
      flush();
      return reply(400, { type: 'error', error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : String(error) } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      release();
    }
  };
  // The credential is a placeholder: nothing authenticates to AWS; the CLI uses the subscription login of the machine. Offering a
  // credential provider puts the stage on the Bedrock wire (the one funded path, A9); the token provider is the retired Vertex form.
  const credentialProvider = async () => ({ accessKeyId: 'ASIAPLANREHEARSAL0001', secretAccessKey: 'plan-rehearsal-no-credential', sessionToken: 'plan-rehearsal-no-session', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const tokenProvider = async () => ({ token: 'plan-rehearsal-no-credential', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  return { fetch, credentialProvider, tokenProvider, fidelityPath, logDir };
}

/** The seam module of the campaign: configured from the environment, because the stage runs in a child process. */
export default function planSeam() {
  const env = process.env;
  return createPlanSeam({
    command: resolveClaudeCommand(env),
    ...(env.KAURO_PLAN_LOG_DIR === undefined ? {} : { logDir: env.KAURO_PLAN_LOG_DIR }),
    ...(env.KAURO_PLAN_FIDELITY === undefined ? {} : { fidelityPath: env.KAURO_PLAN_FIDELITY }),
    ...(env.KAURO_PLAN_CONCURRENCY === undefined ? {} : { concurrency: Number(env.KAURO_PLAN_CONCURRENCY) }),
    ...(env.KAURO_PLAN_TIMEOUT_MS === undefined ? {} : { timeoutMs: Number(env.KAURO_PLAN_TIMEOUT_MS) }),
  });
}
