// The CHAOS seam (B04 L3b, mandate section 4.4; docs/work/CHAOS_REHEARSAL.md): a seamModule over the recorded Amazon Bedrock shapes
// (test/support/bedrock-recordings: the status, headers and x-amzn-ErrorType class of each documented InvokeModel failure) that
// plays one fixed fault script against the campaign's funded path, with an injected sleep and clock so no wall time passes.
//   npm run campaign -- --stage rehearse --seam tools/campaign/chaos-seam.mjs --shape pilot|qualification [--limit N] [--out <dir>] [--kill-at-fixture K]
// EVERYTHING it does is SIMULATED: the stage labels every run over a seam SIMULATED (Codex B04-R8), the summary says so, and no
// provider, credential, network or money is involved. It proves the runner's behaviour under failure, never a model's quality.
//
// The script is a queue of faults; each is taken by one SEND (one call of the credential provider, which the transport makes once per
// send, retries included), and only once the stage has reached the entry's fixture (index within the candidate's pass) and its
// candidate and pass when named. The queue is strictly ordered: an entry that is not yet eligible holds the ones behind it.
//   429-retry-after   429 ThrottlingException with Retry-After: 7           the core waits at least 7000 ms, the hold is RELEASED
//   429               429 ThrottlingException, no Retry-After               the core's own backoff, the hold is RELEASED
//   429-burst         six entries: six 429s in a row                        more than five released 429s in one run stop it RATE_LIMITED
//   503, 529          ServiceUnavailable, overloaded                        retried under the backoff; no usage, so the hold is kept
//   408-after-body    ModelTimeoutException after the body was read         billing unknown: the hold stays AMBIGUOUS, never re-sent
//   reset-mid-body    ECONNRESET after the body was written                 AFTER_SEND: AMBIGUOUS, never re-sent
//   credential-failure the credential provider throws                       BEFORE_SEND: nothing left, RELEASED, retried
//   refusal           200 with stop_reason refusal                          billed, unusable, no hard gate
//   plausible-wrong   200 with a well-formed answer that maps a column to a target the truth does not name
//   served-model-change 200 whose model is not the profile's (Opus)         SERVED_MODEL_CHANGE stops the stage; Sonnet's measurement stays
//   kill -9           afterScore: the stage child kills itself once, after the fsync of the score of fixture k (options.killAtFixture)
// A restart is a new invocation of the runner over the same out root and grant (the test or the operator makes it).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const THROTTLING = 'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/';
const UNAVAILABLE = 'ServiceUnavailableException:http://internal.amazon.com/coral/com.amazon.bedrock/';
const TIMEOUT = 'ModelTimeoutException:http://internal.amazon.com/coral/com.amazon.bedrock/';
export const RETRY_AFTER_SECONDS = 7;

/**
 * The script of a shape. Sonnet's first pass takes one episode per fixture (spaced, so no fixture is pushed past its own invocation
 * ceiling by the script alone: the burst is the one episode a fixture cannot survive, and it stops its run, not the stage); the
 * pilot ends with the served-model change on Opus's third fixture. Qualification has Sonnet alone.
 */
export function chaosScript(shape) {
  const sonnet = { candidate: 'SONNET_5_5_US', pass: 1 };
  const faults = [
    { ...sonnet, fixture: 0, fault: '429-retry-after' },
    { ...sonnet, fixture: 1, fault: '429' },
    ...Array.from({ length: 6 }, () => ({ ...sonnet, fixture: 2, fault: '429-burst' })),
    { ...sonnet, fixture: 4, fault: '503' },
    { ...sonnet, fixture: 5, fault: '529' },
    { ...sonnet, fixture: 6, fault: '408-after-body' },
    { ...sonnet, fixture: 7, fault: 'reset-mid-body' },
    { ...sonnet, fixture: 8, fault: 'credential-failure' },
    { ...sonnet, fixture: 9, fault: 'refusal' },
    { ...sonnet, fixture: 10, fault: 'plausible-wrong' },
  ];
  if (shape === 'pilot') faults.push({ candidate: 'OPUS_5_5_US', pass: 1, fixture: 2, fault: 'served-model-change' });
  return faults;
}

export default function seam({ alwaysAbstainAnswer, parseProviderRequestPayload, outDir, VirtualClock, options = {} }) {
  const shape = options.shape ?? 'pilot';
  const queue = (options.script ?? chaosScript(shape)).map((entry) => ({ ...entry }));
  const clock = new VirtualClock();
  const events = join(outDir, 'chaos-events.jsonl');
  const sleeps = join(outDir, 'chaos-sleeps.jsonl');
  mkdirSync(outDir, { recursive: true });
  const record = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`);
  const here = { candidate: null, pass: null, fixture: -1, fixtureIndex: -1 };
  let sends = 0;
  let current = null;
  /** A plausible-wrong answer that waits for the first send whose envelope offers a column a target (a clean-only file may offer none). */
  let wrongWaiting = 0;
  const injected = {};
  const inject = (fault, info) => { injected[fault] = (injected[fault] ?? 0) + 1; record(events, { send: sends, fault, candidate: here.candidate, fixtureIndex: here.fixtureIndex, ...info }); };

  /** The head of the queue when the stage has reached it; it is taken by this send. */
  const take = () => {
    const head = queue[0];
    if (head === undefined) return null;
    if (head.candidate !== undefined && head.candidate !== here.candidate) return null;
    if (head.pass !== undefined && head.pass !== here.pass) return null;
    if (here.fixtureIndex < head.fixture) return null;
    const fault = queue.shift().fault;
    if (fault !== 'plausible-wrong') return fault;
    wrongWaiting += 1;
    return null;
  };

  const answer = (status, id, body, headers = {}) => {
    const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const all = { 'content-type': 'application/json', 'x-amzn-requestid': id, ...headers };
    return { status, headers: { get: (name) => all[name.toLowerCase()] ?? null, forEach: (callback) => { for (const [key, value] of Object.entries(all)) callback(value, key); } }, body: (async function* () { yield bytes; })() };
  };
  const failure = (status, id, errorType, headers = {}) => answer(status, id, { message: 'SIMULATED chaos failure (a recorded Bedrock error shape)' }, { 'x-amzn-errortype': errorType, ...headers });

  /** The well-formed answer of the abstaining stand-in; for plausible-wrong, the first mappable column goes to the last target the envelope allows it. */
  const proposalFor = (payload, wrong) => {
    const proposal = alwaysAbstainAnswer(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash });
    if (!wrong) return { proposal, wrongApplied: false };
    const mappable = payload.envelope.constraints.allowedProposalTypes.includes('MAP_FIELD') ? payload.envelope.deterministicCandidates.findIndex((candidate) => Array.isArray(candidate.allowedTargetRefs) && candidate.allowedTargetRefs.length > 0) : -1;
    if (mappable < 0) return { proposal, wrongApplied: false };
    const candidate = payload.envelope.deterministicCandidates[mappable];
    const items = proposal.items.map((item, index) => (index === mappable ? { ...item, proposalType: 'MAP_FIELD', targetRef: candidate.allowedTargetRefs[candidate.allowedTargetRefs.length - 1], abstainReason: null, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', shortRationale: 'The header reads like the target.' } : item));
    return { proposal: { ...proposal, items }, wrongApplied: true };
  };

  const fetch = async (url, init) => {
    const chunks = [];
    for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const model = /claude-opus-5-5/u.test(decodeURIComponent(url)) ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
    const fault = current;
    const id = `chaos-${String(sends)}`;
    record(events, { send: sends, wrote: true, model, fault, candidate: here.candidate, fixtureIndex: here.fixtureIndex });
    switch (fault) {
      case '429-retry-after': inject(fault, { model }); return failure(429, id, THROTTLING, { 'retry-after': String(RETRY_AFTER_SECONDS) });
      case '429': case '429-burst': inject(fault, { model }); return failure(429, id, THROTTLING);
      case '503': inject(fault, { model }); return failure(503, id, UNAVAILABLE);
      case '529': inject(fault, { model }); return failure(529, id, UNAVAILABLE);
      case '408-after-body': inject(fault, { model }); return failure(408, id, TIMEOUT);
      case 'reset-mid-body': inject(fault, { model }); throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      default: break;
    }
    const { anthropic_version: _version, ...rest } = JSON.parse(text);
    const payload = parseProviderRequestPayload(JSON.stringify({ model, ...rest }));
    const { proposal, wrongApplied } = proposalFor(payload, wrongWaiting > 0);
    const answerText = JSON.stringify(proposal);
    const refusal = fault === 'refusal';
    const served = fault === 'served-model-change' ? 'claude-sonnet-5-5' : model;
    if (wrongApplied) { wrongWaiting -= 1; inject('plausible-wrong', { model, wrongApplied }); }
    if (fault === 'served-model-change') inject(fault, { model, served });
    if (refusal) inject(fault, { model });
    const usage = { input_tokens: Math.ceil(text.length / 4), output_tokens: refusal ? 0 : Math.ceil(answerText.length / 4) };
    const body = { id: `msg_bdrk_chaos_${String(sends)}`, type: 'message', role: 'assistant', model: served, stop_reason: refusal ? 'refusal' : 'end_turn', stop_sequence: null, content: [{ type: 'text', text: refusal ? '' : answerText }], usage };
    return answer(200, id, body, { 'x-amzn-bedrock-input-token-count': String(usage.input_tokens), 'x-amzn-bedrock-output-token-count': String(usage.output_tokens) });
  };

  // One call here is one send: the transport asks for the credential once per send, so the script counts retries too, and a credential failure is a send that never left.
  const credentialProvider = async () => {
    sends += 1;
    current = take();
    if (current === 'credential-failure') { inject(current, {}); throw new Error('SIMULATED: the credential refresh failed'); }
    return { accessKeyId: 'ASIACHAOSSIMULATED001', secretAccessKey: 'chaos-secret-not-real', sessionToken: 'chaos-session-not-real', expiresAt: new Date(clock.nowMs() + 3_600_000).toISOString() };
  };

  // The injected sleep advances the virtual clock and records how long the core waited: Retry-After is checked on this record, not on a wall clock.
  const sleep = async (ms) => { clock.advance(ms); record(sleeps, { send: sends, ms, candidate: here.candidate, fixtureIndex: here.fixtureIndex }); };

  const beforeFixture = ({ candidate, pass, index }) => { here.candidate = candidate; here.pass = pass; here.fixtureIndex = index; };

  // kill -9 of this process once, after the fsync of the score of the k-th fixture of the first pass (options.killAtFixture). The marker keeps the restart from dying again.
  const marker = options.killMarker ?? join(dirname(outDir), 'chaos-killed.marker');
  const afterScore = ({ candidate, pass, scoreCount }) => {
    const k = options.killAtFixture;
    if (k === undefined || k === null || scoreCount !== k || pass !== 1 || (options.killCandidate !== undefined && candidate !== options.killCandidate) || existsSync(marker)) return;
    writeFileSync(marker, `${JSON.stringify({ candidate, pass, scoreCount, pid: process.pid })}\n`);
    record(events, { fault: 'kill-9', candidate, pass, scoreCount, send: sends });
    process.kill(process.pid, 'SIGKILL');
  };
  // The stand-in's own judgement of a score (test seam only, never on the provider path), for the stop-rule rehearsal (D4-CHAOS-1):
  // a registered hard gate on the fixture named, or the violation named in options.violationAtFirstScore on the first score only.
  let planted = 0;
  const scoreOverride = (score, { fixtureId }) => {
    const named = options.hardGateAtFixtureId === fixtureId;
    const first = typeof options.violationAtFirstScore === 'string' && planted === 0;
    if (!named && !first) return score;
    planted += 1;
    return { ...score, hardGateViolations: [named ? 'secret_or_forbidden_data_egress' : options.violationAtFirstScore] };
  };

  const report = () => ({ shape, evidence: 'SIMULATED', sends, injected, notReached: [...queue.map((entry) => entry.fault), ...Array.from({ length: wrongWaiting }, () => 'plausible-wrong')], killAtFixture: options.killAtFixture ?? null });
  return { fetch, credentialProvider, clock, now: () => clock.nowMs(), sleep, beforeFixture, afterScore, scoreOverride, report };
}
