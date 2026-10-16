/**
 * The one GitHub transport the chain uses, so a rehearsal can stand in for
 * all of it by replacing `fetch`.
 *
 * Reads and writes go through `github()`; nothing else in tools/chain.mjs
 * touches the network. The token comes from the environment and is never
 * printed, never put on a command line, and never written into a file. Every
 * paginated list is read to the end and its length compared with what the
 * API declared, because a first page that looks complete is how a red check
 * on page two gets missed.
 */
import { githubToken } from './receipt-verify.mjs';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const TIMEOUT_MS = 120_000;
const PAGE = 100;

export class GitHubError extends Error {
  constructor(method, path, status, body) {
    super(`${method} ${path} returned ${String(status)}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    this.status = status;
    this.path = path;
  }
}

export function github(token = githubToken()) {
  if (token === null) throw new Error('no GitHub token in GITHUB_TOKEN or GH_TOKEN; the chain reads the remote and refuses to guess');
  const headers = (accept, extra = {}) => ({
    accept,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'kauro-mc3-chain',
    authorization: `Bearer ${token}`,
    ...extra,
  });

  async function request(method, url, { body = null, accept = 'application/vnd.github+json', contentType = null, raw = false } = {}) {
    const response = await fetch(url, {
      method,
      headers: headers(accept, contentType === null ? {} : { 'content-type': contentType }),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      let text = '';
      try {
        text = await response.text();
      } catch {
        text = '';
      }
      throw new GitHubError(method, url.replace(API, '').replace(UPLOADS, ''), response.status, text);
    }
    if (raw) return response;
    if (response.status === 204) return null;
    return response.json();
  }

  return {
    get: (path, options) => request('GET', `${API}${path}`, options),
    post: (path, json) => request('POST', `${API}${path}`, { body: JSON.stringify(json), contentType: 'application/json' }),
    patch: (path, json) => request('PATCH', `${API}${path}`, { body: JSON.stringify(json), contentType: 'application/json' }),
    put: (path, json) => request('PUT', `${API}${path}`, { body: JSON.stringify(json), contentType: 'application/json' }),
    /** One GraphQL call; the only remote operations with no REST equivalent go through here. */
    async graphql(query, variables = {}) {
      const result = await request('POST', `${API}/graphql`, { body: JSON.stringify({ query, variables }), contentType: 'application/json' });
      if (Array.isArray(result?.errors) && result.errors.length > 0) throw new Error(`GraphQL: ${result.errors.map((entry) => entry.message).join('; ')}`);
      return result?.data ?? null;
    },
    /** Every page of a list endpoint, with the declared total when the API gives one. */
    async list(path, { key = null } = {}) {
      const items = [];
      let declared = null;
      for (let page = 1; ; page += 1) {
        const joiner = path.includes('?') ? '&' : '?';
        const chunk = await request('GET', `${API}${path}${joiner}per_page=${String(PAGE)}&page=${String(page)}`);
        const rows = key === null ? chunk : chunk[key];
        if (key !== null && typeof chunk.total_count === 'number') declared = chunk.total_count;
        if (!Array.isArray(rows)) throw new Error(`GET ${path} did not return a list`);
        items.push(...rows);
        if (rows.length < PAGE) break;
      }
      if (declared !== null && declared !== items.length) throw new Error(`GET ${path} declares ${String(declared)} items and ${String(items.length)} were read`);
      return items;
    },
    /** Bytes of an asset or artifact, following GitHub's redirect. */
    async bytes(path, accept = 'application/octet-stream') {
      const response = await request('GET', `${API}${path}`, { accept, raw: true });
      return Buffer.from(await response.arrayBuffer());
    },
    /** Upload one release asset. `name` is the asset's name on the release. */
    async upload(releaseId, repository, name, bytes, contentType) {
      const url = `${UPLOADS}/repos/${repository}/releases/${String(releaseId)}/assets?name=${encodeURIComponent(name)}`;
      return request('POST', url, { body: bytes, contentType });
    },
  };
}

/** Sleep, for polling; a rehearsal passes a clock that does not wait. */
export const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
