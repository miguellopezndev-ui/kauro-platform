#!/usr/bin/env node
// Focused regression witnesses, also runnable against an older chain module.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function chainIdentityCases(chain, record) {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const identity = { prNumber: 16, branch: 'release/3.0.0-dossier' };
  const pull = (overrides = {}) => ({ number: 16, merged: true, head: { sha: A, ref: identity.branch }, base: { ref: 'main' }, merge_commit_sha: B, ...overrides });
  const scratch = mkdtempSync(join(tmpdir(), 'kauro-chain-merge-selftest-'));
  const node = (id) => chain.NODES.find((entry) => entry.id === id);
  const context = ({ cached = B, local = A, remotePull = pull(), main = B } = {}) => {
    let saves = 0, writes = 0;
    const ctx = {
      state: { ...identity, head: local, candidate: A, prHead: C, ...(cached === null ? {} : { mergedSha: cached }) },
      saveState: () => { saves += 1; },
      nodeById: node,
      gh: {
        get: async (path) => path.includes('/pulls/') ? remotePull : { commit: { sha: main } },
        put: async () => { writes += 1; throw new Error('unexpected merge mutation'); },
        graphql: async () => { writes += 1; throw new Error('unexpected draft mutation'); },
      },
    };
    return { ctx, saves: () => saves, writes: () => writes };
  };
  const test = async (id, expected, run) => {
    try {
      const [holds, observed] = await run();
      record(id, holds, expected, observed);
    } catch (error) { record(id, false, expected, String(error.stack ?? error)); }
  };
  // Stub subprocesses at Node's boundary so the production node bodies run,
  // including the real records-final commit sequence and push refspec.
  const subprocesses = async (stub, run) => {
    const original = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => command === 'git' && args[0] === 'ls-files'
      ? original(command, args, options) : stub(command, args, options);
    syncBuiltinESMExports();
    try { return await run(); }
    finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  };
  const commandResult = (stdout = '', status = 0) => ({ status, stdout, stderr: '', signal: null });
  try {
    for (const operation of ['check', 'run']) {
      await test(`chain.mergeBeforeSaveAdopted.${operation}`, 'a completed A→B merge is adopted and B persisted without another merge', async () => {
        const probe = context({ cached: null });
        const result = await node('merge')[operation](probe.ctx);
        return [result.ok && probe.ctx.state.mergedSha === B && probe.saves() > 0 && probe.writes() === 0, result.detail];
      });
      await test(`chain.mergedPrAdoptedAfterMainMoves.${operation}`, 'a correctly merged PR is adopted as B even if main has advanced to C', async () => {
        const probe = context({ cached: null, main: C });
        const result = await node('merge')[operation](probe.ctx);
        return [result.ok && probe.ctx.state.mergedSha === B && probe.saves() > 0 && probe.writes() === 0, result.detail];
      });
      await test(`chain.cachedMergeMismatchRefused.${operation}`, 'cached C cannot replace this PR’s merge result B, even with main at C', async () => {
        const probe = context({ cached: C, main: C });
        const result = await node('merge')[operation](probe.ctx);
        return [!result.ok && result.detail.includes('merge_commit_sha') && probe.ctx.state.mergedSha === C && probe.writes() === 0 && probe.saves() === 0, result.detail];
      });
    }
    await test('chain.cachedMergeMismatchWithMainAtPrResult', 'cached C is refused against PR result B even when main is B', async () => {
      const probe = context({ cached: C, main: B });
      const result = await node('merge').check(probe.ctx);
      return [!result.ok && result.detail.includes('merge_commit_sha') && probe.saves() === 0, result.detail];
    });
    // A response can be lost after the server completed the merge.
    await test('chain.lostMergeResponseAdopted', 'a PUT error after remote completion is recovered from the bound pull record', async () => {
      const probe = context({ cached: null });
      let merged = false, writes = 0;
      probe.ctx.gh.get = async (path) => path.includes('/pulls/') ? pull({ merged, merge_commit_sha: merged ? B : null }) : { commit: { sha: B } };
      probe.ctx.gh.put = async () => { writes += 1; merged = true; throw new Error('response lost'); };
      const result = await node('merge').run(probe.ctx);
      return [result.ok && probe.ctx.state.mergedSha === B && writes === 1 && probe.saves() > 0, result.detail];
    });
    await test('chain.mergePutResultBound', 'a successful PUT response C cannot substitute for the pull’s result B', async () => {
      const probe = context({ cached: null });
      let merged = false;
      probe.ctx.gh.get = async (path) => path.includes('/pulls/') ? pull({ merged, merge_commit_sha: merged ? B : null }) : { commit: { sha: B } };
      probe.ctx.gh.put = async () => { merged = true; return { merged: true, sha: C }; };
      const result = await node('merge').run(probe.ctx);
      return [!result.ok && result.detail.includes('merge_commit_sha') && probe.ctx.state.mergedSha === undefined && probe.saves() === 0, result.detail];
    });
    for (const [id, remotePull] of [
      ['base', pull({ base: { ref: 'other' } })],
      ['branch', pull({ head: { sha: A, ref: 'release/other' } })],
      ['number', pull({ number: 15 })],
    ]) {
      for (const operation of ['check', 'run']) await test(`chain.mergeForeign${id}Refused.${operation}`, 'a foreign PR identity cannot authorize adoption or a mutation', async () => {
        const probe = context({ remotePull });
        const result = await node('merge')[operation](probe.ctx);
        // Positive identity control: informational prHead C does not prevent
        // adoption of candidate A. This distinguishes identity validation from
        // the older rule that authorized the startup head instead.
        const bound = context({ cached: null });
        const control = await node('merge')[operation](bound.ctx);
        return [!result.ok && result.detail.includes(id === 'branch' ? 'head.ref' : id) && probe.saves() === 0 && probe.writes() === 0
          && control.ok && control.satisfied === true && bound.ctx.state.mergedHead === A, JSON.stringify({ result, control })];
      });
    }
    const localHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    for (const legacy of [false, true]) await test(`chain.resumeAfterCheckoutKeepsPrHead.${legacy ? 'legacy' : 'current'}`, 'makeContext at B preserves original PR head A and both merge oracles recover A→B', async () => {
      const options = { rehearsal: false, ...identity, workName: `resume-${String(legacy)}`, recoveryRoot: scratch, prHead: localHead };
      // Use the context's own path so the witness also reaches the older
      // makeContext implementation, which had no recoveryRoot parameter.
      const initial = await chain.makeContext(options);
      writeFileSync(initial.statePath, JSON.stringify({ ...identity, head: A, ...(!legacy ? { prHead: A } : {}), mergedSha: localHead }));
      const ctx = await chain.makeContext(options);
      ctx.gh = { get: async (path) => path.includes('/pulls/') ? pull({ merge_commit_sha: localHead }) : { commit: { sha: localHead } } };
      const checked = await node('merge').check(ctx);
      const ran = await node('merge').run(ctx);
      const saved = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
      return [checked.ok && ran.ok && saved.prHead === A && saved.candidate === A && saved.mergedHead === A
        && saved.head === localHead && saved.mergedSha === localHead, JSON.stringify({ saved, checked, ran })];
    });
    await test('chain.pushOracleUsesPrHead', 'the merged PR record satisfies push after checkout, independently of informational prHead', async () => {
      const probe = context({ local: localHead });
      probe.ctx.state.prHead = C;
      probe.ctx.gh.get = async (path) => {
        if (path.includes('/pulls/')) return pull();
        throw new Error('branch endpoint must not be read');
      };
      const result = await node('push').check(probe.ctx);
      return [result.ok && probe.ctx.state.prHead === C && probe.ctx.state.mergedHead === A, result.detail];
    });
    // Each implementation is guarded even when invoked directly, outside walk.
    for (const id of ['main-ci', 'checkout-merged', 'receipt-observe', 'dossier-build', 'consumer-check', 'tag', 'release-draft', 'release-publish', 'freeze-verdict', 'handoff']) {
      for (const operation of ['check', 'run']) await test(`chain.unverifiedMergeRefused.${id}.${operation}`, 'no downstream evidence or mutation can consume cached C when the PR merged as B', async () => {
        const probe = context({ cached: C, main: C });
        const ctx = probe.ctx;
        ctx.work = scratch;
        ctx.receiptPath = join(scratch, 'ci-receipt.json');
        const receipt = JSON.stringify({ sha: C, runId: '42' });
        writeFileSync(ctx.receiptPath, receipt);
        ctx.state.receiptSha256 = createHash('sha256').update(receipt).digest('hex');
        ctx.dossierDir = join(scratch, 'absent-dossier');
        ctx.childPreload = [];
        ctx.childEnv = {};
        const unexpected = [];
        ctx.gh.get = async (path) => {
          if (path.includes('/pulls/')) return pull();
          unexpected.push(path); throw new Error('downstream read before binding');
        };
        for (const method of ['list', 'post', 'patch', 'upload', 'bytes']) ctx.gh[method] = async () => { unexpected.push(method); throw new Error('downstream action before binding'); };
        const result = await node(id)[operation](ctx);
        return [!result.ok && result.detail.includes('merge_commit_sha') && unexpected.length === 0 && probe.saves() === 0 && !existsSync(join(scratch, 'logs')) && !existsSync(join(scratch, 'handoff.json')), result.detail];
      });
    }

    await test('chain.r2.recordsCommitIsPushedAndMerged', 'records-final commits B over A; push sends B and merge PUT authorizes B', async () => {
      const probe = context({ cached: null, remotePull: pull({ merged: false, merge_commit_sha: null }) });
      const ctx = probe.ctx;
      ctx.work = scratch;
      let local = A, remote = A, merged = false;
      const pushes = [], merges = [];
      ctx.gh.get = async (path) => path.includes('/pulls/')
        ? pull({ merged, head: { sha: remote, ref: identity.branch }, merge_commit_sha: merged ? C : null })
        : { commit: { sha: remote } };
      ctx.gh.put = async (_path, body) => { merges.push(body.sha); merged = true; return { merged: true, sha: C }; };
      // The subprocess stand-ins succeed; the production run still stages and
      // commits records. Their individual evidence oracles have separate suites.
      ctx.nodeById = (id) => id === 'records-final' ? { check: () => ({ ok: true, detail: 'record bytes qualified' }) } : node(id);
      return subprocesses((command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return commandResult(local);
        if (command === 'git' && args[0] === 'diff') return commandResult('', 1);
        if (command === 'git' && args[0] === 'commit') local = B;
        if (command === 'git' && args[0] === 'push') { pushes.push(args[2]); remote = args[2].split(':')[0]; }
        return commandResult();
      }, async () => {
        const records = await node('records-final').run(ctx);
        const before = await node('push').check(ctx);
        const pushed = await node('push').run(ctx);
        const result = await node('merge').run(ctx);
        const observed = { records, before, pushed, result, pushes, merges, state: ctx.state };
        return [records.ok && local === B && ctx.state.candidate === B && !before.ok && pushed.ok && result.ok
          && JSON.stringify(pushes) === JSON.stringify([`${B}:${identity.branch}`])
          && JSON.stringify(merges) === JSON.stringify([B]) && ctx.state.mergedHead === B && ctx.state.mergedSha === C, JSON.stringify(observed)];
      });
    });
    for (const operation of ['check', 'run']) {
      await test(`chain.r2.earlierCandidateMergeRefused.${operation}`, 'a merged A is refused when the qualified candidate is B', async () => {
        const probe = context({ cached: B, local: B });
        probe.ctx.state.candidate = B;
        const result = await node('merge')[operation](probe.ctx);
        return [!result.ok && result.detail.startsWith('QUALIFIED_CANDIDATE_MISMATCH:') && probe.saves() === 0 && probe.writes() === 0, result.detail];
      });
      await test(`chain.r2.foreignHeadBeforeMergeRefused.${operation}`, 'remote C cannot replace candidate B; no merge PUT or draft mutation', async () => {
        const probe = context({ cached: null, local: C, remotePull: pull({ merged: false, head: { sha: C, ref: identity.branch } }) });
        // Startup remote C is deliberately informational: it must not authorize C.
        probe.ctx.state.candidate = B;
        probe.ctx.state.prHead = C;
        const result = await node('merge')[operation](probe.ctx);
        return [!result.ok && result.detail.startsWith('CANDIDATE_HEAD_MISMATCH:') && probe.writes() === 0 && probe.saves() === 0, result.detail];
      });
    }
    await test('chain.r2.prCiWaitsOnCandidate', 'CI reads checks on candidate B while informational startup head remains A', async () => {
      const probe = context({ cached: null, remotePull: pull({ merged: false, head: { sha: B, ref: identity.branch } }) });
      const ctx = probe.ctx;
      ctx.state.candidate = B;
      ctx.state.prHead = A;
      // Use the real workflow's required legs rather than an empty-check oracle.
      const { readWorkflow, requiredJobLegs } = await import('./receipt-verify.mjs');
      ctx.workflow = readWorkflow();
      const paths = [];
      ctx.gh.list = async (path) => {
        paths.push(path);
        return requiredJobLegs(ctx.workflow).map((leg, i) => ({ id: 2000 + i, name: leg.name, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }));
      };
      const checked = await node('pr-ci').check(ctx);
      const ran = await node('pr-ci').run(ctx);
      return [checked.ok && ran.ok && paths.length === 2 && paths.every((path) => path.includes(`/commits/${B}/`)), JSON.stringify({ paths, checked, ran })];
    });
    for (const branchState of ['deleted', 'moved']) {
      for (const operation of ['check', 'run']) {
        for (const id of ['records-final', 'push', 'pr-ci', 'merge']) {
          await test(`chain.r2.mergedBranch${branchState}.${id}.${operation}`, 'merged PR alone satisfies the node with no branch dependency or subprocess mutation', async () => {
            const probe = context({ cached: null, local: B });
            const ctx = probe.ctx;
            ctx.work = scratch;
            let branchReads = 0, commands = 0;
            ctx.gh.get = async (path) => {
              if (path.includes('/pulls/')) return pull();
              branchReads += 1;
              if (branchState === 'deleted') throw new Error('GET ref returned 404');
              return { commit: { sha: C } };
            };
            return subprocesses(() => { commands += 1; return commandResult('FAIL unexpected subprocess', 1); }, async () => {
              const result = await node(id)[operation](ctx);
              return [result.ok && ctx.state.mergedHead === A && ctx.state.mergedSha === B && commands === 0 && branchReads === 0 && probe.writes() === 0, JSON.stringify({ result, commands, branchReads })];
            });
          });
        }
      }
      for (const mode of ['run', 'check']) await test(`chain.r2.mergedBranch${branchState}.walk.${mode}`, 'the real graph walk reaches main-ci after a merged PR with no push or mutation permission', async () => {
        const probe = context({ cached: null, local: B });
        const ctx = probe.ctx;
        ctx.work = scratch;
        ctx.rehearsal = false;
        ctx.allowMutations = false;
        ctx.log = () => {};
        ctx.ledger = () => {};
        // Exercise recovery even when the recorded fingerprint has changed.
        ctx.ledgerLast = () => ({ status: 'PASS', fingerprint: 'old', attempt: 1 });
        let downstream = 0, branchReads = 0, commands = 0;
        ctx.nodeById = (id) => {
          const original = node(id);
          if (['records-final', 'push', 'pr-ci', 'merge'].includes(id)) return original;
          const stand = () => {
            if (id === 'main-ci') { downstream += 1; return { ok: ctx.state.mergedSha === B && ctx.state.mergedHead === A, detail: 'downstream sees the verified merge result' }; }
            return { ok: true, detail: 'upstream evidence already qualified' };
          };
          return { ...original, inputs: () => [], fingerprint: () => 'stand-in', check: stand, run: stand };
        };
        ctx.gh.get = async (path) => {
          if (path.includes('/pulls/')) return pull();
          branchReads += 1;
          if (branchState === 'deleted') throw new Error('GET ref returned 404');
          return { commit: { sha: C } };
        };
        return subprocesses(() => { commands += 1; return commandResult('FAIL unexpected subprocess', 1); }, async () => {
          const walked = await chain.walk(ctx, { mode, until: 'main-ci' });
          const results = [...walked.results];
          return [downstream > 0 && results.every(([, result]) => ['PASS', 'REUSED'].includes(result.status))
            && commands === 0 && branchReads === 0 && probe.writes() === 0, JSON.stringify({ results, downstream, commands, branchReads })];
        });
      });
    }
    await test('chain.r2.nonAncestorStartupRefusedBeforeMutation', 'non-ancestor remote C fails before state/work creation or any producer mutation', async () => {
      const root = join(scratch, 'non-ancestor');
      let ancestryReads = 0, mutations = 0, error = null;
      return subprocesses((command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return commandResult(B);
        if (command === 'git' && args[0] === 'merge-base') { ancestryReads += 1; return commandResult('', 1); }
        mutations += 1; return commandResult();
      }, async () => {
        try {
          await chain.makeContext({ rehearsal: false, ...identity, recoveryRoot: root, prHead: C,
            pull: pull({ merged: false, head: { sha: C, ref: identity.branch } }) });
        } catch (caught) { error = String(caught.message); }
        return [error !== null && ancestryReads > 0 && mutations === 0 && !existsSync(root), JSON.stringify({ error, ancestryReads, mutations, workExists: existsSync(root) })];
      });
    });
    await test('chain.r2.ancestorStartupCandidatePreserved', 'fresh local B over remote ancestor A binds B and does not push during startup', async () => {
      const root = join(scratch, 'ancestor');
      let ancestryReads = 0, mutations = 0;
      return subprocesses((command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return commandResult(B);
        if (command === 'git' && args[0] === 'merge-base') { ancestryReads += 1; return commandResult(); }
        mutations += 1; return commandResult();
      }, async () => {
        const ctx = await chain.makeContext({ rehearsal: false, ...identity, recoveryRoot: root, prHead: A, pull: pull({ merged: false }) });
        return [ctx.state.candidate === B && ctx.state.prHead === A && ancestryReads > 0 && mutations === 0, JSON.stringify({ state: ctx.state, ancestryReads, mutations })];
      });
    });

    // The reviewer's exact race: the production records commit sequence moves
    // local A→B while the PR merges A→C. Use the real wrapped final check.
    await test('chain.r3.mergeDuringRecordsRefused', 'records-final refuses the outside A→C merge after generating candidate B, and persists no adoption', async () => {
      const probe = context({ cached: null });
      const ctx = probe.ctx;
      ctx.state.prHead = A;
      ctx.work = scratch;
      let local = A, merged = false;
      const saved = [], commands = [];
      ctx.saveState = () => saved.push({ ...ctx.state });
      ctx.gh.get = async () => pull({ merged, merge_commit_sha: merged ? C : null });
      return subprocesses((command, args) => {
        commands.push([command, ...args]);
        if (command === 'git' && args[0] === 'rev-parse') return commandResult(local);
        if (command === 'git' && args[0] === 'diff') return commandResult('', 1);
        if (command === 'git' && args[0] === 'commit') { local = B; merged = true; }
        return commandResult();
      }, async () => {
        const result = await node('records-final').run(ctx);
        return [!result.ok && result.detail.startsWith('QUALIFIED_CANDIDATE_MISMATCH:')
          && commands.some(([command, operation]) => command === 'git' && operation === 'commit')
          && ctx.state.candidate === B && ctx.state.mergedHead === undefined && ctx.state.mergedSha === undefined
          && saved.length > 0 && saved.every((state) => state.mergedHead === undefined && state.mergedSha === undefined)
          && probe.writes() === 0, JSON.stringify({ result, state: ctx.state, saved, commands })];
      });
    });
    const guarded = ['records-final', 'push', 'pr-ci', 'merge', 'main-ci', 'checkout-merged', 'receipt-observe', 'dossier-build', 'consumer-check', 'tag', 'release-draft', 'release-publish', 'freeze-verdict', 'handoff'];
    for (const cachedHead of [false, true]) {
      for (const id of guarded) for (const operation of ['check', 'run']) {
        await test(`chain.r3.${cachedHead ? 'cachedEarlierHead' : 'outsideEarlierMerge'}.${id}.${operation}`, 'a merged head A cannot authorize candidate B or any downstream action', async () => {
          const probe = context({ cached: C, local: B, remotePull: pull({ merge_commit_sha: C }), main: C });
          const ctx = probe.ctx;
          ctx.state.candidate = B;
          if (cachedHead) ctx.state.mergedHead = A;
          ctx.work = scratch;
          const unexpected = [];
          ctx.gh.get = async (path) => {
            if (path.includes('/pulls/')) return pull({ merge_commit_sha: C });
            unexpected.push(path); throw new Error('read before candidate binding');
          };
          for (const method of ['list', 'post', 'patch', 'upload', 'bytes']) ctx.gh[method] = async () => { unexpected.push(method); throw new Error('action before candidate binding'); };
          return subprocesses((command, args) => { unexpected.push([command, ...args]); return commandResult('', 1); }, async () => {
            const before = JSON.stringify(ctx.state);
            const result = await node(id)[operation](ctx);
            return [!result.ok && result.detail.startsWith('QUALIFIED_CANDIDATE_MISMATCH:')
              && unexpected.length === 0 && probe.saves() === 0 && probe.writes() === 0 && JSON.stringify(ctx.state) === before,
            JSON.stringify({ result, unexpected })];
          });
        });
      }
    }
    for (const cached of [false, true]) await test(`chain.r3.earlierMergeStartupRefused.${cached ? 'cached' : 'fresh'}`, 'startup refuses the earlier merge before writing state, ledger, or logs', async () => {
      const root = join(scratch, `earlier-startup-${cached}`);
      const options = { rehearsal: false, ...identity, recoveryRoot: root, workName: 'same-pr', pull: pull({ merge_commit_sha: C }) };
      const statePath = join(root, 'chain', options.workName, 'state.json');
      const bytes = JSON.stringify({ ...identity, head: B, candidate: B, mergedHead: A, mergedSha: C });
      if (cached) { mkdirSync(join(root, 'chain', options.workName), { recursive: true }); writeFileSync(statePath, bytes); }
      let error = null;
      return subprocesses((command, args) => command === 'git' && args[0] === 'rev-parse' ? commandResult(B) : commandResult(), async () => {
        try { await chain.makeContext(options); } catch (caught) { error = String(caught.message); }
        return [error?.startsWith('QUALIFIED_CANDIDATE_MISMATCH:') === true
          && (cached ? readFileSync(statePath, 'utf8') === bytes && !existsSync(join(root, 'chain', options.workName, 'logs')) : !existsSync(root)), error];
      });
    });
    for (const mode of ['check', 'run']) await test(`chain.r3.earlierMergeBlocksWalk.${mode}`, 'an earlier merge fails records-final and blocks every downstream node including tag and handoff', async () => {
      const probe = context({ cached: C, local: B, remotePull: pull({ merge_commit_sha: C }) });
      const ctx = probe.ctx;
      ctx.state.candidate = B;
      ctx.state.mergedHead = A;
      ctx.rehearsal = false;
      ctx.allowMutations = true;
      ctx.log = () => {};
      ctx.ledger = () => {};
      ctx.ledgerLast = () => ({ status: 'PASS', fingerprint: 'old', attempt: 1 });
      const upstream = new Set(chain.validateGraph(chain.NODES).order.slice(0, chain.validateGraph(chain.NODES).order.indexOf('records-final')));
      ctx.nodeById = (id) => {
        const original = node(id);
        const metadata = { ...original, inputs: () => [], fingerprint: () => 'stand-in' };
        const stand = () => ({ ok: true, detail: 'qualified upstream evidence' });
        return upstream.has(id) ? { ...metadata, check: stand, run: stand } : metadata;
      };
      return subprocesses(() => commandResult('', 1), async () => {
        const { results } = await chain.walk(ctx, { mode });
        const first = results.get('records-final');
        return [first.status === 'FAIL' && first.detail.includes('QUALIFIED_CANDIDATE_MISMATCH:')
          && guarded.filter((id) => id !== 'records-final').every((id) => results.get(id).status === 'BLOCKED')
          && probe.saves() === 0 && probe.writes() === 0, JSON.stringify([...results])];
      });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--chain');
  const modulePath = at === -1 ? new URL('./chain.mjs', import.meta.url).href : pathToFileURL(resolve(process.argv[at + 1])).href;
  const chain = await import(modulePath);
  const cases = [];
  await chainIdentityCases(chain, (id, ok, expected, observed) => cases.push({ id, ok, expected, observed }));
  const reportAt = process.argv.indexOf('--report');
  if (reportAt !== -1) writeFileSync(resolve(process.argv[reportAt + 1]), `${JSON.stringify(cases, null, 2)}\n`);
  for (const entry of cases) process.stdout.write(`${entry.ok ? 'ok' : 'FALSE'} ${entry.id}${entry.ok ? '' : `: ${entry.observed}`}\n`);
  const failures = cases.filter((entry) => !entry.ok).length;
  process.stdout.write(`CHAIN-IDENTITY: ${cases.length} cases, ${failures} failures\n`);
  process.exit(failures === 0 ? 0 : 1);
}
