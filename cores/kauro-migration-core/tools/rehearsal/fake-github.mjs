/**
 * A GitHub that lives in a JSON file, for rehearsing the release chain.
 *
 * CONTROL_FLOW_TEST_ONLY. Loaded with `node --import`, it replaces `fetch`
 * for api.github.com and uploads.github.com and refuses every other host: a
 * rehearsal has no network. It refuses to load at all unless
 * KAURO_CONTROL_FLOW_TEST_ONLY=1, so it cannot be picked up by accident.
 *
 * The state is a file named by KAURO_FAKE_GITHUB_STATE so that the chain and
 * the child processes it spawns (the freeze verdict, receipt-verify --observe)
 * see the same remote. Asset bytes live in files beside it. The scenario is
 * in the state and decides where the remote misbehaves:
 *
 *   ok           everything answers as a healthy remote would
 *   ci-red       one required check on the merged commit concluded failure
 *   tag-exists   v2.0.1 already exists on another commit
 *   mutable      the published release reports immutable:false
 *   merge-405    the merge is refused
 *
 * Nothing here is a claim about GitHub's real behaviour beyond the shapes the
 * chain reads; the real remote is read by the same code with the real fetch.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.KAURO_CONTROL_FLOW_TEST_ONLY !== '1') {
  throw new Error('tools/rehearsal/fake-github.mjs is CONTROL_FLOW_TEST_ONLY and KAURO_CONTROL_FLOW_TEST_ONLY is not 1');
}
// Read per request, not at load: one process rehearses several scenarios in
// turn, each with its own state file, and a module is loaded once.
const statePath = () => {
  const path = process.env.KAURO_FAKE_GITHUB_STATE;
  if (path === undefined || !existsSync(path)) throw new Error('KAURO_FAKE_GITHUB_STATE does not name an existing state file');
  return path;
};
statePath();

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const readState = () => JSON.parse(readFileSync(statePath(), 'utf8'));
const writeState = (state) => writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
const assetDir = () => {
  const dir = join(statePath(), '..', 'fake-assets');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const realFetch = globalThis.fetch;

function respond(status, body, { raw = false, headers = {} } = {}) {
  const payload = raw ? body : body === null ? '' : JSON.stringify(body);
  return new Response(status === 204 ? null : payload, {
    status,
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', ...headers },
  });
}
const notFound = (path) => respond(404, { message: 'Not Found', path });

function checkRunsFor(state, sha) {
  return [...state.requiredChecks, 'release receipt (RECEIPT-01)'].map((name, index) => {
    const red = state.scenario === 'ci-red' && index === 0;
    return {
      id: 2000 + index,
      name,
      status: 'completed',
      conclusion: red ? 'failure' : 'success',
      head_sha: sha,
      started_at: '2026-09-11T03:00:00Z',
      completed_at: '2026-09-11T03:10:00Z',
      app: { slug: 'github-actions' },
      check_suite: { id: 500 },
      html_url: `https://github.com/${state.repository}/runs/${String(2000 + index)}`,
    };
  });
}

function jobsFor(state) {
  // The legs the workflow declares, each on the runner it asks for, plus the
  // receipt job; the observer compares names and labels against the workflow.
  const legs = [...state.legs, { name: 'release receipt (RECEIPT-01)', runsOn: 'ubuntu-latest' }];
  return legs.map((leg, index) => ({
    id: 2000 + index,
    html_url: `https://github.com/${state.repository}/runs/${String(2000 + index)}`,
    run_id: state.runId,
    run_attempt: 1,
    name: leg.name,
    status: 'completed',
    conclusion: state.scenario === 'ci-red' && index === 0 ? 'failure' : 'success',
    head_sha: state.main,
    labels: [leg.runsOn],
    runner_name: 'fake',
    started_at: '2026-09-11T03:00:00Z',
    completed_at: '2026-09-11T03:10:00Z',
    steps: [],
  }));
}

function releaseView(state, release) {
  return {
    ...release,
    assets: release.assetIds.map((id) => state.assets[id]),
    html_url: `https://github.com/${state.repository}/releases/tag/${release.tag_name}`,
    upload_url: `https://uploads.github.com/repos/${state.repository}/releases/${String(release.id)}/assets{?name,label}`,
  };
}

async function handle(method, url, init) {
  const state = readState();
  const r = state.repository;
  const path = url.pathname + (url.search ?? '');
  const p = url.pathname;
  const q = url.searchParams;
  state.calls = (state.calls ?? 0) + 1;
  writeState(state);
  // Asset uploads carry bytes, not JSON; they are handled before any body is parsed.
  if (url.host === 'uploads.github.com') {
    const match = new RegExp(`^/repos/${r}/releases/(\\d+)/assets$`, 'u').exec(p);
    if (method !== 'POST' || match === null) return notFound(path);
    const release = state.releases.find((entry) => entry.id === Number(match[1]));
    if (release === undefined) return notFound(path);
    if (release.draft !== true) return respond(422, { message: 'Validation Failed', errors: [{ code: 'immutable_release' }] });
    const name = q.get('name');
    const bytes = Buffer.from(init.body);
    const id = 9000 + Object.keys(state.assets).length;
    writeFileSync(join(assetDir(), String(id)), bytes);
    state.assets[id] = { id, name, size: bytes.length, content_type: init.headers?.['content-type'] ?? 'application/octet-stream', state: 'uploaded', sha256: sha256(bytes) };
    release.assetIds.push(id);
    writeState(state);
    return respond(201, state.assets[id]);
  }

  const body = init?.body ? JSON.parse(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8')) : null;

  if (p === `/repos/${r}`) return respond(200, { full_name: r, private: true, default_branch: 'main', permissions: { admin: true, push: true, pull: true } });
  if (p === `/repos/${r}/immutable-releases`) return respond(200, { enabled: state.scenario !== 'mutable', enforced_by_owner: false });
  if (p === `/repos/${r}/branches/main`) return respond(200, { name: 'main', commit: { sha: state.main } });
  if (p === `/repos/${r}/rules/branches/main`) {
    return respond(200, [
      { type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_last_push_approval: false, required_review_thread_resolution: true } },
      { type: 'required_linear_history' },
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: state.requiredChecks.map((context) => ({ context, integration_id: 15368 })) } },
    ]);
  }
  if (p === `/repos/${r}/rulesets`) return respond(200, [{ id: 1, name: 'main', enforcement: 'active', bypass_actors: [] }]);
  if (p === `/repos/${r}/rulesets/1`) return respond(200, { id: 1, name: 'main', enforcement: 'active', bypass_actors: [], rules: [] });

  if (p === '/graphql' && method === 'POST') {
    if (String(body?.query).includes('markPullRequestReadyForReview') && body?.variables?.id === `PR_node_${String(state.prNumber)}`) {
      state.prDraft = false;
      writeState(state);
      return respond(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    return respond(200, { data: null, errors: [{ message: 'the rehearsal remote does not answer this query' }] });
  }
  if (p === `/repos/${r}/pulls/${String(state.prNumber)}`) {
    return respond(200, { number: state.prNumber, node_id: `PR_node_${String(state.prNumber)}`, draft: state.prDraft !== false, state: state.prMerged ? 'closed' : 'open', merged: state.prMerged, merge_commit_sha: state.prMerged ? state.mergedSha : null, mergeable: true, mergeable_state: state.prDraft !== false ? 'blocked' : 'clean', head: { sha: state.head, ref: state.branch }, base: { ref: 'main' } });
  }
  if (p === `/repos/${r}/pulls/${String(state.prNumber)}/merge`) {
    if (method === 'GET') return state.prMerged ? respond(204, null) : notFound(path);
    if (method === 'PUT') {
      if (state.scenario === 'merge-405') return respond(405, { message: 'Required status check "x" is failing.' });
      if (state.prDraft !== false) return respond(405, { message: 'Pull Request is still a draft' });
      if (state.prMerged) return respond(405, { message: 'Pull Request is not mergeable' });
      state.prMerged = true;
      state.main = state.mergedSha;
      writeState(state);
      return respond(200, { sha: state.mergedSha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  const checkRuns = new RegExp(`^/repos/${r}/commits/([0-9a-f]{40})/check-runs$`, 'u').exec(p);
  if (checkRuns !== null) {
    const runs = checkRunsFor(state, checkRuns[1]);
    return respond(200, { total_count: runs.length, check_runs: runs });
  }
  const commit = new RegExp(`^/repos/${r}/commits/([0-9a-f]{40})$`, 'u').exec(p);
  if (commit !== null) return respond(200, { sha: commit[1], commit: { tree: { sha: state.tree } } });

  if (p === `/repos/${r}/actions/runs`) {
    const wanted = q.get('head_sha');
    const runs = wanted === null || wanted === state.main ? [{ id: state.runId, name: 'core gate', event: 'push', status: 'completed', conclusion: state.scenario === 'ci-red' ? 'failure' : 'success', head_sha: state.main, head_branch: 'main', run_attempt: 1, path: '.github/workflows/ci.yml', workflow_id: 7 }] : [];
    return respond(200, { total_count: runs.length, workflow_runs: runs });
  }
  if (p === `/repos/${r}/actions/runs/${String(state.runId)}`) {
    return respond(200, { id: state.runId, name: 'core gate', event: 'push', status: 'completed', conclusion: state.scenario === 'ci-red' ? 'failure' : 'success', head_sha: state.main, head_branch: 'main', run_attempt: 1, path: '.github/workflows/ci.yml', workflow_id: 7, repository: { full_name: r } });
  }
  if (p === `/repos/${r}/actions/runs/${String(state.runId)}/jobs`) {
    const jobs = jobsFor(state);
    return respond(200, { total_count: jobs.length, jobs });
  }
  if (p === `/repos/${r}/actions/runs/${String(state.runId)}/artifacts`) {
    return respond(200, { total_count: 1, artifacts: [{ id: 31, name: `ci-receipt-${state.main}`, expired: false, size_in_bytes: 1, archive_download_url: `https://api.github.com/repos/${r}/actions/artifacts/31/zip`, workflow_run: { id: state.runId, head_sha: state.main } }] });
  }
  if (p === `/repos/${r}/actions/artifacts/31/zip`) {
    return respond(200, readFileSync(state.receiptZip), { raw: true });
  }
  if (p === `/repos/${r}/actions/workflows/ci.yml`) return respond(200, { id: 7, path: '.github/workflows/ci.yml', name: 'core gate', state: 'active' });

  const tagRef = new RegExp(`^/repos/${r}/git/ref/tags/(.+)$`, 'u').exec(p);
  if (tagRef !== null) {
    const name = decodeURIComponent(tagRef[1]);
    const tag = state.tags[name];
    if (tag === undefined) return notFound(path);
    return respond(200, { ref: `refs/tags/${name}`, object: { type: 'tag', sha: tag.objectSha } });
  }
  const tagObject = new RegExp(`^/repos/${r}/git/tags/([0-9a-f]{40})$`, 'u').exec(p);
  if (tagObject !== null) {
    const tag = Object.values(state.tags).find((entry) => entry.objectSha === tagObject[1]);
    if (tag === undefined) return notFound(path);
    return respond(200, { sha: tag.objectSha, tag: tag.name, message: tag.message, object: { type: 'commit', sha: tag.commit } });
  }
  if (p === `/repos/${r}/git/tags` && method === 'POST') {
    const objectSha = sha256(`tag:${body.tag}:${body.object}`).slice(0, 40);
    state.pendingTagObjects = { ...(state.pendingTagObjects ?? {}), [objectSha]: { name: body.tag, commit: body.object, message: body.message, objectSha } };
    writeState(state);
    return respond(201, { sha: objectSha, tag: body.tag, object: { type: 'commit', sha: body.object } });
  }
  if (p === `/repos/${r}/git/refs` && method === 'POST') {
    const name = String(body.ref).replace(/^refs\/tags\//u, '');
    if (state.tags[name] !== undefined) return respond(422, { message: 'Reference already exists' });
    const pending = (state.pendingTagObjects ?? {})[body.sha];
    if (pending === undefined) return respond(422, { message: 'Object does not exist' });
    state.tags[name] = pending;
    writeState(state);
    return respond(201, { ref: body.ref, object: { type: 'tag', sha: body.sha } });
  }

  if (p === `/repos/${r}/releases` && method === 'GET') return respond(200, state.releases.map((release) => releaseView(state, release)));
  if (p === `/repos/${r}/releases` && method === 'POST') {
    if (state.releases.some((release) => release.tag_name === body.tag_name)) return respond(422, { message: 'Validation Failed', errors: [{ code: 'already_exists', field: 'tag_name' }] });
    const release = { id: 700 + state.releases.length, tag_name: body.tag_name, name: body.name ?? body.tag_name, body: body.body ?? '', draft: body.draft === true, prerelease: body.prerelease === true, target_commitish: body.target_commitish ?? 'main', immutable: false, assetIds: [] };
    state.releases.push(release);
    writeState(state);
    return respond(201, releaseView(state, release));
  }
  const releaseByTag = new RegExp(`^/repos/${r}/releases/tags/(.+)$`, 'u').exec(p);
  if (releaseByTag !== null) {
    const release = state.releases.find((entry) => entry.tag_name === decodeURIComponent(releaseByTag[1]) && entry.draft === false);
    return release === undefined ? notFound(path) : respond(200, releaseView(state, release));
  }
  const releaseAssets = new RegExp(`^/repos/${r}/releases/(\\d+)/assets$`, 'u').exec(p);
  if (releaseAssets !== null) {
    const release = state.releases.find((entry) => entry.id === Number(releaseAssets[1]));
    if (release === undefined) return notFound(path);
    const per = Number(q.get('per_page') ?? '30');
    const page = Number(q.get('page') ?? '1');
    const all = release.assetIds.map((id) => state.assets[id]);
    return respond(200, all.slice((page - 1) * per, page * per));
  }
  const releaseAsset = new RegExp(`^/repos/${r}/releases/assets/(\\d+)$`, 'u').exec(p);
  if (releaseAsset !== null) {
    const asset = state.assets[releaseAsset[1]];
    if (asset === undefined) return notFound(path);
    const accept = init?.headers?.accept ?? init?.headers?.Accept ?? '';
    if (String(accept).includes('octet-stream')) return respond(200, readFileSync(join(assetDir(), String(asset.id))), { raw: true });
    return respond(200, asset);
  }
  const releaseById = new RegExp(`^/repos/${r}/releases/(\\d+)$`, 'u').exec(p);
  if (releaseById !== null) {
    const release = state.releases.find((entry) => entry.id === Number(releaseById[1]));
    if (release === undefined) return notFound(path);
    if (method === 'PATCH') {
      if (release.draft === false) return respond(422, { message: 'Validation Failed', errors: [{ code: 'immutable_release' }] });
      if (body.draft === false) {
        release.draft = false;
        release.immutable = state.scenario !== 'mutable';
        release.published_at = '2026-09-11T04:00:00Z';
      }
      writeState(state);
    }
    return respond(200, releaseView(state, release));
  }

  return notFound(path);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.host !== 'api.github.com' && url.host !== 'uploads.github.com') {
    throw new Error(`CONTROL_FLOW_TEST_ONLY: the rehearsal has no network and ${url.host} was asked for`);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  return handle(method, url, init);
};
void realFetch;
