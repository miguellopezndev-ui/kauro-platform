// The campaign's token provider (B04-CAMPAIGN, D4-TX-1): Application Default Credentials with service-account impersonation.
// No JSON key is ever read as a credential: a `service_account` file is refused. The caller's own (user) credentials are only
// used to ask IAM Credentials for a short-lived access token of the campaign's service account (roles/aiplatform.user only).
//   gcloud auth application-default login --impersonate-service-account=ic-qualification@<project>.iam.gserviceaccount.com
// writes an `impersonated_service_account` file, which this reads; an `authorized_user` file also works when the service account
// is named (--service-account). The token and every secret stay out of error messages: an error names the step and the status.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IAM = (serviceAccount) => `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`;
const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;
const SAFETY_MS = 120_000;

const wellKnownPath = (env) => (env.CLOUDSDK_CONFIG !== undefined ? join(env.CLOUDSDK_CONFIG, 'application_default_credentials.json')
  : env.APPDATA !== undefined ? join(env.APPDATA, 'gcloud', 'application_default_credentials.json') : join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'));

const fail = (message) => { throw new Error(`ADC: ${message}`); };

async function post(fetchImpl, step, url, headers, body) {
  let response;
  try { response = await fetchImpl(url, { method: 'POST', headers, body }); } catch (error) { return fail(`${step} could not be sent (${error instanceof Error ? error.name : 'error'})`); }
  if (response.status !== 200) return fail(`${step} was refused with status ${String(response.status)}`);
  try { return JSON.parse(await response.text()); } catch { return fail(`${step} answered something that is not JSON`); }
}

/**
 * @param {{ serviceAccount?: string, env?: Record<string, string | undefined>, readText?: (path: string) => string, fetchImpl?: Function, now?: () => number }} options
 * @returns {() => Promise<{ token: string, expiresAt: string }>}
 */
export function adcTokenProvider(options = {}) {
  const env = options.env ?? process.env;
  const readText = options.readText ?? ((path) => readFileSync(path, 'utf8'));
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached = null;
  return async () => {
    if (cached !== null && Date.parse(cached.expiresAt) - SAFETY_MS > now()) return cached;
    const path = env.GOOGLE_APPLICATION_CREDENTIALS ?? wellKnownPath(env);
    let file;
    try { file = JSON.parse(readText(path)); } catch { return fail('the credentials file is not readable JSON'); }
    if (file === null || typeof file !== 'object') return fail('the credentials file is not a record');
    if (file.type === 'service_account') return fail('a service-account JSON key is refused; use gcloud auth application-default login --impersonate-service-account');
    let source; let url;
    if (file.type === 'impersonated_service_account') {
      source = file.source_credentials; url = file.service_account_impersonation_url;
      if (typeof url !== 'string' || !url.startsWith('https://iamcredentials.googleapis.com/') || !url.endsWith(':generateAccessToken')) return fail('the impersonation url is not an IAM Credentials generateAccessToken url');
    } else if (file.type === 'authorized_user') {
      if (options.serviceAccount === undefined || !SERVICE_ACCOUNT.test(options.serviceAccount)) return fail('user credentials need a service account to impersonate (--service-account ic-qualification@<project>.iam.gserviceaccount.com)');
      source = file; url = IAM(options.serviceAccount);
    } else return fail(`credentials of type ${String(file.type)} are not supported (authorized_user or impersonated_service_account only)`);
    if (source === null || typeof source !== 'object' || source.type !== 'authorized_user' || typeof source.refresh_token !== 'string' || typeof source.client_id !== 'string' || typeof source.client_secret !== 'string') return fail('the source credentials are not an authorized user');
    const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: source.client_id, client_secret: source.client_secret, refresh_token: source.refresh_token }).toString();
    const refreshed = await post(fetchImpl, 'the refresh of the user token', TOKEN_URL, { 'content-type': 'application/x-www-form-urlencoded' }, form);
    if (typeof refreshed.access_token !== 'string' || refreshed.access_token === '') return fail('the refresh of the user token returned no access token');
    const impersonated = await post(fetchImpl, 'the impersonation of the service account', url, { 'content-type': 'application/json', authorization: `Bearer ${refreshed.access_token}` }, JSON.stringify({ scope: [SCOPE], lifetime: '3600s' }));
    if (typeof impersonated.accessToken !== 'string' || impersonated.accessToken === '' || typeof impersonated.expireTime !== 'string' || Number.isNaN(Date.parse(impersonated.expireTime))) return fail('the impersonation returned no access token with an expiry');
    cached = { token: impersonated.accessToken, expiresAt: impersonated.expireTime };
    return cached;
  };
}
