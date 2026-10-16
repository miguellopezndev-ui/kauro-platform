#!/usr/bin/env node
/**
 * SABOTAGE-REUSE — owner rule A6: the full sabotage runs once per candidate. A pull request is rebased onto an
 * up-to-date main (strict ruleset), so the commit that lands on main has the same git TREE as the pull request's head.
 * On the push to main this finds that head's successful "sabotage (INTELLIGENCE-SABOTAGE-01)" run and adopts its
 * report instead of running the shards again.
 *
 * Reuse only when every one of these holds, else the shards run (a lookup error is "not reusable", never "reusable"):
 *   - the pull request is in this repository (base and head), and one of the pull requests associated with the commit;
 *   - the head commit's git tree sha equals this commit's tree sha;
 *   - a COMPLETED check run named exactly the sabotage check, conclusion success, from the github-actions app, on that head;
 *   - its workflow run is in this repository, on that head, and kept an unexpired `sabotage-report` artifact.
 *
 *   node tools/sabotage-reuse.mjs lookup                    env GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA; writes GITHUB_OUTPUT
 *   node tools/sabotage-reuse.mjs adopt --report <in> --out <out> --run-id <id> --run-url <url> --run-commit <sha>
 *
 * adopt re-subjects the report to this commit (same tree, checked) and records where it came from in `reusedFrom`; the
 * gate then verifies it again with the unchanged strict verifier. The original commit is kept in reusedFrom.commit.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SABOTAGE_CHECK = 'sabotage (INTELLIGENCE-SABOTAGE-01)';
export const REPORT_ARTIFACT = 'sabotage-report';
const SHA = /^[0-9a-f]{40}$/u;

/**
 * @param {{ repo: string, commit: string, tree: string, api: (path: string) => Promise<any> }} input
 * @returns {Promise<{ reusable: boolean, reason: string, runId?: string, runUrl?: string, commit?: string, tree?: string }>}
 */
export async function findReusableRun({ repo, commit, tree, api }) {
  const no = (reason) => ({ reusable: false, reason });
  try {
    if (!SHA.test(String(commit)) || !SHA.test(String(tree))) return no('this commit or tree is not a sha');
    const pulls = await api(`/repos/${repo}/commits/${commit}/pulls?per_page=30`);
    if (!Array.isArray(pulls) || pulls.length === 0) return no('no pull request is associated with this commit');
    const heads = [...new Set(pulls
      .filter((pr) => pr?.base?.repo?.full_name === repo && pr?.head?.repo?.full_name === repo && SHA.test(String(pr?.head?.sha)))
      .map((pr) => pr.head.sha))];
    if (heads.length === 0) return no('no associated pull request is from this repository');
    const reasons = [];
    for (const head of heads) {
      const headCommit = await api(`/repos/${repo}/git/commits/${head}`);
      if (headCommit?.tree?.sha !== tree) { reasons.push(`${head.slice(0, 12)} has tree ${String(headCommit?.tree?.sha).slice(0, 12)}, not ${tree.slice(0, 12)}`); continue; }
      const runs = await api(`/repos/${repo}/commits/${head}/check-runs?check_name=${encodeURIComponent(SABOTAGE_CHECK)}&per_page=100`);
      const candidates = (runs?.check_runs ?? []).filter((run) => run?.name === SABOTAGE_CHECK && run?.status === 'completed' && run?.conclusion === 'success' && run?.app?.slug === 'github-actions' && run?.head_sha === head);
      if (candidates.length === 0) { reasons.push(`${head.slice(0, 12)} has no successful ${SABOTAGE_CHECK} from github-actions`); continue; }
      for (const check of candidates) {
        const runId = /\/actions\/runs\/(\d+)(?:\/|$)/u.exec(String(check.details_url ?? ''))?.[1];
        if (runId === undefined) { reasons.push('a check run has no workflow run id'); continue; }
        const run = await api(`/repos/${repo}/actions/runs/${runId}`);
        if (run?.repository?.full_name !== repo || run?.head_sha !== head) { reasons.push(`run ${runId} is not this repository's run on ${head.slice(0, 12)}`); continue; }
        const artifacts = await api(`/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
        if (!(artifacts?.artifacts ?? []).some((artifact) => artifact?.name === REPORT_ARTIFACT && artifact?.expired === false)) { reasons.push(`run ${runId} has no unexpired ${REPORT_ARTIFACT}`); continue; }
        return { reusable: true, reason: `REUSED from ${String(run.html_url)} (tree ${tree})`, runId: String(runId), runUrl: String(run.html_url), commit: head, tree };
      }
    }
    return no(reasons.join('; ') || 'nothing reusable');
  } catch (error) {
    return no(`lookup failed: ${String(error?.message ?? error)}`);
  }
}

/** The report of the reused run, re-subjected to this commit. Throws unless it is a passed QUALIFICATION of this very tree. */
export function adoptReport(report, { commit, tree }, from, subjectCommit = null) {
  if (report === null || typeof report !== 'object') throw new Error('no report');
  if (report.mode !== 'QUALIFICATION') throw new Error(`the report is ${String(report.mode)}, not a QUALIFICATION`);
  if (report.passed !== true) throw new Error('the report does not say passed');
  if (report.subject?.dirty !== false) throw new Error('the report was produced on a dirty tree');
  if (report.subject?.tree !== tree) throw new Error(`the report is about tree ${String(report.subject?.tree)}, not ${tree}`);
  // A pull request run checks out the synthetic merge commit S, so the report names S, not the head H. Accept H, or an S that
  // the API shows has this tree and H as a parent (S then is a merge of the head); the comparison is by tree either way.
  const named = report.subject?.commit;
  if (named !== from.commit) {
    if (subjectCommit === null || subjectCommit.sha !== named) throw new Error(`the report names commit ${String(named)}, which is not the run's head ${from.commit} and is not verified as its merge commit`);
    if (subjectCommit.tree !== tree) throw new Error(`the report's commit ${String(named)} has tree ${String(subjectCommit.tree)}, not ${tree}`);
    if (!subjectCommit.parents.includes(from.commit)) throw new Error(`the report's commit ${String(named)} is not a merge of the run's head ${from.commit}`);
  }
  if (!SHA.test(String(commit))) throw new Error('this commit is not a sha');
  return { ...report, subject: { ...report.subject, commit }, reusedFrom: { runId: from.runId, runUrl: from.runUrl, commit: from.commit, subjectCommit: named, tree } };
}

const githubApi = (token) => async (path) => {
  const response = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
  if (!response.ok) throw new Error(`GET ${path.split('?')[0]} -> ${String(response.status)}`);
  return response.json();
};

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const [mode, ...args] = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const git = (...a) => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
  if (mode === 'lookup') {
    const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_EVENT_NAME } = process.env;
    const result = GITHUB_EVENT_NAME !== 'push'
      ? { reusable: false, reason: `not a push (${String(GITHUB_EVENT_NAME)}): reuse is only for the push to main` }
      : await findReusableRun({ repo: GITHUB_REPOSITORY, commit: GITHUB_SHA, tree: git('rev-parse', 'HEAD^{tree}'), api: githubApi(GITHUB_TOKEN) });
    process.stderr.write(`sabotage-reuse: ${result.reusable ? 'REUSABLE' : 'not reusable'}: ${result.reason}\n`);
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `candidate=${String(result.reusable)}\nrun_id=${result.runId ?? ''}\nrun_url=${result.runUrl ?? ''}\nrun_commit=${result.commit ?? ''}\ntree=${result.tree ?? ''}\nreason=${result.reason}\n`);
  } else if (mode === 'adopt') {
    try {
      const report = JSON.parse(readFileSync(arg('--report'), 'utf8'));
      const from = { runId: arg('--run-id'), runUrl: arg('--run-url'), commit: arg('--run-commit') };
      let subjectCommit = null;
      if (report?.subject?.commit !== from.commit && SHA.test(String(report?.subject?.commit))) {
        const fetched = await githubApi(process.env.GITHUB_TOKEN)(`/repos/${process.env.GITHUB_REPOSITORY}/git/commits/${report.subject.commit}`);
        subjectCommit = { sha: fetched?.sha, tree: fetched?.tree?.sha, parents: (fetched?.parents ?? []).map((parent) => parent.sha) };
      }
      const adopted = adoptReport(report, { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') }, from, subjectCommit);
      writeFileSync(arg('--out'), `${JSON.stringify(adopted, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`::error::sabotage-reuse adopt refused: ${error.message}\n`);
      process.exit(1);
    }
  } else {
    process.stderr.write('usage: sabotage-reuse.mjs lookup | adopt --report <in> --out <out> --run-id <id> --run-url <url> --run-commit <sha>\n');
    process.exit(2);
  }
}
